//! 本地 MCP 工具代理
//!
//! 插件页面在 `connect-src 'none'` 的沙箱里，既不能直连网络，也不能拉起子进程，
//! 所以「调用本机 MCP 服务」这件事整体放在 Sidecar 里做：
//!
//! - 服务器配置存在 `settings` 表的 `app.mcp`；
//! - 每次调用按「启动进程 → initialize → tools/list 或 tools/call → 退出」走一遍，
//!   用完即弃，不对状态做长连接假设（配置型服务启动成本很低）；
//! - 协议按 MCP 的 JSON-RPC 2.0 行协议收发，标准输出逐行读取。
//!
//! 这样既能把本机工具能力接进对话，又不需要宿主开放额外权限。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::{param_str, App, RpcError, RpcResult};

/// 设置表里的键名
const SETTINGS_KEY: &str = "app.mcp";
/// 单条 JSON-RPC 响应等待上限
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// 启动握手超时（npx 首次拉包会慢一些）
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// 一个已就绪的 MCP 会话
struct Session {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    next_id: i64,
}

impl Session {
    fn send(&mut self, message: &Value) -> Result<(), String> {
        let line = format!("{message}\n");
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("写入 MCP 请求失败：{error}"))
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    /// 发请求并等待同 id 的响应，超时或进程退出都会报错
    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let line = self
                .rx
                .recv_timeout(timeout)
                .map_err(|_| format!("MCP 服务未在 {} 秒内响应 {method}", timeout.as_secs()))?;
            let trimmed = line.trim();
            if trimmed.is_empty() || !trimmed.starts_with('{') {
                continue;
            }
            let parsed: Value = match serde_json::from_str(trimmed) {
                Ok(value) => value,
                Err(_) => continue,
            };
            // 通知、日志、其它 id 的响应一律跳过
            if parsed.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = parsed.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
                    .to_string();
                return Err(format!("MCP 服务返回错误：{message}"));
            }
            return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn shutdown(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 启动服务进程并完成 initialize 握手
fn open(command: &str, args: &[String]) -> Result<Session, String> {
    if command.trim().is_empty() {
        return Err("请先填写启动命令".to_string());
    }
    let mut process = if cfg!(windows) {
        // Windows 上 npx / uvx 这类是 .cmd，必须经 cmd.exe 才能拉起
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg(command);
        cmd
    } else {
        Command::new(command)
    };
    process
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不弹黑窗
        process.creation_flags(0x0800_0000);
    }

    let mut child = process
        .spawn()
        .map_err(|error| format!("启动 MCP 服务失败：{error}"))?;
    let stdin = child.stdin.take().ok_or("无法获取 MCP 服务的标准输入")?;
    let stdout = child.stdout.take().ok_or("无法获取 MCP 服务的标准输出")?;

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(value) => {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut session = Session {
        child,
        stdin,
        rx,
        next_id: 0,
    };
    session.request(
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": json!({}),
            "clientInfo": { "name": "dbx-note", "version": crate::PLUGIN_VERSION },
        }),
        START_TIMEOUT,
    )?;
    session.notify("notifications/initialized", json!({}))?;
    Ok(session)
}

/* ---------------- 配置读写 ---------------- */

fn load_servers(app: &App) -> Result<Vec<Value>, RpcError> {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?",
            params![SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()?;
    let parsed: Value = raw
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({ "servers": [] }));
    Ok(parsed
        .get("servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn find_server(app: &App, id: &str) -> Result<Value, RpcError> {
    load_servers(app)?
        .into_iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| RpcError::invalid("找不到该 MCP 服务，请先在设置里添加"))
}

fn command_of(server: &Value) -> Result<(String, Vec<String>), RpcError> {
    let command = server
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if command.is_empty() {
        return Err(RpcError::invalid("启动命令为空"));
    }
    let args = server
        .get("args")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok((command, args))
}

/* ---------------- RPC ---------------- */

pub fn list(app: &App) -> RpcResult {
    Ok(json!({ "servers": load_servers(app)? }))
}

pub fn save(app: &App, params: &Value) -> RpcResult {
    let servers = params
        .get("servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // 兜底补齐 id 与默认开关；允许先存下「只填了名字」的草稿，方便边填边存
    let normalized: Vec<Value> = servers
        .into_iter()
        .filter(|item| item.is_object())
        .map(|mut item| {
            if item.get("id").and_then(Value::as_str).unwrap_or_default().is_empty() {
                item["id"] = json!(uuid::Uuid::new_v4().to_string());
            }
            if item.get("enabled").is_none() {
                item["enabled"] = json!(true);
            }
            if item.get("args").is_none() {
                item["args"] = json!([]);
            }
            if item.get("name").is_none() {
                item["name"] = json!("");
            }
            if item.get("command").is_none() {
                item["command"] = json!("");
            }
            item
        })
        .collect();
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![SETTINGS_KEY, json!({ "servers": normalized }).to_string(), crate::now_ms()],
    )?;
    Ok(json!({ "servers": normalized }))
}

/// 列出某个服务暴露的工具
pub fn tools(app: &App, params: &Value) -> RpcResult {
    let id = param_str(params, "id");
    let server = find_server(app, &id)?;
    let (command, args) = command_of(&server)?;
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();

    let mut session = open(&command, &args).map_err(RpcError::internal)?;
    let result = session.request("tools/list", json!({}), RESPONSE_TIMEOUT);
    session.shutdown();
    let value = result.map_err(RpcError::internal)?;
    let items = value
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool.get("name").and_then(Value::as_str).unwrap_or_default(),
                "description": tool.get("description").and_then(Value::as_str).unwrap_or_default(),
                "inputSchema": tool.get("inputSchema").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "id": id, "name": name, "tools": items }))
}

/// 调用工具，返回文本内容（图片等二进制内容只回占位说明）
pub fn call(app: &App, params: &Value) -> RpcResult {
    let id = param_str(params, "id");
    let tool = param_str(params, "tool");
    if tool.is_empty() {
        return Err(RpcError::invalid("缺少工具名称"));
    }
    let arguments = params.get("args").cloned().unwrap_or(json!({}));
    let server = find_server(app, &id)?;
    let (command, args) = command_of(&server)?;

    let mut session = open(&command, &args).map_err(RpcError::internal)?;
    let result = session.request(
        "tools/call",
        json!({ "name": tool, "arguments": arguments }),
        RESPONSE_TIMEOUT,
    );
    session.shutdown();
    let value = result.map_err(RpcError::internal)?;

    let is_error = value.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let text = value
        .get("content")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|item| match item.get("type").and_then(Value::as_str) {
                    Some("text") => item
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    Some(kind) => format!("[{kind} 内容]"),
                    None => String::new(),
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    Ok(json!({ "text": text, "isError": is_error }))
}
