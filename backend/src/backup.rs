//! 备份与恢复
//!
//! 备份 = 把整个工作区打成 zip 放在插件数据目录的 `backups/` 下；
//! 恢复 = 解压到指定目录（默认新建一个 `restore-<时间戳>`，不动原工作区）。
//!
//! 之所以不用 Git 代替：备份要覆盖「没有配远端、也不想装 git」的用户，
//! 而且一键导出 zip 便于直接交给别人或丢进网盘。

use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, PathBuf};

use serde_json::{json, Value};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::{param_str, App, RpcError, RpcResult};

fn root_of(app: &App) -> PathBuf {
    app.root
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| app.data_dir.join("workspace"))
}

/// 备份目录
fn backup_dir(app: &App) -> PathBuf {
    app.data_dir.join("backups")
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 打包工作区
pub fn export(app: &App, params: &Value) -> RpcResult {
    let root = root_of(app);
    if !root.exists() {
        return Err(RpcError::invalid("工作区不存在，无法备份"));
    }
    let include_git = params.get("includeGit").and_then(Value::as_bool).unwrap_or(false);
    let dir = backup_dir(app);
    fs::create_dir_all(&dir)?;

    let name = format!("dbx-note-{}.zip", stamp());
    let target = dir.join(&name);
    let file = File::create(&target)?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut files = 0_i64;
    let mut bytes = 0_i64;
    for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        let relative = match path.strip_prefix(&root) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let first = relative.components().next().and_then(|part| match part {
            Component::Normal(name) => Some(name.to_string_lossy().to_string()),
            _ => None,
        });
        if !include_git && first.as_deref() == Some(".git") {
            continue;
        }

        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        // 跳过大文件（>64MB），避免备份把磁盘写满
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        if size > 64 * 1024 * 1024 {
            continue;
        }
        let entry_name = relative.to_string_lossy().replace('\\', "/");
        zip.start_file(entry_name, options)
            .map_err(|error| RpcError::internal(format!("写入备份失败：{error}")))?;
        let mut source = File::open(path)?;
        let mut buffer = Vec::with_capacity(size as usize);
        source.read_to_end(&mut buffer)?;
        zip.write_all(&buffer)?;
        files += 1;
        bytes += size as i64;
    }

    zip.finish()
        .map_err(|error| RpcError::internal(format!("打包失败：{error}")))?
        .flush()?;

    let size = fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
    Ok(json!({
        "path": target.to_string_lossy(),
        "name": name,
        "size": size,
        "files": files,
        "rawBytes": bytes,
        "createdAt": crate::now_ms(),
    }))
}

/// 列出已有备份（新的在前）
pub fn list(app: &App) -> RpcResult {
    let dir = backup_dir(app);
    let mut items: Vec<Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("zip") {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(value) => value,
                Err(_) => continue,
            };
            items.push(json!({
                "path": path.to_string_lossy(),
                "name": path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default(),
                "size": meta.len(),
                "createdAt": meta.modified().ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|value| value.as_millis() as i64)
                    .unwrap_or(0),
            }));
        }
    }
    items.sort_by(|left, right| {
        right["createdAt"].as_i64().unwrap_or(0).cmp(&left["createdAt"].as_i64().unwrap_or(0))
    });
    Ok(json!({ "dir": dir.to_string_lossy(), "items": items }))
}

/// 解压备份到目标目录
///
/// 默认落到 `data_dir/restore-<时间戳>`，需要显式 `target` 才会解到别处；
/// 覆盖当前工作区必须带 `overwrite=true`，避免误操作毁掉正在用的笔记。
pub fn import(app: &App, params: &Value) -> RpcResult {
    let source = param_str(params, "path");
    if source.trim().is_empty() {
        return Err(RpcError::invalid("请选择要恢复的备份文件"));
    }
    let archive_path = PathBuf::from(source.trim());
    if !archive_path.is_file() {
        return Err(RpcError::invalid("备份文件不存在"));
    }

    let root = root_of(app);
    let overwrite = params.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
    let requested = param_str(params, "target");
    let target = if requested.trim().is_empty() {
        app.data_dir.join(format!("restore-{}", stamp()))
    } else {
        PathBuf::from(requested.trim())
    };
    let same_as_workspace = target
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
        == root.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    if same_as_workspace && !overwrite {
        return Err(RpcError::invalid("目标目录就是当前工作区，确认覆盖请勾选「覆盖当前工作区」"));
    }

    let file = File::open(&archive_path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|error| RpcError::invalid(format!("不是有效的 zip：{error}")))?;

    fs::create_dir_all(&target)?;
    let mut files = 0_i64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| RpcError::invalid(format!("读取备份条目失败：{error}")))?;
        // enclosed_name 会挡掉 ../ 与绝对路径
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let out_path = target.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = File::create(&out_path)?;
        std::io::copy(&mut entry, &mut output)?;
        files += 1;
    }

    Ok(json!({
        "path": target.to_string_lossy(),
        "files": files,
        "overwrite": overwrite,
    }))
}

/// 删除一个备份文件（只删 backups/ 下的 zip）
pub fn remove(app: &App, params: &Value) -> RpcResult {
    let raw = param_str(params, "path");
    let path = PathBuf::from(raw.trim());
    let dir = backup_dir(app);
    let dir_real = fs::canonicalize(&dir).unwrap_or(dir.clone());
    let path_real = fs::canonicalize(&path)
        .map_err(|_| RpcError::invalid("备份文件不存在"))?;
    if !path_real.starts_with(&dir_real) {
        return Err(RpcError::invalid("只能删除备份目录里的文件"));
    }
    fs::remove_file(&path_real)?;
    Ok(json!({ "deleted": true }))
}

/// 备份位置信息（设置页展示用）
pub fn info(app: &App) -> RpcResult {
    Ok(json!({
        "dir": backup_dir(app).to_string_lossy(),
        "root": root_of(app).to_string_lossy(),
    }))
}
