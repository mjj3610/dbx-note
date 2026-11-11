//! 知识库（RAG）：分块 → embedding → 向量库 → 混合检索 → 快照同步
//!
//! 对齐参考项目 NoteGen v0.39.2 的 `rag.ts` / `db/vector.ts` / `db/knowledge.ts`：
//! - `knowledge_sources` 登记每个笔记的索引状态（内容哈希去重、状态机、自动计算 / 包含开关）；
//! - `vector_documents` 存分块正文与 embedding（JSON 数字数组），`unique(filename, chunk_id)` 去重；
//! - 检索把「余弦相似度」与「内存 BM25」两路结果按 RRF 融合，返回可直接注入 AI 的上下文；
//! - 快照写到工作区 `.dbx-note/rag-snapshot.json`，随既有 Git / 对象存储同步通道在多设备间流转。
//!
//! SQLite 不支持列 COMMENT，字段用途与取值范围统一写在下面的 SQL 注释里。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::{now_ms, param_str, App, RpcError, RpcResult};

/* ---------------- 常量 ---------------- */

/// 默认分块字符数（参考项目 ragChunkSize）
const DEFAULT_CHUNK_SIZE: usize = 1000;
/// 默认块级重叠字符数（参考项目 ragChunkOverlap）
const DEFAULT_CHUNK_OVERLAP: usize = 200;
/// 一次 embedding 请求最多带多少条分块（参考项目固定 16）
const EMBEDDING_BATCH: usize = 16;
/// 单次 embedding 请求超时
const EMBEDDING_TIMEOUT_MS: u64 = 60_000;
/// 默认返回条数
const DEFAULT_TOP_K: usize = 5;
/// 默认相似度阈值
const DEFAULT_THRESHOLD: f64 = 0.25;
/// RRF 融合常数
const RRF_K: f64 = 20.0;
/// 向量路 / 词法路在 RRF 里的权重
const VECTOR_WEIGHT: f64 = 0.7;
const LEXICAL_WEIGHT: f64 = 0.3;
/// BM25 参数
const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;
/// 单次全量索引最多处理的文件数，避免误把整个磁盘灌进向量库
const MAX_INDEX_FILES: usize = 2000;
/// 单次检索最多读取的分块数
const MAX_SEARCH_CHUNKS: usize = 20_000;
/// 注入 AI 的上下文总长上限
const MAX_CONTEXT_CHARS: usize = 12_000;
/// 快照最大字节数
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
/// 快照格式版本
const SNAPSHOT_SCHEMA_VERSION: i64 = 2;
/// 快照在工作区里的相对路径（随云同步带走）
const KB_SNAPSHOT_REL: &str = ".dbx-note/rag-snapshot.json";
/// 索引时跳过的目录（与参考项目 DEFAULT_EXCLUDED_RAG_PATHS 对齐）
const SKIP_DIRS: [&str; 6] = [".git", ".dbx-note", "node_modules", ".trash", "skills", "assets"];
/// 允许索引的文本扩展名
const TEXT_EXTENSIONS: [&str; 4] = ["md", "markdown", "txt", "mdx"];
/// 词法检索停用的高频词（中文单字 + 英文虚词）
const STOP_WORDS: [&str; 12] = ["的", "了", "和", "是", "在", "有", "the", "a", "an", "of", "to", "and"];

/* ---------------- 表结构 ---------------- */

/// 建表（幂等）。由 `db::open()` 在基础表之后调用。
pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        -- 知识来源登记表：一条笔记一行
        CREATE TABLE IF NOT EXISTS knowledge_sources (
            source_key   TEXT PRIMARY KEY,          -- 去重键，格式 article:<工作区相对路径>
            source_type  TEXT NOT NULL DEFAULT 'article', -- 来源类型：article/record/canvas
            source_id    TEXT NOT NULL,              -- 来源 id：工作区相对路径
            title        TEXT NOT NULL DEFAULT '',  -- 展示标题（文件名或首个 H1）
            content_hash TEXT NOT NULL DEFAULT '',  -- 正文 sha256，用于跳过未变更文件
            indexed_hash TEXT,                      -- 已成功索引的正文 sha256，与 content_hash 相等才算 ready
            status       TEXT NOT NULL DEFAULT 'pending', -- pending/indexing/ready/failed
            error        TEXT,                      -- 最近一次失败原因，成功时清空
            auto_calc    INTEGER NOT NULL DEFAULT 1, -- 0/1：保存时是否自动计算向量
            included     INTEGER NOT NULL DEFAULT 1, -- 0/1：是否包含在知识库检索中
            updated_at   INTEGER NOT NULL          -- 最后更新时间（毫秒时间戳）
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status
            ON knowledge_sources (source_type, status);

        -- 向量分块表：embedding 以 JSON 数字数组字符串存储，避免引入向量扩展
        CREATE TABLE IF NOT EXISTS vector_documents (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            filename   TEXT NOT NULL,               -- = knowledge_sources.source_key
            chunk_id   INTEGER NOT NULL,            -- 同一文件内从 0 递增
            content    TEXT NOT NULL,               -- 分块正文（含标题上下文）
            embedding  TEXT NOT NULL,               -- JSON 数组字符串，如 "[0.1,-0.2]"
            updated_at INTEGER NOT NULL,            -- 写入时刻（毫秒时间戳）
            UNIQUE (filename, chunk_id)
        );
        CREATE INDEX IF NOT EXISTS idx_vector_documents_filename
            ON vector_documents (filename);

        -- 知识库元数据：embeddingDimension / lastIndexedAt / embeddingModel
        CREATE TABLE IF NOT EXISTS kb_meta (
            key   TEXT PRIMARY KEY,                 -- 元数据键
            value TEXT NOT NULL                     -- 元数据值（字符串）
        );
        "#,
    )
}

/* ---------------- 通用小工具 ---------------- */

/// 当前工作区根目录
fn workspace_root(app: &App) -> Result<PathBuf, RpcError> {
    app.root
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| RpcError::internal("状态锁异常"))
}

/// 取 SQLite 连接（短作用域持有，避免与 settings_get 嵌套死锁）
fn with_db<T>(app: &App, action: impl FnOnce(&mut Connection) -> Result<T, RpcError>) -> Result<T, RpcError> {
    let mut guard = app.db.lock().map_err(|_| RpcError::internal("数据库繁忙"))?;
    action(&mut guard)
}

/// 字符串 sha256（小写 hex）
fn sha256_hex(input: &str) -> String {
    Sha256::digest(input.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 余弦相似度；维度不一致或零向量返回 0
fn cosine(left: &[f64], right: &[f64]) -> f64 {
    if left.is_empty() || left.len() != right.len() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_left = 0.0;
    let mut norm_right = 0.0;
    for index in 0..left.len() {
        dot += left[index] * right[index];
        norm_left += left[index] * left[index];
        norm_right += right[index] * right[index];
    }
    if norm_left <= f64::EPSILON || norm_right <= f64::EPSILON {
        return 0.0;
    }
    dot / (norm_left.sqrt() * norm_right.sqrt())
}

/// 中英混合分词：中文取字符 bigram，英文按小写词，去停用词与空白
fn lexical_terms(text: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut word = String::new();
    let flush = |word: &mut String, terms: &mut Vec<String>| {
        if word.len() >= 2 && !STOP_WORDS.contains(&word.as_str()) {
            terms.push(std::mem::take(word));
        } else {
            word.clear();
        }
    };
    let mut cjk: Vec<char> = Vec::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            word.push(ch.to_ascii_lowercase());
            continue;
        }
        flush(&mut word, &mut terms);
        if ch.is_alphabetic() && !ch.is_ascii() {
            cjk.push(ch);
        } else if !cjk.is_empty() {
            push_bigrams(&cjk, &mut terms);
            cjk.clear();
        }
    }
    flush(&mut word, &mut terms);
    push_bigrams(&cjk, &mut terms);
    terms
}

/// 把中文字符序列切成相邻二字词；单字也保留，便于短查询命中
fn push_bigrams(chars: &[char], terms: &mut Vec<String>) {
    if chars.is_empty() {
        return;
    }
    if chars.len() == 1 {
        let single = chars[0].to_string();
        if !STOP_WORDS.contains(&single.as_str()) {
            terms.push(single);
        }
        return;
    }
    for pair in chars.windows(2) {
        terms.push(pair.iter().collect());
    }
}

/// BM25 单词权重；`df` 返回包含该词的文档数
fn bm25_score(
    query_terms: &[String],
    doc_terms: &[String],
    avg_len: f64,
    docs: usize,
    df: &impl Fn(&str) -> usize,
) -> f64 {
    if doc_terms.is_empty() || docs == 0 {
        return 0.0;
    }
    let mut tf_map: HashMap<&str, usize> = HashMap::new();
    for term in doc_terms {
        *tf_map.entry(term.as_str()).or_insert(0) += 1;
    }
    let doc_len = doc_terms.len() as f64;
    let mut score = 0.0;
    for term in query_terms {
        let tf = *tf_map.get(term.as_str()).unwrap_or(&0) as f64;
        if tf <= 0.0 {
            continue;
        }
        let frequency = df(term) as f64;
        let idf = ((docs as f64 - frequency + 0.5) / (frequency + 0.5) + 1.0).ln().max(0.0);
        let denominator = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * doc_len / avg_len.max(1.0));
        score += idf * (tf * (BM25_K1 + 1.0)) / denominator;
    }
    score
}

/// 解析 embedding 列里的 JSON 数字数组
fn parse_embedding(raw: &str) -> Result<Vec<f64>, RpcError> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| RpcError::internal("向量数据不是合法 JSON"))?;
    let items = value
        .as_array()
        .ok_or_else(|| RpcError::internal("向量数据不是数组"))?;
    let vector: Vec<f64> = items
        .iter()
        .map(|item| item.as_f64().unwrap_or(f64::NAN))
        .collect();
    if vector.is_empty() || vector.iter().any(|number| !number.is_finite()) {
        return Err(RpcError::internal("向量数据含非法数值"));
    }
    Ok(vector)
}

/// 读写 kb_meta
fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM kb_meta WHERE key = ?1", [key], |row| row.get(0))
        .optional()
        .ok()
        .flatten()
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), RpcError> {
    conn.execute(
        "INSERT INTO kb_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// 工作区相对路径统一成 `/`
fn normalize_rel(raw: &str) -> String {
    raw.replace('\\', "/").trim_start_matches("./").trim().to_string()
}

/// 来源键：`article:<相对路径>`（与参考项目 createKnowledgeSourceKey 一致）
fn source_key(rel: &str) -> String {
    format!("article:{}", normalize_rel(rel))
}

fn is_text_file(path: &Path) -> bool {
    path.extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .map(|value| TEXT_EXTENSIONS.contains(&value.as_str()))
        .unwrap_or(false)
}

/* ---------------- Markdown 分块 ---------------- */

#[derive(Clone, Debug)]
struct MdBlock {
    content: String,
    /// atomic 块（代码块 / 表格）不与其他块合并
    atomic: bool,
}

/// 按 Markdown 结构切块：标题上下文随正文携带，代码块与表格保持完整
fn parse_markdown_blocks(text: &str) -> Vec<MdBlock> {
    let lines: Vec<&str> = text.lines().collect();
    let mut blocks: Vec<MdBlock> = Vec::new();
    let mut headings: Vec<String> = Vec::new();
    let mut paragraph: Vec<String> = Vec::new();
    let flush_paragraph = |paragraph: &mut Vec<String>, blocks: &mut Vec<MdBlock>| {
        if paragraph.is_empty() {
            return;
        }
        blocks.push(MdBlock { content: paragraph.join("\n"), atomic: false });
        paragraph.clear();
    };
    let heading_prefix = |headings: &Vec<String>| {
        headings.iter().filter(|item| !item.is_empty()).cloned().collect::<Vec<_>>().join("\n")
    };

    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            flush_paragraph(&mut paragraph, &mut blocks);
            let marker = &trimmed[..3];
            let mut code = vec![line.to_string()];
            index += 1;
            while index < lines.len() {
                code.push(lines[index].to_string());
                if lines[index].trim().starts_with(marker) {
                    index += 1;
                    break;
                }
                index += 1;
            }
            blocks.push(MdBlock { content: code.join("\n"), atomic: true });
            continue;
        }
        if trimmed.contains('|')
            && index + 1 < lines.len()
            && lines[index + 1].trim().replace(['|', ':', '-', ' '], "").is_empty()
            && lines[index + 1].contains('-')
        {
            flush_paragraph(&mut paragraph, &mut blocks);
            let mut table = vec![line.to_string(), lines[index + 1].to_string()];
            index += 2;
            while index < lines.len() && lines[index].contains('|') && !lines[index].trim().is_empty() {
                table.push(lines[index].to_string());
                index += 1;
            }
            blocks.push(MdBlock { content: table.join("\n"), atomic: true });
            continue;
        }
        if let Some(level) = heading_level(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            headings.truncate(level.saturating_sub(1));
            while headings.len() < level {
                headings.push(String::new());
            }
            headings[level - 1] = trimmed.to_string();
            index += 1;
            continue;
        }
        if trimmed.is_empty() {
            flush_paragraph(&mut paragraph, &mut blocks);
            index += 1;
            continue;
        }
        paragraph.push(line.to_string());
        index += 1;
    }
    flush_paragraph(&mut paragraph, &mut blocks);

    let prefix = heading_prefix(&headings);
    if prefix.is_empty() {
        return blocks;
    }
    // 标题栈随正文携带：检索命中片段时能看出它属于哪一节
    blocks
        .into_iter()
        .map(|mut block| {
            if !block.atomic && !block.content.starts_with('#') {
                block.content = format!("{prefix}\n\n{}", block.content);
            }
            block
        })
        .collect()
}

/// 识别 `#`~`######` 标题，返回层级
fn heading_level(line: &str) -> Option<usize> {
    let count = line.chars().take_while(|ch| *ch == '#').count();
    if (1..=6).contains(&count) && line.chars().nth(count).map(|ch| ch.is_whitespace()).unwrap_or(false) {
        Some(count)
    } else {
        None
    }
}

/// 超长块按句子切，再按字符硬切
fn split_long_block(content: &str, chunk_size: usize) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in content.chars() {
        current.push(ch);
        let at_boundary = "。！？.!?\n".contains(ch);
        if current.chars().count() >= chunk_size || (at_boundary && current.chars().count() >= chunk_size / 2) {
            pieces.push(std::mem::take(&mut current));
        }
    }
    if !current.trim().is_empty() {
        pieces.push(current);
    }
    pieces
}

/// 分块主逻辑：块级重叠，返回去空后的正文片段
pub fn chunk_markdown(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let size = chunk_size.max(100);
    let overlap = overlap.min(size / 2);
    let blocks = parse_markdown_blocks(text);
    let mut result: Vec<String> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut pending_len = 0usize;

    let flush = |pending: &mut Vec<String>, result: &mut Vec<String>| {
        if pending.is_empty() {
            return;
        }
        result.push(pending.join("\n\n"));
        // 从尾部按「块」回收集重叠，保持语义完整
        let mut carry: Vec<String> = Vec::new();
        let mut used = 0usize;
        for block in pending.iter().rev() {
            let length = block.chars().count();
            if used + length > overlap {
                break;
            }
            used += length;
            carry.push(block.clone());
        }
        carry.reverse();
        *pending = carry;
    };

    for block in blocks {
        let length = block.content.chars().count();
        // 任何超长块（长段落、代码块、表格）都按句子 / 字符硬切，避免整块撑爆上下文窗口
        if length > size {
            flush(&mut pending, &mut result);
            pending_len = pending.iter().map(|item| item.chars().count()).sum();
            for piece in split_long_block(&block.content, size) {
                result.push(piece);
            }
            continue;
        }
        if pending_len + length > size && !pending.is_empty() {
            flush(&mut pending, &mut result);
            pending_len = pending.iter().map(|item| item.chars().count()).sum();
        }
        pending_len += length;
        pending.push(block.content);
    }
    flush(&mut pending, &mut result);
    result.into_iter().map(|item| item.trim().to_string()).filter(|item| !item.is_empty()).collect()
}

/* ---------------- 设置与 embedding ---------------- */

/// 索引 / 检索参数
#[derive(Clone, Copy, Debug)]
struct RagOptions {
    chunk_size: usize,
    overlap: usize,
    top_k: usize,
    threshold: f64,
}

impl Default for RagOptions {
    fn default() -> Self {
        Self {
            chunk_size: DEFAULT_CHUNK_SIZE,
            overlap: DEFAULT_CHUNK_OVERLAP,
            top_k: DEFAULT_TOP_K,
            threshold: DEFAULT_THRESHOLD,
        }
    }
}

/// 读取 `app.settings`（内部会自行获取并释放 db 锁）
fn app_settings(app: &App) -> Value {
    match crate::db::settings_get(app, &json!({ "key": "app.settings" })) {
        Ok(result) => result.get("value").cloned().unwrap_or(Value::Null),
        Err(error) => {
            crate::logln!("[dbx-note] 读取应用设置失败：{error:?}");
            Value::Null
        }
    }
}

/// 合并默认设置与请求参数
fn options_of(app: &App, params: &Value) -> RagOptions {
    let settings = app_settings(app);
    let rag = settings.get("rag");
    let read = |key: &str, fallback: i64| -> i64 {
        params
            .get(key)
            .and_then(Value::as_i64)
            .or_else(|| rag.and_then(|item| item.get(key)).and_then(Value::as_i64))
            .unwrap_or(fallback)
    };
    let threshold = params
        .get("threshold")
        .and_then(Value::as_f64)
        .or_else(|| rag.and_then(|item| item.get("threshold")).and_then(Value::as_f64))
        .unwrap_or(DEFAULT_THRESHOLD);
    let chunk_size = read("chunkSize", DEFAULT_CHUNK_SIZE as i64).clamp(100, 5000) as usize;
    RagOptions {
        chunk_size,
        overlap: read("chunkOverlap", DEFAULT_CHUNK_OVERLAP as i64)
            .clamp(0, (chunk_size - 50) as i64) as usize,
        top_k: read("topK", DEFAULT_TOP_K as i64).clamp(1, 20) as usize,
        threshold: threshold.clamp(0.0, 1.0),
    }
}

/// embedding 模型信息：baseURL / apiKey / 模型名
struct EmbeddingConfig {
    base_url: String,
    api_key: String,
    model: String,
}

/// 从多厂商多模型配置里解析「用途 = embedding」的默认模型
fn embedding_config(app: &App) -> Result<EmbeddingConfig, RpcError> {
    let settings = app_settings(app);
    let ai = settings.get("ai");
    let selected = ai
        .and_then(|item| item.get("defaults"))
        .and_then(|item| item.get("embedding"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let providers = ai.and_then(|item| item.get("providers")).and_then(Value::as_array);
    let mut found: Option<EmbeddingConfig> = None;
    for provider in providers.into_iter().flatten() {
        let base_url = provider.get("baseUrl").and_then(Value::as_str).unwrap_or_default();
        if base_url.trim().is_empty() {
            continue;
        }
        for model in provider.get("models").and_then(Value::as_array).into_iter().flatten() {
            let is_embedding = model.get("modelType").and_then(Value::as_str) == Some("embedding");
            let id = model.get("id").and_then(Value::as_str).unwrap_or_default();
            if !is_embedding || (selected.is_empty() || id != selected) {
                continue;
            }
            found = Some(EmbeddingConfig {
                base_url: base_url.trim().trim_end_matches('/').to_string(),
                api_key: provider.get("apiKey").and_then(Value::as_str).unwrap_or_default().to_string(),
                model: model.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            });
            break;
        }
        if found.is_some() {
            break;
        }
    }
    found.ok_or_else(|| RpcError::invalid("请先在设置里配置 embedding 模型"))
}

/// 调 OpenAI 兼容 `/embeddings`；批量失败时退回逐条，保证部分厂商不支持数组入参也能用
fn fetch_embeddings(config: &EmbeddingConfig, inputs: &[String]) -> Result<Vec<Vec<f64>>, RpcError> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(EMBEDDING_TIMEOUT_MS))
        .build()
        .map_err(|error| RpcError::internal(format!("创建 HTTP 客户端失败：{error}")))?;
    let url = format!("{}/embeddings", config.base_url);
    let send = |input: Value| -> Result<Value, RpcError> {
        let body = json!({
            "model": config.model,
            "input": input,
            "encoding_format": "float",
        });
        let response = client
            .post(&url)
            .bearer_auth(&config.api_key)
            .json(&body)
            .send()
            .map_err(|error| RpcError::internal(format!("请求 embedding 服务失败：{error}")))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|error| RpcError::internal(format!("读取 embedding 响应失败：{error}")))?;
        if !status.is_success() {
            return Err(RpcError::internal(format!(
                "embedding 服务返回 {status}：{}",
                text.chars().take(300).collect::<String>()
            )));
        }
        serde_json::from_str(&text)
            .map_err(|_| RpcError::internal("embedding 响应不是合法 JSON"))
    };

    let batch = Value::Array(inputs.iter().map(|item| json!(item)).collect());
    if let Ok(parsed) = send(batch) {
        if let Some(vectors) = parse_embedding_response(&parsed, inputs.len()) {
            return Ok(vectors);
        }
    }
    let mut vectors = Vec::with_capacity(inputs.len());
    for input in inputs {
        let parsed = send(json!(input))?;
        let single = parse_embedding_response(&parsed, 1)
            .ok_or_else(|| RpcError::internal("embedding 响应缺少 data[].embedding"))?;
        vectors.push(single.into_iter().next().unwrap_or_default());
    }
    Ok(vectors)
}

/// 按 `index` 升序还原向量顺序，忽略非法数值
fn parse_embedding_response(parsed: &Value, expected: usize) -> Option<Vec<Vec<f64>>> {
    let mut rows: Vec<(usize, Vec<f64>)> = Vec::new();
    for (index, item) in parsed.get("data")?.as_array()?.iter().enumerate() {
        let position = item.get("index").and_then(Value::as_u64).unwrap_or(index as u64) as usize;
        let vector: Vec<f64> = item
            .get("embedding")
            .and_then(Value::as_array)?
            .iter()
            .map(|value| value.as_f64().unwrap_or(f64::NAN))
            .collect();
        if vector.is_empty() || vector.iter().any(|number| !number.is_finite()) {
            return None;
        }
        rows.push((position, vector));
    }
    rows.sort_by_key(|row| row.0);
    let vectors: Vec<Vec<f64>> = rows.into_iter().map(|row| row.1).collect();
    (vectors.len() == expected).then_some(vectors)
}

/* ---------------- 索引 ---------------- */

/// 收集工作区里可索引的笔记（排除隐藏 / 依赖 / 资源目录）
fn collect_files(root: &Path, prefix: &str) -> Vec<String> {
    let base = if prefix.is_empty() {
        root.to_path_buf()
    } else {
        match crate::files::safe_join(root, prefix) {
            Ok(path) => path,
            Err(_) => return Vec::new(),
        }
    };
    WalkDir::new(&base)
        .max_depth(8)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref())
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_text_file(entry.path()))
        .filter_map(|entry| {
            let rel = normalize_rel(&crate::files::relative_path(root, entry.path()));
            (!rel.is_empty()).then_some(rel)
        })
        .take(MAX_INDEX_FILES)
        .collect()
}

/// 单篇笔记的索引结果
#[derive(Default)]
struct IndexOutcome {
    chunks: usize,
    indexed: bool,
}

/// 索引一篇笔记：内容哈希去重 → 分块 → embedding → 事务替换
fn index_one(
    app: &App,
    root: &Path,
    rel: &str,
    options: RagOptions,
    config: &EmbeddingConfig,
) -> Result<IndexOutcome, RpcError> {
    let path = crate::files::safe_join(root, rel)?;
    if !path.is_file() || !is_text_file(&path) {
        return Err(RpcError::invalid("只能索引 Markdown / 文本笔记"));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|error| RpcError::internal(format!("读取笔记失败：{error}")))?;
    let hash = sha256_hex(content.trim());
    let key = source_key(rel);

    let state: Option<(String, String, i64, i64)> = with_db(app, |conn| {
        conn.query_row(
            "SELECT content_hash, COALESCE(indexed_hash, ''), auto_calc, included
             FROM knowledge_sources WHERE source_key = ?1",
            [&key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(RpcError::from)
    })?;
    if let Some((previous, indexed_hash, _, included)) = &state {
        if *included == 0 {
            delete_by_keys(app, &[key.clone()])?;
            return Ok(IndexOutcome::default());
        }
        if previous == &hash && indexed_hash == &hash {
            return Ok(IndexOutcome::default());
        }
    }

    let chunks = chunk_markdown(&content, options.chunk_size, options.overlap);
    if chunks.is_empty() {
        return Ok(IndexOutcome::default());
    }
    let mut vectors: Vec<Vec<f64>> = Vec::with_capacity(chunks.len());
    for batch in chunks.chunks(EMBEDDING_BATCH) {
        vectors.extend(fetch_embeddings(config, batch)?);
    }
    if vectors.len() != chunks.len() {
        return Err(RpcError::internal("embedding 返回数量与分块数量不一致"));
    }
    let dimension = vectors.first().map(Vec::len).unwrap_or(0);
    if vectors.iter().any(|vector| vector.len() != dimension) {
        return Err(RpcError::internal("embedding 维度不一致"));
    }

    let title = content
        .lines()
        .find(|line| heading_level(line.trim()).is_some())
        .map(|line| line.trim_start_matches('#').trim().to_string())
        .unwrap_or_else(|| {
            path.file_stem().map(|value| value.to_string_lossy().to_string()).unwrap_or_default()
        });
    let timestamp = now_ms();
    with_db(app, |conn| {
        let known = get_meta(conn, "embeddingDimension")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let existing = conn
            .query_row("SELECT COUNT(*) FROM vector_documents", [], |row| row.get::<_, i64>(0))
            .unwrap_or(0);
        if known > 0 && known != dimension && existing > 0 {
            return Err(RpcError::invalid("embedding 维度已变化，请先清空索引再重新计算"));
        }
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM vector_documents WHERE filename = ?1", [&key])?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO vector_documents (filename, chunk_id, content, embedding, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for (chunk_id, (text, vector)) in chunks.iter().zip(vectors.iter()).enumerate() {
                let raw = serde_json::to_string(vector)
                    .map_err(|error| RpcError::internal(format!("序列化向量失败：{error}")))?;
                insert.execute(params![key, chunk_id as i64, text, raw, timestamp])?;
            }
        }
        tx.execute(
            "INSERT INTO knowledge_sources
                (source_key, source_type, source_id, title, content_hash, indexed_hash,
                 status, error, auto_calc, included, updated_at)
             VALUES (?1, 'article', ?2, ?3, ?4, ?4, 'ready', NULL,
                     COALESCE((SELECT auto_calc FROM knowledge_sources WHERE source_key = ?1), 1),
                     COALESCE((SELECT included FROM knowledge_sources WHERE source_key = ?1), 1), ?5)
             ON CONFLICT(source_key) DO UPDATE SET
                 title = excluded.title, content_hash = excluded.content_hash,
                 indexed_hash = excluded.indexed_hash, status = 'ready', error = NULL,
                 updated_at = excluded.updated_at",
            params![key, normalize_rel(rel), title, hash, timestamp],
        )?;
        set_meta(&tx, "embeddingDimension", &dimension.to_string())?;
        set_meta(&tx, "lastIndexedAt", &timestamp.to_string())?;
        set_meta(&tx, "embeddingModel", &config.model)?;
        tx.commit()?;
        Ok(())
    })?;
    Ok(IndexOutcome { chunks: chunks.len(), indexed: true })
}

/// 批量删除某些来源的向量与登记
fn delete_by_keys(app: &App, keys: &[String]) -> Result<usize, RpcError> {
    if keys.is_empty() {
        return Ok(0);
    }
    with_db(app, |conn| {
        let tx = conn.transaction()?;
        let mut deleted = 0usize;
        for key in keys {
            deleted += tx.execute("DELETE FROM vector_documents WHERE filename = ?1", [key])?;
        }
        tx.commit()?;
        Ok(deleted)
    })
}

/// 统计信息
fn stats(app: &App, options: RagOptions) -> RpcResult {
    let configured = embedding_config(app).is_ok();
    let model = embedding_config(app)
        .map(|config| config.model)
        .unwrap_or_default();
    with_db(app, |conn| {
        let sources: i64 = conn.query_row(
            "SELECT COUNT(*) FROM knowledge_sources WHERE status IN ('ready', 'lexical')", [], |row| row.get(0),
        )?;
        let chunks: i64 = conn.query_row("SELECT COUNT(*) FROM vector_documents", [], |row| row.get(0))?;
        let mut statement = conn.prepare(
            "SELECT source_id, auto_calc, included FROM knowledge_sources ORDER BY source_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
        })?;
        let mut paths: Vec<String> = Vec::new();
        let mut excluded: Vec<String> = Vec::new();
        let mut auto_disabled: Vec<String> = Vec::new();
        for row in rows {
            let (path, auto_calc, included) = row?;
            paths.push(path.clone());
            if included == 0 { excluded.push(path.clone()); }
            if auto_calc == 0 { auto_disabled.push(path); }
        }
        let dimension = get_meta(conn, "embeddingDimension")
            .and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
        let last_indexed_at = get_meta(conn, "lastIndexedAt")
            .and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
        Ok(json!({
            "configured": configured,
            "embeddingModel": model,
            "sources": sources,
            "chunks": chunks,
            "dimension": dimension,
            "lastIndexedAt": last_indexed_at,
            "paths": paths,
            "excluded": excluded,
            "autoDisabled": auto_disabled,
            "chunkSize": options.chunk_size,
            "chunkOverlap": options.overlap,
            "topK": options.top_k,
            "threshold": options.threshold,
        }))
    })
}

/* ---------------- 对外 RPC ---------------- */

/// `kb/status`：知识库统计与配置状态
pub fn status(app: &App) -> RpcResult {
    stats(app, options_of(app, &json!({})))
}

/// 把批量索引结果汇总成统一返回
/// 未配置 embedding 模型时的降级索引：登记来源，并把整篇作为一个「仅词法」分块。
///
/// 向量位写 `[0.0]` 占位（维度与真实向量不匹配，余弦恒为 0），因此这一路只参与 BM25。
/// 用户后来配好模型再点「全部重新计算」时，`index_one` 会按内容哈希重算并替换成真向量分块。
fn register_source_only(app: &App, root: &Path, rel: &str) -> Result<bool, RpcError> {
    let path = crate::files::safe_join(root, rel)?;
    if !path.is_file() || !is_text_file(&path) {
        return Err(RpcError::invalid("只能索引 Markdown / 文本笔记"));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|error| RpcError::internal(format!("读取笔记失败：{error}")))?;
    let hash = sha256_hex(content.trim());
    let key = source_key(rel);
    let title = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| rel.to_string());
    let timestamp = now_ms();
    with_db(app, |conn| {
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM vector_documents WHERE filename = ?1", [&key])?;
        tx.execute(
            "INSERT INTO vector_documents (filename, chunk_id, content, embedding, updated_at)
             VALUES (?1, 0, ?2, '[0.0]', ?3)",
            params![key, content, timestamp],
        )?;
        tx.execute(
            "INSERT INTO knowledge_sources
                (source_key, source_type, source_id, title, content_hash, indexed_hash,
                 status, error, auto_calc, included, updated_at)
             VALUES (?1, 'article', ?2, ?3, ?4, NULL, 'lexical', NULL,
                     COALESCE((SELECT auto_calc FROM knowledge_sources WHERE source_key = ?1), 1),
                     COALESCE((SELECT included FROM knowledge_sources WHERE source_key = ?1), 1), ?5)
             ON CONFLICT(source_key) DO UPDATE SET
                 title = excluded.title, content_hash = excluded.content_hash,
                 indexed_hash = NULL, status = 'lexical', error = NULL,
                 updated_at = excluded.updated_at",
            params![key, normalize_rel(rel), title, hash, timestamp],
        )?;
        set_meta(&tx, "lastIndexedAt", &timestamp.to_string())?;
        tx.commit()?;
        Ok(())
    })?;
    Ok(true)
}

fn run_batch(app: &App, root: &Path, files: &[String], options: RagOptions) -> RpcResult {
    let config = match embedding_config(app) {
        Ok(value) => value,
        Err(_) => {
            // 没有 embedding 模型：登记来源 + 仅词法分块，BM25 检索与文件树状态仍可用
            let mut registered = 0usize;
            let mut failed: Vec<String> = Vec::new();
            for rel in files {
                match register_source_only(app, root, rel) {
                    Ok(true) => registered += 1,
                    Ok(false) => {}
                    Err(error) => {
                        crate::logln!("[dbx-note] 知识库登记来源失败：{rel} {error:?}");
                        failed.push(rel.clone());
                    }
                }
            }
            return Ok(json!({
                "indexed": registered,
                "chunks": 0,
                "skipped": files.len().saturating_sub(registered + failed.len()),
                "updatedAt": now_ms(),
                "failed": failed,
                "lexicalOnly": true,
            }));
        }
    };
    let mut indexed = 0usize;
    let mut chunks = 0usize;
    let mut skipped = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for rel in files {
        match index_one(app, root, rel, options, &config) {
            Ok(outcome) if outcome.indexed => {
                indexed += 1;
                chunks += outcome.chunks;
            }
            Ok(_) => skipped += 1,
            Err(error) => {
                crate::logln!("[dbx-note] 知识库索引失败：{rel} {error:?}");
                failed.push(rel.clone());
            }
        }
    }
    Ok(json!({ "indexed": indexed, "chunks": chunks, "skipped": skipped, "updatedAt": now_ms(), "failed": failed }))
}

/// `kb/indexFile`：单篇笔记计算 / 更新向量
pub fn index_file_rpc(app: &App, params: &Value) -> RpcResult {
    let root = workspace_root(app)?;
    let rel = normalize_rel(&param_str(params, "path"));
    if rel.is_empty() {
        return Err(RpcError::invalid("缺少笔记路径"));
    }
    run_batch(app, &root, &[rel], options_of(app, params))
}

/// `kb/indexFolder`：整个目录批量计算向量
pub fn index_folder_rpc(app: &App, params: &Value) -> RpcResult {
    let root = workspace_root(app)?;
    let prefix = normalize_rel(&param_str(params, "path"));
    run_batch(app, &root, &collect_files(&root, &prefix), options_of(app, params))
}

/// `kb/reindex`：全量重新计算
pub fn reindex(app: &App, params: &Value) -> RpcResult {
    let root = workspace_root(app)?;
    run_batch(app, &root, &collect_files(&root, ""), options_of(app, params))
}

/// `kb/delete`：删除单文件或整个目录的向量
pub fn delete_vectors(app: &App, params: &Value) -> RpcResult {
    let rel = normalize_rel(&param_str(params, "path"));
    if rel.is_empty() {
        return Err(RpcError::invalid("缺少路径"));
    }
    let keys: Vec<String> = with_db(app, |conn| {
        let mut statement = conn.prepare(
            "SELECT source_key, source_id FROM knowledge_sources
             WHERE source_id = ?1 OR source_id LIKE ?2",
        )?;
        let prefix = format!("{rel}/%");
        let rows = statement.query_map(params![rel, prefix], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut keys = Vec::new();
        for row in rows {
            let (key, path) = row?;
            let matches = path == rel || path.starts_with(&format!("{rel}/"));
            if matches { keys.push(key); }
        }
        Ok(keys)
    })?;
    let deleted = delete_by_keys(app, &keys)?;
    with_db(app, |conn| {
        for key in &keys {
            conn.execute(
                "UPDATE knowledge_sources SET status = 'pending', indexed_hash = NULL,
                 error = NULL, updated_at = ?1 WHERE source_key = ?2",
                params![now_ms(), key],
            )?;
        }
        Ok(())
    })?;
    Ok(json!({ "deleted": deleted }))
}

/// `kb/flags`：查询或设置单篇笔记的「自动计算」「包含在知识库」开关
pub fn set_flags(app: &App, params: &Value) -> RpcResult {
    let rel = normalize_rel(&param_str(params, "path"));
    if rel.is_empty() {
        return Err(RpcError::invalid("缺少笔记路径"));
    }
    let key = source_key(&rel);
    let auto_calc = params.get("autoCalc").and_then(Value::as_bool);
    let included = params.get("included").and_then(Value::as_bool);
    with_db(app, |conn| {
        conn.execute(
            "INSERT INTO knowledge_sources
                (source_key, source_type, source_id, title, content_hash, status,
                 auto_calc, included, updated_at)
             VALUES (?1, 'article', ?2, ?2, '', 'pending',
                     COALESCE(?3, 1), COALESCE(?4, 1), ?5)
             ON CONFLICT(source_key) DO UPDATE SET
                 auto_calc = COALESCE(?3, knowledge_sources.auto_calc),
                 included = COALESCE(?4, knowledge_sources.included),
                 updated_at = ?5",
            params![key, rel, auto_calc.map(|value| i64::from(value)), included.map(|value| i64::from(value)), now_ms()],
        )?;
        let (auto, include) = conn.query_row(
            "SELECT auto_calc, included FROM knowledge_sources WHERE source_key = ?1",
            [&key],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        // 关闭「包含」时立即清掉已有向量，避免检索到被排除的内容
        if included == Some(false) || (included.is_none() && include == 0) {
            drop(conn.execute("DELETE FROM vector_documents WHERE filename = ?1", [&key]));
        }
        Ok(json!({ "path": rel, "autoCalc": auto != 0, "included": include != 0 }))
    })
}

/// `kb/clear`：清空全部向量与登记（高危操作，前端需二次确认）
pub fn clear_all(app: &App) -> RpcResult {
    with_db(app, |conn| {
        let tx = conn.transaction()?;
        let cleared = tx.execute("DELETE FROM vector_documents", [])?;
        tx.execute("DELETE FROM knowledge_sources", [])?;
        tx.execute("DELETE FROM kb_meta", [])?;
        tx.commit()?;
        Ok(json!({ "cleared": cleared }))
    })
}

/// 检索用的一条分块
struct ChunkRow {
    filename: String,
    path: String,
    title: String,
    chunk_id: i64,
    content: String,
    embedding: Vec<f64>,
}

/// 读取所有参与检索的分块
fn load_chunks(app: &App) -> Result<Vec<ChunkRow>, RpcError> {
    with_db(app, |conn| {
        let mut statement = conn.prepare(
            "SELECT d.filename, d.chunk_id, d.content, d.embedding,
                    COALESCE(s.source_id, ''), COALESCE(s.title, '')
             FROM vector_documents d
             LEFT JOIN knowledge_sources s ON s.source_key = d.filename
             WHERE COALESCE(s.included, 1) = 1
             LIMIT ?1",
        )?;
        let rows = statement.query_map([MAX_SEARCH_CHUNKS as i64], |row| {
            Ok((
                row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            ))
        })?;
        let mut chunks = Vec::new();
        for row in rows {
            let (filename, chunk_id, content, raw, path, title) = row?;
            match parse_embedding(&raw) {
                Ok(embedding) => chunks.push(ChunkRow {
                    filename, path, title, chunk_id, content, embedding,
                }),
                Err(error) => crate::logln!("[dbx-note] 跳过损坏向量：{filename} {error:?}"),
            }
        }
        Ok(chunks)
    })
}

/// `kb/search`：向量 + BM25 混合检索，返回可注入 AI 的上下文
pub fn search(app: &App, params: &Value) -> RpcResult {
    let query = param_str(params, "query").trim().to_string();
    if query.is_empty() {
        return Ok(json!({ "items": [], "context": "", "sources": [], "configured": false, "tookMs": 0 }));
    }
    let started = now_ms();
    let options = options_of(app, params);
    let chunks = load_chunks(app)?;
    let configured = embedding_config(app).is_ok();
    let query_terms = lexical_terms(&query);

    // 向量路：query embedding 与所有分块算余弦
    let query_vector: Option<Vec<f64>> = match embedding_config(app) {
        Ok(config) => fetch_embeddings(&config, &[query.clone()])
            .ok()
            .and_then(|vectors| vectors.into_iter().next()),
        Err(_) => None,
    };
    let mut vector_scores: Vec<(usize, f64)> = Vec::new();
    if let Some(vector) = &query_vector {
        for (index, chunk) in chunks.iter().enumerate() {
            let score = cosine(vector, &chunk.embedding);
            if score >= options.threshold {
                vector_scores.push((index, score));
            }
        }
        vector_scores.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal));
        vector_scores.truncate(options.top_k * 4);
    }

    // 词法路：内存 BM25（每次检索重建，数据量小且无需持久化）
    let term_lists: Vec<Vec<String>> = chunks.iter().map(|chunk| lexical_terms(&chunk.content)).collect();
    let avg_len = term_lists.iter().map(Vec::len).sum::<usize>() as f64 / term_lists.len().max(1) as f64;
    let mut document_frequency: HashMap<String, usize> = HashMap::new();
    for terms in &term_lists {
        let unique: HashSet<&String> = terms.iter().collect();
        for term in unique {
            *document_frequency.entry(term.clone()).or_insert(0) += 1;
        }
    }
    let df = |term: &str| -> usize { *document_frequency.get(term).unwrap_or(&0) };
    let mut lexical_scores: Vec<(usize, f64)> = term_lists
        .iter()
        .enumerate()
        .map(|(index, terms)| {
            (index, bm25_score(&query_terms, terms, avg_len, term_lists.len(), &df))
        })
        .filter(|(_, score)| *score > 0.0)
        .collect();
    lexical_scores.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal));
    lexical_scores.truncate(options.top_k * 4);
    let lexical_max = lexical_scores.first().map(|row| row.1).unwrap_or(0.0).max(f64::EPSILON);

    // RRF 融合：排序分 = Σ 权重 / (K + rank)，展示分取该 chunk 最强的原始证据
    let mut fused: HashMap<usize, (f64, f64, String)> = HashMap::new();
    for (rank, (index, score)) in vector_scores.iter().enumerate() {
        let entry = fused.entry(*index).or_insert((0.0, 0.0, String::new()));
        entry.0 += VECTOR_WEIGHT / (RRF_K + rank as f64 + 1.0);
        entry.1 = entry.1.max(*score);
        entry.2 = "vector".to_string();
    }
    for (rank, (index, score)) in lexical_scores.iter().enumerate() {
        let entry = fused.entry(*index).or_insert((0.0, 0.0, String::new()));
        entry.0 += LEXICAL_WEIGHT / (RRF_K + rank as f64 + 1.0);
        entry.1 = entry.1.max(score / lexical_max);
        if entry.2 == "vector" { entry.2 = "hybrid".to_string(); }
        else if entry.2.is_empty() { entry.2 = "lexical".to_string(); }
    }
    let mut ranked: Vec<(usize, f64, f64, String)> = fused
        .into_iter()
        .map(|(index, (rank_score, evidence, matched))| (index, rank_score, evidence, matched))
        .collect();
    ranked.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(options.top_k);

    let mut items: Vec<Value> = Vec::new();
    let mut context_parts: Vec<String> = Vec::new();
    let mut sources: Vec<String> = Vec::new();
    let mut used = 0usize;
    for (index, _, evidence, matched) in ranked {
        let chunk = &chunks[index];
        let text = if chunk.content.chars().count() > 1600 {
            chunk.content.chars().take(1600).collect::<String>()
        } else {
            chunk.content.clone()
        };
        if used + text.chars().count() > MAX_CONTEXT_CHARS {
            break;
        }
        used += text.chars().count();
        items.push(json!({
            "path": chunk.path,
            "title": chunk.title,
            "content": text,
            "score": evidence,
            "chunkId": chunk.chunk_id,
            "matched": matched,
        }));
        context_parts.push(format!("文件：{}\n{}\n", chunk.path, text));
        if !sources.contains(&chunk.path) {
            sources.push(chunk.path.clone());
        }
        let _ = &chunk.filename;
    }
    Ok(json!({
        "items": items,
        "context": context_parts.join("\n---\n\n"),
        "sources": sources,
        "configured": configured,
        "tookMs": now_ms() - started,
    }))
}

/* ---------------- 快照导入 / 导出 ---------------- */

/// 快照里的一个来源
#[derive(Clone)]
struct SnapshotSource {
    source_key: String,
    source_type: String,
    source_id: String,
    title: String,
    content_hash: String,
    indexed_hash: Option<String>,
    status: String,
    error: Option<String>,
    auto_calc: i64,
    included: i64,
    updated_at: i64,
}

/// 快照里的一个向量分块
#[derive(Clone)]
struct SnapshotDocument {
    filename: String,
    chunk_id: i64,
    content: String,
    embedding: Vec<f64>,
    updated_at: i64,
}

/// 解析并校验快照（单测覆盖）
fn parse_snapshot(raw: &str) -> Result<(i64, usize, String, Vec<SnapshotSource>, Vec<SnapshotDocument>), RpcError> {
    if raw.len() > MAX_SNAPSHOT_BYTES {
        return Err(RpcError::invalid("知识库快照过大"));
    }
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| RpcError::invalid("知识库快照不是合法 JSON"))?;
    let version = value.get("schemaVersion").and_then(Value::as_i64).unwrap_or(0);
    if version != SNAPSHOT_SCHEMA_VERSION {
        return Err(RpcError::invalid("知识库快照版本不兼容"));
    }
    let dimension = value.get("embeddingDimension").and_then(Value::as_u64).unwrap_or(0) as usize;
    let model = value.get("embeddingModel").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut documents: Vec<SnapshotDocument> = Vec::new();
    for item in value.get("documents").and_then(Value::as_array).into_iter().flatten() {
        let embedding = parse_embedding(item.get("embedding").and_then(Value::as_str).unwrap_or_default())?;
        if dimension > 0 && embedding.len() != dimension {
            return Err(RpcError::invalid("知识库快照里的向量维度不一致"));
        }
        documents.push(SnapshotDocument {
            filename: item.get("filename").and_then(Value::as_str).unwrap_or_default().to_string(),
            chunk_id: item.get("chunkId").and_then(Value::as_i64).unwrap_or(0),
            content: item.get("content").and_then(Value::as_str).unwrap_or_default().to_string(),
            embedding,
            updated_at: item.get("updatedAt").and_then(Value::as_i64).unwrap_or_else(now_ms),
        });
    }
    let mut sources: Vec<SnapshotSource> = Vec::new();
    for item in value.get("sources").and_then(Value::as_array).into_iter().flatten() {
        sources.push(SnapshotSource {
            source_key: item.get("sourceKey").and_then(Value::as_str).unwrap_or_default().to_string(),
            source_type: item.get("sourceType").and_then(Value::as_str).unwrap_or("article").to_string(),
            source_id: item.get("sourceId").and_then(Value::as_str).unwrap_or_default().to_string(),
            title: item.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
            content_hash: item.get("contentHash").and_then(Value::as_str).unwrap_or_default().to_string(),
            indexed_hash: item.get("indexedHash").and_then(Value::as_str).map(str::to_string),
            status: item.get("status").and_then(Value::as_str).unwrap_or("ready").to_string(),
            error: item.get("error").and_then(Value::as_str).map(str::to_string),
            auto_calc: item.get("autoCalc").and_then(Value::as_i64).unwrap_or(1),
            included: item.get("included").and_then(Value::as_i64).unwrap_or(1),
            updated_at: item.get("updatedAt").and_then(Value::as_i64).unwrap_or_else(now_ms),
        });
    }
    Ok((version, dimension, model, sources, documents))
}

/// `kb/export`：导出快照 JSON，并写到工作区供云同步带走
pub fn export_snapshot(app: &App) -> RpcResult {
    let root = workspace_root(app)?;
    let (sources, documents, dimension, model) = with_db(app, |conn| {
        let mut statement = conn.prepare(
            "SELECT source_key, source_type, source_id, title, content_hash, indexed_hash,
                    status, error, auto_calc, included, updated_at
             FROM knowledge_sources ORDER BY source_key",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(json!({
                "sourceKey": row.get::<_, String>(0)?,
                "sourceType": row.get::<_, String>(1)?,
                "sourceId": row.get::<_, String>(2)?,
                "title": row.get::<_, String>(3)?,
                "contentHash": row.get::<_, String>(4)?,
                "indexedHash": row.get::<_, Option<String>>(5)?,
                "status": row.get::<_, String>(6)?,
                "error": row.get::<_, Option<String>>(7)?,
                "autoCalc": row.get::<_, i64>(8)?,
                "included": row.get::<_, i64>(9)?,
                "updatedAt": row.get::<_, i64>(10)?,
            }))
        })?;
        let mut sources = Vec::new();
        for row in rows { sources.push(row?); }
        let mut statement = conn.prepare(
            "SELECT filename, chunk_id, content, embedding, updated_at
             FROM vector_documents ORDER BY filename, chunk_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(json!({
                "filename": row.get::<_, String>(0)?,
                "chunkId": row.get::<_, i64>(1)?,
                "content": row.get::<_, String>(2)?,
                "embedding": row.get::<_, String>(3)?,
                "updatedAt": row.get::<_, i64>(4)?,
            }))
        })?;
        let mut documents = Vec::new();
        for row in rows { documents.push(row?); }
        let dimension = get_meta(conn, "embeddingDimension")
            .and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
        let model = get_meta(conn, "embeddingModel").unwrap_or_default();
        Ok((sources, documents, dimension, model))
    })?;
    let snapshot = json!({
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "generatedAt": now_ms(),
        "embeddingModel": model,
        "embeddingDimension": dimension,
        "sources": sources,
        "documents": documents,
    });
    let raw = serde_json::to_string_pretty(&snapshot)
        .map_err(|error| RpcError::internal(format!("序列化快照失败：{error}")))?;
    let path = root.join(KB_SNAPSHOT_REL);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| RpcError::internal(format!("创建快照目录失败：{error}")))?;
    }
    std::fs::write(&path, &raw)
        .map_err(|error| RpcError::internal(format!("写入知识库快照失败：{error}")))?;
    Ok(json!({
        "json": raw,
        "path": path.to_string_lossy().to_string(),
        "count": snapshot.get("sources").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "vectorCount": snapshot.get("documents").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
    }))
}

/// `kb/import`：从 JSON 或工作区快照恢复（整体事务替换）
pub fn import_snapshot(app: &App, params: &Value) -> RpcResult {
    let root = workspace_root(app)?;
    let raw = match params.get("json").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => std::fs::read_to_string(root.join(KB_SNAPSHOT_REL))
            .map_err(|_| RpcError::invalid("工作区里还没有知识库快照，请先上传或从云端下载"))?,
    };
    let (_, dimension, model, sources, documents) = parse_snapshot(&raw)?;
    let count = sources.len();
    let vector_count = documents.len();
    with_db(app, |conn| {
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM vector_documents", [])?;
        tx.execute("DELETE FROM knowledge_sources", [])?;
        for source in &sources {
            tx.execute(
                "INSERT INTO knowledge_sources
                    (source_key, source_type, source_id, title, content_hash, indexed_hash,
                     status, error, auto_calc, included, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    source.source_key, source.source_type, source.source_id, source.title,
                    source.content_hash, source.indexed_hash, source.status, source.error,
                    source.auto_calc, source.included, source.updated_at
                ],
            )?;
        }
        for document in &documents {
            let embedding = serde_json::to_string(&document.embedding)
                .map_err(|error| RpcError::internal(format!("序列化向量失败：{error}")))?;
            tx.execute(
                "INSERT OR REPLACE INTO vector_documents
                    (filename, chunk_id, content, embedding, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![document.filename, document.chunk_id, document.content, embedding, document.updated_at],
            )?;
        }
        set_meta(&tx, "embeddingDimension", &dimension.to_string())?;
        set_meta(&tx, "embeddingModel", &model)?;
        set_meta(&tx, "lastIndexedAt", &now_ms().to_string())?;
        tx.commit()?;
        Ok(json!({ "count": count, "vectorCount": vector_count, "dimension": dimension }))
    })
}

/* ---------------- 旧版兼容（0.5.5 的 kb 系列 RPC） ---------------- */

/// 旧 `kb/status`：只回 {count, paths, updatedAt}
pub fn legacy_status(app: &App) -> RpcResult {
    let current = stats(app, RagOptions::default())?;
    Ok(json!({
        "count": current.get("sources").and_then(Value::as_i64).unwrap_or(0),
        "paths": current.get("paths").cloned().unwrap_or(json!([])),
        "updatedAt": current.get("lastIndexedAt").and_then(Value::as_i64).unwrap_or(0),
    }))
}

/// 旧 `kb/reindex`
pub fn legacy_reindex(app: &App) -> RpcResult {
    let result = reindex(app, &json!({}))?;
    Ok(json!({
        "count": result.get("indexed").and_then(Value::as_i64).unwrap_or(0),
        "updatedAt": result.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
    }))
}

/// 旧 `kb/upsert`
pub fn legacy_upsert(app: &App, params: &Value) -> RpcResult {
    let result = index_file_rpc(app, params)?;
    let count = stats(app, RagOptions::default())?
        .get("sources").and_then(Value::as_i64).unwrap_or(0);
    let _ = result;
    Ok(json!({ "count": count }))
}

/// 旧 `kb/export`
pub fn legacy_export(app: &App) -> RpcResult {
    let snapshot = export_snapshot(app)?;
    Ok(json!({ "json": snapshot.get("json").cloned().unwrap_or(json!("")) }))
}

/// 旧 `kb/import`
pub fn legacy_import(app: &App, params: &Value) -> RpcResult {
    let result = import_snapshot(app, params)?;
    Ok(json!({ "count": result.get("count").and_then(Value::as_i64).unwrap_or(0) }))
}

/* ---------------- 知识图谱：向量库的只读派生视图 ---------------- */
// 设计要点：
// 1. 不重新调用 embedding、不写表、不扫 Markdown 链接；图谱完全由
//    vector_documents.embedding + knowledge_sources 派生，未配置 embedding 时
//    降级为 BM25 词法相似，保证 lexical-only 知识库也能出图。
// 2. 节点 / 边有硬上限；超过 GRAPH_EXACT_LIMIT 时用词法倒排取候选，
//    避免 O(N²·dim) 在大库上失控。
// 3. 只把节点 / 边（约 100~200KB）经 JSON-RPC 传给前端，embedding 绝不离开 Sidecar。
// 4. 快照按数据指纹缓存；指纹包含 count / max(updated_at) / included 之和，
//    可覆盖 reindex、flags、deleteVectors、snapshotImport 等所有改数据的入口。

/// 每个节点最多保留几个邻居（相对 top-k，避免绝对阈值在不同 embedding 模型下炸图 / 空图）
const GRAPH_TOP_K: usize = 4;
/// 超过这个节点数启用词法候选剪枝
const GRAPH_EXACT_LIMIT: usize = 900;
/// 剪枝时每个节点最多取多少候选
const GRAPH_CANDIDATES: usize = 48;
/// 单张图的节点 / 边上限
const GRAPH_MAX_NODES: usize = 300;
const GRAPH_MAX_EDGES: usize = 600;
/// 节点携带的知识块正文摘要长度（右侧详情直接复用，避免再发一次 RPC）
const GRAPH_EXCERPT_CHARS: usize = 600;

#[derive(Clone)]
struct GraphNode {
    id: String,
    kind: &'static str,
    label: String,
    path: String,
    title: String,
    chunk_id: Option<i64>,
    excerpt: String,
    vector: Vec<f64>,
    terms: Vec<String>,
    chunk_count: usize,
}

struct GraphOptions {
    granularity: String,
    threshold: f64,
    top_k: usize,
    max_nodes: usize,
    max_edges: usize,
    focus: Option<String>,
}

fn graph_options(params: &Value) -> GraphOptions {
    let requested = param_str(params, "granularity");
    let granularity = match requested.as_str() {
        "chunk" => "chunk",
        _ => "source",
    }
    .to_string();
    let number = |key: &str, default: usize, min: usize, max: usize| -> usize {
        params
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or(default as u64)
            .clamp(min as u64, max as u64) as usize
    };
    let focus_raw = param_str(params, "focus");
    let focus = focus_raw.trim();
    GraphOptions {
        granularity,
        threshold: params
            .get("threshold")
            .and_then(Value::as_f64)
            .unwrap_or(0.35)
            .clamp(0.0, 1.0),
        top_k: number("topK", GRAPH_TOP_K, 1, 12),
        max_nodes: number("maxNodes", GRAPH_MAX_NODES, 20, GRAPH_MAX_NODES),
        max_edges: number("maxEdges", GRAPH_MAX_EDGES, 20, GRAPH_MAX_EDGES),
        focus: if focus.is_empty() { None } else { Some(focus.to_string()) },
    }
}

/// 摘要压成单行并截断，避免一个知识块把图谱 JSON 撑大
fn graph_excerpt(text: &str) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for ch in text.chars() {
        if count >= GRAPH_EXCERPT_CHARS {
            break;
        }
        let ch = if ch.is_whitespace() { ' ' } else { ch };
        if ch == ' ' && out.ends_with(' ') {
            continue;
        }
        out.push(ch);
        count += 1;
    }
    out.trim().to_string()
}

fn graph_base_name(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "未命名笔记".to_string())
}

/// 数据水印：任何写向量库 / 改包含开关的动作都会让它变化
fn graph_fingerprint(app: &App) -> Result<String, RpcError> {
    with_db(app, |conn| {
        let (chunks, chunk_stamp): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(MAX(updated_at), 0) FROM vector_documents",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (sources, source_stamp, included): (i64, i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(MAX(updated_at), 0), COALESCE(SUM(included), 0)
             FROM knowledge_sources",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let dimension = get_meta(conn, "embeddingDimension").unwrap_or_default();
        let stamp = get_meta(conn, "lastIndexedAt").unwrap_or_default();
        Ok(format!(
            "{chunks}/{chunk_stamp}/{sources}/{source_stamp}/{included}/{dimension}/{stamp}"
        ))
    })
}

struct GraphCacheEntry {
    key: String,
    payload: Value,
}

/// 只缓存最近一次快照：插件 Sidecar 单进程单工作区足够，且不用给 App 加锁字段
fn graph_cache() -> &'static Mutex<Option<GraphCacheEntry>> {
    static CACHE: OnceLock<Mutex<Option<GraphCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 把分块组装成节点：source 粒度做向量均值池化，chunk 粒度一节点一块
fn graph_nodes(chunks: &[ChunkRow], granularity: &str, dimension: usize) -> Vec<GraphNode> {
    let mut nodes: Vec<GraphNode> = Vec::new();
    if granularity == "chunk" {
        for chunk in chunks {
            let label = if chunk.title.is_empty() {
                graph_base_name(&chunk.path)
            } else {
                chunk.title.clone()
            };
            let vector = if dimension > 0 && chunk.embedding.len() == dimension {
                chunk.embedding.clone()
            } else {
                Vec::new()
            };
            let text: String = chunk.content.chars().take(4000).collect();
            nodes.push(GraphNode {
                id: format!("chunk:{}:{}", chunk.filename, chunk.chunk_id),
                kind: "chunk",
                label: format!("{} · #{}", label, chunk.chunk_id + 1),
                path: chunk.path.clone(),
                title: label,
                chunk_id: Some(chunk.chunk_id),
                excerpt: graph_excerpt(&chunk.content),
                vector,
                terms: lexical_terms(&text),
                chunk_count: 1,
            });
        }
        return nodes;
    }

    let mut index: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (position, chunk) in chunks.iter().enumerate() {
        let slot = match index.get(&chunk.filename) {
            Some(value) => *value,
            None => {
                let next = groups.len();
                groups.push(Vec::new());
                index.insert(chunk.filename.clone(), next);
                next
            }
        };
        groups[slot].push(position);
    }
    for group in groups {
        let first = &chunks[group[0]];
        let label = if first.title.is_empty() {
            graph_base_name(&first.path)
        } else {
            first.title.clone()
        };
        let mut vector = vec![0.0f64; dimension];
        let mut counted = 0usize;
        if dimension > 0 {
            for &position in &group {
                if chunks[position].embedding.len() == dimension {
                    for (offset, value) in chunks[position].embedding.iter().enumerate() {
                        vector[offset] += value;
                    }
                    counted += 1;
                }
            }
            if counted == 0 {
                vector.clear();
            } else {
                for value in &mut vector {
                    *value /= counted as f64;
                }
            }
        } else {
            vector.clear();
        }
        let joined: String = group
            .iter()
            .flat_map(|&position| chunks[position].content.chars())
            .take(4000)
            .collect();
        nodes.push(GraphNode {
            id: format!("source:{}", first.filename),
            kind: "source",
            label: label.clone(),
            path: first.path.clone(),
            title: label,
            chunk_id: None,
            excerpt: graph_excerpt(&chunks[group[0]].content),
            vector,
            terms: lexical_terms(&joined),
            chunk_count: group.len(),
        });
    }
    nodes
}

/// 打分上下文：有真向量走余弦，否则用对称 BM25
struct GraphScoreContext {
    vector_ready: bool,
    avg_len: f64,
    docs: usize,
    df: HashMap<String, usize>,
}

impl GraphScoreContext {
    fn build(nodes: &[GraphNode], vector_ready: bool) -> Self {
        let mut df: HashMap<String, usize> = HashMap::new();
        let mut total = 0usize;
        for node in nodes {
            total += node.terms.len();
            let unique: HashSet<&String> = node.terms.iter().collect();
            for term in unique {
                *df.entry(term.clone()).or_insert(0) += 1;
            }
        }
        Self {
            vector_ready,
            avg_len: total as f64 / nodes.len().max(1) as f64,
            docs: nodes.len(),
            df,
        }
    }

    fn score(&self, left: &GraphNode, right: &GraphNode) -> f64 {
        if self.vector_ready {
            return cosine(&left.vector, &right.vector).max(0.0);
        }
        let lookup = |term: &str| -> usize { *self.df.get(term).unwrap_or(&0) };
        let forward = bm25_score(&left.terms, &right.terms, self.avg_len, self.docs, &lookup);
        let backward = bm25_score(&right.terms, &left.terms, self.avg_len, self.docs, &lookup);
        (forward + backward) / 2.0
    }
}

fn graph_payload(app: &App, options: &GraphOptions) -> Result<Value, RpcError> {
    let fingerprint = graph_fingerprint(app)?;
    let key = format!(
        "{}|{}|{:.3}|{}|{}|{}|{}",
        fingerprint,
        options.granularity,
        options.threshold,
        options.top_k,
        options.max_nodes,
        options.max_edges,
        options.focus.as_deref().unwrap_or(""),
    );
    if let Ok(guard) = graph_cache().lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.key == key {
                return Ok(entry.payload.clone());
            }
        }
    }
    let payload = graph_compute(app, options, &fingerprint)?;
    if let Ok(mut guard) = graph_cache().lock() {
        *guard = Some(GraphCacheEntry { key, payload: payload.clone() });
    }
    Ok(payload)
}

fn graph_compute(app: &App, options: &GraphOptions, watermark: &str) -> Result<Value, RpcError> {
    let chunks = load_chunks(app)?;
    let dimension = with_db(app, |conn| {
        Ok(get_meta(conn, "embeddingDimension")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0))
    })?;
    let embedding = embedding_config(app).ok();
    let configured = embedding.is_some();
    let model = embedding.map(|value| value.model).unwrap_or_default();
    let source_count = chunks
        .iter()
        .map(|chunk| &chunk.filename)
        .collect::<HashSet<_>>()
        .len();

    let mut nodes = graph_nodes(&chunks, &options.granularity, dimension);
    let total_nodes = nodes.len();
    // 占位向量 '[0.0]' 长度为 1，dimension 通常 >= 2；据此区分真向量与词法占位
    let vector_ready = dimension > 1 && nodes.iter().any(|node| node.vector.len() == dimension);
    let context = GraphScoreContext::build(&nodes, vector_ready);

    // 「发现」：以 focus 为中心取最相近的一批节点组成局部子图
    if let Some(focus_id) = &options.focus {
        if let Some(focus_index) = nodes.iter().position(|node| &node.id == focus_id) {
            let mut ranked: Vec<(usize, f64)> = (0..nodes.len())
                .filter(|&position| position != focus_index)
                .map(|position| (position, context.score(&nodes[focus_index], &nodes[position])))
                .collect();
            ranked.sort_by(|left, right| {
                right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut picked = vec![focus_index];
            picked.extend(
                ranked
                    .into_iter()
                    .take(options.max_nodes.saturating_sub(1))
                    .map(|(position, _)| position),
            );
            picked.sort_unstable();
            let snapshot = nodes;
            nodes = picked
                .into_iter()
                .filter_map(|position| snapshot.get(position).cloned())
                .collect();
        }
    }

    let truncated = total_nodes > nodes.len() || nodes.len() > options.max_nodes;
    nodes.truncate(options.max_nodes);
    let count = nodes.len();

    let mut pairs: Vec<(usize, usize, f64)> = Vec::new();
    if count > GRAPH_EXACT_LIMIT {
        // 大库：先用词法倒排取候选，再只对这些候选算相似度
        let mut inverted: HashMap<String, Vec<usize>> = HashMap::new();
        for (position, node) in nodes.iter().enumerate() {
            let unique: HashSet<&String> = node.terms.iter().collect();
            for term in unique {
                inverted.entry(term.clone()).or_default().push(position);
            }
        }
        for left in 0..count {
            let mut counter: HashMap<usize, usize> = HashMap::new();
            for term in &nodes[left].terms {
                if let Some(list) = inverted.get(term) {
                    for &right in list {
                        if right > left {
                            *counter.entry(right).or_insert(0) += 1;
                        }
                    }
                }
            }
            let mut candidates: Vec<(usize, usize)> = counter.into_iter().collect();
            candidates.sort_by(|a, b| b.1.cmp(&a.1));
            candidates.truncate(GRAPH_CANDIDATES);
            for (right, _) in candidates {
                pairs.push((left, right, context.score(&nodes[left], &nodes[right])));
            }
        }
    } else {
        for left in 0..count {
            for right in (left + 1)..count {
                pairs.push((left, right, context.score(&nodes[left], &nodes[right])));
            }
        }
    }

    // 词法分支的原始分不是 0~1，归一化后阈值滑杆才有稳定语义
    if !vector_ready {
        let max_raw = pairs.iter().fold(0.0f64, |acc, item| acc.max(item.2));
        if max_raw > 0.0 {
            for pair in &mut pairs {
                pair.2 /= max_raw;
            }
        }
    }
    pairs.retain(|item| item.2 >= options.threshold);
    pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    let mut degree = vec![0usize; count];
    let mut edges: Vec<Value> = Vec::new();
    for (left, right, score) in &pairs {
        if edges.len() >= options.max_edges {
            break;
        }
        if degree[*left] >= options.top_k || degree[*right] >= options.top_k {
            continue;
        }
        degree[*left] += 1;
        degree[*right] += 1;
        edges.push(json!({
            "source": nodes[*left].id,
            "target": nodes[*right].id,
            "score": (score * 1000.0).round() / 1000.0,
            "kind": if vector_ready { "semantic" } else { "lexical" },
        }));
    }

    // chunk 粒度额外画「同文档相邻块」结构边，不参与相似度计算
    if options.granularity == "chunk" {
        for left in 0..count {
            for right in (left + 1)..count {
                if edges.len() >= options.max_edges {
                    break;
                }
                let a = &nodes[left];
                let b = &nodes[right];
                let adjacent = match (a.chunk_id, b.chunk_id) {
                    (Some(x), Some(y)) => (x - y).abs() == 1,
                    _ => false,
                };
                if a.path != b.path || !adjacent {
                    continue;
                }
                degree[left] += 1;
                degree[right] += 1;
                edges.push(json!({
                    "source": a.id,
                    "target": b.id,
                    "score": 1.0,
                    "kind": "adjacent",
                }));
            }
        }
    }

    let node_values: Vec<Value> = nodes
        .iter()
        .enumerate()
        .map(|(position, node)| {
            json!({
                "id": node.id,
                "kind": node.kind,
                "label": node.label,
                "path": node.path,
                "title": node.title,
                "chunkId": node.chunk_id,
                "excerpt": node.excerpt,
                "degree": degree[position],
                "chunkCount": node.chunk_count,
                "isolated": degree[position] == 0,
            })
        })
        .collect();

    Ok(json!({
        "nodes": node_values,
        "edges": edges,
        "meta": {
            "computedAt": now_ms(),
            "watermark": watermark,
            "dimension": dimension,
            "model": model,
            "configured": configured,
            "chunks": chunks.len(),
            "sources": source_count,
            "strategy": if vector_ready { "vector" } else { "lexical" },
            "granularity": options.granularity,
            "threshold": options.threshold,
            "topK": options.top_k,
            "truncated": truncated,
            "nodeCount": count,
            "edgeCount": edges.len(),
            "maxNodes": options.max_nodes,
            "maxEdges": options.max_edges,
        },
    }))
}

/// `kb/graph`：从向量库派生语义知识图谱（只读，不重新计算 embedding）
pub fn graph(app: &App, params: &Value) -> RpcResult {
    let options = graph_options(params);
    Ok(graph_payload(app, &options)?)
}

/// `kb/graph/neighbors`：以某个节点为中心做局部「发现」，返回可合并的子图
pub fn graph_neighbors(app: &App, params: &Value) -> RpcResult {
    let node_id = param_str(params, "nodeId").trim().to_string();
    if node_id.is_empty() {
        return Err(RpcError::invalid("nodeId 不能为空"));
    }
    let mut options = graph_options(params);
    options.focus = Some(node_id);
    options.max_nodes = options.max_nodes.min(24);
    options.max_edges = options.max_edges.min(80);
    let payload = graph_payload(app, &options)?;
    Ok(json!({
        "nodes": payload.get("nodes").cloned().unwrap_or_else(|| json!([])),
        "edges": payload.get("edges").cloned().unwrap_or_else(|| json!([])),
        "meta": payload.get("meta").cloned().unwrap_or_else(|| json!({})),
    }))
}

/* ---------------- 单元测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_markdown_keeps_blocks_and_overlap() {
        let text = "# 标题\n\n第一段内容。\n\n第二段内容。\n\n```rust\nfn main() {}\n```\n";
        let chunks = chunk_markdown(text, 40, 10);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().any(|item| item.contains("标题")));
        assert!(chunks.iter().any(|item| item.contains("fn main")));
    }

    #[test]
    fn chunk_markdown_splits_long_paragraph() {
        let text = "甲".repeat(500);
        let chunks = chunk_markdown(&text, 100, 20);
        assert!(chunks.len() >= 4, "长段落必须被切开，实际 {} 块", chunks.len());
        assert!(chunks.iter().all(|item| !item.is_empty()));
    }

    #[test]
    fn code_and_table_blocks_are_atomic() {
        let blocks = parse_markdown_blocks("# H\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\nx\n```\n");
        assert!(blocks.iter().any(|item| item.atomic && item.content.contains("| 1 | 2 |")));
        assert!(blocks.iter().any(|item| item.atomic && item.content.contains("```")));
    }

    #[test]
    fn sha256_hex_matches_known_value() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn cosine_handles_identical_orthogonal_and_mismatched() {
        let vector = vec![1.0, 0.0, 1.0];
        assert!((cosine(&vector, &vector) - 1.0).abs() < 1e-9);
        assert_eq!(cosine(&vector, &[0.0, 1.0, 0.0]), 0.0);
        assert_eq!(cosine(&vector, &[1.0, 0.0]), 0.0);
    }

    #[test]
    fn lexical_terms_support_cjk_and_latin() {
        let terms = lexical_terms("知识库 RAG 检索 vector search");
        assert!(terms.contains(&"知识".to_string()));
        assert!(terms.contains(&"rag".to_string()));
        assert!(terms.contains(&"vector".to_string()));
        assert!(!terms.contains(&"the".to_string()));
    }

    #[test]
    fn bm25_rewards_matching_documents() {
        let query = lexical_terms("知识库");
        let matched = lexical_terms("知识库的向量检索实现");
        let unmatched = lexical_terms("完全无关的天气预报内容");
        let df = |_: &str| 1usize;
        let hit = bm25_score(&query, &matched, 8.0, 2, &df);
        let miss = bm25_score(&query, &unmatched, 8.0, 2, &df);
        assert!(hit > 0.0);
        assert_eq!(miss, 0.0);
    }

    #[test]
    fn parse_snapshot_rejects_bad_version_and_dimension() {
        let bad_version = json!({ "schemaVersion": 1, "documents": [] }).to_string();
        assert!(parse_snapshot(&bad_version).is_err());
        let bad_dimension = json!({
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
            "embeddingDimension": 2,
            "documents": [{ "filename": "article:a.md", "chunkId": 0,
                            "content": "正文", "embedding": "[0.1,0.2,0.3]", "updatedAt": 1 }],
            "sources": []
        }).to_string();
        assert!(parse_snapshot(&bad_dimension).is_err());
    }

    #[test]
    fn parse_snapshot_accepts_valid_payload() {
        let raw = json!({
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
            "embeddingDimension": 2,
            "documents": [{ "filename": "article:a.md", "chunkId": 0,
                            "content": "正文", "embedding": "[0.1,0.2]", "updatedAt": 1 }],
            "sources": [{ "sourceKey": "article:a.md", "sourceId": "a.md",
                          "title": "a", "status": "ready" }]
        }).to_string();
        let (_, dimension, _, sources, documents) = parse_snapshot(&raw).expect("快照应可解析");
        assert_eq!(dimension, 2);
        assert_eq!(sources.len(), 1);
        assert_eq!(documents[0].embedding.len(), 2);
    }

    #[test]
    fn graph_excerpt_flattens_and_truncates() {
        let text = "一行\n\n  另一行  ".repeat(40);
        let excerpt = graph_excerpt(&text);
        assert!(excerpt.chars().count() <= GRAPH_EXCERPT_CHARS);
        assert!(!excerpt.contains('\n'));
        assert!(!excerpt.contains("  "));
    }

    #[test]
    fn graph_options_clamp_bounds() {
        let options = graph_options(&json!({
            "granularity": "chunk",
            "threshold": 9.0,
            "topK": 999,
            "maxNodes": 1,
            "maxEdges": 999999,
            "focus": "  ",
        }));
        assert_eq!(options.granularity, "chunk");
        assert_eq!(options.threshold, 1.0);
        assert_eq!(options.top_k, 12);
        assert_eq!(options.max_nodes, 20);
        assert_eq!(options.max_edges, GRAPH_MAX_EDGES);
        assert!(options.focus.is_none());
    }

    #[test]
    fn graph_score_prefers_cosine_when_vectors_exist() {
        let left = GraphNode {
            id: "a".into(), kind: "source", label: "A".into(), path: "a.md".into(),
            title: "A".into(), chunk_id: None, excerpt: String::new(),
            vector: vec![1.0, 0.0], terms: vec!["alpha".into()], chunk_count: 1,
        };
        let right = GraphNode {
            id: "b".into(), kind: "source", label: "B".into(), path: "b.md".into(),
            title: "B".into(), chunk_id: None, excerpt: String::new(),
            vector: vec![1.0, 0.0], terms: vec!["beta".into()], chunk_count: 1,
        };
        let context = GraphScoreContext::build(&[left.clone(), right.clone()], true);
        assert!((context.score(&left, &right) - 1.0).abs() < 1e-9);
        let lexical = GraphScoreContext::build(&[left.clone(), right.clone()], false);
        assert_eq!(lexical.score(&left, &right), 0.0);
    }
}
