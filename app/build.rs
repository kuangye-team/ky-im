#[path = "../shared/release-build.rs"]
mod release;
fn main() {
    release::release_version();
    tauri_build::build();
}
