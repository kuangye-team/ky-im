use serde::Serialize;
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tauri::{Manager, Resource, ResourceId, Runtime, Webview, ipc::Channel};
use tauri_plugin_updater::Update;
use tokio_util::sync::CancellationToken;

// Closing this webview-owned resource also stops an in-flight HTTP download.
struct UpdateDownload {
    update: Arc<Update>,
    cancel: CancellationToken,
    bytes: Mutex<Option<Vec<u8>>>,
}

impl Resource for UpdateDownload {
    fn close(self: Arc<Self>) {
        self.cancel.cancel();
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

async fn cancellable<T>(
    cancel: &CancellationToken,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Update cancelled".into()),
        result = work => result,
    }
}

#[tauri::command]
pub fn prepare_update_download<R: Runtime>(
    webview: Webview<R>,
    update_rid: ResourceId,
) -> Result<ResourceId, String> {
    let mut resources = webview.resources_table();
    let update = resources
        .get::<Update>(update_rid)
        .map_err(|e| e.to_string())?;
    Ok(resources.add(UpdateDownload {
        update,
        cancel: CancellationToken::new(),
        bytes: Mutex::new(None),
    }))
}

#[tauri::command]
pub async fn download_update<R: Runtime>(
    webview: Webview<R>,
    download_rid: ResourceId,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let download = webview
        .resources_table()
        .get::<UpdateDownload>(download_rid)
        .map_err(|e| e.to_string())?;
    let mut started = false;
    let bytes = cancellable(&download.cancel, async {
        // Keep the plugin's signature verification and platform handling.
        download
            .update
            .download(
                |chunk_length, content_length| {
                    if !started {
                        started = true;
                        let _ = on_event.send(DownloadEvent::Started { content_length });
                    }
                    let _ = on_event.send(DownloadEvent::Progress { chunk_length });
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())
    })
    .await?;
    // Finished means the package has also passed signature verification.
    *download.bytes.lock().map_err(|e| e.to_string())? = Some(bytes);
    let _ = on_event.send(DownloadEvent::Finished);
    Ok(())
}

#[tauri::command]
pub async fn install_update<R: Runtime>(
    webview: Webview<R>,
    download_rid: ResourceId,
) -> Result<(), String> {
    let download = webview
        .resources_table()
        .get::<UpdateDownload>(download_rid)
        .map_err(|e| e.to_string())?;
    // Installation can block; keep it off the async runtime and UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        if download.cancel.is_cancelled() {
            return Err("Update cancelled".into());
        }
        let bytes = download.bytes.lock().map_err(|e| e.to_string())?;
        let bytes = bytes.as_ref().ok_or("Update has not been downloaded")?;
        download.update.install(bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_drops_in_flight_work() {
        let cancel = CancellationToken::new();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (held, dropped) = tokio::sync::oneshot::channel::<()>();
        let token = cancel.clone();
        let task = tokio::spawn(async move {
            cancellable(&token, async move {
                let _held = held;
                started.send(()).unwrap();
                std::future::pending::<Result<(), String>>().await
            })
            .await
        });
        ready.await.unwrap();
        cancel.cancel();
        assert_eq!(task.await.unwrap().unwrap_err(), "Update cancelled");
        assert!(dropped.await.is_err());
    }

    #[tokio::test]
    async fn cancellation_wins_even_when_work_is_ready() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            cancellable(&cancel, async {
                panic!("must not start");
                #[allow(unreachable_code)]
                Ok(())
            })
            .await
            .is_err()
        );
        assert_eq!(
            cancellable(&CancellationToken::new(), async { Ok(vec![1, 2]) })
                .await
                .unwrap(),
            vec![1, 2]
        );
    }
}
