//! 对象存储 / WebDAV / 自托管同步通道
//!
//! NoteGen 的「同步平台」除了 GitHub / GitLab / Gitee / Gitea 这些 Git 托管，
//! 还有 S3 兼容对象存储、WebDAV 与自托管服务。它们不是版本控制，而是
//! **文件镜像 + 清单**，所以这里单独实现一条通道，与 `sync.rs` 的 git 通道并存。
//!
//! 远端布局（`<prefix>` 默认 `dbx-note`）：
//!
//! ```text
//! <prefix>/manifest.json          所有文件的 size / mtime / hash
//! <prefix>/files/<相对路径>        工作区文件本体
//! ```
//!
//! 本地另有一份 `<工作区>/.dbx-note/sync-state.json`，记录「上一次同步成功时的 hash」，
//! 用来判断某个文件是「本地改的」「远端改的」还是「两边都改」：
//!
//! - 本地没动过（hash == 基线）→ 拉取远端覆盖；
//! - 远端没动过（远端 hash == 基线）→ 保留本地，上报冲突；
//! - 两边都动过 → 保留本地，上报冲突（下次 push 以本地为准）。
//!
//! 这样重复执行 push / pull 是幂等的，且不会静默丢内容。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use walkdir::WalkDir;

use crate::imagehost::{
    basic_auth, client, field, field_or, join_url, s3_object_url, s3_signed_headers, trim_slashes,
    truncate, urlencode_path,
};
use crate::{sync, App, RpcError, RpcResult};

/// 同步支持的非 Git 平台
const STORE_PROVIDERS: [&str; 3] = ["s3", "webdav", "selfHosted"];
/// 跳过遍历的目录（与 files.rs 的 SKIP_DIRS 保持一致，另加同步状态目录）
const SKIP_DIRS: [&str; 10] = [
    ".git",
    ".obsidian",
    ".dbx-note",
    ".trash",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".venv",
    "cache",
];
/// 本地状态文件（相对工作区）
const STATE_PATH: &str = ".dbx-note/sync-state.json";
/// 清单版本
const MANIFEST_VERSION: i64 = 1;
/// 单次扫描的文件数上限，防止超大工作区把设置页拖住
const MAX_FILES: usize = 4000;
/// 超过这个体积的文件不做全文 hash，退化成 `s:size:mtime` 形式比较
const HASH_LIMIT: u64 = 8 * 1024 * 1024;
/// 单个文件硬上限，超过直接跳过（不会尝试上传）
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
/// 同步日志（最近 100 条）存这里，与 NoteGen 的 sync_logs 同构
const LOGS_KEY: &str = "app.sync.logs";
/// 日志最多保留条数
const LOG_LIMIT: usize = 100;
/// 同步偏好（与平台无关，所有平台共用一份）
const PREFS_KEY: &str = "app.sync.prefs";

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::invalid(message.into())
}

fn internal(message: impl Into<String>) -> RpcError {
    RpcError::internal(message.into())
}

/* ---------------- 配置 ---------------- */

/// 三条通道的默认配置
pub fn default_store_config() -> Value {
    json!({
        "s3": {
            "preset": "custom",
            "endpoint": "",
            "region": "us-east-1",
            "bucket": "",
            "accessKeyId": "",
            "secretAccessKey": "",
            "addressingStyle": "path",
            "pathPrefix": "dbx-note",
        },
        "webdav": {
            "baseUrl": "",
            "username": "",
            "password": "",
            "pathPrefix": "dbx-note",
        },
        "selfHosted": {
            "baseUrl": "",
            "token": "",
            "pathPrefix": "dbx-note",
        },
    })
}

/// 每个平台的密钥字段名
fn secret_field(provider: &str) -> Option<&'static str> {
    match provider {
        "s3" => Some("secretAccessKey"),
        "webdav" => Some("password"),
        "selfHosted" => Some("token"),
        _ => None,
    }
}

/// 把密钥换成掩码后回传（前端永远拿不到明文）
pub fn mask_store(options: &mut Value) {
    let mut store = options.get("store").cloned().unwrap_or_else(default_store_config);
    for provider in STORE_PROVIDERS {
        let Some(key) = secret_field(provider) else { continue };
        let node = store.get_mut(provider).and_then(Value::as_object_mut);
        let Some(node) = node else { continue };
        let secret = node.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        node.insert(format!("has{}", capitalize(key)), json!(!secret.is_empty()));
        node.insert(
            format!("{}Mask", key),
            json!(if secret.is_empty() {
                String::new()
            } else {
                let chars: Vec<char> = secret.chars().collect();
                let head: String = chars.iter().take(4).collect();
                let tail: String = chars.iter().skip(chars.len().saturating_sub(2)).collect();
                format!("{head}••••{tail}")
            }),
        );
        node.insert(key.to_string(), json!(""));
    }
    options["store"] = store;
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// 合并前端传来的 store 配置；密钥留空表示「保持原样」
pub fn merge_store(current: &mut Value, patch: &Value) {
    if !current.get("store").map(Value::is_object).unwrap_or(false) {
        current["store"] = default_store_config();
    }
    let Some(incoming) = patch.as_object() else { return };
    for (provider, fields) in incoming {
        if !STORE_PROVIDERS.contains(&provider.as_str()) {
            continue;
        }
        let Some(fields) = fields.as_object() else { continue };
        let target = current["store"]
            .as_object_mut()
            .map(|store| {
                store
                    .entry(provider.clone())
                    .or_insert_with(|| default_store_config()[provider].clone())
            });
        let Some(target) = target else { continue };
        let clear = fields
            .get("clearSecret")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let secret = secret_field(provider);
        for (key, value) in fields {
            // 掩码字段只用于回显，不落库
            if key.starts_with("has") || key.ends_with("Mask") || key == "clearSecret" {
                continue;
            }
            let is_secret = secret.map(|name| name == key).unwrap_or(false);
            if is_secret {
                if clear {
                    target[key] = json!("");
                    continue;
                }
                let text = value.as_str().unwrap_or_default().trim().to_string();
                if !text.is_empty() {
                    target[key] = json!(text);
                }
                continue;
            }
            target[key] = value.clone();
        }
    }
}

/// 冲突策略：local 保留本地 / remote 用远端覆盖 / skip 跳过并记录
fn conflict_policy(options: &Value) -> String {
    match options.get("conflictPolicy").and_then(Value::as_str) {
        Some("remote") => "remote".to_string(),
        Some("skip") => "skip".to_string(),
        _ => "local".to_string(),
    }
}

/// 自动同步间隔（秒）：`disabled` 或 2/3/5/10/20/30/60/120，与 NoteGen 的选项集一致
const AUTO_SYNC_VALUES: [&str; 9] = ["disabled", "2", "3", "5", "10", "20", "30", "60", "120"];

/// 读同步偏好（设置表 `app.sync.prefs`）
fn load_prefs(app: &App) -> Value {
    let Ok(conn) = app.db.lock() else { return json!({}) };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?",
            rusqlite::params![PREFS_KEY],
            |row| row.get(0),
        )
        .ok();
    raw.and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// 写同步偏好：只覆盖传入的键
fn write_prefs(app: &App, patch: &Map<String, Value>) -> RpcResult {
    let mut current = load_prefs(app);
    if !current.is_object() {
        current = json!({});
    }
    if let Some(target) = current.as_object_mut() {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
    let conn = app.db.lock().map_err(|_| internal("数据库繁忙"))?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![PREFS_KEY, current.to_string(), now_ms()],
    )?;
    Ok(json!({ "ok": true }))
}

/// 优先取偏好，取不到再退回旧的存储平台配置（升级兼容）
fn pref_or(prefs: &Value, options: &Value, key: &str) -> Option<Value> {
    prefs.get(key).cloned().or_else(|| options.get(key).cloned())
}

fn auto_sync(prefs: &Value, options: &Value) -> String {
    if let Some(value) = pref_or(prefs, options, "autoSync") {
        let text = match value.as_str() {
            Some(text) => text.to_string(),
            None => value.to_string(),
        };
        if AUTO_SYNC_VALUES.contains(&text.as_str()) {
            return text;
        }
        if text == "0" || text == "off" || text == "false" {
            return "disabled".to_string();
        }
    }
    // 兼容早期版本只存 autoUpload 布尔值
    match options.get("autoUpload").and_then(Value::as_bool) {
        Some(false) => "disabled".to_string(),
        _ => "5".to_string(),
    }
}

/// 布尔开关，缺省值按 NoteGen 的默认（都开）
fn flag(prefs: &Value, options: &Value, key: &str, default: bool) -> bool {
    pref_or(prefs, options, key)
        .and_then(|value| value.as_bool())
        .unwrap_or(default)
}

/// 追加一条同步日志（写入 settings 表，最多保留 100 条）
fn append_log(app: &App, entry: Value) {
    let Ok(conn) = app.db.lock() else { return };
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?",
            rusqlite::params![LOGS_KEY],
            |row| row.get(0),
        )
        .ok();
    let mut logs: Vec<Value> = existing
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    logs.insert(0, entry);
    logs.truncate(LOG_LIMIT);
    let payload = Value::Array(logs).to_string();
    let _ = conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![LOGS_KEY, payload, now_ms()],
    );
}

/// `sync/storeLogs`：同步历史（新的在前）
pub fn logs(app: &App) -> RpcResult {
    let conn = app.db.lock().map_err(|_| internal("数据库繁忙"))?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?",
            rusqlite::params![LOGS_KEY],
            |row| row.get(0),
        )
        .ok();
    let items: Vec<Value> = raw
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    Ok(json!({ "items": items }))
}

fn store_provider(options: &Value) -> String {
    options
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("github")
        .to_string()
}

fn provider_config(options: &Value, provider: &str) -> Value {
    options
        .get("store")
        .and_then(|store| store.get(provider))
        .cloned()
        .unwrap_or_else(|| default_store_config()[provider].clone())
}

/* ---------------- HTTP 传输层 ---------------- */

enum Transport {
    S3 {
        config: Value,
        prefix: String,
    },
    WebDav {
        base: String,
        auth: Option<String>,
        prefix: String,
        /// 已经 MKCOL 过的目录，避免每个文件都重复建目录
        created: Mutex<HashSet<String>>,
    },
    SelfHosted {
        base: String,
        token: String,
        prefix: String,
    },
}

impl Transport {
    fn provider(&self) -> &'static str {
        match self {
            Transport::S3 { .. } => "s3",
            Transport::WebDav { .. } => "webdav",
            Transport::SelfHosted { .. } => "selfHosted",
        }
    }

    fn prefix(&self) -> &str {
        match self {
            Transport::S3 { prefix, .. } => prefix,
            Transport::WebDav { prefix, .. } => prefix,
            Transport::SelfHosted { prefix, .. } => prefix,
        }
    }

    fn manifest_key(&self) -> String {
        format!("{}/manifest.json", self.prefix())
    }

    fn file_key(&self, rel: &str) -> String {
        format!("{}/files/{}", self.prefix(), rel)
    }

    /// 读对象；不存在返回 None
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, RpcError> {
        match self {
            Transport::S3 { config, .. } => {
                let url = s3_object_url(config, key)?;
                let empty: Vec<u8> = Vec::new();
                let (authorization, amz_date, payload_hash) =
                    s3_signed_headers(config, "GET", &url, &empty, None)?;
                let response = client(120_000)?
                    .get(&url)
                    .header("Authorization", authorization)
                    .header("x-amz-date", amz_date)
                    .header("x-amz-content-sha256", payload_hash)
                    .send()
                    .map_err(|error| internal(format!("读取对象存储失败：{error}")))?;
                let status = response.status().as_u16();
                if status == 404 {
                    return Ok(None);
                }
                if !(200..300).contains(&status) {
                    let text = response.text().unwrap_or_default();
                    return Err(internal(format!(
                        "对象存储返回 {status}：{}",
                        truncate(&text, 300)
                    )));
                }
                let bytes = response
                    .bytes()
                    .map_err(|error| internal(format!("读取响应内容失败：{error}")))?;
                Ok(Some(bytes.to_vec()))
            }
            Transport::WebDav { base, auth, .. } => {
                let url = join_url(base, &urlencode_path(key));
                let (status, body) = simple_request(
                    reqwest::Method::GET,
                    &url,
                    auth.as_deref(),
                    None,
                    120_000,
                )?;
                if status == 404 {
                    return Ok(None);
                }
                if !(200..300).contains(&status) {
                    return Err(internal(format!(
                        "WebDAV 返回 {status}：{}",
                        truncate(&String::from_utf8_lossy(&body), 300)
                    )));
                }
                Ok(Some(body))
            }
            Transport::SelfHosted { base, token, .. } => {
                let url = join_url(base, &urlencode_path(key));
                let auth = if token.trim().is_empty() {
                    None
                } else {
                    Some(format!("Bearer {}", token.trim()))
                };
                let (status, body) =
                    simple_request(reqwest::Method::GET, &url, auth.as_deref(), None, 120_000)?;
                if status == 404 {
                    return Ok(None);
                }
                if !(200..300).contains(&status) {
                    return Err(internal(format!(
                        "自托管服务返回 {status}：{}",
                        truncate(&String::from_utf8_lossy(&body), 300)
                    )));
                }
                Ok(Some(body))
            }
        }
    }

    /// 写对象
    fn put(&self, key: &str, body: &[u8], mime: &str) -> Result<(), RpcError> {
        match self {
            Transport::S3 { config, .. } => {
                let url = s3_object_url(config, key)?;
                let (authorization, amz_date, payload_hash) =
                    s3_signed_headers(config, "PUT", &url, body, Some(mime))?;
                let response = client(180_000)?
                    .put(&url)
                    .header("Authorization", authorization)
                    .header("x-amz-date", amz_date)
                    .header("x-amz-content-sha256", payload_hash)
                    .header("Content-Type", mime)
                    .body(body.to_vec())
                    .send()
                    .map_err(|error| internal(format!("写入对象存储失败：{error}")))?;
                let status = response.status().as_u16();
                if !(200..300).contains(&status) {
                    let text = response.text().unwrap_or_default();
                    return Err(internal(format!(
                        "对象存储返回 {status}：{}",
                        truncate(&text, 300)
                    )));
                }
                Ok(())
            }
            Transport::WebDav { base, auth, .. } => {
                self.ensure_dirs(key)?;
                let url = join_url(base, &urlencode_path(key));
                let (status, body) = simple_request(
                    reqwest::Method::PUT,
                    &url,
                    auth.as_deref(),
                    Some((body, mime)),
                    180_000,
                )?;
                if !(200..300).contains(&status) && status != 204 {
                    return Err(internal(format!(
                        "WebDAV 返回 {status}：{}",
                        truncate(&String::from_utf8_lossy(&body), 300)
                    )));
                }
                Ok(())
            }
            Transport::SelfHosted { base, token, .. } => {
                let url = join_url(base, &urlencode_path(key));
                let auth = if token.trim().is_empty() {
                    None
                } else {
                    Some(format!("Bearer {}", token.trim()))
                };
                let (status, body) = simple_request(
                    reqwest::Method::PUT,
                    &url,
                    auth.as_deref(),
                    Some((body, mime)),
                    180_000,
                )?;
                if !(200..300).contains(&status) && status != 204 {
                    return Err(internal(format!(
                        "自托管服务返回 {status}：{}",
                        truncate(&String::from_utf8_lossy(&body), 300)
                    )));
                }
                Ok(())
            }
        }
    }

    /// 删对象；404 视为成功
    fn delete(&self, key: &str) -> Result<(), RpcError> {
        match self {
            Transport::S3 { config, .. } => {
                let url = s3_object_url(config, key)?;
                let empty: Vec<u8> = Vec::new();
                let (authorization, amz_date, payload_hash) =
                    s3_signed_headers(config, "DELETE", &url, &empty, None)?;
                let response = client(60_000)?
                    .delete(&url)
                    .header("Authorization", authorization)
                    .header("x-amz-date", amz_date)
                    .header("x-amz-content-sha256", payload_hash)
                    .send()
                    .map_err(|error| internal(format!("删除对象失败：{error}")))?;
                let status = response.status().as_u16();
                if (200..300).contains(&status) || status == 404 {
                    return Ok(());
                }
                let text = response.text().unwrap_or_default();
                Err(internal(format!("对象存储返回 {status}：{}", truncate(&text, 300))))
            }
            Transport::WebDav { base, auth, .. } => {
                let url = join_url(base, &urlencode_path(key));
                let (status, _) = simple_request(
                    reqwest::Method::DELETE,
                    &url,
                    auth.as_deref(),
                    None,
                    60_000,
                )?;
                if (200..300).contains(&status) || status == 404 || status == 204 {
                    return Ok(());
                }
                Err(internal(format!("WebDAV 返回 {status}")))
            }
            Transport::SelfHosted { base, token, .. } => {
                let url = join_url(base, &urlencode_path(key));
                let auth = if token.trim().is_empty() {
                    None
                } else {
                    Some(format!("Bearer {}", token.trim()))
                };
                let (status, _) = simple_request(
                    reqwest::Method::DELETE,
                    &url,
                    auth.as_deref(),
                    None,
                    60_000,
                )?;
                if (200..300).contains(&status) || status == 404 || status == 204 {
                    return Ok(());
                }
                Err(internal(format!("自托管服务返回 {status}")))
            }
        }
    }

    /// WebDAV 需要逐级 MKCOL；其它协议远端目录是隐式的
    fn ensure_dirs(&self, key: &str) -> Result<(), RpcError> {
        let Transport::WebDav { base, auth, created, .. } = self else {
            return Ok(());
        };
        let mut parts: Vec<&str> = key.split('/').collect();
        parts.pop();
        let mut current = String::new();
        let mut guard = created.lock().map_err(|_| internal("同步状态锁异常"))?;
        for part in parts.iter().filter(|part| !part.is_empty()) {
            current = if current.is_empty() {
                (*part).to_string()
            } else {
                format!("{current}/{part}")
            };
            if guard.contains(&current) {
                continue;
            }
            let url = join_url(base, &urlencode_path(&current));
            // 201 新建成功，405 已存在，301/302 已存在（部分服务端），其余忽略，PUT 会给出真正的错误
            let _ = simple_request(
                reqwest::Method::from_bytes(b"MKCOL").expect("合法方法"),
                &url,
                auth.as_deref(),
                None,
                30_000,
            );
            guard.insert(current.clone());
        }
        Ok(())
    }
}

/// 简化的请求发送：返回 (状态码, 响应体)
fn simple_request(
    method: reqwest::Method,
    url: &str,
    auth: Option<&str>,
    body: Option<(&[u8], &str)>,
    timeout: u64,
) -> Result<(u16, Vec<u8>), RpcError> {
    let mut request = client(timeout)?.request(method, url);
    if let Some(value) = auth {
        request = request.header("Authorization", value);
    }
    if let Some((bytes, mime)) = body {
        request = request.header("Content-Type", mime).body(bytes.to_vec());
    }
    let response = request
        .send()
        .map_err(|error| internal(format!("请求远端失败（{url}）：{error}")))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .map_err(|error| internal(format!("读取响应内容失败：{error}")))?;
    Ok((status, bytes.to_vec()))
}

/* ---------------- 本地扫描与状态 ---------------- */

#[derive(Clone, Debug)]
struct LocalFile {
    size: u64,
    mtime: i64,
    hash: String,
}

fn path_of(app: &App) -> PathBuf {
    app.root
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| app.data_dir.join("workspace"))
}

fn state_path(root: &Path) -> PathBuf {
    root.join(STATE_PATH)
}

fn read_state(root: &Path) -> Value {
    let raw = std::fs::read_to_string(state_path(root)).unwrap_or_default();
    let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if value.get("files").map(Value::is_object).unwrap_or(false) {
        value
    } else {
        json!({ "version": 1, "files": {} })
    }
}

fn write_state(root: &Path, value: &Value) -> Result<(), RpcError> {
    let path = state_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, value.to_string())?;
    Ok(())
}

fn state_hash(state: &Value, rel: &str) -> Option<String> {
    state
        .get("files")
        .and_then(|files| files.get(rel))
        .and_then(|entry| entry.get("hash"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// 扫描工作区；`with_hash=false` 时只取体积与修改时间
fn scan_local(root: &Path, with_hash: bool) -> BTreeMap<String, LocalFile> {
    let mut out = BTreeMap::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if out.len() >= MAX_FILES {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Ok(relative) = path.strip_prefix(root) else { continue };
        let segments: Vec<String> = relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy().to_string())
            .filter(|part| !part.is_empty() && part != ".")
            .collect();
        if segments.is_empty() {
            continue;
        }
        if segments
            .iter()
            .any(|segment| SKIP_DIRS.contains(&segment.as_str()))
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|delta| delta.as_millis() as i64)
            .unwrap_or(0);
        let rel = segments.join("/");
        let hash = if !with_hash || metadata.len() > HASH_LIMIT {
            format!("s:{}:{}", metadata.len(), mtime)
        } else {
            match std::fs::read(path) {
                Ok(bytes) => {
                    let mut hasher = Sha1::new();
                    hasher.update(&bytes);
                    format!("{}:{}", metadata.len(), hex(&hasher.finalize()))
                }
                Err(_) => continue,
            }
        };
        out.insert(
            rel,
            LocalFile {
                size: metadata.len(),
                mtime,
                hash,
            },
        );
    }
    out
}

/* ---------------- 清单 ---------------- */

fn empty_manifest() -> Value {
    json!({ "version": MANIFEST_VERSION, "updatedAt": 0, "files": {} })
}

fn read_manifest(transport: &Transport) -> Result<Value, RpcError> {
    let Some(bytes) = transport.get(&transport.manifest_key())? else {
        return Ok(empty_manifest());
    };
    let value: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| empty_manifest());
    if value.get("files").and_then(Value::as_object).is_none() {
        return Ok(empty_manifest());
    }
    Ok(value)
}

fn manifest_files(manifest: &Value) -> Map<String, Value> {
    manifest
        .get("files")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/* ---------------- 通道构建 ---------------- */

fn build_transport(options: &Value) -> Result<Transport, RpcError> {
    let provider = store_provider(options);
    if !STORE_PROVIDERS.contains(&provider.as_str()) {
        return Err(invalid("当前同步平台不是对象存储 / WebDAV / 自托管"));
    }
    let config = provider_config(options, &provider);
    match provider.as_str() {
        "s3" => {
            let bucket = field(&config, "bucket");
            let access = field(&config, "accessKeyId");
            let secret = field(&config, "secretAccessKey");
            if bucket.is_empty() {
                return Err(invalid("请填写存储桶（Bucket）"));
            }
            if access.is_empty() || secret.is_empty() {
                return Err(invalid("请填写 Access Key ID 与 Secret Access Key"));
            }
            if crate::imagehost::s3_endpoint(&config).is_empty() {
                return Err(invalid("请填写端点地址（Endpoint）"));
            }
            Ok(Transport::S3 {
                prefix: prefix_of(&config),
                config,
            })
        }
        "webdav" => {
            let base = field(&config, "baseUrl");
            if base.is_empty() {
                return Err(invalid("请填写 WebDAV 目录地址"));
            }
            let username = field(&config, "username");
            let password = field(&config, "password");
            let auth = if username.is_empty() {
                None
            } else {
                Some(basic_auth(&username, &password))
            };
            Ok(Transport::WebDav {
                base: base.trim_end_matches('/').to_string(),
                auth,
                prefix: prefix_of(&config),
                created: Mutex::new(HashSet::new()),
            })
        }
        _ => {
            let base = field(&config, "baseUrl");
            if base.is_empty() {
                return Err(invalid("请填写自托管服务地址"));
            }
            Ok(Transport::SelfHosted {
                base: base.trim_end_matches('/').to_string(),
                token: field(&config, "token"),
                prefix: prefix_of(&config),
            })
        }
    }
}

fn prefix_of(config: &Value) -> String {
    let prefix = trim_slashes(&field_or(config, "pathPrefix", "dbx-note"));
    if prefix.is_empty() {
        "dbx-note".to_string()
    } else {
        prefix
    }
}

fn resolve(app: &App) -> Result<(Value, Transport), RpcError> {
    let options = sync::load_options(app);
    let transport = build_transport(&options)?;
    Ok((options, transport))
}

/* ---------------- RPC ---------------- */

/// `sync/storeOptions`：只回传当前平台的配置（密钥掩码）
pub fn options(app: &App) -> RpcResult {
    let mut value = sync::load_options(app);
    let prefs = load_prefs(app);
    let provider = store_provider(&value);
    mask_store(&mut value);
    Ok(json!({
        "provider": provider,
        "config": provider_config(&value, &provider),
        "conflictPolicy": conflict_policy(&value),
        "prefs": auto_prefs(app, &prefs, &value),
    }))
}

/// 同步偏好（平台无关）
pub fn auto_prefs(app: &App, prefs: &Value, options: &Value) -> Value {
    let _ = app;
    json!({
        "autoSync": auto_sync(prefs, options),
        "autoPullOnOpen": flag(prefs, options, "autoPullOnOpen", true),
        "autoRecordSync": flag(prefs, options, "autoRecordSync", true),
        "autoSettingsSync": flag(prefs, options, "autoSettingsSync", true),
        "autoConversationSync": flag(prefs, options, "autoConversationSync", true),
        "excludeSensitiveConfig": flag(prefs, options, "excludeSensitiveConfig", true),
    })
}

/// `sync/prefs`：读同步偏好（不依赖当前平台）
pub fn prefs(app: &App) -> RpcResult {
    let value = sync::load_options(app);
    let prefs = load_prefs(app);
    Ok(auto_prefs(app, &prefs, &value))
}

/// `sync/savePrefs`：写同步偏好（不依赖当前平台）
pub fn save_prefs(app: &App, params: &Value) -> RpcResult {
    let mut patch = Map::new();
    if let Some(value) = params.get("autoSync") {
        let text = match value.as_str() {
            Some(text) => text.to_string(),
            None => value.to_string(),
        };
        if AUTO_SYNC_VALUES.contains(&text.as_str()) {
            patch.insert("autoSync".into(), json!(text));
        } else if text == "0" || text == "off" || text == "false" {
            patch.insert("autoSync".into(), json!("disabled"));
        }
    }
    for key in [
        "autoPullOnOpen",
        "autoRecordSync",
        "autoSettingsSync",
        "autoConversationSync",
        "excludeSensitiveConfig",
    ] {
        if let Some(value) = params.get(key).and_then(Value::as_bool) {
            patch.insert(key.into(), json!(value));
        }
    }
    if !patch.is_empty() {
        write_prefs(app, &patch)?;
    }
    prefs(app)
}

/// `sync/saveStoreOptions`：保存当前平台的配置
pub fn save(app: &App, params: &Value) -> RpcResult {
    let mut current = sync::load_options(app);
    let provider = {
        let value = crate::param_str(params, "provider");
        if value.is_empty() { store_provider(&current) } else { value }
    };
    if !STORE_PROVIDERS.contains(&provider.as_str()) {
        return Err(invalid("未知的同步平台"));
    }
    current["provider"] = json!(provider);
    // 自动同步相关的开关与平台无关，统一写进偏好；旧字段继续接受
    {
        let mut patch = Map::new();
        if let Some(value) = params.get("autoSync") {
            let text = match value.as_str() {
                Some(text) => text.to_string(),
                None => value.to_string(),
            };
            if AUTO_SYNC_VALUES.contains(&text.as_str()) {
                patch.insert("autoSync".into(), json!(text));
            } else if text == "0" || text == "off" || text == "false" {
                patch.insert("autoSync".into(), json!("disabled"));
            }
        }
        if let Some(value) = params.get("autoUpload").and_then(Value::as_bool) {
            patch.insert("autoSync".into(), json!(if value { "5" } else { "disabled" }));
        }
        for key in [
            "autoPullOnOpen",
            "autoRecordSync",
            "autoSettingsSync",
            "autoConversationSync",
            "excludeSensitiveConfig",
        ] {
            if let Some(value) = params.get(key).and_then(Value::as_bool) {
                patch.insert(key.into(), json!(value));
            }
        }
        if !patch.is_empty() {
            write_prefs(app, &patch)?;
        }
    }
    if let Some(value) = params.get("conflictPolicy").and_then(Value::as_str) {
        if ["local", "remote", "skip"].contains(&value) {
            current["conflictPolicy"] = json!(value);
        }
    }
    if let Some(config) = params.get("config") {
        let mut patch = Map::new();
        patch.insert(provider.clone(), config.clone());
        merge_store(&mut current, &Value::Object(patch));
    }
    sync::save_options(app, &current)?;
    options(app)
}

/// `sync/storeCheck`：连通性检测
pub fn check(app: &App) -> RpcResult {
    let (_, transport) = resolve(app)?;
    match &transport {
        Transport::S3 { config, .. } => {
            let result = crate::imagehost::check(&json!({
                "config": { "provider": "s3", "s3": config },
            }))?;
            Ok(json!({
                "provider": "s3",
                "ok": result.get("ok").cloned().unwrap_or(json!(false)),
                "message": result.get("message").cloned().unwrap_or(json!("")),
            }))
        }
        Transport::WebDav { base, auth, .. } => {
            // 真实 WebDAV 服务要求 Depth: 0 的 PROPFIND，缺省会按 infinity 处理被拒
            let body = r#"<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>"#;
            let mut request = client(30_000)?
                .request(reqwest::Method::from_bytes(b"PROPFIND").expect("合法方法"), base)
                .header("Depth", "0")
                .header("Content-Type", "application/xml; charset=utf-8")
                .body(body.to_string());
            if let Some(value) = auth {
                request = request.header("Authorization", value);
            }
            let response = request
                .send()
                .map_err(|error| internal(format!("请求 WebDAV 失败（{base}）：{error}")))?;
            let status = response.status().as_u16();
            let ok = (200..300).contains(&status) || status == 207;
            Ok(json!({
                "provider": "webdav",
                "ok": ok,
                "message": if ok { "连接正常".to_string() } else { format!("WebDAV 返回 {status}") },
            }))
        }
        Transport::SelfHosted { .. } => {
            // 清单不存在（404）也算连通，说明服务可达
            let reachable = transport.get(&transport.manifest_key());
            match reachable {
                Ok(_) => Ok(json!({
                    "provider": "selfHosted",
                    "ok": true,
                    "message": "连接正常",
                })),
                Err(error) => Ok(json!({
                    "provider": "selfHosted",
                    "ok": false,
                    "message": error.message,
                })),
            }
        }
    }
}

/// `sync/storeStatus`：本地 / 远端差异总览
pub fn status(app: &App) -> RpcResult {
    let root = path_of(app);
    let (options, transport) = resolve(app)?;
    let provider = transport.provider().to_string();
    let local = scan_local(&root, true);
    let state = read_state(&root);

    let mut state_out = json!({
        "provider": provider,
        "ready": true,
        "reachable": true,
        "message": "",
        "prefix": transport.prefix(),
        "localFiles": local.len(),
        "localBytes": local.values().map(|file| file.size).sum::<u64>(),
        "remoteFiles": 0,
        "pendingUpload": 0,
        "pendingDownload": 0,
        "conflicts": 0,
        "lastSyncAt": state.get("lastSyncAt").and_then(Value::as_str).unwrap_or(""),
        "autoCommit": options.get("autoCommit").cloned().unwrap_or(json!(false)),
    });

    let manifest = match read_manifest(&transport) {
        Ok(value) => value,
        Err(error) => {
            state_out["reachable"] = json!(false);
            state_out["message"] = json!(error.message);
            state_out["pendingUpload"] = json!(local.len());
            return Ok(state_out);
        }
    };

    let remote = manifest_files(&manifest);
    state_out["manifestAt"] = manifest.get("updatedAt").cloned().unwrap_or(json!(0));
    state_out["manifestDevice"] = manifest.get("device").cloned().unwrap_or(json!(""));
    state_out["remoteFiles"] = json!(remote.len());

    let mut pending_upload = 0;
    let mut pending_download = 0;
    let mut conflicts = 0;

    for (rel, file) in &local {
        match remote.get(rel).and_then(|entry| entry.get("hash")).and_then(Value::as_str) {
            None => pending_upload += 1,
            Some(remote_hash) if remote_hash != file.hash => {
                let base = state_hash(&state, rel);
                if base.as_deref() == Some(file.hash.as_str()) {
                    // 本地没动过，是远端更新了
                    pending_download += 1;
                } else if base.as_deref() == Some(remote_hash) {
                    // 远端没动过，是本地改了
                    pending_upload += 1;
                } else {
                    conflicts += 1;
                }
            }
            Some(_) => {}
        }
    }
    for rel in remote.keys() {
        if !local.contains_key(rel) {
            pending_download += 1;
        }
    }

    state_out["pendingUpload"] = json!(pending_upload);
    state_out["pendingDownload"] = json!(pending_download);
    state_out["conflicts"] = json!(conflicts);
    Ok(state_out)
}

/// `sync/storePush`：本地 → 远端
pub fn push(app: &App, params: &Value) -> RpcResult {
    let root = path_of(app);
    let (_, transport) = resolve(app)?;
    let remove_deleted = params
        .get("removeDeleted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let local = scan_local(&root, true);
    if local.is_empty() {
        return Err(invalid("工作区是空的，没有可上传的文件"));
    }
    let manifest = read_manifest(&transport)?;
    let remote = manifest_files(&manifest);

    let mut pushed = 0usize;
    let mut skipped = 0usize;
    let mut deleted = 0usize;
    let mut failed: Vec<String> = Vec::new();

    for (rel, file) in &local {
        let same = remote
            .get(rel)
            .and_then(|entry| entry.get("hash"))
            .and_then(Value::as_str)
            .map(|hash| hash == file.hash)
            .unwrap_or(false);
        if same {
            skipped += 1;
            continue;
        }
        let path = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let bytes = match std::fs::read(&path) {
            Ok(value) => value,
            Err(error) => {
                failed.push(format!("{rel}：{error}"));
                continue;
            }
        };
        match transport.put(&transport.file_key(rel), &bytes, "application/octet-stream") {
            Ok(()) => pushed += 1,
            Err(error) => failed.push(format!("{rel}：{}", error.message)),
        }
    }

    if remove_deleted {
        for rel in remote.keys() {
            if local.contains_key(rel) {
                continue;
            }
            match transport.delete(&transport.file_key(rel)) {
                Ok(()) => deleted += 1,
                Err(error) => failed.push(format!("删除 {rel}：{}", error.message)),
            }
        }
    }

    // 新清单：以本地为准；不删远端时保留远端独有条目，避免下次 pull 误判为新增
    let mut files = Map::new();
    for (rel, file) in &local {
        files.insert(
            rel.clone(),
            json!({ "size": file.size, "mtime": file.mtime, "hash": file.hash }),
        );
    }
    if !remove_deleted {
        for (rel, entry) in &remote {
            if !files.contains_key(rel) {
                files.insert(rel.clone(), entry.clone());
            }
        }
    }
    let device = hostname();
    let next_manifest = json!({
        "version": MANIFEST_VERSION,
        "updatedAt": now_ms(),
        "device": device,
        "files": files,
    });
    transport.put(
        &transport.manifest_key(),
        next_manifest.to_string().as_bytes(),
        "application/json",
    )?;

    let mut state = read_state(&root);
    let mut state_files = Map::new();
    for (rel, file) in &local {
        state_files.insert(
            rel.clone(),
            json!({ "size": file.size, "mtime": file.mtime, "hash": file.hash }),
        );
    }
    state["version"] = json!(1);
    state["files"] = Value::Object(state_files);
    state["lastSyncAt"] = json!(chrono::Local::now().format("%Y-%m-%d %H:%M").to_string());
    state["provider"] = json!(transport.provider());
    state["direction"] = json!("push");
    write_state(&root, &state)?;

    append_log(
        app,
        json!({
            "at": now_ms(),
            "provider": transport.provider(),
            "action": "push",
            "pushed": pushed,
            "skipped": skipped,
            "deleted": deleted,
            "failed": failed.len(),
            "ok": failed.is_empty(),
        }),
    );

    Ok(json!({
        "provider": transport.provider(),
        "pushed": pushed,
        "skipped": skipped,
        "deleted": deleted,
        "failed": failed,
        "total": local.len(),
        "message": format!(
            "已上传 {pushed} 个文件，跳过 {skipped} 个未变更文件{}",
            if deleted > 0 { format!("，删除远端 {deleted} 个") } else { String::new() }
        ),
    }))
}

/// `sync/storePull`：远端 → 本地（不删除本地文件）
pub fn pull(app: &App, params: &Value) -> RpcResult {
    let root = path_of(app);
    let (options, transport) = resolve(app)?;
    let policy = conflict_policy(&options);
    let overwrite = params
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let manifest = read_manifest(&transport)?;
    let remote = manifest_files(&manifest);
    if remote.is_empty() {
        return Ok(json!({
            "provider": transport.provider(),
            "pulled": 0,
            "skipped": 0,
            "conflicts": Vec::<String>::new(),
            "message": "远端还没有同步数据",
        }));
    }

    let local = scan_local(&root, true);
    let mut state = read_state(&root);
    let mut pulled = 0usize;
    let mut skipped = 0usize;
    let mut conflicts: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    for (rel, entry) in &remote {
        let remote_hash = entry
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if remote_hash.is_empty() {
            continue;
        }
        match local.get(rel) {
            Some(file) if file.hash == remote_hash => {
                skipped += 1;
                continue;
            }
            Some(file) => {
                let base = state_hash(&state, rel);
                let local_changed = base.as_deref() != Some(file.hash.as_str());
                let remote_changed = base.as_deref() != Some(remote_hash.as_str());
                if local_changed && remote_changed {
                    // 两边都改：按设置里的冲突策略处理
                    match policy.as_str() {
                        "remote" => {} // 继续往下走，用远端覆盖本地
                        "skip" => {
                            skipped += 1;
                            continue;
                        }
                        _ => {
                            conflicts.push(rel.clone());
                            continue;
                        }
                    }
                } else if local_changed && !overwrite {
                    conflicts.push(rel.clone());
                    continue;
                }
            }
            None => {}
        }

        let bytes = match transport.get(&transport.file_key(rel)) {
            Ok(Some(value)) => value,
            Ok(None) => {
                failed.push(format!("{rel}：远端文件不存在"));
                continue;
            }
            Err(error) => {
                failed.push(format!("{rel}：{}", error.message));
                continue;
            }
        };
        let target = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = target.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                failed.push(format!("{rel}：{error}"));
                continue;
            }
        }
        if let Err(error) = std::fs::write(&target, &bytes) {
            failed.push(format!("{rel}：{error}"));
            continue;
        }
        pulled += 1;

        let metadata = std::fs::metadata(&target).ok();
        let size = metadata.as_ref().map(|value| value.len()).unwrap_or(0);
        let mtime = metadata
            .and_then(|value| value.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|delta| delta.as_millis() as i64)
            .unwrap_or(0);
        let files = state["files"].as_object_mut();
        if let Some(files) = files {
            files.insert(
                rel.clone(),
                json!({ "size": size, "mtime": mtime, "hash": remote_hash }),
            );
        }
    }

    state["version"] = json!(1);
    state["lastSyncAt"] = json!(chrono::Local::now().format("%Y-%m-%d %H:%M").to_string());
    state["provider"] = json!(transport.provider());
    state["direction"] = json!("pull");
    write_state(&root, &state)?;

    append_log(
        app,
        json!({
            "at": now_ms(),
            "provider": transport.provider(),
            "action": "pull",
            "pulled": pulled,
            "skipped": skipped,
            "conflicts": conflicts.len(),
            "failed": failed.len(),
            "ok": failed.is_empty(),
        }),
    );

    Ok(json!({
        "provider": transport.provider(),
        "pulled": pulled,
        "skipped": skipped,
        "conflicts": conflicts,
        "failed": failed,
        "message": format!(
            "已下载 {pulled} 个文件，跳过 {skipped} 个相同文件{}",
            if conflicts.is_empty() {
                String::new()
            } else {
                format!("，{} 个文件本地也有改动已保留本地", conflicts.len())
            }
        ),
    }))
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "dbx-note".to_string())
}

/// 供 main 使用：避免未使用告警
pub fn _unused(_: &App) {}
