use super::*;

#[test]
fn reset_clears_identity_history_managed_files_and_pending_cache_but_keeps_external_files() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    f.run(Request::SaveProfile {
        value: json!({"id":"me"}),
    });
    f.run(Request::SaveConversation {
        value: json!({"peer":{"id":"peer"}, "updatedAt":1}),
    });
    f.message(&key, "peer", 1);
    f.save_file(&key);
    // Attachment metadata and payloads can also exist without a message.
    f.save_file(&Uuid::new_v4().to_string());
    let pending = f.begin(&Uuid::new_v4().to_string(), 10, false);
    f.write(&pending, b"part");
    let external = f.base.path().join("export.txt");
    fs::write(&external, b"keep").unwrap();
    let root = f.store.root.clone();
    let default = f.store.default.clone();
    reset_store(
        &mut Some(f.store),
        &default,
        &f.base.path().join("config").join(LOCATOR),
    )
    .unwrap();
    f.store = Store::open(&default).unwrap();
    assert_eq!(f.run(Request::GetProfile), Value::Null);
    assert_eq!(f.run(Request::GetConversations), json!([]));
    assert_eq!(f.run(Request::GetMessages { id: "peer".into() }), json!([]));
    assert_eq!(f.run(Request::GetFiles { minimum: 0 }), json!([]));
    assert!(f.store.pending.is_empty());
    assert_eq!(fs::read_dir(root.join(FILES)).unwrap().count(), 0);
    assert_eq!(fs::read_dir(root.join(CACHE)).unwrap().count(), 0);
    assert_eq!(fs::read(external).unwrap(), b"keep");
    assert_eq!(f.store.root, root);
}

struct Fixture {
    store: Store,
    base: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let base = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let store = Store::open(&base.path().join("data")).unwrap();
        Self { base, store }
    }
    fn run(&mut self, request: Request) -> Value {
        self.store.request(request).unwrap()
    }
    fn begin(&mut self, key: &str, size: u64, folder: bool) -> String {
        self.run(Request::Begin {
            id: key.into(),
            name: if folder { "资料" } else { "hello.txt" }.into(),
            mime: "text/plain".into(),
            size,
            folder,
        })
        .as_str()
        .unwrap()
        .into()
    }
    fn write(&mut self, token: &str, bytes: &[u8]) {
        self.run(Request::Write {
            token: token.into(),
            data: bytes.to_vec(),
        });
    }
    fn message(&mut self, key: &str, peer: &str, created: i64) -> Value {
        let value = json!({"id":key, "peerId":peer, "senderId":peer, "createdAt":created, "status":"delivered", "kind":"file", "size":999});
        self.run(Request::SaveMessage {
            value: value.clone(),
        });
        value
    }
    fn save_file(&mut self, key: &str) {
        let token = self.begin(key, 5, false);
        self.write(&token, b"hello");
        self.run(Request::Finish { token });
    }
}
#[tokio::test]
async fn selected_destination_commits_a_local_export_and_abort_preserves_existing_content() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let state = StorageState::open(&base.join("data"), base.join("config").join(LOCATOR)).unwrap();
    let key = Uuid::new_v4().to_string();
    let managed = state
        .native_request(Request::Begin {
            id: key.clone(),
            name: "inbox.txt".into(),
            mime: "".into(),
            size: 5,
            folder: false,
        })
        .await
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    state
        .native_request(Request::Write {
            token: managed.clone(),
            data: b"hello".to_vec(),
        })
        .await
        .unwrap();
    state
        .native_request(Request::Finish { token: managed })
        .await
        .unwrap();
    let path = base.join("chosen.bin");
    fs::write(&path, b"original").unwrap();
    for commit in [false, true] {
        let token = state
            .native_request(Request::BeginExternal {
                id: key.clone(),
                size: 5,
                destination: path.clone(),
            })
            .await
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        state
            .copy_to_external(key.clone(), token.clone(), true)
            .await
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"original");
        state
            .native_request(if commit {
                Request::Finish { token }
            } else {
                Request::Abort { token }
            })
            .await
            .unwrap();
    }
    assert_eq!(fs::read(&path).unwrap(), b"hello");
    assert_eq!(state.read_source(key, 0, 5).await.unwrap(), b"hello");
}

#[test]
fn sqlite_history_and_files_survive_restart_and_delete_together() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    let other = Uuid::new_v4().to_string();
    f.run(Request::SaveProfile {
        value: json!({"id":"me", "name":"Alice"}),
    });
    f.run(Request::SaveConversation { value:json!({"peer":{"id":"peer"}, "updatedAt":12, "remark":"Friend", "autoAcceptFiles":true}) });
    let message = f.message(&key, "peer", 12);
    f.save_file(&key);
    f.message(&other, "peer", 10);
    let mut collision = message.clone();
    collision["peerId"] = json!("intruder");
    assert!(
        f.store
            .request(Request::SaveMessage { value: collision })
            .is_err()
    );
    assert_eq!(f.run(Request::GetFiles { minimum: 0 })[0]["size"], 5);
    assert_eq!(f.run(Request::GetFiles { minimum: 6 }), json!([]));
    let root = f.store.root.clone();
    f.store._lock.unlock().unwrap();
    f.store = Store::open(&root).unwrap();
    assert_eq!(f.run(Request::GetProfile)["name"], "Alice");
    let history = f.run(Request::GetMessages { id: "peer".into() });
    assert_eq!(history[0]["id"], other);
    assert_eq!(history[1], message);
    assert_eq!(
        f.run(Request::GetLatestMessage { id: "peer".into() }),
        message
    );
    assert_eq!(f.store.read(&key.clone(), 1, 3).unwrap(), b"ell");
    assert!(
        f.store
            .request(Request::DeleteMessages {
                ids: vec![key.clone(), "bad".into()]
            })
            .is_err()
    );
    assert!(f.store.attachment(&key).unwrap().is_some());
    f.run(Request::DeleteMessages {
        ids: vec![key.clone()],
    });
    assert!(f.store.attachment(&key).unwrap().is_none());
    assert_eq!(tree_size(&root.join(FILES)).unwrap(), 0);
    assert_eq!(f.run(Request::GetConversations)[0]["remark"], "Friend");
    f.run(Request::ClearHistory);
    assert_eq!(f.run(Request::GetConversations), json!([]));
    assert_eq!(f.run(Request::GetProfile)["name"], "Alice");
}

#[test]
fn cache_is_invisible_until_complete_and_incomplete_or_aborted_files_never_publish() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    f.message(&key, "peer", 1);
    let token = f.begin(&key, 5, false);
    f.write(&token, b"hel");
    assert_eq!(f.run(Request::Attachment { id: key.clone() }), Value::Null);
    assert!(
        f.store
            .request(Request::Finish {
                token: token.clone()
            })
            .is_err()
    );
    assert!(
        f.store
            .request(Request::Write {
                token: token.clone(),
                data: b"long".to_vec()
            })
            .is_err()
    );
    f.write(&token, b"lo");
    f.run(Request::Finish { token });
    assert_eq!(tree_size(&f.store.root.join(CACHE)).unwrap(), 0);
    let second = Uuid::new_v4().to_string();
    let token = f.begin(&second, 10, false);
    f.write(&token, b"partial");
    f.run(Request::Abort {
        token: token.clone(),
    });
    assert!(f.store.request(Request::Finish { token }).is_err());
    assert_eq!(tree_size(&f.store.root.join(CACHE)).unwrap(), 0);
}

#[test]
fn streams_more_than_256_files_and_preserves_empty_directories() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    f.message(&key, "peer", 1);
    let token = f.begin(&key, 257, true);
    f.run(Request::Directory {
        token: token.clone(),
        path: "empty".into(),
    });
    for path in [
        "../escape",
        "/absolute",
        "a\\b",
        "C:/escape",
        "con",
        "a/../../escape",
    ] {
        assert!(
            f.store
                .request(Request::Entry {
                    token: token.clone(),
                    path: path.into(),
                    size: 1
                })
                .is_err()
        );
    }
    for index in 0..257 {
        f.run(Request::Entry {
            token: token.clone(),
            path: format!("{index}.txt"),
            size: 1,
        });
        f.write(&token, b"x");
        f.run(Request::CloseEntry {
            token: token.clone(),
        });
    }
    f.run(Request::Finish { token });
    let attachment = f.store.attachment(&key).unwrap().unwrap();
    let path = f.store.root.join(attachment.path);
    assert!(path.join("empty").is_dir());
    assert!(path.join("256.txt").is_file());
    assert_eq!(tree_size(&path).unwrap(), 257);
    let token = f.begin(&Uuid::new_v4().to_string(), 1, true);
    f.run(Request::Entry {
        token: token.clone(),
        path: "partial".into(),
        size: 1,
    });
    f.run(Request::Abort { token });
    assert_eq!(tree_size(&f.store.root.join(CACHE)).unwrap(), 0);
}

#[test]
fn large_stream_has_no_indexeddb_size_boundary() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    f.message(&key, "peer", 1);
    let size = 256 * 1024 * 1024 + 1;
    let token = f.begin(&key, size, false);
    let data = vec![42; 2 * 1024 * 1024];
    for _ in 0..128 {
        f.run(Request::Write {
            token: token.clone(),
            data: data.clone(),
        });
    }
    f.write(&token, b"!");
    f.run(Request::Finish { token });
    assert_eq!(f.run(Request::GetFiles { minimum: 0 })[0]["size"], size);
    assert_eq!(f.store.read(&key, size - 1, 1).unwrap(), b"!");
}

#[test]
fn bounds_native_read_and_write_blocks() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    let token = f.begin(&key, MAX_BLOCK as u64, false);
    assert!(
        f.store
            .request(Request::Write {
                token: token.clone(),
                data: vec![0; MAX_BLOCK + 1],
            })
            .is_err()
    );
    let bytes = vec![42; MAX_BLOCK];
    f.write(&token, &bytes);
    f.run(Request::Finish { token });
    assert_eq!(f.store.read(&key.clone(), 0, MAX_BLOCK).unwrap(), bytes);
    assert!(f.store.read(&key, 0, MAX_BLOCK + 1).is_err());
}

#[test]
fn migration_persists_location_and_rolls_back_on_failure() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    f.message(&key, "peer", 1);
    f.save_file(&key);
    let original = f.store.root.clone();
    fs::write(original.join("history.sqlite.backup"), b"backup").unwrap();
    let target = f.base.path().join("new");
    fs::create_dir(&target).unwrap();
    let active = f.begin(&Uuid::new_v4().to_string(), 1, false);
    assert!(f.store.move_to(&target).is_err());
    f.run(Request::Abort { token: active });
    fs::write(target.join("keep"), b"keep").unwrap();
    assert!(f.store.move_to(&target).is_err());
    assert_eq!(fs::read(target.join("keep")).unwrap(), b"keep");
    fs::remove_file(target.join("keep")).unwrap();
    let child = original.join("nested");
    fs::create_dir(&child).unwrap();
    assert!(f.store.move_to(&child).is_err());
    fs::remove_dir(&child).unwrap();
    let config = Connection::open(&f.store.locator).unwrap();
    config.execute_batch("CREATE TRIGGER reject_move BEFORE INSERT ON location BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
    assert!(f.store.move_to(&target).is_err());
    assert_eq!(f.store.root, original);
    assert!(fs::read_dir(&target).unwrap().next().is_none());
    assert_eq!(f.store.read(&key.clone(), 0, 5).unwrap(), b"hello");
    config.execute_batch("DROP TRIGGER reject_move;").unwrap();
    f.store.move_to(&target).unwrap();
    assert!(!original.join(FILES).exists());
    assert!(original.join(FIXED).join(HISTORY).is_file());
    assert!(!target.join(FIXED).exists());
    f.store._lock.unlock().unwrap();
    f.store = Store::open(&original).unwrap();
    assert_eq!(f.store.root, target);
    assert_eq!(
        fs::read(original.join("history.sqlite.backup")).unwrap(),
        b"backup"
    );
    assert_eq!(f.store.read(&key, 0, 5).unwrap(), b"hello");
}

#[test]
fn restart_removes_partial_cache_without_losing_completed_files() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    f.save_file(&key);
    let token = f.begin(&Uuid::new_v4().to_string(), 10, false);
    f.write(&token, b"partial");
    let root = f.store.root.clone();

    // Close open transfer handles before reopening, as on process exit (also works on Windows).
    f.store.pending.clear();
    f.store._lock.unlock().unwrap();
    f.store = Store::open(&root).unwrap();
    assert_eq!(tree_size(&root.join(CACHE)).unwrap(), 0);
    assert!(f.store.attachment(&key).unwrap().is_some());
}

#[test]
fn refuses_a_second_process_store_while_the_first_is_using_it() {
    let f = Fixture::new();
    assert!(Store::open(&f.store.root).is_err());
}

#[test]
fn failed_metadata_deletion_preserves_file_and_cleanup_journal() {
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    f.message(&key, "peer", 1);
    f.save_file(&key);
    f.store.db.execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
    assert!(
        f.store
            .request(Request::DeleteMessages {
                ids: vec![key.clone()]
            })
            .is_err()
    );
    assert_eq!(f.store.read(&key, 0, 5).unwrap(), b"hello");
    let garbage: i64 = f
        .store
        .db
        .query_row("SELECT count(*) FROM garbage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(garbage, 0);
}

#[test]
fn renderer_reload_releases_stale_pending_transfers_for_migration() {
    let mut f = Fixture::new();
    let token = f.begin(&Uuid::new_v4().to_string(), 10, false);
    f.write(&token, b"partial");
    f.run(Request::ResetTransfers);
    assert!(f.store.pending.is_empty());
    assert_eq!(tree_size(&f.store.root.join(CACHE)).unwrap(), 0);
    let target = f.base.path().join("reload-move");
    fs::create_dir(&target).unwrap();
    f.store.move_to(&target).unwrap();
}

#[test]
fn reset_checks_both_locks_and_last_locations_before_removing_only_managed_data() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let default = base.join(DATA_DIR);
    let config = base.join("config");
    let legacy = base.join("legacy");
    let current = base.join("current");
    let mut store = Some(Store::open(&default).unwrap());
    for dir in [&config, &legacy, &current] {
        fs::create_dir(dir).unwrap();
    }
    let db = Connection::open(config.join(LOCATOR)).unwrap();
    db.execute_batch("CREATE TABLE location (id INTEGER PRIMARY KEY,path TEXT)")
        .unwrap();
    db.execute(
        "INSERT INTO location VALUES (1,?)",
        [legacy.to_str().unwrap()],
    )
    .unwrap();
    drop(db);
    fs::write(default.join(HISTORY), b"earlier database").unwrap();
    Store::database(&legacy)
        .unwrap()
        .execute("INSERT INTO settings VALUES('profile', 'old')", [])
        .unwrap();
    fs::create_dir(legacy.join("files")).unwrap();
    store.as_mut().unwrap().move_to(&current).unwrap();
    fs::write(current.join(FILES).join("attachment"), b"current").unwrap();
    fs::write(current.join(HISTORY), b"unrelated").unwrap();
    fs::create_dir(default.join(FILES)).unwrap();
    fs::write(default.join(FILES).join("old copy"), b"keep").unwrap();

    let legacy_lock = lock_storage(&config).unwrap();
    assert!(reset_store(&mut store, &default, &config.join(LOCATOR)).is_err());
    assert!(current.join(FILES).join("attachment").exists());
    drop(legacy_lock);
    let disconnected = base.join("unmounted");
    fs::rename(&current, &disconnected).unwrap();
    assert!(reset_store(&mut store, &default, &config.join(LOCATOR)).is_err());
    assert!(default.join(FIXED).join(LOCATOR).exists());
    assert!(legacy.join("files").exists());
    fs::create_dir(&current).unwrap(); // Some systems leave an empty mount point.
    assert!(reset_store(&mut store, &default, &config.join(LOCATOR)).is_err());
    fs::remove_dir(&current).unwrap();
    fs::rename(disconnected, &current).unwrap();
    reset_store(&mut store, &default, &config.join(LOCATOR)).unwrap();
    assert!(!current.join(FILES).exists());
    assert!(!current.join(CACHE).exists());
    assert!(!legacy.join("files").exists());
    assert!(legacy.join(HISTORY).is_file());
    assert!(config.join(LOCATOR).is_file());
    assert_eq!(
        fs::read(default.join(HISTORY)).unwrap(),
        b"earlier database"
    );
    assert_eq!(fs::read(current.join(HISTORY)).unwrap(), b"unrelated");
    assert!(default.join(FILES).join("old copy").is_file());
    assert!(!default.join(FIXED).join(HISTORY).exists());
    assert!(!default.join(FIXED).join(LOCATOR).exists());
    assert!(default.join(FIXED).join(STORAGE_LOCK).exists());
    assert!(config.join(STORAGE_LOCK).exists());
    reset_store(&mut store, &default, &config.join(LOCATOR)).unwrap();
    assert_eq!(Store::open(&default).unwrap().root, default);
}

#[test]
fn corrupt_locator_prevents_reset() {
    let f = Fixture::new();
    let config = f.base.path().join("config");
    let _lock = lock_storage(&config).unwrap();
    drop(_lock);
    fs::write(config.join(LOCATOR), b"invalid sqlite").unwrap();
    assert!(reset_locations(&f.store.default, &config.join(LOCATOR), Some(&f.store.root)).is_err());
    assert!(f.store.locator.with_file_name(HISTORY).is_file());
}

#[test]
fn usage_and_moves_only_include_current_managed_children_and_fixed_database_files() {
    let mut f = Fixture::new();
    let default = f.store.root.clone();
    let external = f.base.path().join("external");
    fs::create_dir(&external).unwrap();
    let usage = |s: &mut Store| s.info().unwrap()["usage"].as_u64().unwrap();
    let initial = usage(&mut f.store);
    for name in [
        HISTORY,
        "files/sample",
        "cache/sample",
        "own/sample",
        "ky-data/own",
    ] {
        let path = default.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![0; 100]).unwrap();
    }
    assert_eq!(usage(&mut f.store), initial);
    for target in [&external, &default] {
        let root = f.store.root.clone();
        let before = usage(&mut f.store);
        let cache = f.store.info().unwrap()["cacheUsage"].as_u64().unwrap();
        fs::write(root.join(FILES).join("sample"), vec![0; 4096]).unwrap();
        fs::write(root.join(CACHE).join("sample"), vec![0; 2048]).unwrap();
        assert_eq!(usage(&mut f.store), before + 6144);
        assert_eq!(f.store.info().unwrap()["cacheUsage"], cache + 2048);
        let result = f.store.move_to(target).unwrap();
        assert!(result.get("usage").is_none());
        assert!(!external.join(FIXED).exists());
        fs::remove_file(target.join(FILES).join("sample")).unwrap();
        fs::remove_file(target.join(CACHE).join("sample")).unwrap();
    }
    assert!(external.join(FILES).join("sample").exists());
    let before = usage(&mut f.store);
    fs::write(external.join(FILES).join("other"), vec![0; 4000]).unwrap();
    assert_eq!(usage(&mut f.store), before);
}

#[tokio::test]
async fn native_reset_reports_in_use_then_reloads_with_an_empty_cache_and_new_identity() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let default = base.join(DATA_DIR);
    let legacy = base.join("config");
    let state = StorageState::open(&default, legacy.join(LOCATOR)).unwrap();
    Store::database(&default)
        .unwrap()
        .execute("INSERT INTO settings VALUES('profile','old')", [])
        .unwrap();
    fs::create_dir(default.join("files")).unwrap();
    state
        .native_request(Request::SaveIdentity { value: vec![7] })
        .await
        .unwrap();
    let cached = state
        .native_request(Request::ScanUsage { previous: None })
        .await
        .unwrap();
    assert_eq!(
        state.native_request(Request::CachedUsage).await.unwrap(),
        cached
    );
    let held = lock_storage(&legacy).unwrap();
    assert!(
        state
            .native_request(Request::ResetData)
            .await
            .unwrap_err()
            .contains("另一个客户端")
    );
    drop(held);
    state.native_request(Request::ResetData).await.unwrap();
    assert!(
        state
            .native_request(Request::SaveIdentity { value: vec![7] })
            .await
            .is_err()
    );
    state.renderer_reloaded();
    assert!(
        state
            .native_request(Request::GetIdentity)
            .await
            .unwrap()
            .is_null()
    );
    assert!(
        state
            .native_request(Request::CachedUsage)
            .await
            .unwrap()
            .is_null()
    );
    assert!(!default.join(HISTORY).exists());
    assert!(!default.join("files").exists());
}

#[test]
fn disconnected_files_do_not_change_identity_and_reconnect_recovers_files() {
    let mut f = Fixture::new();
    let default = f.store.default.clone();
    let external = f.base.path().join("external");
    let offline = f.base.path().join("offline");
    fs::create_dir(&external).unwrap();
    let key = Uuid::new_v4().to_string();
    f.run(Request::SaveIdentity {
        value: vec![1, 2, 3],
    });
    f.save_file(&key);
    f.store.move_to(&external).unwrap();
    drop(f.store);
    fs::rename(&external, &offline).unwrap();
    f.store = Store::open(&default).unwrap();
    assert_eq!(f.run(Request::GetIdentity), json!([1, 2, 3]));
    assert_eq!(f.store.root, external);
    assert!(f.store.info().is_err());
    assert!(!external.exists());
    fs::rename(offline, &external).unwrap();
    assert!(f.store.info().is_ok());
    assert_eq!(f.store.read(&key, 0, 5).unwrap(), b"hello");
}

#[cfg(unix)]
#[test]
fn reset_can_retry_after_partial_deletion_and_rejects_redirected_or_dangling_paths() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let mut f = Fixture::new();
    let default = f.store.default.clone();
    let external = f.base.path().join("external");
    let locator = f.base.path().join("config").join(LOCATOR);
    fs::create_dir(&external).unwrap();
    f.store.move_to(&external).unwrap();
    let mut store = Some(f.store);
    let protected = external.join(CACHE).join("busy");
    fs::create_dir(&protected).unwrap();
    fs::write(protected.join("keep"), b"locked").unwrap();
    fs::set_permissions(&protected, fs::Permissions::from_mode(0o500)).unwrap();
    if fs::write(protected.join("probe"), b"").is_err() {
        assert!(reset_store(&mut store, &default, &locator).is_err());
        assert!(!external.join(FILES).exists());
        assert!(default.join(FIXED).join(LOCATOR).exists());
    }
    fs::set_permissions(&protected, fs::Permissions::from_mode(0o700)).unwrap();
    let unrelated = f.base.path().join("export");
    fs::create_dir(&unrelated).unwrap();
    fs::write(unrelated.join("file"), b"keep").unwrap();
    symlink(&unrelated, default.join("files")).unwrap();
    assert!(reset_store(&mut store, &default, &locator).is_err());
    assert_eq!(fs::read(unrelated.join("file")).unwrap(), b"keep");
    fs::remove_file(default.join("files")).unwrap();
    symlink(unrelated.join("absent"), default.join("cache")).unwrap();
    assert!(reset_store(&mut store, &default, &locator).is_err());
    fs::remove_file(default.join("cache")).unwrap();
    reset_store(&mut store, &default, &locator).unwrap();
    assert!(!external.join(CACHE).exists());
}

#[test]
fn sparse_attachment_reads_across_the_four_gib_boundary() {
    let mut f = Fixture::new();
    let id = Uuid::new_v4().to_string();
    let boundary = 1_u64 << 32;
    let size = boundary + 1;
    let token = f.begin(&id, size, false);
    let pending = f.store.pending.get_mut(&token).unwrap();
    let file = pending.file.as_mut().unwrap();
    file.write_all(b"ab").unwrap();
    file.seek(SeekFrom::Start(boundary - 1)).unwrap();
    file.write_all(b"yz").unwrap();
    pending.written = size;
    f.run(Request::Finish { token });
    // At offset 1, exactly 4 GiB remain. A premature usize cast returns EOF on ARMv7.
    assert_eq!(f.store.read(&id, 0, 2).unwrap(), b"ab");
    assert_eq!(f.store.read(&id, 1, 1).unwrap(), b"b");
    assert_eq!(f.store.read(&id, 2, 1).unwrap(), [0]);
    assert_eq!(f.store.read(&id, boundary - 1, 8).unwrap(), b"yz");
    assert_eq!(f.store.read(&id, boundary, 1).unwrap(), b"z");
    assert!(f.store.read(&id, size, 1).unwrap().is_empty());
}

#[test]
fn media_preview_serves_seekable_ranges_only_for_saved_media() {
    use tauri::http::{Request as HttpRequest, StatusCode, header};
    let mut f = Fixture::new();
    let key = Uuid::new_v4().to_string();
    let size = 3 * 1024 * 1024;
    let token = f
        .run(Request::Begin {
            id: key.clone(),
            name: "recording.MP4".into(),
            mime: "application/octet-stream".into(),
            size,
            folder: false,
        })
        .as_str()
        .unwrap()
        .to_owned();
    let mut data = vec![0u8; size as usize];
    data[size as usize - 3..].copy_from_slice(b"end");
    f.write(&token, &data);
    let request = |method, range: Option<&str>| {
        let mut req = HttpRequest::builder()
            .method(method)
            .uri(format!("ky-media://localhost/{key}"));
        if let Some(value) = range {
            req = req.header(header::RANGE, value);
        }
        req.body(Vec::new()).unwrap()
    };
    assert!(media::response(&f.store, &request("GET", None)).is_err());
    f.run(Request::Finish { token });
    let metadata = media::response(&f.store, &request("HEAD", None)).unwrap();
    assert_eq!(metadata.headers()[header::CONTENT_TYPE], "video/mp4");
    assert_eq!(metadata.headers()[header::CONTENT_LENGTH], size.to_string());
    assert!(metadata.body().is_empty());
    let start = media::response(&f.store, &request("GET", Some("bytes=0-"))).unwrap();
    assert_eq!(start.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(start.body().len(), 2 * 1024 * 1024);
    let tail = media::response(&f.store, &request("GET", Some("bytes=-3"))).unwrap();
    assert_eq!(
        tail.headers()[header::CONTENT_RANGE],
        format!("bytes {}-{}/{size}", size - 3, size - 1)
    );
    assert_eq!(tail.body(), b"end");
    assert_eq!(
        media::response(&f.store, &request("GET", Some("bytes=9999999-")))
            .unwrap()
            .status(),
        StatusCode::RANGE_NOT_SATISFIABLE
    );
    f.save_file(&key);
    assert!(media::response(&f.store, &request("GET", None)).is_err());
}
