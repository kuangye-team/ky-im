mod client_release;
mod auth;
#[cfg(not(target_arch = "wasm32"))]
mod native_release;
#[cfg(target_arch = "wasm32")]
mod cloudflare_release;
mod config;
mod engine;
mod hub;
pub mod protocol;

pub use config::Config;
pub use engine::AppState;

#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(not(target_arch = "wasm32"))]
pub use native::router;

#[cfg(target_arch = "wasm32")]
mod cloudflare;
#[cfg(target_arch = "wasm32")]
pub use cloudflare::*;
