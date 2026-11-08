//! DBX 笔记 —— 原生 Sidecar
//!
//! 职责：
//! 1. 工作区（Markdown 目录）文件读写：树、新建、重命名、删除、保存、全文搜索；
//! 2. 本地 SQLite：碎片记录、标签、AI 会话、文件历史、键值设置；
//! 3. AI 请求代理：插件页面运行在 `connect-src 'none'` 的沙箱里，浏览器无法直连模型接口，
//!    统一由本进程发起 HTTP 请求（含流式轮询）。
//!
//! 协议：DBX Plugin Protocol v1，stdin/stdout 上的 JSON-RPC 2.0 逐行消息。
//! 注意：`Metadata.version` 必须与 manifest.json 的 version 完全一致，否则宿主会报
//! `Sidecar identity or protocol does not match manifest`。

mod ai;
mod backup;
mod canvas;
mod db;
mod files;
mod gitsync;
mod imagehost;
mod logs;
mod mcp;
// 截图 / 剪贴板位图 / 录音 / 系统 OCR 全部直接调 Win32（GDI、剪贴板、COM、WinRT），
// 非 Windows 平台没有对应实现。这里做条件编译：Windows 编译真实模块，
// 其他平台编译同名同签名的桩，协议层照常分发，调用方拿到的是可读错误而不是链接失败。
#[cfg(windows)]
mod native;
#[cfg(windows)]
mod ocr;
#[cfg(windows)]
mod pin;
#[cfg(windows)]
mod screenshot;
#[cfg(windows)]
mod screenshot_ink;
#[cfg(not(windows))]
#[path = "native_stub.rs"]
mod native;
#[cfg(not(windows))]
#[path = "ocr_stub.rs"]
mod ocr;
#[cfg(not(windows))]
#[path = "screenshot_stub.rs"]
mod screenshot;
mod storesync;
mod sync;

/// 打一行诊断日志：stderr（devhost / 宿主日志里能看到）+ 数据目录下的日志文件
///
/// 用 `crate::logln!("…")` 调用。日志文件位置见 `logs` 模块注释。
#[macro_export]
macro_rules! logln {
    ($($arg:tt)*) => {{
        let line = format!($($arg)*);
        eprintln!("{line}");
        $crate::logs::write(&line);
    }};
}

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

/// 插件标识与版本，必须与 manifest.json 保持一致
const PLUGIN_ID: &str = "com.mjj3610.note";
pub(crate) const PLUGIN_VERSION: &str = "0.5.0";
/// 协议版本
const PROTOCOL_VERSION: i64 = 1;

/// 运行期共享状态
pub struct App {
    /// 宿主分配的插件数据目录（DBX_PLUGIN_DATA_DIR）
    pub data_dir: PathBuf,
    /// 当前工作区根目录，可在设置里切换
    pub root: Mutex<PathBuf>,
    /// SQLite 连接（单连接 + 互斥锁，本地单用户足够）
    pub db: Mutex<rusqlite::Connection>,
    /// 流式对话的中间状态（流式线程需要独立持有，故用 Arc）
    pub streams: Arc<Mutex<HashMap<String, ai::StreamState>>>,
}

/// JSON-RPC 错误
#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// 参数非法
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(-32602, message)
    }

    /// 业务/系统异常统一转 -32000，前端按 message 展示
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(-32000, message)
    }
}

impl From<rusqlite::Error> for RpcError {
    fn from(value: rusqlite::Error) -> Self {
        RpcError::internal(format!("数据库错误：{value}"))
    }
}

impl From<std::io::Error> for RpcError {
    fn from(value: std::io::Error) -> Self {
        RpcError::internal(format!("文件操作失败：{value}"))
    }
}

pub type RpcResult = Result<Value, RpcError>;

fn main() {
    // OCR 子进程模式：WinRT 的 OCR 是原生代码，畸形 / 极小图片能让它直接 AV 退出进程。
    // 放到子进程里跑，崩的只是这个 worker，主进程把"异常退出"当成一次识别失败返回。
    if std::env::args().any(|arg| arg == "--ocr-once") {
        ocr::run_worker_once();
        return;
    }

    // 日志写 stderr，stdout 只能输出协议消息
    // DPI 感知必须在任何窗口 / 量屏之前声明：混合缩放的多屏环境下，
    // 坐标与位图不在同一坐标系会造成「框选区域与实际裁剪区域偏移」
    if !native::ensure_dpi_awareness() {
        crate::logln!("[dbx-note] 声明 DPI 感知失败（可能已被提前设置），截图坐标可能被系统缩放");
    }

    let data_dir = resolve_data_dir();
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        crate::logln!("[dbx-note] 创建数据目录失败：{error}");
        std::process::exit(1);
    }

    logs::init(&data_dir);

    let conn = match db::open(&data_dir.join("dbx-note.db")) {
        Ok(conn) => conn,
        Err(error) => {
            crate::logln!("[dbx-note] 打开数据库失败：{error}");
            std::process::exit(1);
        }
    };

    let root = files::load_root(&data_dir);
    let _ = std::fs::create_dir_all(&root);

    let app = Arc::new(App {
        data_dir,
        root: Mutex::new(root),
        db: Mutex::new(conn),
        streams: Arc::new(Mutex::new(HashMap::new())),
    });

    // 系统级截图热键：插件不在前台时也能直接框选
    // - 未设置：按候选链（Alt+Shift+Z → Ctrl+Alt+Z → …）注册第一个能注册上的
    // - 设置为具体组合：只注册该组合（设置页 / 测试用）
    // - 设置为 off：完全不注册（自动化测试不该占开发机的全局热键）
    let hotkey_env = std::env::var("DBX_NOTE_SHOT_HOTKEY")
        .ok()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if hotkey_env.is_empty() {
        screenshot::start_hotkey(None);
    } else if !hotkey_env.eq_ignore_ascii_case("off") {
        screenshot::start_hotkey(Some(hotkey_env));
    }

    serve(app);
}

/// 数据目录：优先使用宿主下发的 DBX_PLUGIN_DATA_DIR，其次回退到用户配置目录
fn resolve_data_dir() -> PathBuf {
    if let Ok(value) = std::env::var("DBX_PLUGIN_DATA_DIR") {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(PathBuf::from))
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("dbx-note")
}

/// 主循环：逐行读取请求，每条请求一个线程处理，保证长任务不阻塞心跳
fn serve(app: Arc<App>) {
    let stdin = std::io::stdin();
    let mut workers = Vec::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                crate::logln!("[dbx-note] 读取 stdin 失败：{error}");
                break;
            }
        };
        let payload = line.trim();
        if payload.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(payload) {
            Ok(value) => value,
            Err(error) => {
                crate::logln!("[dbx-note] 无法解析请求：{error}");
                continue;
            }
        };

        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = request.get("params").cloned().unwrap_or(Value::Null);

        if id.is_null() {
            // 通知类消息（无 id）不需要回包，记日志即可
            crate::logln!("[dbx-note] 忽略通知：{method}");
            continue;
        }

        if method == "plugin/initialize" {
            let result = initialize(&params);
            write_message(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
            continue;
        }

        let app = Arc::clone(&app);
        workers.push(std::thread::spawn(move || {
            match dispatch(&app, &method, params) {
                Ok(result) => {
                    write_message(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                }
                Err(error) => write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": error.code, "message": error.message }
                })),
            }
        }));
    }

    for worker in workers {
        let _ = worker.join();
    }
}

/// 处理握手：宿主会带上它支持的协议版本列表
fn initialize(params: &Value) -> Value {
    let versions = params
        .get("host")
        .and_then(|host| host.get("protocolVersions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let supports = versions.is_empty()
        || versions
            .iter()
            .any(|version| version.as_i64() == Some(PROTOCOL_VERSION));

    if !supports {
        return json!({
            "code": -32001,
            "message": "DBX 与插件没有共同的协议版本"
        });
    }

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": Vec::<String>::new(),
        "plugin": { "id": PLUGIN_ID, "version": PLUGIN_VERSION }
    })
}

/// 写一行协议消息（stdout 串行化，防止多线程交错）
fn write_message(value: &Value) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    if serde_json::to_writer(&mut lock, value).is_ok() {
        let _ = lock.write_all(b"\n");
        let _ = lock.flush();
    }
}

/// 方法分发
fn dispatch(app: &App, method: &str, params: Value) -> RpcResult {
    match method {
        "ping" => Ok(json!({ "ok": true, "version": PLUGIN_VERSION })),

        // ---------------- 工作区 ----------------
        "workspace/describe" => files::describe_workspace(app),
        "workspace/set" => files::set_workspace(app, &params),
        "workspace/reset" => files::reset_workspace(app),
        "fs/listDirs" => files::list_dirs(&params),
        "fs/mkdir" => files::make_dir(app, &params),
        "fs/tree" => files::read_tree(app, &params),
        "fs/read" => files::read_file(app, &params),
        "fs/write" => files::write_file(app, &params),
        "fs/create" => files::create_entry(app, &params),
        "fs/rename" => files::rename_entry(app, &params),
        "fs/delete" => files::delete_entry(app, &params),
        "fs/search" => files::search_files(app, &params),
        "fs/stat" => files::stat_entry(app, &params),
        "image/read" => files::read_image(app, &params),
        "image/save" => files::save_image(app, &params),
        "image/upload" => imagehost::upload(&params),
        "image/hostingCheck" => imagehost::check(&params),
        "image/hostingRepo" => imagehost::repo(&params),

        // ---------------- 宿主拿不到的系统能力（截屏 / 剪贴板 / 录音） ----------------
        "screen/capture" => native::capture_screen(),
        // 在真实桌面上 1:1 框选（Sidecar 建全屏置顶窗口），返回裁剪后的图
        "log/info" => logs::info(),
        "log/tail" => logs::tail(&params),
        "log/open" => logs::open_dir(),
        "log/write" => logs::write_from_ui(&params),
        "screenshot/select" => screenshot::select(),
        // 自检入口：以 RPC 代跑「全局热键」那条链路（模拟按键在锁屏 / CI 里会被丢掉）
        "screenshot/globalShot" => screenshot::global_shot(&params),
        // 前端快捷键已接手：全局热键线程据此让位，避免弹两个框选窗口
        "screenshot/uiHotkey" => screenshot::mark_ui_hotkey(),
        "screenshot/takePending" => screenshot::take_pending(),
        "screenshot/hotkey" => screenshot::hotkey_status(),
        "screenshot/window" => screenshot::window_probe(),
        // 插件浮层里的「钉在顶层」：浮层在 iframe 里贴不出桌面级窗口，交给 Sidecar
        "screenshot/pin" => screenshot::pin_image(&params),
        "screenshot/unpinAll" => screenshot::unpin_all(),
        // 自检专用：直接往框选窗口投按键（切工具 / Esc），绕开会丢的 SendInput
        "screenshot/pressKey" => screenshot::press_key(&params),
        "screenshot/typeText" => screenshot::type_text(&params),
        "clipboard/image" => native::capture_clipboard(),
        "clipboard/write" => native::write_clipboard(&params),
        "audio/recordStart" => native::record_start(),
        "audio/recordStop" => native::record_stop(),
        "audio/recordStatus" => native::record_status(),

        // ---------------- 画布 ----------------
        "canvas/list" => canvas::list(app),
        "canvas/read" => canvas::read(app, &params),
        "canvas/create" => canvas::create(app, &params),
        "canvas/save" => canvas::save(app, &params),
        "canvas/rename" => canvas::rename(app, &params),
        "canvas/delete" => canvas::delete(app, &params),

        // ---------------- 云同步（Git） ----------------
        "sync/status" => sync::status(app),
        "sync/options" => sync::options(app),
        "sync/saveOptions" => sync::save_settings(app, &params),
        "sync/init" => sync::init(app, &params),
        "sync/remote" => sync::set_remote(app, &params),
        "sync/commit" => sync::commit(app, &params),
        "sync/pull" => sync::pull(app),
        "sync/push" => sync::push(app),
        // 单文件同步：打开笔记时比对远端版本、按需拉取（与 NoteGen 的
        // compareFileVersions / pullFile / pullAllRemoteLibraryFiles 同构）
        "sync/fetch" => gitsync::fetch(app),
        "sync/compare" => gitsync::compare(app, &params),
        "sync/pullFile" => gitsync::pull_file(app, &params),
        "sync/pullAll" => gitsync::pull_all(app),
        "sync/recordBase" => gitsync::record_base(app, &params),
        "sync/resolveConflict" => gitsync::resolve_conflict(app, &params),
        // 对象存储 / WebDAV / 自托管：文件镜像通道
        "sync/storeOptions" => storesync::options(app),
        "sync/saveStoreOptions" => storesync::save(app, &params),
        "sync/storeCheck" => storesync::check(app),
        "sync/storeStatus" => storesync::status(app),
        "sync/storePush" => storesync::push(app, &params),
        "sync/storePull" => storesync::pull(app, &params),
        "sync/storeLogs" => storesync::logs(app),
        "sync/prefs" => storesync::prefs(app),
        "sync/savePrefs" => storesync::save_prefs(app, &params),

        // ---------------- 备份与恢复 ----------------
        "backup/export" => backup::export(app, &params),
        "backup/list" => backup::list(app),
        "backup/import" => backup::import(app, &params),
        "backup/delete" => backup::remove(app, &params),
        "backup/info" => backup::info(app),

        // ---------------- 本地 MCP 工具 ----------------
        "mcp/list" => mcp::list(app),
        "mcp/save" => mcp::save(app, &params),
        "mcp/tools" => mcp::tools(app, &params),
        "mcp/call" => mcp::call(app, &params),

        // ---------------- 记录 ----------------
        "record/list" => db::record_list(app, &params),
        "record/create" => db::record_create(app, &params),
        "record/update" => db::record_update(app, &params),
        "record/delete" => db::record_delete(app, &params),
        "tag/list" => db::tag_list(app),
        "tag/create" => db::tag_create(app, &params),
        "tag/delete" => db::tag_delete(app, &params),

        // ---------------- 对话 ----------------
        "chat/list" => db::chat_list(app),
        "chat/create" => db::chat_create(app, &params),
        "chat/rename" => db::chat_rename(app, &params),
        "chat/delete" => db::chat_delete(app, &params),
        "chat/messages" => db::chat_messages(app, &params),
        "chat/append" => db::chat_append(app, &params),

        // ---------------- 设置与杂项 ----------------
        "settings/get" => db::settings_get(app, &params),
        "settings/set" => db::settings_set(app, &params),
        "history/list" => db::history_list(app, &params),

        // ---------------- AI ----------------
        "ai/chat" => ai::chat(app, &params),
        "ai/start" => ai::start(app, &params),
        "ai/poll" => ai::poll(app, &params),
        "ai/cancel" => ai::cancel(app, &params),
        "ai/models" => ai::models(&params),
        "ai/vision" => ai::vision(app, &params),
        "ai/transcribe" => ai::transcribe(&params),
        "net/request" => ai::net_request(&params),
        // 系统 OCR（VLM 失败 / 未配视觉模型时的回退通道）
        "ocr/status" => ocr::status(app),
        "ocr/run" => ocr::run(app, &params),

        other => Err(RpcError::new(-32601, format!("未实现的方法：{other}"))),
    }
}

/// 取字符串参数
pub fn param_str(params: &Value, key: &str) -> String {
    params
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 取可选字符串参数
pub fn param_opt_str(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

/// 取整型参数
pub fn param_i64(params: &Value, key: &str, fallback: i64) -> i64 {
    params.get(key).and_then(Value::as_i64).unwrap_or(fallback)
}

/// 当前毫秒时间戳
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
