//! Sidecar 日志
//!
//! 宿主把 Sidecar 的 stderr 收在自己的日志里，用户基本找不到；出现「截图没反应 /
//! 宿主没前置」这类问题时无从排查。这里在数据目录下再落一份可读日志：
//!
//! `<数据目录>/logs/sidecar.log`（超过 1 MB 轮转一份 `sidecar.log.1`）
//!
//! 设置页「关于」里可以直接看最近若干行、复制或打开所在目录。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::{RpcError, RpcResult};

/// 单文件上限，超了就在启动时轮转一次（只留一代，不无限增长）
const MAX_BYTES: u64 = 1_048_576;
/// 读尾部时最多读这么多字节，避免把整份日志读进内存
const TAIL_WINDOW: u64 = 262_144;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
/// 串行写：截图线程、RPC 线程都会写，避免半行交错
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 在数据目录下初始化日志文件（失败就静默降级：只走 stderr）
pub fn init(data_dir: &Path) {
    let dir = data_dir.join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("sidecar.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let archived = dir.join("sidecar.log.1");
            let _ = std::fs::remove_file(&archived);
            let _ = std::fs::rename(&path, &archived);
        }
    }
    let _ = LOG_PATH.set(path);
    write(&format!(
        "[dbx-note] Sidecar 启动 · pid={} · version={}",
        std::process::id(),
        crate::PLUGIN_VERSION
    ));
}

fn path() -> Option<&'static PathBuf> {
    LOG_PATH.get()
}

/// 追加一行（带时间戳）。stderr 由调用方（`crate::logln!`）负责
pub fn write(line: &str) {
    let Some(path) = path() else { return };
    let Ok(_guard) = WRITE_LOCK.lock() else { return };
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{stamp} {line}");
    }
}

/// `log/info`：日志文件路径与体积（设置页展示）
pub fn info() -> RpcResult {
    let Some(path) = path() else {
        return Ok(json!({ "path": Value::Null, "exists": false, "size": 0 }));
    };
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    Ok(json!({
        "path": path.to_string_lossy(),
        "exists": path.exists(),
        "size": size,
    }))
}

/// `log/tail`：最近 N 行（`lines` 默认 200，上限 2000）
pub fn tail(params: &Value) -> RpcResult {
    let lines = params
        .get("lines")
        .and_then(|value| value.as_u64())
        .unwrap_or(200)
        .clamp(1, 2000) as usize;
    let Some(path) = path() else {
        return Ok(json!({ "path": Value::Null, "text": "", "lines": 0 }));
    };
    let text = read_tail(path, lines).map_err(|error| RpcError::internal(format!("读取日志失败：{error}")))?;
    let count = text.lines().count();
    Ok(json!({
        "path": path.to_string_lossy(),
        "text": text,
        "lines": count,
    }))
}

/// 只读文件末尾一段再切行：日志轮转前最大 1 MB，整读也不慢，但没必要
fn read_tail(path: &Path, lines: usize) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_WINDOW);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf)?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    // 从中间截断时第一行可能不完整，丢掉
    if start > 0 {
        if let Some(index) = text.find('\n') {
            text = text[index + 1..].to_string();
        }
    }
    let all: Vec<&str> = text.lines().collect();
    let skip = all.len().saturating_sub(lines);
    Ok(all[skip..].join("\n"))
}

/// `log/write`：让插件页面把自己的关键节点也写进同一份日志
///
/// 「全局截图没弹工具栏」这类问题，卡点常常在页面侧（面板不可见 / 轮询没跑 / 浮层没开），
/// 光看 Sidecar 日志只能看到「图已经交出去了」。页面侧通过这里补一行，两边就对得上了。
pub fn write_from_ui(params: &Value) -> RpcResult {
    let line = params
        .get("line")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if line.is_empty() {
        return Err(RpcError::invalid("line 不能为空"));
    }
    // 单行化 + 截断，避免页面把多行 / 超长内容灌进来
    let flat: String = line.replace(['\r', '\n'], " ").chars().take(400).collect();
    let text = format!("[ui] {flat}");
    crate::logln!("{text}");
    Ok(json!({ "ok": true }))
}

/// `log/open`：在资源管理器里打开日志所在目录
pub fn open_dir() -> RpcResult {
    let Some(path) = path() else {
        return Err(RpcError::internal("日志尚未初始化"));
    };
    let dir = path.parent().unwrap_or(path);
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|error| RpcError::internal(format!("打开目录失败：{error}")))?;
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
    }
    Ok(json!({ "ok": true, "dir": dir.to_string_lossy() }))
}
