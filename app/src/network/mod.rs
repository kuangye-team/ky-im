pub mod frame;
#[path = "../../../shared/network_signal.rs"]
mod network_signal;
pub use network_signal::TcpEndpoint;

use base64::{Engine, engine::general_purpose::STANDARD};
use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Semaphore, mpsc, oneshot},
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SERVICE: &str = "_hummingbird._tcp.local.";
const MAX_PEERS: usize = 256;
const IO_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub bio: String,
    pub color: String,
    pub avatar: String,
    pub device: String,
    #[serde(rename = "clientType")]
    pub client_type: ClientType,
}

#[path = "../../../shared/client_type.rs"]
mod client_type;
pub use client_type::ClientType;

impl Profile {
    pub fn validate(&self) -> Result<()> {
        let count = |s: &str| s.encode_utf16().count();
        if Uuid::parse_str(&self.id).is_err()
            || self.name.trim().is_empty()
            || count(&self.name) > 40
            || count(&self.bio) > 160
            || self.avatar.is_empty()
            || count(&self.avatar) > 16
            || count(&self.device) > 64
            || self.color.len() != 7
            || !self.color.starts_with('#')
            || !self.color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid device profile".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum NetworkEvent {
    Peer {
        profile: Profile,
    },
    Left {
        peer_id: String,
    },
    Open {
        peer_id: String,
        connection_id: String,
    },
    Data {
        peer_id: String,
        connection_id: String,
        kind: u8,
        data: Vec<u8>,
    },
    Closed {
        peer_id: String,
        connection_id: String,
    },
    Signal {
        peer_id: String,
        data: serde_json::Value,
    },
    Error,
}

#[derive(Clone)]
struct Peer {
    profile: Profile,
    instance: String,
    fullname: String,
    addresses: Vec<SocketAddr>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    version: u8,
    from: String,
    to: String,
    instance: String,
    target_instance: String,
    connection_id: String,
    request: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    signal: bool,
}

struct WriteFrame {
    kind: u8,
    bytes: Vec<u8>,
    done: oneshot::Sender<Result<()>>,
}

struct Connection {
    id: String,
    stop: CancellationToken,
    writer: mpsc::Sender<WriteFrame>,
    consumed: Arc<Semaphore>,
}

struct PendingConnection {
    id: Uuid,
    cancel: CancellationToken,
}

pub struct LanNode {
    profile: Mutex<Profile>,
    room: String,
    instance: String,
    port: u16,
    mdns: Option<ServiceDaemon>,
    tcp_enabled: bool,
    fullname: String,
    peers: Mutex<HashMap<String, Peer>>,
    remote_peers: Mutex<HashMap<String, Peer>>,
    connections: Mutex<HashMap<String, Connection>>,
    connecting: Mutex<HashMap<String, PendingConnection>>,
    handshakes: Arc<Semaphore>,
    stop: CancellationToken,
    emit: Arc<dyn Fn(NetworkEvent) + Send + Sync>,
}

impl LanNode {
    pub async fn start(
        profile: Profile,
        room: String,
        emit: impl Fn(NetworkEvent) + Send + Sync + 'static,
    ) -> Result<Arc<Self>> {
        Self::start_configured(profile, room, true, true, emit).await
    }

    pub async fn start_configured(
        profile: Profile,
        room: String,
        discover: bool,
        tcp_enabled: bool,
        emit: impl Fn(NetworkEvent) + Send + Sync + 'static,
    ) -> Result<Arc<Self>> {
        profile.validate()?;
        if room.is_empty() || room.len() > 128 {
            return Err("Invalid discovery namespace".into());
        }
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let instance = Uuid::new_v4().to_string();
        let info = service_info(&profile, &room, &instance, port)?;
        let fullname = info.get_fullname().to_owned();
        let (mdns, browse) = if discover {
            let mdns = ServiceDaemon::new().map_err(|e| e.to_string())?;
            let setup = mdns.register(info).and_then(|_| mdns.browse(SERVICE));
            match setup {
                Ok(browse) => (Some(mdns), Some(browse)),
                Err(e) => {
                    let _ = mdns.shutdown();
                    return Err(e.to_string());
                }
            }
        } else {
            (None, None)
        };
        let node = Arc::new(Self {
            profile: Mutex::new(profile),
            room,
            instance,
            port,
            mdns,
            tcp_enabled,
            fullname,
            peers: Mutex::new(HashMap::new()),
            remote_peers: Mutex::new(HashMap::new()),
            connections: Mutex::new(HashMap::new()),
            connecting: Mutex::new(HashMap::new()),
            handshakes: Arc::new(Semaphore::new(16)),
            stop: CancellationToken::new(),
            emit: Arc::new(emit),
        });
        if let Some(browse) = browse {
            let current = node.clone();
            tokio::spawn(async move {
                let mut verify = tokio::time::interval(Duration::from_secs(30));
                loop {
                    tokio::select! {
                        _ = current.stop.cancelled() => break,
                        _ = verify.tick() => {
                            for peer in current.peers.lock().unwrap().values() {
                                let _ = current.mdns.as_ref().unwrap().verify(peer.fullname.clone(), Duration::from_secs(10));
                            }
                        },
                        event = browse.recv_async() => match event {
                            Ok(ServiceEvent::ServiceResolved(info)) => current.discovered(&info),
                            Ok(ServiceEvent::ServiceRemoved(_, name)) => current.removed(&name),
                            Err(_) => { (current.emit)(NetworkEvent::Error); break; }
                            _ => {}
                        }
                    }
                }
            });
        }
        let current = node.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = current.stop.cancelled() => break,
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => {
                            let Ok(permit) = current.handshakes.clone().try_acquire_owned() else { continue; };
                            let receiver = current.clone();
                            tokio::spawn(async move {
                                let _permit = permit;
                                tokio::select! {
                                    _ = receiver.stop.cancelled() => {},
                                    _ = timeout(CONNECT_TIMEOUT, receiver.accept(stream)) => {},
                                }
                            });
                        }
                        Err(_) => { (current.emit)(NetworkEvent::Error); break; }
                    }
                }
            }
        });
        Ok(node)
    }

    fn discovered(&self, service: &ResolvedService) {
        let Some(peer) = parse_service(service, &self.room) else {
            return;
        };
        if peer.profile.id == self.profile.lock().unwrap().id {
            return;
        }
        let id = peer.profile.id.clone();
        let mut peers = self.peers.lock().unwrap();
        if peers.len() >= MAX_PEERS && !peers.contains_key(&id) {
            return;
        }
        let replaced = peers
            .get(&id)
            .is_some_and(|previous| previous.instance != peer.instance);
        let changed = peers
            .get(&id)
            .is_none_or(|p| p.profile != peer.profile || p.instance != peer.instance);
        peers.insert(id.clone(), peer.clone());
        drop(peers);
        if replaced {
            self.close_peer(&id, None);
        }
        if changed {
            (self.emit)(NetworkEvent::Peer {
                profile: peer.profile,
            });
        }
    }

    fn removed(&self, fullname: &str) {
        let mut peers = self.peers.lock().unwrap();
        let id = peers
            .iter()
            .find(|(_, p)| p.fullname == fullname)
            .map(|(id, _)| id.clone());
        if let Some(id) = id {
            let replacement = self.remote_peers.lock().unwrap().get(&id).cloned();
            if let Some(peer) = replacement {
                peers.insert(id.clone(), peer);
            } else {
                peers.remove(&id);
            }
            let retained = peers.contains_key(&id);
            drop(peers);
            if !retained {
                self.close_peer(&id, None);
            }
            (self.emit)(NetworkEvent::Left { peer_id: id });
        }
    }

    pub fn update_profile(&self, profile: Profile) -> Result<()> {
        profile.validate()?;
        let mut current = self.profile.lock().unwrap();
        if profile.id != current.id {
            return Err("Device identity cannot change during a session".into());
        }
        if let Some(mdns) = &self.mdns {
            mdns.register(service_info(
                &profile,
                &self.room,
                &self.instance,
                self.port,
            )?)
            .map_err(|e| e.to_string())?;
        }
        *current = profile;
        Ok(())
    }

    fn hello(&self, peer: &Peer, connection_id: String, request: bool) -> Hello {
        Hello {
            version: 1,
            from: self.profile.lock().unwrap().id.clone(),
            to: peer.profile.id.clone(),
            instance: self.instance.clone(),
            target_instance: peer.instance.clone(),
            connection_id,
            request,
            signal: false,
        }
    }

    fn validate_hello(&self, hello: &Hello) -> Result<Peer> {
        if hello.version != 1
            || hello.to != self.profile.lock().unwrap().id
            || hello.target_instance != self.instance
            || Uuid::parse_str(&hello.connection_id).is_err()
        {
            return Err("Incompatible peer handshake".into());
        }
        let peer = self
            .peers
            .lock()
            .unwrap()
            .get(&hello.from)
            .cloned()
            .ok_or("Device is not discovered")?;
        if peer.instance != hello.instance {
            return Err("Stale peer session".into());
        }
        Ok(peer)
    }

    async fn accept(self: &Arc<Self>, mut stream: TcpStream) -> Result<()> {
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        let (kind, bytes) = frame::read(&mut stream).await.map_err(|e| e.to_string())?;
        if kind != frame::HELLO {
            return Err("Handshake required".into());
        }
        let hello: Hello = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let peer = self.validate_hello(&hello)?;
        if hello.signal {
            let (kind, bytes) = frame::read(&mut stream).await.map_err(|e| e.to_string())?;
            let data: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if kind != frame::SIGNAL || !network_signal::valid_signal(&data) {
                return Err("Invalid connection negotiation".into());
            }
            (self.emit)(NetworkEvent::Signal {
                peer_id: peer.profile.id,
                data,
            });
            return Ok(());
        }
        if !self.tcp_enabled {
            return Err("TCP transfers disabled".into());
        }
        let local_id = self.profile.lock().unwrap().id.clone();
        // Exactly one device dials the long-lived stream. The other sends a short dial request.
        if hello.request != (hello.from > local_id) {
            return Err("Invalid connection direction".into());
        }
        let response =
            serde_json::to_vec(&self.hello(&peer, hello.connection_id.clone(), hello.request))
                .unwrap();
        frame::write(&mut stream, frame::HELLO, &response)
            .await
            .map_err(|e| e.to_string())?;
        if hello.request {
            let node = self.clone();
            let id = peer.profile.id;
            tokio::spawn(async move {
                let _ = node.connect(&id).await;
            });
        } else {
            self.attach(peer, hello.connection_id, stream)?;
        }
        Ok(())
    }

    pub async fn connect(self: &Arc<Self>, peer_id: &str) -> Result<()> {
        if !self.tcp_enabled {
            return Err("TCP transfers disabled".into());
        }
        if self.stop.is_cancelled() {
            return Err("Session closed".into());
        }
        if self.connections.lock().unwrap().contains_key(peer_id) {
            return Ok(());
        }
        let cancel = self.stop.child_token();
        let attempt_id = Uuid::new_v4();
        {
            let mut pending = self.connecting.lock().unwrap();
            if pending.contains_key(peer_id) {
                return Ok(());
            }
            if pending.len() >= 32 {
                return Err("Too many pending connections".into());
            }
            pending.insert(
                peer_id.to_owned(),
                PendingConnection {
                    id: attempt_id,
                    cancel: cancel.clone(),
                },
            );
        }
        let result = tokio::select! {
            _ = cancel.cancelled() => Err("Connection cancelled".into()),
            result = timeout(Duration::from_secs(12), self.dial(peer_id)) => result.unwrap_or_else(|_| Err("Connection timed out".into())),
        };
        let mut pending = self.connecting.lock().unwrap();
        if pending
            .get(peer_id)
            .is_some_and(|attempt| attempt.id == attempt_id)
        {
            pending.remove(peer_id);
        }
        result
    }

    async fn dial(self: &Arc<Self>, peer_id: &str) -> Result<()> {
        let peer = self
            .peers
            .lock()
            .unwrap()
            .get(peer_id)
            .cloned()
            .ok_or("Device is not discovered")?;
        let local_id = self.profile.lock().unwrap().id.clone();
        let hello = self.hello(
            &peer,
            Uuid::new_v4().to_string(),
            local_id.as_str() > peer_id,
        );
        let request = serde_json::to_vec(&hello).unwrap();
        // Try the discovered interfaces concurrently so an unreachable VPN does not hide the LAN address.
        let mut attempts = tokio::task::JoinSet::new();
        for address in &peer.addresses {
            let address = *address;
            attempts.spawn(async move { TcpStream::connect(address).await });
        }
        let mut connected = None;
        while let Some(result) = attempts.join_next().await {
            if let Ok(Ok(stream)) = result {
                connected = Some(stream);
                break;
            }
        }
        attempts.abort_all();
        let mut stream = connected.ok_or("Cannot reach device")?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        frame::write(&mut stream, frame::HELLO, &request)
            .await
            .map_err(|e| e.to_string())?;
        let (kind, bytes) = frame::read(&mut stream).await.map_err(|e| e.to_string())?;
        if kind != frame::HELLO {
            return Err("Invalid handshake response".into());
        }
        let response: Hello = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        self.validate_hello(&response)?;
        if response.from != peer_id
            || response.connection_id != hello.connection_id
            || response.request != hello.request
        {
            return Err("Handshake identity mismatch".into());
        }
        if !hello.request {
            self.attach(peer, hello.connection_id, stream)?;
        }
        Ok(())
    }

    fn attach(
        self: &Arc<Self>,
        peer: Peer,
        connection_id: String,
        stream: TcpStream,
    ) -> Result<()> {
        if self.stop.is_cancelled() {
            return Err("Session closed".into());
        }
        if self
            .peers
            .lock()
            .unwrap()
            .get(&peer.profile.id)
            .is_none_or(|current| current.instance != peer.instance)
        {
            return Err("Peer session changed during connection".into());
        }
        let peer_id = peer.profile.id.clone();
        let stop = self.stop.child_token();
        let consumed = Arc::new(Semaphore::new(0));
        let (writer, mut pending) = mpsc::channel::<WriteFrame>(16);
        {
            let mut connections = self.connections.lock().unwrap();
            if connections.contains_key(&peer_id) {
                return Err("Already connected".into());
            }
            if connections.len() >= 64 {
                return Err("Too many connections".into());
            }
            connections.insert(
                peer_id.clone(),
                Connection {
                    id: connection_id.clone(),
                    stop: stop.clone(),
                    writer,
                    consumed: consumed.clone(),
                },
            );
        }
        (self.emit)(NetworkEvent::Open {
            peer_id: peer_id.clone(),
            connection_id: connection_id.clone(),
        });
        let (mut reader, mut writer) = stream.into_split();
        let node = self.clone();
        tokio::spawn(async move {
            let receive = async {
                loop {
                    let (kind, bytes) =
                        frame::read(&mut reader).await.map_err(|e| e.to_string())?;
                    if kind != frame::TEXT && kind != frame::BINARY {
                        return Err::<(), String>("Unexpected handshake".into());
                    }
                    (node.emit)(NetworkEvent::Data {
                        peer_id: peer_id.clone(),
                        connection_id: connection_id.clone(),
                        kind,
                        data: bytes,
                    });
                    // One outstanding incoming frame per peer; the engine returns credit after storage finishes.
                    let credit = timeout(IO_TIMEOUT, consumed.acquire())
                        .await
                        .map_err(|_| "Receive timed out")?
                        .map_err(|_| "Connection closed")?;
                    credit.forget();
                }
            };
            let send = async {
                while let Some(packet) = pending.recv().await {
                    let result = timeout(
                        IO_TIMEOUT,
                        frame::write(&mut writer, packet.kind, &packet.bytes),
                    )
                    .await
                    .map_err(|_| "Send timed out".to_owned())
                    .and_then(|r| r.map_err(|e| e.to_string()));
                    let failed = result.is_err();
                    let _ = packet.done.send(result);
                    if failed {
                        break;
                    }
                }
            };
            tokio::select! { _ = stop.cancelled() => {}, _ = receive => {}, _ = send => {} }
            node.close_peer(&peer_id, Some(&connection_id));
        });
        Ok(())
    }

    pub async fn send(
        &self,
        peer_id: &str,
        connection_id: &str,
        kind: u8,
        bytes: Vec<u8>,
    ) -> Result<()> {
        if ![frame::TEXT, frame::BINARY].contains(&kind) {
            return Err("Invalid payload kind".into());
        }
        frame::validate(kind, &bytes).map_err(|e| e.to_string())?;
        let writer = self
            .connections
            .lock()
            .unwrap()
            .get(peer_id)
            .filter(|c| c.id == connection_id)
            .map(|c| c.writer.clone())
            .ok_or("Connection closed")?;
        let (done, result) = oneshot::channel();
        timeout(IO_TIMEOUT, async {
            writer
                .send(WriteFrame { kind, bytes, done })
                .await
                .map_err(|_| "Connection closed")?;
            result.await.map_err(|_| "Connection closed")?
        })
        .await
        .map_err(|_| "Send timed out".to_owned())?
    }

    pub fn consumed(&self, peer_id: &str, connection_id: &str) {
        if let Some(connection) = self
            .connections
            .lock()
            .unwrap()
            .get(peer_id)
            .filter(|c| c.id == connection_id)
            && connection.consumed.available_permits() == 0
        {
            connection.consumed.add_permits(1);
        }
    }

    pub fn close_peer(&self, peer_id: &str, connection_id: Option<&str>) {
        if connection_id.is_none()
            && let Some(cancel) = self.connecting.lock().unwrap().remove(peer_id)
        {
            cancel.cancel.cancel();
        }
        let mut connections = self.connections.lock().unwrap();
        if connections
            .get(peer_id)
            .is_some_and(|c| connection_id.is_none_or(|id| c.id == id))
        {
            let connection = connections.remove(peer_id).unwrap();
            connection.stop.cancel();
            drop(connections);
            (self.emit)(NetworkEvent::Closed {
                peer_id: peer_id.to_owned(),
                connection_id: connection.id,
            });
        }
    }

    pub fn endpoint(&self) -> Result<TcpEndpoint> {
        let addresses = if_addrs::get_if_addrs()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|interface| match interface.ip() {
                std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
                _ => None,
            })
            .take(16)
            .collect();
        Ok(TcpEndpoint {
            instance: self.instance.clone(),
            port: self.port,
            addresses,
        })
    }

    pub fn register_peer(&self, profile: Profile, endpoint: TcpEndpoint) -> Result<()> {
        profile.validate()?;
        if !endpoint.validate()
            || Uuid::parse_str(&endpoint.instance).is_err()
            || profile.id == self.profile.lock().unwrap().id
        {
            return Err("Invalid peer address".into());
        }
        let mut peers = self.peers.lock().unwrap();
        if peers.len() >= MAX_PEERS && !peers.contains_key(&profile.id) {
            return Err("Too many devices".into());
        }
        let peer = Peer {
            profile,
            instance: endpoint.instance,
            fullname: String::new(),
            addresses: endpoint
                .addresses
                .into_iter()
                .map(|ip| SocketAddr::from((ip, endpoint.port)))
                .collect(),
        };
        let peer_id = peer.profile.id.clone();
        let replaced = peers
            .get(&peer_id)
            .is_some_and(|previous| previous.instance != peer.instance);
        self.remote_peers
            .lock()
            .unwrap()
            .insert(peer.profile.id.clone(), peer.clone());
        // Keep mDNS's interface addresses when both sources describe the same session.
        if peers
            .get(&peer.profile.id)
            .is_none_or(|p| p.instance != peer.instance || p.fullname.is_empty())
        {
            peers.insert(peer.profile.id.clone(), peer);
        }
        drop(peers);
        if replaced {
            self.close_peer(&peer_id, None);
        }
        Ok(())
    }

    pub fn forget_peer(&self, peer_id: &str) {
        self.peers.lock().unwrap().remove(peer_id);
        self.remote_peers.lock().unwrap().remove(peer_id);
        self.close_peer(peer_id, None);
    }

    /// A short, validated negotiation exchange, independent of the content transfer setting.
    pub async fn signal(&self, peer_id: &str, data: serde_json::Value) -> Result<()> {
        if !network_signal::valid_signal(&data) {
            return Err("Invalid connection negotiation".into());
        }
        let peer = self
            .peers
            .lock()
            .unwrap()
            .get(peer_id)
            .cloned()
            .ok_or("Device is not discovered")?;
        let mut hello = self.hello(&peer, Uuid::new_v4().to_string(), false);
        hello.signal = true;
        let header = serde_json::to_vec(&hello).unwrap();
        let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
        timeout(CONNECT_TIMEOUT, async {
            let mut attempts = tokio::task::JoinSet::new();
            for address in peer.addresses {
                attempts.spawn(async move { TcpStream::connect(address).await });
            }
            while let Some(result) = attempts.join_next().await {
                if let Ok(Ok(mut stream)) = result {
                    attempts.abort_all();
                    frame::write(&mut stream, frame::HELLO, &header)
                        .await
                        .map_err(|e| e.to_string())?;
                    return frame::write(&mut stream, frame::SIGNAL, &bytes)
                        .await
                        .map_err(|e| e.to_string());
                }
            }
            Err("Cannot reach device".into())
        })
        .await
        .map_err(|_| "Connection timed out")?
    }

    pub fn shutdown(&self) {
        self.stop.cancel();
        if let Some(mdns) = &self.mdns {
            let _ = mdns.unregister(&self.fullname);
            let _ = mdns.stop_browse(SERVICE);
            let _ = mdns.shutdown();
        }
        self.connections.lock().unwrap().clear();
        self.peers.lock().unwrap().clear();
        self.remote_peers.lock().unwrap().clear();
    }
}

fn service_info(profile: &Profile, room: &str, instance: &str, port: u16) -> Result<ServiceInfo> {
    let encoded = STANDARD.encode(serde_json::to_vec(profile).map_err(|e| e.to_string())?);
    let mut properties = HashMap::from([
        ("version".to_owned(), "1".to_owned()),
        ("room".to_owned(), room.to_owned()),
        ("instance".to_owned(), instance.to_owned()),
        ("parts".to_owned(), encoded.len().div_ceil(200).to_string()),
    ]);
    for (index, chunk) in encoded.as_bytes().chunks(200).enumerate() {
        properties.insert(
            format!("p{index}"),
            std::str::from_utf8(chunk).unwrap().to_owned(),
        );
    }
    ServiceInfo::new(
        SERVICE,
        instance,
        &format!("hummingbird-{instance}.local."),
        "",
        port,
        properties,
    )
    .map(|info| info.enable_addr_auto())
    .map_err(|e| e.to_string())
}

fn parse_service(info: &ResolvedService, room: &str) -> Option<Peer> {
    if info.get_property_val_str("version") != Some("1")
        || info.get_property_val_str("room") != Some(room)
        || info.get_port() == 0
    {
        return None;
    }
    let instance = info.get_property_val_str("instance")?.to_owned();
    Uuid::parse_str(&instance).ok()?;
    let parts: usize = info.get_property_val_str("parts")?.parse().ok()?;
    if parts == 0 || parts > 20 {
        return None;
    }
    let mut encoded = String::new();
    for i in 0..parts {
        let chunk = info.get_property_val_str(&format!("p{i}"))?;
        if chunk.len() > 200 {
            return None;
        }
        encoded.push_str(chunk);
    }
    let profile: Profile = serde_json::from_slice(&STANDARD.decode(encoded).ok()?).ok()?;
    profile.validate().ok()?;
    let addresses: Vec<_> = info
        .get_addresses_v4()
        .into_iter()
        .filter(|ip| !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast())
        .take(16)
        .map(|ip| SocketAddr::from((ip, info.get_port())))
        .collect();
    if addresses.is_empty() {
        return None;
    }
    Some(Peer {
        profile,
        instance,
        fullname: info.get_fullname().to_owned(),
        addresses,
    })
}

#[cfg(test)]
mod tests;
