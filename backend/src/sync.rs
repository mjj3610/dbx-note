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

fn root_of(app: &App) -> PathBuf {
    app.root
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| app.data_dir.join("workspace"))
}

/// 统一的 git 调用；返回 (成功?, stdout, stderr)
fn git(root: &PathBuf, args: &[&str]) -> (bool, String, String) {
    let mut command = Command::new("git");
    // core.quotepath=false：中文路径原样输出，不转成 \\351 转义
    command
        .arg("-C")
        .arg(root)
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args);
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

fn fail(detail: &str, fallback: &str) -> RpcError {
    let message = if detail.is_empty() { fallback } else { detail };
    RpcError::internal(message.to_string())
}

/// 判断 git 报出的仓库根是否就是工作区本身
///
/// git 在 Windows 上回的是 `D:/a/b` 这种正斜杠形式，盘符大小写也不稳定；
/// 工作区根还可能是相对路径。因此先做字面归一比较，不等再各自 canonicalize 比一次。
fn same_path(reported: &str, root: &Path) -> bool {
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

/// 是否是需要注入 token 的托管平台
fn token_prefix(provider: &str) -> Option<&'static str> {
    match provider {
        "github" => Some("x-access-token"),
        "gitee" | "gitlab" | "gitea" => Some("oauth2"),
        _ => None,
    }
}

/// 把 token 拼进 https 地址（只在调用时使用，不写进 .git/config）
fn authorized_url(url: &str, provider: &str, token: &str) -> Option<String> {
    if token.trim().is_empty() || !url.starts_with("https://") {
        return None;
    }
    let prefix = token_prefix(provider)?;
    let rest = url.trim_start_matches("https://");
    Some(format!("https://{prefix}:{token}@{rest}"))
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
        state["remote"] = Value::String(remote);
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

    if !branch.is_empty() {
        let upstream = format!("origin/{branch}...HEAD");
        let (ok, counts, _) = git(&root, &["rev-list", "--left-right", "--count", &upstream]);
        if ok {
            let (ahead, behind) = parse_ahead_behind(&counts);
            state["ahead"] = json!(ahead);
            state["behind"] = json!(behind);
        }
    }

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
    state["provider"] = config.get("provider").cloned().unwrap_or(json!("github"));
    state["autoCommit"] = config.get("autoCommit").cloned().unwrap_or(json!(false));
    state["hasToken"] = json!(!config
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .is_empty());

    Ok(state)
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

/// 提交全部改动；没有改动时返回 committed=false，不视为错误
pub fn commit(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
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
    if porcelain.is_empty() {
        return Ok(json!({ "committed": false, "message": "没有需要提交的改动" }));
    }
    let (committed, _, err) = git(&root, &["commit", "-m", &message]);
    if !committed {
        return Err(fail(&err, "git commit 失败"));
    }
    Ok(json!({ "committed": true, "message": message }))
}

/// 拉取远端（保留本地未提交改动，不做强推/强拉）
pub fn pull(app: &App) -> RpcResult {
    let root = root_of(app);
    let (_, branch, _) = git(&root, &["branch", "--show-current"]);
    let branch = if branch.is_empty() { "main".to_string() } else { branch };
    let config = load_options(app);
    let provider = config.get("provider").and_then(Value::as_str).unwrap_or("github");
    let token = config.get("token").and_then(Value::as_str).unwrap_or_default();
    let (_, remote, _) = git(&root, &["remote", "get-url", "origin"]);
    let url = authorized_url(&remote, provider, token).unwrap_or_else(|| "origin".to_string());
    let (ok, out, err) = git(&root, &["pull", "--no-rebase", "--autostash", &url, &branch]);
    if !ok {
        return Err(fail(&err, "git pull 失败"));
    }
    Ok(json!({ "ok": true, "output": out }))
}

/// 推送到远端，首次自动建立 upstream
pub fn push(app: &App) -> RpcResult {
    let root = root_of(app);
    let (_, branch, _) = git(&root, &["branch", "--show-current"]);
    let branch = if branch.is_empty() { "main".to_string() } else { branch };
    let config = load_options(app);
    let provider = config.get("provider").and_then(Value::as_str).unwrap_or("github");
    let token = config.get("token").and_then(Value::as_str).unwrap_or_default();
    let (_, remote, _) = git(&root, &["remote", "get-url", "origin"]);
    match authorized_url(&remote, provider, token) {
        // 带 token 时不写 upstream，避免把凭据落到 .git/config
        Some(url) => {
            let (ok, out, err) = git(&root, &["push", &url, &branch]);
            if !ok {
                return Err(fail(&err, "git push 失败"));
            }
            return Ok(json!({ "ok": true, "output": out }));
        }
        None => {}
    }
    let (ok, out, err) = git(&root, &["push", "-u", "origin", &branch]);
    if !ok {
        return Err(fail(&err, "git push 失败"));
    }
    Ok(json!({ "ok": true, "output": out }))
}
