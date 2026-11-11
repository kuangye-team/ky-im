use super::*;

struct Fixture {
    base: PathBuf,
    store: Store,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hummingbird-storage-{}", Uuid::new_v4()));
        fs::create_dir(&base).unwrap();
        let store = Store::open(&base.join("data"), base.join("config/location.sqlite")).unwrap();
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
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
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
    f.store = Store::open(&root, f.store.locator.clone()).unwrap();
    assert_eq!(f.run(Request::GetProfile)["name"], "Alice");
    let history = f.run(Request::GetMessages { id: "peer".into() });
    assert_eq!(history[0]["id"], other);
    assert_eq!(history[1], message);
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
    assert_eq!(tree_size(&root.join("files")).unwrap(), 0);
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
    assert_eq!(tree_size(&f.store.root.join("cache")).unwrap(), 0);
    let second = Uuid::new_v4().to_string();
    let token = f.begin(&second, 10, false);
    f.write(&token, b"partial");
    f.run(Request::Abort {
        token: token.clone(),
    });
    assert!(f.store.request(Request::Finish { token }).is_err());
    assert_eq!(tree_size(&f.store.root.join("cache")).unwrap(), 0);
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
    assert_eq!(tree_size(&f.store.root.join("cache")).unwrap(), 0);
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
    let target = f.base.join("new");
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
    assert!(!original.exists());
    f.store._lock.unlock().unwrap();
    f.store = Store::open(&original, f.store.locator.clone()).unwrap();
    assert_eq!(f.store.root, target);
    assert_eq!(
        fs::read(target.join("history.sqlite.backup")).unwrap(),
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
    let locator = f.store.locator.clone();
    // Close open transfer handles before reopening, as on process exit (also works on Windows).
    f.store.pending.clear();
    f.store._lock.unlock().unwrap();
    f.store = Store::open(&root, locator).unwrap();
    assert_eq!(tree_size(&root.join("cache")).unwrap(), 0);
    assert!(f.store.attachment(&key).unwrap().is_some());
}

#[test]
fn refuses_a_second_process_store_while_the_first_is_using_it() {
    let f = Fixture::new();
    assert!(Store::open(&f.store.root, f.store.locator.clone()).is_err());
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
    assert_eq!(tree_size(&f.store.root.join("cache")).unwrap(), 0);
    let target = f.base.join("reload-move");
    fs::create_dir(&target).unwrap();
    f.store.move_to(&target).unwrap();
}
