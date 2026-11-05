//! 图床上传代理
//!
//! 插件页面在沙箱里发不出请求（CSP `connect-src 'none'`），
//! 所有图床的上传、连接检测、GitHub 仓库查询/创建统一放在 Sidecar 里做。
//!
//! 支持：GitHub / S.EE(SM.MS v2) / PicGo(本机服务) / S3 兼容（AWS、R2、OSS、COS、B2、MinIO、自定义）/
//! 七牛云 Kodo / 又拍云 USS / Lsky Pro / WebDAV / 自定义 HTTP / Cloudinary / ImageKit。
//!
//! 各家的请求格式与签名规则与 NoteGen `src/lib/imageHosting/*` 保持一致，
//! 这样同一个图床账号在两边可以互换使用。

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::{param_str, App, RpcError, RpcResult};

type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::invalid(message.into())
}

fn internal(message: impl Into<String>) -> RpcError {
    RpcError::internal(message.into())
}

/// 取子配置（缺省返回空对象）
fn sub<'a>(config: &'a Value, key: &str) -> &'a Value {
    config.get(key).unwrap_or(&Value::Null)
}

/// 取字符串字段
pub(crate) fn field(node: &Value, key: &str) -> String {
    node.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

pub(crate) fn field_or(node: &Value, key: &str, fallback: &str) -> String {
    let value = field(node, key);
    if value.is_empty() { fallback.to_string() } else { value }
}

/// 去掉首尾斜杠
pub(crate) fn trim_slashes(value: &str) -> String {
    value.trim().trim_matches('/').to_string()
}

/// 拼接 URL
pub(crate) fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim().trim_end_matches('/'), trim_slashes(path))
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// 生成对象名：`<uuid>.<ext>`，按需加路径前缀
fn object_key(name: &str, mime: &str, prefix: &str) -> String {
    let extension = Path::new(name)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .or_else(|| {
            let guess = match mime {
                "image/jpeg" => "jpg",
                "image/gif" => "gif",
                "image/webp" => "webp",
                "image/svg+xml" => "svg",
                "image/bmp" => "bmp",
                "image/avif" => "avif",
                _ => "png",
            };
            Some(guess.to_string())
        })
        .unwrap_or_else(|| "png".to_string());
    let file = format!("{}.{}", uuid::Uuid::new_v4(), extension);
    let prefix = trim_slashes(prefix);
    if prefix.is_empty() { file } else { format!("{prefix}/{file}") }
}

pub(crate) fn basic_auth(user: &str, password: &str) -> String {
    let raw = format!("{user}:{password}");
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hmac_sha1(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex(&hasher.finalize())
}

fn base64_url_safe(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD
        .encode(bytes)
        .replace('+', "-")
        .replace('/', "_")
}

pub(crate) fn client(timeout_ms: u64) -> Result<reqwest::blocking::Client, RpcError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| internal(format!("创建 HTTP 客户端失败：{error}")))
}

fn response_text(response: reqwest::blocking::Response) -> Result<(u16, String), RpcError> {
    let status = response.status().as_u16();
    let text = response
        .text()
        .map_err(|error| internal(format!("读取响应失败：{error}")))?;
    Ok((status, text))
}

pub(crate) fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect::<String>() + "…"
}

/// 读取 JSON 点路径（`data.links.url`）
fn read_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for part in path.split('.') {
        if part.is_empty() {
            continue;
        }
        current = current.get(part)?;
    }
    Some(current)
}

/// 解析 JSON 对象文本（非法/空返回空对象）
fn parse_object(text: &str) -> Value {
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/* ---------------- 上传入口 ---------------- */

/// `image/upload`：按配置选择图床，上传后返回可访问 URL
pub fn upload(params: &Value) -> RpcResult {
    let data = param_str(params, "dataBase64");
    if data.is_empty() {
        return Err(invalid("图片数据为空"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| invalid("图片数据不是合法的 base64"))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(invalid("图片超过 32MB 上限"));
    }
    let name = {
        let value = param_str(params, "name");
        if value.is_empty() { "image.png".to_string() } else { value }
    };
    let mime = {
        let value = param_str(params, "mime");
        if value.is_empty() { "image/png".to_string() } else { value }
    };
    let config = params.get("config").cloned().unwrap_or_else(|| json!({}));
    let provider = field_or(&config, "provider", "local");
    let url = match provider.as_str() {
        "github" => github_upload(&config, &bytes, &name, &mime)?,
        "smms" => smms_upload(&config, &bytes, &name, &mime)?,
        "picgo" => picgo_upload(&config, &bytes, &name)?,
        "s3" => s3_upload(&config, &bytes, &name, &mime)?,
        "qiniu" => qiniu_upload(&config, &bytes, &name, &mime)?,
        "upyun" => upyun_upload(&config, &bytes, &name, &mime)?,
        "lsky" => lsky_upload(&config, &bytes, &name, &mime)?,
        "webdav" => webdav_upload(&config, &bytes, &name, &mime)?,
        "custom-http" => custom_http_upload(&config, &bytes, &name, &mime)?,
        "cloudinary" => cloudinary_upload(&config, &bytes, &name, &mime)?,
        "imagekit" => imagekit_upload(&config, &bytes, &name, &mime)?,
        other => return Err(invalid(format!("未配置的图床：{other}"))),
    };
    Ok(json!({ "url": url, "provider": provider }))
}

/// `image/hostingCheck`：连通性 / 配置完整性检测
pub fn check(params: &Value) -> RpcResult {
    let config = params.get("config").cloned().unwrap_or_else(|| json!({}));
    let provider = field_or(&config, "provider", "local");
    let result = match provider.as_str() {
        "github" => github_check(&config),
        "smms" => smms_check(&config),
        "picgo" => picgo_check(&config),
        "s3" => s3_check(&config),
        "qiniu" => qiniu_check(&config),
        "upyun" => upyun_check(&config),
        "lsky" => lsky_check(&config),
        "webdav" => webdav_check(&config),
        "custom-http" => Ok((custom_http_complete(&config), "已保存配置".to_string(), json!({}))),
        "cloudinary" => Ok((
            !field(sub(&config, "cloudinary"), "cloudName").is_empty()
                && !field(sub(&config, "cloudinary"), "uploadPreset").is_empty(),
            "已保存配置".to_string(),
            json!({}),
        )),
        "imagekit" => imagekit_check(&config),
        other => Ok((false, format!("未知图床：{other}"), json!({}))),
    };
    let (ok, message, extra) = result?;
    Ok(json!({
        "provider": provider,
        "ok": ok,
        "message": message,
        "info": extra,
    }))
}

/// `image/hostingRepo`：GitHub 图床仓库状态查询 / 创建
pub fn repo(params: &Value) -> RpcResult {
    let config = params.get("config").cloned().unwrap_or_else(|| json!({}));
    let action = field_or(params, "action", "check");
    let github = sub(&config, "github");
    let token = field(github, "token");
    if token.is_empty() {
        return Err(invalid("请先填写 GitHub Access Token"));
    }
    let repo_name = {
        let value = field(github, "repo");
        if value.is_empty() { "note-gen-image-sync".to_string() } else { value }
    };
    if action == "create" {
        let client = client(30_000)?;
        let body = json!({
            "name": repo_name,
            "description": "This is a NoteGen image hosting repository.",
            "private": github.get("private").and_then(Value::as_bool).unwrap_or(true),
        });
        let response = client
            .post("https://api.github.com/user/repos")
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .json(&body)
            .send()
            .map_err(|error| internal(format!("请求 GitHub 失败：{error}")))?;
        let (status, text) = response_text(response)?;
        if !(200..300).contains(&status) {
            return Err(internal(format!("创建仓库失败（{status}）：{}", truncate(&text, 300))));
        }
        let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
        return Ok(json!({ "exists": true, "repo": repo_payload(&data, &repo_name) }));
    }
    // check：先取用户名，再查仓库
    let client = client(30_000)?;
    let owner = {
        let configured = field(github, "username");
        if configured.is_empty() {
            let response = client
                .get("https://api.github.com/user")
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "dbx-note")
                .send()
                .map_err(|error| internal(format!("请求 GitHub 失败：{error}")))?;
            let (status, text) = response_text(response)?;
            if !(200..300).contains(&status) {
                return Err(internal(format!("Token 校验失败（{status}）：{}", truncate(&text, 200))));
            }
            let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
            field(&data, "login")
        } else {
            configured
        }
    };
    if owner.is_empty() {
        return Err(internal("无法获取 GitHub 用户名，请检查 Token 权限"));
    }
    let response = client
        .get(format!("https://api.github.com/repos/{owner}/{repo_name}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "dbx-note")
        .send()
        .map_err(|error| internal(format!("请求 GitHub 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    if status == 404 {
        return Ok(json!({ "exists": false, "owner": owner, "repoName": repo_name }));
    }
    if !(200..300).contains(&status) {
        return Err(internal(format!("查询仓库失败（{status}）：{}", truncate(&text, 200))));
    }
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    Ok(json!({
        "exists": true,
        "owner": owner,
        "repoName": repo_name,
        "repo": repo_payload(&data, &repo_name),
    }))
}

fn repo_payload(data: &Value, fallback_name: &str) -> Value {
    let owner = data.get("owner").cloned().unwrap_or_else(|| json!({}));
    json!({
        "fullName": data.get("full_name").and_then(Value::as_str).unwrap_or(fallback_name),
        "htmlUrl": data.get("html_url").and_then(Value::as_str).unwrap_or(""),
        "avatarUrl": owner.get("avatar_url").and_then(Value::as_str).unwrap_or(""),
        "defaultBranch": data.get("default_branch").and_then(Value::as_str).unwrap_or("main"),
        "private": data.get("private").and_then(Value::as_bool).unwrap_or(false),
        "createdAt": data.get("created_at").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": data.get("updated_at").and_then(Value::as_str).unwrap_or(""),
    })
}

/* ---------------- GitHub ---------------- */

fn github_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let github = sub(config, "github");
    let token = field(github, "token");
    if token.is_empty() {
        return Err(invalid("GitHub 图床缺少 Access Token"));
    }
    let owner = field(github, "username");
    if owner.is_empty() {
        return Err(invalid("GitHub 图床缺少用户名（填写 Token 后可自动获取）"));
    }
    let repo = field_or(github, "repo", "note-gen-image-sync");
    let key = object_key(name, mime, &field(github, "pathPrefix"));
    let client = client(60_000)?;
    let body = json!({
        "message": format!("Upload {key}"),
        "content": base64::engine::general_purpose::STANDARD.encode(bytes),
    });
    let response = client
        .put(format!(
            "https://api.github.com/repos/{owner}/{repo}/contents/{}",
            key.rsplit('/').next().unwrap_or(&key)
        ))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "dbx-note")
        .json(&body)
        .send()
        .map_err(|error| internal(format!("上传到 GitHub 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    if !(200..300).contains(&status) {
        return Err(internal(format!("上传失败（{status}）：{}", truncate(&text, 300))));
    }
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let download = data
        .get("content")
        .and_then(|node| node.get("download_url"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let use_jsdelivr = config.get("jsdelivr").and_then(Value::as_bool).unwrap_or(false)
        || github.get("jsdelivr").and_then(Value::as_bool).unwrap_or(false);
    let branch = field_or(github, "branch", "main");
    if use_jsdelivr {
        let cdn = format!("https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{}", urlencode_path(&key));
        // 顺手清一下 CDN 缓存，失败不影响结果
        let _ = client
            .get(format!(
                "https://purge.jsdelivr.net/gh/{owner}/{repo}@{branch}/{}",
                urlencode_path(&key)
            ))
            .timeout(Duration::from_millis(8_000))
            .send();
        return Ok(cdn);
    }
    if download.is_empty() {
        return Ok(format!(
            "https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{}",
            urlencode_path(&key)
        ));
    }
    Ok(download)
}

fn github_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let github = sub(config, "github");
    let token = field(github, "token");
    if token.is_empty() {
        return Ok((false, "未填写 Access Token".to_string(), json!({})));
    }
    let client = client(20_000)?;
    let response = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "dbx-note")
        .send()
        .map_err(|error| internal(format!("请求 GitHub 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    if !(200..300).contains(&status) {
        return Ok((false, format!("Token 无效（{status}）"), json!({})));
    }
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    Ok((
        true,
        "Token 有效".to_string(),
        json!({ "login": field(&data, "login"), "avatarUrl": field(&data, "avatar_url") }),
    ))
}

/* ---------------- S.EE / SM.MS ---------------- */

fn smms_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let token = field(sub(config, "smms"), "token");
    if token.is_empty() {
        return Err(invalid("S.EE 图床缺少 API Token"));
    }
    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(name.to_string())
        .mime_str(mime)
        .map_err(|error| internal(format!("构造上传内容失败：{error}")))?;
    let form = reqwest::blocking::multipart::Form::new()
        .part("smfile", part)
        .text("format", "json");
    let response = client(60_000)?
        .post("https://s.ee/api/v1/file/upload")
        .header("Authorization", token)
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .map_err(|error| internal(format!("上传到 S.EE 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    let data = parse_object(&text);
    if let Some(url) = read_path(&data, "data.url").and_then(Value::as_str) {
        return Ok(url.to_string());
    }
    if let Some(url) = data.get("images").and_then(Value::as_str) {
        return Ok(url.to_string());
    }
    Err(internal(format!("S.EE 上传失败（{status}）：{}", truncate(&text, 300))))
}

fn smms_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let token = field(sub(config, "smms"), "token");
    if token.is_empty() {
        return Ok((false, "未填写 Token".to_string(), json!({})));
    }
    let response = client(20_000)?
        .get("https://s.ee/api/v1/file/domains")
        .header("Authorization", token)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| internal(format!("请求 S.EE 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    if !(200..300).contains(&status) {
        return Ok((false, format!("Token 校验失败（{status}）"), json!({})));
    }
    Ok((true, "Token 有效".to_string(), parse_object(&text)))
}

/* ---------------- PicGo ---------------- */

fn picgo_upload(config: &Value, bytes: &[u8], name: &str) -> Result<String, RpcError> {
    let url = field_or(sub(config, "picgo"), "url", "http://127.0.0.1:36677/upload");
    let path = std::env::temp_dir().join(format!("dbx-note-{}-{name}", now_ms()));
    std::fs::write(&path, bytes).map_err(|error| internal(format!("写入临时文件失败：{error}")))?;
    let result = (|| -> Result<String, RpcError> {
        let response = client(60_000)?
            .post(&url)
            .json(&json!({ "list": [path.to_string_lossy()] }))
            .send()
            .map_err(|error| {
                internal(format!(
                    "无法连接 PicGo 服务（{url}），请确认 PicGo 已启动并开启 Server：{error}"
                ))
            })?;
        let (status, text) = response_text(response)?;
        if !(200..300).contains(&status) {
            return Err(internal(format!("PicGo 返回 {status}：{}", truncate(&text, 300))));
        }
        let data = parse_object(&text);
        data.get("result")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| internal(format!("PicGo 未返回图片地址：{}", truncate(&text, 200))))
    })();
    let _ = std::fs::remove_file(&path);
    result
}

fn picgo_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let url = field_or(sub(config, "picgo"), "url", "http://127.0.0.1:36677/upload");
    let base = url.trim_end_matches("/upload").trim_end_matches('/');
    let response = client(8_000)?.get(format!("{base}/heartbeat")).send();
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            Ok((status < 500, format!("PicGo 服务状态 {status}"), json!({ "url": base })))
        }
        Err(error) => Ok((
            false,
            format!("无法连接 PicGo 服务（{base}）：{error}"),
            json!({ "url": base }),
        )),
    }
}

/* ---------------- S3 兼容 ---------------- */

pub(crate) fn s3_endpoint(config: &Value) -> String {
    let preset = field_or(config, "preset", "aws");
    let region = field(config, "region");
    match preset.as_str() {
        "aws" => format!(
            "https://s3.{}.amazonaws.com",
            if region.is_empty() { "us-east-1" } else { &region }
        ),
        "aliyun-oss" => format!("https://oss-{region}.aliyuncs.com"),
        "tencent-cos" => format!("https://cos.{region}.myqcloud.com"),
        "backblaze-b2" => format!("https://s3.{region}.backblazeb2.com"),
        _ => field(config, "endpoint").trim_end_matches('/').to_string(),
    }
}

fn s3_addressing(config: &Value) -> String {
    let preset = field_or(config, "preset", "aws");
    let configured = field(config, "addressingStyle");
    if !configured.is_empty() && configured != "auto" {
        return configured;
    }
    match preset.as_str() {
        "aws" | "aliyun-oss" | "tencent-cos" => "virtual".to_string(),
        "cloudflare-r2" | "minio" | "backblaze-b2" => "path".to_string(),
        _ => {
            let endpoint = field(config, "endpoint");
            if endpoint.contains("amazonaws.com")
                || endpoint.contains("aliyuncs.com")
                || endpoint.contains("myqcloud.com")
            {
                "virtual".to_string()
            } else {
                "path".to_string()
            }
        }
    }
}

pub(crate) fn urlencode_segment(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub(crate) fn urlencode_path(value: &str) -> String {
    value.split('/').map(urlencode_segment).collect::<Vec<_>>().join("/")
}

/// 拼对象 URL（虚拟主机 / 路径两种寻址）
pub(crate) fn s3_object_url(config: &Value, key: &str) -> Result<String, RpcError> {
    let endpoint = s3_endpoint(config);
    if endpoint.is_empty() {
        return Err(invalid("对象存储需要填写端点地址"));
    }
    let bucket = field(config, "bucket");
    if bucket.is_empty() {
        return Err(invalid("对象存储需要填写存储桶"));
    }
    let url = reqwest::Url::parse(&endpoint)
        .map_err(|error| invalid(format!("端点地址不合法：{error}")))?;
    let host = url.host_str().unwrap_or_default().to_string();
    let base_path = url.path().trim_matches('/').to_string();
    let encoded = urlencode_path(key);
    let mut built = url.clone();
    if s3_addressing(config) == "virtual" {
        let _ = built.set_host(Some(&format!("{bucket}.{host}")));
        let path = [base_path.as_str(), encoded.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("/");
        built.set_path(&format!("/{path}"));
    } else {
        let path = [base_path.as_str(), &urlencode_segment(&bucket), encoded.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("/");
        built.set_path(&format!("/{path}"));
    }
    Ok(built.to_string())
}

/// AWS SigV4 签名（服务固定 s3）
pub(crate) fn s3_signed_headers(
    config: &Value,
    method: &str,
    url: &str,
    payload: &[u8],
    content_type: Option<&str>,
) -> Result<(String, String, String), RpcError> {
    let access_key = field(config, "accessKeyId");
    let secret_key = field(config, "secretAccessKey");
    let region = field_or(config, "region", "us-east-1");
    if access_key.is_empty() || secret_key.is_empty() {
        return Err(invalid("对象存储需要填写 Access Key ID 与 Secret Access Key"));
    }
    let parsed = reqwest::Url::parse(url).map_err(|error| invalid(format!("URL 不合法：{error}")))?;
    let host = parsed.host_str().unwrap_or_default().to_string();
    let canonical_uri = if parsed.path().is_empty() { "/".to_string() } else { parsed.path().to_string() };
    let payload_hash = sha256_hex(payload);

    // 时间戳：AWS 要求 UTC 的 YYYYMMDD'T'HHMMSS'Z'
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();

    let mut headers: Vec<(String, String)> = vec![
        ("host".to_string(), host),
        ("x-amz-content-sha256".to_string(), payload_hash.clone()),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    if let Some(value) = content_type {
        headers.push(("content-type".to_string(), value.to_string()));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let canonical_headers = headers
        .iter()
        .map(|(key, value)| format!("{key}:{}\n", value.trim()))
        .collect::<String>();
    let signed_headers = headers
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request = [
        method.to_string(),
        canonical_uri,
        String::new(),
        canonical_headers,
        signed_headers.clone(),
        payload_hash.clone(),
    ]
    .join("\n");

    let scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign = [
        "AWS4-HMAC-SHA256".to_string(),
        amz_date.clone(),
        scope.clone(),
        sha256_hex(canonical_request.as_bytes()),
    ]
    .join("\n");

    let k_date = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );
    Ok((authorization, amz_date, payload_hash))
}

fn s3_public_url(config: &Value, key: &str) -> Result<String, RpcError> {
    let custom = field(config, "customDomain");
    if !custom.is_empty() {
        return Ok(join_url(&custom, &urlencode_path(key)));
    }
    s3_object_url(config, key)
}

fn s3_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let s3 = sub(config, "s3");
    let key = object_key(name, mime, &field(s3, "pathPrefix"));
    let url = s3_object_url(s3, &key)?;
    let (authorization, amz_date, payload_hash) =
        s3_signed_headers(s3, "PUT", &url, bytes, Some(mime))?;
    let response = client(90_000)?
        .put(&url)
        .header("Authorization", authorization)
        .header("x-amz-date", amz_date)
        .header("x-amz-content-sha256", payload_hash)
        .header("Content-Type", mime)
        .body(bytes.to_vec())
        .send()
        .map_err(|error| internal(format!("上传到对象存储失败：{error}")))?;
    let (status, text) = response_text(response)?;
    if !(200..300).contains(&status) {
        return Err(internal(format!("对象存储返回 {status}：{}", truncate(&text, 300))));
    }
    s3_public_url(s3, &key)
}

fn s3_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let s3 = sub(config, "s3");
    let region = field_or(s3, "region", "us-east-1");
    let endpoint = s3_endpoint(s3);
    let bucket = field(s3, "bucket");
    if endpoint.is_empty() || bucket.is_empty() || field(s3, "accessKeyId").is_empty() {
        return Ok((false, "请先填写 Access Key ID、Secret Access Key、区域和存储桶".to_string(), json!({})));
    }
    // 用 GET bucket 探测（ListObjects），无读权限时再用 PUT 试探写权限
    let base = s3_object_url(s3, "")?;
    let empty: Vec<u8> = Vec::new();
    let (authorization, amz_date, payload_hash) = s3_signed_headers(s3, "GET", &base, &empty, None)?;
    let response = client(30_000)?
        .get(&base)
        .header("Authorization", authorization.clone())
        .header("x-amz-date", amz_date.clone())
        .header("x-amz-content-sha256", payload_hash.clone())
        .send()
        .map_err(|error| internal(format!("连接对象存储失败：{error}")))?;
    let status = response.status().as_u16();
    if (200..300).contains(&status) {
        return Ok((true, "连接正常".to_string(), json!({ "endpoint": endpoint, "region": region })));
    }
    if status == 403 {
        let probe_key = format!(".dbx-note-test-{}", uuid::Uuid::new_v4());
        let url = s3_object_url(s3, &probe_key)?;
        let probe = b"test".to_vec();
        let (authorization, amz_date, payload_hash) =
            s3_signed_headers(s3, "PUT", &url, &probe, Some("text/plain"))?;
        let response = client(30_000)?
            .put(&url)
            .header("Authorization", authorization)
            .header("x-amz-date", amz_date)
            .header("x-amz-content-sha256", payload_hash)
            .header("Content-Type", "text/plain")
            .body(probe)
            .send()
            .map_err(|error| internal(format!("连接对象存储失败：{error}")))?;
        let status = response.status().as_u16();
        return if (200..300).contains(&status) {
            Ok((true, "连接正常（已验证写权限）".to_string(), json!({ "endpoint": endpoint })))
        } else {
            Ok((false, format!("写入被拒绝（{status}）"), json!({ "endpoint": endpoint })))
        };
    }
    Ok((false, format!("对象存储返回 {status}"), json!({ "endpoint": endpoint })))
}

/* ---------------- 七牛云 ---------------- */

fn qiniu_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let qiniu = sub(config, "qiniu");
    let access_key = field(qiniu, "accessKey");
    let secret_key = field(qiniu, "secretKey");
    let bucket = field(qiniu, "bucket");
    let public_url = field(qiniu, "publicUrl");
    if access_key.is_empty() || secret_key.is_empty() || bucket.is_empty() || public_url.is_empty() {
        return Err(invalid("七牛云需要填写 AccessKey、SecretKey、存储空间与公开访问域名"));
    }
    let key = object_key(name, mime, &field_or(qiniu, "pathPrefix", "images"));
    let deadline = (now_ms() / 1000) as u64 + 3600;
    let policy = json!({ "scope": format!("{bucket}:{key}"), "deadline": deadline });
    let encoded_policy = base64_url_safe(policy.to_string().as_bytes());
    let signature = base64_url_safe(&hmac_sha1(secret_key.as_bytes(), encoded_policy.as_bytes()));
    let token = format!("{access_key}:{signature}:{encoded_policy}");

    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(name.to_string())
        .mime_str(mime)
        .map_err(|error| internal(format!("构造上传内容失败：{error}")))?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("token", token)
        .text("key", key.clone())
        .part("file", part);
    let upload_url = field_or(qiniu, "uploadUrl", "https://upload.qiniup.com");
    let response = client(90_000)?
        .post(upload_url)
        .multipart(form)
        .send()
        .map_err(|error| internal(format!("上传到七牛云失败：{error}")))?;
    let (status, text) = response_text(response)?;
    if !(200..300).contains(&status) {
        return Err(internal(format!("七牛云返回 {status}：{}", truncate(&text, 300))));
    }
    Ok(join_url(&public_url, &key))
}

fn qiniu_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let qiniu = sub(config, "qiniu");
    let complete = !field(qiniu, "accessKey").is_empty()
        && !field(qiniu, "secretKey").is_empty()
        && !field(qiniu, "bucket").is_empty()
        && !field(qiniu, "publicUrl").is_empty()
        && !field_or(qiniu, "uploadUrl", "").is_empty();
    let message = if complete { "配置完整".to_string() } else { "请填写 AccessKey、SecretKey、存储空间与公开访问域名".to_string() };
    Ok((complete, message, json!({})))
}

/* ---------------- 又拍云 ---------------- */

fn upyun_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let upyun = sub(config, "upyun");
    let bucket = field(upyun, "bucket");
    let operator = field(upyun, "operator");
    let password = field(upyun, "password");
    let public_url = field(upyun, "publicUrl");
    if bucket.is_empty() || operator.is_empty() || password.is_empty() || public_url.is_empty() {
        return Err(invalid("又拍云需要填写服务名称、操作员、密码与公开访问域名"));
    }
    let key = object_key(name, mime, &field_or(upyun, "pathPrefix", "images"));
    let uri = format!(
        "/{}/{}",
        urlencode_segment(&bucket),
        key.split('/').map(urlencode_segment).collect::<Vec<_>>().join("/")
    );
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let password_md5 = format!("{:x}", md5::compute(password.as_bytes()));
    let signature = base64::engine::general_purpose::STANDARD
        .encode(hmac_sha1(password_md5.as_bytes(), format!("PUT&{uri}&{date}").as_bytes()));
    let authorization = format!("UPYUN {operator}:{signature}");

    let response = client(90_000)?
        .put(format!("https://v0.api.upyun.com{uri}"))
        .header("Authorization", authorization)
        .header("Date", date)
        .header("Content-Type", mime)
        .body(bytes.to_vec())
        .send()
        .map_err(|error| internal(format!("上传到又拍云失败：{error}")))?;
    let (status, text) = response_text(response)?;
    if !(200..300).contains(&status) {
        return Err(internal(format!("又拍云返回 {status}：{}", truncate(&text, 300))));
    }
    Ok(join_url(&public_url, &key))
}

fn upyun_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let upyun = sub(config, "upyun");
    let bucket = field(upyun, "bucket");
    let operator = field(upyun, "operator");
    let password = field(upyun, "password");
    if bucket.is_empty() || operator.is_empty() || password.is_empty() {
        return Ok((false, "请填写服务名称、操作员与密码".to_string(), json!({})));
    }
    let uri = format!("/{}/", urlencode_segment(&bucket));
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let password_md5 = format!("{:x}", md5::compute(password.as_bytes()));
    let signature = base64::engine::general_purpose::STANDARD
        .encode(hmac_sha1(password_md5.as_bytes(), format!("GET&{uri}&{date}").as_bytes()));
    let response = client(20_000)?
        .get(format!("https://v0.api.upyun.com{uri}"))
        .header("Authorization", format!("UPYUN {operator}:{signature}"))
        .header("Date", date)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| internal(format!("请求又拍云失败：{error}")))?;
    let status = response.status().as_u16();
    Ok((
        (200..300).contains(&status),
        if (200..300).contains(&status) { "连接正常".to_string() } else { format!("又拍云返回 {status}") },
        json!({}),
    ))
}

/* ---------------- Lsky Pro ---------------- */

fn lsky_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let lsky = sub(config, "lsky");
    let api_url = field(lsky, "apiUrl");
    let token = field(lsky, "token");
    if api_url.is_empty() || token.is_empty() {
        return Err(invalid("Lsky 需要填写 API 地址与 Token"));
    }
    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(name.to_string())
        .mime_str(mime)
        .map_err(|error| internal(format!("构造上传内容失败：{error}")))?;
    let mut form = reqwest::blocking::multipart::Form::new().part("file", part);
    let strategy = field(lsky, "strategyId");
    if !strategy.is_empty() {
        form = form.text("strategy_id", strategy);
    }
    let response = client(90_000)?
        .post(join_url(&api_url, "upload"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .map_err(|error| internal(format!("上传到 Lsky 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    let data = parse_object(&text);
    for path in ["data.links.url", "data.url", "url"] {
        if let Some(url) = read_path(&data, path).and_then(Value::as_str) {
            return Ok(url.to_string());
        }
    }
    Err(internal(format!("Lsky 未返回图片地址（{status}）：{}", truncate(&text, 300))))
}

fn lsky_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let lsky = sub(config, "lsky");
    let api_url = field(lsky, "apiUrl");
    let token = field(lsky, "token");
    if api_url.is_empty() || token.is_empty() {
        return Ok((false, "请填写 API 地址与 Token".to_string(), json!({})));
    }
    let response = client(20_000)?
        .get(join_url(&api_url, "profile"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .map_err(|error| internal(format!("请求 Lsky 失败：{error}")))?;
    let status = response.status().as_u16();
    Ok((
        (200..300).contains(&status),
        if (200..300).contains(&status) { "连接正常".to_string() } else { format!("Lsky 返回 {status}") },
        json!({}),
    ))
}

/* ---------------- WebDAV ---------------- */

fn webdav_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let webdav = sub(config, "webdav");
    let base = field(webdav, "baseUrl");
    let public_url = field(webdav, "publicUrl");
    if base.is_empty() || public_url.is_empty() {
        return Err(invalid("WebDAV 需要填写目录地址与公开访问地址"));
    }
    let auth = basic_auth(&field(webdav, "username"), &field(webdav, "password"));
    let key = object_key(name, mime, &field_or(webdav, "pathPrefix", "images"));
    let http = client(90_000)?;

    // 逐级 MKCOL，已存在会返回 405/301/302，忽略即可
    let prefix = trim_slashes(&field_or(webdav, "pathPrefix", "images"));
    let mut collection = base.clone();
    for part in prefix.split('/').filter(|value| !value.is_empty()) {
        collection = join_url(&collection, part);
        let _ = http
            .request(reqwest::Method::from_bytes(b"MKCOL").expect("合法方法"), &collection)
            .header("Authorization", auth.clone())
            .send();
    }

    let response = http
        .put(join_url(&base, &key))
        .header("Authorization", auth)
        .header("Content-Type", mime)
        .body(bytes.to_vec())
        .send()
        .map_err(|error| internal(format!("上传到 WebDAV 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    if !(200..300).contains(&status) {
        return Err(internal(format!("WebDAV 返回 {status}：{}", truncate(&text, 300))));
    }
    Ok(join_url(&public_url, &key))
}

fn webdav_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let webdav = sub(config, "webdav");
    let base = field(webdav, "baseUrl");
    if base.is_empty() {
        return Ok((false, "请填写 WebDAV 目录地址".to_string(), json!({})));
    }
    let response = client(20_000)?
        .request(reqwest::Method::from_bytes(b"PROPFIND").expect("合法方法"), &base)
        .header("Authorization", basic_auth(&field(webdav, "username"), &field(webdav, "password")))
        .header("Depth", "0")
        .send()
        .map_err(|error| internal(format!("请求 WebDAV 失败：{error}")))?;
    let status = response.status().as_u16();
    let ok = (200..300).contains(&status) || status == 207;
    Ok((
        ok,
        if ok { "连接正常".to_string() } else { format!("WebDAV 返回 {status}") },
        json!({}),
    ))
}

/* ---------------- 自定义 HTTP ---------------- */

fn custom_http_complete(config: &Value) -> bool {
    let http = sub(config, "customHttp");
    !field(http, "url").is_empty() && !field(http, "responseUrlPath").is_empty()
}

fn parse_json_pairs(text: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(text.trim())
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn custom_http_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let http = sub(config, "customHttp");
    let path = field(http, "responseUrlPath");
    let mut url = field(http, "url");
    if url.is_empty() || path.is_empty() {
        return Err(invalid("自定义 HTTP 需要填写上传地址与返回 URL 路径"));
    }
    let key = object_key(name, mime, "");
    url = url
        .replace("{filename}", &urlencode_segment(&key))
        .replace("{originalName}", &urlencode_segment(name));
    let method = field_or(http, "method", "POST").to_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| invalid("请求方法只能是 POST 或 PUT"))?;
    let headers = parse_json_pairs(&field(http, "headers"));
    let http_client = client(90_000)?;
    let mut request = http_client.request(method.clone(), &url);
    for (key, value) in &headers {
        let text = match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        request = request.header(key, text);
    }
    if method == reqwest::Method::PUT {
        if !headers.keys().any(|key| key.eq_ignore_ascii_case("content-type")) {
            request = request.header("Content-Type", mime);
        }
        request = request.body(bytes.to_vec());
    } else {
        let mut form = reqwest::blocking::multipart::Form::new();
        for (key, value) in parse_json_pairs(&field(http, "formFields")) {
            let text = match value {
                Value::String(text) => text,
                other => other.to_string(),
            };
            form = form.text(key, text);
        }
        let file_field = field_or(http, "fileField", "file");
        let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
            .file_name(key.clone())
            .mime_str(mime)
            .map_err(|error| internal(format!("构造上传内容失败：{error}")))?;
        request = request.multipart(form.part(file_field, part));
    }
    let response = request
        .send()
        .map_err(|error| internal(format!("上传失败：{error}")))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let text = response.text().unwrap_or_default();
        return Err(internal(format!("自定义 HTTP 返回 {status}：{}", truncate(&text, 300))));
    }
    if path == "$requestUrl" {
        return Ok(url);
    }
    if let Some(name) = path.strip_prefix("header.") {
        let value = response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if value.is_empty() {
            return Err(internal(format!("响应头 {name} 不存在")));
        }
        return Ok(value);
    }
    let text = response.text().unwrap_or_default();
    let data = parse_object(&text);
    read_path(&data, &path)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| internal(format!("返回内容里没有 {path}：{}", truncate(&text, 200))))
}

/* ---------------- Cloudinary / ImageKit ---------------- */

fn cloudinary_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let cloudinary = sub(config, "cloudinary");
    let cloud = field(cloudinary, "cloudName");
    let preset = field(cloudinary, "uploadPreset");
    if cloud.is_empty() || preset.is_empty() {
        return Err(invalid("Cloudinary 需要填写 Cloud Name 与 Upload Preset"));
    }
    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(name.to_string())
        .mime_str(mime)
        .map_err(|error| internal(format!("构造上传内容失败：{error}")))?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("upload_preset", preset);
    let folder = field(cloudinary, "folder");
    if !folder.is_empty() {
        form = form.text("folder", folder);
    }
    let response = client(90_000)?
        .post(format!(
            "https://api.cloudinary.com/v1_1/{}/image/upload",
            urlencode_segment(&cloud)
        ))
        .multipart(form)
        .send()
        .map_err(|error| internal(format!("上传到 Cloudinary 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    let data = parse_object(&text);
    if let Some(url) = read_path(&data, "secure_url").and_then(Value::as_str) {
        return Ok(url.to_string());
    }
    Err(internal(format!("Cloudinary 未返回图片地址（{status}）：{}", truncate(&text, 300))))
}

fn imagekit_upload(config: &Value, bytes: &[u8], name: &str, mime: &str) -> Result<String, RpcError> {
    let imagekit = sub(config, "imagekit");
    let private_key = field(imagekit, "privateKey");
    if private_key.is_empty() {
        return Err(invalid("ImageKit 需要填写 Private Key"));
    }
    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(name.to_string())
        .mime_str(mime)
        .map_err(|error| internal(format!("构造上传内容失败：{error}")))?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("fileName", object_key(name, mime, ""));
    let folder = field(imagekit, "folder");
    if !folder.is_empty() {
        form = form.text("folder", folder);
    }
    let response = client(90_000)?
        .post("https://upload.imagekit.io/api/v1/files/upload")
        .header("Authorization", basic_auth(&private_key, ""))
        .multipart(form)
        .send()
        .map_err(|error| internal(format!("上传到 ImageKit 失败：{error}")))?;
    let (status, text) = response_text(response)?;
    let data = parse_object(&text);
    if let Some(url) = read_path(&data, "url").and_then(Value::as_str) {
        return Ok(url.to_string());
    }
    Err(internal(format!("ImageKit 未返回图片地址（{status}）：{}", truncate(&text, 300))))
}

fn imagekit_check(config: &Value) -> Result<(bool, String, Value), RpcError> {
    let private_key = field(sub(config, "imagekit"), "privateKey");
    if private_key.is_empty() {
        return Ok((false, "请填写 Private Key".to_string(), json!({})));
    }
    let response = client(20_000)?
        .get("https://api.imagekit.io/v1/files?limit=1")
        .header("Authorization", basic_auth(&private_key, ""))
        .send()
        .map_err(|error| internal(format!("请求 ImageKit 失败：{error}")))?;
    let status = response.status().as_u16();
    Ok((
        (200..300).contains(&status),
        if (200..300).contains(&status) { "连接正常".to_string() } else { format!("ImageKit 返回 {status}") },
        json!({}),
    ))
}

/// 供 main 使用：避免未使用的告警
pub fn _unused(_: &App) {}
