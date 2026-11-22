#[path = "../shared/release-build.rs"]
mod release;
fn main() {
    release::release_version();
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "apk-update",
        tauri_build::InlinedPlugin::new().commands(&["download", "choose_installer"]),
    ))
    .expect("failed to build the app");
}
