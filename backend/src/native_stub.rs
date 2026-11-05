//! 非 Windows 平台的原生能力桩
//!
//! 截图、剪贴板位图、麦克风录音、DPI 声明都直接调 Win32（GDI / 剪贴板 / COM / cpal），
//! macOS 与 Linux 需要各自的系统 API，本轮尚未实现。这里给出**同名同签名**的桩：
//! 协议层照常分发，调用方拿到的是可读错误，而不是编译不过或进程崩溃。
//!
//! 与 Windows 实现保持一一对应的函数清单见 `native.rs`，改动任何一侧都要同步另一侧。

#![allow(dead_code)]

use serde_json::Value;

use crate::{RpcError, RpcResult};

/// 统一的「本平台暂不支持」文案（前端直接展示给用户）
const UNSUPPORTED: &str = "当前平台暂不支持该能力：截图、剪贴板位图与录音目前仅 Windows 可用";

fn unsupported<T>() -> Result<T, String> {
    Err(UNSUPPORTED.to_string())
}

/// 非 Windows 没有 DPI 感知需要声明，视为已就绪
pub fn ensure_dpi_awareness() -> bool {
    true
}

/// 非 Windows 没有「宿主窗口前置」的概念
pub fn focus_host_window() -> bool {
    false
}

pub fn capture_screen() -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn virtual_screen() -> Result<(i32, i32, u32, u32, Vec<u8>), String> {
    unsupported()
}

pub fn capture_clipboard() -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn write_clipboard(_params: &Value) -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn rgba_from_png_base64(_data: &str) -> Result<(u32, u32, Vec<u8>), String> {
    unsupported()
}

pub fn rgba_png_base64(_width: u32, _height: u32, _rgba: &[u8]) -> Result<String, String> {
    unsupported()
}

pub fn rgba_png_bytes(_width: u32, _height: u32, _rgba: &[u8]) -> Result<Vec<u8>, String> {
    unsupported()
}

pub fn rgba_to_clipboard(_rgba: &[u8], _width: u32, _height: u32) -> Result<(), String> {
    unsupported()
}

pub fn record_start() -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn record_stop() -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn record_status() -> RpcResult {
    Ok(serde_json::json!({ "recording": false, "supported": false }))
}

/// 进程收尾时释放全局资源；非 Windows 下没有需要释放的东西
pub fn shutdown() {}
