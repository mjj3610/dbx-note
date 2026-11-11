//! 云同步（基于本机 Git）
//!
//! NoteGen 的同步是把工作区当成 Git 仓库推到远端（GitHub / GitLab / Gitee 都行），
//! 这里做同样的事：Sidecar 直接调用本机 `git`，插件页面不接触网络与凭据。
//!
//! 设计约束：
//! - 只执行「读状态 / add / commit / pull / push / 设置 remote」这类可预期命令，
//!   不做 `reset --hard`、`clean -fd` 等破坏性操作；
//! - 没有 git 或不是仓库时返回结构化状态，不抛异常，前端据此提示如何初始化；
//! - 认证沿用本机已配置的凭据（credential helper / SSH key），插件不存储任何 token。

use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{params as sql_params, OptionalExtension};
use serde_json::{json, Value};

use crate::{param_str, App, RpcError, RpcResult};
use crate::storesync;

/// 同步配置存在 settings 表里（与 MCP 配置同样的做法）
const OPTIONS_KEY: &str = "app.sync";

pub(crate) fn root_of(app: &App) -> PathBuf {
    app.root
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| app.data_dir.join("workspace"))
}

/// 统一的 git 调用；返回 (成功?, stdout, stderr)
pub(crate) fn git(root: &PathBuf, args: &[&str]) -> (bool, String, String) {
    let mut command = Command::new("git");
    // core.quotepath=false：中文路径原样输出，不转成 \\351 转义
    command
        .arg("-C")
        .arg(root)
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args);
    apply_git_env(&mut command);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：避免每次调用弹一下黑框
        command.creation_flags(0x0800_0000);
    }
    match command.output() {
        Ok(output) => (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ),
        Err(error) => (false, String::new(), format!("{error}")),
    }
}

/// git 子进程的环境约束
///
/// - `GIT_TERMINAL_PROMPT=0`：没有凭据时立刻失败，而不是卡在「输入用户名密码」上。
///   `sync/compare` 现在会在打开笔记时同步执行，一次等待输入就等于界面卡死；
/// - 关掉 git 的交互式编辑器 / 分页器，防止任何子命令等待终端输入；
/// - **不要设置 `GIT_ASKPASS=echo`**：git 会把提示语本身当成用户名/密码提交给远端。
///   v0.5.7 里 Gitee 报的 `Username for 'https: Incorrect username or password`
///   就是 `echo "Username for 'https://gitee.com': "` 被当作凭据发出去后，
///   Gitee 把这段提示语回显在错误信息里。没有凭据时应当直接失败，让前端提示用户补令牌。
fn apply_git_env(command: &mut Command) {
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_PAGER", "cat")
        .env("GIT_EDITOR", "true")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS");
}

/// 与 `git()` 相同，但 stdout 原样返回字节
///
/// 拉取笔记正文必须按字节处理：附件、图片等二进制文件不能走 `String::from_utf8_lossy`，
/// 否则一个字节的替换就会破坏文件。
pub(crate) fn git_bytes(root: &PathBuf, args: &[&str]) -> (bool, Vec<u8>, String) {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args);
    apply_git_env(&mut command);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    match command.output() {
        Ok(output) => (
            output.status.success(),
            output.stdout,
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ),
        Err(error) => (false, Vec::new(), format!("{error}")),
    }
}

/// 把 `origin/<branch>` 跟踪引用指到指定提交
///
/// `git pull <url> <branch>` / `git push <url> <branch>` 只写 `FETCH_HEAD`，
/// 不更新 `refs/remotes/origin/*`；而 `sync/status` 是用该引用算 ahead/behind 的，
/// 不修这一步就会一直显示「没有远端更新」，打开即拉取也就永远不触发。
pub(crate) fn update_tracking_ref(root: &PathBuf, branch: &str, sha: &str) {
    if branch.is_empty() || sha.is_empty() {
        return;
    }
    let reference = format!("refs/remotes/origin/{branch}");
    let (ok, _, _) = git(root, &["update-ref", &reference, sha]);
    if !ok {
        // 引用写到一半失败不影响本次同步结果，仅影响状态展示，忽略即可
    }
}

/// git 是否可用
fn git_version() -> Option<String> {
    let mut command = Command::new("git");
    command.arg("--version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn fail(detail: &str, fallback: &str) -> RpcError {
    let message = if detail.is_empty() { fallback } else { detail };
    RpcError::internal(message.to_string())
}

/**
 * 把 git 原始输出加工成「可以直接展示在界面上」的错误文案。
 *
 * 远端清单拉取失败时，前端要把 message 显示到文件树顶部的状态条里；
 * 而 git 的 stderr 在认证异常时可能回显带令牌的 URL，直接外泄到 UI 有安全风险。
 * 因此统一在这里做两件事：补一句可读的兜底原因、把明文与 URL 编码后的令牌都打码。
 *
 * @param detail   git 原始 stderr；空串时使用 fallback
 * @param fallback 兜底文案
 * @param token    当前保存的私人令牌（明文，仅用于匹配替换，不会写回任何地方）
 * @returns 已脱敏、可直接展示的错误文案
 */
fn redact_detail(detail: &str, fallback: &str, token: &str) -> String {
    let raw = fail(detail, fallback).message;
    sanitize(raw.as_str(), token)
}

/**
 * `redact_detail` 的 RPC 封装：从配置里读取令牌后生成 RpcError。
 * 供 `gitsync::fetch_snapshot` 的全部失败分支复用，避免逐个调用点漏脱敏。
 */
pub(crate) fn redact_error(app: &App, detail: &str, fallback: &str) -> RpcError {
    let token = load_options(app)
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    RpcError::internal(redact_detail(detail, fallback, &token))
}

/// 判断 git 报出的仓库根是否就是工作区本身
///
/// git 在 Windows 上回的是 `D:/a/b` 这种正斜杠形式，盘符大小写也不稳定；
/// 工作区根还可能是相对路径。因此先做字面归一比较，不等再各自 canonicalize 比一次。
pub(crate) fn same_path(reported: &str, root: &Path) -> bool {
    fn normalize(value: &str) -> String {
        value
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .trim_end_matches('/')
            .to_lowercase()
    }
    if normalize(reported) == normalize(&root.to_string_lossy()) {
        return true;
    }
    match (std::fs::canonicalize(reported), std::fs::canonicalize(root)) {
        (Ok(reported_abs), Ok(root_abs)) => {
            normalize(&reported_abs.to_string_lossy()) == normalize(&root_abs.to_string_lossy())
        }
        _ => false,
    }
}

/// 解析 `rev-list --left-right --count a...b` 的 "behind\tahead"
fn parse_ahead_behind(text: &str) -> (i64, i64) {
    let mut parts = text.split_whitespace();
    let behind = parts.next().and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
    (ahead, behind)
}

fn default_options() -> Value {
    json!({
        "provider": "github",
        "token": "",
        // 可选：Gitee 私人令牌需要账号名当用户名，留空时按 oauth2 / 仓库 owner 依次尝试
        "gitUsername": "",
        "autoCommit": false,
        "messageTemplate": "",
        // 对象存储 / WebDAV / 自托管这三条通道不走 git，配置单独存
        "store": storesync::default_store_config(),
    })
}

pub(crate) fn load_options(app: &App) -> Value {
    let stored = (|| -> Option<Value> {
        let conn = app.db.lock().ok()?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?",
                sql_params![OPTIONS_KEY],
                |row| row.get(0),
            )
            .optional()
            .ok()?;
        raw.and_then(|text| serde_json::from_str(&text).ok())
    })();

    let mut merged = default_options();
    if let Some(value) = stored {
        if let Some(object) = value.as_object() {
            for (key, item) in object {
                merged[key] = item.clone();
            }
        }
    }
    merged
}

pub(crate) fn save_options(app: &App, options: &Value) -> Result<(), RpcError> {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        sql_params![OPTIONS_KEY, options.to_string(), crate::now_ms()],
    )?;
    Ok(())
}

/// 读取 / 保存同步配置（provider、token、自动提交、提交信息模板）
pub fn options(app: &App) -> RpcResult {
    let mut value = load_options(app);
    // token 不回传给前端全量内容，只给是否存在与掩码
    let token = value.get("token").and_then(Value::as_str).unwrap_or_default().to_string();
    value["hasToken"] = json!(!token.is_empty());
    value["tokenMask"] = json!(if token.is_empty() {
        String::new()
    } else {
        // 按字符切分，避免用户粘贴非 ASCII 内容时切到 utf8 边界崩掉
        let chars: Vec<char> = token.chars().collect();
        let head: String = chars.iter().take(4).collect();
        let tail: String = chars.iter().skip(chars.len().saturating_sub(2)).collect();
        format!("{head}••••{tail}")
    });
    value["token"] = json!("");
    // 对象存储 / WebDAV / 自托管里面的密钥同样只回传掩码
    storesync::mask_store(&mut value);
    Ok(json!({ "options": value }))
}

pub fn save_settings(app: &App, params: &Value) -> RpcResult {
    let mut current = load_options(app);
    let provider = param_str(params, "provider");
    if !provider.is_empty() {
        current["provider"] = json!(provider);
    }
    // token 传空字符串表示「保持原样」，传 clear=true 才清空
    let token = param_str(params, "token");
    let clear = params.get("clearToken").and_then(Value::as_bool).unwrap_or(false);
    if clear {
        current["token"] = json!("");
    } else if !token.trim().is_empty() {
        current["token"] = json!(token.trim());
    }
    // 平台用户名可显式留空，所以这里用 Some(...) 判断而不是判空
    if let Some(username) = params.get("gitUsername").and_then(Value::as_str) {
        current["gitUsername"] = json!(username.trim());
    }
    if let Some(value) = params.get("autoCommit").and_then(Value::as_bool) {
        current["autoCommit"] = json!(value);
    }
    let template = param_str(params, "messageTemplate");
    if !template.is_empty() {
        current["messageTemplate"] = json!(template);
    }
    // 对象存储 / WebDAV / 自托管的配置一起存进来（密钥留空表示保持原样）
    if let Some(store) = params.get("store") {
        storesync::merge_store(&mut current, store);
    }
    save_options(app, &current)?;
    options(app)
}

/* ---------------- 同步运行状态（把后台静默失败暴露出来） ---------------- */

/// 自动同步在后台静默执行，前端 catch 掉异常后用户只看到「自动同步跑过了」，
/// 却不知道推送一直认证失败。这里落最近一次结果，`sync/status` 带回设置页展示。
const STATE_KEY: &str = "app.sync.state";

fn load_state(app: &App) -> Value {
    (|| -> Option<Value> {
        let conn = app.db.lock().ok()?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?",
                sql_params![STATE_KEY],
                |row| row.get(0),
            )
            .optional()
            .ok()?;
        raw.and_then(|text| serde_json::from_str(&text).ok())
    })()
    .unwrap_or_else(|| json!({}))
}

fn write_state(app: &App, state: &Value) {
    if let Ok(conn) = app.db.lock() {
        let _ = conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            sql_params![STATE_KEY, state.to_string(), crate::now_ms()],
        );
    }
}

/// git 输出里可能回显令牌，统一打码后再写进状态 / 返回前端
pub(crate) fn sanitize(text: &str, token: &str) -> String {
    let mut out = text.to_string();
    if !token.is_empty() {
        out = out.replace(token, "***");
        let encoded = urlencode(token);
        if encoded != token {
            out = out.replace(&encoded, "***");
        }
    }
    out
}

fn record_failure(app: &App, stage: &str, detail: &str) {
    let mut state = load_state(app);
    state["lastError"] = json!(detail);
    state["lastErrorAt"] = json!(crate::now_ms());
    state["lastErrorStage"] = json!(stage);
    write_state(app, &state);
}

fn record_success(app: &App, stage: &str) {
    let mut state = load_state(app);
    state["lastError"] = json!("");
    state["lastErrorAt"] = json!(0);
    state["lastErrorStage"] = json!("");
    state["lastSuccessAt"] = json!(crate::now_ms());
    state["lastSuccessStage"] = json!(stage);
    write_state(app, &state);
}

fn current_token(app: &App) -> String {
    load_options(app)
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/* ---------------- 认证 URL ---------------- */

/// 是否是需要注入 token 的托管平台
fn token_prefix(provider: &str) -> Option<&'static str> {
    match provider {
        "github" => Some("x-access-token"),
        "gitee" | "gitlab" | "gitea" => Some("oauth2"),
        _ => None,
    }
}

/// URL 编码：令牌里出现 `+ / = @ : #` 等字符时不编码会把地址切坏
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 界面上显示的掩码（d350••••1c / d350****1c）不是有效凭据
fn looks_masked(token: &str) -> bool {
    token.contains('•') || token.contains('*') || token.contains('…')
}

/// 取 URL 主机名（兼容已带 userinfo 的 origin）
fn remote_host(url: &str) -> String {
    let raw = url.trim();
    let after_scheme = raw.split_once("://").map(|(_, rest)| rest).unwrap_or(raw);
    let authority = after_scheme.split('/').next().unwrap_or_default();
    authority
        .rsplit('@')
        .next()
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// 取 URL 里的仓库所有者（Gitee 私人令牌常用它当用户名）
fn remote_owner(url: &str) -> String {
    let raw = url.trim();
    let after_scheme = raw.split_once("://").map(|(_, rest)| rest).unwrap_or(raw);
    let mut parts = after_scheme.split('/');
    let _ = parts.next();
    parts.next().unwrap_or_default().to_string()
}

/// 按远端主机判定实际平台
///
/// v0.5.7 只信任设置里保存的 `provider`：默认 `github`，用户即使把远端填成
/// `https://gitee.com/...` 也会拼出 `x-access-token:...@gitee.com`，Gitee 直接拒绝。
/// 平台必须与地址一致，自建 Gitea / GitLab 再回退到用户选的平台。
pub(crate) fn provider_for_url(url: &str, configured: &str) -> String {
    let host = remote_host(url);
    if host == "gitee.com" || host.ends_with(".gitee.com") {
        return "gitee".to_string();
    }
    if host == "github.com" || host.ends_with(".github.com") {
        return "github".to_string();
    }
    if host == "gitlab.com" || host.ends_with(".gitlab.com") {
        return "gitlab".to_string();
    }
    configured.trim().to_ascii_lowercase()
}

fn build_authorized_url(
    url: &str,
    provider: &str,
    token: &str,
    username: &str,
) -> Option<String> {
    let token = token.trim();
    if token.is_empty() || looks_masked(token) || !url.trim().starts_with("https://") {
        return None;
    }
    let prefix = token_prefix(provider)?;
    let rest = url.trim().trim_start_matches("https://");
    // 用户可能已经把凭据写进 origin，去掉旧 userinfo，避免拼出两段
    let rest = rest.rsplit_once('@').map(|(_, tail)| tail).unwrap_or(rest);
    let user = if username.trim().is_empty() { prefix } else { username.trim() };
    Some(format!(
        "https://{}:{}@{}",
        urlencode(user),
        urlencode(token),
        rest
    ))
}

/// 把 token 拼进 https 地址（只在调用时使用，不写进 .git/config）
///
/// 保留给 `githistory` 等只做单次 fetch 的调用点；多候选重试请用 `auth_plan`。
pub(crate) fn authorized_url(url: &str, provider: &str, token: &str) -> Option<String> {
    let effective = provider_for_url(url, provider);
    build_authorized_url(url, &effective, token, "")
}

/// 一次同步可用的认证地址清单
pub(crate) struct AuthPlan {
    /// 依次尝试；为空表示没有可用令牌，交回 `origin` + 本机凭据
    pub urls: Vec<String>,
    pub provider: String,
    pub has_token: bool,
    /// 保存的是界面掩码而不是真实令牌
    pub masked_token: bool,
    pub username: String,
}

impl AuthPlan {
    /// 真正执行命令时用的目标列表
    pub fn targets(&self) -> Vec<String> {
        if self.urls.is_empty() {
            vec!["origin".to_string()]
        } else {
            self.urls.clone()
        }
    }
}

/// 按配置 + 远端地址生成认证候选
///
/// Gitee 私人令牌对用户名敏感：官方允许「账号名 / oauth2 / gitee.com」三种写法，
/// 不同时期生成的令牌表现不一致。按 自定义账号名 → oauth2 → 仓库 owner 依次尝试，
/// 只在认证失败时换下一个，避免每次同步都多打几次网络请求。
pub(crate) fn auth_plan(app: &App, remote: &str) -> AuthPlan {
    let config = load_options(app);
    let configured = config.get("provider").and_then(Value::as_str).unwrap_or("github");
    let provider = provider_for_url(remote, configured);
    let token = config
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let custom = config
        .get("gitUsername")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut plan = AuthPlan {
        urls: Vec::new(),
        provider: provider.clone(),
        has_token: !token.is_empty(),
        masked_token: looks_masked(&token),
        username: String::new(),
    };
    if token.is_empty() || plan.masked_token || !remote.trim().starts_with("https://") {
        return plan;
    }
    let mut users: Vec<String> = Vec::new();
    if provider == "gitee" {
        if !custom.is_empty() {
            users.push(custom.clone());
        }
        users.push("oauth2".to_string());
        let owner = remote_owner(remote);
        if !owner.is_empty() && owner != custom {
            users.push(owner);
        }
    } else {
        users.push(if custom.is_empty() {
            token_prefix(&provider).unwrap_or("oauth2").to_string()
        } else {
            custom
        });
    }
    users.dedup();
    for user in &users {
        if let Some(url) = build_authorized_url(remote, &provider, &token, user) {
            plan.urls.push(url);
        }
    }
    plan.username = users.first().cloned().unwrap_or_default();
    plan
}

/// 是否是「换一个用户名再试一次」有意义的错误
fn is_auth_failure(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("authentication failed")
        || lower.contains("incorrect username or password")
        || lower.contains("access token")
        || lower.contains("could not read username")
        || lower.contains("403")
        || lower.contains("401")
}

/// 把 git 的原始报错翻译成用户能采取行动的话
fn friendly_auth_error(detail: &str, plan: &AuthPlan) -> String {
    if plan.masked_token {
        return format!("保存的访问令牌是界面上的掩码，请重新粘贴完整令牌后再试。\n{detail}");
    }
    if !plan.has_token {
        return format!(
            "尚未配置访问令牌，本机 git 凭据也没能通过认证。请在「访问令牌」中粘贴 {} 私人令牌（Gitee 需勾选 projects 权限）。\n{detail}",
            plan.provider
        );
    }
    if is_auth_failure(detail) {
        return format!(
            "远端认证失败：令牌可能已过期、权限不足（Gitee 需勾选 projects），或平台与远端地址不匹配。可点「测试连接」进一步定位。\n{detail}"
        );
    }
    detail.to_string()
}

/// 工作区必须是自己的 Git 仓库根，否则 `git add -A` 会误提交外层仓库的改动
fn require_repo(root: &PathBuf) -> Result<(), RpcError> {
    let (ok, inside, _) = git(root, &["rev-parse", "--is-inside-work-tree"]);
    if !ok || inside.trim() != "true" {
        return Err(RpcError::invalid("当前工作区还没有初始化 Git 仓库"));
    }
    let (has_top, toplevel, _) = git(root, &["rev-parse", "--show-toplevel"]);
    if !has_top || !same_path(&toplevel, root) {
        return Err(RpcError::invalid(
            "当前工作区不是独立的 Git 仓库（可能位于其它仓库的子目录），改动无法被正确检测",
        ));
    }
    Ok(())
}

/// 被 .gitignore 忽略掉的笔记文件：这类改动 `git add -A` 永远看不到
///
/// 用 `ls-files --others --ignored` 而不是 `status --ignored`：后者对整个被忽略的目录
/// 只回一行 `!! notes/`，扩展名过滤会漏掉；这条命令会展开到每一个具体文件。
fn ignored_note_files(root: &PathBuf) -> Vec<String> {
    let (_, out, _) = git(
        root,
        &["ls-files", "--others", "--ignored", "--exclude-standard"],
    );
    out.lines()
        .map(|line| line.trim().trim_matches('"').to_string())
        .filter(|path| {
            let ext = path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
            matches!(ext.as_str(), "md" | "markdown" | "txt" | "mdx")
        })
        .take(20)
        .collect()
}

fn ahead_behind(root: &PathBuf, branch: &str) -> (i64, i64) {
    if branch.is_empty() {
        return (0, 0);
    }
    let upstream = format!("origin/{branch}...HEAD");
    let (ok, counts, _) = git(root, &["rev-list", "--left-right", "--count", &upstream]);
    if ok {
        parse_ahead_behind(&counts)
    } else {
        (0, 0)
    }
}

/// 当前分支名
///
/// `git branch --show-current` 在「还没有任何提交」的空仓库里返回空串，
/// 这时用 `symbolic-ref` 读 HEAD 指向，仍能拿到 `main` / `master` 的真实名字，
/// 避免回退成写死的 `main` 后与本地分支不一致。
pub(crate) fn current_branch(root: &PathBuf) -> String {
    let (ok, name, _) = git(root, &["branch", "--show-current"]);
    if ok && !name.trim().is_empty() {
        return name.trim().to_string();
    }
    let (ok, symbolic, _) = git(root, &["symbolic-ref", "--short", "HEAD"]);
    if ok && !symbolic.trim().is_empty() {
        return symbolic.trim().to_string();
    }
    "main".to_string()
}

/// 同步状态总览
pub fn status(app: &App) -> RpcResult {
    let root = root_of(app);
    let version = git_version();
    let mut state = json!({
        "available": version.is_some(),
        "gitVersion": version.clone().unwrap_or_default(),
        "root": root.to_string_lossy(),
        "isRepo": false,
        "branch": "",
        "remote": "",
        "ahead": 0,
        "behind": 0,
        "changed": Vec::<String>::new(),
        "lastCommit": "",
        "lastCommitAt": "",
    });
    let Some(_) = version else {
        return Ok(state);
    };

    let (ok, inside, _) = git(&root, &["rev-parse", "--is-inside-work-tree"]);
    if !ok || inside.trim() != "true" {
        return Ok(state);
    }
    // 光看 `--is-inside-work-tree` 不够：工作区位于别的仓库子目录时它同样返回 true，
    // 那样会把笔记提交进上层仓库（数据归属错误）。必须确认工作区自己就是仓库根。
    let (has_top, toplevel, _) = git(&root, &["rev-parse", "--show-toplevel"]);
    if !has_top || !same_path(&toplevel, &root) {
        return Ok(state);
    }
    state["isRepo"] = Value::Bool(true);

    let (_, branch, _) = git(&root, &["branch", "--show-current"]);
    state["branch"] = Value::String(branch.clone());

    let (has_remote, remote, _) = git(&root, &["remote", "get-url", "origin"]);
    if has_remote {
        state["remote"] = Value::String(remote.clone());
    }

    let (_, porcelain, _) = git(&root, &["status", "--porcelain=v1", "-uall"]);
    let changed: Vec<String> = porcelain
        .lines()
        .take(200)
        .map(|line| line.chars().skip(3).collect::<String>())
        // 路径含空格时 git 会整体加引号，这里去掉
        .map(|line| line.trim().trim_matches('"').to_string())
        .filter(|line| !line.trim().is_empty())
        .collect();
    state["changed"] = json!(changed);

    let (ahead, behind) = ahead_behind(&root, &branch);
    state["ahead"] = json!(ahead);
    state["behind"] = json!(behind);

    let (has_commit, log, _) = git(&root, &["log", "-1", "--pretty=format:%h%x09%s%x09%ad", "--date=format:%Y-%m-%d %H:%M"]);
    if has_commit {
        let mut parts = log.split('\t');
        state["lastCommit"] = Value::String(parts.next().unwrap_or_default().to_string());
        let subject = parts.next().unwrap_or_default();
        let at = parts.next().unwrap_or_default();
        state["lastCommitMessage"] = Value::String(subject.to_string());
        state["lastCommitAt"] = Value::String(at.to_string());
    }

    let config = load_options(app);
    let configured = config.get("provider").and_then(Value::as_str).unwrap_or("github");
    let plan = auth_plan(app, &remote);
    state["provider"] = json!(configured);
    // 实际生效的平台由远端地址决定：填了 gitee.com 却还选着 GitHub 时也能一眼看出
    state["effectiveProvider"] = json!(plan.provider);
    state["authUsername"] = json!(plan.username);
    state["autoCommit"] = config.get("autoCommit").cloned().unwrap_or(json!(false));
    state["hasToken"] = json!(plan.has_token);
    state["maskedToken"] = json!(plan.masked_token);
    let ignored = ignored_note_files(&root);
    state["ignored"] = json!(ignored);
    state["ignoredCount"] = json!(ignored.len());

    let sync_state = load_state(app);
    state["lastError"] = sync_state.get("lastError").cloned().unwrap_or(json!(""));
    state["lastErrorAt"] = sync_state.get("lastErrorAt").cloned().unwrap_or(json!(0));
    state["lastErrorStage"] = sync_state.get("lastErrorStage").cloned().unwrap_or(json!(""));
    state["lastSuccessAt"] = sync_state.get("lastSuccessAt").cloned().unwrap_or(json!(0));
    state["lastSuccessStage"] = sync_state.get("lastSuccessStage").cloned().unwrap_or(json!(""));

    Ok(state)
}

/// 给新仓库补一条 `.gitignore`
///
/// `.dbx-note/` 存的是同步状态（对象存储通道的基线），不应该被当成笔记提交；
/// 已经有 .gitignore 且写了这条就原样不动，避免覆盖用户自己的规则。
fn ensure_gitignore(root: &PathBuf) {
    const ENTRY: &str = ".dbx-note/";
    let path = root.join(".gitignore");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|line| line.trim() == ENTRY) {
        return;
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# DBX 笔记同步状态（插件自动生成）\n");
    next.push_str(ENTRY);
    next.push('\n');
    let _ = std::fs::write(path, next);
}

/// 初始化仓库（可选同时设置 origin）
pub fn init(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    if git_version().is_none() {
        return Err(RpcError::internal("未找到 git，请先安装 Git 并加入 PATH"));
    }
    std::fs::create_dir_all(&root)?;
    let (ok, _, err) = git(&root, &["init"]);
    if !ok {
        return Err(fail(&err, "git init 失败"));
    }
    ensure_gitignore(&root);
    let url = param_str(params, "url");
    if !url.trim().is_empty() {
        let (added, _, err) = git(&root, &["remote", "add", "origin", url.trim()]);
        if !added {
            // 已存在则改地址
            let (updated, _, err2) = git(&root, &["remote", "set-url", "origin", url.trim()]);
            if !updated {
                return Err(fail(&err2, &err));
            }
        }
    }
    status(app)
}

/// 设置/更新远端地址
pub fn set_remote(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    let url = param_str(params, "url");
    if url.trim().is_empty() {
        return Err(RpcError::invalid("远端地址不能为空"));
    }
    let (ok, _, err) = git(&root, &["remote", "set-url", "origin", url.trim()]);
    if !ok {
        let (added, _, err2) = git(&root, &["remote", "add", "origin", url.trim()]);
        if !added {
            return Err(fail(&err2, &err));
        }
    }
    status(app)
}

/// 提交全部改动；没有改动时返回 committed=false + 可解释的原因
///
/// v0.5.7 只看 `status --porcelain` 是否为空，用户会遇到两种「明明改了却说没改动」：
/// 1. 自动同步已经在保存后 5 秒把改动提交了，本地只剩未推送的 commit；
/// 2. 笔记文件被 .gitignore 忽略，`git add -A` 根本没纳入。
/// 这里分别返回 reason=committed / ignored，前端按级别提示而不是一律弹绿色成功。
pub fn commit(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    require_repo(&root)?;
    let message = {
        let value = param_str(params, "message");
        if !value.trim().is_empty() {
            value.trim().to_string()
        } else {
            let config = load_options(app);
            let template = config
                .get("messageTemplate")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let now = chrono::Local::now();
            if template.is_empty() {
                format!("note sync {}", now.format("%Y-%m-%d %H:%M"))
            } else {
                template
                    .replace("{date}", &now.format("%Y-%m-%d").to_string())
                    .replace("{time}", &now.format("%H:%M").to_string())
                    .replace("{datetime}", &now.format("%Y-%m-%d %H:%M").to_string())
            }
        }
    };
    let (added, _, err) = git(&root, &["add", "-A"]);
    if !added {
        return Err(fail(&err, "git add 失败"));
    }
    let (_, porcelain, _) = git(&root, &["status", "--porcelain=v1"]);
    if porcelain.trim().is_empty() {
        let ignored = ignored_note_files(&root);
        let (ahead, _) = ahead_behind(&root, &current_branch(&root));
        let (reason, text) = if !ignored.is_empty() {
            (
                "ignored",
                format!(
                    "检测到 {} 个笔记文件被 .gitignore 忽略，未纳入提交（例如 {}）",
                    ignored.len(),
                    ignored[0]
                ),
            )
        } else if ahead > 0 {
            (
                "unpushed",
                format!(
                    "改动已由此前的自动同步提交到本地仓库，还有 {} 个提交没推送到远端。请点「推送」上传。",
                    ahead
                ),
            )
        } else {
            ("clean", "没有需要提交的改动".to_string())
        };
        return Ok(json!({
            "committed": false,
            "reason": reason,
            "message": text,
            "ahead": ahead,
            "ignored": ignored,
        }));
    }
    let (committed, _, err) = git(&root, &["commit", "-m", &message]);
    if !committed {
        return Err(fail(&err, "git commit 失败"));
    }
    record_success(app, "commit");
    Ok(json!({
        "committed": true,
        "reason": "committed",
        "message": message,
        "ahead": 0,
        "ignored": Vec::<String>::new(),
    }))
}

/// 拉取远端（保留本地未提交改动，不做强推/强拉）
pub fn pull(app: &App) -> RpcResult {
    let root = root_of(app);
    require_repo(&root)?;
    let branch = current_branch(&root);
    let (_, remote, _) = git(&root, &["remote", "get-url", "origin"]);
    let plan = auth_plan(app, &remote);
    let token = current_token(app);
    let targets = plan.targets();
    let mut output = String::new();
    let mut failure = String::new();
    for (index, target) in targets.iter().enumerate() {
        let (ok, out, err) = git(
            &root,
            &["pull", "--no-rebase", "--autostash", target.as_str(), branch.as_str()],
        );
        if ok {
            output = out;
            failure.clear();
            break;
        }
        failure = err;
        // 只有认证失败才换下一个候选用户名，网络 / 合并冲突不重复打远端
        if !is_auth_failure(&failure) || index + 1 == targets.len() {
            break;
        }
    }
    if !failure.is_empty() {
        let clean = sanitize(&failure, &token);
        record_failure(app, "pull", &clean);
        return Err(fail(&friendly_auth_error(&clean, &plan), "git pull 失败"));
    }
    // `pull <url> <branch>` 只写 FETCH_HEAD，同步更新跟踪引用，状态里的 ahead/behind 才准
    let (_, head, _) = git(&root, &["rev-parse", "FETCH_HEAD"]);
    update_tracking_ref(&root, &branch, head.trim());
    record_success(app, "pull");
    Ok(json!({ "ok": true, "output": output }))
}

/// 推送到远端，首次自动建立 upstream
pub fn push(app: &App) -> RpcResult {
    let root = root_of(app);
    require_repo(&root)?;
    let branch = current_branch(&root);
    let (_, remote, _) = git(&root, &["remote", "get-url", "origin"]);
    let plan = auth_plan(app, &remote);
    let token = current_token(app);
    let no_token = plan.urls.is_empty();
    let targets = plan.targets();
    let mut output = String::new();
    let mut failure = String::new();
    let mut used_target = targets.first().cloned().unwrap_or_else(|| "origin".to_string());

    for (index, target) in targets.iter().enumerate() {
        used_target = target.clone();
        let args: Vec<&str> = if no_token && index == 0 {
            // 没配令牌时交回 origin + 本机凭据，顺便建立 upstream
            vec!["push", "-u", target.as_str(), branch.as_str()]
        } else {
            // 带令牌时不写 upstream，避免把凭据落进 .git/config
            vec!["push", target.as_str(), branch.as_str()]
        };
        let (ok, out, err) = git(&root, &args);
        if ok {
            output = out;
            failure.clear();
            break;
        }
        failure = err;
        if !is_auth_failure(&failure) || index + 1 == targets.len() {
            break;
        }
    }
    if !failure.is_empty() {
        // 远端领先时先合并一次再推
        //
        // 多设备场景下「本地提交 → 远端也被别的设备推进」非常常见，
        // 直接失败会让自动同步静默停摆、本地开始分叉。这里只处理
        // 非快进这一类情况，其它错误（凭据、网络）原样抛出。
        let rejected = failure.contains("non-fast-forward")
            || failure.contains("fetch first")
            || failure.contains("rejected")
            || failure.contains("Updates were rejected");
        if rejected {
            // `-X ours`：冲突文件以本地为准
            //
            // 合并和重试都必须沿用同一个已认证地址：v0.5.7 这里写死了 origin，
            // 令牌没带过去，于是报出与第一次完全不同的认证失败。
            let (pulled, pull_out, pull_err) = git(
                &root,
                &["pull", "--no-rebase", "--autostash", "-X", "ours", used_target.as_str(), branch.as_str()],
            );
            if pulled {
                let (retried, retry_out, retry_err) =
                    git(&root, &["push", used_target.as_str(), branch.as_str()]);
                if retried {
                    output = format!("{pull_out}\n{retry_out}");
                    failure.clear();
                } else {
                    failure = retry_err;
                }
            } else {
                failure = pull_err;
            }
        }
    }
    if !failure.is_empty() {
        let clean = sanitize(&failure, &token);
        record_failure(app, "push", &clean);
        return Err(fail(&friendly_auth_error(&clean, &plan), "git push 失败"));
    }
    let (_, head, _) = git(&root, &["rev-parse", "HEAD"]);
    update_tracking_ref(&root, &branch, head.trim());
    // 推上去的版本就是新的同步基线：不收口的话下次打开会把同一批文件判成「远端更新」再拉回来
    crate::gitsync::record_base_from_head(app);
    record_success(app, "push");
    Ok(json!({ "ok": true, "output": output }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_is_derived_from_the_remote_host() {
        // 用户只填远端地址、没在平台列表里点 Gitee 时，配置里仍是默认 github
        assert_eq!(
            provider_for_url("https://gitee.com/mjj3610/dbx-notegen.git", "github"),
            "gitee"
        );
        assert_eq!(
            provider_for_url("https://github.com/user/notes.git", "gitee"),
            "github"
        );
        assert_eq!(
            provider_for_url("https://gitlab.com/group/notes.git", "s3"),
            "gitlab"
        );
        // 自建域名回退到用户选择的平台
        assert_eq!(
            provider_for_url("https://git.example.com/user/notes.git", "gitea"),
            "gitea"
        );
    }

    #[test]
    fn authorized_url_uses_the_matching_username() {
        let gitee = authorized_url(
            "https://gitee.com/mjj3610/dbx-notegen.git",
            "github",
            "d350abc1c",
        )
        .unwrap();
        assert!(gitee.starts_with("https://oauth2:d350abc1c@gitee.com/"));
        assert!(!gitee.contains("x-access-token"));

        let github = authorized_url("https://github.com/user/notes.git", "github", "ghp_123")
            .unwrap();
        assert!(github.starts_with("https://x-access-token:ghp_123@github.com/"));
    }

    #[test]
    fn token_and_username_are_url_encoded() {
        let url = build_authorized_url(
            "https://gitee.com/mjj3610/notes.git",
            "gitee",
            "a+b/c=d",
            "user@example.com",
        )
        .unwrap();
        assert!(url.contains("user%40example.com"));
        assert!(url.contains("a%2Bb%2Fc%3Dd"));
        assert_eq!(remote_owner("https://gitee.com/mjj3610/notes.git"), "mjj3610");
    }

    #[test]
    fn already_authorized_remote_is_not_double_prefixed() {
        let url = build_authorized_url(
            "https://old:secret@gitee.com/mjj3610/notes.git",
            "gitee",
            "fresh",
            "oauth2",
        )
        .unwrap();
        assert!(url.starts_with("https://oauth2:fresh@gitee.com/"));
        assert!(!url.contains("old:secret"));
    }

    #[test]
    fn masked_token_is_never_used_as_credential() {
        assert!(looks_masked("d350••••1c"));
        assert!(looks_masked("d350****1c"));
        assert!(!looks_masked("d350abcd1c"));
        assert_eq!(
            authorized_url("https://gitee.com/a/b.git", "gitee", "d350****1c"),
            None
        );
    }

    #[test]
    fn sanitize_removes_both_plain_and_encoded_token() {
        let text = "fatal: https://oauth2:s%2Be%40cret@gitee.com failed with s+e@cret";
        let clean = sanitize(text, "s+e@cret");
        assert!(!clean.contains("s+e@cret"));
        assert!(!clean.contains("s%2Be%40cret"));
    }

    /// 清单失败文案会直接渲染到 UI，明文 / 编码令牌都必须被抹掉
    #[test]
    fn redact_detail_masks_token_and_uses_fallback() {
        const TOKEN: &str = "s+e@cret";
        const FALLBACK: &str = "git fetch 失败：请检查网络与仓库凭据";
        let detail = "fatal: Authentication failed for 'https://oauth2:s%2Be%40cret@gitee.com/a/b.git/'";
        let safe = redact_detail(detail, FALLBACK, TOKEN);
        assert!(safe.contains("Authentication failed"));
        assert!(!safe.contains(TOKEN));
        assert!(!safe.contains("s%2Be%40cret"));
        assert_eq!(redact_detail("", FALLBACK, TOKEN), FALLBACK);
    }

    #[test]
    fn same_path_handles_windows_drive_case() {
        let reported = "D:/Notes/workspace";
        let root = Path::new("d:\\notes\\workspace\\");
        assert!(same_path(reported, root));
    }

    /// 构造一个带 SQLite / 工作区的 App，全部放在临时目录里
    fn test_app(dir: &Path) -> App {
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};

        let workspace = dir.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        App {
            data_dir: dir.to_path_buf(),
            root: Mutex::new(workspace),
            db: Mutex::new(crate::db::open(&dir.join("test.db")).unwrap()),
            streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "dbx-note-sync-{label}-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// 用户反馈的完整链路：改动 → 提交 → 再提交给出原因 → 连接自检 → 掩码令牌拒绝
    #[test]
    fn commit_status_and_check_cover_the_reported_flow() {
        if git_version().is_none() {
            return; // CI 没有 git 时跳过，不把环境缺失当成代码失败
        }
        let dir = temp_dir("flow");
        let app = test_app(&dir);
        let root = root_of(&app);
        init(&app, &json!({})).unwrap();
        git(&root, &["config", "user.email", "sync-test@example.com"]);
        git(&root, &["config", "user.name", "sync-test"]);

        // 第一次：真的有改动，提交成功
        std::fs::write(root.join("note.md"), "# 第一版\n").unwrap();
        let first = commit(&app, &json!({})).unwrap();
        assert_eq!(first["committed"], json!(true), "{first}");
        assert_eq!(first["reason"], json!("committed"));

        // 第二次：工作区已干净（对应用户「提交改动显示没有任何改变」）
        let second = commit(&app, &json!({})).unwrap();
        assert_eq!(second["committed"], json!(false), "{second}");
        assert!(
            second["reason"].as_str().is_some(),
            "空改动必须带回可解释的 reason：{second}"
        );

        let state = status(&app).unwrap();
        assert!(state["effectiveProvider"].as_str().is_some());
        assert!(state.get("lastError").is_some());
        assert!(state.get("ignoredCount").is_some());

        // 没有远端时连接自检应当明确报错，而不是拼出带假凭据的 URL
        assert!(check(&app).is_err());

        // 本地裸仓库模拟 https 远端：ls-remote 可以走通，说明认证计划没有误伤本机凭据
        let bare = dir.join("origin.git");
        let created = std::process::Command::new("git")
            .args(["init", "--bare"])
            .arg(&bare)
            .output();
        if created.is_ok() {
            set_remote(&app, &json!({ "url": bare.to_string_lossy() })).unwrap();
            let connected = check(&app).unwrap();
            assert_eq!(connected["ok"], json!(true), "{connected}");

            // 界面掩码被误存为令牌时必须拒绝，不能拿去拼认证 URL
            save_settings(&app, &json!({ "token": "d350****1c" })).unwrap();
            let masked = check(&app).unwrap();
            assert_eq!(masked["ok"], json!(false), "{masked}");
            assert_eq!(masked["maskedToken"], json!(true));
            assert_eq!(status(&app).unwrap()["maskedToken"], json!(true));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 连接自检：用与推送完全相同的凭据跑一次 `git ls-remote`
///
/// 让用户在设置页就能判断「令牌是否可用 / 平台是否与远端地址匹配」，
/// 不用等自动同步静默失败、也不用看 git 的原始报错去猜。
pub fn check(app: &App) -> RpcResult {
    let root = root_of(app);
    require_repo(&root)?;
    let (has_remote, remote, _) = git(&root, &["remote", "get-url", "origin"]);
    if !has_remote || remote.trim().is_empty() {
        return Err(RpcError::invalid("还没有配置远端仓库"));
    }
    let plan = auth_plan(app, &remote);
    let token = current_token(app);
    let branch = current_branch(&root);
    let base = json!({
        "provider": plan.provider,
        "effectiveProvider": plan.provider,
        "username": plan.username,
        "hasToken": plan.has_token,
        "maskedToken": plan.masked_token,
    });
    let mut result = base.clone();
    if plan.masked_token {
        let message = friendly_auth_error("当前保存的是界面掩码，不是有效令牌。", &plan);
        record_failure(app, "check", &message);
        result["ok"] = json!(false);
        result["message"] = json!(message);
        return Ok(result);
    }
    let targets = plan.targets();
    let mut failure = String::new();
    for (index, target) in targets.iter().enumerate() {
        let (ok, out, err) = git(
            &root,
            &[
                "-c",
                "http.lowSpeedLimit=1000",
                "-c",
                "http.lowSpeedTime=15",
                "ls-remote",
                "--heads",
                target.as_str(),
                branch.as_str(),
            ],
        );
        if ok {
            record_success(app, "check");
            result["ok"] = json!(true);
            result["message"] = json!(if out.trim().is_empty() {
                format!("连接成功（远端 {} 分支暂时为空，首次推送会自动创建）", branch)
            } else {
                format!("连接成功：{} 分支可访问", branch)
            });
            return Ok(result);
        }
        failure = err;
        if !is_auth_failure(&failure) || index + 1 == targets.len() {
            break;
        }
    }
    let clean = sanitize(&failure, &token);
    record_failure(app, "check", &clean);
    result["ok"] = json!(false);
    result["message"] = json!(friendly_auth_error(&clean, &plan));
    Ok(result)
}
