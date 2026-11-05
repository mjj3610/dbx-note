//! 诊断工具（只用于本地排障，不参与发布）：
//!
//! 1. 打印每台显示器的物理矩形与 DPI 缩放，以及虚拟桌面整体范围；
//! 2. 用 SendInput 发真实鼠标事件，在框选窗口上拉一个矩形
//!    （自动化测试环境拉不动原生窗口鼠标，这里直接走系统输入队列）。
//!
//! 用法：diag_drag <x1> <y1> <x2> <y2> [按下前等待ms]
//!       diag_drag keys <组合键>        （模拟按全局热键，如 Ctrl+Alt+F9）
//!       diag_drag grab <out.bmp>       （把当前桌面拍成 BMP，用于核对原生窗口的渲染结果）
//!
//! 坐标是虚拟桌面物理像素（与 GetSystemMetrics(SM_XVIRTUALSCREEN…) 同一坐标系）。
use std::thread::sleep;
use std::time::Duration;

use windows_sys::Win32::Foundation::{LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HDC, HMONITOR, MONITORINFO, SRCCOPY,
};
use windows_sys::Win32::UI::HiDpi::{
    GetDpiForMonitor, MDT_EFFECTIVE_DPI, PROCESS_PER_MONITOR_DPI_AWARE,
    SetProcessDpiAwareness,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, MONITORINFOF_PRIMARY, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

fn virtual_desk_size() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

fn dump_monitors() {
    unsafe {
        let (vx, vy, vw, vh) = virtual_desk_size();
        println!(
            "virtual_screen origin=({vx},{vy}) size={vw}x{vh} primary_screen={}x{}",
            GetSystemMetrics(SM_CXSCREEN),
            GetSystemMetrics(SM_CYSCREEN)
        );

        struct Ctx {
            count: i32,
        }
        let mut ctx = Ctx { count: 0 };
        let ctx_ptr = &mut ctx as *mut Ctx;
        unsafe extern "system" fn on_monitor(
            monitor: HMONITOR,
            _dc: HDC,
            _rect: *mut RECT,
            lparam: LPARAM,
        ) -> i32 {
            let ctx = &mut *(lparam as *mut Ctx);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor, &mut info) != 0 {
                let r = info.rcMonitor;
                let mut dpi_x: u32 = 0;
                let mut dpi_y: u32 = 0;
                let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
                ctx.count += 1;
                println!(
                    "monitor#{} rect=({},{},{}x{}) primary={} dpi={} scale={:.2}",
                    ctx.count,
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    info.dwFlags & MONITORINFOF_PRIMARY != 0,
                    dpi_x,
                    dpi_x as f64 / 96.0
                );
            }
            1
        }
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(on_monitor),
            ctx_ptr as LPARAM,
        );
    }
}

/// 物理坐标 → SendInput 的 0..65535 归一化（MOUSEEVENTF_VIRTUALDESK：全虚拟桌面）
fn normalize(x: i32, y: i32, vw: i32, vh: i32) -> (i32, i32) {
    let nx = ((x as i64 * 65535) / (vw as i64 - 1)) as i32;
    let ny = ((y as i64 * 65535) / (vh as i64 - 1)) as i32;
    (nx.clamp(0, 65535), ny.clamp(0, 65535))
}

fn send_mouse(flags: u32, dx: i32, dy: i32) {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_MOUSE;
    unsafe {
        input.Anonymous = INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        };
        SendInput(1, &input, std::mem::size_of::<INPUT>() as i32);
    }
}

fn send_key(vk: u16, flags: u32) {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_KEYBOARD;
    unsafe {
        input.Anonymous = INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        };
        SendInput(1, &input, std::mem::size_of::<INPUT>() as i32);
    }
}

/// 按下并释放一个组合键（如 "Ctrl+Alt+F9"），用于触发全局热键
fn press_combo(combo: &str) {
    let mut vks: Vec<u16> = Vec::new();
    for part in combo.split('+') {
        let token = part.trim().to_ascii_lowercase();
        if token.is_empty() {
            continue;
        }
        let vk: u16 = match token.as_str() {
            "ctrl" | "control" => 0x11,
            "alt" => 0x12,
            "shift" => 0x10,
            "win" | "meta" => 0x5B,
            other => {
                if let Some(rest) = other.strip_prefix('f') {
                    if let Ok(number) = rest.parse::<u16>() {
                        if (1..=24).contains(&number) {
                            0x70 + number - 1
                        } else {
                            continue;
                        }
                    } else {
                        continue;
                    }
                } else if other == "escape" || other == "esc" {
                    0x1B
                } else if other == "enter" || other == "return" {
                    0x0D
                } else if other == "tab" {
                    0x09
                } else if other == "space" {
                    0x20
                } else if other == "backspace" {
                    0x08
                } else if other == "printscreen" || other == "prtsc" {
                    0x2C
                } else {
                    let chars: Vec<char> = other.chars().collect();
                    if chars.len() == 1 {
                        chars[0].to_ascii_uppercase() as u16
                    } else {
                        continue;
                    }
                }
            },
        };
        vks.push(vk);
    }
    // 修饰键先按，主键最后按下，再按相反顺序全部抬起
    for vk in &vks {
        send_key(*vk, 0);
        sleep(Duration::from_millis(40));
    }
    sleep(Duration::from_millis(80));
    for vk in vks.iter().rev() {
        send_key(*vk, KEYEVENTF_KEYUP);
        sleep(Duration::from_millis(40));
    }
}

/// 拍一张当前桌面（含所有顶层窗口）并写成 32 位 BMP，用来肉眼核对原生窗口画得对不对
fn grab(path: &str) {
    unsafe {
        let (vx, vy, vw, vh) = virtual_desk_size();
        let screen = GetDC(std::ptr::null_mut());
        let mem = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, vw, vh);
        let previous = SelectObject(mem, bitmap);
        let ok = BitBlt(mem, 0, 0, vw, vh, screen, vx, vy, SRCCOPY);
        if ok == 0 {
            eprintln!("BitBlt 失败");
            return;
        }

        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: vw,
            biHeight: -vh, // 负高度 = 自顶向下，行序与屏幕一致
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB as u32,
            biSizeImage: (vw * vh * 4) as u32,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut pixels = vec![0u8; (vw * vh * 4) as usize];
        let lines = GetDIBits(
            mem,
            bitmap,
            0,
            vh as u32,
            pixels.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(mem, previous);
        DeleteObject(bitmap);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);

        if lines == 0 {
            eprintln!("GetDIBits 失败");
            return;
        }

        let body = pixels.len() as u32;
        let mut out = Vec::with_capacity(54 + pixels.len());
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&(54 + body).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&54u32.to_le_bytes());
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&vw.to_le_bytes());
        out.extend_from_slice(&(-vh).to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&body.to_le_bytes());
        out.extend_from_slice(&2835i32.to_le_bytes());
        out.extend_from_slice(&2835i32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&pixels);
        match std::fs::write(path, &out) {
            Ok(()) => println!("grab {} ({}x{})", path, vw, vh),
            Err(error) => eprintln!("写文件失败：{error}"),
        }
    }
}

fn main() {
    // 与 backend 抓屏前一致：先声明每显示器 DPI 感知，再量桌面 / 发事件
    unsafe {
        let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
    }
    dump_monitors();

    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "grab" {
        grab(&args[2]);
        return;
    }
    if args.len() >= 3 && args[1] == "keys" {
        press_combo(&args[2]);
        println!("keys {}", args[2]);
        return;
    }
    if args.len() < 5 {
        eprintln!("用法：diag_drag <x1> <y1> <x2> <y2> [等待ms]  或  diag_drag keys <组合键>");
        return;
    }
    let parse = |index: usize| -> i32 { args[index].parse().unwrap_or(0) };
    let (x1, y1, x2, y2) = (parse(1), parse(2), parse(3), parse(4));
    let wait = args.get(5).and_then(|v| v.parse::<u64>().ok()).unwrap_or(600);

    let (_vx, _vy, vw, vh) = virtual_desk_size();
    sleep(Duration::from_millis(wait));

    // 移到起点 → 按下 → 分步拖到终点（太快偶尔会被合并掉事件）→ 松手
    let (nx1, ny1) = normalize(x1, y1, vw, vh);
    send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx1, ny1);
    sleep(Duration::from_millis(120));
    send_mouse(MOUSEEVENTF_LEFTDOWN, 0, 0);
    sleep(Duration::from_millis(80));
    let steps = 12;
    // 步长可调：默认 30ms 接近人手速度；要抓「拖拽中间帧」时调大（如 DIAG_STEP_MS=140）
    let step_ms = std::env::var("DIAG_STEP_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30);
    for index in 1..=steps {
        let t = index as f64 / steps as f64;
        let cx = x1 as f64 + (x2 - x1) as f64 * t;
        let cy = y1 as f64 + (y2 - y1) as f64 * t;
        let (nx, ny) = normalize(cx as i32, cy as i32, vw, vh);
        send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny);
        sleep(Duration::from_millis(step_ms));
    }
    sleep(Duration::from_millis(80));
    send_mouse(MOUSEEVENTF_LEFTUP, 0, 0);
    println!("dragged ({x1},{y1}) -> ({x2},{y2})");
}
