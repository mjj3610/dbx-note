//! Git 通道的单文件同步
//!
//! 与 NoteGen（参考项目）的 `compareFileVersions` / `pullFile` / `pullAllRemoteLibraryFiles`
//! 同构，解决「远端改了笔记，本地进入时看不到」的问题：
//!
//! 1. 每次打开笔记先 `fetch` 一次，拿到远端最新树（参考项目是查一次 contents API）；
//! 2. 用「上次同步时记下的远端 blob」与「当前远端 blob」比对，判定该文件该拉、该推还是冲突；
//! 3. 需要拉时只写发生变化的那个文件（参考项目也只下这一个文件），写完把基线推进；
//! 4. 两边都改过时返回冲突内容，由界面弹窗让用户选保留哪边。
//!
//! 基线放在工作区 `.dbx-note/git-sync-state.json`，与对象存储通道的
//! `sync-state.json` 分开：两条通道的版本标识不同（git blob 是 SHA-1，
//! 对象存储是我们自己的 `size:sha1`），混在一起会互相判成「远端变了」。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::sync;
use crate::{param_str, App, RpcError, RpcResult};

/// 单文件同步基线（对应参考项目的 `syncedFileShas` + 每文件最后同步时间）
///
/// 放在 `.git/` 里而不是工作区：基线文件本身不能让 git 看见，
/// 否则每次拉取都会改动它 → 工作区变脏 → 自动提交 → 推上去 → 又变脏，形成自激循环。
/// 拿不到 git 目录时（理论上只在仓库损坏时）退回 `.dbx-note/`。
const STATE_FALLBACK: &str = ".dbx-note/git-sync-state.json";
const STATE_NAME: &str = "dbx-note-sync-state.json";
/// 冲突时回传给界面的单个文件内容上限，避免一次塞进几十 MB
const CONFLICT_PREVIEW_LIMIT: usize = 2 * 1024 * 1024;
/// 单文件拉取体积上限，超过按二进制处理并跳过内容回传
const MAX_PULL_BYTES: usize = 32 * 1024 * 1024;

/* ---------------- 路径与状态 ---------------- */

/// 校验并归一化相对路径
///
/// 路径来自前端，会直接拼进 `git show FETCH_HEAD:<path>`。拒绝绝对路径、`..`
/// 与以 `-` 开头的片段，避免把用户输入当成 git 选项或越出工作区。
fn normalize_rel(raw: &str) -> Result<String, RpcError> {
    let value = raw.trim().replace('\\', "/");
    if value.is_empty() {
        return Err(RpcError::invalid("路径不能为空"));
    }
    if value.starts_with('/') || value.contains(':') {
        return Err(RpcError::invalid("只支持工作区内的相对路径"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in value.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.starts_with('-') {
            return Err(RpcError::invalid("路径不合法"));
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err(RpcError::invalid("路径不合法"));
    }
    Ok(parts.join("/"))
}

/// 基线文件路径：优先放到 git 目录内，避免被当成笔记提交
fn state_path(root: &Path) -> PathBuf {
    let root_buf = root.to_path_buf();
    let (ok, git_dir, _) = sync::git(&root_buf, &["rev-parse", "--absolute-git-dir"]);
    if ok && !git_dir.trim().is_empty() {
        return PathBuf::from(git_dir.trim()).join(STATE_NAME);
    }
    root.join(STATE_FALLBACK)
}

/// 读基线；结构非法时当作空基线，不让历史脏数据阻断同步
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

/// 取某文件的基线（远端 blob sha, 上次同步时间）
fn base_of(state: &Value, rel: &str) -> Option<(String, i64)> {
    let entry = state.get("files")?.get(rel)?;
    let sha = entry.get("sha").and_then(Value::as_str)?.to_string();
    if sha.is_empty() {
        return None;
    }
    let synced_at = entry.get("syncedAt").and_then(Value::as_i64).unwrap_or(0);
    Some((sha, synced_at))
}

fn set_base(state: &mut Value, rel: &str, sha: &str, synced_at: i64) {
    let Some(files) = state.get_mut("files").and_then(Value::as_object_mut) else {
        return;
    };
    let mut entry = Map::new();
    entry.insert("sha".into(), json!(sha));
    entry.insert("syncedAt".into(), json!(synced_at));
    files.insert(rel.to_string(), Value::Object(entry));
}

fn drop_base(state: &mut Value, rel: &str) {
    if let Some(files) = state.get_mut("files").and_then(Value::as_object_mut) {
        files.remove(rel);
    }
}

/* ---------------- 远端快照 ---------------- */

struct RemoteFile {
    blob: String,
    size: u64,
}

struct Snapshot {
    head: String,
    branch: String,
    files: BTreeMap<String, RemoteFile>,
}

/// 解析 `git ls-tree -r -l` 的输出
///
/// 形如 `100644 blob 4b825dc642cb6eb9a060e54bf8d69288fbee4904      12\t日记/a.md`。
/// 先按 Tab 切出路径（路径里可能有空格），再切元信息，避免把带空格的文件名切坏。
fn parse_ls_tree(output: &str) -> BTreeMap<String, RemoteFile> {
    let mut files = BTreeMap::new();
    for line in output.lines() {
        let Some((meta, path)) = line.split_once('\t') else {
            continue;
        };
        let mut columns = meta.split_whitespace();
        let _mode = columns.next();
        let kind = columns.next().unwrap_or_default();
        if kind != "blob" {
            continue;
        }
        let Some(blob) = columns.next() else { continue };
        let size = columns
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if path.is_empty() {
            continue;
        }
        files.insert(
            path.to_string(),
            RemoteFile {
                blob: blob.to_string(),
                size,
            },
        );
    }
    files
}

/// 拉取远端最新树
///
/// 认证沿用 `sync.rs` 的规则：配置了 token 就把它拼进 https 地址，否则交回 `origin`，
/// 由本机 credential helper / SSH key 处理，插件本身不落盘任何凭据。
fn fetch_snapshot(app: &App) -> Result<Snapshot, RpcError> {
    let root = sync::root_of(app);
    let (has_remote, remote, _) = sync::git(&root, &["remote", "get-url", "origin"]);
    if !has_remote || remote.trim().is_empty() {
        return Err(RpcError::invalid("还没有配置远端仓库"));
    }
    let branch = sync::current_branch(&root);
    let config = sync::load_options(app);
    let provider = config
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("github");
    let token = config.get("token").and_then(Value::as_str).unwrap_or_default();
    let target = sync::authorized_url(&remote, provider, token).unwrap_or_else(|| "origin".to_string());

    // 低速阈值：弱网时 15 秒内不足 1KB/s 就中断，避免打开笔记长时间转圈
    let (ok, _, err) = sync::git(
        &root,
        &[
            "-c",
            "http.lowSpeedLimit=1000",
            "-c",
            "http.lowSpeedTime=15",
            "fetch",
            "--prune",
            &target,
            &branch,
        ],
    );
    if !ok {
        return Err(sync::fail(&err, "git fetch 失败：请检查网络与仓库凭据"));
    }
    let (has_head, head, head_err) = sync::git(&root, &["rev-parse", "FETCH_HEAD"]);
    if !has_head || head.trim().is_empty() {
        return Err(sync::fail(&head_err, "无法解析远端提交"));
    }
    let head = head.trim().to_string();
    // 让 status 里的 ahead/behind 也跟上（fetch 到 FETCH_HEAD 不会自动更新跟踪引用）
    sync::update_tracking_ref(&root, &branch, &head);

    let (listed, tree, tree_err) = sync::git(&root, &["ls-tree", "-r", "-l", "FETCH_HEAD"]);
    if !listed {
        return Err(sync::fail(&tree_err, "无法读取远端文件列表"));
    }
    Ok(Snapshot {
        head,
        branch,
        files: parse_ls_tree(&tree),
    })
}

/// 远端某文件最后一次提交的时间（毫秒）；取不到返回 0，与参考项目一致
fn remote_mtime(root: &PathBuf, rel: &str) -> i64 {
    let (ok, out, _) = sync::git(root, &["log", "-1", "--format=%ct", "FETCH_HEAD", "--", rel]);
    if !ok {
        return 0;
    }
    out.trim()
        .parse::<i64>()
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(0)
}

fn local_mtime(root: &Path, rel: &str) -> i64 {
    std::fs::metadata(root.join(rel))
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as i64)
        .unwrap_or(0)
}

/* ---------------- 判定（对齐 compareFileVersions） ---------------- */

/// 一次判定的结果：`action` 取值 none / pull / push / conflict
struct Decision {
    action: &'static str,
    reason: &'static str,
}

/// 本地文件的两个标识：内容 blob 与修改时间
struct LocalInfo {
    sha: String,
    mtime: i64,
}

/// 计算本地文件的 blob sha
///
/// `git hash-object` 给出的就是该文件提交后会用到的 blob sha，与远端
/// `ls-tree` 里的是同一套算法，所以能直接和基线、远端版本三路比较。
/// 这也比参考项目「只看记录的远端 SHA」更稳：本地有未推送的修改时不会
/// 被当成「远端更新」直接覆盖掉。
fn local_info(root: &PathBuf, rel: &str) -> Option<LocalInfo> {
    if !root.join(rel).is_file() {
        return None;
    }
    let (ok, sha, _) = sync::git(root, &["hash-object", rel]);
    if !ok || sha.trim().is_empty() {
        return None;
    }
    Some(LocalInfo {
        sha: sha.trim().to_string(),
        mtime: local_mtime(root, rel),
    })
}

/// 三路比对判定（基线 / 本地 / 远端）
///
/// 与参考项目的四种状态完全对应（none / pull / push / conflict），差别只在
/// 「两边都改过」这次能真的判出来：参考项目因为拿不到本地 blob，只比
/// 「记录的远端 SHA vs 当前远端 SHA」，本地未推送的修改会被直接覆盖。
///
/// 没有基线时（首次同步、换设备）退回参考项目的时间比较：
/// 远端较新 → 拉；本地较新 → 推；时间都取不到 → 冲突。
fn decide(
    remote: Option<&RemoteFile>,
    base: Option<&(String, i64)>,
    local: Option<&LocalInfo>,
    remote_time: i64,
) -> Decision {
    let local_sha = local.map(|item| item.sha.as_str());
    let local_time = local.map(|item| item.mtime).unwrap_or(0);

    let Some(remote_file) = remote else {
        // 远端没有这个文件
        return match (base, local_sha) {
            (_, None) => Decision {
                action: "none",
                reason: "本地与远端都没有该文件",
            },
            // 基线就等于本地内容 → 之前同步过，只是远端被删了，保持本地不动
            (Some((base_sha, _)), Some(sha)) if base_sha == sha => Decision {
                action: "none",
                reason: "远端已无该文件，本地保持现状",
            },
            _ => Decision {
                action: "push",
                reason: "远端文件不存在，需要推送",
            },
        };
    };

    match (base, local_sha) {
        (Some((base_sha, _)), Some(sha)) => {
            let local_changed = base_sha.as_str() != sha;
            let remote_changed = base_sha.as_str() != remote_file.blob.as_str();
            match (local_changed, remote_changed) {
                (false, true) => Decision {
                    action: "pull",
                    reason: "远程文件已更新，本地未改动",
                },
                (true, false) => Decision {
                    action: "push",
                    reason: "本地已修改，远端未变",
                },
                (false, false) => Decision {
                    action: "none",
                    reason: "已同步",
                },
                (true, true) => {
                    if sha == remote_file.blob.as_str() {
                        Decision {
                            action: "none",
                            reason: "两边改成了相同内容",
                        }
                    } else {
                        Decision {
                            action: "conflict",
                            reason: "本地与远端都改过同一个文件",
                        }
                    }
                }
            }
        }
        // 本地文件被删了：远端还等于基线就尊重删除，远端也变了就把远端拉回来
        (Some((base_sha, _)), None) => {
            if base_sha.as_str() == remote_file.blob.as_str() {
                Decision {
                    action: "none",
                    reason: "本地已删除，远端未变",
                }
            } else {
                Decision {
                    action: "pull",
                    reason: "本地已删除但远端有更新，拉回远端版本",
                }
            }
        }
        // 首次同步：没有基线，按内容与时间判断
        (None, Some(sha)) => {
            if sha == remote_file.blob.as_str() {
                return Decision {
                    action: "none",
                    reason: "与远端内容一致",
                };
            }
            if local_time == 0 && remote_time == 0 {
                return Decision {
                    action: "conflict",
                    reason: "无法确定修改时间，需要手动处理",
                };
            }
            if remote_time == 0 {
                return Decision {
                    action: "pull",
                    reason: "无法确定远程修改时间，拉取远端版本",
                };
            }
            if local_time == 0 {
                return Decision {
                    action: "push",
                    reason: "无法确定本地修改时间，推送本地版本",
                };
            }
            if remote_time > local_time {
                Decision {
                    action: "pull",
                    reason: "远程文件较新，需要拉取更新",
                }
            } else if local_time > remote_time {
                Decision {
                    action: "push",
                    reason: "本地文件较新，需要推送更新",
                }
            } else {
                Decision {
                    action: "none",
                    reason: "修改时间相同，认为已同步",
                }
            }
        }
        (None, None) => Decision {
            action: "pull",
            reason: "本地文件不存在，需要从远程拉取",
        },
    }
}

/// 删除本地文件：`remove_local` 只在拉取路径使用，这里统一收口错误
fn write_local(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), RpcError> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bytes)?;
    Ok(())
}

fn read_local_text(root: &Path, rel: &str) -> Option<String> {
    let bytes = std::fs::read(root.join(rel)).ok()?;
    if bytes.len() > CONFLICT_PREVIEW_LIMIT {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// 本地分支落后于远端时快进合并，让「磁盘内容」与「HEAD」保持一致
///
/// 单文件写入会让工作区比 HEAD 新；分支若一直停在旧提交，下一次自动提交推送
/// 会被远端以 non-fast-forward 拒绝，本地就开始分叉。
/// 只有 HEAD 是 FETCH_HEAD 祖先（本地没有额外提交）时才快进，其余情况不强行动作。
fn fast_forward(root: &PathBuf) -> bool {
    let (is_ancestor, _, _) = sync::git(root, &["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]);
    if !is_ancestor {
        return false;
    }
    let (ok, _, _) = sync::git(root, &["merge", "--ff-only", "FETCH_HEAD"]);
    ok
}

/// 用 HEAD 的树刷新全部基线（快进合并 / 提交推送之后调用）
fn refresh_bases_from_head(root: &PathBuf, state: &mut Value, now: i64) -> usize {
    let (listed, tree, _) = sync::git(root, &["ls-tree", "-r", "-l", "HEAD"]);
    if !listed {
        return 0;
    }
    let tracked = parse_ls_tree(&tree);
    for (rel, file) in &tracked {
        set_base(state, rel, &file.blob, now);
    }
    tracked.len()
}

/* ---------------- 对外接口 ---------------- */

/// `sync/fetch`：只拉远端状态，供界面显示「有 N 个文件可更新」
pub fn fetch(app: &App) -> RpcResult {
    let snapshot = fetch_snapshot(app)?;
    Ok(json!({
        "head": snapshot.head,
        "branch": snapshot.branch,
        "remoteFiles": snapshot.files.len(),
    }))
}

/// `sync/compare`：判定单个文件该拉、该推还是冲突
pub fn compare(app: &App, params: &Value) -> RpcResult {
    let rel = normalize_rel(&param_str(params, "path"))?;
    let root = sync::root_of(app);
    let snapshot = match fetch_snapshot(app) {
        Ok(value) => value,
        // 离线 / 凭据失效时不阻断打开笔记，也不做任何写入，等价于「远端未知」
        Err(error) => {
            return Ok(json!({
                "path": rel,
                "action": "none",
                "reason": error.message,
                "offline": true,
            }))
        }
    };

    let mut state = read_state(&root);
    let remote = snapshot.files.get(&rel);
    let base = base_of(&state, &rel);
    let local = local_info(&root, &rel);
    let remote_time = if remote.is_some() {
        remote_mtime(&root, &rel)
    } else {
        0
    };

    let decision = decide(remote, base.as_ref(), local.as_ref(), remote_time);

    // 判定为「已同步」时把基线补齐：首次同步和刚推完都会走到这里，
    // 补齐之后就是一次 blob 比较，不用再比时间。
    if decision.action == "none" {
        if let Some(remote_file) = remote {
            if base.as_ref().map(|(sha, _)| sha != &remote_file.blob).unwrap_or(true) {
                set_base(&mut state, &rel, &remote_file.blob, crate::now_ms());
                let _ = write_state(&root, &state);
            }
        }
    }

    let mut payload = json!({
        "path": rel,
        "action": decision.action,
        "reason": decision.reason,
        "remoteSha": remote.map(|file| file.blob.clone()).unwrap_or_default(),
        "baseSha": base.map(|(sha, _)| sha).unwrap_or_default(),
        "localSha": local.as_ref().map(|item| item.sha.clone()).unwrap_or_default(),
        "remoteMtime": remote_time,
        "remoteSize": remote.map(|file| file.size).unwrap_or(0),
        "localMtime": local.as_ref().map(|item| item.mtime).unwrap_or(0),
        "localExists": local.is_some(),
    });

    // 冲突时把两边内容一起带回，弹窗要用；读不到（二进制 / 过大）就把字段留空
    if decision.action == "conflict" {
        payload["localContent"] = json!(read_local_text(&root, &rel).unwrap_or_default());
        if let Some(remote_file) = remote {
            let (ok, bytes, _) = sync::git_bytes(&root, &["show", &format!("FETCH_HEAD:{rel}")]);
            if ok && bytes.len() <= CONFLICT_PREVIEW_LIMIT {
                payload["remoteContent"] = json!(String::from_utf8_lossy(&bytes).to_string());
            }
            payload["remoteSha"] = json!(remote_file.blob);
        }
    }
    Ok(payload)
}

/// `sync/pullFile`：拉取单个文件并推进基线
pub fn pull_file(app: &App, params: &Value) -> RpcResult {
    let rel = normalize_rel(&param_str(params, "path"))?;
    let root = sync::root_of(app);
    let snapshot = fetch_snapshot(app)?;
    let Some(remote_file) = snapshot.files.get(&rel) else {
        return Err(RpcError::invalid("远程不存在该文件，无法拉取"));
    };
    let (ok, bytes, err) = sync::git_bytes(&root, &["show", &format!("FETCH_HEAD:{rel}")]);
    if !ok {
        return Err(sync::fail(&err, "读取远端文件失败"));
    }
    if bytes.len() > MAX_PULL_BYTES {
        return Err(RpcError::invalid("文件过大，已跳过自动拉取"));
    }
    let created = !root.join(&rel).is_file();
    write_local(&root, &rel, &bytes)?;

    let mut state = read_state(&root);
    let now = crate::now_ms();
    set_base(&mut state, &rel, &remote_file.blob, now);
    state["lastSyncAt"] = json!(now);
    write_state(&root, &state)?;

    // 拉完让本地分支跟上远端，并把其它文件的基线一起对齐：
    // 快进之后那些文件也已经变成远端版本，基线不跟着走，下次比对会误判成冲突。
    if fast_forward(&root) {
        let mut latest = read_state(&root);
        refresh_bases_from_head(&root, &mut latest, now);
        latest["lastSyncAt"] = json!(now);
        write_state(&root, &latest)?;
    }

    // 文本文件直接把内容回传，界面就不用再读一次盘；二进制只回传标记
    let text = String::from_utf8(bytes).ok();
    Ok(json!({
        "updated": true,
        "created": created,
        "binary": text.is_none(),
        "content": text.unwrap_or_default(),
        "sha": remote_file.blob,
        "head": snapshot.head,
    }))
}

/// `sync/pullAll`：把远端所有「本地没改过且已变化」的文件拉下来
///
/// 对应参考项目的「拉取全部远程文件」，主要给新设备 / 首次配置用：
/// 打开笔记时才拉的话，本地一个文件都没有就永远没有入口。
pub fn pull_all(app: &App) -> RpcResult {
    let root = sync::root_of(app);
    let snapshot = fetch_snapshot(app)?;
    let mut state = read_state(&root);
    let mut pulled = 0usize;
    let mut skipped = 0usize;
    let mut failed: Vec<String> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();
    let now = crate::now_ms();

    for (rel, remote_file) in &snapshot.files {
        if normalize_rel(rel).is_err() {
            continue;
        }
        let base = base_of(&state, rel);
        let local = local_info(&root, rel);
        let remote_time = remote_mtime(&root, rel);
        let decision = decide(Some(remote_file), base.as_ref(), local.as_ref(), remote_time);
        match decision.action {
            "pull" => {
                let (ok, bytes, err) = sync::git_bytes(&root, &["show", &format!("FETCH_HEAD:{rel}")]);
                if !ok {
                    failed.push(format!("{rel}：{err}"));
                    continue;
                }
                if bytes.len() > MAX_PULL_BYTES {
                    failed.push(format!("{rel}：文件过大"));
                    continue;
                }
                if let Err(error) = write_local(&root, rel, &bytes) {
                    failed.push(format!("{rel}：{}", error.message));
                    continue;
                }
                // 拉下来的文件立即推进基线，否则下一轮仍会判成「远端已更新」
                set_base(&mut state, rel, &remote_file.blob, now);
                pulled += 1;
            }
            "conflict" => conflicts.push(rel.clone()),
            _ => {
                // 已同步的文件顺手把基线对齐到当前远端，避免历史空基线反复走时间比较
                set_base(&mut state, rel, &remote_file.blob, base.map(|(_, at)| at).unwrap_or(now));
                skipped += 1;
            }
        }
    }

    // 全部拉完后同样让分支跟上远端，基线随 HEAD 对齐（同 pull_file）
    if fast_forward(&root) {
        refresh_bases_from_head(&root, &mut state, now);
    }

    state["lastSyncAt"] = json!(now);
    write_state(&root, &state)?;

    Ok(json!({
        "head": snapshot.head,
        "pulled": pulled,
        "skipped": skipped,
        "conflicts": conflicts,
        "failed": failed,
        "message": format!("已拉取 {pulled} 个文件"),
    }))
}

/// 推送成功后由 `sync::push` 调用：把 HEAD 的版本写成新基线
///
/// 放在后端做，前端就不用再发一次 `sync/recordBase`，推送完状态立刻一致；
/// 失败时静默（基线没更新最多导致下次打开多一次比对，不影响数据）。
pub(crate) fn record_base_from_head(app: &App) {
    let root = sync::root_of(app);
    let mut state = read_state(&root);
    let now = crate::now_ms();
    if refresh_bases_from_head(&root, &mut state, now) == 0 {
        return;
    }
    state["lastSyncAt"] = json!(now);
    let _ = write_state(&root, &state);
}

/// `sync/recordBase`：把刚提交 / 推送的版本写成新基线
///
/// 不传 `paths` 时按 HEAD 全量刷新，用于「提交并推送」之后收口；
/// 传了就只更新这些路径，避免把别处的手工改动误记成已同步。
pub fn record_base(app: &App, params: &Value) -> RpcResult {
    let root = sync::root_of(app);
    let mut state = read_state(&root);
    let now = crate::now_ms();

    let requested: Vec<String> = params
        .get("paths")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|item| normalize_rel(item).ok())
                .collect()
        })
        .unwrap_or_default();

    let (listed, tree, err) = sync::git(&root, &["ls-tree", "-r", "-l", "HEAD"]);
    if !listed {
        return Err(sync::fail(&err, "无法读取本地提交的文件列表"));
    }
    let tracked = parse_ls_tree(&tree);

    let mut updated = 0usize;
    for (rel, file) in &tracked {
        if !requested.is_empty() && !requested.iter().any(|item| item == rel) {
            continue;
        }
        set_base(&mut state, rel, &file.blob, now);
        updated += 1;
    }
    // 请求里有、但 HEAD 里没有的文件（被删了或没提交），基线一并清掉
    for rel in &requested {
        if !tracked.contains_key(rel) {
            drop_base(&mut state, rel);
        }
    }
    state["lastSyncAt"] = json!(now);
    write_state(&root, &state)?;
    Ok(json!({ "updated": updated }))
}

/* ---------------- 远端文件树（对齐参考项目 loadRemoteSyncFiles） ----------------
 *
 * 参考项目进入文件页时并不下载任何笔记正文，而是拉一次「远端目录清单」，
 * 把只存在于云端的节点以 `isLocale: false` 插进文件树，用户点开时才下载单文件。
 * 我们之前只做了「打开已存在的本地笔记时逐文件比对」，所以远端新增的笔记
 * 在进入时完全不可见 —— 这就是「本地进入时还是没有拉取」的根因。
 *
 * 这里只负责产出清单，合并与渲染在前端 `remoteTree.ts` / `notes.ts` 完成。
 */

/// 单次清单返回上限，避免超大仓库把 RPC 载荷撑爆
const MAX_TREE_FILES: usize = 5_000;

/// 隐藏文件、插件元数据不进文件树（与参考项目过滤 `.` 开头条目一致）
pub(crate) fn tree_visible(rel: &str) -> bool {
    const SKIP_DIRS: [&str; 9] = [
        ".git", ".obsidian", ".dbx-note", ".trash", "node_modules", "target", "dist", ".next",
        ".venv",
    ];
    rel.split('/')
        .all(|part| !part.is_empty() && !part.starts_with('.') && !SKIP_DIRS.contains(&part))
}

/// 与本地 `fs/tree` 同一套白名单：只有笔记和图片才在文件树里出现
pub(crate) fn tree_note_file(rel: &str) -> bool {
    if !tree_visible(rel) {
        return false;
    }
    let extension = rel
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "md" | "markdown" | "txt" | "mdx" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
    )
}

/// 三路比对给出清单里每个文件的状态
///
/// 只在「没有基线且本地存在」时才去查远端提交时间：有基线时一次 blob
/// 比较就够了，逐文件跑 `git log` 会让进入文件树变成 N 次进程启动。
fn classify(root: &PathBuf, state: &Value, rel: &str, remote_file: &RemoteFile) -> &'static str {
    let base = base_of(state, rel);
    let local = local_info(root, rel);
    let remote_time = if base.is_none() && local.is_some() {
        remote_mtime(root, rel)
    } else {
        0
    };
    match decide(Some(remote_file), base.as_ref(), local.as_ref(), remote_time).action {
        "pull" if local.is_none() => "remoteOnly",
        "pull" => "updated",
        "push" => "localNewer",
        "conflict" => "conflict",
        _ => "synced",
    }
}

/// `sync/remoteTree` 统一入口：按当前同步平台分派
pub fn remote_tree(app: &App) -> RpcResult {
    let options = sync::load_options(app);
    let provider = options
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("github");
    if ["s3", "webdav", "selfHosted"].contains(&provider) {
        return crate::storesync::remote_tree(app);
    }
    list_remote(app)
}

/// Git 通道：fetch 一次后列出远端完整文件树
pub fn list_remote(app: &App) -> RpcResult {
    let root = sync::root_of(app);
    let provider = sync::load_options(app)
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("github")
        .to_string();
    let (is_repo, _, _) = sync::git(&root, &["rev-parse", "--is-inside-work-tree"]);
    let (has_remote, remote, _) = sync::git(&root, &["remote", "get-url", "origin"]);
    if !is_repo || !has_remote || remote.trim().is_empty() {
        return Ok(json!({
            "configured": false,
            "offline": false,
            "provider": provider,
            "files": [],
            "message": "还没有配置 Git 远端仓库",
        }));
    }

    let snapshot = match fetch_snapshot(app) {
        Ok(value) => value,
        Err(error) => {
            return Ok(json!({
                "configured": true,
                "offline": true,
                "provider": provider,
                "files": [],
                "message": error.message,
            }))
        }
    };

    let state = read_state(&root);
    let mut files = Vec::new();
    for (rel, remote_file) in &snapshot.files {
        if !tree_note_file(rel) || files.len() >= MAX_TREE_FILES {
            continue;
        }
        let local = local_info(&root, rel);
        let status = classify(&root, &state, rel, remote_file);
        files.push(json!({
            "path": rel,
            "sha": remote_file.blob,
            "size": remote_file.size,
            // 逐文件查远端提交时间会拉起 N 个 git 进程，文件树只需要体积做提示
            "mtime": 0,
            "status": status,
            "localExists": local.is_some(),
        }));
    }

    // 本地有、远端没有的文件也回传，界面可以标「待上传」
    let mut local_only = Vec::new();
    for rel in local_paths(&root) {
        if tree_note_file(&rel) && !snapshot.files.contains_key(&rel) {
            local_only.push(rel);
        }
    }

    Ok(json!({
        "configured": true,
        "offline": false,
        "provider": provider,
        "channel": "git",
        "head": snapshot.head,
        "branch": snapshot.branch,
        "files": files,
        "localOnly": local_only,
    }))
}

/// 列出工作区里的普通文件（排除隐藏目录与 .git）
fn local_paths(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        if out.len() >= MAX_TREE_FILES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

/// `sync/resolveConflict`：用户在弹窗里选了「采用远端 / 保留本地」
pub fn resolve_conflict(app: &App, params: &Value) -> RpcResult {
    let side = param_str(params, "side");
    if side == "remote" {
        return pull_file(app, params);
    }
    // 保留本地：清掉基线，下一次提交推送会把它重新写成远端版本
    let rel = normalize_rel(&param_str(params, "path"))?;
    let root = sync::root_of(app);
    let mut state = read_state(&root);
    drop_base(&mut state, &rel);
    write_state(&root, &state)?;
    Ok(json!({ "ok": true, "action": "push" }))
}
