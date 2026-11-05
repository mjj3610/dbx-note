//! 画布存储
//!
//! 画布（流程图 / 思维导图 / 白板）是结构化文档，不放进 Markdown 文件树，
//! 统一落在工作区 `canvases/*.canvas.json`，一棵工作区带一份画布集：
//!
//! - 前端只传相对路径与整篇 JSON 文本，Sidecar 负责安全写入（原子写）与列表汇总；
//! - JSON 结构由前端定义（version / title / nodes / edges），后端只解析 title 与 updatedAt 做列表展示。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::files::{relative_path, safe_join};
use crate::{param_str, App, RpcError, RpcResult};

/// 画布目录（相对工作区）
const CANVAS_DIR: &str = "canvases";
/// 画布文件后缀
const CANVAS_EXT: &str = ".canvas.json";

fn root_of(app: &App) -> PathBuf {
    app.root
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| app.data_dir.join("workspace"))
}

fn canvas_root(app: &App) -> PathBuf {
    root_of(app).join(CANVAS_DIR)
}

/// 把用户输入的名称收敛成安全的文件名（保留中文，去掉路径与非法字符）
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => ch,
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', ' ', '-']).to_string();
    if trimmed.is_empty() {
        "未命名画布".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

/// 相对路径必须是 canvases/ 下的 .canvas.json，防止越权读写工作区其它文件
fn resolve(app: &App, path: &str) -> Result<PathBuf, RpcError> {
    let root = root_of(app);
    let target = safe_join(&root, path)?;
    let base = canvas_root(app);
    if !target.starts_with(&base) || !target.to_string_lossy().ends_with(CANVAS_EXT) {
        return Err(RpcError::invalid("画布路径不合法"));
    }
    Ok(target)
}

fn read_meta(path: &Path) -> (String, i64, usize) {
    let stem = path
        .file_name()
        .map(|value| value.to_string_lossy().trim_end_matches(CANVAS_EXT).to_string())
        .unwrap_or_default();
    let text = fs::read_to_string(path).unwrap_or_default();
    let parsed: Option<Value> = serde_json::from_str(&text).ok();
    let title = parsed
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(stem);
    let updated_at = parsed
        .as_ref()
        .and_then(|value| value.get("updatedAt"))
        .and_then(Value::as_i64)
        .or_else(|| {
            fs::metadata(path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
        })
        .unwrap_or(0);
    (title, updated_at, text.len())
}

/// 列出工作区全部画布
pub fn list(app: &App) -> RpcResult {
    let dir = canvas_root(app);
    let root = root_of(app);
    let mut items: Vec<Value> = Vec::new();
    if dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if !path.is_file() || !path.to_string_lossy().ends_with(CANVAS_EXT) {
                    continue;
                }
                let (title, updated_at, size) = read_meta(&path);
                items.push(json!({
                    "title": title,
                    "path": relative_path(&root, &path),
                    "size": size,
                    "updatedAt": updated_at,
                }));
            }
        }
    }
    items.sort_by(|left, right| {
        let left_at = left.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
        let right_at = right.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
        right_at.cmp(&left_at)
    });
    Ok(json!({ "items": items }))
}

/// 读取一份画布
pub fn read(app: &App, params: &Value) -> RpcResult {
    let target = resolve(app, &param_str(params, "path"))?;
    if !target.is_file() {
        return Err(RpcError::internal("画布不存在"));
    }
    let content = fs::read_to_string(&target)?;
    Ok(json!({ "path": param_str(params, "path"), "content": content }))
}

/// 新建画布，返回相对路径（同名自动加序号）
pub fn create(app: &App, params: &Value) -> RpcResult {
    let name = sanitize_name(&param_str(params, "name"));
    let dir = canvas_root(app);
    fs::create_dir_all(&dir)?;
    let mut index = 1;
    let mut file_name = format!("{name}{CANVAS_EXT}");
    while dir.join(&file_name).exists() {
        index += 1;
        file_name = format!("{name}-{index}{CANVAS_EXT}");
    }
    let target = dir.join(&file_name);
    let now = now_ms();
    let title = file_name.trim_end_matches(CANVAS_EXT).to_string();
    let document = json!({
        "version": 1,
        "title": title,
        "nodes": [],
        "edges": [],
        "updatedAt": now,
    });
    let pretty = serde_json::to_string_pretty(&document)
        .map_err(|_| RpcError::internal("画布序列化失败"))?;
    fs::write(&target, pretty)?;
    let root = root_of(app);
    Ok(json!({
        "path": relative_path(&root, &target),
        "title": title,
        "content": document.to_string(),
    }))
}

/// 保存画布（整篇覆盖，原子写）
pub fn save(app: &App, params: &Value) -> RpcResult {
    let target = resolve(app, &param_str(params, "path"))?;
    let content = param_str(params, "content");
    // 校验是合法 JSON，避免前端 bug 把画布写坏
    let parsed: Value = serde_json::from_str(&content).map_err(|_| RpcError::invalid("画布内容不是合法 JSON"))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = target.with_extension("tmp-dbxsave");
    fs::write(&temp, content.as_bytes())?;
    fs::rename(&temp, &target)?;
    let title = parsed
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    Ok(json!({ "ok": true, "title": title, "size": content.len() }))
}

/// 重命名画布（改文件名，标题同步写回 JSON）
pub fn rename(app: &App, params: &Value) -> RpcResult {
    let target = resolve(app, &param_str(params, "path"))?;
    let next_name = sanitize_name(&param_str(params, "name"));
    let dir = target.parent().ok_or_else(|| RpcError::internal("画布路径异常"))?;
    let next = dir.join(format!("{next_name}{CANVAS_EXT}"));
    if next.exists() && next != target {
        return Err(RpcError::internal("同名画布已存在"));
    }
    fs::rename(&target, &next)?;
    if let Ok(text) = fs::read_to_string(&next) {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(&text) {
            parsed["title"] = Value::String(next_name.clone());
            let _ = fs::write(&next, serde_json::to_string_pretty(&parsed).unwrap_or(text));
        }
    }
    let root = root_of(app);
    Ok(json!({ "path": relative_path(&root, &next), "title": next_name }))
}

/// 删除画布
pub fn delete(app: &App, params: &Value) -> RpcResult {
    let target = resolve(app, &param_str(params, "path"))?;
    if target.exists() {
        fs::remove_file(&target)?;
    }
    Ok(json!({ "ok": true }))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
