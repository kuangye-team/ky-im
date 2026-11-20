use super::Result;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};

pub(super) const DATA_DIR: &str = "data";
pub(super) const FIXED: &str = "ky-data";
pub(super) const FILES: &str = "ky-files";
pub(super) const CACHE: &str = "ky-cache";
pub(super) const HISTORY: &str = "history.sqlite";
pub(super) const UNKNOWN_LOCATION: &str = "无法确认应用数据的位置，请检查存储目录后重试";
pub(super) const OFFLINE: &str = "数据存储目录不可用，请连接原存储磁盘后重试";
pub(super) const LOCATOR: &str = "storage-location.sqlite";
pub(super) const STORAGE_LOCK: &str = "storage.lock";

pub(super) fn relative(value: &str) -> Result<PathBuf> {
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
pub(super) fn safe_name(name: &str) -> String {
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
pub(super) fn no_links(path: &Path) -> Result<()> {
    // Reject symbolic links along the entire path before reading or writing managed data.
    for parent in path.ancestors() {
        if metadata(parent)?.is_some_and(|m| m.file_type().is_symlink()) {
            return Err("存储目录不能包含符号链接".into());
        }
    }
    Ok(())
}
pub(super) fn tree_size(path: &Path) -> Result<u64> {
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
pub(super) fn copy_tree(from: &Path, to: &Path) -> Result<()> {
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

/// Verify both the directory structure (including empty folders) and file bytes before
/// committing a new location. Buffers are reused for the whole migration.
pub(super) fn verify_copy(source: &Path, target: &Path, buffers: &mut [u8]) -> Result<()> {
    let original = fs::symlink_metadata(source)?;
    let copy = fs::symlink_metadata(target)?;
    let mismatch = "存储迁移校验失败，原目录未改变";
    if original.is_dir() && copy.is_dir() {
        let mut count = 0;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            verify_copy(&entry.path(), &target.join(entry.file_name()), buffers)?;
            count += 1;
        }
        if fs::read_dir(target)?.count() != count {
            return Err(mismatch.into());
        }
        return Ok(());
    }
    if !original.is_file() || !copy.is_file() || original.len() != copy.len() {
        return Err(mismatch.into());
    }
    let (left, right) = buffers.split_at_mut(buffers.len() / 2);
    let mut source = File::open(source)?;
    let mut target = File::open(target)?;
    loop {
        let read = source.read(left)?;
        if read == 0 {
            break;
        }
        target.read_exact(&mut right[..read])?;
        if left[..read] != right[..read] {
            return Err(mismatch.into());
        }
    }
    Ok(())
}

pub(super) fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub(super) fn lock_storage(directory: &Path) -> Result<File> {
    let path = directory.join(STORAGE_LOCK);
    no_links(&path)?;
    fs::create_dir_all(directory)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    lock.try_lock()
        .map_err(|_| "数据目录正被另一个客户端使用，请关闭其他实例后重试")?;
    Ok(lock)
}

pub(super) fn sqlite_paths(path: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    ["", "-wal", "-shm", "-journal"]
        .into_iter()
        .map(move |suffix| {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            PathBuf::from(name)
        })
}

pub(super) fn check_sqlite(path: &Path) -> Result<()> {
    for file in sqlite_paths(path) {
        no_links(&file)?;
        if metadata(&file)?.is_some_and(|m| !m.is_file()) {
            return Err(UNKNOWN_LOCATION.into());
        }
    }
    Ok(())
}

fn remove_sqlite(path: &Path) -> Result<()> {
    // Keep the primary file until sidecars have been removed, so a retry still has its locator.
    for file in sqlite_paths(path)
        .skip(1)
        .chain(std::iter::once(path.to_owned()))
    {
        if metadata(&file)?.is_some() {
            fs::remove_file(file)?;
        }
    }
    Ok(())
}

pub(super) fn location(db: &Connection) -> Result<Option<PathBuf>> {
    let saved: Option<String> = db
        .query_row("SELECT path FROM location WHERE id=1", [], |r| r.get(0))
        .optional()?;
    let root = saved.map(PathBuf::from);
    if root.as_ref().is_some_and(|p| {
        !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir))
    }) {
        return Err(UNKNOWN_LOCATION.into());
    }
    Ok(root)
}

fn last_root(locator: &Path, default: &Path) -> Result<PathBuf> {
    check_sqlite(locator)?;
    let root = if metadata(locator)?.is_some() {
        let db = Connection::open_with_flags(locator, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        location(&db)?
    } else {
        if sqlite_paths(locator).skip(1).any(|p| p.exists()) {
            return Err(UNKNOWN_LOCATION.into());
        }
        None
    };
    let root = root.as_deref().unwrap_or(default);
    no_links(root)?;
    if !root.is_dir() {
        return Err(OFFLINE.into());
    }
    Ok(root.canonicalize()?)
}

// While a reset is incomplete the normal ownership evidence (attachment directories or the
// legacy database) may already be gone. Remember the verified directory, including its
// filesystem identity, so a retry cannot mistake an empty mount point for the original disk.
fn confirm_custom_roots(locator: &Path, roots: &[(&Path, bool)], default: &Path) -> Result<()> {
    if roots.iter().all(|(root, _)| *root == default) {
        return Ok(());
    }
    let mut db = Connection::open(locator)?;
    let tx = db.transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS location (id INTEGER PRIMARY KEY CHECK(id=1), path TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reset_roots (generation INTEGER PRIMARY KEY, path TEXT NOT NULL, stamp TEXT NOT NULL)")?;
    for (generation, &(root, owned)) in (0_i64..).zip(roots) {
        if root == default {
            continue;
        }
        let meta = fs::metadata(root)?;
        let stamp = match meta.created() {
            Ok(time) => time
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
                .to_string(),
            #[cfg(unix)]
            Err(_) => {
                use std::os::unix::fs::MetadataExt;
                format!("{}:{}", meta.dev(), meta.ino())
            }
            #[cfg(not(unix))]
            Err(e) => return Err(e.into()),
        };
        let path = root.to_str().ok_or(UNKNOWN_LOCATION)?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT path, stamp FROM reset_roots WHERE generation=?",
                [generation],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if !owned && !previous.is_some_and(|(p, s)| p == path && s == stamp) {
            return Err(OFFLINE.into());
        }
        tx.execute(
            "INSERT OR REPLACE INTO reset_roots VALUES(?,?,?)",
            rusqlite::params![generation, path, stamp],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Called with the current generation's lock held and its business database closed.
pub(super) fn reset_locations(
    default: &Path,
    legacy_locator: &Path,
    active: Option<&Path>,
) -> Result<()> {
    let default = default.canonicalize()?;
    let fixed = default.join(FIXED);
    let config = legacy_locator.parent().ok_or(UNKNOWN_LOCATION)?;
    let _legacy_lock = lock_storage(config)?;
    let config = config.canonicalize()?;
    let locator = fixed.join(LOCATOR);

    let current = last_root(&locator, &default)?;
    let legacy = last_root(legacy_locator, &default)?;
    if active.is_some_and(|p| p != current)
        || legacy.starts_with(&fixed)
        || current.starts_with(&fixed)
    {
        return Err(UNKNOWN_LOCATION.into());
    }
    let dirs = [
        current.join(FILES),
        current.join(CACHE),
        legacy.join("files"),
        legacy.join("cache"),
    ];
    // Validate both generations before touching either. Roots can coincide, but no managed
    // directory may contain the other generation's storage, locator, or held lock.
    for dir in &dirs {
        no_links(dir)?;
        if [&fixed, &config, &current, &legacy]
            .iter()
            .any(|p| p.starts_with(dir))
            || metadata(dir)?.is_some_and(|m| !m.is_dir())
        {
            return Err(UNKNOWN_LOCATION.into());
        }
    }
    let history = fixed.join(HISTORY);
    let legacy_history = legacy.join(HISTORY);
    check_sqlite(&history)?;
    check_sqlite(&legacy_history)?;
    let legacy_exists = metadata(&legacy_history)?.is_some();
    if legacy_exists {
        let db = Connection::open_with_flags(&legacy_history, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        // The released business schema identifies managed history even in a user-selected folder.
        db.prepare(
            "SELECT s.key, m.peer, a.value FROM settings s, messages m, attachments a LIMIT 0",
        )
        .map_err(|_| UNKNOWN_LOCATION)?;
    }
    confirm_custom_roots(
        &locator,
        &[
            (&current, dirs[0].is_dir() && dirs[1].is_dir()),
            (&legacy, legacy_exists),
        ],
        &default,
    )?;
    let keep_legacy_location = legacy != default && metadata(&default.join(HISTORY))?.is_some();
    for dir in &dirs {
        if metadata(dir)?.is_some() {
            fs::remove_dir_all(dir)?;
        }
    }
    remove_sqlite(&history)?;
    remove_sqlite(&legacy_history)?;
    if keep_legacy_location {
        // The published client requires a database file at its configured location on startup.
        super::Store::database(&legacy)?;
    } else {
        remove_sqlite(legacy_locator)?;
    }
    remove_sqlite(&locator)?;
    Ok(())
}
