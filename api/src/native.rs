use crate::{AppState, Config, engine::process_message, hub, protocol};
use axum::{
    Json, Router,
    extract::{
        ConnectInfo, RawQuery, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use hub::{CloseReason, Identity, QUEUE_CAPACITY, Transport};
use protocol::{ClientMessage, MAX_MESSAGE_BYTES, ServerMessage};
use serde_json::{Map, Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    time::{Instant, MissedTickBehavior},
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

pub fn router(state: Arc<AppState>) -> Result<Router, String> {
    let static_files = ServeDir::new(&state.config.static_dir)
        .fallback(ServeFile::new(state.config.static_dir.join("index.html")));
    let origins = state
        .config
        .cors_origins
        .iter()
        .map(|origin| {
            origin
                .parse::<HeaderValue>()
                .map_err(|_| "Invalid CORS_ORIGINS value".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let app = Router::new()
        .route("/api/latest", get(crate::native_release::latest))
        .route("/api/health", get(health))
        .route("/api/health/details", get(health_details))
        .route("/api/ws", any(websocket))
        .route("/api/ws/ticket", get(websocket_ticket))
        .route("/api/{*path}", any(api_not_found))
        .route("/api", any(api_not_found))
        .fallback_service(static_files)
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .with_state(state);
    let app = app.layer(
        CorsLayer::new()
            .allow_origin(AllowOrigin::predicate(move |origin, _| {
                origins.contains(origin)
                    || origin.to_str().is_ok_and(crate::config::is_desktop_origin)
            }))
            .allow_methods([Method::GET])
            .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]),
    );
    Ok(app)
}

async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "service": "im-api",
        "relay": state.config.relay_enabled,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn health_details(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !crate::auth::authorized(
        &state.config.authorization,
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
    ) {
        return unauthorized();
    }
    let hub = state.hub.lock().expect("hub lock poisoned");
    Json(json!({
        "ok": true,
        "service": "im-api",
        "relay": state.config.relay_enabled,
        "version": env!("CARGO_PKG_VERSION"),
        "rooms": hub.rooms.len(),
        "peers": hub.rooms.values().map(|peers| peers.len()).sum::<usize>(),
        "headers": headers_json(&headers),
    }))
    .into_response()
}

fn headers_json(headers: &HeaderMap) -> Value {
    let mut result = Map::new();
    for name in headers.keys() {
        if crate::auth::sensitive_header(name.as_str()) {
            continue;
        }
        let values = headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .map(|value| Value::String(value.to_owned()))
            .collect::<Vec<_>>();
        result.insert(name.as_str().to_owned(), Value::Array(values));
    }
    Value::Object(result)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"error": "unauthorized"})),
    )
        .into_response()
}

async fn websocket_ticket(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !crate::auth::authorized(
        &state.config.authorization,
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
    ) {
        return unauthorized();
    }
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"ticket": crate::auth::ticket(&state.config.authorization, hub::now_ms())})),
    )
        .into_response()
}

async fn api_not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({"error": "not_found"})))
}

async fn websocket(
    State(state): State<Arc<AppState>>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&state.config, &headers) {
        return (StatusCode::FORBIDDEN, "WebSocket origin is not allowed").into_response();
    }
    if !crate::auth::websocket_authorized(
        &state.config.authorization,
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        query.as_deref().unwrap_or_default(),
        hub::now_ms(),
    ) {
        return unauthorized();
    }
    let Ok(permit) = Arc::clone(&state.connections).try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Connection limit reached").into_response();
    };
    let source_ip = source_ip(&state.config, address.ip(), &headers);
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .read_buffer_size(16 * 1024)
        .write_buffer_size(16 * 1024)
        // A welcome can include every allowed profile, larger than an inbound signal.
        // 16 KiB covers even maximum-length fields escaped as JSON control characters.
        .max_write_buffer_size(MAX_MESSAGE_BYTES + state.config.max_connections * 16 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, state, source_ip).await;
        })
}

fn source_ip(config: &Config, peer_ip: IpAddr, headers: &HeaderMap) -> IpAddr {
    if !config.trust_proxy_headers {
        return peer_ip.to_canonical();
    }
    forwarded_ip(headers).unwrap_or(peer_ip).to_canonical()
}

fn forwarded_ip(headers: &HeaderMap) -> Option<IpAddr> {
    headers
        .get("Forwarded")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_forwarded)
        .or_else(|| {
            headers
                .get("X-Forwarded-For")
                .and_then(|value| value.to_str().ok())
                .and_then(parse_x_forwarded_for)
        })
        .or_else(|| single_ip_header(headers, "CF-Connecting-IP"))
        .or_else(|| single_ip_header(headers, "True-Client-IP"))
        .or_else(|| single_ip_header(headers, "Fly-Client-IP"))
        .or_else(|| single_ip_header(headers, "Fastly-Client-IP"))
        .or_else(|| single_ip_header(headers, "X-Real-IP"))
}

fn single_ip_header(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<IpAddr>().ok())
}

fn parse_x_forwarded_for(value: &str) -> Option<IpAddr> {
    value
        .split(',')
        .map(str::trim)
        .find_map(|entry| entry.parse::<IpAddr>().ok())
}

fn parse_forwarded(value: &str) -> Option<IpAddr> {
    value.split(',').find_map(|entry| {
        entry.split(';').find_map(|pair| {
            let (name, raw) = pair.split_once('=')?;
            if !name.trim().eq_ignore_ascii_case("for") {
                return None;
            }
            parse_forwarded_for_value(raw.trim())
        })
    })
}

fn parse_forwarded_for_value(value: &str) -> Option<IpAddr> {
    let value = value.trim().trim_matches('"');
    if value.eq_ignore_ascii_case("unknown") || value.starts_with('_') {
        return None;
    }
    if let Some(bracketed) = value.strip_prefix('[') {
        let host = bracketed.split_once(']')?.0;
        return host.parse::<IpAddr>().ok();
    }
    value
        .parse::<IpAddr>()
        .ok()
        .or_else(|| value.rsplit_once(':')?.0.parse::<IpAddr>().ok())
}

fn origin_allowed(config: &Config, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if crate::config::is_desktop_origin(origin)
        || config.cors_origins.iter().any(|allowed| allowed == origin)
    {
        return true;
    }
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
    else {
        return false;
    };
    [format!("http://{host}"), format!("https://{host}")].contains(&origin.to_owned())
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(5), socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn send_json(socket: &mut WebSocket, message: ServerMessage) -> bool {
    // All server messages contain only JSON-serializable data and strings.
    send(
        socket,
        Message::Text(
            serde_json::to_string(&message)
                .expect("serialize protocol message")
                .into(),
        ),
    )
    .await
}

async fn session(mut socket: WebSocket, state: Arc<AppState>, source_ip: IpAddr) {
    let (outgoing, mut messages) = mpsc::channel(QUEUE_CAPACITY);
    let (close, mut close_rx) = watch::channel::<Option<hub::CloseReason>>(None);
    let generation = state
        .next_generation
        .fetch_add(1, Ordering::Relaxed)
        .to_string();
    let transport: Arc<dyn Transport> = Arc::new(NativeTransport {
        outgoing: outgoing.clone(),
        close: close.clone(),
    });
    let mut identity: Option<Identity> = None;
    let started = Instant::now();
    let mut last_seen = started;
    let mut rate = protocol::MessageRate::default();
    let mut heartbeat = tokio::time::interval(state.config.heartbeat_interval);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    heartbeat.tick().await;

    loop {
        tokio::select! {
            changed = close_rx.changed() => {
                if changed.is_ok() {
                    let reason = *close_rx.borrow_and_update();
                    if let Some(reason) = reason { send_json(&mut socket, reason.message()).await; }
                }
                break;
            }
            _ = tokio::time::sleep_until(started + state.config.join_timeout), if identity.is_none() => {
                send_json(&mut socket, ServerMessage::error("join_timeout", "Send a join message shortly after connecting")).await;
                break;
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > state.config.idle_timeout {
                    send_json(&mut socket, ServerMessage::error("idle_timeout", "Heartbeat timed out")).await;
                    break;
                }
                if !send(&mut socket, Message::Ping(Vec::new().into())).await { break; }
            }
            outgoing = messages.recv() => {
                let Some(message) = outgoing else { break; };
                if !send_json(&mut socket, message).await { break; }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break; };
                last_seen = Instant::now();
                let parsed = match &message {
                    Message::Text(text) => serde_json::from_str::<ClientMessage>(text).ok(),
                    _ => None,
                };
                let relay = state.config.relay_enabled && matches!(parsed, Some(ClientMessage::Relay { .. }));
                if !rate.allow(hub::now_ms(), relay, match &message { Message::Text(s) => s.len(), _ => 0 }) {
                    send_json(&mut socket, ServerMessage::error("rate_limited", "Too many messages; reconnect shortly")).await;
                    break;
                }
                match message {
                    Message::Text(_) => {
                        let result = match parsed {
                            Some(message) => process_message(&state, message, source_ip, &mut identity, &generation, &transport),
                            None => Err(ServerMessage::error("invalid_message", "Expected a valid JSON protocol message")),
                        };
                        if let Err(message) = result
                            && !send_json(&mut socket, message).await { break; }
                    }
                    Message::Ping(payload) => { if !send(&mut socket, Message::Pong(payload)).await { break; } }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    Message::Binary(_) => {
                        if !send_json(&mut socket, ServerMessage::error("unsupported_message", "Send JSON protocol frames")).await { break; }
                    }
                }
            }
        }
    }
    if let Some(identity) = identity {
        state.leave(&identity);
    }
    let _ = send(&mut socket, Message::Close(None)).await;
}

struct NativeTransport {
    outgoing: mpsc::Sender<ServerMessage>,
    close: watch::Sender<Option<CloseReason>>,
}
impl Transport for NativeTransport {
    fn send(&self, message: ServerMessage) -> bool {
        self.outgoing.try_send(message).is_ok()
    }
    fn close(&self, reason: CloseReason) {
        self.close.send_replace(Some(reason));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ClientMessage;
    use axum::http::HeaderValue;

    fn join_at(
        state: &AppState,
        id: &str,
        room: &str,
        source_ip: &str,
        preferred_number: &str,
    ) -> (Identity, mpsc::Receiver<ServerMessage>, serde_json::Value) {
        let (outgoing, mut messages) = mpsc::channel(QUEUE_CAPACITY);
        let (close, _) = watch::channel(None);
        let mut identity = None;
        let profile = serde_json::from_value(json!({
            "id": id, "name": id, "numericId": preferred_number, "clientType": "web",
        }))
        .unwrap();
        process_message(
            state,
            ClientMessage::Join {
                room: room.into(),
                profile,
            },
            source_ip.parse().unwrap(),
            &mut identity,
            &state
                .next_generation
                .fetch_add(1, Ordering::Relaxed)
                .to_string(),
            &(Arc::new(NativeTransport { outgoing, close }) as Arc<dyn Transport>),
        )
        .unwrap();
        let welcome = serde_json::to_value(messages.try_recv().unwrap()).unwrap();
        (identity.unwrap(), messages, welcome)
    }

    #[test]
    fn ipv4_mapped_ipv6_source_uses_the_same_discovery_group() {
        let state = AppState::new(Config::default());
        let (_, _, first) = join_at(&state, "alice", "local", "192.0.2.1", "123456");
        let (_, _, second) = join_at(&state, "bob", "local", "::ffff:192.0.2.1", "654321");
        assert_eq!(first["room"], "local@192.0.2.1");
        assert_eq!(second["room"], first["room"]);
        assert_eq!(first["numericId"], second["numericId"]);
        assert_eq!(second["peers"][0]["id"], "alice");
    }

    #[test]
    fn automatic_groups_use_both_namespace_and_observed_ip_not_saved_number() {
        let state = AppState::new(Config::default());
        let (_, mut alice, first) = join_at(&state, "alice", "local", "192.0.2.1", "123456");
        let (_, mut bob, second) = join_at(&state, "bob", "local", "192.0.2.1", "654321");
        assert_eq!(first["room"], "local@192.0.2.1");
        assert_eq!(second["room"], first["room"]);
        assert_eq!(first["numericId"], second["numericId"]);
        assert_eq!(second["peers"][0]["id"], "alice");
        assert!(matches!(
            alice.try_recv().unwrap(),
            ServerMessage::PeerJoined { .. }
        ));
        let (carol, mut carol_messages, third) =
            join_at(&state, "carol", "local", "192.0.2.2", "123456");
        assert_eq!(third["room"], "local@192.0.2.2");
        assert_ne!(first["numericId"], third["numericId"]);
        assert_eq!(third["peers"], json!([]));
        let (_, _, fourth) = join_at(&state, "dan", "private", "192.0.2.1", "123456");
        assert_eq!(fourth["room"], "private@192.0.2.1");
        assert_ne!(first["numericId"], fourth["numericId"]);
        assert_eq!(fourth["peers"], json!([]));
        assert!(alice.try_recv().is_err());
        assert!(bob.try_recv().is_err());
        state
            .connect_group(&carol, "discover".into(), "123456")
            .unwrap();
        let resolved = serde_json::to_value(carol_messages.try_recv().unwrap()).unwrap();
        assert_eq!(resolved["type"], "group_resolved");
        assert_eq!(resolved["peers"].as_array().unwrap().len(), 2);
        for receiver in [&mut alice, &mut bob] {
            let joined = serde_json::to_value(receiver.try_recv().unwrap()).unwrap();
            assert_eq!(joined["peer"]["id"], "carol");
            assert_eq!(joined["peer"]["numericId"], third["numericId"]);
        }
    }

    #[test]
    fn proxy_headers_are_ignored_when_disabled() {
        let mut headers = HeaderMap::new();
        headers.insert("X-Forwarded-For", HeaderValue::from_static("203.0.113.9"));
        let config = Config {
            trust_proxy_headers: false,
            ..Config::default()
        };
        assert_eq!(
            source_ip(&config, "127.0.0.1".parse::<IpAddr>().unwrap(), &headers),
            "127.0.0.1".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn proxy_headers_can_supply_real_client_ip_when_enabled() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "Forwarded",
            HeaderValue::from_static("for=\"[2001:db8::5]:1234\";proto=https"),
        );
        headers.insert(
            "X-Forwarded-For",
            HeaderValue::from_static("203.0.113.9, 10.0.0.2"),
        );
        let config = Config {
            trust_proxy_headers: true,
            ..Config::default()
        };
        assert_eq!(
            source_ip(&config, "127.0.0.1".parse::<IpAddr>().unwrap(), &headers),
            "2001:db8::5".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn health_details_headers_keep_all_values() {
        let mut headers = HeaderMap::new();
        headers.append("x-test", HeaderValue::from_static("one"));
        headers.append("x-test", HeaderValue::from_static("two"));
        headers.insert("host", HeaderValue::from_static("localhost:8080"));
        assert_eq!(
            headers_json(&headers),
            json!({
                "host": ["localhost:8080"],
                "x-test": ["one", "two"],
            })
        );
    }
}
