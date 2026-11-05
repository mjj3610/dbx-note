//! 非 Windows 平台的系统 OCR 桩
//!
//! Windows 实现走 WinRT 的 `Windows.Media.Ocr`，且为了防住畸形图片导致的 AV 退出，
//! 实际识别放在独立子进程（`--ocr-once`）里跑。macOS（Vision）与 Linux（Tesseract）
//! 需要各自的绑定，本轮尚未实现。
//!
//! 桩保留同样的返回结构：`status` 如实报告「不可用」，`run` 返回可读错误，
//! 前端据此把「系统识别」按钮置灰，而不会把整条图片识别链路带崩。

#![allow(dead_code)]

use serde_json::{json, Value};

use crate::{App, RpcError, RpcResult};

const UNSUPPORTED: &str = "当前平台暂不支持系统 OCR，请在设置里配置视觉模型走模型识别";

/// 子进程 worker 入口：非 Windows 上不会被触发（`--ocr-once` 只在 Windows 有用）
pub fn run_worker_once() {}

/// 系统 OCR 是否可用；结构与 Windows 实现一致
pub fn status(_app: &App) -> RpcResult {
    Ok(json!({
        "engine": "none",
        "available": false,
        "languages": [],
        "error": UNSUPPORTED,
    }))
}

pub fn run(_app: &App, _params: &Value) -> RpcResult {
    Err(RpcError::internal(UNSUPPORTED))
}
