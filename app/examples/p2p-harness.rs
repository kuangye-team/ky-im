//! Test-only framed stdio boundary using the desktop's binary IPC event format.
use hummingbird::p2p::{ListenOptions, Node};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    sync::{Arc, Mutex},
};
fn output(value: Value) {
    output_frame(1, &serde_json::to_vec(&value).unwrap());
}
fn output_frame(kind: u8, bytes: &[u8]) {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&((bytes.len() + 1) as u32).to_be_bytes());
    let _ = out.write_all(&[kind]);
    let _ = out.write_all(bytes);
    let _ = out.flush();
}
#[tokio::main]
async fn main() {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(Value, Option<Vec<u8>>)>(64);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut size = [0; 4];
            if input.read_exact(&mut size).is_err() {
                break;
            }
            let size = u32::from_be_bytes(size) as usize;
            if size == 0 || size > 3 * 1024 * 1024 {
                break;
            }
            let mut frame = vec![0; size];
            if input.read_exact(&mut frame).is_err() {
                break;
            }
            let (json, data) = if frame[0] == 2 && size >= 5 {
                let header = u32::from_be_bytes(frame[1..5].try_into().unwrap()) as usize;
                if header > size - 5 {
                    break;
                }
                (&frame[5..5 + header], Some(frame[5 + header..].to_vec()))
            } else {
                (&frame[1..], None)
            };
            let Ok(value) = serde_json::from_slice(json) else {
                break;
            };
            if tx.blocking_send((value, data)).is_err() {
                break;
            }
        }
    });
    let root = std::env::current_dir()
        .unwrap()
        .join("../temp/artifacts/native-integration")
        .join(std::process::id().to_string());
    let storage = hummingbird::storage::StorageState::open(
        &root.join("data"),
        root.join("config/location.sqlite"),
    )
    .unwrap();
    let node: Arc<tokio::sync::Mutex<Option<Node>>> = Default::default();
    while let Some((request, data)) = rx.recv().await {
        let state = node.clone();
        let storage = storage.clone();
        let root = root.clone();
        tokio::spawn(async move {
            let result: Result<Value, String> = async {
                let op = request["op"].as_str().ok_or("Missing op")?;
                if op == "start" {
                    let mut state = state.lock().await;
                    if let Some(node) = state.take() {
                        node.stop();
                    }
                    *state = Some(
                        Node::start(
                            serde_json::from_value(request["key"].clone())
                                .map_err(|e| e.to_string())?,
                            request["profile"].clone(),
                            request["room"].as_str().unwrap_or("test").into(),
                            ListenOptions::from_request(&request, false),
                            Arc::new(|event| output(json!({"event":event}))),
                            Arc::new(|header, data| {
                                output_frame(2, &hummingbird::p2p::encode_data(header, data))
                            }),
                        )
                        .await?,
                    );
                    if request["nativeIO"] == true {
                        let node = state.as_ref().unwrap();
                        node.files.enable(storage.clone());
                        #[cfg(any(target_os = "macos", windows))]
                        node.files.configure_send_activity(&request);
                        node.pipes.enable_native();
                        return Ok(json!({"nativeFiles":true,"nativeNetwork":true}));
                    }
                    return Ok(Value::Null);
                }
                if op == "storage" {
                    use hummingbird::storage::Request;
                    let mut request: Request = serde_json::from_value(request["request"].clone())
                        .map_err(|e| e.to_string())?;
                    if let Request::BeginExternal { destination, .. } = &mut request {
                        // Test exports stay beside this isolated harness store.
                        let name = destination.file_name().ok_or("Missing file name")?;
                        let exports = root.join("exports");
                        std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
                        *destination = exports.join(name);
                    }
                    if let Request::CopyToExternal { from, to, saved } = request {
                        storage.copy_to_external(from, to, saved).await?;
                        return Ok(Value::Null);
                    }
                    return storage.native_request(request).await;
                }
                if op == "storage_read" {
                    let bytes = storage
                        .read_source(
                            request["key"].as_str().unwrap().into(),
                            request["offset"].as_u64().unwrap(),
                            request["length"].as_u64().unwrap() as usize,
                        )
                        .await?;
                    return Ok(json!(bytes));
                }
                if op == "storage_write" {
                    return storage
                        .native_request(hummingbird::storage::Request::Write {
                            token: request["token"].as_str().unwrap().into(),
                            data: data.ok_or("Missing payload")?,
                        })
                        .await;
                }
                let node = state.lock().await.clone().ok_or("Not started")?;
                let peer = request["peerId"].as_str().unwrap_or_default();
                let token = request["token"].as_str().unwrap_or_default();
                let id = request["id"].as_str().unwrap_or_default();
                match op {
                    "rtc_exchange" => {
                        return node.network.exchange_offer(peer, &request["offer"]).await;
                    }
                    "rtc_reply" => node.network.webview.reply(
                        request["requestId"].as_str().ok_or("Missing RTC request")?,
                        request["error"]
                            .as_str()
                            .map_or_else(|| Ok(Vec::new()), |e| Err(e.to_string())),
                    ),
                    "socket_open" => {
                        node.network
                            .open(
                                request["socketId"].as_str().unwrap().into(),
                                request["source"].as_str().unwrap().into(),
                                request["address"].as_str().unwrap().into(),
                                request["permitted"].as_bool().unwrap_or(false),
                                request["useSystemProxy"].as_bool().unwrap_or(true),
                            )
                            .await?
                    }
                    "socket_send" => node.network.send(
                        request["socketId"].as_str().unwrap(),
                        request["message"].as_str().unwrap(),
                    )?,
                    "socket_close" => node
                        .network
                        .close_source(request["socketId"].as_str().unwrap()),
                    "relay_dial" => {
                        node.network
                            .dial_relay(token.into(), request["address"].as_str().unwrap())
                            .await?
                    }
                    "file_source" => {
                        return node.files.source(
                            storage
                                .source(request["attachmentId"].as_str().unwrap().into())
                                .await?,
                            None,
                        );
                    }
                    "file_upload" => {
                        let temp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
                        return node
                            .files
                            .source(temp.reopen().map_err(|e| e.to_string())?, Some(temp));
                    }
                    "file_source_release" => node.files.release_source(token),
                    "file_sender" => node.files.sender(
                        peer,
                        id,
                        request["source"].as_str().unwrap(),
                        request["token"].as_str().map(str::to_owned),
                        request["size"].as_u64().unwrap(),
                    )?,
                    "file_receive" => node.files.receive(
                        peer,
                        id,
                        token.into(),
                        request["size"].as_u64().unwrap(),
                        request["connectionId"].as_str().unwrap().into(),
                    )?,
                    "file_send" => {
                        return node
                            .send_file(
                                peer,
                                id,
                                request["offset"].as_u64().unwrap(),
                                request["sequence"].as_u64().unwrap(),
                                request["base"].as_u64().unwrap_or(0),
                                request["singleFile"].as_bool().unwrap_or(false),
                            )
                            .await;
                    }
                    "file_retarget" => node.files.retarget(peer, id, token.into()).await?,
                    "file_state" => {
                        return node
                            .files
                            .state(
                                peer,
                                id,
                                request["connectionId"].as_str().map(str::to_owned),
                            )
                            .await;
                    }
                    "file_cancel" => node.files.cancel(peer, id),
                    "file_release" => node.files.release(peer, id).await,

                    "stop" => node.stop(),
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
                            serde_json::from_value(request["addresses"].clone())
                                .map_err(|e| e.to_string())?,
                            request["source"].as_str().unwrap_or("test").into(),
                        )
                        .await?
                    }
                    "forget" => {
                        node.forget(peer, request["source"].as_str().unwrap_or("test").into())
                            .await?
                    }
                    "connect" => {
                        node.connect_attempt(
                            peer,
                            request["attemptId"].as_str().unwrap_or_default().into(),
                        )
                        .await?
                    }
                    "close" | "close_route" => {
                        node.close_attempt(
                            peer,
                            request["attemptId"].as_str().map(str::to_owned),
                            request["physicalConnectionId"].as_str().map(str::to_owned),
                            op == "close" && request["retirePeer"].as_bool().unwrap_or(true),
                        )
                        .await?
                    }
                    "publish" => node.publish(request["profile"].clone()).await?,
                    "ping" => {
                        return Ok(json!(
                            node.probe_peer(peer, request["probeId"].as_str()).await?
                        ));
                    }
                    "metrics" => {
                        return Ok(node.metrics.configure(
                            request["enabled"].as_bool(),
                            request["reset"].as_bool().unwrap_or(false),
                        ));
                    }
                    "consumed" => node.consumed(
                        token,
                        request["sequence"].as_u64().ok_or("Missing sequence")?,
                    )?,
                    "pipe_ready" => node.pipes.ready(token),
                    "pipe_close" => node.pipes.close(token),
                    "pipe_consumed" => node.pipes.consumed(
                        token,
                        request["sequence"].as_u64().ok_or("Missing sequence")?,
                    )?,
                    "pipe_accept" => {
                        return Ok(json!(
                            node.pipes.accept(
                                request["address"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .parse()
                                    .map_err(|_| "Invalid address")?
                            )?
                        ));
                    }
                    "write" => {
                        let data = data.ok_or("Missing binary payload")?;
                        if let Some(id) = request["headers"]["x-rtc-reply"].as_str() {
                            node.network.webview.reply(id, Ok(data));
                        } else if let Some(token) = request["headers"]["x-file-source"].as_str() {
                            node.files.upload(token, data).await?;
                        } else if let Some(token) = request["headers"]["x-pipe-token"].as_str() {
                            node.pipes.write(token, &data).await?;
                        } else {
                            node.send(
                                request["headers"]["x-peer-id"].as_str().unwrap_or_default(),
                                request["headers"]["x-protocol"]
                                    .as_str()
                                    .unwrap_or_default(),
                                request["headers"]["x-frame-kind"]
                                    .as_str()
                                    .unwrap_or("0")
                                    .parse()
                                    .unwrap_or(0),
                                data,
                            )
                            .await?;
                        }
                    }
                    _ => return Err("Unknown operation".into()),
                }
                Ok(Value::Null)
            }
            .await;
            output(match result {
                Ok(result) => json!({"id":request["rpcId"],"result":result}),
                Err(error) => json!({"id":request["rpcId"],"error":error}),
            });
        });
    }
}
