#[cfg(target_os = "android")]
mod android;
mod startup;
pub use startup::run;
pub mod ipc;
pub mod reload;
pub mod storage;
#[cfg(desktop)]
pub mod updates;
#[cfg(desktop)]
pub mod window_theme;

pub mod p2p;

#[path = "../../shared/capabilities.rs"]
pub mod capabilities;
