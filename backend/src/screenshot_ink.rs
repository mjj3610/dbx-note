//! 全局截图 · 就地标注画布 + 工具栏
//!
//! 全局热键按下时插件可能根本不在前台，用户要的是「在桌面上框完就顺手标完」，
//! 而不是「先复制到剪贴板、再给一个浮窗提示、再回 DBX 打开一张图」。
//!
//! 所以这里把**标注这一步搬到框选窗口自己身上**：`mod window` 松手后不再销毁窗口，
//! 而是保留整屏画面（选区外压暗、选区内 1:1 原始像素），在选区正下方画一条工具栏，
//! 用户当场标注，再选「复制 / 插入笔记 / 保存到记录」。
//!
//! 画布只负责三件事：
//! 1. 把选区从整屏底图上裁下来当底片；
//! 2. 矢量形状按序栅格化（矩形 / 椭圆 / 箭头 / 画笔 / 马赛克）；
//! 3. 文字交给 GDI（唯一能画出清晰字形、还能用上系统输入法的路径）。
//!
//! 工具栏与插件浮层**保持同一套**：同样的七个工具、四个颜色、四档粗细、撤销 / 重做，
//! 以及复制 / 插入笔记 / 保存到记录 / 关闭。

use std::cell::RefCell;
use std::ffi::c_void;

use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    AlphaBlend, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW,
    CreatePen, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, Ellipse, ExtCreatePen, FillRect,
    FrameRect, GetDC, GetDIBits, GetStockObject, LineTo, MoveToEx, Polyline, Rectangle, ReleaseDC,
    RoundRect, SelectObject, SetBkColor, SetBkMode, SetTextColor, StretchDIBits, TextOutW, AC_SRC_ALPHA,
    AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, BS_SOLID, DEFAULT_CHARSET,
    DIB_RGB_COLORS, DT_CALCRECT, DT_CENTER, DT_LEFT, DT_SINGLELINE, DT_VCENTER, HDC, HGDIOBJ,
    HPEN, LOGBRUSH, NULL_BRUSH, OPAQUE, PS_ENDCAP_ROUND, PS_GEOMETRIC, PS_JOIN_ROUND, PS_SOLID,
    SRCCOPY, TRANSPARENT,
};
use windows_sys::Win32::UI::Controls::Dialogs::{
    GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST,
    OPENFILENAMEW,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, SetFocus, VK_ESCAPE, VK_SHIFT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreateWindowExW, DestroyWindow, GetParent, GetWindowLongPtrW, GetWindowTextW,
    PostMessageW, SendMessageW, SetWindowLongPtrW, GWLP_WNDPROC, WM_KEYDOWN, WM_SETFONT, WS_CHILD,
    WS_VISIBLE, WNDPROC,
};

/* ------------------------------------------------------------------ */
/* 工具与配色                                                          */
/* ------------------------------------------------------------------ */

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    Select,
    Rect,
    Ellipse,
    Arrow,
    Pen,
    Text,
    Mosaic,
}

/// 与插件浮层 `SHOT_TOOLS` 同序同义（选择 / 矩形 / 椭圆 / 箭头 / 画笔 / 文字 / 马赛克）
pub const TOOLS: [Tool; 7] = [
    Tool::Select,
    Tool::Rect,
    Tool::Ellipse,
    Tool::Arrow,
    Tool::Pen,
    Tool::Text,
    Tool::Mosaic,
];

/// 与插件浮层 `SHOT_COLORS` 完全同源（八色，顺序一致）
pub const COLORS: [[u8; 3]; 8] = [
    [0xef, 0x44, 0x44], // 红
    [0xf9, 0x73, 0x16], // 橙
    [0xfa, 0xcc, 0x15], // 黄
    [0x22, 0xc5, 0x5e], // 绿
    [0x3b, 0x82, 0xf6], // 蓝
    [0xa8, 0x55, 0xf7], // 紫
    [0xff, 0xff, 0xff], // 白
    [0x17, 0x17, 0x17], // 黑
];

/// 线宽滑轨范围（对齐参考项目的 `Slider min=1 max=12 step=1`）
pub const WIDTH_MIN: i32 = 1;
pub const WIDTH_MAX: i32 = 12;
/// 默认线宽（参考项目 `useState(3)`）
pub const WIDTH_DEFAULT: i32 = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Pick(Tool),
    Ink(usize),
    /// 线宽 1..=12：由滑轨落点换算，不会真的把 `WidthTrack` 传出去
    Width(i32),
    /// 滑轨本体（只用于布局与命中换算）
    WidthTrack,
    Undo,
    Redo,
    Copy,
    /// 另存为：弹系统保存对话框写到用户选的位置（对应浮层里的「下载」）
    Save,
    Insert,
    /// 钉在顶层：把当前标注结果贴成一个置顶小窗，便于对照其他窗口抄写
    Pin,
    Record,
    Close,
}

/// 用户最终选择的出口
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Exit {
    Copy,
    Insert,
    Record,
    Pin,
}

/* ------------------------------------------------------------------ */
/* 形状                                                                */
/* ------------------------------------------------------------------ */

#[derive(Clone)]
enum Shape {
    Rect {
        a: (i32, i32),
        b: (i32, i32),
        color: [u8; 3],
        width: i32,
    },
    Ellipse {
        a: (i32, i32),
        b: (i32, i32),
        color: [u8; 3],
        width: i32,
    },
    Arrow {
        a: (i32, i32),
        b: (i32, i32),
        color: [u8; 3],
        width: i32,
    },
    Pen {
        points: Vec<(i32, i32)>,
        color: [u8; 3],
        width: i32,
    },
    Mosaic {
        a: (i32, i32),
        b: (i32, i32),
    },
    Text {
        x: i32,
        y: i32,
        text: Vec<u16>,
        color: [u8; 3],
        size: i32,
    },
}

impl Shape {
    /// 选区改大小时把形状坐标平移到新原点（画布坐标 = 屏幕坐标 - 选区左上角）
    fn shift(&mut self, dx: i32, dy: i32) {
        let move_point = |point: &mut (i32, i32)| {
            point.0 += dx;
            point.1 += dy;
        };
        match self {
            Shape::Rect { a, b, .. }
            | Shape::Ellipse { a, b, .. }
            | Shape::Arrow { a, b, .. }
            | Shape::Mosaic { a, b } => {
                move_point(a);
                move_point(b);
            }
            Shape::Pen { points, .. } => {
                for point in points.iter_mut() {
                    move_point(point);
                }
            }
            Shape::Text { x, y, .. } => {
                *x += dx;
                *y += dy;
            }
        }
    }

    fn bounds(&self) -> (i32, i32, i32, i32) {
        let span = |a: (i32, i32), b: (i32, i32)| {
            (
                a.0.min(b.0),
                a.1.min(b.1),
                (a.0 - b.0).abs(),
                (a.1 - b.1).abs(),
            )
        };
        match self {
            Shape::Rect { a, b, width, .. }
            | Shape::Ellipse { a, b, width, .. }
            | Shape::Arrow { a, b, width, .. } => {
                let (x, y, w, h) = span(*a, *b);
                let pad = width + 4;
                (x - pad, y - pad, w + pad * 2, h + pad * 2)
            }
            Shape::Mosaic { a, b } => span(*a, *b),
            Shape::Pen {
                points, width, ..
            } => {
                let mut x0 = i32::MAX;
                let mut y0 = i32::MAX;
                let mut x1 = i32::MIN;
                let mut y1 = i32::MIN;
                for (x, y) in points {
                    x0 = x0.min(*x);
                    y0 = y0.min(*y);
                    x1 = x1.max(*x);
                    y1 = y1.max(*y);
                }
                if x0 > x1 {
                    return (0, 0, 0, 0);
                }
                let pad = width + 2;
                (x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2)
            }
            Shape::Text {
                x, y, text, size, ..
            } => {
                // 多行文字：宽度取最长一行，高度按行数 × 行高（1.35，与前端一致）
                let lines = text_lines(text);
                let widest = lines.iter().map(|line| line.len() as i32).max().unwrap_or(0);
                (
                    *x - 2,
                    *y - 2,
                    (widest + 1) * (*size - 2).max(10) + 8,
                    line_height(*size) * lines.len() as i32 + 8,
                )
            }
        }
    }
}

/// 把一段文字按 `\n` 切成行
///
/// `read_edit_text` 已经统一去掉 `\r`，这里只认 `\n`；末尾空行也保留，
/// 多按几个回车时边界与绘制才对得上。
pub(crate) fn text_lines(text: &[u16]) -> Vec<Vec<u16>> {
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    for unit in text {
        if *unit == 0x000A {
            lines.push(std::mem::take(&mut current));
        } else {
            current.push(*unit);
        }
    }
    lines.push(current);
    lines
}

/// 行高：与前端 `fontSize * 1.35` 对齐
fn line_height(size: i32) -> i32 {
    ((size as f64) * 1.35).round() as i32
}

/* ------------------------------------------------------------------ */
/* 画布                                                                */
/* ------------------------------------------------------------------ */

/// 带裁剪矩形的 BGRA 画布（自顶向下），脏矩形重绘靠它
struct Canvas<'a> {
    data: &'a mut [u8],
    width: i32,
    clip: (i32, i32, i32, i32),
}

impl Canvas<'_> {
    #[inline]
    fn inside(&self, x: i32, y: i32) -> bool {
        let (cx, cy, cw, ch) = self.clip;
        x >= cx && y >= cy && x < cx + cw && y < cy + ch
    }

    #[inline]
    fn paint(&mut self, x: i32, y: i32, color: [u8; 3], alpha: u8) {
        if !self.inside(x, y) {
            return;
        }
        let index = ((y * self.width + x) * 4) as usize;
        let pixel = &mut self.data[index..index + 3];
        if alpha >= 255 {
            pixel[0] = color[2];
            pixel[1] = color[1];
            pixel[2] = color[0];
            return;
        }
        let a = alpha as u32;
        for (slot, value) in pixel.iter_mut().zip([color[2], color[1], color[0]]) {
            *slot = ((value as u32 * a + *slot as u32 * (255 - a)) / 255) as u8;
        }
    }

    fn stamp(&mut self, x: i32, y: i32, radius: i32, color: [u8; 3], alpha: u8) {
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                self.paint(x + dx, y + dy, color, alpha);
            }
        }
    }

    fn line(&mut self, a: (i32, i32), b: (i32, i32), width: i32, color: [u8; 3], alpha: u8) {
        let radius = (width / 2).max(0);
        let steps = (a.0 - b.0).abs().max((a.1 - b.1).abs()).max(1);
        for step in 0..=steps {
            let x = a.0 + (b.0 - a.0) * step / steps;
            let y = a.1 + (b.1 - a.1) * step / steps;
            self.stamp(x, y, radius, color, alpha);
        }
    }

    fn polyline(&mut self, points: &[(i32, i32)], width: i32, color: [u8; 3], alpha: u8) {
        if points.len() == 1 {
            self.stamp(points[0].0, points[0].1, (width / 2).max(1), color, alpha);
            return;
        }
        for pair in points.windows(2) {
            self.line(pair[0], pair[1], width, color, alpha);
        }
    }
}

fn rasterize(canvas: &mut [u8], width: i32, shape: &Shape, clip: (i32, i32, i32, i32)) {
    // 马赛克要读「当前画布」再写回，先把借用收回来单独处理
    if let Shape::Mosaic { a, b } = shape {
        apply_mosaic(canvas, width, clip, *a, *b);
        return;
    }
    let mut surface = Canvas {
        data: canvas,
        width,
        clip,
    };
    match shape {
        Shape::Rect {
            a,
            b,
            color,
            width: stroke,
        } => {
            let (x0, y0) = (a.0.min(b.0), a.1.min(b.1));
            let (x1, y1) = (a.0.max(b.0), a.1.max(b.1));
            surface.line((x0, y0), (x1, y0), *stroke, *color, 255);
            surface.line((x0, y1), (x1, y1), *stroke, *color, 255);
            surface.line((x0, y0), (x0, y1), *stroke, *color, 255);
            surface.line((x1, y0), (x1, y1), *stroke, *color, 255);
        }
        Shape::Ellipse {
            a,
            b,
            color,
            width: stroke,
        } => {
            let (x0, y0) = (a.0.min(b.0), a.1.min(b.1));
            let (x1, y1) = (a.0.max(b.0), a.1.max(b.1));
            let (w, h) = (x1 - x0, y1 - y0);
            if w < 2 || h < 2 {
                return;
            }
            let (cx, cy) = (x0 + w / 2, y0 + h / 2);
            let (rx, ry) = (w as f64 / 2.0, h as f64 / 2.0);
            let steps = (((w + h) as f64) * 1.4) as i32;
            let radius = (stroke / 2).max(1);
            for step in 0..=steps.max(48) {
                let angle = step as f64 / steps.max(48) as f64 * std::f64::consts::TAU;
                let x = cx + (rx * angle.cos()).round() as i32;
                let y = cy + (ry * angle.sin()).round() as i32;
                surface.stamp(x, y, radius, *color, 255);
            }
        }
        Shape::Arrow {
            a,
            b,
            color,
            width: stroke,
        } => {
            surface.line(*a, *b, *stroke, *color, 255);
            let dx = (b.0 - a.0) as f64;
            let dy = (b.1 - a.1) as f64;
            let length = (dx * dx + dy * dy).sqrt();
            if length < 6.0 {
                return;
            }
            let head = (length * 0.3).clamp(10.0, 26.0);
            let angle = dy.atan2(dx);
            for spread in [0.5_f64, -0.5] {
                let wing = angle + std::f64::consts::PI + spread;
                let tip = (
                    b.0 + (head * wing.cos()).round() as i32,
                    b.1 + (head * wing.sin()).round() as i32,
                );
                surface.line(*b, tip, *stroke, *color, 255);
            }
        }
        Shape::Pen {
            points,
            color,
            width: stroke,
        } => surface.polyline(points, *stroke, *color, 255),
        // 文字交给 GDI 渲染
        Shape::Text { .. } => {}
        Shape::Mosaic { .. } => unreachable!("马赛克在 rasterize 入口单独处理"),
    }
}

fn apply_mosaic(canvas: &mut [u8], width: i32, clip: (i32, i32, i32, i32), a: (i32, i32), b: (i32, i32)) {
    let block = 9;
    let x0 = a.0.min(b.0).max(clip.0);
    let y0 = a.1.min(b.1).max(clip.1);
    let x1 = a.0.max(b.0).min(clip.0 + clip.2);
    let y1 = a.1.max(b.1).min(clip.1 + clip.3);
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let mut by = y0 - y0.rem_euclid(block);
    while by < y1 {
        let mut bx = x0 - x0.rem_euclid(block);
        while bx < x1 {
            let (mut r, mut g, mut bl, mut count) = (0u32, 0u32, 0u32, 0u32);
            for y in by.max(y0)..(by + block).min(y1) {
                for x in bx.max(x0)..(bx + block).min(x1) {
                    let index = ((y * width + x) * 4) as usize;
                    bl += canvas[index] as u32;
                    g += canvas[index + 1] as u32;
                    r += canvas[index + 2] as u32;
                    count += 1;
                }
            }
            if count > 0 {
                let (r, g, bl) = ((r / count) as u8, (g / count) as u8, (bl / count) as u8);
                for y in by.max(y0)..(by + block).min(y1) {
                    for x in bx.max(x0)..(bx + block).min(x1) {
                        let index = ((y * width + x) * 4) as usize;
                        canvas[index] = bl;
                        canvas[index + 1] = g;
                        canvas[index + 2] = r;
                        canvas[index + 3] = 255;
                    }
                }
            }
            bx += block;
        }
        by += block;
    }
}

/* ------------------------------------------------------------------ */
/* 工具栏布局                                                          */
/* ------------------------------------------------------------------ */

/// 一条工具栏（客户区坐标）
pub struct Bar {
    pub rect: (i32, i32, i32, i32),
    pub items: Vec<((i32, i32, i32, i32), Action)>,
    /// 竖分隔线（只画不响应）
    pub seps: Vec<(i32, i32, i32, i32)>,
}

/* 尺寸逻辑像素，最后乘 DPI 缩放；数值来自参考项目的 Tailwind 类 */
/// 卡片圆角 `rounded-xl`
const CARD_R: i32 = 12;
/// 卡片内边距 `p-2`
const CARD_PAD: i32 = 8;
/// 行高 `h-9`
const ROW_H: i32 = 36;
/// 行间距 `gap-2`
const ROW_GAP: i32 = 8;
/// 控件间距 `gap-1`
const GAP: i32 = 4;
/// 分隔线高度 `h-6`
const SEP_H: i32 = 24;
/// 色点格子：`size="sm"` 的 ToggleGroupItem
const SWATCH_CELL: i32 = 32;
/// 色点直径 `size-4`
const SWATCH_D: i32 = 16;
/// 滑轨宽度 `w-32`
const SLIDER_W: i32 = 128;
/// 马赛克工具那一行是独立的 `Field className="w-44"`
const MOSAIC_SLIDER_W: i32 = 176;
/// 数值宽度 `w-7`
const VALUE_W: i32 = 28;
/// 卡片首选宽度 `min(660, 视口-16)`
const CARD_W: i32 = 660;
/// 卡片与视口边缘的最小留白
const CARD_MARGIN: i32 = 8;

/// 主按钮文案（参考项目 `<Button>` 里就这五个字）
const PRIMARY_LABEL: &str = "保存到记录";
/// 主按钮字号：shadcn `Button` 默认 `text-sm`（14px）
const PRIMARY_FONT: i32 = 14;
/// 主按钮左右内边距 `px-4`
const PILL_PAD_X: i32 = 16;
/// 主按钮图标边长：`[&_svg]:size-4`
const PILL_ICON: i32 = 16;
/// 图标与文字的间距 `gap-2`
const PILL_GAP: i32 = 8;

/// 估文本宽度：中日韩字符按全角算，其余按 0.6 倍字号算
///
/// `layout()` 里拿不到 DC，`measure()` 用不了，只能按字体度量估；中文全角正好等于字号，
/// 估出来的值够准，不会像原来那样把「保存到记录」裁掉一截。
fn label_w(label: &str, size: i32) -> i32 {
    label
        .chars()
        .map(|ch| {
            if (ch as u32) < 0x2e80 {
                size * 6 / 10
            } else {
                size
            }
        })
        .sum()
}

/// 主按钮宽度：`px-3` + 图标 + `gap-1.5` + 文字 + `px-3`
fn primary_w(scale: f64) -> i32 {
    let base = PILL_PAD_X * 2 + PILL_ICON + PILL_GAP + label_w(PRIMARY_LABEL, PRIMARY_FONT);
    (base as f64 * scale).round() as i32
}

/// 参考项目里「颜色行」只在非选择 / 非马赛克工具下出现
fn has_color_row(tool: Tool) -> bool {
    !matches!(tool, Tool::Select | Tool::Mosaic)
}

/// 参考项目里「线宽行」在选择工具下不出现
fn has_width_row(tool: Tool) -> bool {
    !matches!(tool, Tool::Select)
}

/// 算工具栏位置与按钮矩形
///
/// 版式对齐参考项目（`src/app/screenshot/page.tsx`）：一张固定宽 660 的圆角卡片，
/// 左边是分段式工具组 + 撤销重做，右边 `ml-auto` 依次关闭 / 复制 / 下载 / 插入 / 主按钮；
/// 第二行左边色点组、右边滑轨 + 数值。位置也照抄：横向右对齐选区，纵向优先贴选区
/// 下方 10px，放不下改上方，再不行压进选区底部。
pub fn layout(sel: (i32, i32, i32, i32), screen: (i32, i32), scale: f64, tool: Tool) -> Bar {
    let s = |value: i32| (value as f64 * scale).round() as i32;
    let (pad, row, gap, sep_h) = (s(CARD_PAD), s(ROW_H), s(GAP), s(SEP_H));
    let row_gap = s(ROW_GAP);
    let margin = s(CARD_MARGIN);
    let sep_w = s(1).max(1);

    let colors = has_color_row(tool);
    let widths = has_width_row(tool);
    let primary_w = primary_w(scale);

    // ---- 先量宽度，再摆位置（`ml-auto` 需要知道卡片多宽）----
    let tools_w = TOOLS.len() as i32 * row;
    let left_w = tools_w + gap + sep_w + gap + row + gap + row;
    // 5 个图标 + 5 个间距（图标之间 4 个、图标与主按钮之间 1 个）+ 主按钮
    let right_w = row * 5 + gap * 5 + primary_w;
    let content = pad * 2 + left_w + gap * 2 + right_w;
    let avail = (screen.0 - margin * 2).max(row * 10);
    let width = content.max(s(CARD_W)).min(avail);

    let rows = if widths { 2 } else { 1 };
    let height = pad * 2 + row * rows + if rows > 1 { row_gap } else { 0 };

    let mut items: Vec<((i32, i32, i32, i32), Action)> = Vec::new();
    let mut seps: Vec<(i32, i32, i32, i32)> = Vec::new();

    // ---- 第一行 ----
    let row1 = pad;
    let mut x = pad;
    for entry in TOOLS {
        items.push(((x, row1, row, row), Action::Pick(entry)));
        x += row;
    }
    x += gap;
    seps.push((x, row1 + (row - sep_h) / 2, sep_w, sep_h));
    x += sep_w + gap;
    items.push(((x, row1, row, row), Action::Undo));
    x += row + gap;
    items.push(((x, row1, row, row), Action::Redo));

    // 右侧动作区（`ml-auto`）：顺序照参考项目的 X / Copy / Pin / Download，
    // 之后是插件多出来的「插入笔记」，最右是黑色主按钮「保存到记录」
    const RIGHT_ACTIONS: [Action; 5] = [
        Action::Close,
        Action::Copy,
        Action::Pin,
        Action::Save,
        Action::Insert,
    ];
    let mut right = width - pad - primary_w;
    items.push(((right, row1, primary_w, row), Action::Record));
    for action in RIGHT_ACTIONS.iter().rev() {
        right -= gap + row;
        items.push(((right, row1, row, row), *action));
    }

    // ---- 第二行 ----
    if widths {
        let row2 = pad + row + row_gap;
        if colors {
            let mut cx = pad;
            for (index, _) in COLORS.iter().enumerate() {
                items.push(((cx, row2, s(SWATCH_CELL), row), Action::Ink(index)));
                cx += s(SWATCH_CELL);
            }
        }
        let slider_w = s(if tool == Tool::Mosaic {
            MOSAIC_SLIDER_W
        } else {
            SLIDER_W
        });
        let slider_x = if colors {
            width - pad - s(VALUE_W) - gap - slider_w
        } else {
            pad
        };
        items.push(((slider_x, row2, slider_w, row), Action::WidthTrack));
    }

    // ---- 定位（照参考项目的三档规则）----
    let top = {
        let want = sel.1 + sel.3 + s(10);
        if want + height + s(18) <= screen.1 {
            want
        } else if sel.1 >= height + s(18) {
            sel.1 - height - s(10)
        } else {
            sel.1 + sel.3 - height - s(10)
        }
    }
    .max(0)
    .min((screen.1 - height).max(0));
    let left = (sel.0 + sel.2 - width)
        .max(margin)
        .min((screen.0 - width - margin).max(margin));

    for item in items.iter_mut() {
        item.0 .0 += left;
        item.0 .1 += top;
    }
    for sep in seps.iter_mut() {
        sep.0 += left;
        sep.1 += top;
    }
    Bar {
        rect: (left, top, width, height),
        items,
        seps,
    }
}

/// 命中工具栏按钮
///
/// 滑轨按落点换算成 1..=12 的线宽，所以整条滑轨都能点、能拖。
pub fn hit(bar: &Bar, x: i32, y: i32) -> Option<Action> {
    let (bx, by, bw, bh) = bar.rect;
    if x < bx || y < by || x >= bx + bw || y >= by + bh {
        return None;
    }
    bar.items
        .iter()
        .find(|(rect, _)| {
            x >= rect.0 && x < rect.0 + rect.2 && y >= rect.1 && y < rect.1 + rect.3
        })
        .map(|(rect, action)| match action {
            Action::WidthTrack => {
                let span = (rect.2 - 1).max(1);
                let steps = WIDTH_MAX - WIDTH_MIN;
                let offset = ((x - rect.0) * steps + span / 2) / span;
                Action::Width((WIDTH_MIN + offset).clamp(WIDTH_MIN, WIDTH_MAX))
            }
            other => *other,
        })
}

/* ------------------------------------------------------------------ */
/* 另存为                                                              */
/* ------------------------------------------------------------------ */

/// 弹系统保存对话框，把当前画面（含标注）写成 PNG
///
/// 对应插件浮层里的「下载」出口：那边没有浏览器下载目录可用，就换成系统对话框
/// 让用户自己决定存哪儿。返回 `Ok(None)` 表示用户取消了对话框。
pub fn save_as(hwnd: HWND, rgba: &[u8], width: u32, height: u32) -> Result<Option<String>, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };

    let png = crate::native::rgba_png_bytes(width, height, rgba)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut file: Vec<u16> = format!("screenshot-{stamp}.png")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // 缓冲区要留足：系统会把用户选定的完整路径写回来
    file.resize(1024, 0);
    let filter: Vec<u16> = "PNG 图片\0*.png\0所有文件\0*.*\0\0".encode_utf16().collect();
    let ext: Vec<u16> = "png\0".encode_utf16().collect();
    let title: Vec<u16> = "另存为\0".encode_utf16().collect();
    // 默认目录：用户下载夹（拿不到就让系统自己决定）
    let downloads = std::env::var_os("USERPROFILE").map(|home| {
        std::path::Path::new(&home)
            .join("Downloads")
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    });

    let mut ofn: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    ofn.hwndOwner = hwnd;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = file.as_mut_ptr();
    ofn.nMaxFile = file.len() as u32;
    ofn.lpstrDefExt = ext.as_ptr();
    ofn.lpstrTitle = title.as_ptr();
    if let Some(dir) = downloads.as_ref() {
        ofn.lpstrInitialDir = dir.as_ptr();
    }
    ofn.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;

    // Vista 之后 GetSaveFileName 内部就是 IFileDialog，线程没有初始化 COM 时会直接返回 0
    // （不弹窗、也不给错误码），表现成「点了没反应」——所以这里自己起一个 STA。
    let hr = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    let com_ready = hr >= 0;
    let ok = unsafe { GetSaveFileNameW(&mut ofn) };
    if com_ready {
        unsafe { CoUninitialize() };
    }
    if ok == 0 {
        return Ok(None);
    }
    let end = file.iter().position(|unit| *unit == 0).unwrap_or(file.len());
    let path = String::from_utf16_lossy(&file[..end]);
    if path.is_empty() {
        return Ok(None);
    }
    std::fs::write(&path, png).map_err(|error| format!("写入失败：{error}"))?;
    Ok(Some(path))
}

/* ------------------------------------------------------------------ */
/* 画布实体                                                            */
/* ------------------------------------------------------------------ */

pub struct Ink {
    pub width: i32,
    pub height: i32,
    base: Vec<u8>,
    canvas: Vec<u8>,
    shapes: Vec<Shape>,
    draft: Option<Shape>,
    redo: Vec<Shape>,
    pub tool: Tool,
    pub color: [u8; 3],
    pub stroke: i32,
    /// 文字输入框（用户输入中文时要靠 EDIT 控件拿系统输入法）
    edit: HWND,
    edit_at: (i32, i32),
    scale: f64,
}

impl Ink {
    /// 从整屏底图裁出选区当底片（1:1，不缩放，所以不会糊）
    pub fn new(bright: &[u8], screen_w: i32, sel: (i32, i32, i32, i32), scale: f64) -> Ink {
        let (x, y, w, h) = sel;
        let mut base = Vec::with_capacity((w * h * 4) as usize);
        for row in 0..h {
            let start = (((y + row) * screen_w) + x) as usize * 4;
            base.extend_from_slice(&bright[start..start + (w as usize) * 4]);
        }
        let canvas = base.clone();
        Ink {
            width: w,
            height: h,
            base,
            canvas,
            shapes: Vec::new(),
            draft: None,
            redo: Vec::new(),
            // 参考项目 `const [tool, setTool] = useState<Tool>('select')`：
            // 打开就是「选择」态，用户直接拖手柄改选区，不会误画一笔
            tool: Tool::Select,
            color: COLORS[0],
            stroke: WIDTH_DEFAULT,
            edit: std::ptr::null_mut(),
            edit_at: (0, 0),
            scale,
        }
    }

    fn clip_of(&self, rect: (i32, i32, i32, i32)) -> (i32, i32, i32, i32) {
        let x0 = rect.0.max(0);
        let y0 = rect.1.max(0);
        let x1 = (rect.0 + rect.2).min(self.width);
        let y1 = (rect.1 + rect.3).min(self.height);
        (x0, y0, (x1 - x0).max(0), (y1 - y0).max(0))
    }

    /// 选区被 8 向手柄改动后重建画布
    ///
    /// 参考项目里画布是 DOM 层、形状是相对选区的 SVG，改选区只要改 CSS；
    /// 我们是预裁剪的像素画布，所以必须按新矩形重新裁底片，并把已有形状
    /// 按新旧原点之差平移，否则标注会留在屏幕原处、新露出的区域也是黑的。
    pub fn resize(
        &mut self,
        bright: &[u8],
        screen_w: i32,
        old_origin: (i32, i32),
        new_sel: (i32, i32, i32, i32),
    ) {
        let (nx, ny, w, h) = new_sel;
        if w <= 0 || h <= 0 || screen_w <= 0 {
            return;
        }
        let (dx, dy) = (old_origin.0 - nx, old_origin.1 - ny);
        let row_bytes = (w as usize).saturating_mul(4);
        let mut base = vec![0u8; row_bytes.saturating_mul(h as usize)];
        for row in 0..h {
            let start = ((ny + row) as usize)
                .saturating_mul(screen_w as usize)
                .saturating_add(nx.max(0) as usize)
                .saturating_mul(4);
            if start + row_bytes <= bright.len() {
                let offset = row as usize * row_bytes;
                base[offset..offset + row_bytes].copy_from_slice(&bright[start..start + row_bytes]);
            }
        }

        for shape in &mut self.shapes {
            shape.shift(dx, dy);
        }
        if let Some(draft) = &mut self.draft {
            draft.shift(dx, dy);
        }
        for shape in &mut self.redo {
            shape.shift(dx, dy);
        }
        self.edit_at.0 += dx;
        self.edit_at.1 += dy;
        self.width = w;
        self.height = h;
        self.base = base;
        self.canvas = self.base.clone();
        self.redraw((0, 0, w, h));
    }

    /// 重画一块：底片 → 形状 → 草稿（文字由 GDI 在 paint 时叠加）
    pub fn redraw(&mut self, rect: (i32, i32, i32, i32)) -> (i32, i32, i32, i32) {
        let clip = self.clip_of(rect);
        if clip.2 <= 0 || clip.3 <= 0 {
            return (0, 0, 0, 0);
        }
        let stride = (self.width * 4) as usize;
        for row in clip.1..clip.1 + clip.3 {
            let start = row as usize * stride + clip.0 as usize * 4;
            let end = start + clip.2 as usize * 4;
            self.canvas[start..end].copy_from_slice(&self.base[start..end]);
        }
        for shape in self.shapes.iter() {
            rasterize(&mut self.canvas, self.width, shape, clip);
        }
        if let Some(draft) = self.draft.as_ref() {
            rasterize(&mut self.canvas, self.width, draft, clip);
        }
        clip
    }

    /// 把画布贴到窗口上（`origin` 是选区在客户区里的左上角）
    ///
    /// 整幅贴：源坐标固定 `(0, 0)` 对齐 `origin`，超出部分交给 DC 的裁剪区
    /// （`BeginPaint` 已经按失效区设好）兜住。曾经按 `clip` 算源子矩形，结果
    /// 整张画布被平移了一格，标注看上去「没画上 / 位置偏了」。
    pub fn paint(
        &self,
        hdc: windows_sys::Win32::Graphics::Gdi::HDC,
        origin: (i32, i32),
        _clip: (i32, i32, i32, i32),
    ) {
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = self.width;
        info.bmiHeader.biHeight = -self.height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        unsafe {
            StretchDIBits(
                hdc,
                origin.0,
                origin.1,
                self.width,
                self.height,
                0,
                0,
                self.width,
                self.height,
                self.canvas.as_ptr() as *const c_void,
                &info,
                DIB_RGB_COLORS,
                SRCCOPY,
            );
        }
    }

    /// 文字用 GDI 叠在画布上（`origin` 同上）
    ///
    /// 多行按 `\n` 拆开逐行画；字体按字号缓存——每帧为每段文字重新 `CreateFontW`
    /// 在拖动 / 连续重绘时开销不小，而字号实际只有几档。
    pub fn paint_text(&self, hdc: windows_sys::Win32::Graphics::Gdi::HDC, origin: (i32, i32)) {
        unsafe {
            SetBkMode(hdc, TRANSPARENT as i32);
            for shape in &self.shapes {
                if let Shape::Text {
                    x,
                    y,
                    text,
                    color,
                    size,
                } = shape
                {
                    let font = text_font(*size);
                    if font.is_null() {
                        continue;
                    }
                    let old = SelectObject(hdc, font);
                    SetTextColor(
                        hdc,
                        (color[2] as u32) << 16 | (color[1] as u32) << 8 | color[0] as u32,
                    );
                    let step = line_height(*size);
                    for (index, line) in text_lines(text).iter().enumerate() {
                        if line.is_empty() {
                            continue;
                        }
                        TextOutW(
                            hdc,
                            origin.0 + x,
                            origin.1 + y + index as i32 * step,
                            line.as_ptr(),
                            line.len() as i32,
                        );
                    }
                    SelectObject(hdc, old);
                }
            }
        }
    }

    /* ---------------- 交互 ---------------- */

    /// 起一个形状（**只管形状**：文字输入框由窗口模块在释放借用后创建）
    pub fn begin(&mut self, point: (i32, i32)) {
        if matches!(self.tool, Tool::Text | Tool::Select) {
            return;
        }
        let (color, stroke) = (self.color, self.stroke);
        let shape = match self.tool {
            Tool::Rect => Shape::Rect {
                a: point,
                b: point,
                color,
                width: stroke,
            },
            Tool::Ellipse => Shape::Ellipse {
                a: point,
                b: point,
                color,
                width: stroke,
            },
            Tool::Arrow => Shape::Arrow {
                a: point,
                b: point,
                color,
                width: stroke,
            },
            Tool::Pen => Shape::Pen {
                points: vec![point],
                color,
                width: stroke,
            },
            Tool::Mosaic => Shape::Mosaic { a: point, b: point },
            Tool::Text | Tool::Select => return,
        };
        self.draft = Some(shape);
    }

    pub fn moved(&mut self, point: (i32, i32)) -> Option<(i32, i32, i32, i32)> {
        let before = self.draft.as_ref()?.bounds();
        let point = (point.0.clamp(0, self.width - 1), point.1.clamp(0, self.height - 1));
        match self.draft.as_mut()? {
            Shape::Rect { b, .. } | Shape::Ellipse { b, .. } | Shape::Arrow { b, .. } => *b = point,
            Shape::Mosaic { b, .. } => *b = point,
            Shape::Pen { points, .. } => {
                if let Some(last) = points.last() {
                    if (last.0 - point.0).abs() < 2 && (last.1 - point.1).abs() < 2 {
                        return None;
                    }
                }
                points.push(point);
            }
            Shape::Text { .. } => return None,
        }
        let after = self.draft.as_ref()?.bounds();
        Some(union(before, after))
    }

    pub fn end(&mut self) -> Option<(i32, i32, i32, i32)> {
        let draft = self.draft.take()?;
        let bounds = draft.bounds();
        let keep = match &draft {
            Shape::Rect { a, b, .. } | Shape::Ellipse { a, b, .. } | Shape::Arrow { a, b, .. } => {
                (a.0 - b.0).abs() > 2 || (a.1 - b.1).abs() > 2
            }
            Shape::Mosaic { a, b } => (a.0 - b.0).abs() > 2 || (a.1 - b.1).abs() > 2,
            Shape::Pen { points, .. } => points.len() > 1,
            Shape::Text { .. } => true,
        };
        if keep {
            self.shapes.push(draft);
            self.redo.clear();
        }
        Some(bounds)
    }

    pub fn undo(&mut self) -> Option<(i32, i32, i32, i32)> {
        let shape = self.shapes.pop()?;
        let bounds = shape.bounds();
        self.redo.push(shape);
        Some(bounds)
    }

    pub fn redo(&mut self) -> Option<(i32, i32, i32, i32)> {
        let shape = self.redo.pop()?;
        let bounds = shape.bounds();
        self.shapes.push(shape);
        Some(bounds)
    }

    pub fn can_undo(&self) -> bool {
        !self.shapes.is_empty()
    }

    /// 已提交的形状数量（探针用：文字输入到底有没有落地，看这个数）
    pub fn shape_count(&self) -> usize {
        self.shapes.len()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /* ---------------- 文字输入 ---------------- */

    /// 文字字号（由线宽换算，与参考项目 `max(14, lineWidth * 6)` 同源）
    pub fn text_size(&self) -> i32 {
        (self.stroke * 4).clamp(14, 34)
    }

    pub fn text_scale(&self) -> f64 {
        self.scale
    }

    /// 记下刚建好的输入框
    ///
    /// 输入框的**创建**放在窗口模块里做：建窗口会同步回调本窗口的窗口过程
    /// （`WM_PARENTNOTIFY` / 首次重绘），那里还会再借一次 `STATE`，
    /// 所以在持有 `STATE` 可变借用时创建窗口会直接 panic（RefCell already mutably borrowed）。
    pub fn attach_edit(&mut self, handle: isize, at: (i32, i32)) {
        self.edit = handle as HWND;
        self.edit_at = at;
    }

    /// 把输入框「摘下来」：返回句柄与落点，`self.edit` 立刻清空
    ///
    /// 提交/取消时也一样——先摘句柄，销毁窗口放在借用释放之后。
    pub fn detach_edit(&mut self) -> Option<(isize, (i32, i32))> {
        if self.edit.is_null() {
            return None;
        }
        let handle = self.edit as isize;
        let at = self.edit_at;
        self.edit = std::ptr::null_mut();
        Some((handle, at))
    }

    /// 把一段文字落成标注（借用内调用，不碰任何窗口 API）
    pub fn push_text(&mut self, text: Vec<u16>, at: (i32, i32)) -> Option<(i32, i32, i32, i32)> {
        if text.is_empty() {
            return None;
        }
        let size = self.text_size();
        self.shapes.push(Shape::Text {
            x: at.0,
            y: at.1,
            text,
            color: self.color,
            size,
        });
        self.redo.clear();
        let bounds = self.shapes.last().map(|shape| shape.bounds());
        if let Some(bounds) = bounds {
            self.redraw(bounds);
        }
        bounds
    }

    pub fn editing(&self) -> bool {
        !self.edit.is_null()
    }

    /// 文字输入框的窗口句柄（自检往里投字符用）
    pub fn edit_handle(&self) -> isize {
        self.edit as isize
    }

    /// 导出：画布 + 文字 → RGBA（自顶向下）
    pub fn bake(&self) -> Vec<u8> {
        let (width, height) = (self.width, self.height);
        let mut buffer = vec![0u8; (width * height * 4) as usize];
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            let memory = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            if memory.is_null() || bitmap.is_null() {
                ReleaseDC(std::ptr::null_mut(), screen);
                return to_rgba(&self.canvas);
            }
            let old = SelectObject(memory, bitmap as HGDIOBJ);
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = width;
            info.bmiHeader.biHeight = -height;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            StretchDIBits(
                memory,
                0,
                0,
                width,
                height,
                0,
                0,
                width,
                height,
                self.canvas.as_ptr() as *const c_void,
                &info,
                DIB_RGB_COLORS,
                SRCCOPY,
            );
            self.paint_text(memory, (0, 0));
            GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                buffer.as_mut_ptr() as *mut c_void,
                &mut info,
                DIB_RGB_COLORS,
            );
            SelectObject(memory, old);
            DeleteObject(bitmap as HGDIOBJ);
            DeleteDC(memory);
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        to_rgba(&buffer)
    }
}

thread_local! {
    /// EDIT 子类化时的原窗口过程 + 宿主窗口
    static EDIT_OLD: std::cell::RefCell<(isize, HWND)> = std::cell::RefCell::new((0, std::ptr::null_mut()));
    /// 字形缓存：字号 → 字体句柄。每帧 `CreateFontW` 太贵，而字号只有几档
    static TEXT_FONTS: std::cell::RefCell<Vec<(i32, HGDIOBJ)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// 取（或建）指定字号的字体
fn text_font(size: i32) -> HGDIOBJ {
    TEXT_FONTS.with(|cell| {
        let mut cache = cell.borrow_mut();
        if let Some((_, font)) = cache.iter().find(|(cached, _)| *cached == size) {
            return *font;
        }
        let face = wide("Microsoft YaHei");
        let font = unsafe {
            CreateFontW(
                -size,
                0,
                0,
                0,
                400,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                0,
                0,
                0,
                0,
                face.as_ptr(),
            ) as HGDIOBJ
        };
        cache.push((size, font));
        font
    })
}

/// 窗口销毁时释放字体缓存
pub fn release_text_fonts() {
    TEXT_FONTS.with(|cell| {
        for (_, font) in cell.borrow_mut().drain(..) {
            if !font.is_null() {
                unsafe { DeleteObject(font) };
            }
        }
    });
}

/// 创建文字输入框（父窗口 `parent`，落点 `point` + 选区原点 `origin`）
///
/// **不要在持有 `STATE` 借用时调用**：`CreateWindowExW` / `SetFocus` 会同步把消息
/// 回灌给本窗口的窗口过程，那里再借 `STATE` 就是 RefCell 重入 panic，
/// 表现正是「输入框一出现截图窗口就卡死、随后消失」。
pub fn create_text_editor(
    parent: HWND,
    point: (i32, i32),
    origin: (i32, i32),
    size: i32,
    scale: f64,
) -> isize {
    let width = (240.0 * scale) as i32;
    // 多行输入框：给三行的高度，写长句换行时不用滚
    let height = size * 3 + 16;
    let class = wide("EDIT");
    // 多行（`ES_MULTILINE`）+ 认回车（`ES_WANTRETURN`）：Shift+Enter 换行靠它们，
    // 单独按回车提交由 `edit_proc` 拦下（与参考项目「Enter 添加、Shift+Enter 换行」一致）。
    // `ES_AUTOVSCROLL`：行数超出高度时纵向滚动，不会有字看不见。
    const ES_MULTILINE: u32 = 0x0004;
    const ES_AUTOVSCROLL: u32 = 0x0040;
    const ES_WANTRETURN: u32 = 0x1000;
    let edit = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_WANTRETURN | ES_AUTOVSCROLL,
            origin.0 + point.0,
            origin.1 + point.1,
            width,
            height,
            parent,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if edit.is_null() {
        return 0;
    }
    unsafe {
        let face = wide("Microsoft YaHei");
        let font = CreateFontW(
            -size,
            0,
            0,
            0,
            400,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            0,
            0,
            0,
            0,
            face.as_ptr(),
        );
        SendMessageW(edit, WM_SETFONT, font as usize, 1);
        let previous = GetWindowLongPtrW(edit, GWLP_WNDPROC);
        SetWindowLongPtrW(edit, GWLP_WNDPROC, edit_proc as *const () as isize);
        EDIT_OLD.with(|cell| *cell.borrow_mut() = (previous, parent));
        SetFocus(edit);
    }
    edit as isize
}

/// 读走输入框里的文字（调用方随后要 `destroy_text_editor`）
///
/// 多行输入框回传的是 `\r\n`，这里统一成 `\n`：后面的绘制 / 边界计算只认 `\n`。
pub fn read_edit_text(handle: isize) -> Vec<u16> {
    if handle == 0 {
        return Vec::new();
    }
    // 多行 + 4000 字上限（与参考项目 textarea 的 maxLength 一致），一次读干净
    let mut buffer = vec![0u16; 4096];
    let length = unsafe { GetWindowTextW(handle as HWND, buffer.as_mut_ptr(), buffer.len() as i32) };
    buffer[..length.max(0) as usize]
        .iter()
        .copied()
        .filter(|value| *value != 0 && *value != 0x000D)
        .collect()
}

/// 销毁输入框并把焦点交还框选窗口
///
/// 焦点必须还回去：销毁「当前拥有焦点的子窗口」之后系统不会自动把焦点交回父窗口，
/// 于是后续 Esc / Ctrl+Z 全部收不到，用户看到的就是"卡死"。
pub fn destroy_text_editor(handle: isize, parent: HWND) {
    if handle == 0 {
        return;
    }
    unsafe {
        DestroyWindow(handle as HWND);
        SetFocus(parent);
    }
}

/// 编辑框只拦两件事：回车提交、Esc 放弃（其余交给原过程，输入法才正常）
unsafe extern "system" fn edit_proc(
    hwnd: HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    let (previous, host) = EDIT_OLD.with(|cell| *cell.borrow());
    if message == WM_KEYDOWN {
        let key = wparam as u32;
        // Shift 按住时的回车交给编辑框自己处理（插一个换行），
        // 单独的回车才是「提交」——与参考项目 Textarea 的行为一致。
        let shift = unsafe { GetKeyState(VK_SHIFT as i32) } < 0;
        let commit = key == 0x0D && !shift;
        if commit || key == VK_ESCAPE as u32 {
            let parent = unsafe { GetParent(hwnd) };
            INK_ACTION.with(|cell| {
                *cell.borrow_mut() = Some(if commit {
                    EditCommand::Commit
                } else {
                    EditCommand::Cancel
                });
            });
            // 让 mod window 消息循环去处理。
            //
            // 这里**必须是 PostMessage**：`SendMessage` 是同步的，会在编辑框自己的
            // 键盘处理函数里直接跑完「提交 → DestroyWindow(自己)」，等于在窗口过程里
            // 销毁自己的窗口——Windows 下这属于未定义行为，实际表现就是输入完卡死、
            // 接着整个截图窗口消失（后台进程还活着）。
            unsafe {
                PostMessageW(parent, WM_INK_EDIT, 0, 0);
            }
            let _ = host;
            return 0;
        }
    }
    let proc: WNDPROC = unsafe { std::mem::transmute(previous) };
    unsafe { CallWindowProcW(proc, hwnd, message, wparam, lparam) }
}

/// 编辑框子类化后把「提交 / 放弃」转给宿主窗口处理
pub const WM_INK_EDIT: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 0x51;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EditCommand {
    Commit,
    Cancel,
}

thread_local! {
    static INK_ACTION: std::cell::RefCell<Option<EditCommand>> = const { std::cell::RefCell::new(None) };
}

pub fn take_edit_command() -> Option<EditCommand> {
    INK_ACTION.with(|cell| cell.borrow_mut().take())
}

/* ------------------------------------------------------------------ */
/* 文字输入框配色                                                      */
/* ------------------------------------------------------------------ */

thread_local! {
    /// 文字输入框的背景刷子：颜色跟着「选取的颜色」走，换色才重建
    static EDIT_BRUSH: std::cell::RefCell<Option<(u32, usize)>> = const { std::cell::RefCell::new(None) };
}

/// 给 EDIT 控件配文字色与背景色（父窗口处理 `WM_CTLCOLOREDIT` 时调用）
///
/// 参考项目里文字是直接画在图上的、用当前选中的颜色；这里的原生输入框做同样的表达：
/// 文字用选中色，底色按颜色明度选白 / 深两种，保证黄、白这类浅色也读得出来。
pub fn edit_colors(hdc: HDC, color: [u8; 3]) -> isize {
    let text = cref(((color[0] as u32) << 16) | ((color[1] as u32) << 8) | color[2] as u32);
    // 0.299/0.587/0.114 亮度：浅色（黄、白）配深底，其余配白底
    let luma = (color[0] as f32 * 0.299 + color[1] as f32 * 0.587 + color[2] as f32 * 0.114) as i32;
    let background = if luma > 170 { cref(0x18_181b) } else { cref(0xff_ffff) };

    let brush = EDIT_BRUSH.with(|cell| {
        let mut cache = cell.borrow_mut();
        if let Some((key, handle)) = cache.as_ref() {
            if *key == background {
                return *handle;
            }
        }
        if let Some((_, old)) = cache.take() {
            unsafe { DeleteObject(old as HGDIOBJ) };
        }
        let handle = unsafe { CreateSolidBrush(background) } as usize;
        *cache = Some((background, handle));
        handle
    });

    unsafe {
        SetTextColor(hdc, text);
        SetBkColor(hdc, background);
        SetBkMode(hdc, OPAQUE as i32);
    }
    brush as isize
}

pub fn release_edit_brush() {
    EDIT_BRUSH.with(|cell| {
        if let Some((_, handle)) = cell.borrow_mut().take() {
            unsafe { DeleteObject(handle as HGDIOBJ) };
        }
    });
}

/* ------------------------------------------------------------------ */
/* 工具栏绘制                                                          */
/* ------------------------------------------------------------------ */

/// `#rrggbb` → COLORREF
///
/// GDI 要的是 `0x00BBGGRR`，直接把 `0xRRGGBB` 塞进去会把红蓝调反（`#ef4444` 会画成蓝色）。
const fn cref(rgb: u32) -> u32 {
    ((rgb & 0x0000_00ff) << 16) | (rgb & 0x0000_ff00) | ((rgb >> 16) & 0x0000_00ff)
}

/* 配色取自参考项目的主题变量（light）：卡片 popover/border、强调 accent、
   主按钮 primary、滑轨 secondary，禁用态弱化 */
const CARD_BG: u32 = cref(0xff_ffff);
/// `border`（参考项目浅色主题 `--border`）
const CARD_EDGE: u32 = cref(0xe5_e5e5);
/// `accent`：ghost 按钮的 hover 与 ToggleGroup 的选中态都是它
const HOVER_BG: u32 = cref(0xf4_f4f5);
const ACTIVE_BG: u32 = HOVER_BG;
const ICON: u32 = cref(0x18_181b);
/// 禁用态：参考项目是 `disabled:opacity-50`，即图标色 50% 叠在白底上
const ICON_OFF: u32 = cref(0x8b_8b8d);
const PRIMARY_BG: u32 = cref(0x18_181b);
const PRIMARY_FG: u32 = cref(0xfa_fafa);
const TRACK_BG: u32 = cref(0xf4_f4f5);
const THUMB_EDGE: u32 = cref(0x18_181b);
const SWATCH_EDGE: u32 = cref(0xd4_d4d8);
const TEXT_MUTED: u32 = cref(0x52_525b);
/// 尺寸角标的 secondary 底色
const BADGE_BG: u32 = cref(0xf4_f4f5);
/// 选框 / 手柄的 primary 色
const FRAME: u32 = cref(0x18_181b);
/// 选区边框线颜色：红色（与标注调色板首个颜色 `#ef4444` 一致）。
/// 只作用于框选阶段的边框与 8 个 resize 手柄描边；工具栏、角标仍用中性色。
const SELECTION_BORDER: u32 = cref(0xef_4444);

/* ---- 基础图元 ---- */

unsafe fn fill_round(hdc: HDC, area: &RECT, radius: i32, color: u32) {
    let brush = CreateSolidBrush(color);
    let pen = CreatePen(0, 1, color);
    let old_brush = SelectObject(hdc, brush as HGDIOBJ);
    let old_pen = SelectObject(hdc, pen as HGDIOBJ);
    RoundRect(hdc, area.left, area.top, area.right, area.bottom, radius * 2, radius * 2);
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    DeleteObject(brush as HGDIOBJ);
    DeleteObject(pen as HGDIOBJ);
}

unsafe fn outline_round(hdc: HDC, area: &RECT, radius: i32, color: u32) {
    let pen = CreatePen(0, 1, color);
    let old_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH) as HGDIOBJ);
    let old_pen = SelectObject(hdc, pen as HGDIOBJ);
    RoundRect(hdc, area.left, area.top, area.right, area.bottom, radius * 2, radius * 2);
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    DeleteObject(pen as HGDIOBJ);
}

unsafe fn fill_circle(hdc: HDC, cx: i32, cy: i32, radius: i32, color: u32) {
    let brush = CreateSolidBrush(color);
    let pen = CreatePen(0, 1, color);
    let old_brush = SelectObject(hdc, brush as HGDIOBJ);
    let old_pen = SelectObject(hdc, pen as HGDIOBJ);
    Ellipse(hdc, cx - radius, cy - radius, cx + radius, cy + radius);
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    DeleteObject(brush as HGDIOBJ);
    DeleteObject(pen as HGDIOBJ);
}

unsafe fn ring_circle(hdc: HDC, cx: i32, cy: i32, radius: i32, width: i32, color: u32) {
    let pen = CreatePen(0, width.max(1), color);
    let old_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH) as HGDIOBJ);
    let old_pen = SelectObject(hdc, pen as HGDIOBJ);
    Ellipse(hdc, cx - radius, cy - radius, cx + radius, cy + radius);
    SelectObject(hdc, old_brush);
    SelectObject(hdc, old_pen);
    DeleteObject(pen as HGDIOBJ);
}

unsafe fn fill_box(hdc: HDC, area: &RECT, color: u32) {
    let brush = CreateSolidBrush(color);
    FillRect(hdc, area, brush);
    DeleteObject(brush as HGDIOBJ);
}

/// 一行文本；`center` 为假时靠左
unsafe fn draw_text(hdc: HDC, area: &RECT, label: &str, size: i32, color: u32, center: bool) {
    let face = wide("Microsoft YaHei");
    let font = CreateFontW(
        -size,
        0,
        0,
        0,
        400,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        0,
        0,
        0,
        0,
        face.as_ptr(),
    );
    let old_font = SelectObject(hdc, font as HGDIOBJ);
    SetBkMode(hdc, TRANSPARENT as i32);
    SetTextColor(hdc, color);
    let text: Vec<u16> = label.encode_utf16().collect();
    let mut target = *area;
    let flags = if center {
        DT_CENTER | DT_VCENTER | DT_SINGLELINE
    } else {
        DT_LEFT | DT_VCENTER | DT_SINGLELINE
    };
    DrawTextW(hdc, text.as_ptr(), text.len() as i32, &mut target, flags);
    SelectObject(hdc, old_font);
    DeleteObject(font as HGDIOBJ);
}

/// 文本宽度（用 `DT_CALCRECT` 量，别自己估）
unsafe fn measure(hdc: HDC, label: &str, size: i32) -> (i32, i32) {
    let face = wide("Microsoft YaHei");
    let font = CreateFontW(
        -size,
        0,
        0,
        0,
        400,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        0,
        0,
        0,
        0,
        face.as_ptr(),
    );
    let old_font = SelectObject(hdc, font as HGDIOBJ);
    let text: Vec<u16> = label.encode_utf16().collect();
    let mut target = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    DrawTextW(
        hdc,
        text.as_ptr(),
        text.len() as i32,
        &mut target,
        DT_CALCRECT | DT_SINGLELINE,
    );
    SelectObject(hdc, old_font);
    DeleteObject(font as HGDIOBJ);
    (target.right - target.left, target.bottom - target.top)
}

/// 主按钮上的对勾
unsafe fn draw_check(hdc: HDC, area: &RECT, tone: u32) {
    let cx = (area.left + area.right) / 2;
    let cy = (area.top + area.bottom) / 2;
    let pen = CreatePen(0, 2, tone);
    let old_pen = SelectObject(hdc, pen as HGDIOBJ);
    MoveToEx(hdc, cx - 4, cy, std::ptr::null_mut());
    LineTo(hdc, cx - 1, cy + 3);
    LineTo(hdc, cx + 4, cy - 3);
    SelectObject(hdc, old_pen);
    DeleteObject(pen as HGDIOBJ);
}

/// 画工具栏（`ink` 只用它的当前状态来决定高亮）
/// 点到圆角矩形的有符号距离（矩形内部为负，外部为正）
fn round_rect_distance(x: i32, y: i32, rect: (i32, i32, i32, i32), radius: i32) -> f64 {
    let (rx, ry, rw, rh) = rect;
    let (half_w, half_h) = (rw as f64 / 2.0, rh as f64 / 2.0);
    let (cx, cy) = (rx as f64 + half_w, ry as f64 + half_h);
    let radius = radius as f64;
    let qx = (x as f64 + 0.5 - cx).abs() - (half_w - radius);
    let qy = (y as f64 + 0.5 - cy).abs() - (half_h - radius);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - radius
}

thread_local! {
    /// 投影的 alpha 图只跟卡片尺寸有关，缓存一份，拖拽时每帧不必重算
    static SHADOW_ALPHA: RefCell<Option<((i32, i32, i32), Vec<u8>)>> = const { RefCell::new(None) };
}

/// 卡片投影（对应参考项目的 `shadow-xl`）
///
/// GDI 的填充不支持半透明，所以自己生成一张「纯黑 + 逐像素 alpha」的 DIB：
/// 以圆角矩形为形状做高斯衰减，再用 `AlphaBlend` 叠到目标 DC 上。
/// 参考项目是两层阴影（`0 20px 25px -5px` / `0 8px 10px -6px`，各 10%），
/// 叠加后卡片正下方约 13% 不透明度，向外一个 blur 距离衰减到 0。
fn paint_shadow(hdc: HDC, card: &RECT, radius: i32, scale: f64) {
    let margin = (20.0 * scale).round().max(6.0) as i32;
    let offset_y = (6.0 * scale).round().max(2.0) as i32;
    let blur = (11.0 * scale).round().max(4.0) as i32;
    let width = (card.right - card.left) + margin * 2;
    let height = (card.bottom - card.top) + margin * 2 + offset_y;
    if width <= 0 || height <= 0 {
        return;
    }

    let alpha = SHADOW_ALPHA.with(|cell| {
        let mut cache = cell.borrow_mut();
        let key = (width, height, radius);
        if let Some((cached_key, data)) = cache.as_ref() {
            if *cached_key == key {
                return data.clone();
            }
        }
        let inner = (
            margin,
            margin + offset_y,
            width - margin * 2,
            height - margin * 2 - offset_y,
        );
        let mut data = vec![0u8; (width * height) as usize];
        for y in 0..height {
            for x in 0..width {
                let distance = round_rect_distance(x, y, inner, radius);
                let falloff = if distance <= 0.0 {
                    1.0
                } else {
                    (-(distance / blur as f64).powi(2)).exp()
                };
                data[(y * width + x) as usize] = (falloff * 0.13 * 255.0).round() as u8;
            }
        }
        *cache = Some((key, data.clone()));
        data
    });

    unsafe {
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;

        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        if bitmap.is_null() || bits.is_null() {
            return;
        }
        let dc = CreateCompatibleDC(hdc);
        if dc.is_null() {
            DeleteObject(bitmap as HGDIOBJ);
            return;
        }
        let old = SelectObject(dc, bitmap as HGDIOBJ);

        // 预乘 alpha：颜色是纯黑，RGB 全 0，只写 alpha 通道
        let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, (width * height * 4) as usize);
        for (index, value) in alpha.iter().enumerate() {
            let base = index * 4;
            pixels[base] = 0;
            pixels[base + 1] = 0;
            pixels[base + 2] = 0;
            pixels[base + 3] = *value;
        }

        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        AlphaBlend(
            hdc,
            card.left - margin,
            card.top - margin,
            width,
            height,
            dc,
            0,
            0,
            width,
            height,
            blend,
        );

        SelectObject(dc, old);
        DeleteObject(bitmap as HGDIOBJ);
        DeleteDC(dc);
    }
}

pub fn paint_bar(hdc: HDC, bar: &Bar, ink: &Ink, hot: Option<Action>) {
    let (x, y, w, h) = bar.rect;
    let s = |value: i32| (value as f64 * ink.scale).round() as i32;
    unsafe {
        // 卡片：`rounded-xl border bg-popover shadow-xl`
        let card = RECT {
            left: x,
            top: y,
            right: x + w,
            bottom: y + h,
        };
        // 参考项目卡片带 shadow-xl：在压暗的桌面上有这层投影，卡片才不会"糊"在背景里
        paint_shadow(hdc, &card, s(CARD_R), ink.scale);
        fill_round(hdc, &card, s(CARD_R), CARD_BG);
        outline_round(hdc, &card, s(CARD_R), CARD_EDGE);

        for sep in &bar.seps {
            let rect = RECT {
                left: sep.0,
                top: sep.1,
                right: sep.0 + sep.2,
                bottom: sep.1 + sep.3,
            };
            fill_box(hdc, &rect, CARD_EDGE);
        }

        for (rect, action) in &bar.items {
            let area = RECT {
                left: rect.0,
                top: rect.1,
                right: rect.0 + rect.2,
                bottom: rect.1 + rect.3,
            };
            let active = match action {
                Action::Pick(tool) => *tool == ink.tool,
                Action::Ink(index) => COLORS[*index] == ink.color,
                _ => false,
            };
            let hover = match action {
                Action::WidthTrack => hot == Some(Action::WidthTrack),
                Action::Width(_) => hot == Some(Action::WidthTrack),
                other => hot == Some(*other),
            };
            let enabled = match action {
                Action::Undo => ink.can_undo(),
                Action::Redo => ink.can_redo(),
                _ => true,
            };

            match action {
                // 色点：`size-4 rounded-full border`
                Action::Ink(index) => {
                    if active {
                        fill_round(hdc, &area, s(6), ACTIVE_BG);
                    }
                    let color = COLORS[*index];
                    let rgb = (color[2] as u32) << 16 | (color[1] as u32) << 8 | color[0] as u32;
                    let cx = (area.left + area.right) / 2;
                    let cy = (area.top + area.bottom) / 2;
                    let radius = s(SWATCH_D) / 2;
                    fill_circle(hdc, cx, cy, radius, rgb);
                    ring_circle(hdc, cx, cy, radius, s(1), SWATCH_EDGE);
                }
                // 滑轨 + 数值：`Slider` + `w-7 text-xs tabular-nums`
                Action::WidthTrack => {
                    let cy = (area.top + area.bottom) / 2;
                    let track_h = s(6).max(4);
                    let radius = track_h / 2;
                    let rail = RECT {
                        left: area.left,
                        top: cy - radius,
                        right: area.right,
                        bottom: cy - radius + track_h,
                    };
                    fill_round(hdc, &rail, radius, TRACK_BG);

                    let thumb_r = s(8).max(5);
                    let steps = (WIDTH_MAX - WIDTH_MIN).max(1);
                    let offset = (ink.stroke.clamp(WIDTH_MIN, WIDTH_MAX) - WIDTH_MIN) as f64 / steps as f64;
                    let span = (area.right - area.left - thumb_r * 2).max(1);
                    let knob = area.left + thumb_r + (span as f64 * offset).round() as i32;
                    let range = RECT {
                        left: area.left,
                        top: rail.top,
                        right: knob,
                        bottom: rail.bottom,
                    };
                    if range.right > range.left {
                        fill_round(hdc, &range, radius, THUMB_EDGE);
                    }
                    fill_circle(hdc, knob, cy, thumb_r, CARD_BG);
                    ring_circle(hdc, knob, cy, thumb_r, s(2).max(1), THUMB_EDGE);

                    let value = RECT {
                        left: area.right + s(GAP),
                        top: area.top,
                        right: area.right + s(GAP) + s(VALUE_W),
                        bottom: area.bottom,
                    };
                    // 文字工具显示字号、马赛克显示格子尺寸，其余显示线宽（参考项目同款换算）
                    let label = match ink.tool {
                        Tool::Text => format!("{}", (ink.stroke * 6).max(14)),
                        Tool::Mosaic => format!("{}", (ink.stroke * 6).max(10)),
                        _ => format!("{}", ink.stroke),
                    };
                    draw_text(hdc, &value, &label, s(12), TEXT_MUTED, true);
                }
                // 主按钮：黑底 + 对勾 + 文字
                Action::Record => {
                    fill_round(hdc, &area, s(6), PRIMARY_BG);
                    let cy = (area.top + area.bottom) / 2;
                    let pad = s(PILL_PAD_X);
                    let side = s(PILL_ICON);
                    let check = RECT {
                        left: area.left + pad,
                        top: cy - side / 2,
                        right: area.left + pad + side,
                        bottom: cy + side / 2,
                    };
                    draw_check(hdc, &check, PRIMARY_FG);
                    let text = RECT {
                        left: check.right + s(PILL_GAP),
                        top: area.top,
                        right: area.right - pad,
                        bottom: area.bottom,
                    };
                    draw_text(hdc, &text, PRIMARY_LABEL, s(PRIMARY_FONT), PRIMARY_FG, false);
                }
                // 图标按钮：`ghost`，选中 / hover 给 accent 底
                _ => {
                    if active {
                        fill_round(hdc, &area, s(6), ACTIVE_BG);
                    } else if hover && enabled {
                        fill_round(hdc, &area, s(6), HOVER_BG);
                    }
                    let tone = if !enabled {
                        ICON_OFF
                    } else {
                        ICON
                    };
                    draw_icon(hdc, *action, &area, tone, ink.scale);
                }
            }
        }
    }
}

/// 选区样式：红色 1px 边框 + 8 个手柄 + 尺寸角标
///
/// 边框与手柄描边统一用 `SELECTION_BORDER`（红色），在浅色 / 深色壁纸上都更醒目；
/// 手柄是 `size-3` 的白底方框压在边框上（四角 + 四边中点），与参考项目一致；
/// 角标是 `Badge variant="secondary"`，贴着选区左上角外侧，上方放不下就落到选区内。
pub fn paint_selection(
    hdc: HDC,
    sel: (i32, i32, i32, i32),
    scale: f64,
    handles: bool,
) {
    let (x, y, w, h) = sel;
    let s = |value: i32| (value as f64 * scale).round() as i32;
    unsafe {
        // 1px 边框
        let edge = RECT {
            left: x,
            top: y,
            right: x + w,
            bottom: y + h,
        };
        let brush = CreateSolidBrush(SELECTION_BORDER);
        FrameRect(hdc, &edge, brush);
        DeleteObject(brush as HGDIOBJ);

        if handles {
            let box_size = s(12).max(6);
            let half = box_size / 2;
            let points = [
                (x, y),
                (x + w / 2, y),
                (x + w, y),
                (x + w, y + h / 2),
                (x + w, y + h),
                (x + w / 2, y + h),
                (x, y + h),
                (x, y + h / 2),
            ];
            for (hx, hy) in points {
                let area = RECT {
                    left: hx - half,
                    top: hy - half,
                    right: hx - half + box_size,
                    bottom: hy - half + box_size,
                };
                fill_box(hdc, &area, CARD_BG);
                let pen = CreatePen(0, 1, SELECTION_BORDER);
                let old_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH) as HGDIOBJ);
                let old_pen = SelectObject(hdc, pen as HGDIOBJ);
                Rectangle(hdc, area.left, area.top, area.right, area.bottom);
                SelectObject(hdc, old_brush);
                SelectObject(hdc, old_pen);
                DeleteObject(pen as HGDIOBJ);
            }
        }

        // 尺寸角标
        let label = format!("{w} × {h}");
        let (text_w, text_h) = measure(hdc, &label, s(12));
        let pad_x = s(8);
        let badge_w = text_w + pad_x * 2;
        let badge_h = (text_h + s(6)).max(s(20));
        let badge_top = if y >= s(28) { y - s(27) } else { y + s(4) };
        let badge = RECT {
            left: x,
            top: badge_top,
            right: x + badge_w,
            bottom: badge_top + badge_h,
        };
        fill_round(hdc, &badge, s(6), BADGE_BG);
        draw_text(hdc, &badge, &label, s(12), FRAME, true);
    }
}

/// 图标：按 Lucide 的 24×24 视口手绘
///
/// 参考项目用的是 `lucide-react`（`MousePointer2 / Square / Circle / ArrowUpRight /
/// Pencil / Type / ScanLine / Undo2 / Redo2 / X / Copy / Download / Check`），
/// 24 视口、`stroke-width: 2`、圆头圆角。这里不引图标字体或位图资源，改成把同样的
/// 路径点按比例放大后用 GDI 画出来——几何一致，肉眼就看不出是两套实现。
const ICON_SIZE: i32 = 16;
/// Lucide 的 viewBox 边长
const ICON_VIEW: f64 = 24.0;

/// 一段圆弧采样成折线（GDI 的 `Arc` 方向随坐标系而变，自己采样最稳）
fn arc_points(cx: f64, cy: f64, r: f64, from_deg: f64, to_deg: f64) -> Vec<(f64, f64)> {
    let steps = 16;
    (0..=steps)
        .map(|index| {
            let angle = (from_deg + (to_deg - from_deg) * index as f64 / steps as f64).to_radians();
            (cx + r * angle.cos(), cy + r * angle.sin())
        })
        .collect()
}

/// 图标绘制的临时上下文：负责 24 视口 → 设备像素的映射与画笔生命周期
struct IconCtx {
    hdc: HDC,
    left: i32,
    top: i32,
    size: i32,
    pen: HPEN,
    old_pen: HGDIOBJ,
    old_brush: HGDIOBJ,
}

impl IconCtx {
    fn new(hdc: HDC, area: &RECT, tone: u32, scale: f64, weight: f64) -> Self {
        let size = ((ICON_SIZE as f64) * scale).round().max(1.0) as i32;
        let left = (area.left + area.right - size) / 2;
        let top = (area.top + area.bottom - size) / 2;
        // 24 视口里的 2px 描边缩到 16px 只有 1.33px，GDI 只能整像素；
        // 指针那种小三角形描边太细会糊成一团，单独加粗一点（`weight`）。
        let width = ((2.0 * size as f64 / ICON_VIEW * weight).round() as i32).max(1);
        let brush = LOGBRUSH {
            lbStyle: BS_SOLID,
            lbColor: tone,
            lbHatch: 0,
        };
        unsafe {
            let pen = ExtCreatePen(
                (PS_GEOMETRIC | PS_SOLID | PS_ENDCAP_ROUND | PS_JOIN_ROUND) as u32,
                width as u32,
                &brush,
                0,
                std::ptr::null(),
            );
            let old_pen = SelectObject(hdc, pen as HGDIOBJ);
            let old_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH) as HGDIOBJ);
            Self {
                hdc,
                left,
                top,
                size,
                pen,
                old_pen,
                old_brush,
            }
        }
    }

    fn x(&self, value: f64) -> i32 {
        self.left + (value * self.size as f64 / ICON_VIEW).round() as i32
    }

    fn y(&self, value: f64) -> i32 {
        self.top + (value * self.size as f64 / ICON_VIEW).round() as i32
    }

    fn scale_of(&self, value: f64) -> i32 {
        (value * self.size as f64 / ICON_VIEW).round() as i32
    }

    fn line(&self, x1: f64, y1: f64, x2: f64, y2: f64) {
        unsafe {
            MoveToEx(self.hdc, self.x(x1), self.y(y1), std::ptr::null_mut());
            LineTo(self.hdc, self.x(x2), self.y(y2));
        }
    }

    fn poly(&self, points: &[(f64, f64)]) {
        let pts: Vec<POINT> = points
            .iter()
            .map(|(px, py)| POINT {
                x: self.x(*px),
                y: self.y(*py),
            })
            .collect();
        unsafe {
            Polyline(self.hdc, pts.as_ptr(), pts.len() as i32);
        }
    }

    fn circle(&self, cx: f64, cy: f64, r: f64) {
        unsafe {
            Ellipse(
                self.hdc,
                self.x(cx - r),
                self.y(cy - r),
                self.x(cx + r),
                self.y(cy + r),
            );
        }
    }

    fn round_rect(&self, x: f64, y: f64, w: f64, h: f64, r: f64) {
        let d = self.scale_of(r * 2.0).max(2);
        unsafe {
            RoundRect(
                self.hdc,
                self.x(x),
                self.y(y),
                self.x(x + w),
                self.y(y + h),
                d,
                d,
            );
        }
    }
}

impl Drop for IconCtx {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.hdc, self.old_pen);
            SelectObject(self.hdc, self.old_brush);
            DeleteObject(self.pen as HGDIOBJ);
        }
    }
}

/// 把一个按钮的图标画出来（坐标同 Lucide 的 24 视口）
fn draw_icon(hdc: HDC, action: Action, area: &RECT, tone: u32, scale: f64) {
    // 指针图标本身面积小，描边按 1.6 倍画才不会糊成一小撮像素
    let weight = if action == Action::Pick(Tool::Select) { 1.6 } else { 1.0 };
    let icon = IconCtx::new(hdc, area, tone, scale, weight);
    match action {
        // MousePointer2：宽一点的指针轮廓（照 Lucide 的四点多边形，比细长尾巴更像箭头）
        Action::Pick(Tool::Select) => {
            icon.poly(&[(4.0, 4.0), (20.0, 10.6), (13.6, 12.2), (12.0, 18.6), (4.0, 4.0)]);
        }
        // Square
        Action::Pick(Tool::Rect) => icon.round_rect(3.0, 3.0, 18.0, 18.0, 2.0),
        // Circle
        Action::Pick(Tool::Ellipse) => icon.circle(12.0, 12.0, 9.0),
        // ArrowUpRight
        Action::Pick(Tool::Arrow) => {
            icon.poly(&[(7.0, 7.0), (17.0, 7.0), (17.0, 17.0)]);
            icon.line(7.0, 17.0, 17.0, 7.0);
        }
        // Pencil：笔杆 + 笔尖
        Action::Pick(Tool::Pen) => {
            icon.poly(&[
                (3.2, 20.8),
                (4.6, 16.4),
                (15.6, 5.4),
                (18.6, 8.4),
                (7.6, 19.4),
                (3.2, 20.8),
            ]);
            icon.line(13.4, 7.6, 16.4, 10.6);
        }
        // Type
        Action::Pick(Tool::Text) => {
            icon.poly(&[(4.0, 7.0), (4.0, 4.0), (20.0, 4.0), (20.0, 7.0)]);
            icon.line(12.0, 4.0, 12.0, 20.0);
            icon.line(9.0, 20.0, 15.0, 20.0);
        }
        // ScanLine：四角框 + 中间一条线
        Action::Pick(Tool::Mosaic) => {
            icon.poly(&[(3.0, 7.0), (3.0, 5.0), (5.0, 3.0), (7.0, 3.0)]);
            icon.poly(&[(17.0, 3.0), (19.0, 3.0), (21.0, 5.0), (21.0, 7.0)]);
            icon.poly(&[(21.0, 17.0), (21.0, 19.0), (19.0, 21.0), (17.0, 21.0)]);
            icon.poly(&[(7.0, 21.0), (5.0, 21.0), (3.0, 19.0), (3.0, 17.0)]);
            icon.line(7.0, 12.0, 17.0, 12.0);
        }
        // Undo2：左箭头 + 半圆
        Action::Undo => {
            icon.poly(&[(9.0, 14.0), (4.0, 9.0), (9.0, 4.0)]);
            icon.line(4.0, 9.0, 14.5, 9.0);
            icon.poly(&arc_points(14.5, 14.5, 5.5, -90.0, 90.0));
            icon.line(14.5, 20.0, 11.0, 20.0);
        }
        // Redo2：镜像
        Action::Redo => {
            icon.poly(&[(15.0, 14.0), (20.0, 9.0), (15.0, 4.0)]);
            icon.line(20.0, 9.0, 9.5, 9.0);
            icon.poly(&arc_points(9.5, 14.5, 5.5, -90.0, -270.0));
            icon.line(9.5, 20.0, 13.0, 20.0);
        }
        // X
        Action::Close => {
            icon.line(6.0, 6.0, 18.0, 18.0);
            icon.line(18.0, 6.0, 6.0, 18.0);
        }
        // Copy：两张纸
        Action::Copy => {
            icon.round_rect(8.0, 8.0, 14.0, 14.0, 2.0);
            icon.poly(&[(4.0, 16.0), (4.0, 4.0), (16.0, 4.0)]);
        }
        // Download：箭头 + 托盘（对应「另存为」）
        Action::Save => {
            icon.line(12.0, 3.0, 12.0, 15.0);
            icon.poly(&[(7.0, 10.0), (12.0, 15.0), (17.0, 10.0)]);
            icon.poly(&[(4.0, 16.0), (4.0, 20.0), (20.0, 20.0), (20.0, 16.0)]);
        }
        // SquarePlus：方框加号（对应「插入笔记」）
        Action::Insert => {
            icon.round_rect(3.0, 3.0, 18.0, 18.0, 3.0);
            icon.line(12.0, 8.0, 12.0, 16.0);
            icon.line(8.0, 12.0, 16.0, 12.0);
        }
        // Lucide `Pin`：图钉（顶部横杆 + 收腰的针身 + 底部长杆）
        Action::Pin => {
            icon.poly(&[(9.0, 15.0), (9.0, 10.5), (7.0, 8.5), (7.0, 6.0), (17.0, 6.0), (17.0, 8.5), (15.0, 10.5), (15.0, 15.0)]);
            icon.line(5.0, 15.0, 19.0, 15.0);
            icon.line(12.0, 15.0, 12.0, 21.0);
        }
        _ => {}
    }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

pub fn union(
    a: (i32, i32, i32, i32),
    b: (i32, i32, i32, i32),
) -> (i32, i32, i32, i32) {
    let x0 = a.0.min(b.0);
    let y0 = a.1.min(b.1);
    let x1 = (a.0 + a.2).max(b.0 + b.2);
    let y1 = (a.1 + a.3).max(b.1 + b.3);
    (x0, y0, x1 - x0, y1 - y0)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = bgra.to_vec();
    for pixel in out.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    out
}

#[cfg(test)]
mod selection_border_tests {
    use super::*;

    /// 用户反馈：全局截图框选阶段的边框线要改成红色，且不能误把工具栏 / 角标也染红
    #[test]
    fn selection_border_is_red_and_distinct_from_toolbar() {
        assert_eq!(SELECTION_BORDER, cref(0xef_4444));
        assert_ne!(SELECTION_BORDER, FRAME);
        // GDI COLORREF 是 0x00BBGGRR：#ef4444 应存成 0x004444ef
        assert_eq!(SELECTION_BORDER & 0x00ff_ffff, 0x0044_44ef);
    }
}
