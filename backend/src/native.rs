//! 宿主沙箱里拿不到的能力，交给 Sidecar 在本地进程里做
//!
//! 插件 UI 跑在 `sandbox="allow-scripts"` 的 iframe 里，没有 `allow="microphone"`，
//! 也没有屏幕捕获权限：`getUserMedia()` 会一直挂着不返回，`navigator.clipboard.read()`
//! 在部分宿主里同样被拒。这三件事在系统侧都有正规接口，所以放到 Sidecar：
//!
//! - `screen/capture`：GDI BitBlt 抓主屏，编码 PNG 回传
//! - `clipboard/image`：读剪贴板里的位图（CF_DIB）
//! - `audio/recordStart` / `audio/recordStop`：cpal 录麦克风，收成 16-bit PCM 的 wav
//!
//! 三者都只回传 base64，落盘仍走既有的 `image/save` 与转写接口。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use base64::Engine;
use serde_json::json;

use crate::{RpcError, RpcResult};

/* ------------------------------------------------------------------ */
/* 截屏                                                                */
/* ------------------------------------------------------------------ */

/// 进程启动时声明每显示器 DPI 感知（PMv2）
///
/// 必须在任何量屏 / 建窗口之前调用：否则混合缩放多屏下坐标被系统虚拟化，
/// 框选窗口显示与裁剪坐标会和真实桌面错位。重复调用会失败（已设置过），无副作用。
#[cfg(windows)]
pub fn ensure_dpi_awareness() -> bool {
    win::set_dpi_awareness()
}

#[cfg(not(windows))]
pub fn ensure_dpi_awareness() -> bool {
    true
}

#[cfg(windows)]
fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // 整屏图较大，用快速压缩：体积差几成，但截屏到插入的等待时间差一个量级
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(rgba)
            .map_err(|error| error.to_string())?;
    }
    Ok(out)
}

#[cfg(windows)]
mod win {
    pub(super) fn set_dpi_awareness() -> bool {
        use windows_sys::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != 0 }
    }

    use std::ffi::c_void;

    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
        SRCCOPY,
    };
    use windows_sys::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics;

    /// 抓主屏，返回 (宽, 高, RGBA 像素)
    pub fn grab_screen() -> Result<(u32, u32, Vec<u8>), String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SM_CXSCREEN, SM_CYSCREEN};
        unsafe {
            // 声明 DPI 感知，否则高分屏下只能抓到缩放后的模糊图
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

            let width = GetSystemMetrics(SM_CXSCREEN);
            let height = GetSystemMetrics(SM_CYSCREEN);
            if width <= 0 || height <= 0 {
                return Err("拿不到屏幕尺寸".into());
            }
            let pixels = grab_rect(0, 0, width, height)?;
            Ok((width as u32, height as u32, pixels))
        }
    }

    /// 抓虚拟桌面：所有显示器拼成的整块区域，原点可能为负（副屏在主屏左侧时）
    pub fn grab_virtual() -> Result<(i32, i32, u32, u32, Vec<u8>), String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        };
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if width <= 0 || height <= 0 {
                // 虚拟桌面取不到时退回主屏
                let (w, h, pixels) = grab_screen()?;
                return Ok((0, 0, w, h, pixels));
            }
            let pixels = grab_rect(x, y, width, height)?;
            Ok((x, y, width as u32, height as u32, pixels))
        }
    }

    /// BitBlt 屏幕上的任意矩形，返回自顶向下的 RGBA
    ///
    /// 显示器刚被唤醒（DPMS 关闭 / 远程会话刚连上）时第一次 `BitBlt` 会返回 0，
    /// 隔一帧再抓就好了。这里重试两次，避免用户按热键直接吃到「截屏失败」。
    unsafe fn grab_rect(x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
        let mut last = String::new();
        // 显示器刚被唤醒（DPMS 关闭 / 远程会话刚连上）时第一次 BitBlt 会返回 0，
        // 锁屏 / 安全桌面下则会成功但抓到一整屏黑。两种都按「隔一会儿再试」处理。
        for attempt in 0..3 {
            match grab_rect_once(x, y, width, height) {
                Ok(pixels) => {
                    if is_blank(&pixels) {
                        last = "屏幕内容全黑".into();
                        if attempt < 2 {
                            std::thread::sleep(std::time::Duration::from_millis(120));
                            continue;
                        }
                        return Err(
                            "屏幕内容不可抓取（可能正在锁屏或处于安全桌面），已取消本次截图".into()
                        );
                    }
                    if attempt > 0 {
                        crate::logln!("[dbx-note] 截屏第 {} 次尝试成功（前 {attempt} 次失败：{last}）", attempt + 1);
                    }
                    return Ok(pixels);
                }
                Err(message) => {
                    last = message;
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(90));
                    }
                }
            }
        }
        Err(last)
    }

    /// 粗采样判断是不是「一整屏黑」（锁屏 / 安全桌面 / 独占全屏的典型表现）
    unsafe fn is_blank(pixels: &[u8]) -> bool {
        if pixels.len() < 4 {
            return true;
        }
        let step = (pixels.len() / 4 / 4096).max(1) * 4;
        let mut index = 0;
        while index + 3 < pixels.len() {
            if pixels[index] > 2 || pixels[index + 1] > 2 || pixels[index + 2] > 2 {
                return false;
            }
            index += step;
        }
        true
    }

    unsafe fn grab_rect_once(
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<Vec<u8>, String> {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("拿不到屏幕设备上下文".into());
        }
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if memory.is_null() || bitmap.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("创建离屏位图失败".into());
        }
        let previous = SelectObject(memory, bitmap as HGDIOBJ);
        // 源坐标可以是负数（虚拟桌面原点在副屏上），屏幕 DC 覆盖整个虚拟桌面
        let copied = BitBlt(memory, 0, 0, width, height, screen, x, y, SRCCOPY);
        SelectObject(memory, previous);

        // BITMAPINFO(HEADER) 在 windows-sys 里没有 Default，只能先清零再逐项赋值
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        // 负数 = 自上而下，省一次翻转
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;

        let mut buffer = vec![0u8; (width * height * 4) as usize];
        let lines = GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            buffer.as_mut_ptr() as *mut c_void,
            &mut info,
            DIB_RGB_COLORS,
        );

        DeleteObject(bitmap as HGDIOBJ);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);

        if copied == 0 || lines == 0 {
            return Err("截屏失败".into());
        }

        // BGRA → RGBA，并把 GDI 留下的 alpha=0 补成不透明
        for pixel in buffer.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok(buffer)
    }

    /// 打开剪贴板，失败时重试
    ///
    /// Windows 的剪贴板是全局单占有资源：剪贴板历史、输入法、资源管理器都可能短暂
    /// 持有它，单次 `OpenClipboard` 会偶发失败。这里退避重试若干次再报错。
    unsafe fn open_clipboard() -> Result<(), String> {
        use windows_sys::Win32::System::DataExchange::OpenClipboard;
        /// 打开剪贴板的最大尝试次数（每次间隔 40ms，合计约 3s）
        const CLIPBOARD_OPEN_RETRIES: u32 = 75;
        /// 每次重试之间的等待时间
        const CLIPBOARD_RETRY_DELAY_MS: u64 = 40;
        // 剪贴板是全局独占资源：剪贴板历史、输入法、别的截图工具、以及同时运行的
        // 其它版本插件 Sidecar 都可能正握着它。成功时立即返回，只有争用才付出等待。
        for attempt in 0..CLIPBOARD_OPEN_RETRIES {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                return Ok(());
            }
            if attempt + 1 < CLIPBOARD_OPEN_RETRIES {
                std::thread::sleep(std::time::Duration::from_millis(CLIPBOARD_RETRY_DELAY_MS));
            }
        }
        Err("剪贴板被其他程序占用，请稍后重试".into())
    }

    /// 读剪贴板里的 CF_DIB 位图
    pub fn grab_clipboard() -> Result<(u32, u32, Vec<u8>), String> {
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, GetClipboardData, IsClipboardFormatAvailable,
        };
        use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
        const CF_DIB: u32 = 8;

        unsafe {
            if IsClipboardFormatAvailable(CF_DIB) == 0 {
                return Err("剪贴板里没有图片".into());
            }
            open_clipboard()?;
            let handle = GetClipboardData(CF_DIB);
            if handle.is_null() {
                CloseClipboard();
                return Err("剪贴板里没有图片".into());
            }
            let size = GlobalSize(handle);
            let pointer = GlobalLock(handle);
            if pointer.is_null() || size == 0 {
                CloseClipboard();
                return Err("读取剪贴板图片失败".into());
            }
            let raw = std::slice::from_raw_parts(pointer as *const u8, size);
            let parsed = decode_dib(raw);
            GlobalUnlock(handle);
            CloseClipboard();
            parsed
        }
    }

    /// 把 RGBA 像素写成 CF_DIB 放进剪贴板（32 位 BI_RGB、自底向上）
    ///
    /// 截图工具的「复制」走这里：宿主 iframe 里 `navigator.clipboard.write()` 常被拒，
    /// 而进程侧写系统剪贴板不受限制，复制出去可以直接粘到别的应用。
    pub fn set_clipboard(rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, SetClipboardData,
        };
        use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        const CF_DIB: u32 = 8;

        let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
        let pixel_bytes = (width as usize) * (height as usize) * 4;
        let total = header_size + pixel_bytes;

        unsafe {
            open_clipboard()?;
            EmptyClipboard();
            let handle = GlobalAlloc(GMEM_MOVEABLE, total);
            if handle.is_null() {
                CloseClipboard();
                return Err("分配剪贴板内存失败".into());
            }
            let base = GlobalLock(handle) as *mut u8;
            if base.is_null() {
                CloseClipboard();
                return Err("锁定剪贴板内存失败".into());
            }

            let header = base as *mut BITMAPINFOHEADER;
            std::ptr::write(header, std::mem::zeroed());
            (*header).biSize = header_size as u32;
            (*header).biWidth = width as i32;
            // 正数高度 = 自底向上，与 GDI 的默认方向一致
            (*header).biHeight = height as i32;
            (*header).biPlanes = 1;
            (*header).biBitCount = 32;
            (*header).biCompression = BI_RGB;
            (*header).biSizeImage = pixel_bytes as u32;

            // RGBA → BGRA，逐行倒着写；alpha 统一 255，否则别的应用粘出来会是透明黑
            let pixels = base.add(header_size);
            for row in 0..height as usize {
                let source_row = (height as usize - 1 - row) * width as usize * 4;
                let target_row = row * width as usize * 4;
                for column in 0..width as usize {
                    let source = source_row + column * 4;
                    let target = target_row + column * 4;
                    *pixels.add(target) = rgba[source + 2];
                    *pixels.add(target + 1) = rgba[source + 1];
                    *pixels.add(target + 2) = rgba[source];
                    *pixels.add(target + 3) = 255;
                }
            }

            GlobalUnlock(handle);
            if SetClipboardData(CF_DIB, handle as *mut c_void).is_null() {
                CloseClipboard();
                return Err("写入剪贴板失败".into());
            }
            CloseClipboard();
            Ok(())
        }
    }

    /// 把宿主主窗口激活到前台
    ///
    /// Sidecar 由宿主进程拉起，所以沿父进程链往上找 3 层，命中有可见顶层窗口的那一进程
    /// 就是宿主（DBeaver / DBX 这类宿主的主窗口标题非空、没有 owner）。
    pub fn focus_host() -> bool {
        use windows_sys::Win32::Foundation::{HWND, LPARAM, TRUE};
        use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow,
            GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
            SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE, SW_SHOW,
        };

        struct Find {
            pid: u32,
            found: HWND,
            score: i32,
        }

        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows_sys::Win32::Foundation::BOOL {
            let state = &mut *(lparam as *mut Find);
            if IsWindowVisible(hwnd) == 0 || !GetWindow(hwnd, GW_OWNER).is_null() {
                return TRUE;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != state.pid {
                return TRUE;
            }
            // 有标题的（主窗口）优先，其次任意可见窗口
            let score = if GetWindowTextLengthW(hwnd) > 0 { 2 } else { 1 };
            if score > state.score {
                state.score = score;
                state.found = hwnd;
            }
            TRUE
        }

        fn parent_pid(pid: u32) -> Option<u32> {
            use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            };
            unsafe {
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
                    return None;
                }
                let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                let mut found = None;
                let mut ok = Process32FirstW(snapshot, &mut entry) != 0;
                while ok {
                    if entry.th32ProcessID == pid {
                        found = Some(entry.th32ParentProcessID);
                        break;
                    }
                    ok = Process32NextW(snapshot, &mut entry) != 0;
                }
                CloseHandle(snapshot);
                found
            }
        }

        let mut pid = std::process::id();
        let mut target: HWND = std::ptr::null_mut();
        for _ in 0..3 {
            let Some(next) = parent_pid(pid) else { break };
            if next == 0 || next == pid || next == 4 {
                break;
            }
            pid = next;
            let mut state = Find {
                pid,
                found: std::ptr::null_mut(),
                score: 0,
            };
            unsafe {
                EnumWindows(Some(collect), &mut state as *mut Find as LPARAM);
            }
            // 只认「有标题的可见顶层窗口」：命令行 / 辅助进程也可能挂在父进程链上，
            // 把它们的窗口拉到前台没有意义，继续往上找宿主主窗口。
            if !state.found.is_null() && state.score >= 2 {
                target = state.found;
                break;
            }
        }
        if target.is_null() {
            crate::logln!("[dbx-note] 找不到宿主窗口（沿父进程链未命中带标题的可见窗口）");
            return false;
        }

        unsafe {
            if IsIconic(target) != 0 {
                ShowWindow(target, SW_RESTORE);
            }
            ShowWindow(target, SW_SHOW);
            if SetForegroundWindow(target) != 0 {
                return true;
            }
            crate::logln!("[dbx-note] SetForegroundWindow 被前台锁拒绝，改用线程输入附加重试");
            // 前台锁：我们的进程不是当前前台时会被拒绝。把输入队列临时挂到前台线程上再试。
            let foreground = GetForegroundWindow();
            let foreground_thread = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
            let mine = GetCurrentThreadId();
            let attached = foreground_thread != 0
                && foreground_thread != mine
                && AttachThreadInput(mine, foreground_thread, TRUE) != 0;
            BringWindowToTop(target);
            let ok = SetForegroundWindow(target) != 0;
            if attached {
                AttachThreadInput(mine, foreground_thread, 0);
            }
            ok
        }
    }

    /// 解析 CF_DIB（BITMAPINFOHEADER + 可选调色板 + 像素）
    fn decode_dib(raw: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {        if raw.len() < 40 {
            return Err("剪贴板位图数据不完整".into());
        }
        let read_u32 = |offset: usize| -> u32 {
            u32::from_le_bytes([raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]])
        };
        let read_i32 = |offset: usize| -> i32 { read_u32(offset) as i32 };

        let header_size = read_u32(0) as usize;
        let width = read_i32(4);
        let height_raw = read_i32(8);
        let bit_count = u16::from_le_bytes([raw[14], raw[15]]);
        let compression = read_u32(16);
        if width <= 0 || height_raw == 0 {
            return Err("剪贴板位图尺寸不合法".into());
        }
        let bottom_up = height_raw > 0;
        let height = height_raw.abs();
        // 只处理未压缩的真彩色；其它（含 PNG 压缩的 DIB）交给前端剪贴板 API
        if compression != 0 || (bit_count != 32 && bit_count != 24) {
            return Err("剪贴板位图格式不受支持".into());
        }

        let bytes_per_pixel = (bit_count / 8) as usize;
        let stride = ((width as usize * bytes_per_pixel) + 3) / 4 * 4;
        let pixel_offset = header_size.max(40);
        let needed = pixel_offset + stride * height as usize;
        if raw.len() < needed {
            return Err("剪贴板位图数据长度不足".into());
        }

        let mut rgba = vec![0u8; (width as usize * height as usize * 4) as usize];
        for row in 0..height as usize {
            let source_row = if bottom_up { height as usize - 1 - row } else { row };
            let start = pixel_offset + source_row * stride;
            for column in 0..width as usize {
                let source = start + column * bytes_per_pixel;
                let target = (row * width as usize + column) * 4;
                rgba[target] = raw[source + 2];
                rgba[target + 1] = raw[source + 1];
                rgba[target + 2] = raw[source];
                rgba[target + 3] = if bytes_per_pixel == 4 && raw[source + 3] != 0 {
                    raw[source + 3]
                } else {
                    255
                };
            }
        }
        Ok((width as u32, height as u32, rgba))
    }
}

/// 把 PNG（base64）写进系统剪贴板，供截图工具的「复制」使用
pub fn write_clipboard(params: &serde_json::Value) -> RpcResult {
    let encoded = params
        .get("dataBase64")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if encoded.is_empty() {
        return Err(RpcError::invalid("缺少图片数据"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| RpcError::invalid("图片数据不是合法的 base64"))?;
    let (width, height, rgba) = decode_png(&bytes)?;
    win::set_clipboard(&rgba, width, height).map_err(RpcError::internal)?;
    Ok(json!({ "ok": true, "width": width, "height": height }))
}

/// 解 PNG 成 RGBA（截图工具裁剪出来的都是 RGBA，兼容 RGB 兜底）
#[cfg(windows)]
fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), RpcError> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = decoder
        .read_info()
        .map_err(|error| RpcError::invalid(format!("解析图片失败：{error}")))?;
    let mut buffer = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| RpcError::invalid(format!("解码图片失败：{error}")))?;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buffer[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for pixel in buffer[..info.buffer_size()].chunks_exact(3) {
                out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
            out
        }
        other => {
            return Err(RpcError::invalid(format!(
                "不支持的图片格式：{other:?}"
            )))
        }
    };
    Ok((info.width, info.height, rgba))
}

/// base64 PNG → (宽, 高, RGBA)
///
/// 「钉在顶层」要从插件浮层把标注结果贴到桌面上，浮层手里只有 base64，
/// 这里负责解码成窗口能直接画的自顶向下 RGBA。
pub fn rgba_from_png_base64(data: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("图片数据不是合法的 base64：{error}"))?;
    decode_png(&bytes).map_err(|error| error.message)
}

fn image_payload(width: u32, height: u32, rgba: &[u8], source: &str) -> RpcResult {    let png = encode_png(width, height, rgba).map_err(RpcError::internal)?;
    Ok(json!({
        "width": width,
        "height": height,
        "mime": "image/png",
        "source": source,
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(png),
    }))
}

/// 截整屏（主显示器）
pub fn capture_screen() -> RpcResult {
    match win::grab_screen() {
        Ok((width, height, rgba)) => image_payload(width, height, &rgba, "screen"),
        Err(message) => Err(RpcError::internal(message)),
    }
}

/// 抓虚拟桌面（所有显示器拼成的整块区域），返回 (原点x, 原点y, 宽, 高, RGBA)
pub fn virtual_screen() -> Result<(i32, i32, u32, u32, Vec<u8>), String> {
    win::grab_virtual()
}

/// RGBA → PNG base64
pub fn rgba_png_base64(width: u32, height: u32, rgba: &[u8]) -> Result<String, String> {
    let png = encode_png(width, height, rgba)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/// RGBA → PNG 原始字节（另存为直接落盘用，省一次 base64 往返）
pub fn rgba_png_bytes(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    encode_png(width, height, rgba)
}

/// RGBA 直接写系统剪贴板（全局截图选中即复制）
pub fn rgba_to_clipboard(rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    win::set_clipboard(rgba, width, height)
}

/// 读剪贴板里的图片
pub fn capture_clipboard() -> RpcResult {
    match win::grab_clipboard() {
        Ok((width, height, rgba)) => image_payload(width, height, &rgba, "clipboard"),
        Err(message) => Err(RpcError::internal(message)),
    }
}

/* ------------------------------------------------------------------ */
/* 录音                                                                */
/* ------------------------------------------------------------------ */

struct Recorder {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    channels: u16,
    started: Instant,
    thread: Option<JoinHandle<()>>,
}

static RECORDER: Mutex<Option<Recorder>> = Mutex::new(None);

fn wav_from_pcm(samples: &[f32], sample_rate: u32, channels: u16) -> Vec<u8> {
    // 下混成单声道：转写服务只需要一路语音，文件也小一半以上
    let mono: Vec<i16> = if channels <= 1 {
        samples.iter().map(|value| (value.clamp(-1.0, 1.0) * 32767.0) as i16).collect()
    } else {
        samples
            .chunks(channels as usize)
            .map(|frame| {
                let sum: f32 = frame.iter().sum();
                ((sum / frame.len() as f32).clamp(-1.0, 1.0) * 32767.0) as i16
            })
            .collect()
    };

    let data_len = (mono.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for value in mono {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// 开始录音：起一个持有 cpal Stream 的线程，样本累积到共享缓冲
pub fn record_start() -> RpcResult {
    use cpal::traits::{DeviceTrait, HostTrait};

    let mut guard = RECORDER.lock().map_err(|_| RpcError::internal("录音状态被占用"))?;
    if guard.is_some() {
        return Ok(json!({ "recording": true }));
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| RpcError::invalid("没有可用的麦克风"))?;
    let config = device
        .default_input_config()
        .map_err(|error| RpcError::invalid(format!("麦克风不可用：{error}")))?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let stop = Arc::new(AtomicBool::new(false));
    let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let thread_stop = stop.clone();
    let thread_samples = samples.clone();
    let stream_config: cpal::StreamConfig = config.clone().into();
    let thread = std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, StreamTrait};

        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            let _ = ready_tx.send(Err("没有可用的麦克风".into()));
            return;
        };
        let buffer = thread_samples.clone();
        let build = device.build_input_stream(
            &stream_config,
            move |data: &[f32], _| {
                if let Ok(mut target) = buffer.lock() {
                    // 上限约 5 分钟，避免异常情况下一直涨
                    if target.len() < sample_rate_cap(sample_rate) {
                        target.extend_from_slice(data);
                    }
                }
            },
            move |_error| {},
            None,
        );

        match build {
            Ok(stream) => {
                if let Err(error) = stream.play() {
                    let _ = ready_tx.send(Err(format!("开始录音失败：{error}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                while !thread_stop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                drop(stream);
            }
            Err(error) => {
                let _ = ready_tx.send(Err(format!("打开麦克风失败：{error}")));
            }
        }
    });

    match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => {
            *guard = Some(Recorder {
                stop,
                samples,
                sample_rate,
                channels,
                started: Instant::now(),
                thread: Some(thread),
            });
            Ok(json!({ "recording": true, "sampleRate": sample_rate, "channels": channels }))
        }
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(RpcError::invalid(message))
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            let _ = thread.join();
            Err(RpcError::internal("麦克风没有响应"))
        }
    }
}

fn sample_rate_cap(sample_rate: u32) -> usize {
    // 5 分钟
    sample_rate as usize * 5 * 60
}

/// 结束录音，返回 wav 的 base64
pub fn record_stop() -> RpcResult {
    let recorder = {
        let mut guard = RECORDER.lock().map_err(|_| RpcError::internal("录音状态被占用"))?;
        guard.take()
    };
    let Some(mut recorder) = recorder else {
        return Err(RpcError::invalid("当前没有在录音"));
    };
    recorder.stop.store(true, Ordering::Relaxed);
    if let Some(thread) = recorder.thread.take() {
        let _ = thread.join();
    }
    let samples = recorder
        .samples
        .lock()
        .map(|values| values.clone())
        .unwrap_or_default();
    let duration_ms = recorder.started.elapsed().as_millis() as u64;
    if samples.is_empty() {
        return Err(RpcError::invalid("没有录到声音"));
    }
    let wav = wav_from_pcm(&samples, recorder.sample_rate, recorder.channels);
    Ok(json!({
        "mime": "audio/wav",
        "name": "recording.wav",
        "durationMs": duration_ms,
        "size": wav.len(),
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(wav),
    }))
}

/// 录音状态（前端用它决定按钮文案）
pub fn record_status() -> RpcResult {
    let recording = RECORDER.lock().map(|guard| guard.is_some()).unwrap_or(false);
    Ok(json!({ "recording": recording, "available": true }))
}

/// 把宿主（DBX）主窗口激活到前台
///
/// 全局热键截完图时，标注工具栏在插件浮层里；宿主还在后台的话用户只看得到
/// 「图进了剪贴板」，没有任何工具可用。这里顺着父进程链找到宿主顶层窗口并激活。
#[cfg(windows)]
pub fn focus_host_window() -> bool {
    win::focus_host()
}

#[cfg(not(windows))]
pub fn focus_host_window() -> bool {
    false
}

/// 兜底：进程退出前停掉录音线程
pub fn shutdown() {
    if let Ok(mut guard) = RECORDER.lock() {
        if let Some(mut recorder) = guard.take() {
            recorder.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = recorder.thread.take() {
                let _ = thread.join();
            }
        }
    }
}
