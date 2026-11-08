use crate::{
    AppState, Config,
    engine::process_message,
    hub::{CloseReason, StoredPeer, Transport, now_ms},
    protocol::{ClientMessage, MAX_MESSAGE_BYTES, ServerMessage},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
};
use worker::*;

const HUB_NAME: &str = "global-v1";
const JOIN_TIMEOUT_MS: u64 = 10_000;

fn config(env: &Env) -> Result<Config> {
    Config::from_values(|key| env.var(key).ok().map(|v| v.to_string())).map_err(Error::RustError)
}

#[event(fetch)]
pub async fn fetch(request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = request.url()?;
    let config = config(&env)?;
    let origin = request.headers().get("Origin")?;
    if origin.as_ref().is_some_and(|origin| {
        *origin != url.origin().ascii_serialization() && !config.cors_origins.contains(origin)
    }) {
        return Response::error("Origin is not allowed", 403);
    }
    if request.method() != Method::Get {
        return Response::error("Method not allowed", 405);
    }
    if !matches!(
        url.path(),
        "/api/health" | "/api/health/details" | "/api/ws"
    ) {
        return Ok(Response::from_json(&json!({"error": "not_found"}))?.with_status(404));
    }
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
    let mut response = if url.path() == "/api/health" {
        Response::from_json(
            &json!({"ok": true, "service": "im-api", "version": env!("CARGO_PKG_VERSION")}),
        )?
    } else {
        env.durable_object("SIGNALING")?
            .get_by_name(HUB_NAME)?
            .fetch_with_request(request)
            .await?
    };
    if response.status_code() != 101 {
        // A DO fetch returns immutable headers; copy before adding CORS/cache headers.
        let headers = Headers::from_iter(response.headers());
        response = response.with_headers(headers);
        response
            .headers_mut()
            .set("X-Content-Type-Options", "nosniff")?;
        response.headers_mut().set("Cache-Control", "no-store")?;
        if let Some(origin) = origin {
            response
                .headers_mut()
                .set("Access-Control-Allow-Origin", &origin)?;
            response.headers_mut().set("Vary", "Origin")?;
        }
    }
    Ok(response)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    sid: String,
    ip: String,
    connected_at: u64,
    joined: bool,
    rate_at: u64,
    rate_count: u32,
    lookup_at: u64,
    lookup_count: u8,
}

fn attachment(socket: &WebSocket) -> Result<Attachment> {
    socket
        .deserialize_attachment()?
        .ok_or_else(|| Error::RustError("Missing session attachment".into()))
}

fn headers_json(headers: &Headers) -> Value {
    let mut result = Map::new();
    for (name, value) in headers.entries() {
        let entry = result
            .entry(name)
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(values) = entry {
            values.push(Value::String(value));
        }
    }
    Value::Object(result)
}

enum Effect {
    Send(String, ServerMessage),
    Close(String, CloseReason),
}
type Effects = Arc<Mutex<Vec<Effect>>>;
struct WorkerTransport {
    sid: String,
    effects: Effects,
}
impl Transport for WorkerTransport {
    fn send(&self, message: ServerMessage) -> bool {
        self.effects
            .lock()
            .unwrap()
            .push(Effect::Send(self.sid.clone(), message));
        true
    }
    fn close(&self, reason: CloseReason) {
        self.effects
            .lock()
            .unwrap()
            .push(Effect::Close(self.sid.clone(), reason));
    }
}

#[durable_object]
pub struct SignalingHub {
    state: State,
    app: Arc<AppState>,
    sockets: RefCell<HashMap<String, WebSocket>>,
    effects: Effects,
    saved: RefCell<HashMap<String, StoredPeer>>,
}

impl SignalingHub {
    fn restore(state: State, env: Env) -> Result<Self> {
        let app = AppState::new(config(&env)?);
        let sql = state.storage().sql();
        sql.exec(
            "CREATE TABLE IF NOT EXISTS peers (sid TEXT PRIMARY KEY, data TEXT NOT NULL)",
            None,
        )?;
        state.set_websocket_auto_response(&WebSocketRequestResponsePair::new(
            r#"{"type":"ping"}"#,
            r#"{"type":"pong"}"#,
        )?);
        let effects = Arc::new(Mutex::new(Vec::new()));
        let mut sockets = HashMap::new();
        let mut rates = HashMap::new();
        for socket in state.get_websockets() {
            let a = attachment(&socket)?;
            if socket.as_ref().ready_state() == 1 {
                rates.insert(a.sid.clone(), (a.lookup_at, a.lookup_count));
                sockets.insert(a.sid, socket);
            }
        }
        #[derive(Deserialize)]
        struct Row {
            data: String,
        }
        let mut saved = HashMap::new();
        for row in sql
            .exec("SELECT data FROM peers", None)?
            .to_array::<Row>()?
        {
            let mut peer: StoredPeer = serde_json::from_str(&row.data)?;
            peer.subscriptions.sort();
            peer.pairs.sort();
            let transport = Arc::new(WorkerTransport {
                sid: peer.sid.clone(),
                effects: effects.clone(),
            });
            let rate = rates.get(&peer.sid).copied().unwrap_or((now_ms(), 0));
            app.hub
                .lock()
                .unwrap()
                .restore(peer.clone(), transport, rate);
            saved.insert(peer.sid.clone(), peer);
        }
        // Load all relations before dropping dead sessions, to notify live observers.
        for sid in saved.keys().filter(|sid| !sockets.contains_key(*sid)) {
            let identity = app.hub.lock().unwrap().identity_for_session(sid);
            if let Some(identity) = identity {
                app.leave(&identity);
            }
        }
        let hub = Self {
            state,
            app,
            sockets: RefCell::new(sockets),
            effects,
            saved: RefCell::new(saved),
        };
        hub.flush(true)?;
        Ok(hub)
    }

    fn transport(&self, sid: &str) -> Arc<dyn Transport> {
        Arc::new(WorkerTransport {
            sid: sid.to_owned(),
            effects: self.effects.clone(),
        })
    }

    fn persist(&self) -> Result<()> {
        let peers = self.app.hub.lock().unwrap().stored_peers();
        let current: HashMap<_, _> = peers.into_iter().map(|p| (p.sid.clone(), p)).collect();
        let mut saved = self.saved.borrow_mut();
        let sql = self.state.storage().sql();
        // Synchronous writes within one event are committed atomically by DO storage.
        // Compare structs so legacy TS JSON field order does not cause rewrites.
        for (sid, peer) in &current {
            if saved.get(sid) != Some(peer) {
                sql.exec(
                    "INSERT OR REPLACE INTO peers (sid, data) VALUES (?, ?)",
                    vec![sid.clone().into(), serde_json::to_string(peer)?.into()],
                )?;
            }
        }
        for sid in saved.keys().filter(|sid| !current.contains_key(*sid)) {
            sql.exec("DELETE FROM peers WHERE sid = ?", vec![sid.clone().into()])?;
        }
        *saved = current;
        Ok(())
    }

    fn disconnect(&self, sid: &str, error: Option<ServerMessage>, code: u16) {
        let socket = self.sockets.borrow_mut().remove(sid);
        if let Some(socket) = socket {
            if let Some(error) = error {
                let _ = socket.send(&error);
            }
            let _ = socket.close(Some(code), Some(""));
        }
        let identity = self.app.hub.lock().unwrap().identity_for_session(sid);
        if let Some(identity) = identity {
            self.app.leave(&identity);
        }
    }

    fn flush(&self, mut persist: bool) -> Result<()> {
        loop {
            if persist {
                self.persist()?;
            }
            let effects = std::mem::take(&mut *self.effects.lock().unwrap());
            if effects.is_empty() {
                break;
            }
            persist = false;
            for effect in effects {
                match effect {
                    Effect::Send(sid, message) => {
                        let failed = self
                            .sockets
                            .borrow()
                            .get(&sid)
                            .is_some_and(|s| s.send(&message).is_err());
                        if failed {
                            self.disconnect(&sid, None, 1000);
                            persist = true;
                        }
                    }
                    Effect::Close(sid, reason) => {
                        self.disconnect(&sid, Some(reason.message()), 1000);
                        persist = true;
                    }
                }
            }
        }
        Ok(())
    }

    async fn schedule_join_timeout(&self) -> Result<()> {
        let storage = self.state.storage();
        // Read before inspecting sockets: the input gate serializes alarm updates.
        let scheduled = storage.get_alarm().await?;
        let next = self
            .sockets
            .borrow()
            .values()
            .map(attachment)
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|a| !a.joined)
            .map(|a| a.connected_at + JOIN_TIMEOUT_MS)
            .min();
        if next.map(|v| v as i64) != scheduled {
            if let Some(next) = next {
                storage
                    .set_alarm(ScheduledTime::new(js_sys::Date::new(&(next as f64).into())))
                    .await?;
            } else {
                storage.delete_alarm().await?;
            }
        }
        Ok(())
    }

    async fn handle_message(&self, socket: WebSocket, raw: WebSocketIncomingMessage) -> Result<()> {
        let mut a = attachment(&socket)?;
        if !self.sockets.borrow().contains_key(&a.sid) {
            return Ok(());
        }
        let now = now_ms();
        let error = if !a.joined && now.saturating_sub(a.connected_at) >= JOIN_TIMEOUT_MS {
            Some(("join_timeout", "请重新连接后再试", 1000))
        } else {
            if now.saturating_sub(a.rate_at) >= 10_000 {
                a.rate_at = now;
                a.rate_count = 0;
            }
            a.rate_count += 1;
            if a.rate_count > 240 {
                Some(("rate_limited", "操作过于频繁，请稍后重试", 1000))
            } else {
                None
            }
        };
        let len = match &raw {
            WebSocketIncomingMessage::String(s) => s.len(),
            WebSocketIncomingMessage::Binary(b) => b.len(),
        };
        let error = error.or_else(|| {
            (len > MAX_MESSAGE_BYTES).then_some(("message_too_large", "请求过大", 1009))
        });
        if let Some((code, message, close_code)) = error {
            self.disconnect(
                &a.sid,
                Some(ServerMessage::error(code, message)),
                close_code,
            );
            self.flush(true)?;
            return self.schedule_join_timeout().await;
        }
        let message = match raw {
            WebSocketIncomingMessage::String(s) => serde_json::from_str::<ClientMessage>(&s)
                .map_err(|_| ServerMessage::error("invalid_message", "请求格式不正确")),
            WebSocketIncomingMessage::Binary(_) => Err(ServerMessage::error(
                "unsupported_message",
                "此连接仅用于发现设备",
            )),
        };
        let mut changed = false;
        let mut join = false;
        let result = match message {
            Ok(message) => {
                changed = !matches!(message, ClientMessage::Signal { .. } | ClientMessage::Ping);
                join = matches!(message, ClientMessage::Join { .. });
                let mut identity = self.app.hub.lock().unwrap().identity_for_session(&a.sid);
                let result = process_message(
                    &self.app,
                    message,
                    a.ip.parse()
                        .map_err(|_| Error::RustError("Invalid session IP".into()))?,
                    &mut identity,
                    &a.sid,
                    &self.transport(&a.sid),
                );
                if let Some(identity) = identity {
                    a.joined = true;
                    (a.lookup_at, a.lookup_count) =
                        self.app.hub.lock().unwrap().lookup_rate(&identity);
                }
                result
            }
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            self.transport(&a.sid).send(error);
        }
        socket.serialize_attachment(&a)?;
        self.flush(changed)?;
        if join {
            self.schedule_join_timeout().await?;
        }
        Ok(())
    }
}

impl DurableObject for SignalingHub {
    fn new(state: State, env: Env) -> Self {
        Self::restore(state, env).expect("restore signaling hub")
    }

    async fn fetch(&self, request: Request) -> Result<Response> {
        if request.url()?.path() == "/api/health/details" {
            let hub = self.app.hub.lock().unwrap();
            return Response::from_json(
                &json!({"ok": true, "service": "im-api", "version": env!("CARGO_PKG_VERSION"),
                "rooms": hub.rooms.len(),
                "peers": hub.rooms.values().map(HashMap::len).sum::<usize>(),
                "headers": headers_json(request.headers()),
                }),
            );
        }
        if self.sockets.borrow().len() >= self.app.config.max_connections {
            return Response::error("Connection limit reached", 503);
        }
        let Some(ip) = request
            .headers()
            .get("CF-Connecting-IP")?
            .and_then(|s| s.parse::<IpAddr>().ok())
        else {
            return Response::error("Client address is unavailable", 400);
        };
        let pair = WebSocketPair::new()?;
        let now = now_ms();
        // Platform UUIDs avoid collisions across hibernations and deployments.
        let sid = uuid();
        let a = Attachment {
            sid: sid.clone(),
            ip: ip.to_canonical().to_string(),
            connected_at: now,
            joined: false,
            rate_at: now,
            rate_count: 0,
            lookup_at: now,
            lookup_count: 0,
        };
        self.state.accept_web_socket(&pair.server);
        pair.server.serialize_attachment(&a)?;
        self.sockets.borrow_mut().insert(sid, pair.server);
        self.schedule_join_timeout().await?;
        Response::from_websocket(pair.client)
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        self.handle_message(ws, message).await
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _clean: bool,
    ) -> Result<()> {
        self.disconnect(&attachment(&ws)?.sid, None, 1000);
        self.flush(true)?;
        self.schedule_join_timeout().await
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        <Self as DurableObject>::websocket_close(self, ws, 1000, String::new(), false).await
    }

    async fn alarm(&self) -> Result<Response> {
        let pending = self
            .sockets
            .borrow()
            .values()
            .map(attachment)
            .collect::<Result<Vec<_>>>()?;
        for a in pending {
            if !a.joined && now_ms().saturating_sub(a.connected_at) >= JOIN_TIMEOUT_MS {
                self.disconnect(
                    &a.sid,
                    Some(ServerMessage::error("join_timeout", "请重新连接后再试")),
                    1000,
                );
            }
        }
        self.flush(true)?;
        self.schedule_join_timeout().await?;
        Response::empty()
    }
}

#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = crypto, js_name = randomUUID)]
    fn uuid() -> String;
}
