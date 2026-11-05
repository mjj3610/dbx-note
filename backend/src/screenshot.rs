//! 全屏框选 + 全局热键
//!
//! 插件 UI 跑在宿主窗口的 iframe 里，没法把界面铺到整个桌面，所以框选这一段放到
//! Sidecar：先把整块虚拟桌面（含所有显示器）抓成位图，再建一个覆盖全屏的置顶无边框
//! 窗口，把这张图 **1:1** 画上去，鼠标直接在这张原图上拉框——选区外压暗、左上角实时
//! 显示尺寸，松手即裁出选区。松手/取消后窗口销毁，坐标还原到物理像素，不存在「先把
//! 桌面缩进插件窗口再选」的二次缩放。
//!
//! 另外注册一个系统级热键（默认 `Alt+Shift+Z`）：插件不在前台时也能直接框选。全局路径
//! 选完**不跳回插件**——选区内保持 1:1 原始像素、选区外压暗，原地弹出工具栏（工具 / 颜色 /
//! 粗细 / 撤销 / 复制 / 插入笔记 / 保存到记录，与编辑器里那套完全一致），标完再选出口。
//!
//! 两条路径的区别只有「谁来框选」：编辑器里点截图按钮由插件浮层框（`screenshot/select`），
//! 桌面上按热键由这个原生窗口框（`capture_to_clipboard`），工具栏是同一套。

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::screenshot_ink::Exit;
use crate::{native, RpcError, RpcResult};

/// 框选窗口同一时刻只允许一个
static SELECTING: AtomicBool = AtomicBool::new(false);
/// 前端「截图快捷键」keydown 命中的时间：全局热键线程据此让位
///
/// 以前用「最近 600ms 内有任何 RPC」来判断，宿主心跳 / 后台轮询会把全局热键
/// 永久压制（离开插件后按热键没反应），现在只认这个精确标记。
static UI_HOTKEY_MS: AtomicI64 = AtomicI64::new(0);
/// 全局热键产出的截图，等插件下次聚焦时取走
static PENDING: Mutex<Option<Value>> = Mutex::new(None);
/// 全局热键注册状态（设置页展示）
static HOTKEY: Mutex<Option<HotkeyState>> = Mutex::new(None);
/// 最近一次框选窗口的自检信息（可见性 / 绘制次数 / 位置），供测试与排障读取
static WINDOW_PROBE: Mutex<Option<Value>> = Mutex::new(None);
/// 最近一次**就地标注**阶段的自检信息（工具栏矩形 / 按钮数 / 档位）
///
/// 「全局截图当场出工具栏」是肉眼才看得出的东西，自动化没法拉鼠标，所以要有一个
/// 机器可读的证据：工具栏真的算出来了、按钮真的排在窗口里、档位和插件浮层一致。
static ANNOTATE_PROBE: Mutex<Option<Value>> = Mutex::new(None);

/// 自检时用 RPC 指定的出口（0=不指定，1=复制，2=插入笔记，3=保存到记录）
///
/// 模拟按键在锁屏 / 远程会话 / CI 里经常被系统丢掉，全局热键那条链路就没法自动验证；
/// 自检改为直接调 `screenshot/globalShot`，再用这个覆盖值代替「人去点按钮」。
static EXIT_OVERRIDE: AtomicI32 = AtomicI32::new(0);

const HOTKEY_ID: i32 = 0x5A01;

#[derive(Clone)]
struct HotkeyState {
    combo: String,
    registered: bool,
    reason: String,
}

/// `screenshot/uiHotkey`：前端快捷键已接手，全局热键这次让位
pub fn mark_ui_hotkey() -> RpcResult {
    UI_HOTKEY_MS.store(crate::now_ms(), Ordering::SeqCst);
    Ok(json!({ "ok": true }))
}

fn ui_hotkey_recent(window_ms: i64) -> bool {
    let last = UI_HOTKEY_MS.load(Ordering::SeqCst);
    last > 0 && crate::now_ms() - last < window_ms
}

/// e2e / 无交互桌面下强制走「整屏交给插件浮层」的老路径
fn plugin_mode() -> bool {
    matches!(
        std::env::var("DBX_NOTE_SCREENSHOT_MODE").ok().as_deref(),
        Some("plugin")
    )
}

/* ------------------------------------------------------------------ */
/* 对外 RPC                                                            */
/* ------------------------------------------------------------------ */

/// `screenshot/select`：在真实桌面上框选，返回裁剪后的 PNG
pub fn select() -> RpcResult {
    if plugin_mode() {
        // 测试 / 降级路径：整屏回传，由插件浮层自己框选
        let mut shot = native::capture_screen()?;
        shot["mode"] = json!("plugin");
        return Ok(shot);
    }

    if SELECTING.load(Ordering::SeqCst) {
        return Err(RpcError::internal("截图窗口已打开"));
    }

    // 编辑器路径不在这里标注：图交回插件浮层，用页面里那套工具栏
    let picked = run_selection(false).map_err(RpcError::internal)?;
    let encoded = native::rgba_png_base64(picked.width, picked.height, &picked.rgba)
        .map_err(RpcError::internal)?;
    Ok(json!({
        "dataBase64": encoded,
        "width": picked.width,
        "height": picked.height,
        "mime": "image/png",
        "mode": "native",
        "x": picked.x,
        "y": picked.y,
    }))
}

/// `screenshot/globalShot`：以 RPC 方式跑一遍「全局热键」那条链路（自检 / 排障用）
///
/// 做的和热键线程完全一样：`capture_to_clipboard` → 桌面框选 → 原地标注 → 按出口收尾。
/// 只有设了 `DBX_NOTE_SCREENSHOT_AUTO` 的自检环境才开放，正常使用下不暴露；
/// `params.exit` 可以指定出口（copy / insert / record），省掉模拟点击。
pub fn global_shot(params: &Value) -> RpcResult {
    if std::env::var("DBX_NOTE_SCREENSHOT_AUTO").is_err() {
        return Err(RpcError::internal("该入口仅在自检环境开放"));
    }
    if SELECTING.load(Ordering::SeqCst) {
        return Err(RpcError::internal("截图窗口已打开"));
    }
    let override_code = match params.get("exit").and_then(Value::as_str) {
        Some("copy") => 1,
        Some("insert") => 2,
        Some("record") => 3,
        // 等价于按 Esc：验证「取消之后什么都不该留下」
        Some("cancel") => 4,
        // 等价于点「钉在顶层」：验证桌面真的多了一个置顶窗口
        Some("pin") => 5,
        _ => 0,
    };
    EXIT_OVERRIDE.store(override_code, Ordering::SeqCst);
    let result = capture_to_clipboard();
    EXIT_OVERRIDE.store(0, Ordering::SeqCst);
    // 取消是正常结局（等价于用户按了 Esc），不该当错误返回
    if let Err(message) = &result {
        if message.contains("已取消截图") {
            return Ok(json!({ "ok": true, "exit": "cancel" }));
        }
    }
    result.map_err(RpcError::internal)?;
    Ok(json!({ "ok": true, "exit": params.get("exit").and_then(Value::as_str).unwrap_or("done") }))
}

/// `screenshot/takePending`：取走全局热键留下的截图（没有则 null）
///
/// 只保留两分钟：图已经进过剪贴板，太久之后再弹标注反而会打断人。
pub fn take_pending() -> RpcResult {
    let mut guard = PENDING
        .lock()
        .map_err(|_| RpcError::internal("截图队列被占用"))?;
    let taken = guard.take().unwrap_or(Value::Null);
    let fresh = taken
        .get("at")
        .and_then(Value::as_i64)
        .map(|at| crate::now_ms() - at < 120_000)
        .unwrap_or(false);
    if fresh {
        Ok(taken)
    } else {
        Ok(Value::Null)
    }
}

/// `screenshot/hotkey`：全局热键注册状态
pub fn hotkey_status() -> RpcResult {
    let guard = HOTKEY
        .lock()
        .map_err(|_| RpcError::internal("热键状态被占用"))?;
    match guard.as_ref() {
        Some(state) => Ok(json!({
            "combo": state.combo,
            "registered": state.registered,
            "reason": state.reason,
        })),
        None => Ok(json!({
            "combo": "",
            "registered": false,
            "reason": "尚未注册",
        })),
    }
}

/// `screenshot/pressKey`：往框选窗口投一个按键（自检专用）
///
/// 锁屏 / 远程会话里 `SendInput` 会被系统丢掉，但「切工具、Esc 退出」这些交互本身
/// 还是要能被自动化验证，所以给一个直接投递 `WM_KEYDOWN` 的口子。
pub fn press_key(params: &serde_json::Value) -> RpcResult {
    let hwnd = WINDOW_HWND.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
    if hwnd.is_null() {
        return Err(RpcError::invalid("框选窗口没打开"));
    }
    let key = params
        .get("key")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let code = match key {
        "esc" => 0x1B,
        "enter" => 0x0D,
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(ch), None) => ch.to_ascii_uppercase() as u32,
                _ => return Err(RpcError::invalid("按键只支持单个字符或 esc / enter")),
            }
        }
    };
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::WM_KEYDOWN,
            code as usize,
            0,
        );
    }
    Ok(json!({ "ok": true, "key": key }))
}

/// `screenshot/typeText`：往文字输入框打一段字符（自检专用）
pub fn type_text(params: &serde_json::Value) -> RpcResult {
    window::type_text(params)
}

/// `screenshot/unpinAll`：关掉所有钉图窗口（自检收尾用）
pub fn unpin_all() -> RpcResult {
    crate::pin::close_all();
    Ok(json!({ "ok": true }))
}

/// `screenshot/pin`：把插件浮层里的标注结果钉到桌面上
///
/// 浮层跑在宿主的 iframe 里，没法自己开桌面窗口，所以把图交回 Sidecar。
/// 落点默认贴着截图选区左上角，被参数覆盖时按 `x` / `y` 放。
pub fn pin_image(params: &serde_json::Value) -> RpcResult {
    let data = params
        .get("dataBase64")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if data.is_empty() {
        return Err(RpcError::invalid("缺少图片数据"));
    }
    let (width, height, rgba) =
        native::rgba_from_png_base64(data).map_err(RpcError::invalid)?;
    let x = params.get("x").and_then(|value| value.as_i64()).unwrap_or(120) as i32;
    let y = params.get("y").and_then(|value| value.as_i64()).unwrap_or(140) as i32;
    crate::pin::pin(rgba, width as i32, height as i32, (x, y));
    crate::logln!("[dbx-note] 浮层截图已钉在桌面（{width} × {height} @ {x},{y}）");
    Ok(json!({ "ok": true, "width": width, "height": height }))
}

/// `screenshot/window`：上一次框选窗口的自检信息（测试与排障用）
///
/// `annotate` 字段在「就地标注」阶段才有值：全局热键路径下工具栏是不是真的算出来、
/// 按钮是不是都排进了窗口、档位和插件浮层是不是同一套，都靠它证明。
pub fn window_probe() -> RpcResult {
    let mut value = WINDOW_PROBE
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_else(|| json!({}));
    let annotate = ANNOTATE_PROBE.lock().ok().and_then(|guard| guard.clone());
    let dib = DIB_SIZE.lock().ok().and_then(|guard| *guard);
    let hwnd = WINDOW_HWND.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
    let stored = LAST_PIXELS.lock().ok().and_then(|guard| *guard);
    // 窗口还在就现场比对；已经关了就把标注开场那一帧的结论报出来
    let pixels = if hwnd.is_null() {
        stored
    } else {
        compare_pixels(hwnd).or(stored)
    };
    if let Some(map) = value.as_object_mut() {
        // 窗口句柄已经清了 = 这一轮确实关掉了：把旧快照里的 `visible` 翻成 false，
        // 否则自检读到的永远是「关窗前还开着」，验不出窗口有没有真的退出。
        if hwnd.is_null() {
            map.insert("visible".into(), json!(false));
        }
        // 「钉在顶层」的窗口数量：自检据此确认图片真的贴到桌面上了
        map.insert("pins".into(), json!(crate::pin::count()));
        map.insert("pinRects".into(), json!(crate::pin::rects()));
        map.insert(
            "pinTopmost".into(),
            json!(crate::pin::rects_and_topmost()
                .into_iter()
                .map(|(_, topmost)| topmost)
                .collect::<Vec<_>>()),
        );
        // 绘制耗时：拖拽/调粗细时每帧多少毫秒。超过 ~16ms 就会肉眼可见地卡
        {
            let frames = PAINT_COUNT.load(Ordering::SeqCst).max(1) as u64;
            let total = PAINT_US.load(Ordering::SeqCst);
            let worst = PAINT_MAX_US.load(Ordering::SeqCst);
            map.insert(
                "paint".into(),
                json!({
                    "frames": frames,
                    "avgMs": (total as f64 / frames as f64 / 1000.0 * 10.0).round() / 10.0,
                    "maxMs": (worst as f64 / 1000.0 * 10.0).round() / 10.0,
                }),
            );
        }
        map.insert("annotate".into(), annotate.unwrap_or(Value::Null));
        map.insert(
            "dib".into(),
            match dib {
                Some((width, height)) => json!([width, height]),
                None => Value::Null,
            },
        );
        // 「选区里到底是不是那块原像素」+「选区外是不是压暗了」的机器可读证据
        map.insert(
            "pixels".into(),
            match pixels {
                Some((inside_total, inside_bad, outside_total, outside_bad)) => json!({
                    "inside": { "checked": inside_total, "mismatch": inside_bad },
                    "outside": { "checked": outside_total, "mismatch": outside_bad },
                }),
                None => Value::Null,
            },
        );
    }
    Ok(value)
}

/// 默认候选：按顺序挑第一个能注册上的
///
/// `Alt+Shift+Z`（对齐参考实现）在不少机器上已经被宿主或别的软件占走，光用一个
/// 组合会让「全局截图」直接失效，所以准备一条备选链，注册到哪个就用哪个，
/// 实际生效的组合会通过 `screenshot/hotkey` 报给设置页展示。
const HOTKEY_CANDIDATES: [&str; 5] = [
    "Alt+Shift+Z",
    "Ctrl+Alt+Z",
    "Alt+Shift+X",
    "Alt+Shift+D",
    "Ctrl+Alt+Shift+Z",
];

/// 启动全局热键监听线程（注册失败不影响其它功能，只是没全局入口）
///
/// `preferred` 非空时只用它（设置里指定 / 测试用），否则按候选链逐个尝试。
pub fn start_hotkey(preferred: Option<String>) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::RegisterHotKey;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, WM_HOTKEY};

    let candidates: Vec<String> = match preferred {
        Some(combo) => vec![combo],
        None => HOTKEY_CANDIDATES.iter().map(|item| item.to_string()).collect(),
    };

    let spawned = std::thread::Builder::new()
        .name("dbx-shot-hotkey".into())
        .spawn(move || {
            let mut active: Option<String> = None;
            let mut last_reason = String::from("快捷键格式无法识别");
            for combo in &candidates {
                let Some((modifiers, virtual_key)) = parse_combo(combo) else {
                    continue;
                };
                let registered = unsafe {
                    RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, modifiers, virtual_key)
                } != 0;
                if registered {
                    active = Some(combo.clone());
                    break;
                }
                last_reason = "该组合已被其它程序占用".into();
            }

            let Some(combo) = active else {
                store_hotkey(candidates.first().map(String::as_str).unwrap_or(""), false, &last_reason);
                return;
            };
            store_hotkey(&combo, true, "");

            loop {
                let mut message: windows_sys::Win32::UI::WindowsAndMessaging::MSG =
                    unsafe { std::mem::zeroed() };
                let got = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
                if got <= 0 {
                    break;
                }
                if message.message != WM_HOTKEY {
                    continue;
                }
                // 插件窗口在前台时，前端自己的 keydown 会先打 uiHotkey 标记再走同一套框选；
                // 稍微等一下让标记先到，有标记或框选窗口已开就让给前端，避免弹两个窗口。
                // 注意只认 uiHotkey 标记：宿主心跳 / 后台轮询的 RPC 不该压制全局热键。
                std::thread::sleep(Duration::from_millis(150));
                if SELECTING.load(Ordering::SeqCst) || ui_hotkey_recent(600) {
                    continue;
                }
                if let Err(error) = capture_to_clipboard() {
                    // 用户按 Esc / 点关闭是正常操作，不该在日志里报成失败
                    if !error.contains("已取消截图") {
                        crate::logln!("[dbx-note] 全局截图失败：{error}");
                    }
                }
            }
        });

    if spawned.is_err() {
        store_hotkey(
            HOTKEY_CANDIDATES.first().copied().unwrap_or(""),
            false,
            "无法创建热键线程",
        );
    }
}

fn store_hotkey(combo: &str, registered: bool, reason: &str) {
    if let Ok(mut guard) = HOTKEY.lock() {
        *guard = Some(HotkeyState {
            combo: combo.to_string(),
            registered,
            reason: reason.to_string(),
        });
    }
}

/// 记录框选窗口的自检信息（client = 客户区尺寸，与位图不一致说明显示被缩放）
fn store_probe_full(visible: bool, painted: u32, rect: Vec<i32>, client: Vec<i32>) {
    if let Ok(mut guard) = WINDOW_PROBE.lock() {
        *guard = Some(json!({
            "visible": visible,
            "painted": painted,
            "rect": rect,
            "client": client,
        }));
    }
}

/// 记录就地标注阶段的自检信息
fn store_probe_annotate(value: Value) {
    if let Ok(mut guard) = ANNOTATE_PROBE.lock() {
        *guard = Some(value);
    }
}

/// 清掉上一轮的标注探针：每次框选从干净状态开始，避免读到陈旧结论
fn reset_probe_annotate() {
    if let Ok(mut guard) = ANNOTATE_PROBE.lock() {
        *guard = None;
    }
}

/* ------------------------------------------------------------------ */
/* 像素级自检：选区里画的到底是不是那块原像素                          */
/* ------------------------------------------------------------------ */

/// 一次抽样：坐标 + 该位置「应该」显示的颜色（RGB）
type SamplePoint = (i32, i32, [u8; 3]);

/// 窗口线程填、探针线程读的期望像素
///
/// 用户反馈「拖拽时选区里出现了这块区域没有的内容」时，光看几何没法判断到底错在哪：
/// 位置对但像素错、像素对但位置偏，是两种完全不同的 bug。这里由窗口线程按合成源
/// （`bright` / `dim`）取十几个采样点，`screenshot/window` 再拿窗口实际像素逐个比对，
/// 把「1:1 还是被缩放/偏移」变成一个可以写进日志的数字。
#[derive(Clone, Default)]
struct PixelSamples {
    /// 选区内：应该等于 `bright`（原亮度）
    inside: Vec<SamplePoint>,
    /// 选区外：应该等于 `dim`（压暗 46%）
    outside: Vec<SamplePoint>,
}

static PIXEL_SAMPLES: Mutex<Option<PixelSamples>> = Mutex::new(None);
static WINDOW_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static DIB_SIZE: Mutex<Option<(i32, i32)>> = Mutex::new(None);

/// 标注阶段**第一帧**（此时还没有任何形状）的像素比对结论
///
/// 窗口一关就读不到像素了（`WM_DESTROY` 会把句柄清零），但自动化与事后排查需要的
/// 正是「那一帧到底对不对」。所以在标注开场、窗口还活着时算一次存下来，
/// 之后 `screenshot/window` 即使窗口已经关掉也能报告这一帧的结论。
static LAST_PIXELS: Mutex<Option<(usize, usize, usize, usize)>> = Mutex::new(None);
/// 每个窗口只取一次结论（`GetPixel` 不便宜，不能每帧都做）
static VERDICT_TAKEN: AtomicBool = AtomicBool::new(false);

/// WM_PAINT 实际执行次数：0 说明窗口虽然建了但一帧都没画
static PAINT_COUNT: AtomicU32 = AtomicU32::new(0);
/// 绘制耗时（微秒累计 / 单帧峰值）：拖拽卡不卡，看这两个数就有答案
static PAINT_US: AtomicU64 = AtomicU64::new(0);
static PAINT_MAX_US: AtomicU64 = AtomicU64::new(0);

/// 从 BGRA 缓冲区读一个像素（越界返回 None）
fn sample_at(bgra: &[u8], width: i32, height: i32, x: i32, y: i32) -> Option<[u8; 3]> {
    if x < 0 || y < 0 || x >= width || y >= height {
        return None;
    }
    let index = ((y as usize) * (width as usize) + (x as usize)) * 4;
    let slice = bgra.get(index..index + 3)?;
    Some([slice[2], slice[1], slice[0]])
}

/// 拿窗口实际像素和期望值比对，返回 (选区内总数, 选区内不符, 选区外总数, 选区外不符)
fn compare_pixels(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<(usize, usize, usize, usize)> {
    use windows_sys::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
    let guard = PIXEL_SAMPLES.lock().ok()?;
    let samples = guard.as_ref()?;
    if samples.inside.is_empty() && samples.outside.is_empty() {
        return None;
    }
    unsafe {
        let hdc = GetDC(hwnd);
        if hdc.is_null() {
            return None;
        }
        let check = |points: &[SamplePoint]| {
            let mut mismatch = 0;
            for (x, y, expected) in points {
                let value = GetPixel(hdc, *x, *y);
                if value == u32::MAX {
                    continue;
                }
                let actual = [(value & 0xff) as u8, ((value >> 8) & 0xff) as u8, ((value >> 16) & 0xff) as u8];
                let diff = (0..3)
                    .map(|index| (actual[index] as i32 - expected[index] as i32).abs())
                    .max()
                    .unwrap_or(0);
                // 允许 4 级误差：DWM 合成 / 视频抖动都可能差一两级
                if diff > 4 {
                    mismatch += 1;
                }
            }
            (points.len(), mismatch)
        };
        let (inside_total, inside_bad) = check(&samples.inside);
        let (outside_total, outside_bad) = check(&samples.outside);
        ReleaseDC(hwnd, hdc);
        Some((inside_total, inside_bad, outside_total, outside_bad))
    }
}

/// "Alt+Shift+Z" → (修饰键, 虚拟键码)
fn parse_combo(combo: &str) -> Option<(u32, u32)> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
    };

    let mut modifiers = MOD_NOREPEAT;
    let mut key: Option<u32> = None;
    for part in combo.split('+') {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        match token.to_ascii_lowercase().as_str() {
            "alt" => modifiers |= MOD_ALT,
            "ctrl" | "control" => modifiers |= MOD_CONTROL,
            "shift" => modifiers |= MOD_SHIFT,
            "win" | "meta" | "super" | "cmd" => modifiers |= MOD_WIN,
            other => {
                // F1–F24
                if let Some(rest) = other.strip_prefix('f') {
                    if let Ok(number) = rest.parse::<u32>() {
                        if (1..=24).contains(&number) {
                            key = Some(0x70 + number - 1);
                            continue;
                        }
                    }
                }
                match other {
                    "printscreen" | "prtsc" | "prtscr" => key = Some(0x2C),
                    "space" => key = Some(0x20),
                    _ => {
                        let chars: Vec<char> = other.chars().collect();
                        if chars.len() == 1 {
                            let upper = chars[0].to_ascii_uppercase();
                            if upper.is_ascii_alphanumeric() {
                                key = Some(upper as u32);
                            }
                        }
                    }
                }
            }
        }
    }
    key.map(|key| (modifiers, key))
}

/// 全局热键路径：框选 → 就地标注 → 复制 / 插入笔记 / 保存到记录
///
/// 工具栏和编辑器里点截图按钮时用的是**同一套**（`screenshot_ink` 里的七个工具、四个
/// 颜色、四档粗细、撤销 / 重做、复制 / 插入笔记 / 保存到记录）。区别只有「谁来框选」：
/// 编辑器里由插件浮层框，桌面上由这个原生窗口框；框完之后都在原地标注。
///
/// 选「插入笔记 / 保存到记录」时，把标注好的图放进剪贴板 + 挂起项，再把宿主拉到前台；
/// 页面侧拿到挂起项后直接落库 / 插入，不再弹第二个标注浮层。
fn capture_to_clipboard() -> Result<(), String> {
    let picked = run_selection(true)?;
    let exit = picked.exit;
    match exit {
        // 复制：只进剪贴板，前台窗口不动——用户还留在原来那个应用里，直接粘贴
        Some(Exit::Copy) => {
            native::rgba_to_clipboard(&picked.rgba, picked.width, picked.height)?;
            crate::logln!(
                "[dbx-note] 全局截图已复制到剪贴板（{} × {}）",
                picked.width,
                picked.height
            );
            Ok(())
        }
        Some(action @ (Exit::Insert | Exit::Record)) => {
            // 剪贴板只是顺手给用户留一份：它被别的程序短暂占住不该让「存记录 / 插入笔记」失败
            if let Err(error) = native::rgba_to_clipboard(&picked.rgba, picked.width, picked.height) {
                crate::logln!("[dbx-note] 全局截图未能写入剪贴板（不影响后续动作）：{error}");
            }
            let encoded = native::rgba_png_base64(picked.width, picked.height, &picked.rgba)?;
            let payload = json!({
                "dataBase64": encoded,
                "width": picked.width,
                "height": picked.height,
                "mime": "image/png",
                "mode": "native",
                "source": "global",
                "action": match action {
                    Exit::Record => "record",
                    _ => "insert",
                },
                "at": crate::now_ms(),
            });
            let mut guard = PENDING.lock().map_err(|_| "截图队列被占用".to_string())?;
            *guard = Some(payload);
            drop(guard);
            let focused = native::focus_host_window();
            crate::logln!(
                "[dbx-note] 全局截图完成：{:?} · 宿主前置 = {focused}（{} × {}）",
                action,
                picked.width,
                picked.height
            );
            Ok(())
        }
        // 钉图：贴成置顶小窗，不写剪贴板、不打扰前台窗口
        Some(Exit::Pin) => {
            let at = (picked.x, picked.y);
            crate::pin::pin(
                picked.rgba.clone(),
                picked.width as i32,
                picked.height as i32,
                at,
            );
            crate::logln!(
                "[dbx-note] 全局截图已钉在桌面（{} × {} @ {},{}）",
                picked.width,
                picked.height,
                at.0,
                at.1
            );
            Ok(())
        }
        // Esc / 取消按钮：什么都不做
        None => {
            crate::logln!("[dbx-note] 全局截图已取消");
            Ok(())
        }
    }
}

/// 框选一次；`annotate` 为真时选完留在原地标注（全局热键路径）
fn run_selection(annotate: bool) -> Result<window::Picked, String> {
    if SELECTING.swap(true, Ordering::SeqCst) {
        return Err("截图窗口已打开".into());
    }
    reset_probe_annotate();
    let outcome = window::select_region(annotate);
    SELECTING.store(false, Ordering::SeqCst);
    outcome
}

/* ------------------------------------------------------------------ */
/* 原生框选窗口                                                        */
/* ------------------------------------------------------------------ */

mod window {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EndPaint,
        InvalidateRect, SelectObject, SetDIBitsToDevice, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, PAINTSTRUCT, SRCCOPY,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, VK_ESCAPE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
        GetForegroundWindow, GetMessageW, GetWindowRect, KillTimer, LoadCursorW,
        PeekMessageW, PostMessageW, PostQuitMessage, RegisterClassW, SetCursor, SetForegroundWindow,
        SetTimer, SetWindowPos, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST,
        IDC_ARROW, IDC_CROSS, MSG, PM_REMOVE, SWP_NOMOVE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_SHOW,
        WM_DESTROY, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT,
        WM_RBUTTONDOWN, WM_SETCURSOR, WM_TIMER, WM_CTLCOLOREDIT, WNDCLASSW, WS_CLIPCHILDREN,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    use crate::native;
    use crate::screenshot_ink::{
        hit as ink_hit, layout as ink_layout, paint_bar as ink_paint_bar,
        paint_selection as ink_paint_selection, Action, Bar, Exit, Ink, Tool, TOOLS, WIDTH_MAX,
        WIDTH_MIN, WM_INK_EDIT,
    };

    /// 选区外压暗比例：对齐参考项目 `rgba(0, 0, 0, 0.46)`，即保留 54% 亮度
    const DIM_RATIO: u32 = 138;
    /// 自检投字符 / 按键的队列（RPC 线程写、窗口线程读）
    static TYPE_QUEUE: std::sync::Mutex<Vec<InputOp>> = std::sync::Mutex::new(Vec::new());
    /// 自检投字符：让窗口线程去 `WM_CHAR` 给输入框
    ///
    /// 注意不能和 `WM_INK_SAVE`（`0x52`）撞号，否则回车会被「另存为」分支吃掉——
    /// 表现就是输入框里的字打进去了却怎么也提交不了。
    const WM_INK_TYPE: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 0x53;

    /// 投给输入框的一次操作
    #[derive(Clone)]
    enum InputOp {
        Text(Vec<u16>),
        /// 按键（回车提交 / Esc 放弃都要走 `WM_KEYDOWN`，编辑框不认 `WM_CHAR` 的 \r）
        Key(u32),
    }

    /// 自动化测试的自动松手定时器
    const TIMER_ID: usize = 0x5A02;
    /// 自动化测试的「自动选出口」定时器
    const TIMER_EXIT: usize = 0x5A03;
    /// 「另存为」：延后到消息队列里弹保存对话框（见 `Action::Save`）
    const WM_INK_SAVE: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 0x52;

    thread_local! {
        static STATE: RefCell<Option<State>> = RefCell::new(None);
    }


    /// 窗口真实可见性与位置
    pub fn probe(hwnd: HWND) -> (bool, u32, Vec<i32>) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindowVisible};
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        unsafe {
            GetWindowRect(hwnd, &mut rect);
        }
        let visible = unsafe { IsWindowVisible(hwnd) } != 0;
        (
            visible,
            super::PAINT_COUNT.load(std::sync::atomic::Ordering::SeqCst),
            vec![rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top],
        )
    }

    struct State {
        /// 整块虚拟桌面的 BGRA（自顶向下）
        bright: Vec<u8>,
        dim: Vec<u8>,
        width: i32,
        height: i32,
        origin_x: i32,
        origin_y: i32,
        anchor: Option<(i32, i32)>,
        cursor: Option<(i32, i32)>,
        rect: Option<(i32, i32, i32, i32)>,
        /// 上一帧的选区（脏矩形重绘：只刷新旧选区的并集，拖动才跟得上手）
        last_rect: Option<(i32, i32, i32, i32)>,
        cancelled: bool,
        /// 自动化测试用：把这条矩形当作用户拉出来的框，定时自动松手
        auto: Option<(i32, i32, i32, i32)>,
        /// 松手后是否留在原地标注（全局热键路径）；编辑器路径把图交回插件浮层
        annotate: bool,
        /// 标注阶段：底片 + 形状
        ink: Option<Ink>,
        /// 标注阶段的工具栏（位置与按钮矩形）
        bar: Option<Bar>,
        /// 鼠标正压在哪个按钮上（画 hover）
        hot: Option<Action>,
        /// 用户最终选的出口：复制 / 插入笔记 / 保存到记录
        exit: Option<Exit>,
        scale: f64,
    }

    /// 框选结果：选完（可能已标注）的图 + 用户选的出口
    pub struct Picked {
        pub x: i32,
        pub y: i32,
        pub width: u32,
        pub height: u32,
        /// 已标注（或未标注）的图，RGBA 自顶向下
        pub rgba: Vec<u8>,
        /// `None` 表示这条路径不需要出口（编辑器路径由插件浮层决定）
        pub exit: Option<Exit>,
    }

    /// 覆盖整个虚拟桌面、1:1 显示抓到的画面，让用户在原图上拉框
    ///
    /// `annotate` 为真时，松手后窗口不销毁，直接在选区下方出工具栏就地标注；
    /// 为假时选完立刻返回，交给插件浮层（编辑器里点截图按钮走这条）。
    pub fn select_region(annotate: bool) -> Result<Picked, String> {
        let (origin_x, origin_y, width, height, rgba) = native::virtual_screen()?;
        if width < 8 || height < 8 {
            return Err("屏幕尺寸异常".into());
        }

        let bright = to_bgra(&rgba);
        drop(rgba);
        let dim = darken(&bright, DIM_RATIO);
        let (auto, auto_delay) = auto_rect(width as i32, height as i32);

        STATE.with(|cell| {
            *cell.borrow_mut() = Some(State {
                bright,
                dim,
                width: width as i32,
                height: height as i32,
                origin_x,
                origin_y,
                anchor: None,
                cursor: None,
                rect: auto,
                last_rect: None,
                cancelled: false,
                auto,
                annotate,
                ink: None,
                bar: None,
                hot: None,
                exit: None,
                scale: 1.0,
            });
        });

        // 记住当前前台窗口，选完还回去，否则插件浮层会落在别的窗口后面
        let previous = unsafe { GetForegroundWindow() };
        let class = wide("DbxNoteScreenshot");
        let hwnd = unsafe { create_window(&class, origin_x, origin_y, width as i32, height as i32)? };

        unsafe {
            ShowWindow(hwnd, SW_SHOW);
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                origin_x,
                origin_y,
                width as i32,
                height as i32,
                SWP_SHOWWINDOW,
            );
            // 客户区必须与位图同尺寸（1:1 显示的前提）。万一被系统改了（理论上
            // PMv2 不会），按差值拉回来，保证画上去的像素与裁剪坐标一一对应。
            let mut client: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut client);
            let client_w = client.right - client.left;
            let client_h = client.bottom - client.top;
            if client_w != width as i32 || client_h != height as i32 {
                let mut frame: RECT = std::mem::zeroed();
                GetWindowRect(hwnd, &mut frame);
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    0,
                    0,
                    frame.right - frame.left + (width as i32 - client_w),
                    frame.bottom - frame.top + (height as i32 - client_h),
                    SWP_NOMOVE | SWP_NOZORDER,
                );
            }
            SetForegroundWindow(hwnd);
            UpdateWindow(hwnd);
            if auto.is_some() {
                // 先让窗口真画一帧（带选区），再自动松手
                SetTimer(hwnd, TIMER_ID, auto_delay, None);
            }
        }

        // 记下窗口此刻的真实状态，测试与排障都靠它（PowerShell 查窗口会被安全策略拦）
        let (visible, painted, rect) = probe(hwnd);
        let client_note = unsafe {
            let mut client: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut client);
            vec![client.right - client.left, client.bottom - client.top]
        };
        // 自检要从别的线程读窗口像素，得把 hwnd 与位图尺寸挂到全局
        super::WINDOW_HWND.store(hwnd as isize, Ordering::SeqCst);
        if let Ok(mut guard) = super::DIB_SIZE.lock() {
            *guard = Some((width as i32, height as i32));
        }
        // 新窗口 = 新的一轮，上一次的采样与结论都要清掉，别把旧窗口的数字当成本次结果
        super::VERDICT_TAKEN.store(false, Ordering::SeqCst);
        super::PAINT_US.store(0, Ordering::SeqCst);
        super::PAINT_MAX_US.store(0, Ordering::SeqCst);
        if let Ok(mut guard) = super::LAST_PIXELS.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = super::PIXEL_SAMPLES.lock() {
            *guard = None;
        }
        super::store_probe_full(visible, painted, rect, client_note);

        let mut message: MSG = unsafe { std::mem::zeroed() };
        loop {
            let got = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
            if got <= 0 {
                break;
            }
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        let state = STATE
            .with(|cell| cell.borrow_mut().take())
            .ok_or("框选状态丢失")?;
        // 「复制」不改前台窗口：用户还留在原来那个应用里，粘贴即可
        let keep_focus = state.exit == Some(Exit::Copy);
        if !previous.is_null() && !keep_focus {
            unsafe {
                SetForegroundWindow(previous);
            }
        }
        if state.cancelled {
            return Err("已取消截图".into());
        }
        let (x, y, w, h) = state.rect.ok_or("没有选择区域")?;
        if w < 1 || h < 1 {
            return Err("没有选择区域".into());
        }

        // 标注过就用标注结果，否则直接裁底图
        let rgba = match state.ink.as_ref() {
            Some(ink) => ink.bake(),
            None => crop(&state.bright, state.width, x, y, w, h),
        };
        Ok(Picked {
            x: state.origin_x + x,
            y: state.origin_y + y,
            width: w as u32,
            height: h as u32,
            rgba,
            exit: state.exit,
        })
    }

    /// 进入标注阶段：建画布、算工具栏位置，整窗重画一次
    fn enter_annotate(hwnd: HWND) {
        let prepared = STATE.with(|cell| {
            let borrow = cell.borrow();
            let state = borrow.as_ref()?;
            if !state.annotate || state.ink.is_some() {
                return None;
            }
            let rect = state.rect?;
            if rect.2 < 3 || rect.3 < 3 {
                return None;
            }
            let scale = dpi_scale(hwnd);
            let ink = Ink::new(&state.bright, state.width, rect, scale);
            let bar = ink_layout(rect, (state.width, state.height), scale, ink.tool);
            Some((ink, bar, scale, rect))
        });
        let Some((ink, bar, scale, rect)) = prepared else {
            return;
        };
        let bar_rect = bar.rect;
        STATE.with(|cell| {
            if let Some(state) = cell.borrow_mut().as_mut() {
                state.ink = Some(ink);
                state.bar = Some(bar);
                state.scale = scale;
                // 框选已经结束：清掉锚点，`anchor.is_some()` 就是「还在拖选区」，
                // 只剩它才会藏手柄。不清的话标注阶段永远看不到那 8 个手柄。
                state.anchor = None;
            }
        });
        unsafe {
            InvalidateRect(hwnd, std::ptr::null(), 0);
            UpdateWindow(hwnd);
        }
        // 自检探针：把「工具栏真的排出来了」变成机器可读的证据
        refresh_probe_annotate();
        crate::logln!(
            "[dbx-note] 截图工具栏已就绪：选区 {}×{} · 工具栏 {}×{} @ ({}, {})",
            rect.2,
            rect.3,
            bar_rect.2,
            bar_rect.3,
            bar_rect.0,
            bar_rect.1
        );
        // 自动化测试：按预设动作自动结束
        if screenshot_exit_env().is_some() || exit_cancel_override() {
            unsafe {
                SetTimer(hwnd, TIMER_EXIT, 500, None);
            }
        }
    }

    /// 自检里「等价于按 Esc」的那种出口（没法真的去点关闭按钮）
    fn exit_cancel_override() -> bool {
        super::EXIT_OVERRIDE.load(Ordering::SeqCst) == 4
    }

    /// `screenshot/typeText`：往文字输入框打一段字符（自检专用）
    ///
    /// 走 `WM_CHAR` 而不是 `SendInput`：焦点在不在这个窗口上都能打进去，CI / 远程会话可用。
    /// 回车必须走 `WM_KEYDOWN`（`EDIT` 控件不认 `WM_CHAR` 的 `\r`），所以文本里夹的换行
    /// 会被拆成「一段字符 + 一个回车」依次入队。
    pub fn type_text(params: &serde_json::Value) -> crate::RpcResult {
        let hwnd = super::WINDOW_HWND.load(Ordering::SeqCst) as HWND;
        if hwnd.is_null() {
            return Err(crate::RpcError::invalid("框选窗口没打开"));
        }
        // `STATE` 是窗口线程的 thread_local，RPC 线程读不到，只能把操作排进队列，
        // 再由窗口线程（`WM_INK_TYPE`）转成 `WM_CHAR` / `WM_KEYDOWN` 交给输入框。
        let key = params.get("key").and_then(|value| value.as_str());
        let text = params.get("text").and_then(|value| value.as_str()).unwrap_or("");
        let mut count = 0;
        if let Ok(mut queue) = TYPE_QUEUE.lock() {
            if let Some(key) = key {
                let code = match key {
                    "enter" => 0x0D,
                    "esc" => 0x1B,
                    other => return Err(crate::RpcError::invalid(format!("不支持的按键：{other}"))),
                };
                queue.push(InputOp::Key(code));
                count = 1;
            } else {
                for (index, chunk) in text.split(|ch| ch == '\r' || ch == '\n').enumerate() {
                    if index > 0 {
                        queue.push(InputOp::Key(0x0D));
                        count += 1;
                    }
                    if !chunk.is_empty() {
                        queue.push(InputOp::Text(chunk.encode_utf16().collect()));
                        count += chunk.chars().count();
                    }
                }
            }
        }
        unsafe {
            PostMessageW(hwnd, WM_INK_TYPE, 0, 0);
        }
        Ok(serde_json::json!({ "ok": true, "typed": count }))
    }

    /// 把当前标注状态写进自检探针
    ///
    /// 探针是给自动化核对用的：工具栏矩形、按钮数、当前工具、第二行有没有藏起来，
    /// 换工具 / 撤销之后都要重新写一次，否则读到的是进场那一瞬间的旧结论。
    fn refresh_probe_annotate() {
        STATE.with(|cell| {
            let borrow = cell.borrow();
            let Some(state) = borrow.as_ref() else {
                return;
            };
            let (Some(ink), Some(bar), Some(rect)) =
                (state.ink.as_ref(), state.bar.as_ref(), state.rect)
            else {
                return;
            };
            let (bx, by, bw, bh) = bar.rect;
            let colors = bar
                .items
                .iter()
                .filter(|(_, action)| matches!(action, Action::Ink(_)))
                .count();
            let widths = bar
                .items
                .iter()
                .any(|(_, action)| matches!(action, Action::WidthTrack));
            // 文字输入框实际会用的字色 / 底色：与 `WM_CTLCOLOREDIT` 走同一套换算，
            // 自检据此确认「输入框用的是当前选中的颜色」而不是恒定的黑字。
            let text_color = format!(
                "#{:02x}{:02x}{:02x}",
                ink.color[0], ink.color[1], ink.color[2]
            );
            let text_background = {
                let luma = ink.color[0] as f32 * 0.299
                    + ink.color[1] as f32 * 0.587
                    + ink.color[2] as f32 * 0.114;
                if luma as i32 > 170 {
                    "#18181b"
                } else {
                    "#ffffff"
                }
            };
            super::store_probe_annotate(serde_json::json!({
                "ready": true,
                "sel": [rect.0, rect.1, rect.2, rect.3],
                "bar": [bx, by, bw, bh],
                "barInsideWindow": bx >= 0
                    && by >= 0
                    && bx + bw <= state.width
                    && by + bh <= state.height,
                "buttons": bar.items.len(),
                // 动作清单：按参考项目顺序应当是
                // 7 工具 · 撤销 · 重做 · 关闭 · 复制 · 钉在顶层 · 下载 · 插入笔记 · 主按钮
                // （选择工具下没有颜色行与滑轨，所以按钮总数比绘图工具少几个）
                "actions": bar
                    .items
                    .iter()
                    .map(|(_, action)| format!("{action:?}"))
                    .collect::<Vec<_>>(),
                "tool": format!("{:?}", ink.tool),
                "tools": TOOLS.iter().map(|tool| format!("{tool:?}")).collect::<Vec<_>>(),
                "colors": colors,
                // 调色板是固定的八色；`colors` 是**这一版工具栏真的画出来的色点数**
                // （选择工具下没有颜色行，所以是 0），两个数分开报，测试才不会被
                // "当前工具没有第二行" 误导。
                "palette": crate::screenshot_ink::COLORS.len(),
                "widthTrack": widths,
                "widths": [WIDTH_MIN, WIDTH_MAX],
                "stroke": ink.stroke,
                "textColor": text_color,
                "textBackground": text_background,
                "shapes": ink.shape_count(),
                "editing": ink.editing(),
                "canUndo": ink.can_undo(),
                "canRedo": ink.can_redo(),
                "scale": state.scale,
            }));
        });
    }

    fn dpi_scale(hwnd: HWND) -> f64 {
        let dpi = unsafe { windows_sys::Win32::UI::HiDpi::GetDpiForWindow(hwnd) }.max(96) as f64;
        (dpi / 96.0).clamp(1.0, 3.0)
    }

    /// 自动化测试用：`DBX_NOTE_SCREENSHOT_AUTO_EXIT=copy|insert|record|pin`
    ///
    /// 自检通过 RPC（`screenshot/globalShot`）进来时，`EXIT_OVERRIDE` 优先——
    /// 那种场景下没法真的去点工具栏上的按钮。
    fn screenshot_exit_env() -> Option<Exit> {
        match super::EXIT_OVERRIDE.load(Ordering::SeqCst) {
            1 => return Some(Exit::Copy),
            2 => return Some(Exit::Insert),
            3 => return Some(Exit::Record),
            // 4 是「取消」（见 `exit_cancel_override`），钉图排在它后面，别复用 4
            5 => return Some(Exit::Pin),
            _ => {}
        }
        match std::env::var("DBX_NOTE_SCREENSHOT_AUTO_EXIT").ok().as_deref() {
            Some("copy") => Some(Exit::Copy),
            Some("insert") => Some(Exit::Insert),
            Some("record") => Some(Exit::Record),
            Some("pin") => Some(Exit::Pin),
            _ => None,
        }
    }

    unsafe fn create_window(
        class: &[u16],
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<HWND, String> {
        let mut window_class: WNDCLASSW = std::mem::zeroed();
        window_class.style = CS_HREDRAW | CS_VREDRAW;
        window_class.lpfnWndProc = Some(wndproc);
        window_class.hInstance = std::ptr::null_mut();
        window_class.hCursor = LoadCursorW(std::ptr::null_mut(), IDC_CROSS);
        window_class.hbrBackground = std::ptr::null_mut();
        window_class.lpszClassName = class.as_ptr();
        // 重复注册会返回 0，同一个类名再建窗口仍然可用
        RegisterClassW(&window_class);

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class.as_ptr(),
            class.as_ptr(),
            // `WS_CLIPCHILDREN`：整窗 BitBlt 时把文字输入框那一块从裁剪区里排掉，
            // 否则每帧上屏都会把正在编辑的 EDIT 盖掉，用户看到的就是"输入框一闪就没"。
            WS_POPUP | WS_CLIPCHILDREN,
            x,
            y,
            width,
            height,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return Err("创建截图窗口失败".into());
        }
        Ok(hwnd)
    }

    /// 消息 lParam 里的客户区坐标
    ///
    /// 注意不能用 GetCursorPos 替代：输入事件积压时（拖拽每步都触发全屏重绘），
    /// 系统应用的光标位置会落后于消息携带的位置，GetCursorPos 会读到滞后坐标
    /// （实测把选区截小一截）。lParam 是每个事件注入时的权威位置。
    fn point(lparam: LPARAM) -> (i32, i32) {
        let packed = lparam as u32;
        let x = (packed & 0xFFFF) as u16 as i16 as i32;
        let y = ((packed >> 16) & 0xFFFF) as u16 as i16 as i32;
        (x, y)
    }

    /// 当前鼠标位置（客户区坐标）：`WM_SETCURSOR` 不带坐标，只能自己问系统
    fn cursor_pos(hwnd: HWND) -> (i32, i32) {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut position = POINT { x: 0, y: 0 };
        unsafe {
            if GetCursorPos(&mut position) == 0 {
                return (0, 0);
            }
            ScreenToClient(hwnd, &mut position);
        }
        (position.x, position.y)
    }

    /// 客户区坐标 → 标注画布坐标（选区左上角为原点）
    fn ink_point((x, y): (i32, i32)) -> Option<(i32, i32, (i32, i32))> {
        STATE.with(|cell| {
            let borrow = cell.borrow();
            let state = borrow.as_ref()?;
            let (sx, sy, sw, sh) = state.rect?;
            if x < sx || y < sy || x >= sx + sw || y >= sy + sh {
                return None;
            }
            Some((x - sx, y - sy, (sx, sy)))
        })
    }

    fn redraw_ink(hwnd: HWND, rect: (i32, i32, i32, i32)) {
        let client = STATE.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let state = borrow.as_mut()?;
            let rect = state.ink.as_mut()?.redraw(rect);
            let (sx, sy, _, _) = state.rect?;
            if rect.2 <= 0 || rect.3 <= 0 {
                return None;
            }
            Some(RECT {
                left: sx + rect.0,
                top: sy + rect.1,
                right: sx + rect.0 + rect.2,
                bottom: sy + rect.1 + rect.3,
            })
        });
        if let Some(rect) = client {
            unsafe {
                InvalidateRect(hwnd, &rect, 0);
                UpdateWindow(hwnd);
            }
        }
    }

    fn invalidate_bar(hwnd: HWND) {
        let rect = STATE.with(|cell| {
            let borrow = cell.borrow();
            let bar = borrow.as_ref()?.bar.as_ref()?;
            let (x, y, w, h) = bar.rect;
            Some(RECT {
                left: x - 2,
                top: y - 2,
                right: x + w + 2,
                bottom: y + h + 2,
            })
        });
        if let Some(rect) = rect {
            unsafe {
                InvalidateRect(hwnd, &rect, 0);
                UpdateWindow(hwnd);
            }
        }
    }

    /* ---------------- 文字输入：创建 / 提交都在借用之外 ---------------- */

    /// 打开文字输入框
    ///
    /// 只在借用内读三个数（字号 / 缩放 / 落点），建窗口这一步必须**在借用之外**，
    /// 否则 `CreateWindowExW` 同步回灌的消息会重入 `STATE` 借用并 panic。
    fn open_text_editor(hwnd: HWND, point: (i32, i32)) {
        let prepared = STATE.with(|cell| {
            let borrow = cell.borrow();
            let state = borrow.as_ref()?;
            let ink = state.ink.as_ref()?;
            let origin = state.rect.map(|(x, y, _, _)| (x, y))?;
            Some((ink.text_size(), ink.text_scale(), origin))
        });
        let Some((size, scale, origin)) = prepared else {
            return;
        };
        let handle = crate::screenshot_ink::create_text_editor(hwnd, point, origin, size, scale);
        if handle == 0 {
            return;
        }
        STATE.with(|cell| {
            if let Some(state) = cell.borrow_mut().as_mut() {
                if let Some(ink) = state.ink.as_mut() {
                    ink.attach_edit(handle, point);
                }
            }
        });
        refresh_probe_annotate();
    }

    /// 提交（或放弃）正在编辑的文字
    ///
    /// `commit = false` 用于 Esc 放弃。销毁窗口、交还焦点都在借用之外完成。
    fn finish_text_editor(hwnd: HWND, commit: bool) {
        let detached = STATE.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let state = borrow.as_mut()?;
            state.ink.as_mut()?.detach_edit()
        });
        let Some((handle, at)) = detached else {
            return;
        };
        let text = if commit {
            crate::screenshot_ink::read_edit_text(handle)
        } else {
            Vec::new()
        };
        crate::screenshot_ink::destroy_text_editor(handle, hwnd);
        let bounds = if text.is_empty() {
            None
        } else {
            STATE.with(|cell| {
                let mut borrow = cell.borrow_mut();
                let state = borrow.as_mut()?;
                // 选中颜色可能在输入过程中改过，落字时再取一次
                state.ink.as_mut()?.push_text(text, at)
            })
        };
        if let Some(bounds) = bounds {
            redraw_ink(hwnd, bounds);
        }
        refresh_probe_annotate();
        unsafe {
            InvalidateRect(hwnd, std::ptr::null(), 0);
            UpdateWindow(hwnd);
        }
    }

    /// 有未提交的文字就提交（换工具、点别处、退出前都走这里）
    fn commit_pending_text(hwnd: HWND) {
        let editing = STATE.with(|cell| {
            cell.borrow()
                .as_ref()
                .and_then(|state| state.ink.as_ref())
                .map(|ink| ink.editing())
                .unwrap_or(false)
        });
        if editing {
            finish_text_editor(hwnd, true);
        }
    }

    /// 工具栏按钮 → 具体动作
    fn handle_action(hwnd: HWND, action: Action) {
        // 换工具 / 走任何一个出口之前，先把没提交的文字落地：
        // 提交要销毁输入框，不能放在 `STATE` 借用里做；而且 `bake()` 只认已提交的形状，
        // 不先提交的话用户打完字直接点「复制」，这段字就丢了。
        if !matches!(action, Action::Ink(_) | Action::Width(_) | Action::WidthTrack | Action::Undo | Action::Redo) {
            commit_pending_text(hwnd);
        }
        let mut repaint: Option<(i32, i32, i32, i32)> = None;
        let mut bar_dirty = false;
        let mut relayout = false;
        let mut exit: Option<Exit> = None;
        let mut close = false;
        STATE.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let Some(state) = borrow.as_mut() else {
                return;
            };
            let _origin = state.rect.map(|(x, y, _, _)| (x, y)).unwrap_or((0, 0));
            let Some(ink) = state.ink.as_mut() else {
                return;
            };
            match action {
                Action::Pick(tool) => {
                    ink.tool = tool;
                    relayout = true;
                }
                Action::Ink(index) => {
                    ink.color = crate::screenshot_ink::COLORS[index];
                    bar_dirty = true;
                }
                Action::Width(value) => {
                    ink.stroke = value.clamp(WIDTH_MIN, WIDTH_MAX);
                    bar_dirty = true;
                }
                // 滑轨本体由 `hit` 换算成具体线宽，正常传不到这里
                Action::WidthTrack => {}
                Action::Undo => {
                    repaint = ink.undo();
                    bar_dirty = true;
                }
                Action::Redo => {
                    repaint = ink.redo();
                    bar_dirty = true;
                }
                Action::Copy => {
                    exit = Some(Exit::Copy);
                    close = true;
                }
                Action::Insert => {
                    exit = Some(Exit::Insert);
                    close = true;
                }
                Action::Pin => {
                    exit = Some(Exit::Pin);
                    close = true;
                }
                Action::Record => {
                    exit = Some(Exit::Record);
                    close = true;
                }
                // 另存为不算出口：存完还留在标注界面，用户可以接着复制 / 插入 / 存记录。
                // 放到消息队列里去做——保存对话框自带消息循环，在鼠标消息里直接开会把
                // 那次按键的 up 消息吞掉，窗口状态容易乱。
                Action::Save => unsafe {
                    PostMessageW(hwnd, WM_INK_SAVE, 0, 0);
                },
                Action::Close => {
                    state.cancelled = true;
                    close = true;
                }
            }
            if let Some(value) = exit {
                state.exit = Some(value);
            }
        });
        if relayout {
            // 换工具会改变第二行的显隐，卡片高度随之变化，整窗重画一次最稳
            STATE.with(|cell| {
                if let Some(state) = cell.borrow_mut().as_mut() {
                    let Some(tool) = state.ink.as_ref().map(|ink| ink.tool) else {
                        return;
                    };
                    let Some(rect) = state.rect else {
                        return;
                    };
                    let scale = state.scale;
                    let screen = (state.width, state.height);
                    state.bar = Some(ink_layout(rect, screen, scale, tool));
                }
            });
            unsafe {
                InvalidateRect(hwnd, std::ptr::null(), 0);
                UpdateWindow(hwnd);
            }
            refresh_probe_annotate();
        }
        if let Some(rect) = repaint {
            redraw_ink(hwnd, rect);
        }
        if bar_dirty {
            invalidate_bar(hwnd);
            refresh_probe_annotate();
        }
        if close {
            unsafe {
                ReleaseCapture();
                DestroyWindow(hwnd);
            }
        }
    }

    /// 「另存为」：把当前画面（含标注）交给系统保存对话框
    ///
    /// 单独一个函数是因为它必须在消息队列里跑：对话框自带消息循环，
    /// 在 `WM_LBUTTONDOWN` 里直接开会把同一次点击的 up 消息吞掉。
    fn save_current(hwnd: HWND) {
        let baked = STATE.with(|cell| {
            let borrow = cell.borrow();
            let ink = borrow.as_ref().and_then(|state| state.ink.as_ref())?;
            Some((ink.bake(), ink.width as u32, ink.height as u32))
        });
        let Some((rgba, width, height)) = baked else {
            return;
        };
        if width == 0 || height == 0 {
            return;
        }
        match crate::screenshot_ink::save_as(hwnd, &rgba, width, height) {
            Ok(Some(path)) => crate::logln!("[dbx-note] 截图已另存为 {path}"),
            Ok(None) => {}
            Err(error) => crate::logln!("[dbx-note] 另存为失败：{error}"),
        }
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_INK_SAVE => {
                save_current(hwnd);
                0
            }
            WM_PAINT => {
                paint(hwnd);
                0
            }
            WM_SETCURSOR => {
                // 参考项目的光标规则：框选 / 标注时十字，指针工具在选区内是箭头，
                // 压在工具栏上也是箭头。以前一直是系统默认箭头，看不出「可以框」。
                let (x, y) = cursor_pos(hwnd);
                let arrow_only = STATE.with(|cell| {
                    let borrow = cell.borrow();
                    let Some(state) = borrow.as_ref() else {
                        return true;
                    };
                    if let (Some(bar), Some(_)) = (state.bar.as_ref(), state.ink.as_ref()) {
                        let (bx, by, bw, bh) = bar.rect;
                        if x >= bx && x < bx + bw && y >= by && y < by + bh {
                            return true;
                        }
                    }
                    // 指针工具（选择）在标注阶段用箭头，其余情况都是十字
                    state
                        .ink
                        .as_ref()
                        .map(|ink| ink.tool == Tool::Select)
                        .unwrap_or(false)
                });
                let id = if arrow_only { IDC_ARROW } else { IDC_CROSS };
                let handle = LoadCursorW(std::ptr::null_mut(), id);
                if !handle.is_null() {
                    SetCursor(handle);
                }
                1
            }
            WM_ERASEBKGND => {
                // 自己整块合成，别让系统先刷一层背景（那一层就是闪白的来源）
                1
            }
            WM_CTLCOLOREDIT => {
                // 文字输入框用「当前选中的颜色」显示：参考项目里边打字边能在图上看到
                // 选中色的文字，这里没有第二块画布，就至少让输入框本身是那个颜色。
                let color = STATE.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .and_then(|state| state.ink.as_ref())
                        .map(|ink| ink.color)
                        .unwrap_or([0x17, 0x17, 0x17])
                });
                crate::screenshot_ink::edit_colors(wparam as HDC, color)
            }
            WM_INK_TYPE => {
                let batches = TYPE_QUEUE
                    .lock()
                    .map(|mut queue| std::mem::take(&mut *queue))
                    .unwrap_or_default();
                let edit = STATE.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .and_then(|state| state.ink.as_ref())
                        .map(|ink| ink.edit_handle())
                        .unwrap_or(0)
                });
                if edit != 0 {
                    unsafe {
                        for batch in batches {
                            match batch {
                                InputOp::Text(units) => {
                                    for unit in units {
                                        PostMessageW(
                                            edit as HWND,
                                            windows_sys::Win32::UI::WindowsAndMessaging::WM_CHAR,
                                            unit as usize,
                                            0,
                                        );
                                    }
                                }
                                InputOp::Key(code) => {
                                    PostMessageW(
                                        edit as HWND,
                                        windows_sys::Win32::UI::WindowsAndMessaging::WM_KEYDOWN,
                                        code as usize,
                                        0,
                                    );
                                }
                            }
                        }
                    }
                }
                0
            }
            WM_INK_EDIT => {
                // 编辑框里的回车 / Esc：回到宿主窗口处理，避免在子类过程里重入
                let command = crate::screenshot_ink::take_edit_command();
                let origin = STATE.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .and_then(|state| state.rect.map(|(x, y, _, _)| (x, y)))
                        .unwrap_or((0, 0))
                });
                let _ = origin;
                match command {
                    Some(crate::screenshot_ink::EditCommand::Commit) => finish_text_editor(hwnd, true),
                    Some(crate::screenshot_ink::EditCommand::Cancel) => finish_text_editor(hwnd, false),
                    None => {}
                }
                0
            }
            WM_LBUTTONDOWN => {
                let (x, y) = point(lparam);
                // 标注阶段：先看是不是点在工具栏上
                let hit_action = STATE.with(|cell| {
                    let borrow = cell.borrow();
                    let bar = borrow.as_ref()?.bar.as_ref()?;
                    ink_hit(bar, x, y)
                });
                if let Some(action) = hit_action {
                    handle_action(hwnd, action);
                    return 0;
                }
                if let Some((px, py, _origin)) = ink_point((x, y)) {
                    // 先把上一段没提交的文字落地（销毁输入框必须发生在借用之外）
                    commit_pending_text(hwnd);
                    let tool = STATE.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .and_then(|state| state.ink.as_ref())
                            .map(|ink| ink.tool)
                    });
                    if tool == Some(Tool::Text) {
                        // 文字工具：建输入框（借用之外），且不要再抢鼠标捕获
                        open_text_editor(hwnd, (px, py));
                        unsafe { ReleaseCapture() };
                        return 0;
                    }
                    let editing = STATE.with(|cell| {
                        if let Some(state) = cell.borrow_mut().as_mut() {
                            if let Some(ink) = state.ink.as_mut() {
                                ink.begin((px, py));
                                return ink.editing();
                            }
                        }
                        false
                    });
                    // 文字工具把焦点交给输入框后**不能再 SetCapture**：一旦父窗口抓着鼠标，
                    // 用户点输入框的鼠标消息会跑到父窗口去（于是又开一个输入框），输入框
                    // 永远点不进去，看起来就是"卡死"。
                    if editing {
                        unsafe { ReleaseCapture() };
                    } else {
                        SetCapture(hwnd);
                    }
                    return 0;
                }
                // 标注阶段点在选区外：不重新框选，避免误操作
                let annotating = STATE.with(|cell| {
                    cell.borrow().as_ref().map(|state| state.ink.is_some()).unwrap_or(false)
                });
                if annotating {
                    return 0;
                }

                let hit = STATE.with(|cell| match cell.borrow_mut().as_mut() {
                    Some(state) => {
                        state.anchor = Some((x, y));
                        state.cursor = Some((x, y));
                        state.rect = None;
                        true
                    }
                    None => false,
                });
                if hit {
                    SetCapture(hwnd);
                    STATE.with(|cell| {
                        if let Some(state) = cell.borrow_mut().as_mut() {
                            state.last_rect = None;
                        }
                    });
                    InvalidateRect(hwnd, std::ptr::null(), 0);
                    UpdateWindow(hwnd);
                }
                0
            }
            WM_MOUSEMOVE => {
                let (mut x, mut y) = point(lparam);
                // 快速拖动时系统会把一串移动消息排进队列；逐条补画只会越掉越远。
                // 先把同窗口后续的移动消息全部吃掉，只按最后一个位置画一帧。
                let mut queued: MSG = std::mem::zeroed();
                unsafe {
                    while PeekMessageW(&mut queued, hwnd, WM_MOUSEMOVE, WM_MOUSEMOVE, PM_REMOVE) != 0 {
                        let (nx, ny) = point(queued.lParam);
                        x = nx;
                        y = ny;
                    }
                }

                // 标注阶段：画形状 / 刷新 hover
                let phase = STATE.with(|cell| {
                    let borrow = cell.borrow();
                    borrow.as_ref().map(|state| {
                        (
                            state.ink.is_some(),
                            state.bar.as_ref().and_then(|bar| ink_hit(bar, x, y)),
                        )
                    })
                });
                if let Some((true, hot)) = phase {
                    let mut bar_dirty = false;
                    let dirty = STATE.with(|cell| {
                        let mut borrow = cell.borrow_mut();
                        let Some(state) = borrow.as_mut() else {
                            return None;
                        };
                        if state.hot != hot {
                            state.hot = hot;
                            bar_dirty = true;
                        }
                        let (sx, sy, sw, sh) = state.rect?;
                        if x < sx || y < sy || x >= sx + sw || y >= sy + sh {
                            return None;
                        }
                        let ink = state.ink.as_mut()?;
                        // 注意：`moved` 返回的是**画布坐标**，`redraw_ink` 内部自己会
                        // 加上选区原点转成客户区。这里再手动加一次会把脏区整体推到
                        // 选区偏移处——表现就是「标了看不到、形状跑到别处」。
                        Some(ink.moved((x - sx, y - sy))?)
                    });
                    if let Some(rect) = dirty {
                        redraw_ink(hwnd, rect);
                    } else if bar_dirty {
                        invalidate_bar(hwnd);
                    }
                    return 0;
                }
                let band = STATE.with(|cell| match cell.borrow_mut().as_mut() {
                    Some(state) if state.anchor.is_some() => {
                        state.cursor = Some((x, y));
                        let next = state
                            .anchor
                            .map(|(ax, ay)| normalize(ax, ay, x, y, state.width, state.height));
                        if next == state.rect {
                            None
                        } else {
                            let band = (state.last_rect, next);
                            state.last_rect = next;
                            state.rect = next;
                            Some(band)
                        }
                    }
                    _ => None,
                });
                if let Some((old, new)) = band {
                    invalidate_change(hwnd, old, new);
                    // 立刻画掉这一帧：否则 WM_PAINT 会被后续消息继续往后挤，
                    // 表现为「鼠标已经走到下面了，下面那条边还没跟上」
                    unsafe {
                        UpdateWindow(hwnd);
                    }
                }
                0
            }
            WM_LBUTTONUP => {
                let (x, y) = point(lparam);
                ReleaseCapture();
                let annotating = STATE.with(|cell| {
                    cell.borrow().as_ref().map(|state| state.ink.is_some()).unwrap_or(false)
                });
                if annotating {
                    let dirty = STATE.with(|cell| {
                        let mut borrow = cell.borrow_mut();
                        let state = borrow.as_mut()?;
                        // 同上：`end()` 返回画布坐标，由 `redraw_ink` 负责转客户区
                        state.ink.as_mut()?.end()
                    });
                    if let Some(rect) = dirty {
                        redraw_ink(hwnd, rect);
                        // 形状进了历史，撤销按钮要从禁用态亮起来——只刷画布不够
                        invalidate_bar(hwnd);
                        refresh_probe_annotate();
                    }
                    return 0;
                }
                let closing = STATE.with(|cell| match cell.borrow_mut().as_mut() {
                    Some(state) => {
                        let rect = state
                            .anchor
                            .map(|(ax, ay)| normalize(ax, ay, x, y, state.width, state.height));
                        match rect {
                            // 只是点了一下没拉出面积：当成取消
                            Some((_, _, w, h)) if w >= 3 && h >= 3 => state.rect = rect,
                            _ => state.cancelled = true,
                        }
                        true
                    }
                    None => false,
                });
                if !closing {
                    return 0;
                }
                let annotate = STATE.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .map(|state| state.annotate && !state.cancelled)
                        .unwrap_or(false)
                });
                if annotate {
                    enter_annotate(hwnd);
                } else {
                    unsafe {
                        DestroyWindow(hwnd);
                    }
                }
                0
            }
            WM_RBUTTONDOWN => {
                cancel(hwnd);
                0
            }
            WM_TIMER => {
                if wparam == TIMER_EXIT {
                    unsafe { KillTimer(hwnd, TIMER_EXIT) };
                    if exit_cancel_override() {
                        cancel(hwnd);
                        return 0;
                    }
                    if let Some(exit) = screenshot_exit_env() {
                        let action = match exit {
                            Exit::Copy => Action::Copy,
                            Exit::Insert => Action::Insert,
                            Exit::Record => Action::Record,
                            Exit::Pin => Action::Pin,
                        };
                        handle_action(hwnd, action);
                    }
                    return 0;
                }
                // 只服务自动化测试：把预设矩形当作用户拉出来的框，然后自动松手
                let finished = STATE.with(|cell| match cell.borrow_mut().as_mut() {
                    Some(state) => match state.auto {
                        Some(rect) => {
                            state.rect = Some(rect);
                            true
                        }
                        None => false,
                    },
                    None => false,
                });
                if finished {
                    unsafe { KillTimer(hwnd, TIMER_ID) };
                    let annotate = STATE.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .map(|state| state.annotate)
                            .unwrap_or(false)
                    });
                    if annotate {
                        enter_annotate(hwnd);
                    } else {
                        unsafe {
                            DestroyWindow(hwnd);
                        }
                    }
                }
                0
            }
            WM_KEYDOWN => {
                let key = wparam as u32;
                let editing = STATE.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .and_then(|state| state.ink.as_ref())
                        .map(|ink| ink.editing())
                        .unwrap_or(false)
                });
                if key == VK_ESCAPE as u32 {
                    if editing {
                        finish_text_editor(hwnd, false);
                    } else {
                        cancel(hwnd);
                    }
                    return 0;
                }
                // 文本框正在输入时，别的快捷键都不抢
                if editing {
                    return 0;
                }
                let ctrl =
                    unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState(0x11) } < 0;
                // Ctrl+Z 撤销 / Ctrl+Y 重做 / Ctrl+C 复制 / Ctrl+S 另存
                if ctrl {
                    let action = match key {
                        0x5A => Some(Action::Undo),
                        0x59 => Some(Action::Redo),
                        0x43 => Some(Action::Copy),
                        0x53 => Some(Action::Save),
                        _ => None,
                    };
                    if let Some(action) = action {
                        handle_action(hwnd, action);
                        return 0;
                    }
                }
                if ctrl {
                    return 0;
                }
                // 回车 = 保存到记录（参考项目的 Enter 语义）
                if key == 0x0D {
                    handle_action(hwnd, Action::Record);
                    return 0;
                }
                // 工具快捷键：V 选择 / R 矩形 / O 椭圆 / A 箭头 / P 画笔 / T 文字 / M 马赛克
                let tool = match key {
                    0x56 => Some(Tool::Select),
                    0x52 => Some(Tool::Rect),
                    0x4F => Some(Tool::Ellipse),
                    0x41 => Some(Tool::Arrow),
                    0x50 => Some(Tool::Pen),
                    0x54 => Some(Tool::Text),
                    0x4D => Some(Tool::Mosaic),
                    _ => None,
                };
                if let Some(tool) = tool {
                    handle_action(hwnd, Action::Pick(tool));
                }
                0
            }
            WM_DESTROY => {
                release_back_buffer();
                crate::screenshot_ink::release_edit_brush();
                crate::screenshot_ink::release_text_fonts();
                // 窗口没了就别再让探针去读像素：清掉全局句柄与抽样，避免读到陈旧结论
                super::WINDOW_HWND.store(0, Ordering::SeqCst);
                if let Ok(mut guard) = super::PIXEL_SAMPLES.lock() {
                    *guard = None;
                }
                if let Ok(mut guard) = super::DIB_SIZE.lock() {
                    *guard = None;
                }
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    fn cancel(hwnd: HWND) {
        STATE.with(|cell| {
            if let Some(state) = cell.borrow_mut().as_mut() {
                state.cancelled = true;
            }
        });
        unsafe {
            ReleaseCapture();
            DestroyWindow(hwnd);
        }
    }

    // 后缓冲：屏幕内容一次性合成到这里，再整体 BitBlt 上屏。
    //
    // 之前是直接往窗口 DC 上分几笔画（底图 → 选区 → 边框 → 角标 → 工具栏），
    // 拖拽时每帧只刷几条边带，屏幕上就会出现「一部分新、一部分旧」的条带，
    // 也就是用户说的花屏。改成整块合成后，每帧对屏幕只有一次写操作，不会再看到中间态。
    //
    // 现在又进一步把它做成 **DIB 段**（而不是 `CreateCompatibleBitmap` 出来的 DDB）：
    // 底图可以直接按行 `memcpy` 进显存位图，不再经过 `SetDIBitsToDevice` 那套
    // "xSrc/ySrc 是源矩形左下角、StartScan 是起始扫描线" 的坐标语义。
    // 之前拖拽改变选区大小时，选区里的内容会顺着上边线滚出去，就是那套语义被
    // 用错了（xSrc/ySrc 与 StartScan 混用，源起点跟着 y 漂），像素没法 1:1 对齐。
    struct BackSurface {
        dc: HDC,
        bitmap: HBITMAP,
        old: HGDIOBJ,
        bits: *mut u8,
        width: i32,
        height: i32,
    }

    thread_local! {
        static BACK: RefCell<Option<BackSurface>> = const { RefCell::new(None) };
    }

    /// 后缓冲视图：`dc` 用于 GDI 绘制，`bits` 用于逐行硬拷贝
    #[derive(Clone, Copy)]
    struct BackView {
        dc: HDC,
        bits: *mut u8,
        width: i32,
        height: i32,
    }

    fn back_buffer(hdc: HDC, width: i32, height: i32) -> Option<BackView> {
        let (width, height) = (width.max(1), height.max(1));
        let reuse = BACK.with(|cell| {
            matches!(cell.borrow().as_ref(), Some(surface) if surface.width >= width && surface.height >= height)
        });
        if !reuse {
            release_back_buffer();
            unsafe {
                let dc = CreateCompatibleDC(hdc);
                if dc.is_null() {
                    return None;
                }
                let mut info: BITMAPINFO = std::mem::zeroed();
                info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                info.bmiHeader.biWidth = width;
                // 负高度 = 自顶向下，行序与抓屏缓冲区一致，可以整行 memcpy
                info.bmiHeader.biHeight = -height;
                info.bmiHeader.biPlanes = 1;
                info.bmiHeader.biBitCount = 32;
                info.bmiHeader.biCompression = BI_RGB;
                let mut bits: *mut c_void = std::ptr::null_mut();
                let bitmap = CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
                if bitmap.is_null() || bits.is_null() {
                    if !bitmap.is_null() {
                        DeleteObject(bitmap as HGDIOBJ);
                    }
                    DeleteDC(dc);
                    return None;
                }
                let old = SelectObject(dc, bitmap as HGDIOBJ);
                BACK.with(|cell| {
                    *cell.borrow_mut() = Some(BackSurface {
                        dc,
                        bitmap,
                        old,
                        bits: bits as *mut u8,
                        width,
                        height,
                    });
                });
            }
        }
        BACK.with(|cell| {
            cell.borrow().as_ref().map(|surface| BackView {
                dc: surface.dc,
                bits: surface.bits,
                width: surface.width,
                height: surface.height,
            })
        })
    }

    /// 把源图的 `(x, y, w, h)` 逐行拷到后缓冲的**同一坐标**上（源目标 1:1）
    ///
    /// 这就是原来 `SetDIBitsToDevice(back, x, y, w, h, x, y, 0, full_h, …)` 想做的事，
    /// 只是把"让 GDI 去理解源起点"换成"自己算行偏移"——坐标绝不会漂。
    fn blit_rect(back: &BackView, src: &[u8], src_w: i32, src_h: i32, rect: (i32, i32, i32, i32)) {
        let (x, y, w, h) = rect;
        let left = x.max(0);
        let top = y.max(0);
        let right = (x + w).min(src_w).min(back.width);
        let bottom = (y + h).min(src_h).min(back.height);
        if right <= left || bottom <= top || back.bits.is_null() {
            return;
        }
        let bytes = (right - left) as usize * 4;
        for row in top..bottom {
            let source = ((row as usize * src_w as usize) + left as usize) * 4;
            let target = ((row as usize * back.width as usize) + left as usize) * 4;
            unsafe {
                std::ptr::copy_nonoverlapping(
                    src.as_ptr().add(source),
                    back.bits.add(target),
                    bytes,
                );
            }
        }
    }

    /// 降级路径：没有后缓冲时直接往窗口 DC 上贴一块底图
    ///
    /// 参数用**惯用的那套**：`xSrc` 只做横向偏移，纵向交给 `StartScan`（源起始扫描线）
    /// 与 `cLines`（取多少行）。旧代码把 `ySrc` 和 `StartScan` 混着用，源起点会跟着
    /// 纵坐标漂，拖拽改大小时选区内的画面就会"从上边线滚出去"。
    fn gdi_blit(hdc: HDC, src: &[u8], src_w: i32, src_h: i32, rect: (i32, i32, i32, i32)) {
        let (x, y, w, h) = rect;
        if w <= 0 || h <= 0 {
            return;
        }
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = src_w;
        info.bmiHeader.biHeight = -src_h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        unsafe {
            SetDIBitsToDevice(
                hdc,
                x,
                y,
                w as u32,
                h as u32,
                x.max(0),
                0,
                y.max(0) as u32,
                h as u32,
                src.as_ptr() as *const c_void,
                &info,
                DIB_RGB_COLORS,
            );
        }
    }

    fn release_back_buffer() {
        BACK.with(|cell| {
            if let Some(surface) = cell.borrow_mut().take() {
                unsafe {
                    SelectObject(surface.dc, surface.old);
                    DeleteObject(surface.bitmap as HGDIOBJ);
                    DeleteDC(surface.dc);
                }
            }
        });
    }

    /// 把「这一帧应该显示成什么」采样下来，供 `screenshot/window` 做像素比对
    ///
    /// 选区内取 4×4 网格（期望值 = 原亮度底图），选区外取四角与四边中点
    /// （期望值 = 压暗底图，工具栏压住的位置跳过）。纯内存读，十几个点，可以每帧做。
    fn publish_pixel_samples(state: &State) {
        let mut samples = super::PixelSamples::default();
        if let Some((x, y, w, h)) = state.rect {
            if w > 20 && h > 20 {
                for row in 0..4 {
                    for column in 0..4 {
                        let px = x + 8 + (w - 16) * (column * 2 + 1) / 8;
                        let py = y + 8 + (h - 16) * (row * 2 + 1) / 8;
                        if let Some(rgb) =
                            super::sample_at(&state.bright, state.width, state.height, px, py)
                        {
                            samples.inside.push((px, py, rgb));
                        }
                    }
                }
            }
        }
        let bar = state.bar.as_ref().map(|bar| bar.rect);
        let candidates = [
            (24, 24),
            (state.width - 24, 24),
            (24, state.height - 24),
            (state.width - 24, state.height - 24),
            (state.width / 2, 24),
            (state.width / 2, state.height - 24),
            (24, state.height / 2),
            (state.width - 24, state.height / 2),
        ];
        for (px, py) in candidates {
            if let Some((bx, by, bw, bh)) = bar {
                if px >= bx - 4 && px <= bx + bw + 4 && py >= by - 4 && py <= by + bh + 4 {
                    continue;
                }
            }
            if let Some(rgb) = super::sample_at(&state.dim, state.width, state.height, px, py) {
                samples.outside.push((px, py, rgb));
            }
        }
        if let Ok(mut guard) = super::PIXEL_SAMPLES.lock() {
            *guard = Some(samples);
        }
    }

    fn paint(hwnd: HWND) {
        let started = std::time::Instant::now();
        super::PAINT_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // 标注开场的第一帧：画完这帧就把「选区到底是不是原像素」验一次存起来
        let mut want_verdict = false;
        unsafe {
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut ps);

            STATE.with(|cell| {
                let borrow = cell.borrow();
                let Some(state) = borrow.as_ref() else {
                    return;
                };

                // 本次要画的外接矩形（已夹进窗口）
                let area = ps.rcPaint;
                let x0 = area.left.max(0);
                let y0 = area.top.max(0);
                let width = area.right.min(state.width) - x0;
                let height = area.bottom.min(state.height) - y0;
                if width <= 0 || height <= 0 {
                    return;
                }

                // 后缓冲跟窗口一样大：绘制全部沿用客户区坐标，不做任何原点/视口映射，
                // 最后只把失效区那一条 BitBlt 上屏。
                // 万一离屏位图建不出来（显存紧张），退回直接画到窗口 DC——画面可能闪，
                // 但总比留一块没画过的白板强。
                let surface = back_buffer(hdc, state.width, state.height);
                let back = surface.map(|view| view.dc).unwrap_or(hdc);
                let offscreen = surface.is_some();

                // 底图：压暗版等价于「选区外半透明遮罩」，逐像素乘法在抓图时一次做好。
                // 这里不再调 `SetDIBitsToDevice`：它的 xSrc / ySrc / StartScan 语义很容易
                // 用错（源起点会跟着 y 漂），拖拽改大小时选区内容就会"从上边线滚出去"。
                // 后缓冲是自顶向下的 DIB 段，直接按行 memcpy，源和目标严格同一坐标。
                match surface {
                    Some(view) => blit_rect(
                        &view,
                        &state.dim,
                        state.width,
                        state.height,
                        (x0, y0, width, height),
                    ),
                    None => gdi_blit(hdc, &state.dim, state.width, state.height, (x0, y0, width, height)),
                }

                if let Some((x, y, w, h)) = state.rect {
                    // 选区内叠回原亮度（或标注画布）：只画与失效区相交的部分
                    let left = x.max(x0);
                    let top = y.max(y0);
                    let right = (x + w).min(x0 + width);
                    let bottom = (y + h).min(y0 + height);
                    if right > left && bottom > top {
                        match state.ink.as_ref() {
                            // 标注阶段：画布已经含形状，直接贴画布（避开形状被底图盖掉）
                            Some(ink) => {
                                ink.paint(back, (x, y), (left, top, right - left, bottom - top));
                            }
                            None => match surface {
                                Some(view) => blit_rect(
                                    &view,
                                    &state.bright,
                                    state.width,
                                    state.height,
                                    (left, top, right - left, bottom - top),
                                ),
                                None => gdi_blit(
                                    hdc,
                                    &state.bright,
                                    state.width,
                                    state.height,
                                    (left, top, right - left, bottom - top),
                                ),
                            },
                        }
                    }

                    // 文字（GDI）：标注阶段才有
                    if let Some(ink) = state.ink.as_ref() {
                        ink.paint_text(back, (x, y));
                    }

                    // 选框 + 8 个手柄 + 尺寸角标（与参考项目同一套样式）
                    let marquee = STATE.with(|cell| {
                        cell.borrow()
                            .as_ref()
                            .map(|state| state.anchor.is_some())
                            .unwrap_or(false)
                    });
                    ink_paint_selection(back, (x, y, w, h), state.scale, !marquee);
                }

                // 工具栏盖在压暗区上
                if let (Some(bar), Some(ink)) = (state.bar.as_ref(), state.ink.as_ref()) {
                    let (bx, by, bw, bh) = bar.rect;
                    if area.right > bx
                        && area.left < bx + bw
                        && area.bottom > by
                        && area.top < by + bh
                    {
                        ink_paint_bar(back, bar, ink, state.hot);
                    }
                }

                // 一次性上屏：每帧对屏幕只有这一次写操作，不会有「一半新一半旧」的条带
                if offscreen {
                    BitBlt(hdc, x0, y0, width, height, back, x0, y0, SRCCOPY);
                }

                // 顺手把「这一帧应该显示成什么」采样给探针（纯内存读，十几个点）
                publish_pixel_samples(state);

                // 标注阶段 + 已有选区 + 还没取过结论：这一帧刚画出选区、上面一个形状都没有，
                // 正是"选区内是不是原像素"最干净的证据，存下来给窗口关掉之后看
                if state.ink.is_some()
                    && state.rect.is_some()
                    && !super::VERDICT_TAKEN.load(Ordering::SeqCst)
                {
                    want_verdict = true;
                }
            });

            EndPaint(hwnd, &ps);

            // 结论要在 `EndPaint` 之后取：绘制指令还压在 GDI 批次里时读窗口像素不可靠
            if want_verdict && !super::VERDICT_TAKEN.swap(true, Ordering::SeqCst) {
                if let Some(verdict) = super::compare_pixels(hwnd) {
                    if let Ok(mut guard) = super::LAST_PIXELS.lock() {
                        *guard = Some(verdict);
                    }
                }
            }
        }
        // 记一帧的耗时：拖拽时每秒几十帧，单帧超过 ~16ms 就会肉眼可见地发滞
        let spent = started.elapsed().as_micros() as u64;
        super::PAINT_US.fetch_add(spent, std::sync::atomic::Ordering::SeqCst);
        super::PAINT_MAX_US.fetch_max(spent, std::sync::atomic::Ordering::SeqCst);
    }

    /// 只把「本帧真正变了的地方」标成脏区
    ///
    /// 注意 `BeginPaint` 给的 `rcPaint` 是失效区的**外接矩形**，所以这里切多细都
    /// 不会少画——真正省时间的是每帧只贴一次（见 `paint` 的后缓冲）。既然如此就
    /// 老老实实刷「旧框 ∪ 新框」（各放大一圈盖住边框和尺寸角标），比按差集分条带
    /// 更不容易漏：差集会漏掉「新选区落在旧框放大余量里」的那一条，正是边拖边
    /// 留下亮/暗色带的来源。
    fn invalidate_change(
        hwnd: HWND,
        old: Option<(i32, i32, i32, i32)>,
        new: Option<(i32, i32, i32, i32)>,
    ) {
        // 连同边框与上方角标一起算进「这块区域可能变了」
        let inflate = |(x, y, w, h): (i32, i32, i32, i32)| (x - 6, y - 30, w + 12, h + 36);
        let rect = match (old, new) {
            (Some(old), Some(new)) => crate::screenshot_ink::union(inflate(old), inflate(new)),
            (None, Some(new)) => inflate(new),
            (Some(old), None) => inflate(old),
            (None, None) => return,
        };
        let (x, y, w, h) = rect;
        let rect = RECT {
            left: x,
            top: y,
            right: x + w,
            bottom: y + h,
        };
        unsafe {
            InvalidateRect(hwnd, &rect, 0);
        }
    }

    fn normalize(ax: i32, ay: i32, bx: i32, by: i32, width: i32, height: i32) -> (i32, i32, i32, i32) {
        let left = ax.min(bx).clamp(0, width);
        let top = ay.min(by).clamp(0, height);
        let right = ax.max(bx).clamp(0, width);
        let bottom = ay.max(by).clamp(0, height);
        (left, top, (right - left).max(0), (bottom - top).max(0))
    }

    /// 解析自动化测试用的预设选区 `DBX_NOTE_SCREENSHOT_AUTO=x,y,w,h[,delayMs]`
    ///
    /// 有这一项时窗口照常创建、照常绘制，只是到点自动「松手」，让脚本能在没有
    /// 鼠标注入的环境里验证裁剪尺寸与选区渲染。
    fn auto_rect(width: i32, height: i32) -> (Option<(i32, i32, i32, i32)>, u32) {
        let fallback = 900;
        let Ok(raw) = std::env::var("DBX_NOTE_SCREENSHOT_AUTO") else {
            return (None, fallback);
        };
        let parts: Vec<i32> = raw
            .split(',')
            .filter_map(|part| part.trim().parse::<i32>().ok())
            .collect();
        if parts.len() < 4 {
            return (None, fallback);
        }
        let (x, y, w, h) = (parts[0], parts[1], parts[2], parts[3]);
        let delay = parts
            .get(4)
            .map(|value| (*value).clamp(200, 20_000) as u32)
            .unwrap_or(fallback);
        let left = x.clamp(0, width);
        let top = y.clamp(0, height);
        let right = (x + w).clamp(0, width);
        let bottom = (y + h).clamp(0, height);
        if right - left < 3 || bottom - top < 3 {
            return (None, delay);
        }
        (Some((left, top, right - left, bottom - top)), delay)
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn to_bgra(rgba: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(rgba.len());
        for pixel in rgba.chunks_exact(4) {
            out.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
        }
        out
    }

    fn darken(bgra: &[u8], ratio: u32) -> Vec<u8> {
        let mut out = bgra.to_vec();
        for pixel in out.chunks_exact_mut(4) {
            pixel[0] = (pixel[0] as u32 * ratio / 255) as u8;
            pixel[1] = (pixel[1] as u32 * ratio / 255) as u8;
            pixel[2] = (pixel[2] as u32 * ratio / 255) as u8;
        }
        out
    }

    /// 从整块 BGRA 里裁一块出来，顺手转回 RGBA
    fn crop(bgra: &[u8], stride_width: i32, x: i32, y: i32, width: i32, height: i32) -> Vec<u8> {
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height {
            let start = (((y + row) * stride_width) + x) as usize * 4;
            let end = start + (width as usize) * 4;
            out.extend_from_slice(&bgra[start..end]);
        }
        for pixel in out.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        out
    }
}
