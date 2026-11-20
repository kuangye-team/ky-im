//! Bounded byte pipes join native sockets and WebView DataChannels to one Swarm.
use super::{Emit, EmitData};
use futures::{
    FutureExt, StreamExt,
    future::BoxFuture,
    io::{AsyncRead, AsyncWrite},
};
use libp2p::{
    Multiaddr, Transport,
    core::transport::{DialOpts, ListenerId, TransportError, TransportEvent},
};
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream, WriteHalf},
    sync::{Mutex as AsyncMutex, oneshot},
};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};

pub const PIPE_BLOCK: usize = 256 * 1024;

struct Pipe {
    writer: Option<Arc<AsyncMutex<WriteHalf<DuplexStream>>>>,
    credit: Arc<super::credit::ReceiveCredit>,
    ready: Option<oneshot::Sender<()>>,
}
#[derive(Clone)]
pub struct Pipes {
    native: Arc<std::sync::atomic::AtomicBool>,
    endpoints: Arc<Mutex<HashMap<String, DuplexStream>>>,
    available: Arc<tokio::sync::Notify>,
    metrics: super::metrics::Metrics,
    entries: Arc<Mutex<HashMap<String, Pipe>>>,
    incoming: futures::channel::mpsc::UnboundedSender<(String, Multiaddr)>,
    emit: Emit,
    emit_data: EmitData,
}
impl Pipes {
    pub fn enable_native(&self) {
        self.native.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub async fn endpoint(
        &self,
        id: &str,
    ) -> Result<(DuplexStream, tokio_util::sync::CancellationToken), String> {
        tokio::time::timeout(std::time::Duration::from_secs(25), async {
            loop {
                let notified = self.available.notified();
                let endpoint = self.endpoints.lock().unwrap().remove(id);
                if let Some(io) = endpoint {
                    let closed = self
                        .entries
                        .lock()
                        .unwrap()
                        .get(id)
                        .ok_or("Connection closed")?
                        .credit
                        .closed
                        .clone();
                    return Ok((io, closed));
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| "Connection timeout".to_string())?
    }

    pub async fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > PIPE_BLOCK {
            return Err("Pipe frame too large".into());
        }
        let _timing = self.metrics.timer("pipe.write", bytes.len());
        let writer = self
            .entries
            .lock()
            .unwrap()
            .get(id)
            .and_then(|p| p.writer.clone())
            .ok_or("Pipe closed")?;
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            writer.lock().await.write_all(bytes),
        )
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    }
    pub fn consumed(&self, id: &str, sequence: u64) -> Result<(), String> {
        if let Some(p) = self.entries.lock().unwrap().get(id) {
            p.credit.consumed(sequence)?;
        }
        Ok(())
    }
    pub fn ready(&self, id: &str) {
        if let Some(p) = self.entries.lock().unwrap().get_mut(id)
            && let Some(tx) = p.ready.take()
        {
            let _ = tx.send(());
        }
    }
    pub fn close(&self, id: &str) {
        self.endpoints.lock().unwrap().remove(id);
        if let Some(pipe) = self.entries.lock().unwrap().remove(id) {
            pipe.credit.close();
        }
    }
    pub fn accept(&self, address: Multiaddr) -> Result<String, String> {
        if !supported(&address) {
            return Err("Invalid transport address".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.incoming
            .unbounded_send((id.clone(), address))
            .map_err(|e| e.to_string())?;
        Ok(id)
    }
    fn create(&self, id: String, rtc: bool) -> io::Result<(PipeIo, oneshot::Receiver<()>)> {
        let mut entries = self.entries.lock().unwrap();
        // Established pipes stay in this map for I/O. Only waiters consume handshake capacity.
        if entries
            .values()
            .filter(|pipe| pipe.ready.as_ref().is_some_and(|tx| !tx.is_closed()))
            .count()
            >= 32
        {
            return Err(io::Error::other("Pending pipe limit"));
        }
        let (node, bridge) = tokio::io::duplex(2 * PIPE_BLOCK);
        if self.native.load(std::sync::atomic::Ordering::SeqCst) && !rtc {
            let (tx, rx) = oneshot::channel();
            entries.insert(
                id.clone(),
                Pipe {
                    writer: None,
                    credit: Arc::new(super::credit::ReceiveCredit::default()),
                    ready: Some(tx),
                },
            );
            self.endpoints.lock().unwrap().insert(id.clone(), bridge);
            self.available.notify_one();
            return Ok((
                PipeIo {
                    inner: node.compat(),
                    id,
                    pipes: self.clone(),
                },
                rx,
            ));
        }
        let (mut reader, writer) = tokio::io::split(bridge);
        let (tx, rx) = oneshot::channel();
        let credit = Arc::new(super::credit::ReceiveCredit::default());
        entries.insert(
            id.clone(),
            Pipe {
                writer: Some(Arc::new(AsyncMutex::new(writer))),
                credit: credit.clone(),
                ready: Some(tx),
            },
        );
        let pipes = self.clone();
        let token = id.clone();
        let emit = self.emit.clone();
        let emit_data = self.emit_data.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0; PIPE_BLOCK];
            loop {
                let timing = pipes.metrics.timer("pipe.creditWait", 0);
                let Ok(Ok(permit)) =
                    tokio::time::timeout(std::time::Duration::from_secs(15), credit.acquire())
                        .await
                else {
                    break;
                };
                drop(timing);
                let count = tokio::select! {
                    _ = credit.closed.cancelled() => break,
                    result = reader.read(&mut buffer) => match result {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    }
                };
                let sequence = credit.sent(permit);
                emit_data(
                    json!({"type":"pipe_data","token":token,"sequence":sequence}),
                    &buffer[..count],
                );
            }
            pipes.close(&token);
            emit(json!({"type":"pipe_close","token":token}));
        });
        Ok((
            PipeIo {
                inner: node.compat(),
                id,
                pipes: self.clone(),
            },
            rx,
        ))
    }
    pub fn shutdown(&self) {
        self.endpoints.lock().unwrap().clear();
        let mut entries = self.entries.lock().unwrap();
        for pipe in entries.values() {
            pipe.credit.close();
        }
        entries.clear();
    }
}
pub struct PipeIo {
    inner: Compat<DuplexStream>,
    id: String,
    pipes: Pipes,
}
impl Drop for PipeIo {
    fn drop(&mut self) {
        self.pipes.close(&self.id);
    }
}
impl AsyncRead for PipeIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
impl AsyncWrite for PipeIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_close(cx)
    }
}
pub struct ByteTransport {
    pipes: Pipes,
    incoming: futures::channel::mpsc::UnboundedReceiver<(String, Multiaddr)>,
    listener: Option<(ListenerId, Multiaddr)>,
    events: VecDeque<TransportEvent<BoxFuture<'static, io::Result<PipeIo>>, io::Error>>,
}
fn supported(address: &Multiaddr) -> bool {
    address.to_string().contains(".hummingbird.invalid/")
}
impl ByteTransport {
    pub fn new(emit: Emit, emit_data: EmitData, metrics: super::metrics::Metrics) -> (Self, Pipes) {
        let (tx, rx) = futures::channel::mpsc::unbounded();
        let pipes = Pipes {
            native: Default::default(),
            endpoints: Default::default(),
            available: Default::default(),
            metrics,
            entries: Default::default(),
            incoming: tx,
            emit,
            emit_data,
        };
        (
            Self {
                pipes: pipes.clone(),
                incoming: rx,
                listener: None,
                events: VecDeque::new(),
            },
            pipes,
        )
    }
}
impl Transport for ByteTransport {
    type Output = PipeIo;
    type Error = io::Error;
    type ListenerUpgrade = BoxFuture<'static, io::Result<PipeIo>>;
    type Dial = BoxFuture<'static, io::Result<PipeIo>>;
    fn listen_on(
        &mut self,
        id: ListenerId,
        addr: Multiaddr,
    ) -> Result<(), TransportError<io::Error>> {
        if !supported(&addr) {
            return Err(TransportError::MultiaddrNotSupported(addr));
        }
        self.listener = Some((id, addr.clone()));
        self.events.push_back(TransportEvent::NewAddress {
            listener_id: id,
            listen_addr: addr,
        });
        Ok(())
    }
    fn remove_listener(&mut self, id: ListenerId) -> bool {
        if self.listener.as_ref().is_some_and(|(old, _)| *old == id) {
            self.listener = None;
            true
        } else {
            false
        }
    }
    fn dial(
        &mut self,
        addr: Multiaddr,
        _: DialOpts,
    ) -> Result<Self::Dial, TransportError<io::Error>> {
        if !supported(&addr) {
            return Err(TransportError::MultiaddrNotSupported(addr));
        }
        let pipes = self.pipes.clone();
        Ok(async move {
            let id = uuid::Uuid::new_v4().to_string();
            let (io, ready) = pipes.create(id.clone(), addr.to_string().contains("/webrtc"))?;
            (pipes.emit)(json!({"type":"pipe_dial","token":id,"address":addr.to_string()}));
            tokio::time::timeout(std::time::Duration::from_secs(25), ready)
                .await
                .map_err(io::Error::other)?
                .map_err(io::Error::other)?;
            Ok(io)
        }
        .boxed())
    }
    fn poll(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<TransportEvent<Self::ListenerUpgrade, Self::Error>> {
        if let Some(event) = self.events.pop_front() {
            return Poll::Ready(event);
        }
        if let Poll::Ready(Some((id, remote))) = self.incoming.poll_next_unpin(cx)
            && let Some((listener_id, local_addr)) = self.listener.clone()
        {
            let pipes = self.pipes.clone();
            let rtc = remote.to_string().contains("/webrtc");
            return Poll::Ready(TransportEvent::Incoming {
                listener_id,
                local_addr,
                send_back_addr: remote,
                upgrade: async move {
                    let (io, _) = pipes.create(id.clone(), rtc)?;
                    (pipes.emit)(json!({"type":"pipe_incoming_ready","token":id}));
                    Ok(io)
                }
                .boxed(),
            });
        }
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn established_pipes_do_not_consume_handshake_capacity() {
        let (_, pipes) =
            ByteTransport::new(Arc::new(|_| {}), Arc::new(|_, _| {}), Default::default());
        pipes.enable_native();
        let mut established = Vec::new();
        for n in 0..40 {
            let id = format!("open-{n}");
            let (io, ready) = pipes.create(id.clone(), false).unwrap();
            pipes.ready(&id);
            ready.await.unwrap();
            established.push(io);
        }
        let _pending: Vec<_> = (0..32)
            .map(|n| pipes.create(format!("pending-{n}"), false).unwrap())
            .collect();
        assert!(pipes.create("next".into(), false).is_err());
        pipes.ready("pending-0");
        assert!(pipes.create("next".into(), false).is_ok());
        assert_eq!(established.len(), 40);
    }
}
