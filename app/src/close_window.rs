use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

#[derive(Default)]
pub struct ClosePrompt {
    open: AtomicBool,
    english: AtomicBool,
}

#[tauri::command]
pub fn set_window_language(state: State<'_, ClosePrompt>, language: String) {
    state.english.store(language == "en", Ordering::Relaxed);
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }
    api.prevent_close();
    let prompt = window.state::<ClosePrompt>();
    if prompt.open.swap(true, Ordering::AcqRel) {
        return;
    }
    let (title, message, hide, quit, cancel) = if prompt.english.load(Ordering::Relaxed) {
        (
            "Close this window?",
            "Hide the window to keep Hummingbird running in the background. Open the app again to return. Quitting will interrupt any unfinished transfers.",
            "Hide Window",
            "Quit App",
            "Cancel",
        )
    } else {
        (
            "关闭窗口？",
            "隐藏后，蜂鸟会继续在后台运行。再次打开应用即可回到这里。退出应用会中断未完成的传输。",
            "隐藏窗口",
            "退出应用",
            "取消操作",
        )
    };
    let dialog = window.dialog().message(message).title(title).parent(window);
    let window = window.clone();
    dialog
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            hide.into(),
            quit.into(),
            cancel.into(),
        ))
        .show_with_result(move |result| {
            match result {
                MessageDialogResult::Custom(label) if label == hide => {
                    if let Err(error) = window.hide() {
                        eprintln!("Could not hide the main window: {error}");
                    }
                }
                MessageDialogResult::Custom(label) if label == quit => window.app_handle().exit(0),
                _ => {}
            }
            window
                .state::<ClosePrompt>()
                .open
                .store(false, Ordering::Release);
        });
}
