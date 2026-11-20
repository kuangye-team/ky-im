#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod close_window;

use hummingbird::storage::StorageState;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
#[tauri::command]
fn runtime_info() -> hummingbird::capabilities::RuntimeInfo {
    hummingbird::capabilities::app_runtime()
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        // Register first so opening a deep link reuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(close_window::ClosePrompt::default())
        .on_window_event(close_window::on_window_event)
        .plugin(hummingbird::reload::init())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main")
                && let Some(color) = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|config| config.label == "main")
                    .and_then(|config| config.background_color)
                && let Err(error) = hummingbird::window_theme::set_title_bar_color(window, color)
            {
                // Older Windows versions may not support custom caption colors.
                eprintln!("{error}");
            }
            #[cfg(all(debug_assertions, windows))]
            app.deep_link().register_all()?;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if event
                    .urls()
                    .iter()
                    .any(|url| url.scheme() == "ky-im" && url.host_str() == Some("open"))
                {
                    show_main_window(&handle);
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(hummingbird::p2p::ipc::P2pState::default())
        .manage(StorageState::default())
        .invoke_handler(tauri::generate_handler![
            close_window::set_window_language,
            hummingbird::p2p::ipc::p2p_request,
            hummingbird::p2p::ipc::p2p_write,
            runtime_info,
            hummingbird::reload::set_reload_guard,
            hummingbird::reload::reload_app,
            hummingbird::window_theme::set_title_bar_color,
            hummingbird::updates::prepare_update_download,
            hummingbird::updates::download_update,
            hummingbird::updates::install_update,
            hummingbird::storage::storage_request,
            hummingbird::storage::storage_write,
            hummingbird::storage::file_sources,
            hummingbird::storage::storage_read
        ])
        .build(tauri::generate_context!())
        .expect("Could not start Hummingbird")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(async {
                    app.state::<hummingbird::p2p::ipc::P2pState>().stop().await;
                });
            }
        });
}
