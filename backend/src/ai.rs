//! AI 请求代理与通用 HTTP 通道
//!
//! 插件页面在沙箱里（CSP `connect-src 'none'`）无法直连外部接口，
//! 因此模型调用、模型列表、以及设置页里的"测试连接"统一走这里。
//!
//! 流式输出用「后台线程累积 + 前端轮询」实现：
//! `ai/start` 立即返回 id，`ai/poll` 读取已累积的文本与完成状态。
//! 这样既不依赖宿主的自定义事件通道，也能避免长连接把宿主卡住。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{param_i64, param_str, App, RpcError, RpcResult};

/// 单次请求默认超时（毫秒）
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// 流式输出最长等待时间（毫秒），防止僵死线程
const STREAM_MAX_MS: u64 = 180_000;

/// 流式对话的中间状态
pub struct StreamState {
    pub text: String,
    pub done: bool,
    pub error: Option<String>,
    pub cancelled: Arc<AtomicBool>,
}

fn client(timeout_ms: u64) -> Result<reqwest::blocking::Client, RpcError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| RpcError::internal(format!("创建 HTTP 客户端失败：{error}")))
}

/// 拼接 OpenAI 兼容接口地址，容忍用户填的 baseUrl 带不带 /v1
fn endpoint(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    format!("{trimmed}{path}")
}

fn model_config(params: &Value) -> (String, String, String, f64) {
    (
        param_str(params, "baseUrl"),
        param_str(params, "apiKey"),
        param_str(params, "model"),
        params.get("temperature").and_then(Value::as_f64).unwrap_or(0.7),
    )
}

fn build_body(params: &Value, stream: bool) -> Value {
    let (_, _, model, temperature) = model_config(params);
    let messages = params.get("messages").cloned().unwrap_or(json!([]));
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": stream,
    });

    // 多模型配置下每个模型可以有自己的 top_p / max_tokens。
    // top_p 缺省或等于 1 时不下发（1 就是无偏置采样，发了反而可能被部分厂商拒），
    // max_tokens 为 0 时不下发，交给服务端默认值。
    let top_p = params.get("topP").and_then(Value::as_f64).unwrap_or(0.0);
    if top_p > 0.0 && (top_p - 1.0).abs() > f64::EPSILON {
        if let Some(object) = body.as_object_mut() {
            object.insert("top_p".into(), json!(top_p));
        }
    }
    let max_tokens = param_i64(params, "maxTokens", 0);
    if max_tokens > 0 {
        if let Some(object) = body.as_object_mut() {
            object.insert("max_tokens".into(), json!(max_tokens));
        }
    }

    body
}

/// 非流式对话：一次返回完整文本
pub fn chat(_app: &App, params: &Value) -> RpcResult {
    let (base_url, api_key, model, _) = model_config(params);
    if base_url.is_empty() || model.is_empty() {
        return Err(RpcError::invalid("请先在设置里配置模型服务地址与模型名称"));
    }
    let timeout = param_i64(params, "timeoutMs", DEFAULT_TIMEOUT_MS as i64) as u64;
    let response = client(timeout)?
        .post(endpoint(&base_url, "/chat/completions"))
        .bearer_auth(&api_key)
        .json(&build_body(params, false))
        .send()
        .map_err(|error| RpcError::internal(format!("请求模型服务失败：{error}")))?;

    let status = response.status();
    let text = response
        .text()
        .map_err(|error| RpcError::internal(format!("读取响应失败：{error}")))?;
    if !status.is_success() {
        return Err(RpcError::internal(format!(
            "模型服务返回 {status}：{}",
            truncate(&text, 400)
        )));
    }

    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| RpcError::internal(format!("响应不是合法 JSON：{}", truncate(&text, 200))))?;
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Ok(json!({ "content": content, "usage": parsed.get("usage").cloned().unwrap_or(Value::Null) }))
}

/// 启动流式对话
pub fn start(app: &App, params: &Value) -> RpcResult {
    let (base_url, api_key, model, _) = model_config(params);
    if base_url.is_empty() || model.is_empty() {
        return Err(RpcError::invalid("请先在设置里配置模型服务地址与模型名称"));
    }

    let id = Uuid::new_v4().to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut streams = app.streams.lock().map_err(|_| RpcError::internal("状态锁异常"))?;
        streams.insert(
            id.clone(),
            StreamState {
                text: String::new(),
                done: false,
                error: None,
                cancelled: Arc::clone(&cancelled),
            },
        );
    }

    let chat_id = id.clone();
    let body = build_body(params, true);
    let url = endpoint(&base_url, "/chat/completions");
    // 流式线程只持有 streams 的 Arc 副本，不借用 App，避免悬垂引用
    let streams = Arc::clone(&app.streams);
    let cancelled_thread = Arc::clone(&cancelled);

    std::thread::spawn(move || {
        let result = run_stream(&url, &api_key, &body, &streams, &chat_id, &cancelled_thread);
        if let Ok(mut guard) = streams.lock() {
            if let Some(state) = guard.get_mut(&chat_id) {
                if let Err(message) = result {
                    state.error = Some(message);
                }
                state.done = true;
            }
        }
    });

    Ok(json!({ "id": id }))
}

fn run_stream(
    url: &str,
    api_key: &str,
    body: &Value,
    streams: &Arc<std::sync::Mutex<HashMap<String, StreamState>>>,
    chat_id: &str,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(STREAM_MAX_MS))
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;

    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(body)
        .send()
        .map_err(|error| format!("请求模型服务失败：{error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Err(format!("模型服务返回 {status}：{}", truncate(&text, 400)));
    }

    let reader = BufReader::new(response);
    for line in reader.lines() {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }
        let line = match line {
            Ok(value) => value,
            Err(error) => return Err(format!("读取流式响应失败：{error}")),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with("data:") {
            continue;
        }
        let payload = trimmed.trim_start_matches("data:").trim();
        if payload == "[DONE]" {
            return Ok(());
        }
        let parsed: Value = match serde_json::from_str(payload) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let delta = parsed
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if delta.is_empty() {
            continue;
        }
        if let Ok(mut guard) = streams.lock() {
            if let Some(state) = guard.get_mut(chat_id) {
                state.text.push_str(delta);
            }
        }
    }
    Ok(())
}

/// 轮询流式结果
pub fn poll(app: &App, params: &Value) -> RpcResult {
    let id = param_str(params, "id");
    let streams = app.streams.lock().map_err(|_| RpcError::internal("状态锁异常"))?;
    match streams.get(&id) {
        Some(state) => Ok(json!({
            "text": state.text,
            "done": state.done,
            "error": state.error,
        })),
        None => Err(RpcError::internal("会话不存在或已结束")),
    }
}

/// 取消流式请求
pub fn cancel(app: &App, params: &Value) -> RpcResult {
    let id = param_str(params, "id");
    let streams = app.streams.lock().map_err(|_| RpcError::internal("状态锁异常"))?;
    if let Some(state) = streams.get(&id) {
        state.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(json!({ "ok": true }))
}

/// 拉取模型列表（OpenAI 兼容 /models）
pub fn models(params: &Value) -> RpcResult {
    let (base_url, api_key, _, _) = model_config(params);
    if base_url.is_empty() {
        return Err(RpcError::invalid("请先填写服务地址"));
    }
    let response = client(20_000)?
        .get(endpoint(&base_url, "/models"))
        .bearer_auth(&api_key)
        .send()
        .map_err(|error| RpcError::internal(format!("请求失败：{error}")))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| RpcError::internal(format!("读取响应失败：{error}")))?;
    if !status.is_success() {
        return Err(RpcError::internal(format!("服务返回 {status}：{}", truncate(&text, 300))));
    }
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let items = parsed
        .get("data")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("id").and_then(Value::as_str))
                .map(|id| json!(id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({ "items": items }))
}

/// 视觉识别：把图片交给多模态模型，返回识别出的文字 / 描述
///
/// 图片可以由工作区路径给出（Sidecar 自己读盘），也可以直接传 base64，
/// 这样编辑器里的图片节点、截图预览都能复用同一条通道。
pub fn vision(app: &App, params: &Value) -> RpcResult {
    let (base_url, api_key, model, temperature) = model_config(params);
    if base_url.is_empty() || model.is_empty() {
        return Err(RpcError::invalid("请先在设置里配置识别模型（地址与模型名）"));
    }
    let (data_url, _mime) = match image_payload(app, params)? {
        Some(value) => value,
        None => return Err(RpcError::invalid("缺少图片内容")),
    };
    let prompt = {
        let value = param_str(params, "prompt");
        if value.trim().is_empty() {
            "请识别这张图片中的文字，按原样输出，不要添加解释。".to_string()
        } else {
            value
        }
    };

    let body = json!({
        "model": model,
        "temperature": temperature.min(0.3),
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": data_url } }
            ]
        }],
    });
    // 描述图片时限制输出长度（参考项目 `max_tokens = 120`），避免记录里一大段废话
    let mut body = body;
    let max_tokens = param_i64(params, "maxTokens", 0);
    if max_tokens > 0 {
        if let Some(object) = body.as_object_mut() {
            object.insert("max_tokens".into(), json!(max_tokens));
        }
    }

    let response = client(120_000)?
        .post(endpoint(&base_url, "/chat/completions"))
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .map_err(|error| RpcError::internal(format!("请求识别服务失败：{error}")))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| RpcError::internal(format!("读取响应失败：{error}")))?;
    if !status.is_success() {
        return Err(RpcError::internal(format!("识别服务返回 {status}：{}", truncate(&text, 400))));
    }
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| RpcError::internal(format!("响应不是合法 JSON：{}", truncate(&text, 200))))?;
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    Ok(json!({ "text": content }))
}

/// 语音转写：把本机音频文件发给 OpenAI 兼容的 /audio/transcriptions
pub fn transcribe(params: &Value) -> RpcResult {
    let (base_url, api_key, model, _) = model_config(params);
    if base_url.is_empty() {
        return Err(RpcError::invalid("请先在设置里配置语音识别服务地址"));
    }
    let path = param_str(params, "path");
    // 录音场景下音频只在页面内存里，允许直接传 base64（不落盘）
    let base64_param = param_str(params, "audioBase64");
    let mime_param = param_str(params, "mime");
    let name_param = param_str(params, "name");
    let (bytes, file_name) = if path.trim().is_empty() {
        if base64_param.trim().is_empty() {
            return Err(RpcError::invalid("请选择要转写的音频文件"));
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(base64_param.trim())
            .map_err(|_| RpcError::invalid("音频数据不是合法的 base64"))?;
        let ext = match mime_param.as_str() {
            "audio/mp4" | "audio/m4a" => "m4a",
            "audio/mpeg" | "audio/mp3" => "mp3",
            "audio/wav" | "audio/x-wav" => "wav",
            "audio/ogg" => "ogg",
            _ => "webm",
        };
        let name = if name_param.trim().is_empty() {
            format!("recording.{ext}")
        } else {
            name_param.clone()
        };
        (decoded, name)
    } else {
        let file_path = std::path::PathBuf::from(path.trim());
        let bytes = std::fs::read(&file_path)
            .map_err(|error| RpcError::invalid(format!("读取音频失败：{error}")))?;
        let file_name = file_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "audio.mp3".to_string());
        (bytes, file_name)
    };
    if bytes.len() > 60 * 1024 * 1024 {
        return Err(RpcError::invalid("音频超过 60MB 上限"));
    }
    let model = if model.trim().is_empty() { "whisper-1".to_string() } else { model };

    let mime = if mime_param.trim().is_empty() {
        "application/octet-stream".to_string()
    } else {
        mime_param.clone()
    };
    let part = reqwest::blocking::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&mime)
        .map_err(|error| RpcError::internal(format!("构造上传内容失败：{error}")))?;
    let form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("model", model);

    let response = client(120_000)?
        .post(endpoint(&base_url, "/audio/transcriptions"))
        .bearer_auth(&api_key)
        .multipart(form)
        .send()
        .map_err(|error| RpcError::internal(format!("请求转写服务失败：{error}")))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| RpcError::internal(format!("读取响应失败：{error}")))?;
    if !status.is_success() {
        return Err(RpcError::internal(format!("转写服务返回 {status}：{}", truncate(&text, 400))));
    }
    // 大多数服务返回 {"text": "..."}，少数直接返回纯文本
    let content = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("text").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| text.trim().to_string());
    Ok(json!({ "text": content }))
}

/// 取图片内容：优先用工作区路径读盘，其次用传入的 base64
fn image_payload(app: &App, params: &Value) -> Result<Option<(String, String)>, RpcError> {
    let mime_of = |ext: &str| match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };

    let base64_param = param_str(params, "imageBase64");
    if !base64_param.trim().is_empty() {
        let mime = {
            let value = param_str(params, "mime");
            if value.trim().is_empty() { "image/png".to_string() } else { value }
        };
        return Ok(Some((
            format!("data:{mime};base64,{base64_param}"),
            mime,
        )));
    }

    let path = param_str(params, "imagePath");
    if path.trim().is_empty() {
        return Ok(None);
    }
    let root = app
        .root
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| app.data_dir.join("workspace"));
    let target = crate::files::safe_join(&root, &path)?;
    let bytes = std::fs::read(&target)
        .map_err(|error| RpcError::invalid(format!("读取图片失败：{error}")))?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err(RpcError::invalid("图片超过 20MB 上限"));
    }
    let extension = target
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = mime_of(&extension).to_string();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some((format!("data:{mime};base64,{encoded}"), mime)))
}

/// 通用 HTTP 代理：设置页测试连接、拉取远程内容等
pub fn net_request(params: &Value) -> RpcResult {
    let url = param_str(params, "url");
    if url.is_empty() {
        return Err(RpcError::invalid("缺少请求地址"));
    }
    let method = {
        let value = param_str(params, "method").to_uppercase();
        if value.is_empty() { "GET".to_string() } else { value }
    };
    let timeout = param_i64(params, "timeoutMs", 20_000).clamp(1_000, 120_000) as u64;
    let http = client(timeout)?;

    let mut request = match method.as_str() {
        "POST" => http.post(&url),
        "PUT" => http.put(&url),
        "DELETE" => http.delete(&url),
        _ => http.get(&url),
    };

    if let Some(headers) = params.get("headers").and_then(Value::as_object) {
        for (key, value) in headers {
            if let Some(text) = value.as_str() {
                request = request.header(key, text);
            }
        }
    }
    if let Some(body) = params.get("body").and_then(Value::as_str) {
        request = request.body(body.to_string());
    }

    let response = request
        .send()
        .map_err(|error| RpcError::internal(format!("请求失败：{error}")))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(key, value)| value.to_str().ok().map(|text| (key.to_string(), text.to_string())))
        .collect::<HashMap<_, _>>();
    let bytes = response
        .bytes()
        .map_err(|error| RpcError::internal(format!("读取响应失败：{error}")))?;

    Ok(json!({
        "status": status,
        "headers": headers,
        "body": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "url": url,
    }))
}

fn truncate(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    chars[..max].iter().collect()
}
