//! Isolated release WebView using the real IPC/storage commands. Never loads user data.
use tauri::{
    Manager, WebviewUrl, WebviewWindowBuilder,
    utils::config::{AppDirectoriesOverride, FrontendDist},
};

fn main() {
    let url: tauri::Url = std::env::var("TRANSFER_BENCH_URL")
        .expect("TRANSFER_BENCH_URL")
        .parse()
        .unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.scheme(), "http");
    let directory = std::path::PathBuf::from(
        std::env::var("TRANSFER_BENCH_DATA").expect("TRANSFER_BENCH_DATA"),
    );
    assert!(directory.is_absolute());
    std::fs::create_dir_all(&directory).unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "team.kuangye.im.transfer-benchmark".into();
    context.config_mut().app.windows.clear();
    // This example's own frontend origin; production app configuration is untouched.
    let origin: tauri::Url = url.origin().ascii_serialization().parse().unwrap();
    context.config_mut().build.dev_url = Some(origin.clone());
    context.config_mut().build.frontend_dist = Some(FrontendDist::Url(origin));
    context.config_mut().app.app_directories_override =
        Some(AppDirectoriesOverride::Root(directory.clone()));
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .manage(hummingbird::p2p::ipc::P2pState::default())
        .manage(hummingbird::storage::StorageState::default())
        .invoke_handler(tauri::generate_handler![
            hummingbird::p2p::ipc::p2p_request,
            hummingbird::p2p::ipc::p2p_write,
            hummingbird::storage::storage_request,
            hummingbird::storage::storage_write,
            hummingbird::storage::storage_read,
            hummingbird::storage::file_sources,
        ])
        .setup(move |app| {
            if let Some(path) = std::env::var_os("TRANSFER_BENCH_FILE") {
                use tauri_plugin_fs::FsExt;
                app.fs_scope().allow_file(std::path::PathBuf::from(path))?;
            }
            app.add_capability(
                serde_json::json!({
                    "identifier": "benchmark-local", "windows": ["benchmark"],
                    "permissions": ["core:default"]
                })
                .to_string(),
            )?;
            WebviewWindowBuilder::new(app, "benchmark", WebviewUrl::External(url))
                .title("文件传输测试")
                .inner_size(880.0, 560.0)
                .data_directory(directory.join("webview"))
                .build()?;
            Ok(())
        })
        .run(context)
        .expect("Could not start benchmark WebView");
}
