mod addresses;
mod bulk;
mod webtransport;
mod webview;
use crate::capabilities::{capability, known_capabilities};
use webview::WebviewSession;
#[cfg(test)]
mod connection_tests;
mod credit;
pub mod files;
mod health;
pub mod ipc;
pub mod metrics;
pub mod network;
mod rtc_signal;
#[cfg(any(target_os = "macos", windows))]
mod send_activity;
mod streams;
pub mod transport;
use futures::{AsyncReadExt, AsyncWriteExt, StreamExt};
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, SwarmBuilder, Transport, identify, identity, noise,
    swarm::{ConnectionId, Stream, SwarmEvent, dial_opts::DialOpts},
    yamux,
};
use mdns_sd::{ScopedIp, ServiceDaemon, ServiceEvent, ServiceInfo};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use transport::{ByteTransport, Pipes};

const CHAT: &str = "/hummingbird/chat/2.0.0";
const FILE: &str = "/hummingbird/file/2.0.0";
const RTC_SIGNAL: StreamProtocol = StreamProtocol::new("/hummingbird/rtc-signal/2.0.0");
const SERVICE: &str = "_hummingbird-v2._tcp.local.";
const FRAME_LIMIT: usize = files::MAX_CHUNK + files::CHUNK_HEADER;
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;
pub type EmitData = Arc<dyn Fn(Value, &[u8]) + Send + Sync>;

/// The small JSON header routes a raw payload without serializing each byte.
pub fn encode_data(header: Value, data: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(&header).expect("event header");
    let mut frame = Vec::with_capacity(4 + header.len() + data.len());
    frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(data);
    frame
}
// The derive generates handler calls for the connection limiter's Infallible events.
#[allow(unreachable_code)]
mod behaviour {
    use super::{identify, rtc_signal, streams};
    use libp2p::swarm::NetworkBehaviour;

    #[derive(NetworkBehaviour)]
    pub(super) struct Behaviour {
        pub(super) limits: libp2p::connection_limits::Behaviour,
        pub(super) streams: streams::Behaviour,
        pub(super) rtc_signal: rtc_signal::Behaviour,
        pub(super) identify: identify::Behaviour,
    }
}
use behaviour::{Behaviour, BehaviourEvent};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerHealth {
    round_trip_ms: f64,
    age_ms: f64,
}
#[derive(Clone, Copy)]
enum FileRoute {
    Ordered,
    TryBulk,
}

struct WriteRequest {
    frame: Vec<u8>,
    route: FileRoute,
    reply: oneshot::Sender<Result<(), String>>,
}
type ReceiveCredits = HashMap<String, (String, Arc<credit::ReceiveCredit>)>;
type Writers = Arc<Mutex<HashMap<(String, String), (mpsc::Sender<WriteRequest>, String)>>>;
#[derive(Clone)]
pub struct Node {
    pub network: network::Network,
    local: Arc<Mutex<Value>>,
    pub files: files::Files,
    pub emit: Emit,
    commands: mpsc::Sender<Command>,
    pub pipes: Pipes,
    pub metrics: metrics::Metrics,
    writers: Writers,
    rtc_routes: Arc<Mutex<HashMap<ConnectionId, WebviewSession>>>,
    active: Arc<Mutex<HashMap<PeerId, ConnectionId>>>,
    consumed: Arc<Mutex<ReceiveCredits>>,
    cancel: CancellationToken,
    emit_data: EmitData,
}
enum Command {
    Register {
        peer: PeerId,
        profile: Value,
        addresses: Vec<Multiaddr>,
        source: String,
    },
    Forget {
        peer: PeerId,
        source: String,
    },
    Open(PeerId, ConnectionId, streams::Open),
    Reject(PeerId, ConnectionId),
    Connect(PeerId, String),
    Publish(Value),
    Ping(PeerId, String, oneshot::Sender<Result<PeerHealth, String>>),
    Close {
        peer: PeerId,
        attempt: Option<String>,
        physical: Option<String>,
        retire_peer: bool,
        done: oneshot::Sender<()>,
    },
}
#[derive(Default)]
pub struct ListenOptions {
    pub mdns: bool,
    pub tcp: bool,
    pub announce_loopback: bool,
}

impl ListenOptions {
    pub fn from_request(request: &Value, default_mdns: bool) -> Self {
        Self {
            mdns: request["mdns"].as_bool().unwrap_or(default_mdns),
            tcp: request["tcp"].as_bool().unwrap_or(true),
            announce_loopback: request["announceLoopback"].as_bool().unwrap_or(false),
        }
    }
}

impl Node {
    pub async fn start(
        key: Vec<u8>,
        profile: Value,
        room: String,
        listen: ListenOptions,
        emit: Emit,
        emit_data: EmitData,
    ) -> Result<Self, String> {
        // libp2p and native WSS can enable different rustls providers transitively.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let keys = identity::Keypair::from_protobuf_encoding(&key).map_err(|e| e.to_string())?;
        let local = keys.public().to_peer_id();
        if profile["id"].as_str() != Some(&local.to_string()) {
            return Err("Invalid local identity".into());
        }
        let ListenOptions {
            mdns: discover,
            tcp,
            announce_loopback,
        } = listen;
        let metrics = metrics::Metrics::default();
        let (transport, pipes) =
            ByteTransport::new(emit.clone(), emit_data.clone(), metrics.clone());
        let mut swarm = SwarmBuilder::with_existing_identity(keys)
            .with_tokio()
            .with_tcp(
                libp2p::tcp::Config::default().nodelay(true),
                noise::Config::new,
                yamux::Config::default,
            )
            .map_err(|e| e.to_string())?
            .with_quic()
            .with_other_transport(webtransport::BrowserListener::new)
            .map_err(|e| e.to_string())?
            .with_other_transport(|key| {
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(
                    transport
                        .upgrade(libp2p::core::upgrade::Version::V1Lazy)
                        .authenticate(noise::Config::new(key)?)
                        .multiplex(yamux::Config::default()),
                )
            })
            .map_err(|e| e.to_string())?
            .with_behaviour(|key| Behaviour {
                limits: libp2p::connection_limits::Behaviour::new(
                    libp2p::connection_limits::ConnectionLimits::default()
                        .with_max_pending_incoming(Some(32))
                        .with_max_pending_outgoing(Some(4))
                        .with_max_established(Some(64))
                        .with_max_established_per_peer(Some(2)),
                ),
                streams: Default::default(),
                rtc_signal: Default::default(),
                identify: identify::Behaviour::new(identify::Config::new(
                    "/hummingbird/2.0.0".into(),
                    key.public(),
                )),
            })
            .unwrap_or_else(|never| match never {})
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(120)))
            .build();
        swarm
            .listen_on(
                "/dns4/listener.relay.hummingbird.invalid/tcp/443/wss"
                    .parse()
                    .unwrap(),
            )
            .map_err(|e| e.to_string())?;
        if tcp {
            for addr in [
                "/ip4/0.0.0.0/tcp/0",
                "/ip6/::/tcp/0",
                "/ip4/0.0.0.0/udp/0/quic-v1",
                "/ip6/::/udp/0/quic-v1",
                "/ip4/0.0.0.0/udp/0/quic-v1/webtransport",
                "/ip6/::/udp/0/quic-v1/webtransport",
            ] {
                let _ = swarm.listen_on(addr.parse().unwrap());
            }
        }
        let (commands, mut rx) = mpsc::channel(256);
        let node = Self {
            local: Arc::new(Mutex::new(profile.clone())),
            network: network::Network::new(pipes.clone(), emit.clone(), emit_data.clone()),
            files: Default::default(),
            emit: emit.clone(),
            commands,
            metrics,
            pipes,
            writers: Default::default(),
            rtc_routes: Default::default(),
            active: Default::default(),
            consumed: Default::default(),
            cancel: CancellationToken::new(),
            emit_data,
        };
        let (pings, incoming_pings) = futures::channel::mpsc::channel(64);
        tokio::spawn(health::listen(incoming_pings, node.clone()));
        let service = if discover {
            ServiceDaemon::new().ok()
        } else {
            None
        };
        if let Some(service) = &service {
            let events = service.browse(SERVICE).map_err(|e| e.to_string())?;
            let commands = node.commands.clone();
            let room = room.clone();
            let emit = emit.clone();
            let cancel = node.cancel.clone();
            tokio::spawn(async move {
                let mut known = HashMap::new();
                loop {
                    tokio::select! {
                        _=cancel.cancelled()=>break,
                        event=events.recv_async()=>match event{
                            Ok(ServiceEvent::ServiceResolved(info))=>{
                                if info.get_property_val_str("room")!=Some(&room){continue;}
                                let Some(peer)=info.get_property_val_str("peer").and_then(|s|s.parse::<PeerId>().ok()) else{continue;};if peer==local{continue;}
                                let Some(profile)=decode_mdns(&info)else{continue;};
                                let addresses=info.get_addresses().iter().filter_map(|ip|match ip{
                                    ScopedIp::V4(ip)=>format!("/ip4/{}/tcp/{}/p2p/{peer}",ip.addr(),info.get_port()).parse::<Multiaddr>().ok(),
                                    ScopedIp::V6(ip)=>format!("/ip6/{}/tcp/{}/p2p/{peer}",ip.addr(),info.get_port()).parse::<Multiaddr>().ok(),
                                    _=>None,
                                }).collect::<Vec<_>>();
                                // A restarted peer can announce before its old mDNS record expires.
                                let instance = (peer, info.get_port(), info.get_property_val_str("instance").unwrap_or_default().to_owned());
                                let name = info.get_fullname();
                                let joined = known.get(name) != Some(&instance);
                                known.insert(name.to_owned(), instance);
                                let _=commands.send(Command::Register{peer,profile:profile.clone(),addresses,source:"mdns".into()}).await;
                                emit(json!({"type":"peer","profile":profile,"source":"mdns","joined":joined}));
                            }
                            Ok(ServiceEvent::ServiceRemoved(_,name))=>{if let Some((peer, _, _))=known.remove(&name){let _=commands.send(Command::Forget{peer,source:"mdns".into()}).await;emit(json!({"type":"left","peerId":peer.to_string(),"source":"mdns"}));}}
                            Err(_)=>break,_=>{}
                        }
                    }
                }
            });
        }
        let handle = node.clone();
        tokio::spawn(async move {
            let mut latest = profile;
            let mut visible: HashMap<PeerId, HashSet<String>> = HashMap::new();
            let mut mdns = MdnsAdvertisement {
                room,
                instance: uuid::Uuid::new_v4().to_string(),
                addresses: None,
            };
            let mut addresses: Vec<Multiaddr> = Vec::new();
            let mut dialed = HashMap::<PeerId, ConnectionId>::new();
            let mut paths = HashMap::<ConnectionId, PeerId>::new();
            let mut rounds = HashMap::<PeerId, String>::new();
            let mut retiring = HashSet::<ConnectionId>::new();
            let mut rtc_dials = HashMap::<PeerId, ConnectionId>::new();
            let mut close_waiters: Vec<(HashSet<ConnectionId>, oneshot::Sender<()>)> = Vec::new();
            let mut address_book: HashMap<PeerId, HashMap<String, Vec<Multiaddr>>> = HashMap::new();
            let mut wanted = HashSet::new();
            let mut desktop_rtc = HashSet::new();
            let mut carriers = HashMap::new();
            let mut webtransport_carriers = HashSet::new();
            let mut upgrades = HashMap::new();
            let mut fallback = HashMap::new();
            let mut pings = pings;
            let mut probes = HashMap::<ConnectionId, health::Probe>::new();
            loop {
                let mut pending = Vec::new();
                for (ids, done) in close_waiters.drain(..) {
                    if ids.is_disjoint(&retiring) {
                        let _ = done.send(());
                    } else {
                        pending.push((ids, done));
                    }
                }
                close_waiters = pending;
                for peer in wanted.iter().copied().collect::<Vec<_>>() {
                    if dialed.len() >= 4 {
                        break;
                    }
                    if swarm.is_connected(&peer) {
                        wanted.remove(&peer);
                        continue;
                    }
                    if !visible.contains_key(&peer) || dialed.contains_key(&peer) {
                        continue;
                    }
                    let mut addresses = address_book
                        .get(&peer)
                        .into_iter()
                        .flat_map(|sources| sources.values().flatten())
                        .cloned()
                        .map(network::tag_rtc_address)
                        .collect::<Vec<_>>();
                    if desktop_rtc.contains(&peer) {
                        let rtc = addresses
                            .iter()
                            .find(|a| a.to_string().contains("/webrtc"))
                            .cloned();
                        // A fresh address announcement wakes the elected desktop dialer even if
                        // the previous connection was idle-closed. Both sides can request a link.
                        if rtc.is_some() && local.to_string() > peer.to_string() {
                            wanted.remove(&peer);
                            emit(json!({"type":"request_connect","peerId":peer.to_string()}));
                            continue;
                        }
                        addresses.retain(|a| !a.to_string().contains("/webrtc"));
                        if let Some(rtc) = rtc {
                            if addresses.is_empty() {
                                addresses.push(rtc);
                            } else {
                                fallback.insert(peer, rtc);
                            }
                        }
                    }
                    if addresses.is_empty() {
                        // A connect request may precede the first address announcement.
                        continue;
                    }
                    wanted.remove(&peer);
                    let opts = DialOpts::peer_id(peer).addresses(addresses).build();
                    let id = opts.connection_id();
                    match swarm.dial(opts) {
                        Ok(()) => {
                            dialed.insert(peer, id);
                        }
                        Err(_) => {
                            if let Some(rtc) = fallback.remove(&peer) {
                                let opts = DialOpts::peer_id(peer).addresses(vec![rtc]).build();
                                let id = opts.connection_id();
                                if swarm.dial(opts).is_ok() {
                                    dialed.insert(peer, id);
                                    continue;
                                }
                            }
                            emit(
                                json!({"type":"closed","peerId":peer.to_string(),"attemptId":rounds.remove(&peer)}),
                            );
                        }
                    }
                }
                tokio::select! {
                    _=handle.cancel.cancelled()=>break,
                    command=rx.recv()=>match command{
                        Some(Command::Register{peer,profile,addresses:remote,source})=>{
                            if visible.len()>=256&&!visible.contains_key(&peer){continue;}
                            visible.entry(peer).or_default().insert(source.clone());
                            let remote=remote.into_iter().filter(|address|tcp||address.to_string().contains("hummingbird.invalid")).collect::<Vec<_>>();
                            address_book.entry(peer).or_default().insert(source,remote);
                            if has_capability(&latest["runtime"]["capabilities"], "webrtc")
                                && has_capability(&profile["capabilities"], "app")
                                && has_capability(&profile["capabilities"], "webrtc") {
                                let first = desktop_rtc.insert(peer);
                                if local.to_string() < peer.to_string()
                                    && first && swarm.is_connected(&peer)
                                    && let Some(&connection) = carriers.get(&peer) {
                                    upgrades.insert(peer, connection);
                                    swarm.behaviour_mut().rtc_signal.open(peer, connection);
                                }
                            }
                        }
                        Some(Command::Forget { peer, source }) => {
                            if let Some(sources) = address_book.get_mut(&peer) {
                                sources.remove(&source);
                            }
                            if let Some(sources) = visible.get_mut(&peer) {
                                sources.remove(&source);
                                if sources.is_empty() {
                                    visible.remove(&peer);
                                    desktop_rtc.remove(&peer);
                                    fallback.remove(&peer);
                                }
                            }
                        }
                        Some(Command::Open(peer, id, request)) => {
                            if handle.selected(peer) == Some(id) {
                                swarm.behaviour_mut().streams.open(peer, id, request);
                            }
                        }
                        Some(Command::Reject(peer,id)) => {
                            if handle.selected(peer) == Some(id) { swarm.close_connection(id); }
                        }
                        Some(Command::Connect(peer, attempt)) => {
                            rounds.insert(peer, attempt);
                            wanted.insert(peer);
                        }
                        Some(Command::Close{peer,attempt,physical,retire_peer,done}) => {
                            let owns_round = match attempt.as_ref() {
                                Some(expected) => rounds.get(&peer) == Some(expected),
                                None => retire_peer,
                            };
                            let selected = handle.selected(peer);
                            let owns_route = paths.iter().any(|(id, owner)| *owner == peer &&
                                physical.as_deref() == Some(id.to_string().as_str()) &&
                                selected.is_none_or(|selected| selected == *id));
                            let close_all = retire_peer && (owns_round || owns_route);
                            let mut ids: HashSet<_> = paths.iter()
                                .filter(|(id, owner)| **owner == peer && (close_all ||
                                    physical.as_deref() == Some(id.to_string().as_str())))
                                .map(|(id, _)| *id).collect();
                            if close_all || owns_round && physical.is_none() {
                                wanted.remove(&peer);
                                fallback.remove(&peer);
                                rounds.remove(&peer);
                                if let Some(&id) = dialed.get(&peer) { ids.insert(id); }
                                if let Some(&id) = rtc_dials.get(&peer) { ids.insert(id); }
                            }
                            if close_all { handle.network.close_peer(&peer.to_string()); }
                            for id in &ids {
                                retiring.insert(*id);
                                swarm.close_connection(*id);
                            }
                            close_waiters.push((ids, done));
                        }
                        Some(Command::Publish(profile))=>{
                            let changed = latest["numericId"] != profile["numericId"]
                                || latest["name"] != profile["name"]
                                || latest["runtime"]["clientType"] != profile["runtime"]["clientType"]
                                || latest["runtime"]["capabilities"] != profile["runtime"]["capabilities"];
                            latest = profile;
                            *handle.local.lock().unwrap() = latest.clone();
                            if changed && let Some(service) = &service {
                                mdns.update(service, &latest, &addresses, true);
                            }
                        }
                        Some(Command::Ping(peer, request_id, reply)) => {
                            let Some(id) = handle.selected(peer) else {
                                let _ = reply.send(Err("设备连接已断开".into()));
                                continue;
                            };
                            if probes.get(&id).is_none_or(|p| p.peek().is_some()) {
                                probes.insert(id, health::probe(id, peer, handle.clone(),request_id));
                            }
                            let probe = probes[&id].clone();
                            let cancel = handle.cancel.clone();
                            tokio::spawn(async move {
                                tokio::select! {
                                    _ = cancel.cancelled() => {},
                                    result = probe => { let _ = reply.send(result); }
                                }
                            });
                        }
                        None=>break,
                    },
                    event=swarm.select_next_some()=>match event{
                        SwarmEvent::NewListenAddr{address,..}=>{
                            if addresses.contains(&address) || !addresses::usable(&address, announce_loopback) {continue;}
                            addresses.push(address);
                            emit(json!({"type":"addresses","addresses":announce_addresses(&addresses)}));
                            if let Some(service) = &service { mdns.update(service, &latest, &addresses, false); }
                        }
                        SwarmEvent::ExpiredListenAddr{address,..}=>{
                            addresses.retain(|a| a != &address);
                            emit(json!({"type":"addresses","addresses":announce_addresses(&addresses)}));
                            if let Some(service) = &service { mdns.update(service, &latest, &addresses, false); }
                        }
                        SwarmEvent::ListenerClosed{addresses:closed,..}=>{
                            addresses.retain(|a| !closed.contains(a));
                            emit(json!({"type":"addresses","addresses":announce_addresses(&addresses)}));
                            if let Some(service) = &service { mdns.update(service, &latest, &addresses, false); }
                        }
                        SwarmEvent::ConnectionEstablished{peer_id,connection_id,endpoint,num_established,..}=>{
                            if dialed.get(&peer_id) == Some(&connection_id) { dialed.remove(&peer_id); }
                            if rtc_dials.get(&peer_id) == Some(&connection_id) { rtc_dials.remove(&peer_id); }
                            if retiring.contains(&connection_id) || !visible.contains_key(&peer_id) {
                                swarm.close_connection(connection_id);
                                continue;
                            }
                            if let Some(rtc) = handle.network.file_rtc(endpoint.get_remote_address(), &peer_id.to_string()) {
                                handle.rtc_routes.lock().unwrap().insert(connection_id, rtc);
                            }
                            paths.insert(connection_id,peer_id);
                            fallback.remove(&peer_id);
                            let rtc = endpoint.get_remote_address().to_string().contains("/webrtc");
                            if !rtc && num_established.get() > 1 && carriers.contains_key(&peer_id) && desktop_rtc.contains(&peer_id) {
                                swarm.close_connection(connection_id);
                                continue;
                            }
                            if !rtc { carriers.insert(peer_id, connection_id); }
                            if endpoint.get_remote_address().iter().any(|p| p == libp2p::multiaddr::Protocol::WebTransport) {
                                webtransport_carriers.insert(connection_id);
                            }
                            if !rtc && num_established.get()==1 && desktop_rtc.contains(&peer_id) && local.to_string() < peer_id.to_string() {
                                upgrades.insert(peer_id, connection_id);
                                swarm.behaviour_mut().rtc_signal.open(peer_id, connection_id);
                            }
                            emit(json!({"type":"connected","connectionId":connection_id.to_string(),"peerId":peer_id.to_string(),"address":endpoint.get_remote_address().to_string()}));
                            visible.entry(peer_id).or_default().insert("connection".into());
                            if local.to_string()<peer_id.to_string() && handle.selected(peer_id).is_none() {
                                handle.open_business(peer_id,connection_id);
                            }
                        }
                        SwarmEvent::ConnectionClosed { peer_id, connection_id, num_established, cause, .. } => {
                            webtransport_carriers.remove(&connection_id);
                            handle.rtc_routes.lock().unwrap().remove(&connection_id);
                            paths.remove(&connection_id);
                            retiring.remove(&connection_id);
                            probes.remove(&connection_id);
                            handle.diagnostic(peer_id,connection_id,"connection-closed",json!({"remaining":num_established,"error":cause.map(|e|e.to_string())}));
                            if handle.selected(peer_id) == Some(connection_id) {
                                handle.active.lock().unwrap().remove(&peer_id);
                                let channel_id = format!("channel-{connection_id}");
                                handle.writers.lock().unwrap().retain(|(p,_),(_,id)|p!=&peer_id.to_string() || id!=&channel_id);
                                handle.close_receivers(&peer_id.to_string());
                                emit(json!({"type":"closed","peerId":peer_id.to_string(),"connectionId":channel_id,"physicalConnectionId":connection_id.to_string()}));
                                if local.to_string() < peer_id.to_string()
                                    && let Some((&next, _)) = paths.iter().find(|(id, p)| **p == peer_id && !retiring.contains(id)) {
                                    handle.open_business(peer_id, next);
                                }
                            }
                            if carriers.get(&peer_id)==Some(&connection_id) { carriers.remove(&peer_id); }
                            if upgrades.get(&peer_id)==Some(&connection_id) { upgrades.remove(&peer_id); }
                            emit(json!({"type":"connection_closed","connectionId":connection_id.to_string(),"peerId":peer_id.to_string()}));
                            if num_established == 0 {

                                handle.close_receivers(&peer_id.to_string());
                                if let Some(sources) = visible.get_mut(&peer_id) { sources.remove("connection"); if sources.is_empty() { visible.remove(&peer_id); } }
                                handle.writers.lock().unwrap().retain(|(p, _), _| p != &peer_id.to_string());

                            }
                        }
                        SwarmEvent::OutgoingConnectionError{peer_id:Some(peer),connection_id,error,..}=>{
                            handle.diagnostic(peer,connection_id,"dial-failed",json!({"error":error.to_string(),"action":"release-attempt"}));
                            if rtc_dials.get(&peer) == Some(&connection_id) {
                                rtc_dials.remove(&peer);
                                handle.network.signal_streams.lock().unwrap().remove(&peer);
                                retiring.remove(&connection_id);
                                continue;
                            }
                            if dialed.get(&peer) != Some(&connection_id) { retiring.remove(&connection_id); continue; }
                            dialed.remove(&peer);
                            if retiring.remove(&connection_id) {continue;}
                            if !swarm.is_connected(&peer) {
                                if let Some(addr) = fallback.remove(&peer) {
                                    let opts=DialOpts::peer_id(peer).addresses(vec![addr]).build();
                                    let id=opts.connection_id();
                                    if swarm.dial(opts).is_ok() {dialed.insert(peer,id);continue;}
                                }
                                emit(json!({"type":"closed","peerId":peer.to_string(),"attemptId":rounds.remove(&peer)}));
                            }
                        }
                        SwarmEvent::Behaviour(BehaviourEvent::Streams((peer,id,event))) => {
                            match event {
                                Ok(streams::Negotiated::Inbound(proto,stream)) if proto == health::PROTOCOL => {
                                    if handle.selected(peer) == Some(id) { let _ = pings.try_send((peer,id,stream)); }
                                }
                                Ok(streams::Negotiated::Inbound(proto,stream)) if paths.get(&id)==Some(&peer) && !retiring.contains(&id) && local.to_string() > peer.to_string() => {
                                    let chosen = *handle.active.lock().unwrap().entry(peer).or_insert(id);
                                    if chosen == id {
                                        let protocol = if proto.as_ref() == CHAT {CHAT} else {FILE};
                                        handle.attach(peer,id,protocol,stream,emit.clone());
                                    }
                                }
                                Err(error) => handle.diagnostic(peer,id,"stream-negotiation",json!({"error":error})),
                                _ => {}
                            }
                        }
                        SwarmEvent::Behaviour(BehaviourEvent::RtcSignal((peer,connection,stream)))=>{
                            if !visible.contains_key(&peer) || paths.get(&connection) != Some(&peer) {continue;}
                            let web = webtransport_carriers.contains(&connection);
                            if !web && carriers.get(&peer)!=Some(&connection) {continue;}
                            if !web && local.to_string()<peer.to_string() {
                                if upgrades.remove(&peer)!=Some(connection) {continue;}
                                if let Some(stream)=stream {
                                    let addr = network::tag_rtc_address(format!("/dns4/rtc-stream.hummingbird.invalid/udp/1/webrtc/p2p/{peer}").parse().expect("RTC address"));
                                    handle.network.signal_streams.lock().unwrap().insert(peer,stream);
                                    let opts = DialOpts::peer_id(peer).condition(libp2p::swarm::dial_opts::PeerCondition::Always)
                                        .addresses(vec![addr]).build();
                                    let id = opts.connection_id();
                                    if swarm.dial(opts).is_ok() {
                                        rtc_dials.insert(peer,id);
                                    } else {
                                        handle.network.signal_streams.lock().unwrap().remove(&peer);
                                    }
                                }
                            } else if let Some(stream)=stream {
                                let net=handle.network.clone();
                                tokio::spawn(async move {let _ = tokio::time::timeout(Duration::from_secs(24), net.stream_offer(peer,stream)).await;});
                            }
                        }
                        SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. }))
                            if tcp && visible.contains_key(&peer_id) => {
                            let addresses = info.listen_addrs.into_iter()
                                .filter(|a| !a.to_string().contains("hummingbird.invalid"))
                                .take(16)
                                .collect();
                            address_book.entry(peer_id).or_default().insert("identify".into(), addresses);
                        }
                        _=>{}
                    }
                }
            }
            if let Some(service) = service {
                let _ = service.shutdown();
            }
            handle.pipes.shutdown();
            handle.writers.lock().unwrap().clear();
            handle.consumed.lock().unwrap().clear();
        });
        Ok(node)
    }
    fn open_business(&self, peer: PeerId, physical: ConnectionId) {
        self.active.lock().unwrap().insert(peer, physical);
        let node = self.clone();
        tokio::spawn(async move {
            for protocol in [CHAT, FILE] {
                match node
                    .open_stream(peer, physical, StreamProtocol::new(protocol))
                    .await
                {
                    Ok(stream) => node.attach(peer, physical, protocol, stream, node.emit.clone()),
                    Err(error) => {
                        node.diagnostic(
                            peer,
                            physical,
                            "open-stream",
                            json!({"protocol":protocol,"error":error}),
                        );
                        let _ = node.command(Command::Reject(peer, physical)).await;
                        break;
                    }
                }
            }
        });
    }
    async fn bulk_file_payload_bytes(&self, peer: &str) -> Option<usize> {
        let peer = peer.parse().ok()?;
        let physical = self.selected(peer)?;
        let rtc = self.rtc_routes.lock().unwrap().get(&physical)?.clone();
        rtc.chunk().await
    }
    fn selected(&self, peer: PeerId) -> Option<ConnectionId> {
        self.active.lock().unwrap().get(&peer).copied()
    }
    fn diagnostic(&self, peer: PeerId, id: ConnectionId, stage: &str, detail: Value) {
        (self.emit)(
            json!({"type":"diagnostic","peerId":peer.to_string(),"diagnostic":{
                "stage":stage,"layer":"rust-libp2p","connectionId":id.to_string(),
                "activeConnectionId":self.selected(peer).map(|id|id.to_string()), "result":detail
            }}),
        );
    }
    async fn open_stream(
        &self,
        peer: PeerId,
        id: ConnectionId,
        protocol: StreamProtocol,
    ) -> Result<Stream, String> {
        let (reply, rx) = oneshot::channel();
        self.command(Command::Open(peer, id, streams::Open { protocol, reply }))
            .await?;
        tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    fn attach(
        &self,
        peer: PeerId,
        physical: ConnectionId,
        protocol: &'static str,
        stream: libp2p::swarm::Stream,
        emit: Emit,
    ) {
        let active = self.active.lock().unwrap();
        if active.get(&peer) != Some(&physical) {
            return;
        }
        let key = (peer.to_string(), protocol.to_owned());
        let (tx, mut rx) = mpsc::channel::<WriteRequest>(8);
        let mut writers = self.writers.lock().unwrap();
        if writers.contains_key(&key) {
            return;
        }
        let connection = format!("channel-{physical}");
        let binding_writer = tx.downgrade();
        writers.insert(key.clone(), (tx, connection.clone()));
        if writers.contains_key(&(peer.to_string(), CHAT.into()))
            && writers.contains_key(&(peer.to_string(), FILE.into()))
        {
            emit(
                json!({"type":"open","peerId":peer.to_string(),"connectionId":connection,"physicalConnectionId":physical.to_string()}),
            );
        }
        drop(writers);
        drop(active);
        let (mut reader, mut writer) = stream.split();
        let node = self.clone();
        let cancellation = self.cancel.clone();
        let metrics = self.metrics.clone();
        let rtc = self.rtc_routes.lock().unwrap().get(&physical).cloned();
        let outbound = rtc.clone();
        tokio::spawn(async move {
            if protocol == CHAT
                && let Some(rtc) = &outbound
                && let Some(payload) = rtc.hello().await
            {
                let hello = bulk::control_frame(&payload);
                if writer.write_all(&hello).await.is_err() || writer.flush().await.is_err() {
                    return;
                }
            }
            let mut requested_bulk = false;
            loop {
                let request = tokio::select! { _ = cancellation.cancelled() => break, item = rx.recv() => item };
                let Some(WriteRequest {
                    mut frame,
                    route,
                    reply,
                }) = request
                else {
                    break;
                };
                let _timing = metrics.timer("frame.write", frame.len());
                let result = tokio::time::timeout(Duration::from_secs(65), async {
                    if let FileRoute::TryBulk = route
                        && let Some(rtc) = &outbound
                        && (requested_bulk || rtc.bound().await)
                    {
                        if !requested_bulk {
                            requested_bulk = true;
                            writer.write_all(bulk::OPEN_FRAME).await?;
                            writer.flush().await?;
                        }
                        if let Some(desc) = rtc.send(&frame[5..]).await {
                            frame.clear();
                            frame.extend_from_slice(&(desc.len() as u32).to_be_bytes());
                            frame.push(2);
                            frame.extend_from_slice(&desc);
                        }
                    }
                    writer.write_all(&frame).await?;
                    writer.flush().await
                })
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e: std::io::Error| e.to_string()));
                let failed = result.is_err();
                let _ = reply.send(result);
                if failed {
                    break;
                }
            }
        });
        let token = uuid::Uuid::new_v4().to_string();
        let credit = Arc::new(credit::ReceiveCredit::default());
        self.consumed
            .lock()
            .unwrap()
            .insert(token.clone(), (peer.to_string(), credit.clone()));
        tokio::spawn(async move {
            loop {
                let timing = node.metrics.timer("frame.creditWait", 0);
                let permit = tokio::select! {
                    _ = node.cancel.cancelled() => break,
                    result = tokio::time::timeout(Duration::from_secs(60), credit.acquire()) => {
                        let Ok(Ok(permit)) = result else { break; };
                        permit
                    }
                };
                drop(timing);
                let frame = tokio::select! {
                    _ = node.cancel.cancelled() => break,
                    _ = credit.closed.cancelled() => break,
                    frame = read_frame(&mut reader) => frame,
                };
                let (kind, bytes) = match frame {
                    Ok(frame) => frame,
                    Err(error) => {
                        node.diagnostic(peer,physical,"stream-read",json!({"protocol":protocol,"streamId":token,"channelId":connection,"error":error.to_string()}));
                        break;
                    }
                };
                if kind == 2
                    && protocol == CHAT
                    && let Some(rtc) = &rtc
                    && bulk::binding_control(&bytes)
                {
                    if let Some(payload) = rtc.binding(&bytes).await {
                        let Some(tx) = binding_writer.upgrade() else {
                            break;
                        };
                        let (reply, done) = oneshot::channel();
                        let request = WriteRequest {
                            frame: bulk::control_frame(&payload),
                            route: FileRoute::Ordered,
                            reply,
                        };
                        if tx.send(request).await.is_err() || !matches!(done.await, Ok(Ok(()))) {
                            break;
                        }
                    }
                    continue;
                }
                if kind == 2 && protocol == FILE && bytes == bulk::OPEN {
                    if let Some(rtc) = &rtc {
                        rtc.prepare().await;
                    }
                    continue;
                }
                let bulk_record = kind == 2 && protocol == FILE && bulk::descriptor(&bytes);
                let bytes = if bulk_record {
                    let Some(rtc) = &rtc else { break };
                    match rtc.receive(&bytes).await {
                        Ok(plain) => plain,
                        Err(error) => {
                            node.diagnostic(
                                peer,
                                physical,
                                "file-channel-read",
                                json!({"error":error}),
                            );
                            break;
                        }
                    }
                } else {
                    bytes
                };
                if kind == 2 && node.files.enabled() {
                    drop(permit);
                    let id = bytes
                        .get(4..40)
                        .and_then(|b| std::str::from_utf8(b).ok())
                        .map(str::to_owned);
                    if let Err(error) = node
                        .files
                        .chunk(
                            &node,
                            &peer.to_string(),
                            &connection,
                            bytes,
                            bulk_record,
                            &emit,
                        )
                        .await
                        && let Some(id) = id
                    {
                        node.files.cancel(&peer.to_string(), &id);
                        emit(
                            json!({"type":"file_error","peerId":peer.to_string(),"id":id,"message":error}),
                        );
                        let _ = node
                            .send(
                                &peer.to_string(),
                                CHAT,
                                1,
                                serde_json::to_vec(
                                    &json!({"type":"transfer-error","id":id,"message":error}),
                                )
                                .unwrap(),
                            )
                            .await;
                    }
                    continue;
                }
                if kind == 1
                    && let Ok(packet) = serde_json::from_slice::<Value>(&bytes)
                    && node.files.progress(&peer.to_string(), &packet)
                {
                    drop(permit);
                    continue;
                }
                let sequence = credit.sent(permit);
                (node.emit_data)(
                    json!({"type":"data","peerId":peer.to_string(),"connectionId":connection,"kind":kind,"token":token,"sequence":sequence}),
                    &bytes,
                );
            }
            credit.close();
            node.consumed.lock().unwrap().remove(&token);
            let current = {
                let mut writers = node.writers.lock().unwrap();
                if writers.get(&key).is_some_and(|(_, id)| id == &connection) {
                    writers.remove(&key);
                    true
                } else {
                    false
                }
            };
            if current {
                emit(
                    json!({"type":"closed","peerId":peer.to_string(),"connectionId":connection,"physicalConnectionId":physical.to_string()}),
                );
            }
        });
    }
    pub async fn register(
        &self,
        profile: Value,
        addresses: Vec<String>,
        source: String,
    ) -> Result<(), String> {
        let peer = profile["id"]
            .as_str()
            .ok_or("Missing peer")?
            .parse()
            .map_err(|_| "Invalid peer")?;
        let addresses = addresses
            .into_iter()
            .take(32)
            .filter_map(|s| s.parse().ok())
            .collect();
        self.command(Command::Register {
            peer,
            profile,
            addresses,
            source,
        })
        .await
    }
    pub async fn forget(&self, peer: &str, source: String) -> Result<(), String> {
        self.command(Command::Forget {
            peer: peer.parse().map_err(|_| "Invalid peer")?,
            source,
        })
        .await
    }
    pub async fn connect(&self, peer: &str) -> Result<(), String> {
        self.connect_attempt(peer, String::new()).await
    }
    pub async fn connect_attempt(&self, peer: &str, attempt: String) -> Result<(), String> {
        self.command(Command::Connect(
            peer.parse().map_err(|_| "Invalid peer")?,
            attempt,
        ))
        .await
    }
    pub async fn publish(&self, profile: Value) -> Result<(), String> {
        self.command(Command::Publish(profile)).await
    }
    pub async fn ping(&self, peer: &str) -> Result<PeerHealth, String> {
        self.probe_peer(peer, None).await
    }
    pub async fn probe_peer(
        &self,
        peer: &str,
        request: Option<&str>,
    ) -> Result<PeerHealth, String> {
        let (tx, rx) = oneshot::channel();
        self.command(Command::Ping(
            peer.parse().map_err(|_| "Invalid peer")?,
            request
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            tx,
        ))
        .await?;
        tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
    }
    pub async fn close(&self, peer: &str) -> Result<(), String> {
        self.close_attempt(peer, None, None, true).await
    }
    pub async fn close_attempt(
        &self,
        peer: &str,
        attempt: Option<String>,
        physical: Option<String>,
        retire_peer: bool,
    ) -> Result<(), String> {
        let (done, wait) = oneshot::channel();
        self.command(Command::Close {
            peer: peer.parse().map_err(|_| "Invalid peer")?,
            attempt,
            physical,
            retire_peer,
            done,
        })
        .await?;
        wait.await.map_err(|e| e.to_string())
    }
    async fn command(&self, command: Command) -> Result<(), String> {
        self.commands.send(command).await.map_err(|e| e.to_string())
    }
    pub async fn send(
        &self,
        peer: &str,
        protocol: &str,
        kind: u8,
        data: Vec<u8>,
    ) -> Result<(), String> {
        self.send_parts(peer, protocol, kind, &[&data], FileRoute::Ordered)
            .await
    }

    async fn send_parts(
        &self,
        peer: &str,
        protocol: &str,
        kind: u8,
        parts: &[&[u8]],
        route: FileRoute,
    ) -> Result<(), String> {
        let size: usize = parts.iter().map(|part| part.len()).sum();
        if !matches!(kind, 1 | 2) || size == 0 || size > FRAME_LIMIT {
            return Err("Invalid message".into());
        }
        let tx = self
            .writers
            .lock()
            .unwrap()
            .get(&(peer.into(), protocol.into()))
            .map(|(tx, _)| tx.clone())
            .ok_or("Device disconnected")?;
        let mut frame = Vec::with_capacity(size + 5);
        frame.extend_from_slice(&(size as u32).to_be_bytes());
        frame.push(kind);
        for part in parts {
            frame.extend_from_slice(part);
        }
        let (reply, rx) = oneshot::channel();
        tx.send(WriteRequest {
            frame,
            route,
            reply,
        })
        .await
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }
    pub fn consumed(&self, token: &str, sequence: u64) -> Result<(), String> {
        if let Some((_, credit)) = self.consumed.lock().unwrap().get(token) {
            credit.consumed(sequence)?;
        }
        Ok(())
    }
    fn close_receivers(&self, peer: &str) {
        self.files.disconnected(peer);
        self.consumed.lock().unwrap().retain(|_, (owner, credit)| {
            if owner == peer {
                credit.close();
                false
            } else {
                true
            }
        });
    }
    pub fn stop(&self) {
        self.cancel.cancel();
        self.files.shutdown();
        self.network.shutdown();
        self.pipes.shutdown();
    }
}
async fn read_frame(
    reader: &mut (impl futures::AsyncRead + Unpin),
) -> std::io::Result<(u8, Vec<u8>)> {
    let mut header = [0u8; 5];
    reader.read_exact(&mut header).await?;
    let size = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
    if size == 0 || size > FRAME_LIMIT || ![1, 2].contains(&header[4]) {
        return Err(std::io::Error::other("Invalid frame"));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).await?;
    Ok((header[4], bytes))
}
struct MdnsAdvertisement {
    room: String,
    instance: String,
    addresses: Option<(u16, Vec<std::net::IpAddr>)>,
}

impl MdnsAdvertisement {
    fn update(
        &mut self,
        service: &ServiceDaemon,
        profile: &Value,
        listen: &[Multiaddr],
        force: bool,
    ) {
        use libp2p::multiaddr::Protocol;
        use std::net::IpAddr;

        // A DNS-SD record has one port. IPv4 and IPv6 listeners can receive
        // different ephemeral ports, so publish only IPs served by that port.
        let mut endpoints: Vec<_> = listen
            .iter()
            .filter_map(|address| {
                let mut parts = address.iter();
                let ip = match parts.next()? {
                    Protocol::Ip4(ip) => IpAddr::V4(ip),
                    Protocol::Ip6(ip) => IpAddr::V6(ip),
                    _ => return None,
                };
                match parts.next()? {
                    Protocol::Tcp(port) if !ip.is_unspecified() => Some((ip, port)),
                    _ => None,
                }
            })
            .collect();
        endpoints.sort_by_key(|(ip, port)| (ip.is_loopback(), ip.is_ipv6(), *port, *ip));
        let next = endpoints.first().map(|(_, port)| {
            (
                *port,
                endpoints
                    .iter()
                    .filter(|(_, p)| p == port)
                    .map(|(ip, _)| *ip)
                    .collect::<Vec<_>>(),
            )
        });
        if !force && self.addresses == next {
            return;
        }
        if let Some((port, ips)) = &next {
            if mdns_info(profile, &self.room, *port, &self.instance, ips)
                .and_then(|info| service.register(info))
                .is_ok()
            {
                self.addresses = next;
            }
        } else if self.addresses.is_some() {
            let name = format!("{}.{}", profile["id"].as_str().unwrap_or_default(), SERVICE);
            if service.unregister(&name).is_ok() {
                self.addresses = None;
            }
        }
    }
}

fn has_capability(list: &Value, name: &str) -> bool {
    let id = capability(name);
    list.as_array()
        .is_some_and(|caps| caps.iter().any(|c| c == id))
}

fn mdns_info(
    profile: &Value,
    room: &str,
    port: u16,
    instance: &str,
    ips: &[std::net::IpAddr],
) -> Result<ServiceInfo, mdns_sd::Error> {
    let id = profile["id"].as_str().unwrap_or_default();
    let advertised = profile["runtime"]["capabilities"]
        .as_array()
        .ok_or_else(|| mdns_sd::Error::Msg("Missing capabilities".into()))?;
    let mut properties = vec![
        ("peer", id),
        ("room", room),
        ("instance", instance),
        (
            "clientType",
            profile["runtime"]["clientType"]
                .as_str()
                .ok_or_else(|| mdns_sd::Error::Msg("Missing clientType".into()))?,
        ),
        ("protocol", capability("discovery")),
        ("name", profile["name"].as_str().unwrap_or_default()),
        (
            "numericId",
            profile["numericId"].as_str().unwrap_or_default(),
        ),
    ];
    properties.extend(
        known_capabilities()
            .filter(|id| advertised.iter().any(|cap| cap.as_str() == Some(*id)))
            .map(|id| (id, "1")),
    );
    ServiceInfo::new(
        SERVICE,
        id,
        &format!("{id}.local."),
        ips,
        port,
        &properties[..],
    )
}
fn decode_mdns(info: &mdns_sd::ResolvedService) -> Option<Value> {
    if info.get_property_val_str("protocol")? != capability("discovery") {
        return None;
    }
    let caps: Vec<_> = known_capabilities()
        .filter(|id| info.get_property_val_str(id) == Some("1"))
        .collect();
    if !caps.contains(&capability("discovery")) {
        return None;
    }
    let client_type = info.get_property_val_str("clientType")?;
    if !matches!(client_type, "desktop" | "mobile") {
        return None;
    }
    Some(
        json!({"id":info.get_property_val_str("peer")?, "numericId":info.get_property_val_str("numericId")?, "name":info.get_property_val_str("name")?, "capabilities":caps, "clientType":client_type}),
    )
}

fn announce_addresses(addresses: &[Multiaddr]) -> Vec<String> {
    // The WebView selects one list per recipient. Each signal carries at most 32 addresses.
    let mut tcp = Vec::new();
    let mut quic = Vec::new();
    let mut webtransport = Vec::new();
    for address in addresses {
        let (group, limit) = if address
            .iter()
            .any(|p| p == libp2p::multiaddr::Protocol::WebTransport)
        {
            (&mut webtransport, 32)
        } else if address
            .iter()
            .any(|p| p == libp2p::multiaddr::Protocol::QuicV1)
        {
            (&mut quic, 16)
        } else {
            (&mut tcp, 16)
        };
        if group.len() < limit {
            group.push(address.to_string());
        }
    }
    tcp.extend(quic);
    tcp.extend(webtransport);
    tcp
}
