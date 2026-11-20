//! Desktop persistence. Only this module resolves managed paths; peers never supply absolute paths.
mod paths;
use paths::{
    CACHE, DATA_DIR, FILES, FIXED, HISTORY, LOCATOR, OFFLINE, STORAGE_LOCK, check_sqlite,
    copy_tree, location, lock_storage, metadata, no_links, relative, reset_locations, safe_name,
    sqlite_paths, tree_size, verify_copy,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
// The frontend selects its block size (2 MiB by default). Bound native IPC
// independently so a malformed renderer request cannot allocate arbitrarily.
const MAX_BLOCK: usize = 16 * 1024 * 1024;

#[derive(Default, Clone)]
pub struct StorageState {
    store: Arc<Mutex<Option<Store>>>,
    resetting: Arc<std::sync::atomic::AtomicBool>,
    epoch: Arc<std::sync::atomic::AtomicU64>,
    paths: Arc<std::sync::OnceLock<(PathBuf, PathBuf)>>,
}

impl StorageState {
    /// The fixed business database is derived from the default root. The legacy locator is
    /// consulted only for an explicit two-generation reset.
    pub fn open(default: &Path, legacy_locator: PathBuf) -> std::result::Result<Self, String> {
        let state = Self::default();
        state
            .paths
            .set((default.to_owned(), legacy_locator))
            .unwrap();
        *state.store.lock().unwrap() = Some(Store::open(default).map_err(|e| e.to_string())?);
        Ok(state)
    }

    fn locate(&self, app: &tauri::AppHandle) -> std::result::Result<(), String> {
        if self.paths.get().is_none() {
            let default = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join(DATA_DIR);
            let legacy = app
                .path()
                .app_config_dir()
                .map_err(|e| e.to_string())?
                .join(LOCATOR);
            let _ = self.paths.set((default, legacy));
        }
        Ok(())
    }
    pub async fn read_source(
        &self,
        key: String,
        offset: u64,
        length: usize,
    ) -> std::result::Result<Vec<u8>, String> {
        self.with_store(move |store| store.read(&key, offset, length))
            .await
    }

    /// Native transfer workers reuse the initialized store, without renderer IPC.
    pub async fn native_request(&self, request: Request) -> std::result::Result<Value, String> {
        if matches!(request, Request::ResetData) {
            return self.reset().await;
        }
        self.with_store(move |store| store.request(request)).await
    }

    async fn with_store<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
    ) -> std::result::Result<T, String> {
        if self.resetting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("应用数据正在重置，请稍候".into());
        }
        let state = self.clone();
        let generation = state.epoch.load(std::sync::atomic::Ordering::SeqCst);
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = state
                .store
                .lock()
                .map_err(|_| "Storage lock poisoned".to_string())?;
            if state.resetting.load(std::sync::atomic::Ordering::SeqCst)
                || state.epoch.load(std::sync::atomic::Ordering::SeqCst) != generation
            {
                return Err("应用数据正在重置，请稍候".into());
            }
            if guard.is_none() {
                let (default, _) = state.paths.get().ok_or("存储尚未准备好")?;
                *guard = Some(Store::open(default).map_err(|e| e.to_string())?);
            }
            operation(guard.as_mut().unwrap()).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn reset(&self) -> std::result::Result<Value, String> {
        self.resetting
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (default, legacy) = self.paths.get().ok_or("存储尚未准备好")?.clone();
        let shared = self.store.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = shared.lock().map_err(|_| "Storage lock poisoned")?;
            reset_store(&mut guard, &default, &legacy).map_err(|error| {
                if error.is::<std::io::Error>() {
                    "重置未完成，请检查文件权限和磁盘连接后重试".to_owned()
                } else if error.is::<rusqlite::Error>() {
                    paths::UNKNOWN_LOCATION.to_owned()
                } else {
                    error.to_string()
                }
            })?;
            Ok(Value::Null)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Copy a stable prefix in bounded native blocks without holding the store lock during the copy.
    pub async fn copy_to_external(
        &self,
        from: String,
        to: String,
        saved: bool,
    ) -> std::result::Result<(), String> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let (mut reader, length) = {
                let guard = state.store.lock().unwrap();
                let store = guard.as_ref().ok_or("存储尚未准备好")?;
                let target = store.pending.get(&to).ok_or("文件传输已取消")?;
                if target.external.is_none() || target.written != 0 {
                    return Err("请重新选择保存位置".into());
                }
                let (path, length) = if saved {
                    let record = store
                        .attachment(&from)?
                        .ok_or("附件尚未接收完成或已被清除")?;
                    if record.folder || from != target.id || record.size != target.size {
                        return Err("文件进度无法确认，请重新发送".into());
                    }
                    (store.root.join(relative(&record.path)?), record.size)
                } else {
                    let source = store.pending.get(&from).ok_or("文件传输已取消")?;
                    if source.folder
                        || source.external.is_some()
                        || source.id != target.id
                        || source.size != target.size
                    {
                        return Err("文件进度无法确认，请重新发送".into());
                    }
                    (
                        store.root.join(CACHE).join(&from).join(&source.name),
                        source.written,
                    )
                };
                no_links(&path)?;
                (File::open(path)?, length)
            };
            let mut remaining = length;
            while remaining > 0 {
                let mut data = vec![0; remaining.min(2 * 1024 * 1024) as usize];
                reader.read_exact(&mut data)?;
                remaining -= data.len() as u64;
                let mut guard = state.store.lock().unwrap();
                let store = guard.as_mut().ok_or("文件传输已取消")?;
                if !saved && !store.pending.contains_key(&from) {
                    return Err("文件传输已取消".into());
                }
                store.request(Request::Write {
                    token: to.clone(),
                    data,
                })?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    }

    pub async fn source(&self, key: String) -> std::result::Result<File, String> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let guard = state.store.lock().map_err(|_| "Storage lock poisoned")?;
            let store = guard.as_ref().ok_or("存储尚未准备好")?;
            let a = store
                .attachment(&key)
                .map_err(|e| e.to_string())?
                .ok_or("附件已被清除")?;
            if a.folder {
                return Err("请选择文件发送".into());
            }
            let path = store
                .root
                .join(relative(&a.path).map_err(|e| e.to_string())?);
            no_links(&path).map_err(|e| e.to_string())?;
            File::open(path).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn renderer_reloaded(&self) {
        use std::sync::atomic::Ordering;
        if self.resetting.swap(false, Ordering::SeqCst) {
            self.epoch.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    GetIdentity,
    SaveIdentity {
        value: Vec<u8>,
    },
    GetProfile,
    GetPeerProfiles,
    SavePeerProfile {
        value: Value,
    },
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
    ResetData,
    Info,
    CachedUsage,
    ScanUsage {
        previous: Option<u64>,
    },
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
    BeginExternal {
        id: String,
        size: u64,
        destination: PathBuf,
    },
    CopyToExternal {
        from: String,
        to: String,
        saved: bool,
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
    external: Option<(tempfile::NamedTempFile, PathBuf)>,
}
struct Store {
    root: PathBuf,
    default: PathBuf,
    locator: PathBuf,
    cached_usage: Option<Value>,
    recovered: bool,
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
    fn open(default: &Path) -> Result<Self> {
        let fixed = default.join(FIXED);
        let lock = lock_storage(&fixed)?;
        let locator = fixed.join(LOCATOR);
        check_sqlite(&locator)?;
        let config = Connection::open(&locator)?;
        config.execute_batch("CREATE TABLE IF NOT EXISTS location (id INTEGER PRIMARY KEY CHECK(id=1), path TEXT NOT NULL);")?;
        let saved = location(&config)?;
        let default = default.canonicalize()?;
        let root = saved.unwrap_or_else(|| default.clone());
        no_links(&root)?;
        check_sqlite(&fixed.join(HISTORY))?;
        let mut store = Self {
            root,
            default,
            locator,
            db: Self::database(&fixed)?,
            _lock: lock,
            cached_usage: None,
            recovered: false,
            pending: HashMap::new(),
        };
        // A disconnected file drive does not prevent offline access to identity and chat history.
        if store.root == store.default || store.root.join(FILES).is_dir() {
            store.recover()?;
        }
        Ok(store)
    }
    fn database(root: &Path) -> Result<Connection> {
        let db = Connection::open(root.join(HISTORY))?;
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
        no_links(&self.root.join(FILES))?;
        no_links(&self.root.join(CACHE))?;
        self.cleanup_garbage()?;
        // Unfinished transfers cannot resume after restart. Never expose their partial bytes.
        let cache = self.root.join(CACHE);
        if cache.exists() {
            no_links(&cache)?;
            fs::remove_dir_all(&cache)?;
        }
        fs::create_dir(&cache)?;
        fs::create_dir_all(self.root.join(FILES))?;
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
        for entry in fs::read_dir(self.root.join(FILES))? {
            let entry = entry?;
            if !paths.contains(&entry.file_name().to_string_lossy().into_owned()) {
                no_links(&entry.path())?;
                if entry.file_type()?.is_dir() {
                    // A viewer may still hold a deleted file open on Windows. Retry later.
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        self.recovered = true;
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
            .map(|raw| {
                let attachment: Attachment = serde_json::from_str(&raw)?;
                let parts: Vec<_> = attachment.path.split('/').collect();
                if parts.len() != 3 || parts[0] != FILES {
                    return Err("Invalid attachment path".into());
                }
                id(parts[1])?;
                Ok(attachment)
            })
            .transpose()
    }
    fn cleanup_garbage(&self) -> Result<bool> {
        if !self.root.join(FILES).is_dir() {
            return Ok(true);
        }
        let paths = self
            .db
            .prepare("SELECT path FROM garbage")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut pending = false;
        for path in paths {
            let (prefix, token) = path.split_once('/').ok_or("Invalid attachment directory")?;
            if prefix != FILES {
                return Err("Invalid attachment directory".into());
            }
            id(token)?;
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
    fn ensure_files(&mut self) -> Result<()> {
        if !self.recovered && self.root.join(FILES).is_dir() {
            self.recover()?;
        }
        for name in [FILES, CACHE] {
            let path = self.root.join(name);
            no_links(&path)?;
            if !path.is_dir() {
                return Err(OFFLINE.into());
            }
        }
        Ok(())
    }

    fn info(&mut self) -> Result<Value> {
        self.ensure_files()?;
        let cleanup_pending = self.cleanup_garbage()?;
        let fixed = self.default.join(FIXED);
        let mut usage = 0;
        for path in sqlite_paths(&fixed.join(HISTORY))
            .chain(sqlite_paths(&self.locator))
            .chain(std::iter::once(fixed.join(STORAGE_LOCK)))
        {
            if let Some(meta) = metadata(&path)? {
                if !meta.is_file() {
                    return Err("无法确认应用数据的位置，请检查存储目录后重试".into());
                }
                usage += meta.len();
            }
        }
        let cache = tree_size(&self.root.join(CACHE))?;
        usage += tree_size(&self.root.join(FILES))? + cache;
        Ok(
            json!({"directory":self.root, "usage":usage, "cacheUsage":cache, "cleanupPending":cleanup_pending}),
        )
    }

    fn move_to(&mut self, target: &Path) -> Result<Value> {
        if !self.pending.is_empty() {
            return Err("请等待文件传输完成后再修改存储目录".into());
        }
        self.ensure_files()?;
        no_links(target)?;
        let target = target.canonicalize()?;
        if target == self.root {
            return Ok(json!({"directory":target}));
        }
        if target.starts_with(&self.root)
            || self.root.starts_with(&target)
            || (target != self.default
                && (target.starts_with(&self.default) || self.default.starts_with(&target)))
        {
            return Err("请选择当前存储目录之外的空文件夹".into());
        }
        if target != self.default && fs::read_dir(&target)?.next().is_some() {
            return Err("请选择空文件夹，避免覆盖已有数据".into());
        }
        let mut created = Vec::new();
        let prepare = (|| -> Result<()> {
            for name in [FILES, CACHE] {
                let from = self.root.join(name);
                let to = target.join(name);
                fs::create_dir(&to)?;
                created.push(to.clone());
                for entry in fs::read_dir(&from)? {
                    let entry = entry?;
                    copy_tree(&entry.path(), &to.join(entry.file_name()))?;
                }
            }
            let mut buffers = vec![0u8; 128 * 1024];
            for name in [FILES, CACHE] {
                verify_copy(&self.root.join(name), &target.join(name), &mut buffers)?;
            }
            let config = Connection::open(&self.locator)?;
            config.execute(
                "INSERT OR REPLACE INTO location VALUES(1, ?)",
                [target.to_str().ok_or("Invalid directory")?],
            )?;
            Ok(())
        })();
        if let Err(error) = prepare {
            for path in created {
                fs::remove_dir_all(path)?;
            }
            return Err(error);
        }
        let old = std::mem::replace(&mut self.root, target);
        self.cached_usage = None;
        let mut cleanup_warning = false;
        if old == self.default {
            for name in [FILES, CACHE] {
                cleanup_warning |= fs::remove_dir_all(old.join(name)).is_err();
            }
        }
        Ok(json!({"directory":self.root, "cleanupWarning":cleanup_warning}))
    }
    fn abort(&mut self, token: &str) -> Result<()> {
        id(token)?;
        self.pending.remove(token);
        let path = self.root.join(CACHE).join(token);
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
        if let Some(files) = self
            .cached_usage
            .as_mut()
            .and_then(|s| s["files"].as_array_mut())
        {
            let removed: HashSet<_> = ids.iter().map(String::as_str).collect();
            files.retain(|file| !file["id"].as_str().is_some_and(|id| removed.contains(id)));
        }
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
            Request::GetIdentity => Ok(self
                .values("SELECT value FROM settings WHERE key='identity'", [])?
                .pop()
                .unwrap_or(Value::Null)),
            Request::SaveIdentity { value } => {
                if value.len() > 256 {
                    return Err("Invalid identity".into());
                }
                self.db.execute(
                    "INSERT OR IGNORE INTO settings VALUES('identity', ?)",
                    [serde_json::to_string(&value)?],
                )?;
                Ok(Value::Null)
            }
            Request::GetPeerProfiles => Ok(json!(
                self.values("SELECT value FROM settings WHERE key LIKE 'peer/%'", [])?
            )),
            Request::SavePeerProfile { value } => {
                let id = string(&value, "id")?;
                let revision = value["revision"]
                    .as_i64()
                    .filter(|r| (1..=9_007_199_254_740_991).contains(r))
                    .ok_or("Invalid revision")?;
                self.db.execute(
                    "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
                     WHERE json_extract(settings.value, '$.revision') < ?",
                    params![format!("peer/{id}"), value.to_string(), revision],
                )?;
                Ok(Value::Null)
            }
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
                self.ensure_files()?;
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
            Request::ResetData => Err("应用数据正在重置，请稍候".into()),
            Request::CachedUsage => Ok(self.cached_usage.clone().unwrap_or(Value::Null)),
            Request::ScanUsage { previous } => {
                if let Some(cached) = &self.cached_usage
                    && cached["completedAt"].as_u64() != previous
                {
                    return Ok(cached.clone());
                }
                let info = self.info()?;
                let files = self.request(Request::GetFiles { minimum: 0 })?;
                let completed = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_millis() as u64;
                let snapshot = json!({"info":info, "usage":info["usage"], "files":files, "completedAt":completed});
                self.cached_usage = Some(snapshot.clone());
                Ok(snapshot)
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
                self.ensure_files()?;
                id(&key)?;
                if self
                    .pending
                    .values()
                    .any(|p| p.id == key && p.external.is_none())
                {
                    return Err("文件正在传输".into());
                }
                let token = Uuid::new_v4().to_string();
                let name = safe_name(&name);
                let dir = self.root.join(CACHE).join(&token);
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
                        external: None,
                    },
                );
                Ok(json!(token))
            }
            Request::BeginExternal {
                id: key,
                size,
                destination,
            } => {
                id(&key)?;
                no_links(&destination)?;
                let parent = destination
                    .parent()
                    .ok_or("请选择保存位置")?
                    .canonicalize()?;
                if !destination.is_absolute()
                    || (parent.starts_with(&self.root)
                        || parent.starts_with(self.default.join(FIXED)))
                    || destination.is_dir()
                {
                    return Err("请选择数据存储目录之外的位置".into());
                }
                let temp = tempfile::Builder::new()
                    .prefix(".hummingbird-")
                    .tempfile_in(parent)?;
                let file = temp.reopen()?;
                let token = Uuid::new_v4().to_string();
                self.pending.insert(
                    token.clone(),
                    Pending {
                        id: key,
                        name: String::new(),
                        mime: String::new(),
                        size,
                        written: 0,
                        folder: false,
                        file: Some(file),
                        remaining: size,
                        external: Some((temp, destination)),
                    },
                );
                Ok(json!(token))
            }
            Request::CopyToExternal { .. } => Err("文件传输已取消".into()),
            Request::Directory { token, path } => {
                let pending = self.pending.get(&token).ok_or("文件传输已取消")?;
                if !pending.folder || pending.file.is_some() {
                    return Err("Invalid folder state".into());
                }
                let target = self
                    .root
                    .join(CACHE)
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
                    .join(CACHE)
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
                if let Some((temp, destination)) = pending.external {
                    temp.persist(destination)?;
                    return Ok(Value::Null);
                }
                let source = self.root.join(CACHE).join(&token);
                let dest = self.root.join(FILES).join(&token);
                let previous = self.attachment(&pending.id)?;
                let attachment = Attachment {
                    path: format!("{FILES}/{token}/{}", pending.name),
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
                if let Some(previous) = previous
                    && let Some(parent) = self.root.join(relative(&previous.path)?).parent()
                {
                    let _ = fs::remove_dir_all(parent);
                }
                Ok(Value::Null)
            }
            Request::Abort { token } => {
                self.abort(&token)?;
                Ok(Value::Null)
            }
            Request::Attachment { id } => {
                self.ensure_files()?;
                Ok(match self.attachment(&id)? {
                    Some(a) if self.root.join(relative(&a.path)?).exists() => json!(a),
                    _ => Value::Null,
                })
            }
            Request::Export { id, destination } => {
                let a = self.attachment(&id)?.ok_or("附件尚未接收完成或已被清除")?;
                let source = self.root.join(relative(&a.path)?);
                no_links(&source)?;
                let dest = PathBuf::from(destination);
                no_links(&dest)?;
                let parent = dest.parent().ok_or("Invalid destination")?.canonicalize()?;
                if parent.starts_with(&self.root) || parent.starts_with(self.default.join(FIXED)) {
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

fn reset_store(store: &mut Option<Store>, default: &Path, legacy_locator: &Path) -> Result<()> {
    // Keep the same locked inode while closing SQLite and transfer handles, including on Windows.
    let (_lock, active) = match store.take() {
        Some(Store { _lock, root, .. }) => (_lock, Some(root)),
        None => (lock_storage(&default.join(FIXED))?, None),
    };
    reset_locations(default, legacy_locator, active.as_deref())
}

#[tauri::command]
pub async fn storage_request(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    request: Request,
) -> std::result::Result<Value, String> {
    if let Request::BeginExternal { destination, .. } = &request {
        use tauri_plugin_fs::FsExt;
        if !app.fs_scope().is_allowed(destination) {
            return Err("请重新选择保存位置".into());
        }
    }
    if let Request::CopyToExternal { from, to, saved } = request {
        state.copy_to_external(from, to, saved).await?;
        return Ok(Value::Null);
    }
    state.locate(&app)?;
    state.native_request(request).await
}

#[tauri::command]
pub async fn storage_write(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    request: tauri::ipc::Request<'_>,
) -> std::result::Result<(), String> {
    let token = crate::ipc::header(&request, "x-storage-token")?;
    let data = crate::ipc::raw(request.body(), MAX_BLOCK)?;
    state.locate(&app)?;
    state
        .with_store(move |store| store.request(Request::Write { token, data }))
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
    state.locate(&app)?;
    state
        .with_store(move |store| store.read(&id, offset, length))
        .await
        .map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests;

/// Only paths granted by a native dialog or a native drop may become transfer sources.
#[tauri::command]
pub async fn file_sources(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> std::result::Result<Value, String> {
    use tauri_plugin_fs::FsExt;
    if paths.len() > 64 {
        return Err("选择的文件过多，请分批发送".into());
    }
    let scope = app.fs_scope();
    tokio::task::spawn_blocking(move || {
        let mut sources = Vec::new();
        for path in paths {
            let p = Path::new(&path);
            if !scope.is_allowed(p) { return Err("请重新选择要发送的文件".to_string()); }
            no_links(p).map_err(|e| e.to_string())?;
            let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
            if !metadata.is_file() && !metadata.is_dir() { return Err("文件无法读取，请重新选择".into()); }
            if metadata.is_dir() { scope.allow_directory(p, true).map_err(|e| e.to_string())?; }
            sources.push(json!({"path":path,"name":p.file_name().unwrap_or_default().to_string_lossy(),"size":metadata.len(),"directory":metadata.is_dir(),"type":mime_guess::from_path(p).first_or_octet_stream().to_string()}));
        }
        Ok(json!(sources))
    }).await.map_err(|e| e.to_string())?
}
