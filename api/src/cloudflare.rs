use crate::{Config, protocol};
mod directory;
mod room;
mod route;
mod store;
pub use directory::NumberDirectory;
pub use room::DiscoveryRoom;
pub use route::PeerRoute;
use serde_json::json;
use std::net::IpAddr;
use worker::*;

fn config(env: &Env) -> Result<Config> {
    Config::from_values(|key| env.var(key).ok().map(|v| v.to_string())).map_err(Error::RustError)
}

#[event(fetch)]
pub async fn fetch(request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = request.url()?;
    let config = config(&env)?;
    let origin = request.headers().get("Origin")?;
    if origin.as_ref().is_some_and(|origin| {
        *origin != url.origin().ascii_serialization()
            && !config.cors_origins.contains(origin)
            && !crate::config::is_desktop_origin(origin)
    }) {
        return Response::error("Origin is not allowed", 403);
    }
    if request.method() == Method::Options {
        let mut response = Response::empty()?.with_status(204);
        if let Some(origin) = origin {
            response
                .headers_mut()
                .set("Access-Control-Allow-Origin", &origin)?;
            response.headers_mut().set("Vary", "Origin")?;
        }
        response
            .headers_mut()
            .set("Access-Control-Allow-Methods", "GET, OPTIONS")?;
        response.headers_mut().set(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type",
        )?;
        return Ok(response);
    }
    if request.method() != Method::Get {
        return Response::error("Method not allowed", 405);
    }
    if !matches!(
        url.path(),
        "/api/capabilities" | "/api/health" | "/api/health/details" | "/api/ws" | "/api/latest"
    ) {
        return Ok(Response::from_json(&json!({"error": "not_found"}))?.with_status(404));
    }
    let authorization = request.headers().get("Authorization")?;
    let authorized = crate::auth::authorized(&config.authorization, authorization.as_deref());
    if url.path() == "/api/ws" {
        if !request
            .headers()
            .get("Upgrade")?
            .is_some_and(|s| s.eq_ignore_ascii_case("websocket"))
        {
            return Response::error("Expected WebSocket", 426);
        }
        // Only the ingress-provided address is used, never X-Forwarded-For.
        if request
            .headers()
            .get("CF-Connecting-IP")?
            .and_then(|s| s.parse::<IpAddr>().ok())
            .is_none()
        {
            return Response::error("Client address is unavailable", 400);
        }
    }
    let mut response = if url.path() == "/api/latest" {
        crate::cloudflare_release::latest(&config.latest_json_url)
            .await
            .or_else(|_| Response::error("Release unavailable", 502))?
    } else if url.path() == "/api/health/details" && !authorized {
        Response::from_json(&json!({"error":"unauthorized"}))?.with_status(401)
    } else if matches!(url.path(), "/api/health" | "/api/capabilities") {
        Response::from_json(
            &json!({"ok": true, "service": "im-api", "version": crate::protocol::capabilities::RELEASE_VERSION, "capabilities": crate::protocol::capabilities::server_runtime(config.relay_enabled).capabilities}),
        )?
    } else {
        let (binding, key) = if url.path() == "/api/ws" {
            let Some(room) = crate::auth::room(url.query().unwrap_or_default()) else {
                return Response::error("Invalid room", 400);
            };
            let ip: IpAddr = request
                .headers()
                .get("CF-Connecting-IP")?
                .unwrap()
                .parse()
                .unwrap();
            ("ROOMS", format!("{room}@{}", ip.to_canonical()))
        } else if let Some((_, key)) = url.query_pairs().find(|(k, _)| k == "room") {
            let Some((room, ip)) = key.split_once('@') else {
                return Response::error("Invalid room key", 400);
            };
            let Ok(ip) = ip.parse::<IpAddr>() else {
                return Response::error("Invalid room key", 400);
            };
            if !protocol::valid_identifier(room) {
                return Response::error("Invalid room key", 400);
            }
            ("ROOMS", format!("{room}@{}", ip.to_canonical()))
        } else {
            ("ROUTES", "@health".into())
        };
        env.durable_object(binding)?
            .get_by_name(&key)?
            .fetch_with_request(request)
            .await?
    };
    if url.path() == "/api/health/details" && response.status_code() == 200 {
        let mut detail: serde_json::Value = response.json().await?;
        let runtime = protocol::capabilities::server_runtime(config.relay_enabled);
        detail["service"] = "im-api".into();
        detail["version"] = runtime.version.into();
        detail["capabilities"] = json!(runtime.capabilities);
        if detail["scope"] == "global" {
            let thresholds = [
                ("connections", config.max_connections),
                ("rooms", config.max_rooms),
            ];
            let mut warnings = Vec::new();
            for (field, limit) in thresholds {
                if detail[field]
                    .as_u64()
                    .is_some_and(|count| count >= limit as u64)
                {
                    warnings.push(field);
                }
            }
            detail["warningThresholds"] =
                json!({"connections":config.max_connections,"rooms":config.max_rooms});
            detail["warnings"] = json!(warnings);
        }
        response = Response::from_json(&detail)?;
    }
    if response.status_code() != 101 {
        // A DO fetch returns immutable headers; copy before adding CORS/cache headers.
        let headers = Headers::from_iter(response.headers());
        response = response.with_headers(headers);
        response
            .headers_mut()
            .set("X-Content-Type-Options", "nosniff")?;
        if url.path() != "/api/latest" || response.status_code() != 200 {
            response.headers_mut().set("Cache-Control", "no-store")?;
        }
        if let Some(origin) = origin {
            response
                .headers_mut()
                .set("Access-Control-Allow-Origin", &origin)?;
            response.headers_mut().set("Vary", "Origin")?;
        }
    }
    Ok(response)
}
