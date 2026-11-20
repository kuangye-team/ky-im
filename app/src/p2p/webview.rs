//! Requests from authenticated Rust protocol streams to their exact WebView RTC session.
use super::{Emit, EmitData, bulk};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

type Reply = Result<Vec<u8>, String>;

pub struct Webview {
    emit: Emit,
    emit_data: EmitData,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
    closed: CancellationToken,
}

impl Webview {
    pub(super) fn new(emit: Emit, emit_data: EmitData) -> Self {
        Self {
            emit,
            emit_data,
            pending: Default::default(),
            closed: Default::default(),
        }
    }
    pub fn stop(&self) {
        self.closed.cancel();
    }
    pub fn reply(&self, id: &str, value: Reply) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(value);
        }
    }
    pub(super) async fn request(&self, peer: &str, session: &str, op: &str, data: &[u8]) -> Reply {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        // A stream task can be cancelled while the WebView is processing a block.
        struct Pending<'a>(&'a Webview, &'a str);
        impl Drop for Pending<'_> {
            fn drop(&mut self) {
                self.0.pending.lock().unwrap().remove(self.1);
            }
        }
        let _pending = Pending(self, &id);
        let event = json!({"type":"rtc_request","requestId":id,"peerId":peer,"rtcSessionId":session,"operation":op});
        if data.is_empty() {
            (self.emit)(event);
        } else {
            (self.emit_data)(event, data);
        }
        tokio::select! {
            _ = self.closed.cancelled() => Err("Connection closed".into()),
            result = tokio::time::timeout(Duration::from_secs(62), rx) =>
                result.map_err(|_| "WebView request timed out")?.map_err(|_| "Connection closed")?,
        }
    }
}

#[derive(Clone)]
pub(super) struct WebviewSession {
    pub peer: String,
    pub session: String,
    pub bridge: Arc<Webview>,
}
impl WebviewSession {
    async fn call(&self, op: &str, data: &[u8]) -> Reply {
        self.bridge
            .request(&self.peer, &self.session, op, data)
            .await
    }
    pub async fn chunk(&self) -> Option<usize> {
        let bytes = self.call("chunk", &[]).await.ok()?;
        let chunk = u32::from_be_bytes(bytes.try_into().ok()?) as usize;
        (1..=super::files::MAX_CHUNK)
            .contains(&chunk)
            .then_some(chunk)
    }
    pub async fn hello(&self) -> Option<Vec<u8>> {
        self.call("hello", &[]).await.ok().filter(|v| !v.is_empty())
    }
    pub async fn binding(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        self.call("binding", bytes)
            .await
            .ok()
            .filter(|v| !v.is_empty())
    }
    pub async fn bound(&self) -> bool {
        self.call("bound", &[]).await.is_ok_and(|v| v == [1])
    }
    pub async fn prepare(&self) {
        let _ = self.call("prepare", &[]).await;
    }
    pub async fn send(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        self.call("send", bytes)
            .await
            .ok()
            .filter(|v| bulk::descriptor(v))
    }
    pub async fn receive(&self, desc: &[u8]) -> Reply {
        self.call("receive", desc).await
    }
}
