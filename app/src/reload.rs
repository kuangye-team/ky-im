//! WebView reloads (including its native context menu) bypass DOM beforeunload on macOS.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State, WebviewWindow, plugin::TauriPlugin, webview::PageLoadEvent};

#[derive(Default)]
pub struct ReloadGuard {
    ready: AtomicBool,
    approved: AtomicBool,
}

impl ReloadGuard {
    fn allow_navigation(&self) -> bool {
        self.approved.swap(false, Ordering::SeqCst) || !self.ready.load(Ordering::SeqCst)
    }
}

#[tauri::command]
pub fn set_reload_guard(state: State<'_, ReloadGuard>, ready: bool) {
    state.ready.store(ready, Ordering::SeqCst);
}

#[tauri::command]
pub fn reload_app(window: WebviewWindow, state: State<'_, ReloadGuard>) -> Result<(), String> {
    state.approved.store(true, Ordering::SeqCst);
    if let Err(error) = window.reload() {
        state.approved.store(false, Ordering::SeqCst);
        return Err(error.to_string());
    }
    Ok(())
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("reload-guard")
        .setup(|app, _| {
            app.manage(ReloadGuard::default());
            Ok(())
        })
        .on_navigation(|webview, _| {
            if webview.label() != "main" || webview.state::<ReloadGuard>().allow_navigation() {
                return true;
            }
            // The renderer decides using the latest transfer state. Cancellation keeps
            // the existing document and its live connections intact.
            let _ = webview.eval("window.dispatchEvent(new Event('hummingbird:reload-request'))");
            false
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Started) {
                webview
                    .state::<crate::storage::StorageState>()
                    .renderer_reloaded();
                // A failed bootstrap must still be reloadable. React re-arms after mounting.
                webview
                    .state::<ReloadGuard>()
                    .ready
                    .store(false, Ordering::SeqCst);
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_load_is_allowed_and_approval_only_allows_one_navigation() {
        let guard = ReloadGuard::default();
        assert!(guard.allow_navigation());
        guard.ready.store(true, Ordering::SeqCst);
        assert!(!guard.allow_navigation());
        assert!(!guard.allow_navigation()); // Cancelling never grants approval.
        guard.approved.store(true, Ordering::SeqCst);
        assert!(guard.allow_navigation());
        assert!(!guard.allow_navigation());
    }
}
