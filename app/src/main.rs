#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use hummingbird::storage::StorageState;
use hummingbird::{
    ipc,
    network::{LanNode, Profile, TcpEndpoint, frame},
};
use std::sync::Arc;
use tauri::{
    Manager, State,
    ipc::{Channel, InvokeResponseBody, Request},
};
use tokio::sync::Mutex;

#[derive(Default)]
struct NetworkState(Mutex<Option<(String, Arc<LanNode>)>>);

impl NetworkState {
    async fn node(&self, session_id: &str) -> Result<Arc<LanNode>, String> {
        self.0
            .lock()
            .await
            .as_ref()
            .filter(|(id, _)| id == session_id)
            .map(|(_, node)| node.clone())
            .ok_or("Discovery session closed".into())
    }
}

#[tauri::command]
async fn lan_start(
    state: State<'_, NetworkState>,
    session_id: String,
    profile: Profile,
    room: String,
    on_event: Channel<InvokeResponseBody>,
    discover: Option<bool>,
    tcp_enabled: Option<bool>,
) -> Result<TcpEndpoint, String> {
    let mut current = state.0.lock().await;
    if let Some((_, previous)) = current.take() {
        previous.shutdown();
    }
    let node = LanNode::start_configured(
        profile,
        room,
        discover.unwrap_or(true),
        tcp_enabled.unwrap_or(true),
        move |event| {
            if let Ok(body) = ipc::network_event(event) {
                let _ = on_event.send(body);
            }
        },
    )
    .await?;
    let endpoint = match node.endpoint() {
        Ok(endpoint) => endpoint,
        Err(error) => {
            node.shutdown();
            return Err(error);
        }
    };
    *current = Some((session_id, node));
    Ok(endpoint)
}

#[tauri::command]
async fn lan_stop(state: State<'_, NetworkState>, session_id: String) -> Result<(), String> {
    let mut current = state.0.lock().await;
    if current.as_ref().is_some_and(|(id, _)| id == &session_id)
        && let Some((_, node)) = current.take()
    {
        node.shutdown();
    }
    Ok(())
}

#[tauri::command]
async fn lan_profile(
    state: State<'_, NetworkState>,
    session_id: String,
    profile: Profile,
) -> Result<(), String> {
    state.node(&session_id).await?.update_profile(profile)
}

#[tauri::command]
async fn lan_peer(
    state: State<'_, NetworkState>,
    session_id: String,
    profile: Profile,
    endpoint: TcpEndpoint,
) -> Result<(), String> {
    state
        .node(&session_id)
        .await?
        .register_peer(profile, endpoint)
}
#[tauri::command]
async fn lan_forget(
    state: State<'_, NetworkState>,
    session_id: String,
    peer_id: String,
) -> Result<(), String> {
    state.node(&session_id).await?.forget_peer(&peer_id);
    Ok(())
}
#[tauri::command]
async fn lan_signal(
    state: State<'_, NetworkState>,
    session_id: String,
    peer_id: String,
    data: serde_json::Value,
) -> Result<(), String> {
    state.node(&session_id).await?.signal(&peer_id, data).await
}

#[tauri::command]
async fn tcp_connect(
    state: State<'_, NetworkState>,
    session_id: String,
    peer_id: String,
) -> Result<(), String> {
    state.node(&session_id).await?.connect(&peer_id).await
}

#[tauri::command]
async fn tcp_send(state: State<'_, NetworkState>, request: Request<'_>) -> Result<(), String> {
    let session_id = ipc::header(&request, "x-session-id")?;
    let peer_id = ipc::header(&request, "x-peer-id")?;
    let connection_id = ipc::header(&request, "x-connection-id")?;
    let kind: u8 = ipc::header(&request, "x-frame-kind")?
        .parse()
        .map_err(|_| "Invalid payload kind")?;
    if ![frame::TEXT, frame::BINARY].contains(&kind) {
        return Err("Invalid payload kind".into());
    }
    let bytes = ipc::raw(request.body(), frame::limit(kind))?;
    state
        .node(&session_id)
        .await?
        .send(&peer_id, &connection_id, kind, bytes)
        .await
}

#[tauri::command]
async fn tcp_consumed(
    state: State<'_, NetworkState>,
    session_id: String,
    peer_id: String,
    connection_id: String,
) -> Result<(), String> {
    state
        .node(&session_id)
        .await?
        .consumed(&peer_id, &connection_id);
    Ok(())
}

#[tauri::command]
async fn tcp_close(
    state: State<'_, NetworkState>,
    session_id: String,
    peer_id: String,
    connection_id: Option<String>,
) -> Result<(), String> {
    state
        .node(&session_id)
        .await?
        .close_peer(&peer_id, connection_id.as_deref());
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(NetworkState::default())
        .manage(StorageState::default())
        .invoke_handler(tauri::generate_handler![
            lan_start,
            lan_stop,
            lan_profile,
            lan_peer,
            lan_forget,
            lan_signal,
            tcp_connect,
            tcp_send,
            tcp_consumed,
            tcp_close,
            hummingbird::storage::storage_request,
            hummingbird::storage::storage_write,
            hummingbird::storage::storage_read
        ])
        .build(tauri::generate_context!())
        .expect("Could not start Hummingbird")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(async {
                    if let Some((_, node)) = app.state::<NetworkState>().0.lock().await.take() {
                        node.shutdown();
                    }
                });
            }
        });
}
