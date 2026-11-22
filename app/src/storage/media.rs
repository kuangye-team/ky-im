//! The WebView requests media bytes by attachment ID. It never supplies a filesystem path.
use super::{Attachment, Result, StorageState, Store};
use tauri::{
    Manager, UriSchemeContext, UriSchemeResponder, Wry,
    http::{Method, Request, Response, StatusCode, header},
};

const BLOCK: u64 = 2 * 1024 * 1024;

fn media_mime(file: &Attachment) -> Option<String> {
    let declared = file.mime.split(';').next()?.trim().to_ascii_lowercase();
    let guessed = mime_guess::from_path(&file.name).first_raw().unwrap_or("");
    [declared.as_str(), guessed]
        .into_iter()
        .find(|value| value.starts_with("audio/") || value.starts_with("video/"))
        .map(str::to_owned)
}

pub fn serve(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let state = ctx.app_handle().state::<StorageState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let response = state
            .with_store(move |store| response(store, &request))
            .await
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap()
            });
        responder.respond(response);
    });
}

pub(super) fn response(store: &Store, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>> {
    let key = request.uri().path().trim_start_matches('/');
    let file = store
        .attachment(key)?
        .filter(|a| !a.folder)
        .ok_or("无法读取附件")?;
    let mime = media_mime(&file).ok_or("无法预览这个文件")?;
    let mut reply = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if request.method() == Method::HEAD {
        return Ok(reply
            .header(header::CONTENT_LENGTH, file.size)
            .body(Vec::new())?);
    }
    if request.method() != Method::GET {
        return Ok(reply
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .body(Vec::new())?);
    }
    let mut start = 0;
    let mut length = file.size.min(BLOCK);
    let range = request.headers().get(header::RANGE);
    if let Some(range) = range {
        let valid = range
            .to_str()
            .ok()
            .and_then(|s| http_range_header::parse_range_header(s).ok())
            .filter(|_| file.size > 0)
            .and_then(|r| r.validate(file.size).ok());
        let Some([range]) = valid.as_deref() else {
            return Ok(reply
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{}", file.size))
                .body(Vec::new())?);
        };
        start = *range.start();
        length = (range.end() - start + 1).min(BLOCK);
    }
    if range.is_some() || length < file.size {
        reply = reply.status(StatusCode::PARTIAL_CONTENT).header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{}", start + length - 1, file.size),
        );
    }
    Ok(reply
        .header(header::CONTENT_LENGTH, length)
        .body(store.read(key, start, length as usize)?)?)
}
