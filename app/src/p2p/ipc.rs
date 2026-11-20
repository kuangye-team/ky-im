use super::{ListenOptions, Node};
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::{
    State,
    ipc::{Channel, InvokeResponseBody, Request},
};
#[derive(Default)]
pub struct P2pState(tokio::sync::Mutex<Option<(String, Node)>>);
impl P2pState {
    pub async fn stop(&self) {
        if let Some((_, node)) = self.0.lock().await.take() {
            node.stop();
        }
    }
    async fn node(&self, session: &str) -> Result<Node, String> {
        self.0
            .lock()
            .await
            .as_ref()
            .filter(|(id, _)| id == session)
            .map(|(_, n)| n.clone())
            .ok_or("Network session closed".into())
    }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
#[tauri::command]
pub async fn p2p_request(
    app: tauri::AppHandle,
    storage: State<'_, crate::storage::StorageState>,
    state: State<'_, P2pState>,
    session_id: String,
    request: Value,
    on_event: Channel<InvokeResponseBody>,
) -> Result<Value, String> {
    let op = text(&request, "op")?;
    if op == "start" {
        let mut current = state.0.lock().await;
        if let Some((_, old)) = current.take() {
            old.stop();
        }
        let key = serde_json::from_value(request["key"].clone()).map_err(|e| e.to_string())?;
        let events = on_event;
        let data_events = events.clone();
        let node = Node::start(
            key,
            request["profile"].clone(),
            text(&request, "room")?.into(),
            ListenOptions::from_request(&request, true),
            Arc::new(move |event| {
                let _ = events.send(InvokeResponseBody::Json(event.to_string()));
            }),
            Arc::new(move |header, data| {
                let _ = data_events.send(InvokeResponseBody::Raw(super::encode_data(header, data)));
            }),
        )
        .await?;
        node.pipes.enable_native();
        node.files.enable(storage.inner().clone());
        #[cfg(any(target_os = "macos", windows))]
        node.files.configure_send_activity(&request);
        *current = Some((session_id, node));
        return Ok(json!({"nativeFiles":true,"nativeNetwork":true}));
    }
    if op == "stop" {
        let mut current = state.0.lock().await;
        if current.as_ref().is_some_and(|(id, _)| id == &session_id)
            && let Some((_, old)) = current.take()
        {
            old.stop();
        }
        return Ok(Value::Null);
    }
    let node = state.node(&session_id).await?;
    match op {
        "rtc_exchange" => {
            return node
                .network
                .exchange_offer(text(&request, "peerId")?, &request["offer"])
                .await;
        }
        "rtc_reply" => node.network.webview.reply(
            text(&request, "requestId")?,
            match request["error"].as_str() {
                Some(message) => Err(message.to_string()),
                None => Ok(Vec::new()),
            },
        ),
        "socket_open" => {
            node.network
                .open(
                    text(&request, "socketId")?.into(),
                    text(&request, "source")?.into(),
                    text(&request, "address")?.into(),
                    request["permitted"].as_bool().unwrap_or(false),
                )
                .await?
        }
        "socket_send" => node
            .network
            .send(text(&request, "socketId")?, text(&request, "message")?)?,
        "socket_close" => node.network.close_source(text(&request, "socketId")?),
        "relay_dial" => {
            let token = text(&request, "token")?;
            if let Err(error) = node
                .network
                .dial_relay(token.into(), text(&request, "address")?)
                .await
            {
                node.pipes.close(token);
                return Err(error);
            }
        }

        "file_source" => {
            let file = if let Some(id) = request["attachmentId"].as_str() {
                storage.source(id.into()).await?
            } else {
                use tauri_plugin_fs::FsExt;
                let path = std::path::PathBuf::from(text(&request, "path")?);
                if !app.fs_scope().is_allowed(&path) {
                    return Err("请重新选择要发送的文件".into());
                }
                for parent in path.ancestors() {
                    if std::fs::symlink_metadata(parent)
                        .map_err(|e| e.to_string())?
                        .file_type()
                        .is_symlink()
                    {
                        return Err("文件包含符号链接，请重新选择".into());
                    }
                }
                std::fs::File::open(path).map_err(|e| e.to_string())?
            };
            return node.files.source(file, None);
        }
        "file_upload" => {
            let temp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
            let file = temp.reopen().map_err(|e| e.to_string())?;
            return node.files.source(file, Some(temp));
        }
        "file_source_release" => node.files.release_source(text(&request, "token")?),
        "file_sender" => node.files.sender(
            text(&request, "peerId")?,
            text(&request, "id")?,
            text(&request, "source")?,
            request["token"].as_str().map(str::to_owned),
            request["size"].as_u64().ok_or("Missing size")?,
        )?,
        "file_receive" => node.files.receive(
            text(&request, "peerId")?,
            text(&request, "id")?,
            text(&request, "token")?.into(),
            request["size"].as_u64().ok_or("Missing size")?,
            text(&request, "connectionId")?.into(),
        )?,
        "file_retarget" => {
            node.files
                .retarget(
                    text(&request, "peerId")?,
                    text(&request, "id")?,
                    text(&request, "token")?.into(),
                )
                .await?
        }
        "file_state" => {
            return node
                .files
                .state(
                    text(&request, "peerId")?,
                    text(&request, "id")?,
                    request["connectionId"].as_str().map(str::to_owned),
                )
                .await;
        }
        "file_send" => {
            return node
                .send_file(
                    text(&request, "peerId")?,
                    text(&request, "id")?,
                    request["offset"].as_u64().ok_or("Missing offset")?,
                    request["sequence"].as_u64().ok_or("Missing sequence")?,
                    request["base"].as_u64().unwrap_or(0),
                    request["singleFile"].as_bool().unwrap_or(false),
                )
                .await;
        }
        "file_cancel" => node
            .files
            .cancel(text(&request, "peerId")?, text(&request, "id")?),
        "file_release" => {
            node.files
                .release(text(&request, "peerId")?, text(&request, "id")?)
                .await
        }
        "cache_profile" => {
            let value = &request["profile"];
            if let Some(peer) = value["id"].as_str().and_then(|id| id.parse().ok()) {
                node.cache_profile(peer, value.clone());
            }
        }
        "register" => {
            let cached = &request["cachedProfile"];
            if let Some(peer) = cached["id"].as_str().and_then(|id| id.parse().ok()) {
                node.cache_profile(peer, cached.clone());
            }
            node.register(
                request["profile"].clone(),
                serde_json::from_value(request["addresses"].clone()).map_err(|e| e.to_string())?,
                text(&request, "source")?.into(),
            )
            .await?
        }
        "forget" => {
            node.forget(text(&request, "peerId")?, text(&request, "source")?.into())
                .await?
        }
        "connect" => {
            node.connect_attempt(
                text(&request, "peerId")?,
                request["attemptId"].as_str().unwrap_or_default().into(),
            )
            .await?
        }
        "publish" => node.publish(request["profile"].clone()).await?,
        "ping" => {
            return Ok(json!(
                node.probe_peer(text(&request, "peerId")?, request["probeId"].as_str())
                    .await?
            ));
        }
        "close" | "close_route" => {
            node.close_attempt(
                text(&request, "peerId")?,
                request["attemptId"].as_str().map(str::to_owned),
                request["physicalConnectionId"].as_str().map(str::to_owned),
                op == "close" && request["retirePeer"].as_bool().unwrap_or(true),
            )
            .await?
        }
        "metrics" => {
            return Ok(node.metrics.configure(
                request["enabled"].as_bool(),
                request["reset"].as_bool().unwrap_or(false),
            ));
        }
        "consumed" => node.consumed(
            text(&request, "token")?,
            request["sequence"].as_u64().ok_or("Missing sequence")?,
        )?,
        "pipe_accept" => {
            return Ok(json!(
                node.pipes.accept(
                    text(&request, "address")?
                        .parse()
                        .map_err(|_| "Invalid address")?
                )?
            ));
        }
        "pipe_ready" => node.pipes.ready(text(&request, "token")?),
        "pipe_close" => node.pipes.close(text(&request, "token")?),
        "pipe_consumed" => node.pipes.consumed(
            text(&request, "token")?,
            request["sequence"].as_u64().ok_or("Missing sequence")?,
        )?,
        _ => return Err("Unknown network operation".into()),
    }
    Ok(Value::Null)
}
#[tauri::command]
pub async fn p2p_write(state: State<'_, P2pState>, request: Request<'_>) -> Result<(), String> {
    let session = crate::ipc::header(&request, "x-session-id")?;
    let node = state.node(&session).await?;
    if let Ok(id) = crate::ipc::header(&request, "x-rtc-reply") {
        let bytes = crate::ipc::raw(request.body(), super::FRAME_LIMIT.max(160 * 1024))?;
        node.network.webview.reply(&id, Ok(bytes));
        return Ok(());
    }
    if let Ok(token) = crate::ipc::header(&request, "x-file-source") {
        return node
            .files
            .upload(&token, crate::ipc::raw(request.body(), 2 * 1024 * 1024)?)
            .await;
    }
    if let Ok(token) = crate::ipc::header(&request, "x-pipe-token") {
        let bytes = crate::ipc::raw(request.body(), super::transport::PIPE_BLOCK)?;
        return node.pipes.write(&token, &bytes).await;
    }
    let bytes = crate::ipc::raw(request.body(), super::FRAME_LIMIT)?;
    let peer = crate::ipc::header(&request, "x-peer-id")?;
    let protocol = crate::ipc::header(&request, "x-protocol")?;
    let kind = crate::ipc::header(&request, "x-frame-kind")?
        .parse()
        .map_err(|_| "Invalid frame")?;
    node.send(&peer, &protocol, kind, bytes).await
}
