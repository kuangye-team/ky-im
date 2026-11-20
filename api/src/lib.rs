mod client_release;
mod auth;
#[cfg(not(target_arch = "wasm32"))]
mod native_release;
#[cfg(target_arch = "wasm32")]
mod cloudflare_release;
mod config;
#[cfg(not(target_arch = "wasm32"))]
mod engine;
#[cfg(not(target_arch = "wasm32"))]
mod hub;
mod relay;
pub mod protocol;

pub use config::Config;
#[cfg(not(target_arch = "wasm32"))]
pub use engine::AppState;

#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(not(target_arch = "wasm32"))]
pub use native::router;

#[cfg(target_arch = "wasm32")]
mod cloudflare;
#[cfg(target_arch = "wasm32")]
pub use cloudflare::*;
