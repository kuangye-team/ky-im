use crate::storage::StorageState;
use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;
#[tauri::command]
fn runtime_info() -> crate::capabilities::RuntimeInfo {
    crate::capabilities::app_runtime()
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(windows)]
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/32x32.png"))
        .tooltip("蜂鸟 · Ky IM")
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    if cfg!(windows)
        && let Some(main) = context
            .config_mut()
            .app
            .windows
            .iter_mut()
            .find(|w| w.label == "main")
        && main.hidden_title
    {
        // Tauri applies hiddenTitle only on macOS. Start the Win32 window with an empty caption.
        main.title.clear();
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_android_fs::init())
        .plugin(crate::android::plugin())
        .plugin(crate::android::attachment_plugin())
        .plugin(crate::android::update_plugin());
    #[cfg(desktop)]
    let builder = builder
        // Register first so opening a deep link reuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .register_asynchronous_uri_scheme_protocol("ky-media", crate::storage::media::serve)
        .plugin(crate::reload::init())
        .setup(|_app| {
            #[cfg(desktop)]
            let app = _app;
            #[cfg(windows)]
            install_tray(app)?;
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main")
                && let Some(color) = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|config| config.label == "main")
                    .and_then(|config| config.background_color)
                && let Err(error) = crate::window_theme::set_title_bar_color(window, color)
            {
                // Older Windows versions may not support custom caption colors.
                eprintln!("{error}");
            }
            #[cfg(all(debug_assertions, windows))]
            app.deep_link().register_all()?;
            #[cfg(target_os = "android")]
            crate::android::initialize()?;
            #[cfg(desktop)]
            let handle = app.handle().clone();
            #[cfg(desktop)]
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
        .plugin(tauri_plugin_opener::init())
        .manage(crate::p2p::ipc::P2pState::default())
        .manage(StorageState::default())
        .invoke_handler(tauri::generate_handler![
            crate::p2p::ipc::probe_signaling_server,
            crate::p2p::ipc::p2p_request,
            crate::p2p::ipc::p2p_write,
            #[cfg(target_os = "android")]
            crate::android::request_nearby,
            #[cfg(target_os = "android")]
            crate::android::android_background,
            #[cfg(target_os = "android")]
            crate::storage::android::android_pick_folder,
            #[cfg(target_os = "android")]
            crate::storage::android::android_pick_files,
            #[cfg(target_os = "android")]
            crate::storage::android::android_children,
            #[cfg(target_os = "android")]
            crate::storage::android::android_read,
            #[cfg(target_os = "android")]
            crate::storage::android::android_save_location,
            #[cfg(target_os = "android")]
            crate::storage::android::android_export,
            #[cfg(target_os = "android")]
            crate::storage::android::android_export_writer,
            runtime_info,
            crate::reload::set_reload_guard,
            crate::reload::reload_app,
            #[cfg(desktop)]
            crate::window_theme::set_title_bar_color,
            #[cfg(desktop)]
            crate::updates::prepare_update_download,
            #[cfg(desktop)]
            crate::updates::download_update,
            #[cfg(desktop)]
            crate::updates::install_update,
            #[cfg(any(desktop, target_os = "android"))]
            crate::storage::open::open_attachment,
            crate::storage::storage_request,
            crate::storage::storage_write,
            #[cfg(desktop)]
            crate::storage::file_sources,
            crate::storage::storage_read
        ])
        .build(context)
        .expect("Could not start Hummingbird")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(async {
                    app.state::<crate::p2p::ipc::P2pState>().stop().await;
                });
            }
        });
}
