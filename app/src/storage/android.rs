//! Android documents are provider handles, including on removable and cloud storage.
use super::*;
use tauri_plugin_android_fs::api::api_sync::AndroidFs;
use tauri_plugin_android_fs::{AndroidFsExt, FsUri, PublicGeneralPurposeDir, UriPermission};

type Documents = AndroidFs<tauri::Wry>;
const RESELECT: &str = "无法使用这个文件夹，请重新选择保存位置";

fn content(uri: &FsUri) -> Result<()> {
    if !uri.is_content_scheme()
        || uri
            .document_top_tree_uri
            .as_ref()
            .is_some_and(|top| !top.starts_with("content://"))
    {
        return Err(RESELECT.into());
    }
    Ok(())
}

pub(crate) fn seekable(app: &tauri::AppHandle, uri: &FsUri, size: u64) -> Result<File> {
    readable(app, uri)?;
    let mut file = app.android_fs().open_file_readable(uri)?;
    if file.stream_position().is_ok() && file.metadata()?.len() == size {
        return Ok(file);
    }
    // A cloud provider can return a pipe. An unlinked private file supports native resume
    // offsets and is reclaimed even if the process dies.
    let dir = app.path().app_cache_dir()?;
    fs::create_dir_all(&dir)?;
    check_capacity(&dir, size)?;
    let mut temp = tempfile::tempfile_in(dir)?;
    if std::io::copy(&mut file.take(size.saturating_add(1)), &mut temp)? != size {
        return Err("文件内容已变化，请重新选择".into());
    }
    temp.rewind()?;
    Ok(temp)
}

pub(super) fn check_capacity(path: &Path, size: u64) -> Result<()> {
    if fs2::available_space(path)? < size {
        return Err("手机存储空间不足，请清理后重试".into());
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> std::result::Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn android_pick_folder(
    app: tauri::AppHandle,
) -> std::result::Result<Option<Value>, String> {
    blocking(move || {
        let api = app.android_fs();
        let Some(uri) = api.picker().pick_dir(None, false)? else {
            return Ok(None);
        };
        Ok(Some(json!({"name": api.get_name(&uri)?, "uri": uri})))
    })
    .await
}

#[tauri::command]
pub async fn android_children(
    app: tauri::AppHandle,
    uri: FsUri,
    offset: u64,
) -> std::result::Result<Vec<Value>, String> {
    blocking(move || {
        readable(&app, &uri)?;
        let entries = app
            .android_fs()
            .read_dir_with_range(&uri, offset..offset.checked_add(128).ok_or("目录过大")?)?;
        Ok(entries
            .into_iter()
            .map(|e| {
                json!({"name":e.name(),"uri":e.uri(),"directory":e.is_dir(),
            "size":e.file_len(),"type":e.file_mime_type()})
            })
            .collect())
    })
    .await
}

fn readable(app: &tauri::AppHandle, uri: &FsUri) -> Result<()> {
    content(uri)?;
    // Check the actual document, even when a renderer also supplies a tree URI.
    let actual = FsUri::from_uri(uri.uri.clone());
    if !app
        .android_fs()
        .picker()
        .check_uri_permission(&actual, UriPermission::Read)?
    {
        return Err("文件无法读取，请重新选择".into());
    }
    Ok(())
}

pub(super) fn read_range(
    app: &tauri::AppHandle,
    uri: &FsUri,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>> {
    readable(app, uri)?;
    if length > MAX_BLOCK {
        return Err("读取块过大".into());
    }
    let mut file = app.android_fs().open_file_readable(uri)?;
    if offset != 0
        && file.seek(SeekFrom::Start(offset)).is_err()
        && std::io::copy(&mut (&mut file).take(offset), &mut std::io::sink())? != offset
    {
        return Err("文件无法读取，请重新选择".into());
    }
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

#[tauri::command]
pub async fn android_read(
    app: tauri::AppHandle,
    uri: FsUri,
    offset: u64,
    length: usize,
) -> std::result::Result<tauri::ipc::Response, String> {
    blocking(move || {
        let bytes = read_range(&app, &uri, offset, length)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

fn pick_save_folder(api: &Documents, initial: Option<FsUri>) -> Result<Option<FsUri>> {
    let initial = match initial {
        Some(uri) => uri,
        None => {
            // On Android 7–9 the user may decline shared storage and still use the picker.
            let can_create = api.public_storage().request_permission()?;
            api.picker().resolve_public_storage_initial_location(
                None,
                PublicGeneralPurposeDir::Download,
                "KyIM",
                can_create,
            )?
        }
    };
    Ok(api.picker().pick_dir(Some(&initial), false)?)
}

async fn pick_export_folder(
    app: &tauri::AppHandle,
    state: &StorageState,
) -> std::result::Result<Option<FsUri>, String> {
    state.locate(app)?;
    let initial = state
        .with_store(|s| {
            let last = s
                .values(
                    "SELECT value FROM settings WHERE key='androidExportFolder'",
                    [],
                )?
                .pop();
            match last {
                Some(value) => Ok(Some(serde_json::from_value(value)?)),
                None => Ok(s.save_tree()?.map(|(_, uri)| uri)),
            }
        })
        .await?;
    let app = app.clone();
    let Some(folder) = blocking(move || pick_save_folder(app.android_fs(), initial)).await? else {
        return Ok(None);
    };
    // A picker starting location needs no persistent access to the folder's contents.
    state
        .with_store(move |s| {
            s.db.execute(
                "INSERT OR REPLACE INTO settings VALUES('androidExportFolder', ?)",
                [serde_json::to_string(&folder)?],
            )?;
            Ok(Some(folder))
        })
        .await
}

#[tauri::command]
pub async fn android_save_location(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
) -> std::result::Result<Option<String>, String> {
    state.locate(&app)?;
    let initial = state
        .with_store(|s| Ok(s.save_tree()?.map(|(_, uri)| uri)))
        .await?;
    let selection = blocking(move || {
        let api = app.android_fs();
        let Some(uri) = pick_save_folder(api, initial)? else {
            return Ok(None);
        };
        api.picker().persist_uri_permission(&uri)?;
        require_tree(api, &uri)?;
        Ok(Some((api.get_name(&uri)?, uri)))
    })
    .await?;
    let Some((name, uri)) = selection else {
        return Ok(None);
    };
    state
        .with_store(move |s| {
            s.db.execute(
                "INSERT OR REPLACE INTO settings VALUES('androidSaveTree', ?), ('androidExportFolder', ?)",
                params![serde_json::to_string(&json!({"name":name,"uri":uri}))?, serde_json::to_string(&uri)?],
            )?;
            s.cached_usage = None;
            Ok(Some(name))
        })
        .await
}

pub(super) fn require_tree(api: &Documents, uri: &FsUri) -> Result<()> {
    content(uri)?;
    if !api
        .picker()
        .check_persisted_uri_permission(uri, UriPermission::ReadAndWrite)
        .unwrap_or(false)
        || !api.get_type(uri).is_ok_and(|t| t.is_dir())
    {
        return Err(RESELECT.into());
    }
    Ok(())
}

impl Store {
    pub(super) fn app(&self) -> Result<&tauri::AppHandle> {
        self.app.as_ref().ok_or_else(|| "存储尚未准备好".into())
    }
    pub(super) fn save_tree(&self) -> Result<Option<(String, FsUri)>> {
        self.values("SELECT value FROM settings WHERE key='androidSaveTree'", [])?
            .pop()
            .map(|v| {
                Ok((
                    string(&v, "name")?.to_owned(),
                    serde_json::from_value(v["uri"].clone())?,
                ))
            })
            .transpose()
    }
    pub(super) fn android_attachment(&self, attachment: &Attachment) -> Result<FsUri> {
        if let Some(uri) = &attachment.document {
            return Ok(uri.clone());
        }
        let path = self.root.join(relative(&attachment.path)?);
        no_links(&path)?;
        Ok(FsUri::from_path(path))
    }
}

fn copy_document(
    api: &Documents,
    src: &FsUri,
    parent: &FsUri,
    name: &str,
    nested: bool,
    depth: usize,
) -> Result<FsUri> {
    if depth > 128 || relative(name)?.components().count() != 1 {
        return Err("文件夹目录无法读取".into());
    }
    let meta = api.get_metadata(src)?;
    let dir = meta.is_dir();
    // The provider may append a suffix to the root. Child names must round-trip exactly.
    let dest = if dir {
        api.create_new_dir(parent, name)?
    } else {
        api.create_new_file(parent, name, meta.file_mime_type())?
    };
    let result = (|| -> Result<()> {
        if nested && api.get_name(&dest)? != name {
            return Err("保存位置不能保留原文件名，请选择其他文件夹".into());
        }
        if dir {
            for item in api.read_dir(src)? {
                copy_document(api, item.uri(), &dest, item.name(), true, depth + 1)?;
            }
        } else {
            let mut input = api.open_file_readable(src)?;
            let mut output = api.open_file_writable(&dest)?;
            let written = std::io::copy(&mut input, &mut output)?;
            output.flush()?;
            drop(output);
            if Some(written) != meta.file_len() || api.get_len(&dest)? != written {
                return Err("文件未能完整保存".into());
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        remove_created(api, &dest, dir);
        return Err(error);
    }
    Ok(dest)
}

pub(super) fn remove_created(api: &Documents, dest: &FsUri, dir: bool) {
    let _ = if dir {
        api.remove_dir_all(dest)
    } else {
        api.remove_file(dest)
    };
}

pub(super) fn copy_from_path(
    app: &tauri::AppHandle,
    src: &Path,
    parent: &FsUri,
    name: &str,
) -> Result<FsUri> {
    no_links(src)?;
    copy_document(
        app.android_fs(),
        &FsUri::from_path(src),
        parent,
        name,
        false,
        0,
    )
}

#[tauri::command]
pub async fn android_export(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    id: String,
) -> std::result::Result<(), String> {
    let Some(parent) = pick_export_folder(&app, &state).await? else {
        return Ok(());
    };
    state
        .with_store(move |s| {
            let a = s.attachment(&id)?.ok_or("附件已被清除")?;
            copy_document(
                app.android_fs(),
                &s.android_attachment(&a)?,
                &parent,
                &a.name,
                false,
                0,
            )?;
            Ok(())
        })
        .await
}

#[tauri::command]
pub async fn android_export_writer(
    app: tauri::AppHandle,
    state: State<'_, StorageState>,
    id: String,
    size: u64,
    name: String,
) -> std::result::Result<Option<String>, String> {
    let Some(parent) = pick_export_folder(&app, &state).await? else {
        return Ok(None);
    };
    state
        .with_store(move |store| {
            super::id(&id)?;
            check_capacity(&store.root, size)?;
            let temp = tempfile::NamedTempFile::new_in(store.root.join(CACHE))?;
            let token = store.begin_external(
                id,
                size,
                temp,
                ExternalTarget::Document(parent, safe_name(&name)),
            )?;
            Ok(Some(token))
        })
        .await
}

#[tauri::command]
pub async fn android_pick_files(
    app: tauri::AppHandle,
    images: bool,
) -> std::result::Result<Vec<Value>, String> {
    blocking(move || {
        let api = app.android_fs();
        let uris = api.picker().pick_files(None, &[if images { "image/*" } else { "*/*" }], false)?;
        uris.into_iter().map(|uri| {
            let entry = api.get_metadata(&uri)?;
            Ok(json!({"uri":uri,"name":entry.name(),"size":entry.file_len_or_err()?,"type":entry.file_mime_type_or_err()?}))
        }).collect()
    }).await
}
