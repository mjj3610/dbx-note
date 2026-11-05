//! 本地 SQLite：碎片记录、标签、AI 会话、文件历史、键值设置
//!
//! 表结构说明（SQLite 不支持 COMMENT，这里用注释标注用途与取值范围）：
//! - settings        键值配置：主题、语言、AI 模型等（value 存 JSON 字符串）
//! - records         碎片记录：type ∈ text/link/todo/image/file，archived ∈ 0/1
//! - tags            标签：name 唯一
//! - record_tags     记录与标签的多对多关系
//! - chats           会话：title 为空时由首条消息自动生成
//! - messages        消息：role ∈ user/assistant/system
//! - file_history    笔记快照：保存前留档，便于回滚

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{now_ms, param_i64, param_str, App, RpcError, RpcResult};

/// 打开（并初始化）数据库
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT NOT NULL PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS records (
            id         TEXT NOT NULL PRIMARY KEY,
            type       TEXT NOT NULL DEFAULT 'text',
            content    TEXT NOT NULL,
            meta       TEXT NOT NULL DEFAULT '{}',
            archived   INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_records_created ON records (created_at DESC);

        CREATE TABLE IF NOT EXISTS tags (
            id         TEXT NOT NULL PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            color      TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS record_tags (
            record_id  TEXT NOT NULL,
            tag_id     TEXT NOT NULL,
            PRIMARY KEY (record_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_record_tags_tag ON record_tags (tag_id);

        CREATE TABLE IF NOT EXISTS chats (
            id         TEXT NOT NULL PRIMARY KEY,
            title      TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id         TEXT NOT NULL PRIMARY KEY,
            chat_id    TEXT NOT NULL,
            role       TEXT NOT NULL,
            content    TEXT NOT NULL,
            meta       TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);

        CREATE TABLE IF NOT EXISTS file_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            path       TEXT NOT NULL,
            content    TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_path ON file_history (path, created_at DESC);
        "#,
    )
}

fn parse_json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

/* ---------------- 记录 ---------------- */

/// 记录列表：支持标签、类型、关键词、归档状态过滤
pub fn record_list(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let tag_id = param_str(params, "tagId");
    let record_type = param_str(params, "type");
    let keyword = param_str(params, "query").trim().to_lowercase();
    let limit = param_i64(params, "limit", 200).clamp(1, 500);
    let archived = param_i64(params, "archived", 0);

    let mut sql = String::from(
        "SELECT r.id, r.type, r.content, r.meta, r.archived, r.created_at, r.updated_at
         FROM records r",
    );
    let mut filters: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    if !tag_id.is_empty() {
        sql.push_str(" JOIN record_tags rt ON rt.record_id = r.id");
        filters.push("rt.tag_id = ?".to_string());
        values.push(Value::String(tag_id.clone()));
    }
    filters.push("r.archived = ?".to_string());
    values.push(Value::Number(archived.into()));
    if !record_type.is_empty() && record_type != "all" {
        filters.push("r.type = ?".to_string());
        values.push(Value::String(record_type));
    }
    if !keyword.is_empty() {
        // 图片记录的解读文字存在 meta.text 里，搜索也要能命中
        filters.push("(lower(r.content) LIKE ? OR lower(r.meta) LIKE ?)".to_string());
        values.push(Value::String(format!("%{keyword}%")));
        values.push(Value::String(format!("%{keyword}%")));
    }
    sql.push_str(" WHERE ");
    sql.push_str(&filters.join(" AND "));
    sql.push_str(" ORDER BY r.created_at DESC LIMIT ?");
    values.push(Value::Number(limit.into()));

    let mut stmt = conn.prepare(&sql)?;
    let bound: Vec<rusqlite::types::Value> = values
        .iter()
        .map(|value| match value {
            Value::String(text) => rusqlite::types::Value::Text(text.clone()),
            Value::Number(number) => rusqlite::types::Value::Integer(number.as_i64().unwrap_or(0)),
            _ => rusqlite::types::Value::Null,
        })
        .collect();
    let params_ref: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|value| value as &dyn rusqlite::ToSql).collect();

    let rows = stmt.query_map(params_ref.as_slice(), |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "type": row.get::<_, String>(1)?,
            "content": row.get::<_, String>(2)?,
            "meta": parse_json(&row.get::<_, String>(3)?),
            "archived": row.get::<_, i64>(4)? == 1,
            "createdAt": row.get::<_, i64>(5)?,
            "updatedAt": row.get::<_, i64>(6)?,
        }))
    })?;

    let mut items = Vec::new();
    for row in rows {
        let mut item = row?;
        item["tags"] = tags_of(&conn, item["id"].as_str().unwrap_or_default())?;
        items.push(item);
    }

    Ok(json!({ "items": items }))
}

fn tags_of(conn: &Connection, record_id: &str) -> rusqlite::Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color FROM tags t
         JOIN record_tags rt ON rt.tag_id = t.id
         WHERE rt.record_id = ? ORDER BY t.name",
    )?;
    let rows = stmt.query_map([record_id], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "name": row.get::<_, String>(1)?,
            "color": row.get::<_, String>(2)?,
        }))
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(Value::Array(items))
}

/// 确保标签存在并返回 id
fn ensure_tag(conn: &Connection, name: &str) -> rusqlite::Result<String> {
    if let Some(id) = conn
        .query_row("SELECT id FROM tags WHERE name = ?", [name], |row| row.get::<_, String>(0))
        .optional()?
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, '', ?)",
        params![id, name, now_ms()],
    )?;
    Ok(id)
}

fn attach_tags(conn: &Connection, record_id: &str, names: &[String]) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM record_tags WHERE record_id = ?", [record_id])?;
    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        let tag_id = ensure_tag(conn, trimmed)?;
        conn.execute(
            "INSERT OR IGNORE INTO record_tags (record_id, tag_id) VALUES (?, ?)",
            params![record_id, tag_id],
        )?;
    }
    Ok(())
}

fn read_tag_names(params: &Value) -> Vec<String> {
    params
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn record_create(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let id = Uuid::new_v4().to_string();
    let content = param_str(params, "content");
    if content.trim().is_empty() {
        return Err(RpcError::invalid("记录内容不能为空"));
    }
    let record_type = {
        let value = param_str(params, "type");
        if value.is_empty() { "text".to_string() } else { value }
    };
    let meta = params.get("meta").cloned().unwrap_or(json!({}));
    let now = now_ms();
    conn.execute(
        "INSERT INTO records (id, type, content, meta, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)",
        params![id, record_type, content, meta.to_string(), now, now],
    )?;
    attach_tags(&conn, &id, &read_tag_names(params))?;

    Ok(json!({
        "id": id,
        "type": record_type,
        "content": content,
        "meta": meta,
        "archived": false,
        "createdAt": now,
        "updatedAt": now,
        "tags": tags_of(&conn, &id)?,
    }))
}

pub fn record_update(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let id = param_str(params, "id");
    if id.is_empty() {
        return Err(RpcError::invalid("缺少记录 id"));
    }
    let now = now_ms();

    if let Some(content) = params.get("content").and_then(Value::as_str) {
        conn.execute(
            "UPDATE records SET content = ?, updated_at = ? WHERE id = ?",
            params![content, now, id],
        )?;
    }
    if let Some(archived) = params.get("archived").and_then(Value::as_bool) {
        conn.execute(
            "UPDATE records SET archived = ?, updated_at = ? WHERE id = ?",
            params![if archived { 1 } else { 0 }, now, id],
        )?;
    }
    if let Some(meta) = params.get("meta").and_then(Value::as_object) {
        // 合并写入：只覆盖传入的键，避免把已有 meta（如来源、颜色）整块冲掉
        let existing: Option<String> = conn
            .query_row("SELECT meta FROM records WHERE id = ?", params![id], |row| row.get(0))
            .ok();
        let mut current = existing
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        for (key, value) in meta {
            current.insert(key.clone(), value.clone());
        }
        conn.execute(
            "UPDATE records SET meta = ?, updated_at = ? WHERE id = ?",
            params![Value::Object(current).to_string(), now, id],
        )?;
    }
    if params.get("tags").is_some() {
        attach_tags(&conn, &id, &read_tag_names(params))?;
    }

    Ok(json!({ "ok": true }))
}

pub fn record_delete(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let id = param_str(params, "id");
    conn.execute("DELETE FROM record_tags WHERE record_id = ?", [&id])?;
    conn.execute("DELETE FROM records WHERE id = ?", [&id])?;
    Ok(json!({ "ok": true }))
}

/* ---------------- 标签 ---------------- */

pub fn tag_list(app: &App) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, COUNT(rt.record_id)
         FROM tags t LEFT JOIN record_tags rt ON rt.tag_id = t.id
         GROUP BY t.id ORDER BY COUNT(rt.record_id) DESC, t.name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "name": row.get::<_, String>(1)?,
            "color": row.get::<_, String>(2)?,
            "count": row.get::<_, i64>(3)?,
        }))
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(json!({ "items": items }))
}

pub fn tag_create(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let name = param_str(params, "name").trim().to_string();
    if name.is_empty() {
        return Err(RpcError::invalid("标签名不能为空"));
    }
    let id = ensure_tag(&conn, &name)?;
    Ok(json!({ "id": id, "name": name }))
}

pub fn tag_delete(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let id = param_str(params, "id");
    conn.execute("DELETE FROM record_tags WHERE tag_id = ?", [&id])?;
    conn.execute("DELETE FROM tags WHERE id = ?", [&id])?;
    Ok(json!({ "ok": true }))
}

/* ---------------- 会话 ---------------- */

pub fn chat_list(app: &App) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let mut stmt = conn.prepare("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "title": row.get::<_, String>(1)?,
            "createdAt": row.get::<_, i64>(2)?,
            "updatedAt": row.get::<_, i64>(3)?,
        }))
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(json!({ "items": items }))
}

pub fn chat_create(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let title = param_str(params, "title");
    conn.execute(
        "INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        params![id, title, now, now],
    )?;
    Ok(json!({ "id": id, "title": title, "createdAt": now, "updatedAt": now }))
}

pub fn chat_rename(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    conn.execute(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
        params![param_str(params, "title"), now_ms(), param_str(params, "id")],
    )?;
    Ok(json!({ "ok": true }))
}

pub fn chat_delete(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let id = param_str(params, "id");
    conn.execute("DELETE FROM messages WHERE chat_id = ?", [&id])?;
    conn.execute("DELETE FROM chats WHERE id = ?", [&id])?;
    Ok(json!({ "ok": true }))
}

pub fn chat_messages(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let chat_id = param_str(params, "chatId");
    let mut stmt = conn.prepare(
        "SELECT id, role, content, meta, created_at FROM messages WHERE chat_id = ? ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map([&chat_id], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "role": row.get::<_, String>(1)?,
            "content": row.get::<_, String>(2)?,
            "meta": parse_json(&row.get::<_, String>(3)?),
            "createdAt": row.get::<_, i64>(4)?,
        }))
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(json!({ "items": items }))
}

pub fn chat_append(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let chat_id = param_str(params, "chatId");
    if chat_id.is_empty() {
        return Err(RpcError::invalid("缺少会话 id"));
    }
    let id = Uuid::new_v4().to_string();
    let role = param_str(params, "role");
    let content = param_str(params, "content");
    let meta = params.get("meta").cloned().unwrap_or(json!({}));
    let now = now_ms();
    conn.execute(
        "INSERT INTO messages (id, chat_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params![id, chat_id, role, content, meta.to_string(), now],
    )?;
    conn.execute("UPDATE chats SET updated_at = ? WHERE id = ?", params![now, chat_id])?;

    // 首条用户消息自动作为标题
    let title: Option<String> = conn
        .query_row("SELECT title FROM chats WHERE id = ?", [&chat_id], |row| row.get(0))
        .optional()?;
    if title.unwrap_or_default().is_empty() && role == "user" {
        let short: String = content.chars().take(24).collect();
        conn.execute("UPDATE chats SET title = ? WHERE id = ?", params![short, chat_id])?;
    }

    Ok(json!({ "id": id, "createdAt": now }))
}

/* ---------------- 设置 ---------------- */

pub fn settings_get(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let key = param_str(params, "key");
    let value: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?", [&key], |row| row.get(0))
        .optional()?;
    Ok(json!({
        "key": key,
        "value": value.map(|raw| parse_json(&raw)).unwrap_or(Value::Null),
    }))
}

pub fn settings_set(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let key = param_str(params, "key");
    if key.is_empty() {
        return Err(RpcError::invalid("缺少设置键"));
    }
    let value = params.get("value").cloned().unwrap_or(Value::Null);
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value.to_string(), now_ms()],
    )?;
    Ok(json!({ "ok": true }))
}

/* ---------------- 文件历史 ---------------- */

pub fn history_list(app: &App, params: &Value) -> RpcResult {
    let conn = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    let path = param_str(params, "path");
    let limit = param_i64(params, "limit", 20).clamp(1, 100);
    let mut stmt = conn.prepare(
        "SELECT id, content, created_at FROM file_history WHERE path = ? ORDER BY created_at DESC LIMIT ?",
    )?;
    let rows = stmt.query_map(params![path, limit], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "content": row.get::<_, String>(1)?,
            "createdAt": row.get::<_, i64>(2)?,
        }))
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(json!({ "items": items }))
}
