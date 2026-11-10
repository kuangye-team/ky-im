//! Desktop persistence. Only this module resolves managed paths; peers never supply absolute paths.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
// The frontend selects its block size (2 MiB by default). Bound native IPC
// independently so a malformed renderer request cannot allocate arbitrarily.
const MAX_BLOCK: usize = 16 * 1024 * 1024;

#[derive(Default, Clone)]
pub struct StorageState(Arc<Mutex<Option<Store>>>);

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    GetProfile,
    SaveProfile {
        value: Value,
    },
    GetConversations,
    SaveConversation {
        value: Value,
    },
    GetMessages {
        id: String,
    },
    SaveMessage {
        value: Value,
    },
    GetFiles {
        minimum: u64,
    },
    DeleteMessages {
        ids: Vec<String>,
    },
    DeleteConversation {
        id: String,
    },
    ClearHistory,
    Info,
    Move {
        directory: String,
    },
    ResetTransfers,
    Begin {
        id: String,
        name: String,
        mime: String,
        size: u64,
        folder: bool,
    },
    Directory {
        token: String,
        path: String,
    },
    Entry {
        token: String,
        path: String,
        size: u64,
    },
    #[serde(skip_deserializing)]
    Write {
        token: String,
        data: Vec<u8>,
    },
    CloseEntry {
        token: String,
    },
    Finish {
        token: String,
    },
    Abort {
        token: String,
    },
    Attachment {
        id: String,
    },
    Export {
        id: String,
        destination: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    path: String,
    size: u64,
    mime: String,
    name: String,
    folder: bool,
}
struct Pending {
    id: String,
    name: String,
    mime: String,
    size: u64,
    written: u64,
    folder: bool,
    file: Option<File>,
    remaining: u64,
}
struct Store {
    root: PathBuf,
    locator: PathBuf,
    db: Connection,
    _lock: File,
    pending: HashMap<String, Pending>,
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing {key}").into())
}
fn id(value: &str) -> Result<()> {
    Uuid::parse_str(value)?;
    Ok(())
}
fn relative(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.len() > 4096 || value.split('/').count() > 128 {
        return Err("Invalid path".into());
    }
    for part in value.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > 255
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("文件夹目录无法读取，请检查后重试".into());
        }
    }
    let path = PathBuf::from(value);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid path".into());
    }
    Ok(path)
}
fn safe_name(name: &str) -> String {
    let mut clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:<>\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    while clean.len() > 240 {
        clean.pop();
    }
    if relative(&clean).is_ok() {
        clean
    } else {
        "attachment".into()
    }
}
fn no_links(path: &Path) -> Result<()> {
    // Reject symbolic links along the entire path before reading or writing managed data.
    for parent in path.ancestors() {
        if parent.exists() && fs::symlink_metadata(parent)?.file_type().is_symlink() {
            return Err("存储目录不能包含符号链接".into());
        }
    }
    Ok(())
}
fn tree_size(path: &Path) -> Result<u64> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err("存储目录不能包含符号链接".into());
    }
    if meta.is_file() {
        return Ok(meta.len());
    }
    let mut size = 0;
    for entry in fs::read_dir(path)? {
        size += tree_size(&entry?.path())?;
    }
    Ok(size)
}
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        return Err("存储目录不能包含符号链接".into());
    }
    if meta.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if meta.is_file() {
        // create_new prevents accidental replacement, including case-insensitive collisions.
        let mut output = OpenOptions::new().write(true).create_new(true).open(to)?;
        let copied = std::io::copy(&mut File::open(from)?, &mut output)?;
        output.sync_all()?;
        if copied != meta.len() || output.metadata()?.len() != meta.len() {
            return Err("文件未能完整保存".into());
        }
    } else {
        return Err("Unsupported file type".into());
    }
    Ok(())
}
impl Store {
    fn read(&self, id: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
        if length > MAX_BLOCK {
            return Err("Payload too large".into());
        }
        let a = self.attachment(id)?.ok_or("附件尚未接收完成或已被清除")?;
        if a.folder || offset > a.size {
            return Err("Invalid file range".into());
        }
        let path = self.root.join(relative(&a.path)?);
        no_links(&path)?;
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; length.min((a.size - offset) as usize)];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
    fn open(default: &Path, locator: PathBuf) -> Result<Self> {
        fs::create_dir_all(locator.parent().ok_or("Invalid config path")?)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(locator.with_file_name("storage.lock"))?;
        lock.try_lock()
            .map_err(|_| "数据目录正被另一个客户端使用，请关闭其他实例后重试")?;
        let config = Connection::open(&locator)?;
        config.execute_batch("CREATE TABLE IF NOT EXISTS location (id INTEGER PRIMARY KEY CHECK(id=1), path TEXT NOT NULL);")?;
        let saved: Option<String> = config
            .query_row("SELECT path FROM location WHERE id=1", [], |r| r.get(0))
            .optional()?;
        let root = saved
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default.to_path_buf());
        // A missing configured drive must never silently produce a new identity/database.
        if saved.is_some() && !root.join("history.sqlite").is_file() {
            return Err("数据存储目录不可用，请连接原存储磁盘后重试".into());
        }
        no_links(&root)?;
        fs::create_dir_all(&root)?;
        let root = root.canonicalize()?;
        let db = Self::database(&root)?;
        let mut store = Self {
            root,
            locator,
            db,
            _lock: lock,
            pending: HashMap::new(),
        };
        store.recover()?;
        Ok(store)
    }
    fn database(root: &Path) -> Result<Connection> {
        let db = Connection::open(root.join("history.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, peer TEXT NOT NULL, sender TEXT NOT NULL, created INTEGER NOT NULL, value TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS messages_peer ON messages(peer, created, id);
            CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS garbage (path TEXT PRIMARY KEY);")?;
        Ok(db)
    }
    fn recover(&mut self) -> Result<()> {
        self.cleanup_garbage()?;
        // Unfinished transfers cannot resume after restart. Never expose their partial bytes.
        let cache = self.root.join("cache");
        if cache.exists() {
            no_links(&cache)?;
            fs::remove_dir_all(&cache)?;
        }
        fs::create_dir(&cache)?;
        fs::create_dir_all(self.root.join("files"))?;
        let paths: HashSet<String> = self
            .values("SELECT value FROM attachments", [])?
            .iter()
            .filter_map(|v| {
                v["path"]
                    .as_str()
                    .and_then(|p| p.split('/').nth(1))
                    .map(str::to_owned)
            })
            .collect();
        for entry in fs::read_dir(self.root.join("files"))? {
            let entry = entry?;
            if !paths.contains(&entry.file_name().to_string_lossy().into_owned()) {
                no_links(&entry.path())?;
                if entry.file_type()?.is_dir() {
                    // A viewer may still hold a deleted file open on Windows. Retry later.
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(())
    }
    fn values<P: rusqlite::Params>(&self, sql: &str, parameters: P) -> Result<Vec<Value>> {
        let mut statement = self.db.prepare(sql)?;
        let rows = statement.query_map(parameters, |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    fn attachment(&self, key: &str) -> Result<Option<Attachment>> {
        self.db
            .query_row("SELECT value FROM attachments WHERE id=?", [key], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .map(|raw| Ok(serde_json::from_str(&raw)?))
            .transpose()
    }
    fn cleanup_garbage(&self) -> Result<bool> {
        let paths = self
            .db
            .prepare("SELECT path FROM garbage")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut pending = false;
        for path in paths {
            let target = self.root.join(relative(&path)?);
            if no_links(&target).is_ok()
                && (!target.exists() || fs::remove_dir_all(&target).is_ok())
            {
                self.db
                    .execute("DELETE FROM garbage WHERE path=?", [path])?;
            } else {
                pending = true;
            }
        }
        Ok(pending)
    }
    fn info(&self) -> Result<Value> {
        let cleanup_pending = self.cleanup_garbage()?;
        Ok(
            json!({"directory":self.root, "usage":tree_size(&self.root)?,
            "cacheUsage":tree_size(&self.root.join("cache"))?, "cleanupPending":cleanup_pending}),
        )
    }
    fn move_to(&mut self, target: &Path) -> Result<Value> {
        if !self.pending.is_empty() {
            return Err("请等待文件传输完成后再修改存储目录".into());
        }
        no_links(target)?;
        let target = target.canonicalize()?;
        if target == self.root {
            return self.info();
        }
        if target.starts_with(&self.root)
            || self.root.starts_with(&target)
            || self.locator.starts_with(&target)
        {
            return Err("请选择当前存储目录之外的空文件夹".into());
        }
        if fs::read_dir(&target)?.next().is_some() {
            return Err("请选择空文件夹，避免覆盖已有数据".into());
        }
        // Source remains usable until every file and SQLite backup have been verified.
        let prepare = (|| -> Result<Connection> {
            self.db
                .backup(rusqlite::MAIN_DB, target.join("history.sqlite"), None)?;
            for entry in fs::read_dir(&self.root)? {
                let entry = entry?;
                if [
                    "history.sqlite",
                    "history.sqlite-journal",
                    "history.sqlite-wal",
                    "history.sqlite-shm",
                ]
                .contains(&entry.file_name().to_string_lossy().as_ref())
                {
                    continue;
                }
                copy_tree(&entry.path(), &target.join(entry.file_name()))?;
            }
            let next = Self::database(&target)?;
            let check: String = next.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
            if check != "ok" {
                return Err("存储迁移校验失败，原目录未改变".into());
            }
            let config = Connection::open(&self.locator)?;
            config.execute(
                "INSERT OR REPLACE INTO location VALUES(1, ?)",
                [target.to_str().ok_or("Invalid directory")?],
            )?;
            Ok(next)
        })();
        let next = match prepare {
            Ok(next) => next,
            Err(error) => {
                for entry in fs::read_dir(&target)?.flatten() {
                    let _ = if entry.path().is_dir() {
                        fs::remove_dir_all(entry.path())
                    } else {
                        fs::remove_file(entry.path())
                    };
                }
                return Err(error);
            }
        };
        let old = std::mem::replace(&mut self.root, target);
        drop(std::mem::replace(&mut self.db, next));
        let cleanup_warning = fs::remove_dir_all(old).is_err();
        let mut info = self.info()?;
        info["cleanupWarning"] = json!(cleanup_warning);
        Ok(info)
    }
    fn abort(&mut self, token: &str) -> Result<()> {
        id(token)?;
        self.pending.remove(token);
        let path = self.root.join("cache").join(token);
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
        Ok(())
    }
    fn delete(&mut self, ids: Vec<String>, conversation: Option<&str>, all: bool) -> Result<()> {
        for key in &ids {
            id(key)?;
        }
        let paths: Vec<_> = ids
            .iter()
            .map(|key| self.attachment(key))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .map(|a| a.path)
            .collect();
        let tx = self.db.transaction()?;
        // Record physical cleanup in the same transaction. Locked files can be retried
        // after restart without resurrecting deleted messages or leaving untracked data.
        for path in &paths {
            let path = relative(path)?;
            let directory = path
                .parent()
                .ok_or("Invalid attachment directory")?
                .to_str()
                .ok_or("Invalid path")?;
            tx.execute(
                "INSERT OR IGNORE INTO garbage VALUES(?)",
                [directory.replace('\\', "/")],
            )?;
        }
        for key in &ids {
            tx.execute("DELETE FROM messages WHERE id=?", [key])?;
            tx.execute("DELETE FROM attachments WHERE id=?", [key])?;
        }
        if all {
            tx.execute("DELETE FROM conversations", [])?;
        } else if let Some(peer) = conversation {
            tx.execute("DELETE FROM conversations WHERE id=?", [peer])?;
        }
        tx.commit()?;
        let tokens: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| ids.contains(&p.id))
            .map(|(t, _)| t.clone())
            .collect();
        for token in tokens {
            // Metadata deletion has committed; pending handles must close even if cleanup fails.
            let _ = self.abort(&token);
        }
        let _ = self.cleanup_garbage();
        Ok(())
    }
    fn request(&mut self, request: Request) -> Result<Value> {
        match request {
            Request::GetProfile => Ok(self
                .values("SELECT value FROM settings WHERE key='profile'", [])?
                .pop()
                .unwrap_or(Value::Null)),
            Request::SaveProfile { value } => {
                self.db.execute(
                    "INSERT OR REPLACE INTO settings VALUES('profile', ?)",
                    [value.to_string()],
                )?;
                Ok(Value::Null)
            }
            Request::GetConversations => Ok(json!(
                self.values("SELECT value FROM conversations ORDER BY updated DESC", [])?
            )),
            Request::SaveConversation { value } => {
                self.db.execute(
                    "INSERT OR REPLACE INTO conversations VALUES(?, ?, ?)",
                    params![
                        string(&value["peer"], "id")?,
                        value["updatedAt"].as_i64().ok_or("Invalid date")?,
                        value.to_string()
                    ],
                )?;
                Ok(Value::Null)
            }
            Request::GetMessages { id } => Ok(json!(self.values(
                "SELECT value FROM messages WHERE peer=? ORDER BY created, id",
                [id]
            )?)),
            Request::SaveMessage { value } => {
                let key = string(&value, "id")?;
                id(key)?;
                let peer = string(&value, "peerId")?;
                let sender = string(&value, "senderId")?;
                let existing = self
                    .db
                    .query_row("SELECT peer, sender FROM messages WHERE id=?", [key], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })
                    .optional()?;
                if existing.is_some_and(|(p, s)| p != peer || s != sender) {
                    return Err("消息标识发生冲突".into());
                }
                self.db.execute(
                    "INSERT OR REPLACE INTO messages VALUES(?, ?, ?, ?, ?)",
                    params![
                        key,
                        peer,
                        sender,
                        value["createdAt"].as_i64().ok_or("Invalid date")?,
                        value.to_string()
                    ],
                )?;
                Ok(Value::Null)
            }
            Request::GetFiles { minimum } => {
                let mut files = Vec::new();
                for mut message in self.values(
                    "SELECT m.value FROM messages m JOIN attachments a ON m.id=a.id",
                    [],
                )? {
                    if message["kind"] == "text" {
                        continue;
                    }
                    let attachment = self
                        .attachment(string(&message, "id")?)?
                        .ok_or("Missing attachment")?;
                    let path = self.root.join(relative(&attachment.path)?);
                    if !path.exists() {
                        continue;
                    }
                    let size = tree_size(&path)?;
                    if size >= minimum {
                        message["size"] = json!(size);
                        files.push(message);
                    }
                }
                files.sort_by(|a, b| {
                    b["size"]
                        .as_u64()
                        .cmp(&a["size"].as_u64())
                        .then_with(|| b["createdAt"].as_i64().cmp(&a["createdAt"].as_i64()))
                });
                Ok(json!(files))
            }
            Request::DeleteMessages { ids } => {
                self.delete(ids, None, false)?;
                Ok(Value::Null)
            }
            Request::DeleteConversation { id } => {
                let ids = self
                    .values("SELECT value FROM messages WHERE peer=?", [&id])?
                    .iter()
                    .map(|v| string(v, "id").map(str::to_owned))
                    .collect::<Result<Vec<_>>>()?;
                self.delete(ids, Some(&id), false)?;
                Ok(Value::Null)
            }
            Request::ClearHistory => {
                let ids = self
                    .values("SELECT value FROM messages", [])?
                    .iter()
                    .map(|v| string(v, "id").map(str::to_owned))
                    .collect::<Result<Vec<_>>>()?;
                self.delete(ids, None, true)?;
                Ok(Value::Null)
            }
            Request::Info => self.info(),
            Request::Move { directory } => self.move_to(Path::new(&directory)),
            Request::ResetTransfers => {
                let tokens: Vec<_> = self.pending.keys().cloned().collect();
                for token in tokens {
                    self.abort(&token)?;
                }
                Ok(Value::Null)
            }
            Request::Begin {
                id: key,
                name,
                mime,
                size,
                folder,
            } => {
                id(&key)?;
                if self.pending.values().any(|p| p.id == key) {
                    return Err("文件正在传输".into());
                }
                let token = Uuid::new_v4().to_string();
                let name = safe_name(&name);
                let dir = self.root.join("cache").join(&token);
                fs::create_dir(&dir)?;
                let path = dir.join(&name);
                let file = if folder {
                    fs::create_dir(&path)?;
                    None
                } else {
                    Some(
                        OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&path)?,
                    )
                };
                self.pending.insert(
                    token.clone(),
                    Pending {
                        id: key,
                        name,
                        mime,
                        size,
                        written: 0,
                        folder,
                        file,
                        remaining: size,
                    },
                );
                Ok(json!(token))
            }
            Request::Directory { token, path } => {
                let pending = self.pending.get(&token).ok_or("文件传输已取消")?;
                if !pending.folder || pending.file.is_some() {
                    return Err("Invalid folder state".into());
                }
                let target = self
                    .root
                    .join("cache")
                    .join(&token)
                    .join(&pending.name)
                    .join(relative(&path)?);
                no_links(&target)?;
                fs::create_dir(target)?;
                Ok(Value::Null)
            }
            Request::Entry { token, path, size } => {
                let pending = self.pending.get_mut(&token).ok_or("文件传输已取消")?;
                if !pending.folder
                    || pending.file.is_some()
                    || pending.written + size > pending.size
                {
                    return Err("Invalid folder state".into());
                }
                let target = self
                    .root
                    .join("cache")
                    .join(&token)
                    .join(&pending.name)
                    .join(relative(&path)?);
                no_links(&target)?;
                pending.file = Some(
                    OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(target)?,
                );
                pending.remaining = size;
                Ok(Value::Null)
            }
            Request::Write { token, data } => {
                let bytes = data;
                let pending = self.pending.get_mut(&token).ok_or("文件传输已取消")?;
                if bytes.len() > MAX_BLOCK || bytes.len() as u64 > pending.remaining {
                    return Err("文件数据不完整".into());
                }
                pending
                    .file
                    .as_mut()
                    .ok_or("File closed")?
                    .write_all(&bytes)?;
                pending.remaining -= bytes.len() as u64;
                pending.written += bytes.len() as u64;
                Ok(Value::Null)
            }
            Request::CloseEntry { token } => {
                let pending = self.pending.get_mut(&token).ok_or("文件传输已取消")?;
                if pending.remaining != 0 {
                    return Err("文件没有接收完整，请让对方重新发送".into());
                }
                if let Some(file) = pending.file.take() {
                    file.sync_all()?;
                }
                Ok(Value::Null)
            }
            Request::Finish { token } => {
                let pending = self.pending.get(&token).ok_or("文件传输已取消")?;
                if pending.written != pending.size || (pending.folder && pending.file.is_some()) {
                    return Err("文件接收不完整，未保存附件".into());
                }
                if let Some(file) = &pending.file {
                    file.sync_all()?;
                }
                let pending = self.pending.remove(&token).ok_or("文件传输已取消")?;
                drop(pending.file);
                let source = self.root.join("cache").join(&token);
                let dest = self.root.join("files").join(&token);
                let previous = self.attachment(&pending.id)?;
                let attachment = Attachment {
                    path: format!("files/{token}/{}", pending.name),
                    name: pending.name,
                    mime: pending.mime,
                    size: pending.size,
                    folder: pending.folder,
                };
                let result = (|| -> Result<()> {
                    let tx = self.db.transaction()?;
                    tx.execute(
                        "INSERT OR REPLACE INTO attachments VALUES(?, ?)",
                        params![pending.id, serde_json::to_string(&attachment)?],
                    )?;
                    fs::rename(&source, &dest)?;
                    tx.commit()?;
                    Ok(())
                })();
                if result.is_err() {
                    let _ = fs::remove_dir_all(&source);
                    let _ = fs::remove_dir_all(&dest);
                }
                result?;
                if let Some(previous) = previous {
                    if let Some(parent) = self.root.join(relative(&previous.path)?).parent() {
                        let _ = fs::remove_dir_all(parent);
                    }
                }
                Ok(Value::Null)
            }
            Request::Abort { token } => {
                self.abort(&token)?;
                Ok(Value::Null)
            }
            Request::Attachment { id } => Ok(match self.attachment(&id)? {
                Some(a) if self.root.join(relative(&a.path)?).exists() => json!(a),
                _ => Value::Null,
            }),
            Request::Export { id, destination } => {
                let a = self.attachment(&id)?.ok_or("附件尚未接收完成或已被清除")?;
                let source = self.root.join(relative(&a.path)?);
                no_links(&source)?;
                let dest = PathBuf::from(destination);
                no_links(&dest)?;
                let parent = dest.parent().ok_or("Invalid destination")?.canonicalize()?;
                if parent.starts_with(&self.root) {
                    return Err("请选择数据存储目录之外的位置".into());
                }
                // The native save dialog provides overwrite consent for a file. Folders always get a new name.
                if a.folder {
                    copy_tree(&source, &dest)?;
                } else {
                    let mut output = File::create(&dest)?;
                    std::io::copy(&mut File::open(source)?, &mut output)?;
                    output.sync_all()?;
                }
                Ok(Value::Null)
            }
        }
    }
}

async fn with_store<T: Send + 'static>(
    app: tauri::AppHandle,
    state: &StorageState,
    operation: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
) -> std::result::Result<T, String> {
    let shared = state.0.clone();
    let default = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data");
    let locator = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("storage-location.sqlite");
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = shared
            .lock()
            .map_err(|_| "Storage lock poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(Store::open(&default, locator).map_err(|e| e.to_string())?);
        }
        operation(guard.as_mut().unwrap()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn storage_request(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    request: Request,
) -> std::result::Result<Value, String> {
    with_store(app, &state, move |store| store.request(request)).await
}

#[tauri::command]
pub async fn storage_write(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    request: tauri::ipc::Request<'_>,
) -> std::result::Result<(), String> {
    let token = crate::ipc::header(&request, "x-storage-token")?;
    let data = crate::ipc::raw(request.body(), MAX_BLOCK)?;
    with_store(app, &state, move |store| {
        store.request(Request::Write { token, data })
    })
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn storage_read(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    id: String,
    offset: u64,
    length: usize,
) -> std::result::Result<tauri::ipc::Response, String> {
    with_store(app, &state, move |store| store.read(&id, offset, length))
        .await
        .map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests;
