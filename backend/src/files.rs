//! 工作区文件操作
//!
//! 所有相对路径统一用 `/` 分隔，Java/前端侧无需关心平台差异。
//! 越界（`..`、绝对路径注入）一律拒绝，保证插件只能操作当前工作区。

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::{now_ms, param_i64, param_opt_str, param_str, App, RpcError, RpcResult};

/// 允许出现在文件树里的扩展名
const TEXT_EXTENSIONS: [&str; 4] = ["md", "markdown", "txt", "mdx"];
/// 允许作为附件打开的图片扩展名
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
/// 遍历时跳过的目录
const SKIP_DIRS: [&str; 9] = [
    ".git",
    ".obsidian",
    ".dbx-note",
    ".trash",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".venv",
];
/// 文件树最大深度，避免超深目录把 UI 拖死
const MAX_DEPTH: usize = 6;

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

/// 默认工作区：插件数据目录下的 workspace/
pub fn default_root(data_dir: &Path) -> PathBuf {
    data_dir.join("workspace")
}

/// 读取自定义工作区，缺失时回退默认目录
pub fn load_root(data_dir: &Path) -> PathBuf {
    let raw = fs::read_to_string(config_path(data_dir)).unwrap_or_default();
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    match parsed.get("root").and_then(Value::as_str) {
        Some(root) if !root.trim().is_empty() => PathBuf::from(root.trim()),
        _ => default_root(data_dir),
    }
}

fn save_root(data_dir: &Path, root: &Path) -> Result<(), RpcError> {
    let payload = json!({ "root": root.to_string_lossy(), "updatedAt": now_ms() });
    fs::write(config_path(data_dir), payload.to_string())?;
    Ok(())
}

/// 当前工作区根目录
fn root_of(app: &App) -> PathBuf {
    app.root.lock().map(|value| value.clone()).unwrap_or_else(|_| default_root(&app.data_dir))
}

/* ---------------- 工作区信息 ---------------- */

pub fn describe_workspace(app: &App) -> RpcResult {
    let root = root_of(app);
    let default = default_root(&app.data_dir);
    let exists = root.exists();
    let writable = probe_writable(&root);
    let mut file_count = 0_i64;
    if exists {
        file_count = WalkDir::new(&root)
            .max_depth(MAX_DEPTH)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file() && is_text_file(entry.path()))
            .count() as i64;
    }

    Ok(json!({
        "dataDir": app.data_dir.to_string_lossy(),
        "root": root.to_string_lossy(),
        "defaultRoot": default.to_string_lossy(),
        "isDefault": same_path(&root, &default),
        "exists": exists,
        "writable": writable,
        "platform": std::env::consts::OS,
        "fileCount": file_count,
    }))
}

fn probe_writable(path: &Path) -> bool {
    if fs::create_dir_all(path).is_err() {
        return false;
    }
    let probe = path.join(".dbx-write-probe");
    let ok = fs::write(&probe, b"1").is_ok();
    let _ = fs::remove_file(probe);
    ok
}

fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |value: &Path| {
        value
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    normalize(left) == normalize(right)
}

pub fn set_workspace(app: &App, params: &Value) -> RpcResult {
    let raw = param_str(params, "path");
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(RpcError::invalid("工作区路径不能为空"));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(RpcError::invalid("请提供绝对路径"));
    }
    fs::create_dir_all(&path)?;
    if !probe_writable(&path) {
        return Err(RpcError::invalid("该目录不可写，请换一个位置"));
    }
    save_root(&app.data_dir, &path)?;
    if let Ok(mut root) = app.root.lock() {
        *root = path;
    }
    describe_workspace(app)
}

pub fn reset_workspace(app: &App) -> RpcResult {
    let default = default_root(&app.data_dir);
    fs::create_dir_all(&default)?;
    save_root(&app.data_dir, &default)?;
    if let Ok(mut root) = app.root.lock() {
        *root = default;
    }
    describe_workspace(app)
}

/* ---------------- 目录浏览（沙箱里拿不到系统选择框，自绘本地面板） ---------------- */

pub fn list_dirs(params: &Value) -> RpcResult {
    let raw = param_str(params, "path");
    let platform = std::env::consts::OS;

    let roots = if platform == "windows" {
        (b'C'..=b'Z')
            .map(|letter| format!("{}:\\", letter as char))
            .filter(|drive| Path::new(drive).exists())
            .map(|drive| json!({ "name": drive, "path": drive }))
            .collect::<Vec<_>>()
    } else {
        vec![json!({ "name": "/", "path": "/" })]
    };

    if raw.trim().is_empty() {
        return Ok(json!({
            "path": "",
            "parent": "",
            "entries": Vec::<Value>::new(),
            "roots": roots,
            "shortcuts": shortcuts(),
        }));
    }

    let path = PathBuf::from(raw.trim());
    let mut entries = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&path) {
        for entry in read_dir.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "$RECYCLE.BIN" || name == "System Volume Information" {
                continue;
            }
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            entries.push(json!({
                "name": name,
                "path": entry.path().to_string_lossy(),
            }));
        }
    }
    entries.sort_by(|left, right| {
        let left = left.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
        let right = right.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
        left.cmp(&right)
    });

    let parent = path.parent().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    let writable = probe_writable(&path);

    Ok(json!({
        "path": path.to_string_lossy(),
        "parent": if parent.is_empty() { String::new() } else { parent },
        "entries": entries,
        "roots": roots,
        "shortcuts": shortcuts(),
        "writable": writable,
    }))
}

fn shortcuts() -> Vec<Value> {
    let home = std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(PathBuf::from))
        .unwrap_or_default();
    let mut items = Vec::new();
    let push = |items: &mut Vec<Value>, key: &str, path: PathBuf| {
        if path.exists() {
            items.push(json!({ "key": key, "path": path.to_string_lossy() }));
        }
    };
    push(&mut items, "home", home.clone());
    push(&mut items, "desktop", home.join("Desktop"));
    push(&mut items, "documents", home.join("Documents"));
    push(&mut items, "downloads", home.join("Downloads"));
    items
}

pub fn make_dir(app: &App, params: &Value) -> RpcResult {
    let parent = param_str(params, "parent");
    let name = param_str(params, "name");
    let name = name.trim();
    validate_name(name)?;
    let parent_path = safe_join(&root_of(app), &parent)?;
    let target = parent_path.join(name);
    fs::create_dir_all(&target)?;
    Ok(json!({ "path": relative_path(&root_of(app), &target) }))
}

/* ---------------- 文件树 ---------------- */

pub fn read_tree(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    fs::create_dir_all(&root)?;
    let depth = param_i64(params, "depth", MAX_DEPTH as i64).clamp(1, MAX_DEPTH as i64) as usize;
    let children = read_children(&root, &root, depth);
    Ok(json!({
        "root": root.to_string_lossy(),
        "children": children,
    }))
}

fn read_children(dir: &Path, root: &Path, depth: usize) -> Vec<Value> {
    if depth == 0 {
        return Vec::new();
    }
    let mut nodes: Vec<Value> = Vec::new();
    let read_dir = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(_) => return nodes,
    };

    for entry in read_dir.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let rel = relative_path(root, &path);

        if file_type.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            nodes.push(json!({
                "kind": "folder",
                "name": name,
                "path": rel,
                "children": read_children(&path, root, depth - 1),
            }));
            continue;
        }

        if !file_type.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let is_text = TEXT_EXTENSIONS.contains(&extension.as_str());
        let is_image = IMAGE_EXTENSIONS.contains(&extension.as_str());
        if !is_text && !is_image {
            continue;
        }
        let meta = entry.metadata().ok();
        nodes.push(json!({
            "kind": if is_image { "image" } else { "file" },
            "name": name,
            "path": rel,
            "size": meta.as_ref().map(|value| value.len()).unwrap_or(0),
            "mtime": meta
                .and_then(|value| value.modified().ok())
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as i64)
                .unwrap_or(0),
            "children": Vec::<Value>::new(),
        }));
    }

    // 目录在前、文件在后，各自按名称自然排序
    nodes.sort_by(|left, right| {
        let left_kind = left.get("kind").and_then(Value::as_str).unwrap_or("");
        let right_kind = right.get("kind").and_then(Value::as_str).unwrap_or("");
        let left_folder = left_kind == "folder";
        let right_folder = right_kind == "folder";
        if left_folder != right_folder {
            return if left_folder { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        let left_name = left.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
        let right_name = right.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
        left_name.cmp(&right_name)
    });

    nodes
}

/* ---------------- 读写 ---------------- */

pub fn read_file(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let path = safe_join(&root, &param_str(params, "path"))?;
    if !path.exists() {
        return Err(RpcError::internal("文件不存在"));
    }
    let bytes = fs::read(&path)?;
    // Markdown 统一按 UTF-8 处理，无法解码时用替换字符，避免整篇打不开
    let content = String::from_utf8_lossy(&bytes).to_string();
    let meta = fs::metadata(&path).ok();
    Ok(json!({
        "content": content,
        "size": bytes.len(),
        "mtime": meta
            .and_then(|value| value.modified().ok())
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as i64)
            .unwrap_or(now_ms()),
    }))
}

pub fn write_file(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let path = safe_join(&root, &param_str(params, "path"))?;
    let content = param_str(params, "content");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // 原子写：先写临时文件再替换，避免崩溃留下半截笔记
    let temp = path.with_extension("tmp-dbxsave");
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&temp, &path)?;

    // 历史版本：只对笔记文件留快照。快照是增强能力，写失败不能影响正常保存。
    let rel = relative_path(&root, &path);
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if TEXT_EXTENSIONS.contains(&extension.as_str()) {
        if let Err(error) = crate::db::history_push(app, &rel, &content, false) {
            crate::logln!("[dbx-note] 历史版本快照写入失败（不影响保存）：path={rel} error={error:?}");
        }
    }
    Ok(json!({ "path": rel, "size": content.len() }))
}

pub fn create_entry(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let kind = param_str(params, "kind");
    let parent = param_str(params, "parent");
    let name = param_str(params, "name");
    let name = name.trim();
    validate_name(name)?;
    let parent_path = safe_join(&root, &parent)?;
    fs::create_dir_all(&parent_path)?;

    if kind == "folder" {
        let target = parent_path.join(name);
        fs::create_dir_all(&target)?;
        return Ok(json!({ "path": relative_path(&root, &target), "kind": "folder" }));
    }

    let file_name = if name.to_lowercase().ends_with(".md") || name.to_lowercase().ends_with(".markdown") {
        name.to_string()
    } else {
        format!("{name}.md")
    };
    let target = parent_path.join(&file_name);
    if target.exists() {
        return Err(RpcError::internal("同名文件已存在"));
    }
    let initial = param_opt_str(params, "content").unwrap_or_default();
    fs::write(&target, initial)?;
    Ok(json!({
        "path": relative_path(&root, &target),
        "kind": "file",
        "name": file_name,
    }))
}

pub fn rename_entry(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let path = safe_join(&root, &param_str(params, "path"))?;
    let new_name = param_str(params, "newName");
    let new_name = new_name.trim();
    validate_name(new_name)?;
    let parent = path.parent().ok_or_else(|| RpcError::invalid("无法重命名根目录"))?;
    let mut target = parent.join(new_name);
    let is_file = path.is_file();
    if is_file && !new_name.to_lowercase().ends_with(".md") && !new_name.to_lowercase().ends_with(".markdown") && !new_name.to_lowercase().ends_with(".txt") {
        target = parent.join(format!("{new_name}.md"));
    }
    if target.exists() && target != path {
        return Err(RpcError::internal("目标名称已存在"));
    }
    fs::rename(&path, &target)?;
    Ok(json!({
        "path": relative_path(&root, &target),
        "name": target.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default(),
    }))
}

pub fn delete_entry(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let path = safe_join(&root, &param_str(params, "path"))?;
    if path == root {
        return Err(RpcError::invalid("不能删除工作区根目录"));
    }
    if !path.exists() {
        return Ok(json!({ "deleted": false }));
    }
    if path.is_dir() {
        fs::remove_dir_all(&path)?;
    } else {
        fs::remove_file(&path)?;
    }
    Ok(json!({ "deleted": true }))
}

pub fn stat_entry(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let path = safe_join(&root, &param_str(params, "path"))?;
    let exists = path.exists();
    let meta = fs::metadata(&path).ok();
    Ok(json!({
        "exists": exists,
        "size": meta.as_ref().map(|value| value.len()).unwrap_or(0),
        "isDir": meta.as_ref().map(|value| value.is_dir()).unwrap_or(false),
    }))
}

/* ---------------- 全文搜索 ---------------- */

pub fn search_files(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let query = param_str(params, "query").trim().to_lowercase();
    let limit = param_i64(params, "limit", 60).clamp(1, 200) as usize;
    if query.is_empty() {
        return Ok(json!({ "items": Vec::<Value>::new() }));
    }

    let mut items = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_map(Result::ok)
    {
        if items.len() >= limit {
            break;
        }
        if !entry.file_type().is_file() || !is_text_file(entry.path()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let name_matches = name.to_lowercase().contains(&query);
        let content = match fs::read(entry.path()) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            Err(_) => continue,
        };
        let content_matches = content.to_lowercase().contains(&query);
        if !name_matches && !content_matches {
            continue;
        }

        let snippet = if content_matches {
            build_snippet(&content, &query)
        } else {
            content.chars().take(80).collect::<String>()
        };

        items.push(json!({
            "path": relative_path(&root, entry.path()),
            "name": name,
            "title": name.trim_end_matches(".md"),
            "snippet": snippet,
            "matchedName": name_matches,
        }));
    }

    Ok(json!({ "items": items }))
}

/// 取命中位置前后各 40 字作为摘要
fn build_snippet(content: &str, query: &str) -> String {
    let lower = content.to_lowercase();
    let index = lower.find(query).unwrap_or(0);
    let chars: Vec<char> = content.chars().collect();
    let char_index = content[..index].chars().count();
    let start = char_index.saturating_sub(30);
    let end = (char_index + query.chars().count() + 60).min(chars.len());
    let text: String = chars[start..end].iter().collect();
    text.replace('\n', " ").trim().to_string()
}

/* ---------------- 图片附件 ---------------- */

/// 读取图片并转成 data URL
///
/// 宿主给插件页面的 CSP 是 `default-src 'none'`，页面拿不到 `file://` 或静态路径，
/// 所以图片内容只能通过 Sidecar 读出来再内联给 `<img>`。
pub fn read_image(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let relative = param_str(params, "path");
    if relative.is_empty() {
        return Err(RpcError::invalid("缺少图片路径"));
    }
    let target = safe_join(&root, &relative)?;
    let extension = target
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(RpcError::invalid("不是受支持的图片格式"));
    }
    let meta = fs::metadata(&target).map_err(|error| RpcError::invalid(format!("读取图片失败：{error}")))?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err(RpcError::invalid("图片超过 20MB 上限"));
    }
    let bytes = fs::read(&target).map_err(|error| RpcError::invalid(format!("读取图片失败：{error}")))?;
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    Ok(json!({
        "path": relative_path(&root, &target),
        "size": meta.len(),
        "mime": mime,
        "dataUrl": format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
    }))
}

/// 保存图片到工作区
///
/// `dir`：相对工作区的目录（默认 `assets`，设置里可改）；
/// `nameMode`：`uuid`（默认）/ `date`（年月日-时分秒）/ `original`（原名 + 短随机后缀）。
pub fn save_image(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let name = param_str(params, "name");
    let data = param_str(params, "dataBase64");
    if data.is_empty() {
        return Err(RpcError::invalid("图片数据为空"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| RpcError::invalid("图片数据不是合法的 base64"))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(RpcError::invalid("图片超过 32MB 上限"));
    }
    let extension = Path::new(&name)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .filter(|value| IMAGE_EXTENSIONS.contains(&value.as_str()))
        .unwrap_or_else(|| "png".to_string());

    // 目录名做白名单化处理，禁止跳出工作区
    let dir = {
        let raw = param_str(params, "dir");
        let trimmed = raw.trim().trim_matches(['/', '\\']);
        let cleaned: String = trimmed
            .chars()
            .map(|ch| if matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { ch })
            .collect();
        if cleaned.split(['/', '\\']).any(|part| part == "..") {
            return Err(RpcError::invalid("图片目录不合法"));
        }
        if cleaned.is_empty() { "assets".to_string() } else { cleaned }
    };

    let name_mode = {
        let value = param_str(params, "nameMode");
        if value.is_empty() { "uuid".to_string() } else { value }
    };
    let stem = {
        let original = Path::new(&name)
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        match name_mode.as_str() {
            "date" => chrono::Local::now().format("%Y%m%d-%H%M%S").to_string(),
            "original" => {
                let base: String = original
                    .chars()
                    .map(|ch| if matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|' | ' ') { '_' } else { ch })
                    .collect();
                let base = if base.is_empty() { "image".to_string() } else { base };
                let suffix: String = uuid::Uuid::new_v4().to_string().chars().take(6).collect();
                format!("{base}-{suffix}")
            }
            _ => uuid::Uuid::new_v4().to_string(),
        }
    };

    let assets = root.join(&dir);
    fs::create_dir_all(&assets)?;
    let file_name = format!("{stem}.{extension}");
    let target = assets.join(&file_name);
    fs::write(&target, &bytes)?;
    let relative = relative_path(&root, &target);
    Ok(json!({
        "path": relative,
        "markdown": format!("![]({relative})"),
    }))
}

/* ---------------- 工具函数 ---------------- */

fn is_text_file(path: &Path) -> bool {
    path.extension()
        .map(|value| TEXT_EXTENSIONS.contains(&value.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

fn validate_name(name: &str) -> Result<(), RpcError> {
    if name.is_empty() {
        return Err(RpcError::invalid("名称不能为空"));
    }
    if name == "." || name == ".." {
        return Err(RpcError::invalid("名称不合法"));
    }
    if name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(RpcError::invalid("名称不能包含 / \\ : * ? \" < > |"));
    }
    if name.chars().count() > 120 {
        return Err(RpcError::invalid("名称过长"));
    }
    Ok(())
}

/// 把相对路径拼到根目录，并阻断路径穿越
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, RpcError> {
    let mut result = root.to_path_buf();
    for part in relative.split(['/', '\\']).filter(|part| !part.is_empty()) {
        if part == "." || part == ".." {
            return Err(RpcError::invalid("路径不合法"));
        }
        result.push(part);
    }
    if !path_within(root, &result) {
        return Err(RpcError::invalid("路径超出工作区范围"));
    }
    Ok(result)
}

/// 判断 target 是否位于 root 之内（对已存在部分做 canonicalize）
fn path_within(root: &Path, target: &Path) -> bool {
    let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut probe = target.to_path_buf();
    loop {
        if probe.exists() {
            let real = fs::canonicalize(&probe).unwrap_or_else(|_| probe.clone());
            return real.starts_with(&root_real);
        }
        match probe.parent() {
            Some(parent) => probe = parent.to_path_buf(),
            None => return false,
        }
    }
}

/// 绝对路径转工作区相对路径（`/` 分隔）
pub fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}
