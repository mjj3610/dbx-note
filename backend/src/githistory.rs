//! 编辑器底栏「历史版本」：当前笔记在远端 Git 仓库的提交历史
//!
//! 对齐参考项目 `markdown/sync/history-sheet.tsx`：
//! - 只在 `github` / `gitee` / `gitlab` / `gitea` 四种 Git 托管平台且工作区是独立
//!   Git 仓库并配置了 `origin` 时可用（参考项目在 `local` / `selfHosted` 下 `return null`）；
//! - 列出该文件最近 `HISTORY_LIMIT` 条提交：完整 sha、短 sha、提交说明、作者、时间、
//!   可点开的远端 commit 链接；
//! - 恢复时按完整 sha 取该提交的文件正文；
//! - 面板顶部提供「在仓库中打开」链接。
//!
//! 参考项目直接调四家平台的 REST API；本项目工作区本身就是 Git 仓库、已有 `origin`
//! 与平台 token，用 `git fetch` + `git log <remote-ref> -- <path>` +
//! `git show <sha>:<path>` 取到的是**同一份远端提交历史**，不必再维护四套 REST 客户端，
//! 且自建 Git 服务、已 fetch 的离线历史同样可用。
//!
//! 与 0.5.2 的远端清单共用 `sync::same_path()` 判定，避免工作区没有独立 `.git` 时
//! 误读外层插件源码仓库。

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::{files, sync, App, RpcError, RpcResult};

/// 支持「历史版本」的 Git 托管平台（与参考项目 `supportsHistory` 一致）
const GIT_PROVIDERS: [&str; 4] = ["github", "gitee", "gitlab", "gitea"];
/// 面板一次最多展示的提交数（参考项目 `commits.slice(0, 10)`）
const HISTORY_LIMIT: usize = 10;
/// `git log --format` 的字段分隔符（控制字符不会出现在提交说明里）
const FIELD_SEP: char = '\u{1f}';
/// 单次恢复允许的最大正文，避免把超大历史文件塞进 JSON-RPC 响应
const MAX_HISTORY_CONTENT_BYTES: usize = 8 * 1024 * 1024;
/// 自动化回归开关：设置后跳过联网 fetch，直接用本地已有的提交对象（生产不设置）
const HISTORY_OFFLINE_ENV: &str = "DBX_NOTE_HISTORY_OFFLINE";

/// 解析后的远端仓库信息
struct RepoInfo {
    provider: String,
    /// 站点根，例如 `https://github.com`
    base_url: String,
    /// 仓库所有者（GitLab 子组会是 `group/sub` 形式）
    owner: String,
    repo: String,
    branch: String,
    /// `git log` 的起点：优先 fetch 到的 `FETCH_HEAD`，退而求其次用跟踪引用 / HEAD
    remote_ref: String,
}

/// 校验工作区是**独立**的 Git 仓库，返回其根目录
fn git_root(app: &App) -> Result<PathBuf, RpcError> {
    let root = sync::root_of(app);
    let (has_top, toplevel, _) = sync::git(&root, &["rev-parse", "--show-toplevel"]);
    if !has_top || !sync::same_path(&toplevel, &root) {
        return Err(RpcError::invalid("当前工作区不是独立的 Git 仓库"));
    }
    Ok(root)
}

/// 解析 `origin` URL，返回 (站点根, 所有者, 仓库名)
///
/// 同时兼容 `https://host/owner/repo.git`、带 userinfo 的 token URL、
/// `git@host:owner/repo.git`、GitLab 子组和自托管 Gitea 的子路径。
fn parse_remote(raw: &str) -> Option<(String, String, String)> {
    let url = raw.trim().trim_end_matches('/');
    let (host, path) = if let Some(rest) = url.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        (format!("https://{host}"), path.to_string())
    } else {
        let rest = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))?;
        let (authority, path) = rest.split_once('/')?;
        // `https://oauth2:xxxxx@example.com/...` 这类带 userinfo 的 URL，凭据不参与链接拼接
        let host = authority.rsplit('@').next().unwrap_or(authority);
        (format!("https://{host}"), path.to_string())
    };
    let trimmed = path.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<&str> = trimmed.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    let repo = (*parts.last()?).to_string();
    let owner = parts[..parts.len() - 1].join("/");
    Some((host, owner, repo))
}

/// 某个提交的远端页面地址（参考项目 `getCommitUrl`）
fn commit_url(info: &RepoInfo, sha: &str) -> String {
    let base = format!("{}/{}/{}", info.base_url, info.owner, info.repo);
    match info.provider.as_str() {
        "gitlab" => format!("{base}/-/commit/{sha}"),
        _ => format!("{base}/commit/{sha}"),
    }
}

/// 「在仓库中打开」：该文件的远端页面地址
fn blob_url(info: &RepoInfo, path: &str) -> String {
    let base = format!("{}/{}/{}", info.base_url, info.owner, info.repo);
    match info.provider.as_str() {
        "gitlab" => format!("{base}/-/blob/{}/{path}", info.branch),
        "gitea" => format!("{base}/src/branch/{}/{path}", info.branch),
        _ => format!("{base}/blob/{}/{path}", info.branch),
    }
}

/// 尝试拉一次远端，返回是否拿到 `FETCH_HEAD`。失败不算错误：仍可列已 fetch 的历史
fn fetch_remote(app: &App, root: &PathBuf, branch: &str, remote: &str, info: &RepoInfo) -> bool {
    // e2e / 自检里 origin 是不存在的示例地址，联网 fetch 会白等：直接用本地引用
    if std::env::var_os(HISTORY_OFFLINE_ENV).is_some() {
        return false;
    }
    let options = sync::load_options(app);
    let token = options
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let target = sync::authorized_url(remote, &info.provider, token)
        .unwrap_or_else(|| "origin".to_string());
    let (ok, _, error) = sync::git(
        root,
        &[
            "-c",
            "http.lowSpeedLimit=1000",
            "-c",
            "http.lowSpeedTime=15",
            "fetch",
            "--prune",
            &target,
            branch,
        ],
    );
    if !ok {
        crate::logln!("[dbx-note] 历史版本拉取远端失败（改用本地已有引用）：{error}");
        return false;
    }
    let (has_head, head, _) = sync::git(root, &["rev-parse", "FETCH_HEAD"]);
    if !has_head || head.trim().is_empty() {
        return false;
    }
    sync::update_tracking_ref(root, branch, head.trim());
    true
}

/// 选择 `git log` 的起点：远端最新 > 跟踪引用 > 本地 HEAD
fn choose_ref(root: &PathBuf, branch: &str, fetched: bool) -> String {
    if fetched {
        return "FETCH_HEAD".to_string();
    }
    let tracking = format!("origin/{branch}");
    let (exists, _, _) = sync::git(root, &["cat-file", "-e", &format!("{tracking}^{{commit}}")]);
    if exists {
        return tracking;
    }
    "HEAD".to_string()
}

/// 汇总远端仓库信息；不支持时返回带原因的错误，供 `history/status` 转成 `supported:false`
fn repo_info(app: &App) -> Result<(PathBuf, RepoInfo), RpcError> {
    let root = git_root(app)?;
    let options = sync::load_options(app);
    let configured = options
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("github");
    let (has_remote, remote, _) = sync::git(&root, &["remote", "get-url", "origin"]);
    let remote = remote.trim().to_string();
    if !has_remote || remote.is_empty() {
        return Err(RpcError::invalid("还没有配置远端仓库"));
    }
    // 平台由远端地址决定：只填了 gitee.com 地址、平台列表仍停在 github 时，
    // 历史版本也应该可用，而且 fetch 要用 Gitee 的凭据格式。
    let provider = sync::provider_for_url(&remote, configured);
    if !GIT_PROVIDERS.contains(&provider.as_str()) {
        return Err(RpcError::invalid("历史版本需要配置 GitHub / Gitee / GitLab / Gitea 同步"));
    }
    let (base_url, owner, repo) = parse_remote(&remote)
        .ok_or_else(|| RpcError::invalid("远端仓库地址无法解析"))?;
    let branch = sync::current_branch(&root);
    let branch = if branch.is_empty() { "main".to_string() } else { branch };
    let mut info = RepoInfo {
        provider,
        base_url,
        owner,
        repo,
        branch: branch.clone(),
        remote_ref: String::new(),
    };
    let fetched = fetch_remote(app, &root, &branch, &remote, &info);
    info.remote_ref = choose_ref(&root, &branch, fetched);
    Ok((root, info))
}

/// 校验笔记路径：非空、工作区内、不含 `..`
fn note_path(root: &PathBuf, path: &str) -> Result<String, RpcError> {
    if path.trim().is_empty() {
        return Err(RpcError::invalid("笔记路径不能为空"));
    }
    files::safe_join(root, path)?;
    Ok(path.replace('\\', "/"))
}

/// 把 `git log` 的一行解析成结构化提交
fn parse_commit_line(line: &str, info: &RepoInfo) -> Option<Value> {
    let fields: Vec<&str> = line.split(FIELD_SEP).collect();
    if fields.len() < 4 {
        return None;
    }
    let sha = fields[0].trim();
    if sha.is_empty() {
        return None;
    }
    Some(json!({
        "sha": sha,
        "shortSha": sha.chars().take(7).collect::<String>(),
        "author": fields[1],
        "date": fields[2],
        "message": fields[3],
        "url": commit_url(info, sha),
    }))
}

/// `history/status`：面板是否需要显示「历史版本」入口
///
/// @param app 插件运行时
/// @return `{ supported, provider, repoUrl, branch }` 或 `{ supported:false, reason }`
pub fn status(app: &App) -> RpcResult {
    match repo_info(app) {
        Ok((_, info)) => Ok(json!({
            "supported": true,
            "provider": info.provider,
            "repoUrl": format!("{}/{}/{}", info.base_url, info.owner, info.repo),
            "branch": info.branch,
        })),
        Err(error) => Ok(json!({ "supported": false, "reason": error.message })),
    }
}

/// `history/commits`：当前笔记在远端仓库的提交历史（最多 10 条）
///
/// @param params `{ path }` 工作区相对路径
/// @return `{ supported, fileUrl, commits[] }`；不支持时返回空列表与原因
pub fn commits(app: &App, params: &Value) -> RpcResult {
    let requested = crate::param_str(params, "path");
    let (root, info) = match repo_info(app) {
        Ok(value) => value,
        Err(error) => {
            return Ok(json!({ "supported": false, "reason": error.message, "commits": [] }));
        }
    };
    let path = note_path(&root, &requested)?;
    let limit = format!("-n{HISTORY_LIMIT}");
    let format = format!("--format=%H%x1f%an%x1f%aI%x1f%s");
    let args: Vec<&str> = vec!["log", &limit, &format, &info.remote_ref, "--", &path];
    let (ok, stdout, error) = sync::git(&root, &args);
    if !ok {
        crate::logln!("[dbx-note] 历史版本读取提交失败：path={path} error={error}");
        return Ok(json!({ "supported": true, "fileUrl": blob_url(&info, &path), "commits": [], "reason": error }));
    }
    let commits: Vec<Value> = stdout
        .lines()
        .filter_map(|line| parse_commit_line(line, &info))
        .collect();
    Ok(json!({
        "supported": true,
        "provider": info.provider,
        "fileUrl": blob_url(&info, &path),
        "commits": commits,
    }))
}

/// `history/content`：按完整 sha 取某次提交里该笔记的正文
///
/// @param params `{ path, sha }`；sha 只允许 40/64 位十六进制，避免拼进 `git show` 的 refspec
/// @return `{ sha, path, content, size }`
pub fn content(app: &App, params: &Value) -> RpcResult {
    let sha = crate::param_str(params, "sha");
    let valid_sha = matches!(sha.len(), 40 | 64) && sha.chars().all(|ch| ch.is_ascii_hexdigit());
    if !valid_sha {
        return Err(RpcError::invalid("历史版本 sha 不合法"));
    }
    let (root, _) = repo_info(app)?;
    let path = note_path(&root, &crate::param_str(params, "path"))?;
    let spec = format!("{sha}:{path}");
    let (ok, bytes, error) = sync::git_bytes(&root, &["show", &spec]);
    if !ok {
        return Err(sync::fail(&error, "无法读取该历史版本"));
    }
    if bytes.len() > MAX_HISTORY_CONTENT_BYTES {
        return Err(RpcError::invalid("该历史版本正文过大"));
    }
    let content = String::from_utf8_lossy(&bytes).to_string();
    Ok(json!({
        "sha": sha,
        "path": path,
        "content": content,
        "size": content.len(),
    }))
}
