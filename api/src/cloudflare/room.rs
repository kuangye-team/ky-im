use super::store::{Owner, Store, now};
use crate::{
    Config, auth,
    protocol::{self, ClientMessage, MessageRate, RelayPacket, ServerMessage},
    relay::RelayRegistry,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
};
use tokio::sync::Mutex;
use worker::*;

#[derive(Serialize, Deserialize)]
struct Session {
    sid: String,
    room: String,
    deadline: u64,
    authed: bool,
    joined: bool,
    closing: bool,
    peer: Option<String>,
    rate: MessageRate,
    lookup_at: u64,
    lookups: u8,
}
#[durable_object]
pub struct DiscoveryRoom {
    db: Store,
    config: Config,
    // Preserve WebSocket frame order across asynchronous cross-room routing.
    locks: RefCell<HashMap<String, Rc<Mutex<()>>>>,
}
fn session_key(sid: &str) -> String {
    format!("ws/{sid}")
}
fn tunnel_key(sid: &str) -> String {
    format!("t/{sid}")
}
impl DiscoveryRoom {
    fn socket(&self, sid: &str) -> Option<WebSocket> {
        self.db
            .state
            .get_websockets_with_tag(sid)
            .into_iter()
            .find(|ws| ws.as_ref().ready_state() == 1)
    }
    fn lock(&self, sid: &str) -> Rc<Mutex<()>> {
        self.locks
            .borrow_mut()
            .entry(sid.into())
            .or_default()
            .clone()
    }
    fn sessions(&self) -> Result<Vec<Session>> {
        self.db.list("ws/")
    }
    fn members(&self) -> Result<HashSet<String>> {
        Ok(self
            .sessions()?
            .into_iter()
            .filter(|a| !a.closing)
            .filter_map(|a| a.peer)
            .collect())
    }
    fn counts(&self) -> Result<(usize, usize, usize)> {
        let mut connections = 0;
        let mut pending = 0;
        let mut peers = HashSet::new();
        for a in self
            .sessions()?
            .into_iter()
            .filter(|a| !a.closing && self.socket(&a.sid).is_some())
        {
            connections += 1;
            if a.joined {
                peers.insert(a.peer);
            } else {
                pending += 1;
            }
        }
        Ok((connections, pending, peers.len()))
    }
    async fn changed(&self) -> Result<()> {
        let (connections, _, peers) = self.counts()?;
        let key = self.db.get::<String>("key")?.unwrap_or_default();
        self.db
            .report(
                format!("room/{key}"),
                connections,
                usize::from(peers > 0),
                0,
            )
            .await
    }
    async fn remove(&self, sid: &str) -> Result<()> {
        let lock = self.lock(sid);
        let _guard = lock.lock().await;
        let Some(mut a) = self.db.get::<Session>(&session_key(sid))? else {
            return Ok(());
        };
        a.closing = true;
        self.db.put(&session_key(sid), &a)?;
        self.db.wake(now() + 1000).await?;
        if let Some(id) = a.peer {
            self.db
                .rpc("ROUTES", &id, "change", &json!({"type":"leave","sid":sid}))
                .await?;
        }
        self.db.del(&session_key(sid))?;
        self.db.del(&tunnel_key(sid))?;
        self.locks.borrow_mut().remove(sid);
        self.changed().await
    }
    fn allow_tunnel(
        &self,
        sid: &str,
        a: &Owner,
        b: &Owner,
        id: &str,
        data: &RelayPacket,
    ) -> Result<bool> {
        let key = tunnel_key(sid);
        let mut registry = self.db.get::<RelayRegistry>(&key)?.unwrap_or_default();
        let ok = registry.route(&a.profile.id, &b.profile.id, &a.sid, &b.sid, id, data);
        if ok {
            self.db.put(&key, &registry)?;
        }
        Ok(ok)
    }
    async fn forward(
        &self,
        ws: &WebSocket,
        a: &Session,
        to: String,
        data: Value,
        tunnel: Option<(String, RelayPacket)>,
    ) -> Result<()> {
        let id = a.peer.as_deref().unwrap();
        if to.parse::<libp2p_identity::PeerId>().is_err() || to == id {
            return ws.send(&ServerMessage::error("invalid_target", "Invalid peer"));
        }
        let (from, target) = futures_util::try_join!(self.db.current(id), self.db.current(&to))?;
        let reject = |code: &str| {
            if let Some((session, _)) = &tunnel {
                ws.send(&ServerMessage::RelayError {
                    to: to.clone(),
                    session: session.clone(),
                    code: code.into(),
                    message: code.into(),
                })
            } else {
                ws.send(&ServerMessage::error(code, code))
            }
        };
        let Some(from) = from.filter(|v| v.sid == a.sid) else {
            return reject("session_replaced");
        };
        let Some(b) = target.filter(|b| from.visible(b)) else {
            return reject("peer_unavailable");
        };
        if let Some((session, packet)) = &tunnel {
            if !self.config.relay_enabled || !from.profile.relay || !b.profile.relay {
                return reject("relay_not_allowed");
            }
            if !protocol::valid_identifier(session)
                || !packet.valid()
                || !self.allow_tunnel(&a.sid, &from, &b, session, packet)?
            {
                return reject("invalid_tunnel");
            }
            let payload = match packet {
                RelayPacket::Bytes { sequence, payload } => {
                    json!({"sequence":sequence,"bytes":STANDARD.encode(payload)})
                }
                other => serde_json::to_value(other)?,
            };
            let ok = self
                .db
                .rpc(
                    "ROOMS",
                    &b.room,
                    "tunnel",
                    &json!({"from":from,"to":b,"session":session,"packet":payload}),
                )
                .await?;
            if ok != true {
                self.allow_tunnel(&a.sid, &from, &b, session, &RelayPacket::Close)?;
                return reject("invalid_tunnel");
            }
        } else {
            if !protocol::valid_signal(&data) {
                return reject("invalid_signal");
            }
            if !self
                .db
                .deliver(
                    &b.room,
                    &b.sid,
                    json!({"type":"signal","from":id,"data":data}),
                )
                .await?
            {
                return reject("peer_unavailable");
            }
        }
        Ok(())
    }
    fn receive_tunnel(&self, p: Value) -> Result<bool> {
        let a: Owner = serde_json::from_value(p["from"].clone())?;
        let b: Owner = serde_json::from_value(p["to"].clone())?;
        let Some(ws) = self.socket(&b.sid) else {
            return Ok(false);
        };
        let session = p["session"].as_str().unwrap();
        let packet = if let Some(bytes) = p["packet"]["bytes"].as_str() {
            RelayPacket::Bytes {
                sequence: p["packet"]["sequence"].as_u64().unwrap() as u32,
                payload: STANDARD
                    .decode(bytes)
                    .map_err(|_| Error::RustError("Invalid relay payload".into()))?,
            }
        } else {
            serde_json::from_value(p["packet"].clone())?
        };
        if !self.allow_tunnel(&b.sid, &a, &b, session, &packet)? {
            return Ok(false);
        }
        let message = ServerMessage::Relay {
            from: a.profile.id,
            session: session.into(),
            data: packet,
        };
        if let Some(raw) = protocol::encode_relay_binary(&message) {
            ws.send_with_bytes(&raw)?;
        } else {
            ws.send(&message)?;
        }
        Ok(true)
    }
    async fn handle(
        &self,
        ws: WebSocket,
        sid: String,
        raw: WebSocketIncomingMessage,
    ) -> Result<()> {
        let lock = self.lock(&sid);
        let _guard = lock.lock().await;
        let key = session_key(&sid);
        let Some(mut a) = self.db.get::<Session>(&key)? else {
            return Ok(());
        };
        if a.closing {
            return Ok(());
        }
        let size = match &raw {
            WebSocketIncomingMessage::String(s) => s.len(),
            WebSocketIncomingMessage::Binary(b) => b.len(),
        };
        if size > protocol::MAX_MESSAGE_BYTES || !a.joined && now() >= a.deadline {
            return ws.close(Some(1008), Some("Handshake or size limit"));
        }
        let parsed = match raw {
            WebSocketIncomingMessage::String(s) => serde_json::from_str(&s).ok(),
            WebSocketIncomingMessage::Binary(b) => protocol::decode_relay_binary(&b),
        };
        if !a.authed {
            if let Some(response) = auth::authenticate(
                &self.config.authorization,
                parsed.as_ref(),
                &sid,
                self.config.relay_enabled,
            ) {
                a.authed = true;
                self.db.put(&key, &a)?;
                return ws.send(&response);
            }
            ws.send(&ServerMessage::error(
                "unauthorized",
                "Authentication required",
            ))?;
            return ws.close(Some(1008), Some(""));
        }
        let relay =
            self.config.relay_enabled && matches!(parsed, Some(ClientMessage::Relay { .. }));
        if !a.rate.allow(now(), relay, size) {
            return ws.close(Some(1008), Some("Rate limit"));
        }
        self.db.put(&key, &a)?;
        let Some(mut cmd) = parsed else {
            return ws.send(&ServerMessage::error("invalid_message", "Invalid message"));
        };
        let mut outgoing = match &mut cmd {
            ClientMessage::Join {
                room,
                profile,
                proof,
                recent_numeric_ids,
            } => {
                if a.joined {
                    return ws.send(&ServerMessage::error("already_joined", "Already joined"));
                }
                if room != &a.room {
                    return ws.send(&ServerMessage::error(
                        "invalid_room",
                        "Room does not match upgrade",
                    ));
                }
                if let Err(e) = profile.validate() {
                    return ws.send(&ServerMessage::error("invalid_profile", e));
                }
                if !profile.supports_discovery() {
                    return ws.send(&ServerMessage::error(
                        "capability_required",
                        "Required capabilities are missing",
                    ));
                }
                if !proof.verify(&profile.id, &sid) {
                    return ws.send(&ServerMessage::error(
                        "invalid_identity",
                        "Invalid identity proof",
                    ));
                }
                if let Err(e) = protocol::validate_recent_numbers(recent_numeric_ids) {
                    return ws.send(&e);
                }
                let members = self.members()?;
                if !members.contains(&profile.id)
                    && members.len() >= self.config.max_peers_per_room.min(128)
                {
                    return ws.send(&ServerMessage::error("room_full", "Room is full"));
                }
                profile.relay &= self.config.relay_enabled && profile.supports("relay");
                a.peer = Some(profile.id.clone());
                self.db.put(&key, &a)?;
                json!({"type":"welcome","id":profile.id,"numericId":profile.numeric_id,"room":self.db.get::<String>("key")?,
                    "version":protocol::capabilities::RELEASE_VERSION,"capabilities":protocol::capabilities::server_runtime(self.config.relay_enabled).capabilities})
            }
            _ if !a.joined => {
                let id = match &cmd {
                    ClientMessage::ConnectGroup { request_id, .. }
                    | ClientMessage::Connect { request_id, .. } => Some(request_id),
                    _ => None,
                };
                return ws.send(&match id{Some(id)=>json!({"type":"connect_error","requestId":id,"code":"join_required","message":"Join required"}), None=>serde_json::to_value(ServerMessage::error("join_required","Join required"))?});
            }
            ClientMessage::Ping => return ws.send(&ServerMessage::Pong),
            ClientMessage::Signal { .. } | ClientMessage::Relay { .. } => {
                return match cmd {
                    ClientMessage::Signal { to, data } => {
                        self.forward(&ws, &a, to, data, None).await
                    }
                    ClientMessage::Relay { to, session, data } => {
                        self.forward(&ws, &a, to, Value::Null, Some((session, data)))
                            .await
                    }
                    _ => unreachable!(),
                };
            }
            ClientMessage::Discover { recent_numeric_ids } => {
                if let Err(e) = protocol::validate_recent_numbers(recent_numeric_ids) {
                    return ws.send(&e);
                }
                json!({"type":"discovery_updated"})
            }
            ClientMessage::ChangeNumericId {
                numeric_id,
                revision,
            } => {
                if !protocol::valid_numeric_id(numeric_id)
                    || !(1..=9_007_199_254_740_991).contains(revision)
                {
                    return Ok(());
                }
                Value::Null
            }
            ClientMessage::ConnectGroup {
                request_id,
                numeric_id,
            }
            | ClientMessage::Connect {
                request_id,
                numeric_id,
                ..
            } => {
                if now() - a.lookup_at >= 10000 {
                    a.lookup_at = now();
                    a.lookups = 0;
                }
                a.lookups = a.lookups.saturating_add(1);
                self.db.put(&key, &a)?;
                let invalid = if a.lookups > 10 {
                    Some("connect_rate_limited")
                } else if !protocol::valid_identifier(request_id)
                    || !protocol::valid_numeric_id(numeric_id)
                {
                    Some("invalid_numeric_id")
                } else {
                    None
                };
                if let Some(code) = invalid {
                    return ws.send(&json!({"type":"connect_error","requestId":request_id,"code":code,"message":code}));
                }
                json!({"requestId":request_id,"numericId":numeric_id})
            }
            ClientMessage::Auth { .. } => {
                return ws.send(&ServerMessage::error(
                    "unexpected_auth",
                    "Already authenticated",
                ));
            }
        };
        let mut command = serde_json::to_value(&cmd)?;
        command.as_object_mut().unwrap().remove("proof");
        command["sid"] = json!(sid);
        command["roomKey"] = json!(self.db.get::<String>("key")?);
        let result = self
            .db
            .rpc("ROUTES", a.peer.as_ref().unwrap(), "change", &command)
            .await?;
        if let Some(code) = result["error"].as_str() {
            if matches!(cmd, ClientMessage::Join { .. }) {
                a.peer = None;
                self.db.put(&key, &a)?;
            }
            if outgoing.is_null() {
                return Ok(());
            }
            if let Some(id) = outgoing.get("requestId") {
                return ws.send(
                    &json!({"type":"connect_error","requestId":id,"code":code,"message":code}),
                );
            }
            return ws.send(&ServerMessage::error(code, code));
        }
        if let ClientMessage::Join { .. } = cmd {
            a.joined = true;
            self.db.put(&key, &a)?;
            self.changed().await?;
        }
        if !outgoing.is_null() {
            if matches!(cmd, ClientMessage::Connect { .. }) {
                outgoing["type"] = "peer_resolved".into();
            }
            if matches!(cmd, ClientMessage::ConnectGroup { .. }) {
                outgoing["type"] = "group_resolved".into();
            }
            if let Some(fields) = result.as_object() {
                outgoing.as_object_mut().unwrap().extend(fields.clone());
            }
            ws.send(&outgoing)?;
        }
        Ok(())
    }
}
impl DurableObject for DiscoveryRoom {
    fn new(state: State, env: Env) -> Self {
        let config = super::config(&env).expect("configuration");
        Self {
            db: Store::new(state, env),
            config,
            locks: Default::default(),
        }
    }
    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        match path.as_str() {
            "/members" => Response::from_json(&self.members()?),
            "/replace" => {
                let sid: String = req.json().await?;
                if let Some(ws) = self.socket(&sid) {
                    ws.send(&ServerMessage::error(
                        "session_replaced",
                        "Device reconnected",
                    ))?;
                    ws.close(Some(1000), Some(""))?;
                }
                Response::from_json(&true)
            }
            "/tunnel" => Response::from_json(&self.receive_tunnel(req.json().await?)?),
            "/deliver" => {
                let p: Value = req.json().await?;
                let sid = p["sid"].as_str().unwrap();
                let Some(ws) = self.socket(sid) else {
                    return Response::from_json(&false);
                };
                if p["message"]["type"] == "peer_left" {
                    let key = tunnel_key(sid);
                    if let Some(mut tunnels) = self.db.get::<RelayRegistry>(&key)? {
                        for (a, b, session) in
                            tunnels.remove_owner(p["message"]["id"].as_str().unwrap())
                        {
                            let from = if a == p["message"]["id"] { a } else { b };
                            ws.send(&ServerMessage::Relay {
                                from,
                                session,
                                data: RelayPacket::Close,
                            })?;
                        }
                        self.db.put(&key, &tunnels)?;
                    }
                }
                Response::from_json(&ws.send(&p["message"]).is_ok())
            }
            "/api/health/details" => {
                let (connections, pending, peers) = self.counts()?;
                Response::from_json(
                    &json!({"ok":true,"scope":"room","room":req.url()?.query_pairs().find(|(k,_)|k=="room").map(|(_,v)|v.into_owned()),"connections":connections,"pending":pending,"peers":peers,"asOf":now()}),
                )
            }
            "/api/ws" => {
                if self.counts()?.1 >= 32 {
                    return Response::error("Room busy", 503);
                }
                let name = auth::room(req.url()?.query().unwrap_or_default()).unwrap();
                let ip = req
                    .headers()
                    .get("CF-Connecting-IP")?
                    .and_then(|s| s.parse::<std::net::IpAddr>().ok())
                    .ok_or_else(|| Error::RustError("Invalid ingress address".into()))?;
                let sid = uuid();
                let pair = WebSocketPair::new()?;
                let a = Session {
                    sid: sid.clone(),
                    room: name.clone(),
                    deadline: now() + 10000,
                    authed: false,
                    joined: false,
                    closing: false,
                    peer: None,
                    rate: Default::default(),
                    lookup_at: now(),
                    lookups: 0,
                };
                self.db
                    .put("key", &format!("{name}@{}", ip.to_canonical()))?;
                self.db
                    .state
                    .accept_websocket_with_tags(&pair.server, &[&sid]);
                pair.server.serialize_attachment(&sid)?;
                self.db.put(&session_key(&sid), &a)?;
                self.changed().await?;
                self.db.wake(a.deadline).await?;
                Response::from_websocket(pair.client)
            }
            _ => Response::error("Unknown room operation", 404),
        }
    }
    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        if let Ok(Some(id)) = ws.deserialize_attachment::<String>() {
            self.handle(ws, id, message).await
        } else {
            ws.close(Some(1000), Some("Reconnect"))
        }
    }
    async fn websocket_close(&self, ws: WebSocket, _: usize, _: String, _: bool) -> Result<()> {
        if let Ok(Some(sid)) = ws.deserialize_attachment::<String>() {
            self.remove(&sid).await?;
        }
        Ok(())
    }
    async fn websocket_error(&self, ws: WebSocket, _: Error) -> Result<()> {
        <Self as DurableObject>::websocket_close(self, ws, 1000, String::new(), false).await
    }
    async fn alarm(&self) -> Result<Response> {
        for a in self.sessions()? {
            let socket = self.socket(&a.sid);
            if a.closing || socket.is_none() || (!a.joined && now() >= a.deadline) {
                if let Some(ws) = socket {
                    let _ = ws.close(Some(1008), Some("Handshake timed out"));
                }
                self.remove(&a.sid).await?;
            } else if !a.joined {
                self.db.wake(a.deadline).await?;
            }
        }
        self.db.flush_report().await?;
        Response::empty()
    }
}
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace=crypto,js_name=randomUUID)]
    fn uuid() -> String;
}
