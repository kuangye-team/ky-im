use super::*;

#[tauri::command]
pub async fn open_attachment(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    id: String,
    choose: bool,
) -> std::result::Result<(), String> {
    state.locate(&app)?;
    let target = state
        .with_store(move |store| {
            let file = store
                .attachment(&id)?
                .filter(|a| !a.folder)
                .ok_or("附件尚未接收完成或已被清除")?;
            #[cfg(target_os = "android")]
            {
                let uri = store.android_attachment(&file)?;
                let guessed = mime_guess::from_path(&file.name).first_or_octet_stream();
                let mime = if file.mime.is_empty() || file.mime == "application/octet-stream" {
                    guessed.as_ref()
                } else {
                    &file.mime
                };
                Ok(json!({ "uri": uri.uri, "mime": mime, "choose": choose }))
            }
            #[cfg(not(target_os = "android"))]
            {
                let path = store.root.join(relative(&file.path)?);
                no_links(&path)?;
                if !path.is_file() {
                    return Err("附件尚未接收完成或已被清除".into());
                }
                // Windows shell handlers may reject the verbatim prefix from canonicalize().
                #[cfg(windows)]
                let path = dunce::simplified(&path).to_owned();
                Ok(path)
            }
        })
        .await?;
    #[cfg(target_os = "android")]
    {
        app.state::<crate::android::AttachmentPlugin>()
            .0
            .run_mobile_plugin_async("open", target)
            .await
            .map_err(|_| "无法打开文件，请检查是否已安装合适的应用".to_owned())
    }
    #[cfg(desktop)]
    {
        if choose {
            choose_app(app, target).await
        } else {
            tokio::task::spawn_blocking(move || {
                tauri_plugin_opener::open_path(target, None::<&str>)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
        }
        .map_err(|_| "无法打开文件，请检查是否已安装合适的应用".to_owned())
    }
}

#[cfg(target_os = "macos")]
async fn choose_app(app: tauri::AppHandle, path: PathBuf) -> std::result::Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    tokio::task::spawn_blocking(move || {
        let choice = app
            .dialog()
            .file()
            .set_directory("/Applications")
            .add_filter("Applications", &["app"])
            .blocking_pick_file();
        if let Some(choice) = choice {
            let application = choice.into_path().map_err(|e| e.to_string())?;
            let status = std::process::Command::new("/usr/bin/open")
                .arg("-a")
                .arg(application)
                .arg(path)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("无法打开文件".to_owned());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
async fn choose_app(app: tauri::AppHandle, path: PathBuf) -> std::result::Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{
            Foundation::ERROR_CANCELLED,
            UI::Shell::{OAIF_EXEC, OPENASINFO, SHOpenWithDialog},
        },
        core::{HRESULT, PCWSTR},
    };
    let (done, result) = tokio::sync::oneshot::channel();
    let window = app.get_webview_window("main").ok_or("无法打开窗口")?;
    app.run_on_main_thread(move || {
        let path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let info = OPENASINFO {
            pcszFile: PCWSTR(path.as_ptr()),
            oaifInFlags: OAIF_EXEC,
            ..Default::default()
        };
        let result = unsafe { SHOpenWithDialog(window.hwnd().ok(), &info) };
        let _ = done.send(match result {
            Err(e) if e.code() != HRESULT::from_win32(ERROR_CANCELLED.0) => Err(e.to_string()),
            _ => Ok(()),
        });
    })
    .map_err(|e| e.to_string())?;
    result.await.map_err(|e| e.to_string())?
}

#[cfg(target_os = "linux")]
async fn choose_app(app: tauri::AppHandle, path: PathBuf) -> std::result::Result<(), String> {
    use gtk::{gio, prelude::*};
    let (done, result) = tokio::sync::oneshot::channel();
    let window = app.get_webview_window("main").ok_or("无法打开窗口")?;
    app.run_on_main_thread(move || {
        let file = gio::File::for_path(path);
        let parent = window.gtk_window().ok();
        let dialog = gtk::AppChooserDialog::new(parent.as_ref(), gtk::DialogFlags::MODAL, &file);
        let result = if dialog.run() == gtk::ResponseType::Ok {
            dialog
                .app_info()
                .ok_or_else(|| "请选择应用".to_owned())
                .and_then(|info| {
                    info.launch(&[file], None::<&gio::AppLaunchContext>)
                        .map_err(|e| e.to_string())
                })
        } else {
            Ok(())
        };
        dialog.close();
        let _ = done.send(result);
    })
    .map_err(|e| e.to_string())?;
    result.await.map_err(|e| e.to_string())?
}
