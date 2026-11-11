use crate::client_release::{self, CACHE_SECONDS, MAX_BYTES};
use futures_util::StreamExt;
use worker::*;

pub async fn latest(source: &url::Url) -> Result<Response> {
    let mut url = source.clone();
    let cache = Cache::default();
    let cache_key = url.to_string();
    if let Some(response) = cache.get(cache_key.clone(), false).await? {
        return Ok(response);
    }
    let signal = AbortSignal::from(web_sys::AbortSignal::timeout_with_u32(10_000));
    for _ in 0..4 {
        let mut init = RequestInit::new();
        init.with_redirect(RequestRedirect::Manual);
        let request = Request::new_with_init(url.as_str(), &init)?;
        let mut upstream = Fetch::Request(request).send_with_signal(&signal).await?;
        if (300..400).contains(&upstream.status_code()) {
            let Some(location) = upstream.headers().get("Location")? else {
                break;
            };
            let Ok(next) = url.join(&location) else {
                break;
            };
            if !client_release::allowed_redirect(source, &next) {
                break;
            }
            url = next;
            continue;
        }
        if upstream.status_code() != 200
            || upstream
                .headers()
                .get("Content-Length")?
                .and_then(|value| value.parse::<usize>().ok())
                .is_some_and(|size| size > MAX_BYTES)
        {
            break;
        }
        let mut bytes = Vec::new();
        let mut stream = upstream.stream()?;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Response::error("Release unavailable", 502);
            }
            bytes.extend_from_slice(&chunk);
        }
        if !client_release::valid_manifest(&bytes) {
            break;
        }
        let mut response = Response::from_bytes(bytes)?;
        response
            .headers_mut()
            .set("Content-Type", "application/json")?;
        response
            .headers_mut()
            .set("Cache-Control", &format!("public, max-age={CACHE_SECONDS}"))?;
        cache.put(cache_key, response.cloned()?).await?;
        return Ok(response);
    }
    Response::error("Release unavailable", 502)
}
