//! Native file payloads. UI commands carry handles and offsets, never disk file bytes.
use super::{CHAT, Emit, FILE, Node};
use crate::storage::{Request, StorageState};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio_util::sync::CancellationToken;

pub(super) const CHUNK_HEADER: usize = 44;
pub(super) const CHUNK: usize = 128 * 1024;
pub(super) const MAX_CHUNK: usize = WINDOW as usize;
const BLOCK: usize = 2 * 1024 * 1024;
const WINDOW: u64 = 1024 * 1024;
const FLUSH: usize = 256 * 1024;
type Key = (String, String);
type Result<T> = std::result::Result<T, String>;

fn file_read_plan(preferred: Option<usize>, remaining: u64, sequence: u64) -> (usize, usize) {
    let slots = (1u64 << 32).saturating_sub(sequence);
    let chunk = preferred
        .filter(|&n| n > 0 && n <= MAX_CHUNK && remaining.div_ceil(n as u64) <= slots)
        .unwrap_or(CHUNK);
    (chunk, BLOCK / chunk * chunk)
}

struct Source {
    file: File,
    _temp: Option<tempfile::NamedTempFile>,
}
struct Receive {
    token: String,
    size: u64,
    received: u64,
    sequence: u64,
    buffer: Vec<u8>,
    migrating: bool,
    reported: Instant,
    write_time: Duration,
    connection: String,
}
#[derive(Default)]
struct SendFlow {
    epoch: u64,
    held_until: Option<Instant>,
    #[cfg(any(target_os = "macos", windows))]
    activity: Option<super::send_activity::SendActivity>,
}

#[cfg(any(target_os = "macos", windows))]
struct ActivityScope<'a>(&'a Mutex<SendFlow>);

#[cfg(any(target_os = "macos", windows))]
impl Drop for ActivityScope<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().activity.take();
    }
}

struct SendState {
    file: Arc<Mutex<Source>>,
    token: Option<String>,
    size: u64,
    copied: AtomicU64,
    sent: AtomicU64,
    received: AtomicU64,
    window_wait_us: AtomicU64,
    flow: Mutex<SendFlow>,
    notify: Notify,
    running: AsyncMutex<()>,
}
struct Task {
    cancel: CancellationToken,
    send: Option<SendState>,
    receive: Option<AsyncMutex<Receive>>,
}
#[derive(Clone, Default)]
pub struct Files {
    #[cfg(any(target_os = "macos", windows))]
    activity_disabled: Arc<std::sync::atomic::AtomicBool>,
    store: Arc<Mutex<Option<StorageState>>>,
    tasks: Arc<Mutex<HashMap<Key, Arc<Task>>>>,
    sources: Arc<Mutex<HashMap<String, Arc<Mutex<Source>>>>>,
}
impl Task {
    fn cancel(&self) {
        self.cancel.cancel();
        #[cfg(any(target_os = "macos", windows))]
        if let Some(s) = &self.send {
            s.flow.lock().unwrap().activity.take();
        }
    }
}
impl Files {
    pub fn enable(&self, store: StorageState) {
        *self.store.lock().unwrap() = Some(store);
    }
    #[cfg(any(target_os = "macos", windows))]
    pub fn configure_send_activity(&self, request: &Value) {
        #[cfg(target_os = "macos")]
        let flag = "macosSendActivity";
        #[cfg(windows)]
        let flag = "windowsSendActivity";
        self.activity_disabled
            .store(request[flag].as_bool() == Some(false), Ordering::Relaxed);
    }
    pub fn enabled(&self) -> bool {
        self.store.lock().unwrap().is_some()
    }
    fn store(&self) -> Result<StorageState> {
        self.store
            .lock()
            .unwrap()
            .clone()
            .ok_or("存储尚未准备好".into())
    }
    pub fn source(&self, file: File, temp: Option<tempfile::NamedTempFile>) -> Result<Value> {
        let mut sources = self.sources.lock().unwrap();
        if sources.len() >= 64 {
            return Err("准备的文件过多，请稍后重试".into());
        }
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let token = uuid::Uuid::new_v4().to_string();
        sources.insert(
            token.clone(),
            Arc::new(Mutex::new(Source { file, _temp: temp })),
        );
        Ok(json!({"token":token,"size":size}))
    }
    pub async fn upload(&self, token: &str, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > BLOCK {
            return Err("文件读取块过大".into());
        }
        let source = self
            .sources
            .lock()
            .unwrap()
            .get(token)
            .cloned()
            .ok_or("文件已关闭")?;
        tokio::task::spawn_blocking(move || {
            let mut source = source.lock().unwrap();
            if source._temp.is_none() {
                return Err("文件不可写入".to_string());
            }
            source.file.write_all(&bytes).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub fn release_source(&self, token: &str) {
        self.sources.lock().unwrap().remove(token);
    }
    fn task(&self, peer: &str, id: &str) -> Result<Arc<Task>> {
        self.tasks
            .lock()
            .unwrap()
            .get(&(peer.into(), id.into()))
            .cloned()
            .ok_or("文件传输已取消".into())
    }
    fn insert(&self, peer: &str, id: &str, task: Task) -> Result<()> {
        uuid::Uuid::parse_str(id).map_err(|_| "文件标识无效")?;
        let mut tasks = self.tasks.lock().unwrap();
        if tasks.len() >= 32 || tasks.contains_key(&(peer.into(), id.into())) {
            return Err("文件正在传输，请稍后重试".into());
        }
        tasks.insert((peer.into(), id.into()), Arc::new(task));
        Ok(())
    }
    pub fn receive(
        &self,
        peer: &str,
        id: &str,
        token: String,
        size: u64,
        connection: String,
    ) -> Result<()> {
        self.insert(
            peer,
            id,
            Task {
                cancel: CancellationToken::new(),
                send: None,
                receive: Some(AsyncMutex::new(Receive {
                    token,
                    size,
                    received: 0,
                    sequence: 0,
                    buffer: Vec::with_capacity(FLUSH),
                    migrating: false,
                    reported: Instant::now(),
                    write_time: Duration::ZERO,
                    connection,
                })),
            },
        )
    }
    pub fn sender(
        &self,
        peer: &str,
        id: &str,
        source: &str,
        token: Option<String>,
        size: u64,
    ) -> Result<()> {
        let file = self
            .sources
            .lock()
            .unwrap()
            .remove(source)
            .ok_or("文件已关闭")?;
        if file
            .lock()
            .unwrap()
            .file
            .metadata()
            .map_err(|e| e.to_string())?
            .len()
            != size
        {
            return Err("文件已发生变化，请重新选择".into());
        }
        self.insert(
            peer,
            id,
            Task {
                cancel: CancellationToken::new(),
                receive: None,
                send: Some(SendState {
                    file,
                    token,
                    size,
                    copied: AtomicU64::new(0),
                    sent: AtomicU64::new(0),
                    received: AtomicU64::new(0),
                    window_wait_us: AtomicU64::new(0),
                    flow: Default::default(),
                    notify: Notify::new(),
                    running: AsyncMutex::new(()),
                }),
            },
        )
    }
    async fn flush(&self, receive: &mut Receive) -> Result<()> {
        if !receive.buffer.is_empty() {
            let start = Instant::now();
            self.store()?
                .native_request(Request::Write {
                    token: receive.token.clone(),
                    data: std::mem::replace(&mut receive.buffer, Vec::with_capacity(FLUSH)),
                })
                .await?;
            receive.write_time += start.elapsed();
        }
        Ok(())
    }
    pub async fn state(&self, peer: &str, id: &str, connection: Option<String>) -> Result<Value> {
        let task = self.task(peer, id)?;
        if let Some(receive) = &task.receive {
            let mut r = receive.lock().await;
            if !r.migrating {
                self.flush(&mut r).await?;
            }
            if let Some(connection) = connection {
                r.connection = connection;
            }
            Ok(json!({"received":r.received,"sequence":r.sequence,
                "written":r.received-r.buffer.len() as u64,"destinationWriteMs":r.write_time.as_millis() as u64}))
        } else {
            let s = task.send.as_ref().unwrap();
            Ok(json!({"sent":s.sent.load(Ordering::SeqCst)}))
        }
    }
    pub async fn retarget(&self, peer: &str, id: &str, to: String) -> Result<()> {
        let task = self.task(peer, id)?;
        let store = self.store()?;
        let receive = task.receive.as_ref().ok_or("文件传输已取消")?;
        let from = {
            let mut r = receive.lock().await;
            if r.migrating {
                return Err("正在更改保存位置…".into());
            }
            r.migrating = true;
            r.token.clone()
        };
        // Leave the shared file stream free to deliver other tasks. Already-sent frames
        // for this file fit in its outstanding credit and receive no further credit yet.
        let result = store.copy_to_external(from, to.clone(), false).await;
        let mut r = receive.lock().await;
        r.migrating = false;
        result?;
        if task.cancel.is_cancelled() {
            return Err("文件传输已取消".into());
        }
        r.token = to;
        Ok(())
    }
    /// Native senders consume progress credit directly; the renderer receives only
    /// the aggregated task progress, not one IPC event per network window update.
    pub fn progress(&self, peer: &str, packet: &Value) -> bool {
        let Some(id) = packet["id"].as_str() else {
            return false;
        };
        if packet["type"] == "transfer-error" {
            self.cancel(peer, id);
            return false;
        }
        if packet["type"] == "file-hold" {
            if let Some(active) = packet["active"].as_bool()
                && let Ok(task) = self.task(peer, id)
                && let Some(s) = &task.send
            {
                let mut flow = s.flow.lock().unwrap();
                flow.held_until = active.then(|| Instant::now() + Duration::from_secs(60));
                #[cfg(any(target_os = "macos", windows))]
                if active {
                    flow.activity.take();
                }
                s.notify.notify_one();
            }
            // The UI also owns the timeout for the final receipt.
            return false;
        }
        if packet["type"] != "file-progress" {
            return false;
        }
        if let Ok(task) = self.task(peer, id)
            && let Some(s) = &task.send
        {
            if let Some(received) = packet["received"]
                .as_u64()
                .filter(|n| *n <= s.sent.load(Ordering::SeqCst))
            {
                s.received.fetch_max(received, Ordering::SeqCst);
                s.notify.notify_one();
            }
            return true;
        }
        false
    }
    pub async fn chunk(
        &self,
        node: &Node,
        peer: &str,
        connection: &str,
        bytes: Vec<u8>,
        bulk_record: bool,
        emit: &Emit,
    ) -> Result<()> {
        let (id, sequence, payload) = decode(&bytes)?;
        let task = self.task(peer, &id)?;
        let mut r = task
            .receive
            .as_ref()
            .ok_or("尚未同意接收此文件")?
            .lock()
            .await;
        if task.cancel.is_cancelled() {
            return Ok(());
        }
        if r.connection != connection {
            return Ok(());
        }
        if sequence != r.sequence || r.received + payload.len() as u64 > r.size {
            return Err("文件数据不完整".into());
        }
        if r.migrating && r.buffer.len() + payload.len() > FLUSH + WINDOW as usize + MAX_CHUNK {
            return Err("文件数据不完整".into());
        }
        r.buffer.extend_from_slice(payload);
        r.received += payload.len() as u64;
        r.sequence += 1;
        // Report progress after a whole number of unordered records.
        let flush_at = if bulk_record {
            ((FLUSH + payload.len() / 2) / payload.len()).max(1) * payload.len()
        } else {
            FLUSH
        };
        if !r.migrating && r.buffer.len() >= flush_at {
            let write = node.metrics.timer("file.destinationWrite", r.buffer.len());
            self.flush(&mut r).await?;
            drop(write);
            let _ = node
                .send(
                    peer,
                    CHAT,
                    1,
                    serde_json::to_vec(
                        &json!({"type":"file-progress","id":id,"received":r.received}),
                    )
                    .unwrap(),
                )
                .await;
        }
        if r.reported.elapsed() >= Duration::from_millis(150) || r.received == r.size {
            emit(
                json!({"type":"file_progress","peerId":peer,"id":id,"received":r.received,"sequence":r.sequence,
                    "written":r.received - r.buffer.len() as u64, "destinationWriteMs":r.write_time.as_millis() as u64}),
            );
            r.reported = Instant::now();
        }
        Ok(())
    }
}

impl Node {
    /// A two-block producer overlaps the next disk read with bounded network/copy work.
    pub async fn send_file(
        &self,
        peer: &str,
        id: &str,
        offset: u64,
        sequence: u64,
        base: u64,
        single_file: bool,
    ) -> Result<Value> {
        let task = self.files.task(peer, id)?;
        let s = task.send.as_ref().ok_or("文件状态无效")?;
        let _running = s.running.try_lock().map_err(|_| "文件正在发送")?;
        if offset > s.size || sequence > u32::MAX as u64 + 1 {
            return Err("文件进度无效".into());
        }
        s.received.store(base + offset, Ordering::SeqCst);
        let epoch = s.flow.lock().unwrap().epoch;
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let file = s.file.clone();
        let size = s.size;
        let large = single_file && size > super::bulk::THRESHOLD;
        let route = if large {
            super::FileRoute::TryBulk
        } else {
            super::FileRoute::Ordered
        };
        let preferred = if large {
            self.bulk_file_payload_bytes(peer).await
        } else {
            None
        };
        let (chunk_bytes, read_bytes) = file_read_plan(preferred, size - offset, sequence);
        let read_metrics = self.metrics.clone();
        let reader = tokio::task::spawn_blocking(move || {
            let mut source = file.lock().unwrap();
            let result = (|| -> Result<()> {
                if source.file.metadata().map_err(|e| e.to_string())?.len() != size {
                    return Err("文件已发生变化，请重新选择".into());
                }
                source
                    .file
                    .seek(SeekFrom::Start(offset))
                    .map_err(|e| e.to_string())?;
                let mut at = offset;
                while at < size {
                    let mut block = vec![0; (size - at).min(read_bytes as u64) as usize];
                    let read = read_metrics.timer("file.sourceRead", block.len());
                    source
                        .file
                        .read_exact(&mut block)
                        .map_err(|e| e.to_string())?;
                    drop(read);
                    at += block.len() as u64;
                    if tx.blocking_send(Ok(block)).is_err() {
                        return Ok(());
                    }
                }
                Ok(())
            })();
            if let Err(e) = result {
                let _ = tx.blocking_send(Err(e));
            }
        });
        let mut at = offset;
        let mut seq = sequence;
        let mut reported = Instant::now();
        #[cfg(any(target_os = "macos", windows))]
        let request_activity =
            size > super::bulk::THRESHOLD && !self.files.activity_disabled.load(Ordering::Relaxed);
        let operation = async {
            #[cfg(any(target_os = "macos", windows))]
            let _activity_scope = ActivityScope(&s.flow);
            while let Some(block) = rx.recv().await {
                let block = block?;
                let end = at + block.len() as u64;
                let copy = async {
                    let copied = s.copied.load(Ordering::SeqCst);
                    if let Some(token) = &s.token
                        && end > copied
                    {
                        let _write = self
                            .metrics
                            .timer("file.sourceCopyWrite", (end - copied.max(at)) as usize);
                        self.files
                            .store()?
                            .native_request(Request::Write {
                                token: token.clone(),
                                data: block[(copied.saturating_sub(at)) as usize..].to_vec(),
                            })
                            .await?;
                        s.copied.store(end, Ordering::SeqCst);
                    }
                    Ok::<_, String>(())
                };
                let network = async {
                    let mut sent = at;
                    for payload in block.chunks(chunk_bytes) {
                        loop {
                            let notified = s.notify.notified();
                            let held = {
                                let mut flow = s.flow.lock().unwrap();
                                if flow.epoch != epoch {
                                    return Err("network:连接已中断".to_string());
                                }
                                if task.cancel.is_cancelled() {
                                    return Err("文件传输已取消".to_string());
                                }
                                flow.held_until.take_if(|until| *until <= Instant::now());
                                let held = flow.held_until.is_some();
                                if !held && base + sent < s.received.load(Ordering::SeqCst) + WINDOW
                                {
                                    #[cfg(any(target_os = "macos", windows))]
                                    if request_activity {
                                        flow.activity.get_or_insert_with(
                                            super::send_activity::SendActivity::begin,
                                        );
                                    }
                                    break;
                                }
                                held
                            };
                            let _wait = self.metrics.timer("file.windowWait", 0);
                            let start = Instant::now();
                            let result =
                                tokio::time::timeout(Duration::from_secs(60), notified).await;
                            s.window_wait_us
                                .fetch_add(start.elapsed().as_micros() as u64, Ordering::Relaxed);
                            if result.is_err() && !held {
                                return Err("network:文件传输超时".to_string());
                            }
                        }
                        if seq > u32::MAX as u64 {
                            return Err("文件过大".into());
                        }
                        // Publish the attempted offset before a fast receiver can return its progress.
                        s.sent
                            .fetch_max(base + sent + payload.len() as u64, Ordering::SeqCst);
                        let header = chunk_header(id, seq as u32)?;
                        self.send_parts(peer, FILE, 2, &[&header, payload], route)
                            .await
                            .map_err(|e| format!("network:{e}"))?;
                        seq += 1;
                        sent += payload.len() as u64;
                        #[cfg(any(target_os = "macos", windows))]
                        if sent == size && request_activity {
                            s.flow.lock().unwrap().activity.take();
                        }
                        if reported.elapsed() >= Duration::from_millis(150) || sent == size {
                            (self.emit)(
                                json!({"type":"file_progress","peerId":peer,"id":id,"sent":base+sent,
                                    "confirmed":s.received.load(Ordering::SeqCst),
                                    "windowWaitMs":s.window_wait_us.load(Ordering::Relaxed)/1000}),
                            );
                            reported = Instant::now();
                        }
                    }
                    Ok::<_, String>(())
                };
                #[cfg(any(target_os = "macos", windows))]
                let network = async {
                    let result = network.await;
                    if result.is_err() {
                        // The storage copy may still be settling when the network fails.
                        s.flow.lock().unwrap().activity.take();
                    }
                    result
                };
                // Always settle the current copy before a resume can inspect the cached prefix.
                let (copy, network) = tokio::join!(copy, network);
                copy?;
                network?;
                at = end;
            }
            Ok(json!({"sent":base+at,"sequence":seq}))
        };
        let result = tokio::select! { _ = task.cancel.cancelled() => Err("文件传输已取消".into()), result = operation => result };
        drop(rx);
        let _ = reader.await;
        result
    }
}

impl Files {
    pub fn disconnected(&self, peer: &str) {
        for ((owner, _), task) in self.tasks.lock().unwrap().iter() {
            if owner == peer
                && let Some(s) = &task.send
            {
                let mut flow = s.flow.lock().unwrap();
                flow.held_until = None;
                flow.epoch += 1;
                #[cfg(any(target_os = "macos", windows))]
                flow.activity.take();
                s.notify.notify_one();
            }
        }
    }
    pub fn cancel(&self, peer: &str, id: &str) {
        if let Ok(task) = self.task(peer, id) {
            task.cancel();
        }
    }
    pub async fn release(&self, peer: &str, id: &str) {
        let task = self.tasks.lock().unwrap().remove(&(peer.into(), id.into()));
        if let Some(task) = task {
            task.cancel();
            let token = if let Some(r) = &task.receive {
                Some(r.lock().await.token.clone())
            } else {
                task.send.as_ref().and_then(|s| s.token.clone())
            };
            if let (Some(token), Ok(store)) = (token, self.store()) {
                let _ = store.native_request(Request::Abort { token }).await;
            }
        }
    }
    pub fn shutdown(&self) {
        let keys: Vec<_> = self.tasks.lock().unwrap().keys().cloned().collect();
        for (peer, id) in keys {
            self.cancel(&peer, &id);
            let files = self.clone();
            tokio::spawn(async move {
                files.release(&peer, &id).await;
            });
        }
        self.sources.lock().unwrap().clear();
    }
}
fn decode(bytes: &[u8]) -> Result<(String, u64, &[u8])> {
    if bytes.len() <= CHUNK_HEADER
        || &bytes[..4] != b"SND1"
        || bytes.len() > MAX_CHUNK + CHUNK_HEADER
    {
        return Err("文件数据不完整".into());
    }
    let id = std::str::from_utf8(&bytes[4..40])
        .map_err(|_| "文件标识无效")?
        .to_string();
    uuid::Uuid::parse_str(&id).map_err(|_| "文件标识无效")?;
    Ok((
        id,
        u32::from_be_bytes(bytes[40..44].try_into().unwrap()) as u64,
        &bytes[44..],
    ))
}
fn chunk_header(id: &str, sequence: u32) -> Result<[u8; CHUNK_HEADER]> {
    if id.len() != 36 {
        return Err("文件标识无效".into());
    }
    let mut header = [0; CHUNK_HEADER];
    header[..4].copy_from_slice(b"SND1");
    header[4..40].copy_from_slice(id.as_bytes());
    header[40..].copy_from_slice(&sequence.to_be_bytes());
    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encode(id: &str, sequence: u32, payload: &[u8]) -> Result<Vec<u8>> {
        Ok([chunk_header(id, sequence)?.as_slice(), payload].concat())
    }
    fn store() -> (tempfile::TempDir, StorageState) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../temp/artifacts/native-file-tests");
        std::fs::create_dir_all(&root).unwrap();
        let temp = tempfile::tempdir_in(root).unwrap();
        let store = StorageState::open(
            &temp.path().join("data"),
            temp.path().join("location.sqlite"),
        )
        .unwrap();
        (temp, store)
    }
    async fn node(store: &StorageState) -> Node {
        let key = libp2p::identity::Keypair::generate_ed25519();
        let node = Node::start(
            key.to_protobuf_encoding().unwrap(),
            json!({"id":key.public().to_peer_id().to_string()}),
            "test".into(),
            Default::default(),
            Arc::new(|_| {}),
            Arc::new(|_, _| panic!("file payload entered IPC")),
        )
        .await
        .unwrap();
        node.files.enable(store.clone());
        node
    }
    async fn destination(store: &StorageState, id: &str, size: usize) -> String {
        store
            .native_request(Request::Begin {
                id: id.into(),
                name: "test.bin".into(),
                mime: "".into(),
                size: size as u64,
                folder: false,
            })
            .await
            .unwrap()
            .as_str()
            .unwrap()
            .into()
    }
    fn sink(
        node: &Node,
        peer: &str,
        protocol: &str,
        fail_at: Option<usize>,
        captured: Arc<Mutex<Vec<u8>>>,
    ) {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<super::super::WriteRequest>(8);
        node.writers
            .lock()
            .unwrap()
            .insert((peer.into(), protocol.into()), (tx, "connection".into()));
        let files = node.files.clone();
        let peer = peer.to_owned();
        tokio::spawn(async move {
            let mut count = 0;
            while let Some(super::super::WriteRequest {
                frame: bytes,
                reply,
                ..
            }) = rx.recv().await
            {
                count += 1;
                if fail_at == Some(count) {
                    let _ = reply.send(Err("disconnected".into()));
                    break;
                }
                if bytes[4] == 2 {
                    let (id, _, data) = decode(&bytes[5..]).unwrap();
                    let received = {
                        let mut saved = captured.lock().unwrap();
                        saved.extend_from_slice(data);
                        saved.len()
                    };
                    files.progress(
                        &peer,
                        &json!({"type":"file-progress","id":id,"received":received}),
                    );
                }
                let _ = reply.send(Ok(()));
            }
        });
    }
    #[test]
    fn rtc_reads_end_on_record_boundaries_and_preserve_sequence_capacity() {
        for chunk in [256 * 1024, 200_003, 31 * 1024] {
            assert_eq!(
                file_read_plan(Some(chunk), 1 << 30, 0),
                (chunk, BLOCK / chunk * chunk)
            );
        }
        assert_eq!(file_read_plan(None, 1 << 30, 0), (CHUNK, BLOCK));
        assert_eq!(
            file_read_plan(Some(127 * 1024), CHUNK as u64, u32::MAX as u64),
            (CHUNK, BLOCK)
        );
    }

    #[tokio::test]
    async fn retarget_copies_the_flushed_prefix_and_keeps_the_unflushed_tail() {
        let (root, store) = store();
        let node = node(&store).await;
        sink(&node, "peer", CHAT, None, Default::default());
        let id = uuid::Uuid::new_v4().to_string();
        let size = CHUNK * 3 + 1;
        let managed = destination(&store, &id, size).await;
        let path = root.path().join("selected.bin");
        std::fs::write(&path, b"original").unwrap();
        let external = store
            .native_request(Request::BeginExternal {
                id: id.clone(),
                size: size as u64,
                destination: path.clone(),
            })
            .await
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        node.files
            .receive("peer", &id, managed.clone(), size as u64, "open".into())
            .unwrap();
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        for (index, part) in bytes.chunks(CHUNK).enumerate() {
            if index == 3 {
                node.files
                    .retarget("peer", &id, external.clone())
                    .await
                    .unwrap();
                store
                    .native_request(Request::Abort {
                        token: managed.clone(),
                    })
                    .await
                    .unwrap();
                assert_eq!(std::fs::read(&path).unwrap(), b"original");
            }
            node.files
                .chunk(
                    &node,
                    "peer",
                    "open",
                    encode(&id, index as u32, part).unwrap(),
                    false,
                    &node.emit,
                )
                .await
                .unwrap();
        }
        assert_eq!(
            node.files.state("peer", &id, None).await.unwrap()["received"],
            size
        );
        store
            .native_request(Request::Finish { token: external })
            .await
            .unwrap();
        node.files.release("peer", &id).await;
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(
            store
                .native_request(Request::Attachment { id })
                .await
                .unwrap(),
            Value::Null
        );
        node.stop();
    }

    #[tokio::test]
    async fn native_receive_retains_prefix_binds_peer_and_connection_and_only_publishes_after_finish()
     {
        let (_temp, store) = store();
        let node = node(&store).await;
        sink(&node, "peer", CHAT, None, Default::default());
        let id = uuid::Uuid::new_v4().to_string();
        let bytes = vec![13; CHUNK * 3 + 17];
        let token = destination(&store, &id, bytes.len()).await;
        node.files
            .receive(
                "peer",
                &id,
                token.clone(),
                bytes.len() as u64,
                "first".into(),
            )
            .unwrap();
        assert!(node.files.state("stranger", &id, None).await.is_err());
        node.files
            .chunk(
                &node,
                "peer",
                "first",
                encode(&id, 0, &bytes[..CHUNK]).unwrap(),
                false,
                &node.emit,
            )
            .await
            .unwrap();
        let state = node
            .files
            .state("peer", &id, Some("resumed".into()))
            .await
            .unwrap();
        assert_eq!(state["received"], CHUNK);
        assert_eq!(state["sequence"], 1);
        node.files
            .chunk(
                &node,
                "peer",
                "first",
                encode(&id, 1, &bytes[..CHUNK]).unwrap(),
                false,
                &node.emit,
            )
            .await
            .unwrap();
        assert!(
            node.files
                .chunk(
                    &node,
                    "peer",
                    "resumed",
                    encode(&id, 2, &bytes[..CHUNK]).unwrap(),
                    false,
                    &node.emit
                )
                .await
                .is_err()
        );
        for (i, chunk) in bytes[CHUNK..].chunks(CHUNK).enumerate() {
            node.files
                .chunk(
                    &node,
                    "peer",
                    "resumed",
                    encode(&id, i as u32 + 1, chunk).unwrap(),
                    false,
                    &node.emit,
                )
                .await
                .unwrap();
        }
        assert_eq!(
            node.files.state("peer", &id, None).await.unwrap()["received"],
            bytes.len()
        );
        assert!(
            store
                .native_request(Request::Attachment { id: id.clone() })
                .await
                .unwrap()
                .is_null()
        );
        store
            .native_request(Request::Finish { token })
            .await
            .unwrap();
        assert_eq!(
            store.read_source(id.clone(), 0, bytes.len()).await.unwrap(),
            bytes
        );
        node.files.release("peer", &id).await;
        node.stop();
    }
    #[tokio::test]
    async fn native_sender_resumes_without_duplicating_its_local_copy() {
        let (_temp, store) = store();
        let node = node(&store).await;
        let id = uuid::Uuid::new_v4().to_string();
        let bytes: Vec<_> = (0..BLOCK + 17).map(|i| (i % 251) as u8).collect();
        let token = destination(&store, &id, bytes.len()).await;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&bytes).unwrap();
        let source = node
            .files
            .source(file.reopen().unwrap(), Some(file))
            .unwrap();
        node.files
            .sender(
                "peer",
                &id,
                source["token"].as_str().unwrap(),
                Some(token.clone()),
                bytes.len() as u64,
            )
            .unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        sink(&node, "peer", FILE, Some(4), captured.clone());
        assert!(
            node.send_file("peer", &id, 0, 0, 0, false)
                .await
                .unwrap_err()
                .starts_with("network:")
        );
        assert_eq!(captured.lock().unwrap().len(), 3 * CHUNK);
        sink(&node, "peer", FILE, None, captured.clone());
        node.send_file("peer", &id, (3 * CHUNK) as u64, 3, 0, false)
            .await
            .unwrap();
        assert_eq!(*captured.lock().unwrap(), bytes);
        store
            .native_request(Request::Finish { token })
            .await
            .unwrap();
        assert_eq!(
            store.read_source(id.clone(), 0, bytes.len()).await.unwrap(),
            bytes
        );
        node.files.release("peer", &id).await;
        node.stop();
    }
    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test]
    async fn send_activity_follows_the_body_attempt_through_hold_disconnect_and_resume() {
        let (_root, store) = store();
        let node = node(&store).await;
        let configure = |enabled: bool| {
            node.files.configure_send_activity(&json!({
                "macosSendActivity": enabled == cfg!(target_os = "macos"),
                "windowsSendActivity": enabled == cfg!(windows),
            }));
        };
        node.files.configure_send_activity(&json!({}));
        let id = uuid::Uuid::new_v4().to_string();
        let source = tempfile::tempfile().unwrap();
        source.set_len((BLOCK + 1) as u64).unwrap();
        let source = node.files.source(source, None).unwrap();
        node.files
            .sender(
                "peer",
                &id,
                source["token"].as_str().unwrap(),
                None,
                (BLOCK + 1) as u64,
            )
            .unwrap();
        let task = node.files.task("peer", &id).unwrap();
        let active = || {
            task.send
                .as_ref()
                .unwrap()
                .flow
                .lock()
                .unwrap()
                .activity
                .is_some()
        };
        let (tx, mut writes) = tokio::sync::mpsc::channel::<super::super::WriteRequest>(2);
        node.writers
            .lock()
            .unwrap()
            .insert(("peer".into(), FILE.into()), (tx, "connection".into()));
        let start = |offset, sequence| {
            let node = node.clone();
            let id = id.clone();
            tokio::spawn(
                async move { node.send_file("peer", &id, offset, sequence, 0, true).await },
            )
        };
        assert!(!active());
        let sending = start(0, 0);
        let first = writes.recv().await.unwrap();
        assert!(active());
        node.files
            .progress("peer", &json!({"type":"file-hold","id":id,"active":true}));
        assert!(!active());
        first.reply.send(Ok(())).unwrap();
        node.files
            .progress("peer", &json!({"type":"file-hold","id":id,"active":false}));
        let second = writes.recv().await.unwrap();
        assert!(active());
        node.files.disconnected("peer");
        assert!(!active());
        second.reply.send(Err("disconnected".into())).unwrap();
        assert!(sending.await.unwrap().unwrap_err().starts_with("network:"));
        let resumed = start(BLOCK as u64, 16);
        let tail = writes.recv().await.unwrap();
        assert!(active());
        tail.reply.send(Ok(())).unwrap();
        resumed.await.unwrap().unwrap();
        assert!(!active());
        // A completed resume only needs a receipt, even if the local sender task still exists.
        let complete = start((BLOCK + 1) as u64, 17);
        complete.await.unwrap().unwrap();
        assert!(!active());
        configure(false);
        let disabled = start(BLOCK as u64, 16);
        let tail = writes.recv().await.unwrap();
        assert!(!active());
        tail.reply.send(Ok(())).unwrap();
        disabled.await.unwrap().unwrap();
        configure(true);
        let failed = start(0, 0);
        writes
            .recv()
            .await
            .unwrap()
            .reply
            .send(Err("write failed".into()))
            .unwrap();
        assert!(failed.await.unwrap().is_err());
        assert!(!active());
        let cancelled = start(0, 0);
        let pending = writes.recv().await.unwrap();
        assert!(active());
        node.files.cancel("peer", &id);
        assert!(!active());
        drop(pending);
        assert!(cancelled.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn cancellation_wakes_a_sender_blocked_by_the_receive_window_and_removes_partial_storage()
    {
        let (_temp, store) = store();
        let node = node(&store).await;
        let id = uuid::Uuid::new_v4().to_string();
        let token = destination(&store, &id, BLOCK * 3).await;
        let file = tempfile::NamedTempFile::new().unwrap();
        file.as_file().set_len((BLOCK * 3) as u64).unwrap();
        let source = node
            .files
            .source(file.reopen().unwrap(), Some(file))
            .unwrap();
        node.files
            .sender(
                "peer",
                &id,
                source["token"].as_str().unwrap(),
                Some(token),
                (BLOCK * 3) as u64,
            )
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<super::super::WriteRequest>(8);
        node.writers
            .lock()
            .unwrap()
            .insert(("peer".into(), FILE.into()), (tx, "connection".into()));
        let sender = node.clone();
        let transfer = id.clone();
        let work =
            tokio::spawn(async move { sender.send_file("peer", &transfer, 0, 0, 0, false).await });
        for _ in 0..8 {
            rx.recv().await.unwrap().reply.send(Ok(())).unwrap();
        }
        assert!(!work.is_finished());
        node.files.cancel("peer", &id);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), work)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        node.files.release("peer", &id).await;
        assert!(
            store
                .native_request(Request::Attachment { id })
                .await
                .unwrap()
                .is_null()
        );
        assert_eq!(
            store.native_request(Request::Info).await.unwrap()["cacheUsage"],
            0
        );
        node.stop();
    }
}
