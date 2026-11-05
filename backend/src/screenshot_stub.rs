//! 非 Windows 平台的截图链路桩
//!
//! Windows 实现包含四件事：全局热键（RegisterHotKey）、原生框选窗口（GDI 双缓冲 + 就地标注）、
//! 截屏位图取色与置顶贴图窗口。macOS 需要 ScreenCaptureKit / CGWindow，Linux 需要 X11 或
//! PipeWire，本轮尚未实现。
//!
//! 桩让协议层的 `screenshot/*` 全部分发成功但返回可读错误，前端据此把入口置灰，
//! 不影响笔记、AI、同步等主流程。

#![allow(dead_code)]

use serde_json::{json, Value};

use crate::{RpcError, RpcResult};

const UNSUPPORTED: &str = "当前平台暂不支持截图：框选、标注与贴图目前仅 Windows 可用";

/// 不注册任何全局热键
pub fn start_hotkey(_preferred: Option<String>) {}

/// 全局热键状态：如实报告「未注册」以及原因
pub fn hotkey_status() -> RpcResult {
    Ok(json!({
        "combo": "",
        "registered": false,
        "reason": UNSUPPORTED,
    }))
}

pub fn mark_ui_hotkey() -> RpcResult {
    Ok(Value::Null)
}

pub fn select() -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn global_shot(_params: &Value) -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn take_pending() -> RpcResult {
    Ok(Value::Null)
}

pub fn window_probe() -> RpcResult {
    Ok(json!({ "open": false, "supported": false, "reason": UNSUPPORTED }))
}

pub fn pin_image(_params: &Value) -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn unpin_all() -> RpcResult {
    Ok(Value::Null)
}

pub fn press_key(_params: &Value) -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}

pub fn type_text(_params: &Value) -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}
