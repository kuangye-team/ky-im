//! Central WebSockets, relay tunnels and SDP exchange over authenticated desktop streams.
use super::{Emit, EmitData, transport::Pipes};
use futures::{SinkExt, StreamExt};
use reqwest_websocket::Message;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, mpsc},
};

use tokio_util::sync::CancellationToken;
type Result<T> = std::result::Result<T, String>;
struct Source {
    name: String,
    permitted: bool,
    peers: Mutex<HashMap<String, bool>>,
    send: mpsc::Sender<Message>,
    cancel: CancellationToken,
}
struct Tunnel {
    source: String,
    peer: String,
    session: String,
    pipe: String,
    input: mpsc::Sender<(u32, Vec<u8>)>,
    credit: AtomicU32,
    notify: Notify,
    accepted: AtomicBool,
    pipe_attached: AtomicBool,
    cancel: CancellationToken,
}
impl Tunnel {
    fn grant_credit(&self, count: u32) -> bool {
        let mut available = self.credit.load(Ordering::SeqCst);
        while available + count <= 8 {
            match self.credit.compare_exchange_weak(
                available,
                available + count,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return true,
                Err(current) => available = current,
            }
        }
        false
    }
}
#[derive(Clone)]
pub struct Network {
    pub webview: Arc<super::webview::Webview>,
    pipes: Pipes,
    emit: Emit,
    sources: Arc<Mutex<HashMap<String, Arc<Source>>>>,
    tunnels: Arc<Mutex<HashMap<String, Arc<Tunnel>>>>,
    pub(super) signal_streams: Arc<Mutex<HashMap<libp2p::PeerId, libp2p::swarm::Stream>>>,
    pub(super) profiles: Arc<Mutex<HashMap<libp2p::PeerId, Value>>>,
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
// A local address tag ties a Swarm ConnectionId to its exact RTC session, including simultaneous dials.
pub(super) fn tag_rtc_address(address: libp2p::Multiaddr) -> libp2p::Multiaddr {
    use libp2p::multiaddr::Protocol;
    address
        .replace(0, |p| match p {
            Protocol::Dns4(name)
                if matches!(
                    name.as_ref(),
                    "rtc.hummingbird.invalid" | "rtc-stream.hummingbird.invalid"
                ) =>
            {
                Some(Protocol::Dns4(
                    format!("{}.{name}", uuid::Uuid::new_v4()).into(),
                ))
            }
            _ => None,
        })
        .unwrap_or(address)
}
fn route_session(address: &libp2p::Multiaddr) -> Option<String> {
    let libp2p::multiaddr::Protocol::Dns4(host) = address.iter().next()? else {
        return None;
    };
    let (id, suffix) = host.split_once('.')?;
    if !matches!(
        suffix,
        "rtc.hummingbird.invalid" | "rtc-stream.hummingbird.invalid"
    ) {
        return None;
    }
    uuid::Uuid::parse_str(id).ok().map(|u| u.to_string())
}
fn tunnel_key(source: &str, peer: &str, session: &str) -> String {
    format!("{source}:{peer}:{session}")
}
impl Network {
    pub fn new(pipes: Pipes, emit: Emit, emit_data: EmitData) -> Self {
        Self {
            webview: Arc::new(super::webview::Webview::new(emit.clone(), emit_data)),
            pipes,
            emit,
            sources: Default::default(),
            tunnels: Default::default(),
            signal_streams: Default::default(),
            profiles: Default::default(),
        }
    }
    pub(super) fn file_rtc(
        &self,
        address: &libp2p::Multiaddr,
        peer: &str,
    ) -> Option<super::webview::WebviewSession> {
        Some(super::webview::WebviewSession {
            peer: peer.to_string(),
            session: route_session(address)?,
            bridge: self.webview.clone(),
        })
    }
    fn source(&self, id: &str) -> Result<Arc<Source>> {
        self.sources
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("服务器连接已断开".into())
    }
    async fn packet(&self, source: &str, packet: Value) -> Result<()> {
        let s = self.source(source)?;
        tokio::select! { _ = s.cancel.cancelled() => Err("服务器连接已断开".into()), result = s.send.send(Message::Text(packet.to_string())) => result.map_err(|e| e.to_string()) }
    }
    pub async fn open(
        &self,
        id: String,
        name: String,
        address: String,
        permitted: bool,
        use_system_proxy: bool,
    ) -> Result<()> {
        if !address.starts_with("ws://") && !address.starts_with("wss://") {
            return Err("服务器地址无法使用".into());
        }
        let (tx, mut rx) = mpsc::channel(64);
        let source = Arc::new(Source {
            name,
            permitted,
            peers: Default::default(),
            send: tx,
            cancel: CancellationToken::new(),
        });
        {
            let mut sources = self.sources.lock().unwrap();
            if sources.len() >= 16 || sources.contains_key(&id) {
                return Err("服务器连接过多".into());
            }
            sources.insert(id.clone(), source.clone());
        }
        let network = self.clone();
        tokio::spawn(async move {
            let result = async {
                let ws = tokio::time::timeout(
                    Duration::from_secs(15),
                    super::signaling_socket::connect(&address, use_system_proxy),
                )
                .await
                .map_err(|e| e.to_string())??;
                (network.emit)(json!({"type":"socket","socketId":id,"state":"open"}));
                let (mut write, mut read) = ws.split();
                #[cfg(target_os = "android")]
                let joined = AtomicBool::new(false);
                let outgoing = async {
                    loop {
                        // An idle Android WebView can stop scheduling the discovery timer.
                        // Keep the registered WSS session alive from its owning native task.
                        #[cfg(target_os = "android")]
                        let next =
                            match tokio::time::timeout(Duration::from_secs(20), rx.recv()).await {
                                Ok(next) => next,
                                Err(_) if joined.load(Ordering::Relaxed) => {
                                    Some(Message::Text(r#"{"type":"ping"}"#.into()))
                                }
                                Err(_) => continue,
                            };
                        #[cfg(not(target_os = "android"))]
                        let next = rx.recv().await;
                        let Some(message) = next else { break };
                        write.send(message).await.map_err(|e| e.to_string())?;
                    }
                    Ok::<_, String>(())
                };
                let incoming = async {
                    let mut last_activity = None::<tokio::time::Instant>;
                    while let Some(message) = read.next().await {
                        match message.map_err(|e| e.to_string())? {
                            Message::Binary(bytes) => network.binary(&id, &bytes)?,
                            Message::Text(raw) => {
                                let packet: Value =
                                    serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                                #[cfg(target_os = "android")]
                                if packet["type"] == "welcome" {
                                    joined.store(true, Ordering::Relaxed);
                                }
                                network.observe(&id, &source, &packet);
                                if packet["type"] == "tunnel" {
                                    network.tunnel_packet(&id, &source, &packet).await?;
                                } else if packet["type"] == "tunnel_error" {
                                    network.close_tunnel(
                                        &tunnel_key(
                                            &id,
                                            packet["to"].as_str().unwrap_or(""),
                                            packet["session"].as_str().unwrap_or(""),
                                        ),
                                        false,
                                    );
                                } else {
                                    (network.emit)(
                                        json!({"type":"socket","socketId":id,"state":"message","message":raw.as_str()}),
                                    );
                                    continue;
                                }
                            }
                            Message::Ping(data) => {
                                source
                                    .send
                                    .try_send(Message::Pong(data))
                                    .map_err(|e| e.to_string())?;
                            }
                            Message::Close { .. } => break,
                            _ => continue,
                        }
                        // Relay frames stay in Rust. Coalesce liveness notifications to the WebView.
                        if last_activity.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                            (network.emit)(
                                json!({"type":"socket","socketId":id,"state":"activity"}),
                            );
                            last_activity = Some(tokio::time::Instant::now());
                        }
                    }
                    Ok::<_, String>(())
                };
                tokio::select! { result = outgoing => result, result = incoming => result, _ = source.cancel.cancelled() => Ok(()) }
            };
            let result = tokio::select! { result = result => result, _ = source.cancel.cancelled() => Ok(()) };
            if let Err(error) = result {
                (network.emit)(
                    json!({"type":"socket","socketId":id,"state":"error","detail":error}),
                );
            }
            network.close_source(&id);
            (network.emit)(json!({"type":"socket","socketId":id,"state":"close"}));
        });
        Ok(())
    }
    pub fn send(&self, id: &str, packet: &str) -> Result<()> {
        if packet.len() > 512 * 1024 {
            return Err("消息过长".into());
        }
        self.source(id)?
            .send
            .try_send(Message::Text(packet.to_string()))
            .map_err(|_| "连接繁忙，请稍后重试".into())
    }
    fn observe(&self, id: &str, source: &Source, packet: &Value) {
        let mut peers = source.peers.lock().unwrap();
        if let Some(list) = packet["peers"].as_array() {
            for peer in list {
                if let Some(id) = peer["id"].as_str() {
                    peers.insert(id.into(), peer["relay"].as_bool().unwrap_or(false));
                }
            }
        }
        if let Some(id) = packet["peer"]["id"].as_str() {
            peers.insert(
                id.into(),
                packet["peer"]["relay"].as_bool().unwrap_or(false),
            );
        }
        if packet["type"] == "peer_left"
            && let Some(id) = packet["id"].as_str()
        {
            peers.remove(id);
        }
        if let Some(list) = packet["removedPeerIds"].as_array() {
            for peer in list {
                if let Some(id) = peer.as_str() {
                    peers.remove(id);
                }
            }
        }
        let revoked: Vec<_> = self
            .tunnels
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, t)| t.source == id && !peers.get(&t.peer).copied().unwrap_or(false))
            .map(|(key, _)| key.clone())
            .collect();
        drop(peers);
        for key in revoked {
            self.close_tunnel(&key, true);
        }
    }
    pub fn close_source(&self, id: &str) {
        if let Some(source) = self.sources.lock().unwrap().remove(id) {
            source.cancel.cancel();
        }
        let keys: Vec<_> = self
            .tunnels
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, t)| t.source == id)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            self.close_tunnel(&key, false);
        }
    }
    pub(super) fn close_peer(&self, peer: &str) {
        let tunnels: Vec<_> = self
            .tunnels
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, tunnel)| tunnel.peer == peer)
            .map(|(id, _)| id.clone())
            .collect();
        for id in tunnels {
            self.close_tunnel(&id, true);
        }
    }
    pub fn shutdown(&self) {
        self.webview.stop();
        let ids: Vec<_> = self.sources.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.close_source(&id);
        }
    }
    pub async fn dial_relay(&self, pipe: String, address: &str) -> Result<()> {
        let addr: libp2p::Multiaddr = address.parse().map_err(|_| "Invalid address")?;
        let peer = addr
            .iter()
            .find_map(|p| {
                if let libp2p::multiaddr::Protocol::P2p(id) = p {
                    Some(id.to_string())
                } else {
                    None
                }
            })
            .ok_or("Missing peer")?;
        let source = self
            .sources
            .lock()
            .unwrap()
            .iter()
            .find(|(_, s)| {
                s.permitted
                    && s.peers.lock().unwrap().get(&peer) == Some(&true)
                    && address.starts_with(&format!("/dns4/{}.relay.hummingbird.invalid/", s.name))
            })
            .map(|(id, _)| id.clone())
            .ok_or("暂时无法联系这台设备")?;
        let session = uuid::Uuid::new_v4().to_string();
        self.new_tunnel(&source, &peer, &session, pipe, false)?;
        self.packet(
            &source,
            json!({"type":"tunnel","to":peer,"session":session,"data":{"kind":"open"}}),
        )
        .await
    }
    fn new_tunnel(
        &self,
        source: &str,
        peer: &str,
        session: &str,
        pipe: String,
        accepted: bool,
    ) -> Result<()> {
        let key = tunnel_key(source, peer, session);
        let (tx, mut rx) = mpsc::channel::<(u32, Vec<u8>)>(8);
        let tunnel = Arc::new(Tunnel {
            source: source.into(),
            peer: peer.into(),
            session: session.into(),
            pipe,
            input: tx,
            credit: AtomicU32::new(8),
            notify: Notify::new(),
            accepted: AtomicBool::new(accepted),
            pipe_attached: AtomicBool::new(false),
            cancel: CancellationToken::new(),
        });
        {
            let mut tunnels = self.tunnels.lock().unwrap();
            let pending = tunnels
                .values()
                .filter(|t| {
                    !t.pipe_attached.load(Ordering::Relaxed) || !t.accepted.load(Ordering::Relaxed)
                })
                .count();
            if pending >= 16 || tunnels.contains_key(&key) {
                return Err("连接过多".into());
            }
            tunnels.insert(key.clone(), tunnel.clone());
        }
        let network = self.clone();
        tokio::spawn(async move {
            let work = async {
                let (io, closed) = network.pipes.endpoint(&tunnel.pipe).await?;
                tunnel.pipe_attached.store(true, Ordering::Relaxed);
                let (mut reader, mut writer) = tokio::io::split(io);
                let send = async {
                    let mut bytes = vec![0; 16384];
                    let mut seq = 0u32;
                    loop {
                        tokio::time::timeout(Duration::from_secs(25), async {
                            loop {
                                let wake = tunnel.notify.notified();
                                if tunnel.accepted.load(Ordering::SeqCst)
                                    && tunnel.credit.load(Ordering::SeqCst) > 0
                                {
                                    break;
                                }
                                wake.await;
                            }
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                        let n = reader.read(&mut bytes).await.map_err(|e| e.to_string())?;
                        if n == 0 {
                            break;
                        }
                        let a = tunnel.peer.as_bytes();
                        let b = tunnel.session.as_bytes();
                        let mut frame = Vec::with_capacity(10 + a.len() + b.len() + n);
                        frame.extend_from_slice(b"KIM2");
                        frame.push(a.len() as u8);
                        frame.push(b.len() as u8);
                        frame.extend_from_slice(&seq.to_be_bytes());
                        frame.extend_from_slice(a);
                        frame.extend_from_slice(b);
                        frame.extend_from_slice(&bytes[..n]);
                        tunnel.credit.fetch_sub(1, Ordering::SeqCst);
                        seq = seq.wrapping_add(1);
                        network
                            .source(&tunnel.source)?
                            .send
                            .send(Message::Binary(frame.into()))
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    Ok::<_, String>(())
                };
                let receive = async {
                    let mut expected = 0u32;
                    while let Some((seq, bytes)) = rx.recv().await {
                        if seq != expected {
                            return Err("Invalid tunnel sequence".into());
                        }
                        expected = expected.wrapping_add(1);
                        writer.write_all(&bytes).await.map_err(|e| e.to_string())?;
                        network.packet(&tunnel.source, json!({"type":"tunnel","to":tunnel.peer,"session":tunnel.session,"data":{"kind":"credit","count":1}})).await?;
                    }
                    Ok::<_, String>(())
                };
                tokio::select! { r = send => r, r = receive => r, _ = closed.cancelled() => Ok(()) }
            };
            tokio::select! { _ = work => {}, _ = tunnel.cancel.cancelled() => {} }
            network.close_tunnel(&key, true);
        });
        Ok(())
    }
    async fn tunnel_packet(&self, source_id: &str, source: &Source, packet: &Value) -> Result<()> {
        let peer = text(packet, "from")?;
        let session = text(packet, "session")?;
        if session.len() > 64 || peer.len() > 128 {
            return Err("Invalid tunnel".into());
        }
        let key = tunnel_key(source_id, peer, session);
        let kind = packet["data"]["kind"].as_str().unwrap_or("");
        if kind == "open" {
            if !source.permitted || source.peers.lock().unwrap().get(peer) != Some(&true) {
                return Ok(());
            }
            if self.tunnels.lock().unwrap().contains_key(&key) {
                return Ok(());
            }
            let address = format!(
                "/dns4/{}.relay.hummingbird.invalid/tcp/443/wss/p2p/{peer}",
                source.name
            )
            .parse()
            .map_err(|_| "Invalid peer")?;
            let pipe = self.pipes.accept(address)?;
            if let Err(error) = self.new_tunnel(source_id, peer, session, pipe.clone(), true) {
                self.pipes.close(&pipe);
                return Err(error);
            }
            self.packet(
                source_id,
                json!({"type":"tunnel","to":peer,"session":session,"data":{"kind":"accept"}}),
            )
            .await?;
        } else {
            let tunnel = self.tunnels.lock().unwrap().get(&key).cloned();
            if let Some(t) = tunnel {
                match kind {
                    "accept" if !t.accepted.swap(true, Ordering::SeqCst) => {
                        self.pipes.ready(&t.pipe);
                        t.notify.notify_one();
                    }
                    "credit" => {
                        let count = packet["data"]["count"]
                            .as_u64()
                            .filter(|n| *n > 0 && *n <= 8);
                        if let Some(count) = count
                            && t.grant_credit(count as u32)
                        {
                            t.notify.notify_one();
                            return Ok(());
                        }
                        self.close_tunnel(&key, true);
                    }
                    "close" => self.close_tunnel(&key, false),
                    _ => self.close_tunnel(&key, true),
                }
            }
        }
        Ok(())
    }
    fn binary(&self, source: &str, bytes: &[u8]) -> Result<()> {
        if bytes.len() < 10 || &bytes[..4] != b"KIM2" {
            return Err("Invalid tunnel".into());
        }
        let a = bytes[4] as usize;
        let b = bytes[5] as usize;
        if bytes.len() <= 10 + a + b || bytes.len() > 10 + a + b + 16384 {
            return Err("Invalid tunnel".into());
        }
        let peer = std::str::from_utf8(&bytes[10..10 + a]).map_err(|e| e.to_string())?;
        let session = std::str::from_utf8(&bytes[10 + a..10 + a + b]).map_err(|e| e.to_string())?;
        let key = tunnel_key(source, peer, session);
        let tunnel = self.tunnels.lock().unwrap().get(&key).cloned();
        if let Some(t) = tunnel {
            let sequence = u32::from_be_bytes(bytes[6..10].try_into().unwrap());
            if t.input
                .try_send((sequence, bytes[10 + a + b..].to_vec()))
                .is_err()
            {
                self.close_tunnel(&key, true);
            }
        }
        Ok(())
    }
    fn close_tunnel(&self, key: &str, notify: bool) {
        let tunnel = self.tunnels.lock().unwrap().remove(key);
        if let Some(t) = tunnel {
            t.cancel.cancel();
            self.pipes.close(&t.pipe);
            if notify && let Ok(s) = self.source(&t.source) {
                let _ = s.send.try_send(Message::Text(json!({"type":"tunnel","to":t.peer,"session":t.session,"data":{"kind":"close"}}).to_string()));
            }
        }
    }
    pub(super) async fn stream_offer(
        &self,
        peer: libp2p::PeerId,
        mut stream: libp2p::swarm::Stream,
    ) -> Result<()> {
        let data = super::health::read(&mut stream, 160 * 1024)
            .await
            .map_err(|e| e.to_string())?;
        if data["description"]["type"] != "offer" {
            return Err("Invalid RTC offer".into());
        }
        let session = text(&data, "session")?;
        let response = self
            .webview
            .request(
                &peer.to_string(),
                session,
                "offer",
                &serde_json::to_vec(&data).map_err(|e| e.to_string())?,
            )
            .await?;
        let answer = serde_json::from_slice(&response).map_err(|e| e.to_string())?;
        super::health::write(&mut stream, &answer)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn exchange_offer(&self, peer: &str, offer: &Value) -> Result<Value> {
        let peer: libp2p::PeerId = peer.parse().map_err(|_| "Invalid peer")?;
        let mut stream = self
            .signal_streams
            .lock()
            .unwrap()
            .remove(&peer)
            .ok_or("Signal stream closed")?;
        super::health::write(&mut stream, offer)
            .await
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(
            Duration::from_secs(15),
            super::health::read(&mut stream, 160 * 1024),
        )
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use rustls::{
        client::danger::ServerCertVerifier,
        pki_types::{CertificateDer, ServerName, UnixTime},
    };
    /// Verifies an existing development certificate against OS trust, without
    /// relying on per-executable LAN permissions or installing a test CA.
    #[test]
    #[ignore = "set P2P_TLS_CERT (DER file) and P2P_TLS_HOST for an OS-trusted development certificate"]
    fn system_trusted_wss_certificate_and_hostname() {
        let certificate =
            CertificateDer::from(std::fs::read(std::env::var("P2P_TLS_CERT").unwrap()).unwrap());
        let host = ServerName::try_from(std::env::var("P2P_TLS_HOST").unwrap()).unwrap();
        let verifier = rustls_platform_verifier::Verifier::new(std::sync::Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .unwrap();
        verifier
            .verify_server_cert(&certificate, &[], &host, &[], UnixTime::now())
            .unwrap();
        let other = ServerName::try_from("unrelated.example.invalid").unwrap();
        assert!(
            verifier
                .verify_server_cert(&certificate, &[], &other, &[], UnixTime::now())
                .is_err()
        );
    }
}
