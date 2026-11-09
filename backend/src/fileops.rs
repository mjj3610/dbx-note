//! 文件树「更多操作」与右键菜单的后端能力
//!
//! 对齐参考项目 `file-more-menu.tsx` / `file-item.tsx` 的动作：
//! - 复制 / 创建副本 / 剪切粘贴（`fs/copy`、`fs/move`）
//! - 查看目录（`fs/reveal`，在系统文件管理器里选中）
//! - 导入笔记 / 导入为 Markdown / 导入 Notion zip（`fs/import`，前端解包后批量写盘）
//! - 从模板新建笔记（`fs/templates`）
//! - 知识库索引状态 / 全量重建 / 单篇更新 / 导出 / 导入（`kb/*`）
//!
//! 参考项目的知识库是向量数据库；本项目是「本地优先 + 全文检索」，等价映射成
//! 工作区 `.dbx-note/kb-index.json` 里的笔记索引快照（路径 / 标题 / 摘要 / 字数 / 时间）。
//! 索引随工作区一起被云同步带走，所以「上传 / 下载知识库」落地为导出 / 导入这份快照。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::{files, now_ms, param_str, App, RpcError, RpcResult};

/// 单次导入最多文件数，避免一次 RPC 塞进整棵目录树
const MAX_IMPORT_FILES: usize = 500;
/// 单个导入文件最大正文（8 MiB）
const MAX_IMPORT_BYTES: usize = 8 * 1024 * 1024;
/// 索引文件位置（工作区内，会随云同步一起走）
const KB_DIR: &str = ".dbx-note";
const KB_FILE: &str = "kb-index.json";
/// 索引扫描时跳过的目录（与 `files::read_children` 的白名单保持一致）
const SKIP_DIRS: [&str; 8] = [
    ".git", ".obsidian", ".dbx-note", ".trash", "node_modules", "target", "dist", ".next",
];
const TEXT_EXTENSIONS: [&str; 4] = ["md", "markdown", "txt", "mdx"];
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

fn root_of(app: &App) -> PathBuf {
    crate::sync::root_of(app)
}

fn is_text_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    TEXT_EXTENSIONS.contains(&ext.as_str())
}

fn is_image_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    IMAGE_EXTENSIONS.contains(&ext.as_str())
}

/// 目录名 / 文件名里不允许的字符（与 `files::validate_name` 一致）
fn safe_segment(name: &str) -> String {
    name.chars()
        .filter(|ch| !matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0') && !ch.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// 把导入项的名字规范成工作区内相对路径：逐段过滤，丢掉 `.` / `..` 与盘符
fn safe_import_path(raw: &str) -> String {
    raw.replace('\\', "/")
        .split('/')
        .filter_map(|part| {
            let clean = safe_segment(part);
            if clean.is_empty() || clean == "." || clean == ".." {
                None
            } else {
                Some(clean)
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// 在目标目录里找一个不冲突的名字；`suffix` 用于「创建副本」
fn unique_path(dir: &Path, stem: &str, extension: &str, suffix: &str) -> PathBuf {
    for index in 0..1000 {
        let label = if index == 0 {
            format!("{stem}{suffix}")
        } else {
            format!("{stem}{suffix} {index}")
        };
        let name = if extension.is_empty() {
            label
        } else {
            format!("{label}.{extension}")
        };
        let candidate = dir.join(&name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}{suffix}-{}", now_ms()))
}

fn split_name(path: &Path) -> (String, String) {
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    (stem, ext)
}

/// 递归复制目录（跳过顶层 `.dbx-note` / `.git` 这类内部目录）
fn copy_dir(from: &Path, to: &Path) -> Result<(), RpcError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// `fs/copy`：复制文件 / 目录；`duplicate=true` 时自动生成「副本」名
///
/// @param params `{ from, toDir?, duplicate? }`
/// @return `{ path, name }`
pub fn copy_entry(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let from = param_str(params, "from");
    let source = files::safe_join(&root, &from)?;
    if source == root || !source.exists() {
        return Err(RpcError::invalid("源条目不存在"));
    }
    let duplicate = params.get("duplicate").and_then(Value::as_bool).unwrap_or(false);
    let to_dir_rel = param_str(params, "toDir");
    let parent_rel = from.rsplit_once('/').map(|(value, _)| value).unwrap_or("");
    let dir_rel = if to_dir_rel.is_empty() { parent_rel } else { to_dir_rel.as_str() };
    let dir = files::safe_join(&root, dir_rel)?;
    fs::create_dir_all(&dir)?;

    let is_dir = source.is_dir();
    let original_name = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    // 目录名里的点不属于扩展名，整体作为 stem；文件才拆主名与后缀
    let (stem, copy_ext) = if is_dir {
        (original_name.clone(), String::new())
    } else {
        let (stem, ext) = split_name(&source);
        (stem, ext)
    };
    let copy_ext = copy_ext.as_str();
    let original = dir.join(&original_name);
    // 「创建副本」一定带后缀；普通粘贴在目标目录无同名文件时保留原名，冲突才退让
    let target = if duplicate || original == source {
        // 粘贴回原目录等价于「创建副本」，不能尝试复制成自己
        unique_path(&dir, &stem, copy_ext, " 副本")
    } else if !original.exists() {
        original
    } else {
        unique_path(&dir, &stem, copy_ext, " 副本")
    };
    if target == source {
        return Err(RpcError::invalid("目标与源条目相同"));
    }
    if source.is_dir() {
        copy_dir(&source, &target)?;
    } else {
        fs::copy(&source, &target)?;
    }
    Ok(json!({
        "path": files::relative_path(&root, &target),
        "name": target.file_name().map(|v| v.to_string_lossy().to_string()).unwrap_or_default(),
    }))
}

/// `fs/move`：剪切后粘贴到目标目录
///
/// @param params `{ from, toDir }`；目标目录必须是工作区内的目录
pub fn move_entry(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let from = param_str(params, "from");
    let source = files::safe_join(&root, &from)?;
    if source == root || !source.exists() {
        return Err(RpcError::invalid("源条目不存在"));
    }
    let dir = files::safe_join(&root, &param_str(params, "toDir"))?;
    if !dir.is_dir() {
        return Err(RpcError::invalid("目标目录不存在"));
    }
    // 不允许把目录搬进自己
    if source.is_dir() && dir.starts_with(&source) {
        return Err(RpcError::invalid("不能把目录移动到自身内部"));
    }
    let name = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut target = dir.join(&name);
    if target.exists() {
        let (stem, ext) = if source.is_dir() {
            (name.clone(), String::new())
        } else {
            split_name(&source)
        };
        target = unique_path(&dir, &stem, &ext, " 副本");
    }
    fs::rename(&source, &target)?;
    Ok(json!({
        "path": files::relative_path(&root, &target),
        "name": target.file_name().map(|v| v.to_string_lossy().to_string()).unwrap_or_default(),
    }))
}

/// `fs/reveal`：在系统文件管理器里选中该条目
pub fn reveal_entry(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let path = files::safe_join(&root, &param_str(params, "path"))?;
    if !path.exists() {
        return Err(RpcError::invalid("条目不存在"));
    }
    #[cfg(windows)]
    {
        let native = path.to_string_lossy().replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(format!("/select,{native}"))
            .spawn()
            .map_err(|error| RpcError::internal(format!("打开文件管理器失败：{error}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|error| RpcError::internal(format!("打开 Finder 失败：{error}")))?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let dir = if path.is_dir() { path.clone() } else { path.parent().unwrap_or(&root).to_path_buf() };
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|error| RpcError::internal(format!("打开目录失败：{error}")))?;
    }
    Ok(json!({ "ok": true, "path": files::relative_path(&root, &path) }))
}

/// `fs/import`：批量写盘（前端负责解包 / 转码 / 转 Markdown）
///
/// @param params `{ target, files: [{ name, content?, contentBase64? }], overwrite? }`
pub fn import_entries(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let target_dir = files::safe_join(&root, &param_str(params, "target"))?;
    fs::create_dir_all(&target_dir)?;
    let list = params.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    if list.len() > MAX_IMPORT_FILES {
        return Err(RpcError::invalid("一次最多导入 500 个文件"));
    }
    let overwrite = params.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut paths: Vec<String> = Vec::new();
    for item in list {
        let name = safe_import_path(item.get("name").and_then(Value::as_str).unwrap_or_default());
        if name.is_empty() || (!is_text_file(Path::new(&name)) && !is_image_file(Path::new(&name))) {
            skipped += 1;
            continue;
        }
        let dest = files::safe_join(&target_dir, &name)?;
        if dest.exists() && !overwrite {
            skipped += 1;
            continue;
        }
        let bytes: Vec<u8> = if let Some(text) = item.get("content").and_then(Value::as_str) {
            if text.len() > MAX_IMPORT_BYTES {
                skipped += 1;
                continue;
            }
            text.as_bytes().to_vec()
        } else if let Some(encoded) = item.get("contentBase64").and_then(Value::as_str) {
            use base64::Engine;
            match base64::engine::general_purpose::STANDARD.decode(encoded) {
                Ok(value) if value.len() <= MAX_IMPORT_BYTES => value,
                _ => {
                    skipped += 1;
                    continue;
                }
            }
        } else {
            skipped += 1;
            continue;
        };
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&dest, &bytes)?;
        imported += 1;
        paths.push(files::relative_path(&root, &dest));
    }
    Ok(json!({ "imported": imported, "skipped": skipped, "paths": paths }))
}

/// `fs/templates`：工作区 `templates/` 下的 Markdown 模板
pub fn list_templates(app: &App) -> RpcResult {
    let root = root_of(app);
    let dir = files::safe_join(&root, "templates")?;
    let mut items: Vec<Value> = Vec::new();
    if dir.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&dir)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && is_text_file(path))
            .collect();
        entries.sort();
        for path in entries {
            let content = fs::read_to_string(&path).unwrap_or_default();
            items.push(json!({
                "name": path.file_stem().map(|v| v.to_string_lossy().to_string()).unwrap_or_default(),
                "path": files::relative_path(&root, &path),
                "content": content,
            }));
        }
    }
    Ok(json!({ "items": items }))
}

/* ---------------- 知识库索引 ---------------- */

fn kb_path(root: &Path) -> PathBuf {
    root.join(KB_DIR).join(KB_FILE)
}

fn read_kb(root: &Path) -> Value {
    fs::read_to_string(kb_path(root))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({ "version": 1, "updatedAt": 0, "docs": [] }))
}

fn write_kb(root: &Path, docs: &[Value]) -> Result<Value, RpcError> {
    let payload = json!({ "version": 1, "updatedAt": now_ms(), "docs": docs });
    let path = kb_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default())?;
    Ok(payload)
}

fn doc_of(root: &Path, path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    let title = content
        .lines()
        .find(|line| line.trim_start().starts_with('#'))
        .map(|line| line.trim_start().trim_start_matches('#').trim().to_string())
        .unwrap_or_default();
    let summary: String = content
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect();
    let mtime = fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    Some(json!({
        "path": files::relative_path(root, path),
        "title": title,
        "summary": summary,
        "chars": content.chars().count(),
        "mtime": mtime,
    }))
}

fn scan_docs(root: &Path) -> Vec<Value> {
    let mut docs: Vec<Value> = WalkDir::new(root)
        .max_depth(6)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            let text: &str = &name;
            !text.starts_with('.') && !SKIP_DIRS.contains(&text)
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_text_file(entry.path()))
        .filter_map(|entry| doc_of(root, entry.path()))
        .collect();
    docs.sort_by(|left, right| {
        left.get("path").and_then(Value::as_str).unwrap_or("")
            .cmp(right.get("path").and_then(Value::as_str).unwrap_or(""))
    });
    docs
}

/// `kb/status`：索引条目数与已收录路径（文件树「显示知识库状态」用）
pub fn kb_status(app: &App) -> RpcResult {
    let root = root_of(app);
    let data = read_kb(&root);
    let docs = data.get("docs").and_then(Value::as_array).cloned().unwrap_or_default();
    let paths: Vec<String> = docs
        .iter()
        .filter_map(|item| item.get("path").and_then(Value::as_str).map(str::to_string))
        .collect();
    Ok(json!({
        "count": docs.len(),
        "paths": paths,
        "updatedAt": data.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
    }))
}

/// `kb/reindex`：全量重建索引（「全部重新计算」）
pub fn kb_reindex(app: &App) -> RpcResult {
    let root = root_of(app);
    let docs = scan_docs(&root);
    let count = docs.len();
    write_kb(&root, &docs)?;
    Ok(json!({ "count": count, "updatedAt": now_ms() }))
}

/// `kb/upsert`：单篇笔记保存后增量更新（「自动更新知识库」开启时前端调用）
pub fn kb_upsert(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let rel = param_str(params, "path");
    let path = files::safe_join(&root, &rel)?;
    if rel.is_empty() || path.is_dir() || !is_text_file(&path) {
        return Err(RpcError::invalid("只能更新笔记文件的知识库索引"));
    }
    let data = read_kb(&root);
    let mut docs = data.get("docs").and_then(Value::as_array).cloned().unwrap_or_default();
    docs.retain(|item| item.get("path").and_then(Value::as_str) != Some(rel.as_str()));
    if let Some(doc) = doc_of(&root, &path) {
        docs.push(doc);
    }
    let count = docs.len();
    write_kb(&root, &docs)?;
    Ok(json!({ "count": count }))
}

/// `kb/data`：取完整索引 JSON，供「上传知识库」另存为
pub fn kb_export(app: &App) -> RpcResult {
    let root = root_of(app);
    Ok(json!({ "json": serde_json::to_string_pretty(&read_kb(&root)).unwrap_or_default() }))
}

/// `kb/import`：从用户选的快照文件恢复索引（「下载知识库」）
pub fn kb_import(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let raw = param_str(params, "json");
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|_| RpcError::invalid("知识库快照不是合法 JSON"))?;
    let docs = parsed
        .get("docs")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| RpcError::invalid("知识库快照缺少 docs 字段"))?;
    if docs.len() > 10_000 {
        return Err(RpcError::invalid("知识库快照过大"));
    }
    let count = docs.len();
    write_kb(&root, &docs)?;
    Ok(json!({ "count": count }))
}
