//! Browser-initiated libp2p connections over HTTP/3. Only the first stream
//! carries Noise. Subsequent HTTP/3 bidirectional streams are Swarm substreams.
use futures::{
    AsyncWriteExt, FutureExt, StreamExt,
    future::BoxFuture,
    stream::{BoxStream, SelectAll},
};
use if_watch::{IfEvent, tokio::IfWatcher};
use libp2p::{
    Multiaddr, PeerId, Transport,
    core::{
        multihash::Multihash,
        muxing::{StreamMuxer, StreamMuxerEvent},
        transport::{DialOpts, ListenerId, TransportError, TransportEvent},
        upgrade::InboundConnectionUpgrade,
    },
    identity,
    multiaddr::Protocol,
    noise,
};
use std::{
    collections::{HashMap, HashSet},
    io,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio_util::{
    compat::{Compat, TokioAsyncReadCompatExt},
    sync::CancellationToken,
};
use wtransport::{
    Connection, Endpoint, Identity, ServerConfig, endpoint::IncomingSession, stream::BiStream,
};

type Hash = Multihash<64>;
type Substream = Compat<BiStream>;
type Upgrade = BoxFuture<'static, io::Result<(PeerId, Muxer)>>;
type Event = TransportEvent<Upgrade, io::Error>;

pub struct BrowserListener {
    noise: noise::Config,
    listeners: SelectAll<BoxStream<'static, Event>>,
    stops: HashMap<ListenerId, CancellationToken>,
}

impl BrowserListener {
    pub fn new(key: &identity::Keypair) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self {
            noise: noise::Config::new(key)?,
            listeners: SelectAll::new(),
            stops: HashMap::new(),
        })
    }
}

fn address(socket: SocketAddr) -> Multiaddr {
    Multiaddr::from(socket.ip())
        .with(Protocol::Udp(socket.port()))
        .with(Protocol::QuicV1)
        .with(Protocol::WebTransport)
}

fn certificate(bind: SocketAddr) -> io::Result<(ServerConfig, Hash)> {
    use wtransport::tls::self_signed::time::{Duration as TimeDelta, OffsetDateTime};
    // Allow for clock skew between devices while keeping the full validity within 14 days.
    let identity = Identity::self_signed_builder()
        .subject_alt_names(["localhost"])
        .not_before(OffsetDateTime::now_utc() - TimeDelta::hours(1))
        .validity_days(14)
        .build()
        .map_err(io::Error::other)?;
    let digest = identity.certificate_chain().as_slice()[0].hash();
    let hash = Hash::wrap(0x12, digest.as_ref()).map_err(io::Error::other)?;
    let config = ServerConfig::builder()
        .with_bind_address(bind)
        .with_identity(identity)
        .build();
    Ok((config, hash))
}

impl Transport for BrowserListener {
    type Output = (PeerId, Muxer);
    type Error = io::Error;
    type ListenerUpgrade = Upgrade;
    type Dial = Upgrade;

    fn dial(&mut self, addr: Multiaddr, _: DialOpts) -> Result<Upgrade, TransportError<io::Error>> {
        Err(TransportError::MultiaddrNotSupported(addr))
    }

    fn listen_on(
        &mut self,
        id: ListenerId,
        addr: Multiaddr,
    ) -> Result<(), TransportError<io::Error>> {
        let mut parts = addr.iter();
        let ip = match parts.next() {
            Some(Protocol::Ip4(ip)) => IpAddr::V4(ip),
            Some(Protocol::Ip6(ip)) => IpAddr::V6(ip),
            _ => return Err(TransportError::MultiaddrNotSupported(addr)),
        };
        let (Some(Protocol::Udp(port)), Some(Protocol::QuicV1), Some(Protocol::WebTransport), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(TransportError::MultiaddrNotSupported(addr));
        };
        let bind = SocketAddr::new(ip, port);
        let (config, mut hash) = certificate(bind).map_err(TransportError::Other)?;
        let endpoint = Endpoint::server(config).map_err(TransportError::Other)?;
        let socket = endpoint.local_addr().map_err(TransportError::Other)?;
        let mut interfaces = IfWatcher::new().map_err(TransportError::Other)?;
        let stop = CancellationToken::new();
        self.stops.insert(id, stop.clone());
        let noise = self.noise.clone();
        self.listeners.push(async_stream::stream! {
            let mut ips = HashSet::new();
            let renew = Duration::from_secs(7 * 86400);
            let mut rotation = tokio::time::interval_at(tokio::time::Instant::now() + renew, renew);
            rotation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let announced = |ip, hash| address(SocketAddr::new(ip, socket.port())).with(Protocol::Certhash(hash));
            let reason = loop {
                tokio::select! {
                    _ = stop.cancelled() => break Ok(()),
                    update = interfaces.next() => match update {
                        Some(Ok(change)) => {
                            let net = match change { IfEvent::Up(net) | IfEvent::Down(net) => net };
                            let host = net.addr();
                            if ip.is_ipv4() != host.is_ipv4() || (!ip.is_unspecified() && ip != host) { continue; }
                            let listen_addr = announced(host, hash);
                            match change {
                                IfEvent::Up(_) if ips.insert(host) =>
                                    yield TransportEvent::NewAddress { listener_id: id, listen_addr },
                                IfEvent::Down(_) if ips.remove(&host) =>
                                    yield TransportEvent::AddressExpired { listener_id: id, listen_addr },
                                _ => {}
                            }
                        }
                        Some(Err(error)) => break Err(error),
                        None => break Ok(()),
                    },
                    _ = rotation.tick() => {
                        let next = certificate(bind).and_then(|(config, next)| {
                            endpoint.reload_config(config, false)?;
                            Ok(next)
                        });
                        let next = match next { Ok(next) => next, Err(e) => break Err(e) };
                        let old = std::mem::replace(&mut hash, next);
                        for &host in &ips {
                            yield TransportEvent::AddressExpired { listener_id: id, listen_addr: announced(host, old) };
                            yield TransportEvent::NewAddress { listener_id: id, listen_addr: announced(host, hash) };
                        }
                    },
                    incoming = endpoint.accept() => {
                        let remote = address(incoming.remote_address());
                        let auth = noise.clone().with_webtransport_certhashes([hash].into());
                        yield TransportEvent::Incoming {
                            listener_id: id, local_addr: announced(socket.ip(), hash), send_back_addr: remote,
                            upgrade: authenticate(incoming, auth).boxed(),
                        };
                    }
                }
            };
            yield TransportEvent::ListenerClosed { listener_id: id, reason };
        }.boxed());
        Ok(())
    }

    fn remove_listener(&mut self, id: ListenerId) -> bool {
        self.stops.remove(&id).is_some_and(|stop| {
            stop.cancel();
            true
        })
    }

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Event> {
        match self.listeners.poll_next_unpin(cx) {
            Poll::Ready(Some(event)) => {
                if let TransportEvent::ListenerClosed { listener_id, .. } = &event {
                    self.stops.remove(listener_id);
                }
                Poll::Ready(event)
            }
            _ => Poll::Pending,
        }
    }
}

async fn authenticate(
    incoming: IncomingSession,
    auth: noise::Config,
) -> io::Result<(PeerId, Muxer)> {
    let request = incoming.await.map_err(io::Error::other)?;
    if request.path() != "/.well-known/libp2p-webtransport?type=noise" {
        request.not_found().await;
        return Err(io::Error::other("Unknown WebTransport endpoint"));
    }
    let conn = request.accept().await.map_err(io::Error::other)?;
    let first = conn.accept_bi().await.map_err(io::Error::other)?;
    let (peer, mut stream) = auth
        .upgrade_inbound(BiStream::join(first).compat(), "/noise")
        .await
        .map_err(io::Error::other)?;
    stream.close().await?;
    Ok((peer, Muxer::new(conn)))
}

pub struct Muxer {
    conn: Connection,
    inbound: BoxStream<'static, io::Result<Substream>>,
    outbound: BoxStream<'static, io::Result<Substream>>,
    closed: BoxFuture<'static, io::Error>,
}

impl Muxer {
    fn new(conn: Connection) -> Self {
        let accept = conn.clone();
        let open = conn.clone();
        let watch = conn.clone();
        Self {
            conn,
            inbound: async_stream::stream! {
                loop {
                    yield accept.accept_bi().await.map(|s| BiStream::join(s).compat()).map_err(io::Error::other);
                }
            }.boxed(),
            outbound: async_stream::stream! {
                loop {
                    let stream = async {
                        let opening = open.open_bi().await.map_err(io::Error::other)?;
                        Ok(BiStream::join(opening.await.map_err(io::Error::other)?).compat())
                    }.await;
                    yield stream;
                }
            }.boxed(),
            closed: async move { io::Error::other(watch.closed().await) }.boxed(),
        }
    }
}

impl StreamMuxer for Muxer {
    type Substream = Substream;
    type Error = io::Error;
    fn poll_inbound(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<Substream>> {
        self.inbound.poll_next_unpin(cx).map(Option::unwrap)
    }
    fn poll_outbound(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<Substream>> {
        self.outbound.poll_next_unpin(cx).map(Option::unwrap)
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.conn.close(0u32.into(), b"");
        Poll::Ready(Ok(()))
    }
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<StreamMuxerEvent>> {
        self.closed.poll_unpin(cx).map(Err)
    }
}
