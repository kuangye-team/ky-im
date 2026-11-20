//! Open and accept business streams on a specific authenticated connection.
use super::{CHAT, FILE, health};
use futures::future::{Ready, ready};
use libp2p::{
    Multiaddr, PeerId, StreamProtocol,
    core::{
        Endpoint,
        transport::PortUse,
        upgrade::{InboundUpgrade, OutboundUpgrade, UpgradeInfo},
    },
    swarm::{
        ConnectionDenied, ConnectionId, FromSwarm, NetworkBehaviour, NotifyHandler, OneShotHandler,
        Stream, SubstreamProtocol, THandler, THandlerInEvent, THandlerOutEvent, ToSwarm,
    },
};
use std::{
    collections::VecDeque,
    convert::Infallible,
    task::{Context, Poll},
};
use tokio::sync::oneshot;

#[derive(Debug, Clone)]
pub struct Listen;

#[derive(Debug)]
pub struct Open {
    pub protocol: StreamProtocol,
    pub reply: oneshot::Sender<Stream>,
}

#[derive(Debug)]
pub enum Negotiated {
    Inbound(StreamProtocol, Stream),
    Outbound,
}
impl UpgradeInfo for Listen {
    type Info = StreamProtocol;
    type InfoIter = [StreamProtocol; 3];
    fn protocol_info(&self) -> Self::InfoIter {
        [
            StreamProtocol::new(CHAT),
            StreamProtocol::new(FILE),
            health::PROTOCOL,
        ]
    }
}
impl InboundUpgrade<Stream> for Listen {
    type Output = Negotiated;
    type Error = Infallible;
    type Future = Ready<Result<Negotiated, Infallible>>;
    fn upgrade_inbound(self, stream: Stream, protocol: StreamProtocol) -> Self::Future {
        ready(Ok(Negotiated::Inbound(protocol, stream)))
    }
}
impl UpgradeInfo for Open {
    type Info = StreamProtocol;
    type InfoIter = [StreamProtocol; 1];
    fn protocol_info(&self) -> Self::InfoIter {
        [self.protocol.clone()]
    }
}
impl OutboundUpgrade<Stream> for Open {
    type Output = Negotiated;
    type Error = Infallible;
    type Future = Ready<Result<Negotiated, Infallible>>;
    fn upgrade_outbound(self, stream: Stream, _: StreamProtocol) -> Self::Future {
        let _ = self.reply.send(stream);
        ready(Ok(Negotiated::Outbound))
    }
}
type Event = (PeerId, ConnectionId, Result<Negotiated, String>);
#[derive(Default)]
pub struct Behaviour {
    events: VecDeque<ToSwarm<Event, Open>>,
}
impl Behaviour {
    pub fn open(&mut self, peer_id: PeerId, id: ConnectionId, request: Open) {
        self.events.push_back(ToSwarm::NotifyHandler {
            peer_id,
            handler: NotifyHandler::One(id),
            event: request,
        });
    }
    fn handler() -> THandler<Self> {
        OneShotHandler::new(SubstreamProtocol::new(Listen, ()), Default::default())
    }
}
impl NetworkBehaviour for Behaviour {
    type ConnectionHandler = OneShotHandler<Listen, Open, Negotiated>;
    type ToSwarm = Event;
    fn handle_established_inbound_connection(
        &mut self,
        _: ConnectionId,
        _: PeerId,
        _: &Multiaddr,
        _: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(Self::handler())
    }
    fn handle_established_outbound_connection(
        &mut self,
        _: ConnectionId,
        _: PeerId,
        _: &Multiaddr,
        _: Endpoint,
        _: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(Self::handler())
    }
    fn on_swarm_event(&mut self, _: FromSwarm) {}
    fn on_connection_handler_event(
        &mut self,
        peer: PeerId,
        id: ConnectionId,
        event: THandlerOutEvent<Self>,
    ) {
        self.events.push_back(ToSwarm::GenerateEvent((
            peer,
            id,
            event.map_err(|e| e.to_string()),
        )));
    }
    fn poll(&mut self, _: &mut Context<'_>) -> Poll<ToSwarm<Event, THandlerInEvent<Self>>> {
        self.events.pop_front().map_or(Poll::Pending, Poll::Ready)
    }
}
