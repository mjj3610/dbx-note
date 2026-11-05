//! 系统 OCR（Windows.Media.Ocr）
//!
//! 参考项目的图片识别是**两条腿**（`recognizeImageWithFallback`）：
//! 先让视觉模型看图，返回空 / 抛错就回退系统 OCR，仍然能读出图里的文字。
//! 插件此前只有 VLM 一条腿——把纯文本模型（比如 qwen3-8B）填进识别配置，
//! 服务端直接 400，记录上就只剩一句"图片识别失败"。
//!
//! 四个实现约束：
//! 1. WinRT 的 `IAsyncOperation::get()` **阻塞调用线程**，而且必须在 COM 公寓里调，
//!    所以 OCR 全部丢进独立子进程（`--ocr-once`），自己做 `CoInitializeEx`；
//! 2. **子进程隔离**：WinRT 的 OCR 是原生代码，喂畸形 / 极小图片能直接 AV 退出进程
//!    （实测 1×1 PNG 会让 `backend.exe` 以 0xC0000005 崩掉）。放在子进程里崩，
//!    主进程只收到"子进程异常退出"，转成一条普通错误返回，插件不会连带挂掉；
//! 3. 识别可能很慢，统一加超时（对齐参考项目的 30s），超时杀子进程；
//! 4. 引擎按"中文优先"挑一个系统已装的语言，没装 OCR 语言包时如实报错，
//!    前端据此把"系统 OCR"标成不可用。
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};

use crate::files;
use crate::{param_str, App, RpcError, RpcResult};

/** 引擎标识：前端用它区分"系统 OCR"与"VLM" */
const ENGINE: &str = "windows-ocr";
/** 识别超时（参考项目 `DEFAULT_OCR_TIMEOUT_MS`） */
const TIMEOUT_MS: u64 = 30_000;
/** 状态探测给短一点：只是列语言 + 建引擎 */
const PROBE_TIMEOUT_MS: u64 = 8_000;
/** 语言优先级：先简体，再繁体/英文/日/韩 */
const PREFERRED: [&str; 5] = ["zh-Hans", "zh-Hant", "en-US", "ja-JP", "ko-KR"];

/// 子进程入口：`backend.exe --ocr-once` 从 stdin 读一个 JSON，跑完把结果打到 stdout
///
/// 请求形态：`{"status": true}` 或 `{"path": "C:////…////a.png"}`
/// 响应形态：`{"text": "…"}` / `{"available": true, "languages": [...], "active": "…"}` / `{"error": "…"}`
pub fn run_worker_once() {
    // 这里必须是 MTA：WinRT 的异步 .get() 依赖公寓初始化
    unsafe {
        let _ = windows_sys::Win32::System::Com::CoInitializeEx(
            std::ptr::null(),
            windows_sys::Win32::System::Com::COINIT_MULTITHREADED as u32,
        );
    }

    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let payload: Value = serde_json::from_str(&input).unwrap_or(Value::Null);

    let result = if payload.get("status").and_then(Value::as_bool).unwrap_or(false) {
        probe_engine()
    } else {
        let path = payload.get("path").and_then(Value::as_str).unwrap_or_default();
        recognize_file(path).map(|text| json!({ "text": text }))
    };

    let output = match result {
        Ok(value) => value,
        Err(message) => json!({ "error": message }),
    };
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{output}");
    let _ = stdout.flush();
}

/// 探测引擎：能建出引擎才算可用，顺带把语言列表带回去
fn probe_engine() -> Result<Value, String> {
    let available = available_languages()?;
    if available.is_empty() {
        return Err("系统没有安装 OCR 识别语言包".to_string());
    }
    let (_engine, tag) = create_engine()?;
    Ok(json!({ "available": true, "languages": available, "active": tag }))
}

/// 起一个 OCR 子进程，把 payload 塞进去，读回一行 JSON
///
/// 子进程崩溃（原生 AV）时 stdout 是空的，这里如实转成错误——这正是隔离的意义：
/// 主进程不会跟着挂，记录上只是"这次识别失败"。
fn call_worker(payload: Value, timeout: Duration) -> Result<Value, String> {
    let exe = std::env::current_exe().map_err(|error| format!("定位 OCR 进程失败：{error}"))?;
    let mut child = Command::new(exe)
        .arg("--ocr-once")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动 OCR 进程失败：{error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.to_string().as_bytes());
        // 关掉 stdin：子进程按"读到 EOF"判定请求结束
    }

    // 单独读 stdout：文字可能超过管道缓冲，不读会让子进程写满阻塞
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buffer = String::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = stream.read_to_string(&mut buffer);
        }
        buffer
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = reader.join().unwrap_or_default();
                let trimmed = output.trim();
                if trimmed.is_empty() {
                    return Err(format!("系统 OCR 进程异常退出（{status}）"));
                }
                let parsed: Value = serde_json::from_str(trimmed)
                    .map_err(|_| format!("系统 OCR 进程返回异常：{}", trimmed.chars().take(120).collect::<String>()))?;
                if let Some(error) = parsed.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
                return Ok(parsed);
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("系统 OCR 超时".to_string());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(format!("等待 OCR 进程失败：{error}")),
        }
    }
}

/** 系统里已安装的 OCR 识别语言（如 `zh-Hans-CN`、`en-US`） */
fn available_languages() -> Result<Vec<String>, String> {
    let languages = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|error| format!("读取系统 OCR 语言失败：{error}"))?;
    let size = languages
        .Size()
        .map_err(|error| format!("读取系统 OCR 语言数量失败：{error}"))?;
    let mut tags = Vec::new();
    for index in 0..size {
        let language = languages
            .GetAt(index)
            .map_err(|error| format!("读取系统 OCR 语言失败：{error}"))?;
        let tag = language
            .LanguageTag()
            .map_err(|error| format!("读取系统 OCR 语言标签失败：{error}"))?
            .to_string_lossy();
        if !tag.is_empty() {
            tags.push(tag);
        }
    }
    Ok(tags)
}

/** 语言标签匹配：`zh-Hans` 能命中 `zh-Hans-CN`，`en-US` 命中 `en-US` */
fn pick_language(available: &[String], wanted: &str) -> Option<String> {
    let lower = wanted.to_lowercase();
    available
        .iter()
        .find(|tag| tag.to_lowercase() == lower)
        .or_else(|| {
            available.iter().find(|tag| {
                let tag = tag.to_lowercase();
                tag.starts_with(&format!("{lower}-")) || lower.starts_with(&format!("{tag}-"))
            })
        })
        .cloned()
}

/** 挑一个可用引擎：优先中文，其次英文，最后按用户配置的语言兜底 */
fn create_engine() -> Result<(OcrEngine, String), String> {
    let available = available_languages()?;
    if available.is_empty() {
        return Err("系统没有安装 OCR 识别语言包".to_string());
    }
    for wanted in PREFERRED {
        let Some(tag) = pick_language(&available, wanted) else { continue };
        let language = Language::CreateLanguage(&HSTRING::from(tag.as_str()))
            .map_err(|error| format!("创建 OCR 语言 {tag} 失败：{error}"))?;
        if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&language) {
            return Ok((engine, tag));
        }
    }
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|error| format!("创建系统 OCR 引擎失败：{error}"))?;
    let tag = available.first().cloned().unwrap_or_default();
    Ok((engine, tag))
}

/** 读图 → OCR → 按行拼回文本（行序即阅读顺序，与参考项目一致） */
fn recognize_file(path: &str) -> Result<String, String> {
    if !std::path::Path::new(path).is_file() {
        return Err(format!("图片文件不存在：{path}"));
    }
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.replace('/', "\\")))
        .map_err(|error| format!("打开图片失败：{error}"))?
        .get()
        .map_err(|error| format!("读取图片失败：{error}"))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|error| format!("打开图片流失败：{error}"))?
        .get()
        .map_err(|error| format!("读取图片流失败：{error}"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|error| format!("解码图片失败：{error}"))?
        .get()
        .map_err(|error| format!("解码图片失败：{error}"))?;
    let decoded = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|error| format!("读取位图失败：{error}"))?
        .get()
        .map_err(|error| format!("读取位图失败：{error}"))?;
    // OCR 只吃 Bgra8 / 预乘 alpha，先统一转一次
    let bitmap = SoftwareBitmap::ConvertWithAlpha(
        &decoded,
        BitmapPixelFormat::Bgra8,
        BitmapAlphaMode::Premultiplied,
    )
    .map_err(|error| format!("转换位图格式失败：{error}"))?;

    let (engine, _tag) = create_engine()?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| format!("OCR 启动失败：{error}"))?
        .get()
        .map_err(|error| format!("OCR 识别失败：{error}"))?;
    let lines = result
        .Lines()
        .map_err(|error| format!("读取 OCR 结果失败：{error}"))?;
    let count = lines
        .Size()
        .map_err(|error| format!("读取 OCR 行数失败：{error}"))?;
    let mut text = Vec::new();
    for index in 0..count {
        let line = lines
            .GetAt(index)
            .map_err(|error| format!("读取 OCR 行失败：{error}"))?;
        let value = line
            .Text()
            .map_err(|error| format!("读取 OCR 文本失败：{error}"))?
            .to_string_lossy();
        if !value.trim().is_empty() {
            text.push(value);
        }
    }
    Ok(text.join("\n"))
}

/** 工作区相对路径 → 绝对路径 */
fn resolve(app: &App, path: &str) -> Result<PathBuf, RpcError> {
    if std::path::Path::new(path).is_absolute() {
        return Ok(PathBuf::from(path));
    }
    let root = app
        .root
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| app.data_dir.join("workspace"));
    files::safe_join(&root, path)
}

/** base64 图片落到临时目录（记录里只有 data URL 时用） */
fn write_temp(app: &App, base64: &str, mime: &str) -> Result<PathBuf, RpcError> {
    use base64::Engine as _;
    let dir = app.data_dir.join("temp-ocr");
    std::fs::create_dir_all(&dir).map_err(|error| RpcError::internal(format!("创建临时目录失败：{error}")))?;
    let ext = match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/gif" => "gif",
        _ => "png",
    };
    let name = format!("{}.{ext}", uuid::Uuid::new_v4());
    let target = dir.join(name);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|error| RpcError::invalid(format!("图片 base64 解不开：{error}")))?;
    std::fs::write(&target, bytes).map_err(|error| RpcError::internal(format!("写入临时图片失败：{error}")))?;
    Ok(target)
}

/// 系统 OCR 是否可用（设置页展示"可用 / 不可用"与识别语言）
pub fn status(_app: &App) -> RpcResult {
    match call_worker(json!({ "status": true }), Duration::from_millis(PROBE_TIMEOUT_MS)) {
        Ok(value) => Ok(json!({
            "engine": ENGINE,
            "available": true,
            "languages": value.get("languages").cloned().unwrap_or_else(|| json!([])),
            "active": value.get("active").cloned().unwrap_or(Value::Null),
        })),
        Err(message) => Ok(json!({
            "engine": ENGINE,
            "available": false,
            "languages": [],
            "error": message,
        })),
    }
}

/// 跑一次系统 OCR：`path`（工作区相对路径）或 `imageBase64` 二选一
pub fn run(app: &App, params: &Value) -> RpcResult {
    let base64 = param_str(params, "imageBase64");
    let path_param = param_str(params, "path");
    let (target, temporary) = if !base64.trim().is_empty() {
        let mime = {
            let value = param_str(params, "mime");
            if value.trim().is_empty() { "image/png".to_string() } else { value }
        };
        (write_temp(app, &base64, &mime)?, true)
    } else if !path_param.trim().is_empty() {
        (resolve(app, &path_param)?, false)
    } else {
        return Err(RpcError::invalid("缺少图片内容"));
    };

    let absolute = target
        .to_str()
        .ok_or_else(|| RpcError::invalid("图片路径不是合法 UTF-8"))?
        .to_string();
    let started = Instant::now();
    let outcome = call_worker(json!({ "path": absolute }), Duration::from_millis(TIMEOUT_MS));
    if temporary {
        let _ = std::fs::remove_file(&target);
    }
    let value = outcome.map_err(|message| {
        // 失败也把耗时带上，日志里能区分"超时"和"没装语言包"
        RpcError::internal(format!("{message}（{}ms）", started.elapsed().as_millis()))
    })?;
    Ok(json!({
        "text": value.get("text").and_then(Value::as_str).unwrap_or_default(),
        "engine": ENGINE,
        "ms": started.elapsed().as_millis() as u64,
    }))
}
