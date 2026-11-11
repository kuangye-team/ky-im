use crate::client_release::{self, CACHE_SECONDS, MAX_BYTES};
use axum::{
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

type Cache = HashMap<String, (Instant, Vec<u8>)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

pub async fn latest(State(state): State<Arc<crate::AppState>>) -> Response {
    let url = &state.config.latest_json_url;
    // Bound memory and serialize cache misses so hover bursts share an upstream request.
    let mut cache = CACHE.get_or_init(Default::default).lock().await;
    cache.retain(|_, (time, _)| time.elapsed().as_secs() < CACHE_SECONDS);
    if let Some((_, bytes)) = cache.get(url.as_str()) {
        return response(bytes.clone());
    }
    match fetch(url.clone()).await {
        Some(bytes) => {
            if cache.len() >= 16 {
                cache.clear();
            }
            cache.insert(url.to_string(), (Instant::now(), bytes.clone()));
            response(bytes)
        }
        None => (
            StatusCode::BAD_GATEWAY,
            [(header::CACHE_CONTROL, "no-store")],
            "Release unavailable",
        )
            .into_response(),
    }
}

fn response(bytes: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "public, max-age=300"),
        ],
        bytes,
    )
        .into_response()
}

async fn fetch(url: url::Url) -> Option<Vec<u8>> {
    // Use the same lightweight TLS provider as the desktop app.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let upstream_url = url.clone();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Ky-IM-release-manifest")
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() < 4
                && client_release::allowed_redirect(&upstream_url, attempt.url())
            {
                attempt.follow()
            } else {
                attempt.error("Invalid release redirect")
            }
        }))
        .build()
        .ok()?;
    let mut upstream = client.get(url).send().await.ok()?.error_for_status().ok()?;
    if upstream
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = upstream.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    client_release::valid_manifest(&bytes).then_some(bytes)
}
