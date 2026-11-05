//! 「钉在顶层」的小窗
//!
//! 参考项目的 `pin_screenshot` 是把选区贴成一个独立窗口，方便一边看一边在别的
//! 应用里抄写。这里用同样的思路做一个原生版本：无边框、**真正置顶**、可拖动，
//! 双击 / Esc / 右键关闭。图片直接画在窗口上，不参与截图窗口的生命周期——
//! 截图窗关掉以后它还在。
//!
//! 实现在单独的消息循环线程里，一个 pin 一个线程，互不影响。
//!
//! 两个踩过的坑（别再踩回去）：
//! 1. 拖动**必须用屏幕坐标**（`GetCursorPos`）。用 `WM_MOUSEMOVE` 的客户区坐标时，
//!    窗口一移动客户区原点就跟着动，算出来的位移会自我抵消；更糟的是鼠标移出窗口后
//!    客户区坐标是**负数**，而 `lparam` 取出来的是 `u16`，`as i32` 会零扩展成 65531，
//!    窗口直接被瞬移到屏幕外——表现就是"拖动一下图就没了"。
//! 2. `WS_EX_TOPMOST` 只是"创建时属于置顶层"，宿主如果自己也是置顶窗口、或者别的
//!    程序后来抢了置顶，光靠样式不够。落地后再显式 `SetWindowPos(HWND_TOPMOST)`，
//!    并定时重申一次，保证它一直在最上面。

use std::ptr;
use std::sync::atomic::{AtomicIsize, Ordering};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EndPaint,
    InvalidateRect, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ, PAINTSTRUCT, SRCCOPY,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, SetFocus, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT, VK_ESCAPE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
    GetWindowLongPtrW, GetWindowRect, KillTimer, LoadCursorW, PostQuitMessage, RegisterClassW,
    SetForegroundWindow, SetTimer, SetWindowPos, ShowWindow, TranslateMessage, CS_DBLCLKS,
    CS_HREDRAW, CS_VREDRAW, GWL_EXSTYLE, HWND_TOPMOST, IDC_ARROW, MSG, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_SHOW, WM_CLOSE, WM_DESTROY, WM_KEYDOWN,
    WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MOUSEMOVE, WM_PAINT,
    WM_RBUTTONDOWN, WM_TIMER, WNDCLASSW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

/// `WM_MOUSELEAVE`：windows-sys 没在 `WindowsAndMessaging` 里导出，自己写值
const WM_MOUSELEAVE: u32 = 0x02A3;

/// 重申置顶的定时器：1.5 秒一次，保证任何程序抢了置顶之后它还能回来
const TOPMOST_TIMER: usize = 0x9A01;
const TOPMOST_INTERVAL_MS: u32 = 1500;

/// 一个 pin 窗口的运行时状态（每线程一份）
struct PinState {
    width: i32,
    height: i32,
    bitmap: HBITMAP,
    /// 拖动起点：按下时的**屏幕**坐标 + 当时的窗口矩形
    drag_from: Option<(POINT, RECT)>,
    /// 鼠标是否在窗口内（决定要不要画关闭按钮）
    hot: bool,
    /// 是否已经向系统登记了「鼠标离开通知」（`TrackMouseEvent` 只用登记一次）
    tracking: bool,
}

/// 关闭按钮的位置与尺寸（右上角，鼠标移进来才显示）
const CLOSE_SIZE: i32 = 22;
const CLOSE_MARGIN: i32 = 6;

fn close_rect(width: i32) -> RECT {
    RECT {
        left: width - CLOSE_SIZE - CLOSE_MARGIN,
        top: CLOSE_MARGIN,
        right: width - CLOSE_MARGIN,
        bottom: CLOSE_MARGIN + CLOSE_SIZE,
    }
}

thread_local! {
    static PIN: std::cell::RefCell<Option<PinState>> = const { std::cell::RefCell::new(None) };
}

/// 当前活着的 pin 数量，只用于日志
static PIN_COUNT: AtomicIsize = AtomicIsize::new(0);

/// 活着的 pin 窗口句柄：`screenshot/window` 报数量、自检收尾时一并关掉
static PIN_WINDOWS: std::sync::Mutex<Vec<isize>> = std::sync::Mutex::new(Vec::new());

/// 当前有几个钉图窗口
pub fn count() -> usize {
    PIN_WINDOWS.lock().map(|list| list.len()).unwrap_or(0)
}

/// 各钉图窗口的屏幕矩形（自检用：确认拖动真的挪了位置、且窗口还在）
pub fn rects() -> Vec<[i32; 4]> {
    rects_and_topmost()
        .into_iter()
        .map(|(rect, _)| rect)
        .collect()
}

/// 每个钉图窗口的矩形 + 是否真的挂在置顶层（`WS_EX_TOPMOST`）
pub fn rects_and_topmost() -> Vec<([i32; 4], bool)> {
    let handles = PIN_WINDOWS
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default();
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetWindowRect(handle as HWND, &mut rect) };
        if ok == 0 {
            continue;
        }
        let ex_style =
            unsafe { GetWindowLongPtrW(handle as HWND, GWL_EXSTYLE) } as u32;
        out.push((
            [
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
            ],
            ex_style & WS_EX_TOPMOST != 0,
        ));
    }
    out
}

/// 关掉所有钉图窗口（自检收尾用，避免测试在桌面上留一堆图）
pub fn close_all() {
    let handles = PIN_WINDOWS
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default();
    for handle in handles {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                handle as HWND,
                WM_CLOSE,
                0,
                0,
            );
        }
    }
}

/// 把一块 RGBA（标注结果）钉到屏幕 `at` 位置
///
/// 失败不抛给调用方——钉图只是顺手的能力，主流程（复制 / 存记录）不能因此失败。
pub fn pin(rgba: Vec<u8>, width: i32, height: i32, at: (i32, i32)) {
    if width <= 0 || height <= 0 || rgba.len() < (width * height * 4) as usize {
        crate::logln!("[dbx-note] 钉图失败：图像尺寸不合法（{width}×{height}）");
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("dbx-note-pin".into())
        .spawn(move || run(rgba, width, height, at));
    if let Err(error) = spawned {
        crate::logln!("[dbx-note] 钉图线程没能启动：{error}");
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn run(rgba: Vec<u8>, width: i32, height: i32, at: (i32, i32)) {
    let class = wide("DbxNotePinWindow");
    unsafe {
        let mut window_class: WNDCLASSW = std::mem::zeroed();
        window_class.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
        window_class.lpfnWndProc = Some(wndproc);
        window_class.hInstance = ptr::null_mut();
        window_class.hCursor = LoadCursorW(ptr::null_mut(), IDC_ARROW);
        window_class.lpszClassName = class.as_ptr();
        // 同一个类名重复注册会返回 0，多开几个 pin 仍然可用
        RegisterClassW(&window_class);

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class.as_ptr(),
            class.as_ptr(),
            WS_POPUP,
            at.0,
            at.1,
            width,
            height,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        );
        if hwnd.is_null() {
            crate::logln!("[dbx-note] 钉图窗口创建失败");
            return;
        }

        // 图像一次性写进 DIB 段，之后每帧只做一次 BitBlt
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut bits: *mut std::ffi::c_void = ptr::null_mut();
        let bitmap = CreateDIBSection(
            ptr::null_mut(),
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            ptr::null_mut(),
            0,
        );
        if bitmap.is_null() || bits.is_null() {
            crate::logln!("[dbx-note] 钉图位图创建失败");
            DestroyWindow(hwnd);
            return;
        }
        let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, (width * height * 4) as usize);
        for (index, chunk) in rgba.chunks_exact(4).enumerate() {
            let base = index * 4;
            pixels[base] = chunk[2];
            pixels[base + 1] = chunk[1];
            pixels[base + 2] = chunk[0];
            pixels[base + 3] = 255;
        }

        PIN.with(|cell| {
            *cell.borrow_mut() = Some(PinState {
                width,
                height,
                bitmap,
                drag_from: None,
                hot: false,
                tracking: false,
            });
        });

        if let Ok(mut list) = PIN_WINDOWS.lock() {
            list.push(hwnd as isize);
        }
        ShowWindow(hwnd, SW_SHOW);
        // 样式里的 TOPMOST 只是"创建时属于置顶层"，这里再显式抬一次：
        // 宿主自己是置顶窗口时，新窗口不一定会被放到它上面。
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            at.0,
            at.1,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        SetForegroundWindow(hwnd);
        // Esc 是**焦点窗口**才收得到的：只把窗口提到前台而不给它焦点，
        // 键盘消息会落到别处，用户按 Esc 就像没反应。
        SetFocus(hwnd);
        SetTimer(hwnd, TOPMOST_TIMER, TOPMOST_INTERVAL_MS, None);
        InvalidateRect(hwnd, ptr::null(), 0);
        let alive = PIN_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
        crate::logln!("[dbx-note] 已钉图（{} × {}，当前 {alive} 个）", width, height);

        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        PIN_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = unsafe { std::mem::zeroed() };
            let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
            let hot = PIN.with(|cell| {
                let borrow = cell.borrow();
                let Some(state) = borrow.as_ref() else {
                    return false;
                };
                unsafe {
                    let memory = CreateCompatibleDC(hdc);
                    if memory.is_null() {
                        return false;
                    }
                    let old = SelectObject(memory, state.bitmap as HGDIOBJ);
                    BitBlt(hdc, 0, 0, state.width, state.height, memory, 0, 0, SRCCOPY);
                    SelectObject(memory, old);
                    DeleteDC(memory);
                }
                state.hot
            });
            // 鼠标移进来才画关闭按钮：贴图是给人看的，常驻一个叉会挡住内容
            if hot {
                let rect = close_rect(PIN.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .map(|state| state.width)
                        .unwrap_or(0)
                }));
                unsafe { draw_close_on(hdc, &rect) };
            }
            unsafe { EndPaint(hwnd, &mut ps) };
            0
        }
        // 拖动的唯一正确做法：屏幕坐标求差，再整体平移窗口。
        // 用客户区坐标会在窗口自己移动时算错，鼠标移出窗口还会因为 u16 零扩展而爆掉。
        WM_LBUTTONDOWN => {
            let (x, y) = (low(lparam), high(lparam));
            // 点在关闭按钮上就直接关，别进入拖动（否则用户会以为没反应）
            let width = PIN.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .map(|state| state.width)
                    .unwrap_or(0)
            });
            let close = close_rect(width);
            if x >= close.left && x < close.right && y >= close.top && y < close.bottom {
                unsafe { DestroyWindow(hwnd) };
                return 0;
            }
            unsafe {
                SetForegroundWindow(hwnd);
                SetFocus(hwnd);
                let mut cursor: POINT = std::mem::zeroed();
                let mut rect: RECT = std::mem::zeroed();
                GetCursorPos(&mut cursor);
                GetWindowRect(hwnd, &mut rect);
                PIN.with(|cell| {
                    if let Some(state) = cell.borrow_mut().as_mut() {
                        state.drag_from = Some((cursor, rect));
                    }
                });
                SetCapture(hwnd);
            }
            0
        }
        WM_MOUSEMOVE => {
            // 悬停状态变化就重画（关掉按钮的显示/隐藏要跟着走）
            let (x, y) = (low(lparam), high(lparam));
            let dirty = PIN.with(|cell| {
                let mut borrow = cell.borrow_mut();
                let Some(state) = borrow.as_mut() else {
                    return false;
                };
                let next = x >= 0
                    && y >= 0
                    && x < state.width
                    && y < state.height;
                let changed = next != state.hot;
                state.hot = next;
                if !state.tracking {
                    state.tracking = true;
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    TrackMouseEvent(&mut track);
                }
                changed
            });
            if dirty {
                unsafe { InvalidateRect(hwnd, ptr::null(), 0) };
            }
            let target = PIN.with(|cell| {
                let borrow = cell.borrow();
                let state = borrow.as_ref()?;
                let (from, rect) = state.drag_from.as_ref()?;
                let mut cursor: POINT = unsafe { std::mem::zeroed() };
                unsafe { GetCursorPos(&mut cursor) };
                Some((
                    rect.left + (cursor.x - from.x),
                    rect.top + (cursor.y - from.y),
                ))
            });
            if let Some((left, top)) = target {
                unsafe {
                    // 只挪位置：尺寸不动、层级保持置顶、也不抢前台
                    SetWindowPos(
                        hwnd,
                        ptr::null_mut(),
                        left,
                        top,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
            }
            0
        }
        WM_LBUTTONUP => {
            PIN.with(|cell| {
                if let Some(state) = cell.borrow_mut().as_mut() {
                    state.drag_from = None;
                }
            });
            unsafe { ReleaseCapture() };
            0
        }
        WM_MOUSELEAVE => {
            let changed = PIN.with(|cell| {
                let mut borrow = cell.borrow_mut();
                let Some(state) = borrow.as_mut() else {
                    return false;
                };
                state.tracking = false;
                let changed = state.hot;
                state.hot = false;
                changed
            });
            if changed {
                unsafe { InvalidateRect(hwnd, ptr::null(), 0) };
            }
            0
        }
        // 定时重申置顶：别的程序（放映、录屏、置顶的宿主）抢了置顶也能回来
        WM_TIMER => {
            if wparam == TOPMOST_TIMER {
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
            0
        }
        // 双击 / 右键 / Esc / 中键都关掉：贴图是临时参照，关掉要足够顺手
        WM_LBUTTONDBLCLK | WM_RBUTTONDOWN | WM_MBUTTONDOWN => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_KEYDOWN => {
            if wparam as u32 == VK_ESCAPE as u32 {
                unsafe { DestroyWindow(hwnd) };
            }
            0
        }
        WM_DESTROY => {
            unsafe { KillTimer(hwnd, TOPMOST_TIMER) };
            if let Ok(mut list) = PIN_WINDOWS.lock() {
                list.retain(|handle| *handle != hwnd as isize);
            }
            PIN.with(|cell| {
                if let Some(state) = cell.borrow_mut().take() {
                    unsafe { DeleteObject(state.bitmap as HGDIOBJ) };
                }
            });
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// `lparam` 里取点的低 16 位
///
/// 必须走 `as i16`：鼠标移到窗口左/上方时客户区坐标是**负数**，直接 `as i32`
/// 会零扩展成 65531 这种值，命中判定与拖动位移全都会飞掉。
fn low(value: LPARAM) -> i32 {
    (value as u32 as u16 as i16) as i32
}

fn high(value: LPARAM) -> i32 {
    ((value as u32 >> 16) as u16 as i16) as i32
}

/// 在 DC 上画关闭按钮（独立的 `HDC` 版本，方便直接复用）
unsafe fn draw_close_on(dc: windows_sys::Win32::Graphics::Gdi::HDC, rect: &RECT) {
    use windows_sys::Win32::Graphics::Gdi::{
        CreatePen, CreateSolidBrush, Ellipse, LineTo, MoveToEx, PS_SOLID, SetBkMode,
        TRANSPARENT,
    };

    let brush = CreateSolidBrush(0x0018_1818);
    let old_brush = SelectObject(dc, brush as HGDIOBJ);
    let pen = CreatePen(PS_SOLID as i32, 1, 0x0018_1818);
    let old_pen = SelectObject(dc, pen as HGDIOBJ);
    Ellipse(dc, rect.left, rect.top, rect.right, rect.bottom);
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    DeleteObject(brush as HGDIOBJ);
    DeleteObject(pen as HGDIOBJ);

    let cx = (rect.left + rect.right) / 2;
    let cy = (rect.top + rect.bottom) / 2;
    let arm = 4;
    let white = CreatePen(PS_SOLID as i32, 2, 0x00ff_ffff);
    let old = SelectObject(dc, white as HGDIOBJ);
    SetBkMode(dc, TRANSPARENT as i32);
    MoveToEx(dc, cx - arm, cy - arm, ptr::null_mut());
    LineTo(dc, cx + arm + 1, cy + arm + 1);
    MoveToEx(dc, cx + arm, cy - arm, ptr::null_mut());
    LineTo(dc, cx - arm - 1, cy + arm + 1);
    SelectObject(dc, old);
    DeleteObject(white as HGDIOBJ);
}
