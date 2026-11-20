use super::RTC_SIGNAL;
use libp2p::{
    Multiaddr, PeerId, StreamProtocol,
    core::{Endpoint, transport::PortUse, upgrade::ReadyUpgrade},
    swarm::{
        ConnectionDenied, ConnectionId, FromSwarm, NetworkBehaviour, NotifyHandler, OneShotHandler,
        Stream, SubstreamProtocol, THandler, THandlerInEvent, THandlerOutEvent, ToSwarm,
    },
};
use std::{
    collections::VecDeque,
    task::{Context, Poll},
};

type Upgrade = ReadyUpgrade<StreamProtocol>;
type Event = (PeerId, ConnectionId, Option<Stream>);

#[derive(Default)]
pub struct Behaviour {
    pending: VecDeque<ToSwarm<Event, Upgrade>>,
}
impl Behaviour {
    pub fn open(&mut self, peer_id: PeerId, id: ConnectionId) {
        self.pending.push_back(ToSwarm::NotifyHandler {
            peer_id,
            handler: NotifyHandler::One(id),
            event: ReadyUpgrade::new(RTC_SIGNAL),
        });
    }
    fn handler() -> THandler<Self> {
        OneShotHandler::new(
            SubstreamProtocol::new(ReadyUpgrade::new(RTC_SIGNAL), ()),
            Default::default(),
        )
    }
}
impl NetworkBehaviour for Behaviour {
    type ConnectionHandler = OneShotHandler<Upgrade, Upgrade, Stream>;
    type ToSwarm = Event;
    fn handle_established_inbound_connection(
        &mut self,
        _: ConnectionId,
        peer: PeerId,
        _: &Multiaddr,
        remote: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        if remote
            .iter()
            .any(|p| matches!(p,libp2p::multiaddr::Protocol::P2p(id) if id!=peer))
        {
            return Err(ConnectionDenied::new("Signaling peer identity mismatch"));
        }
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
        result: THandlerOutEvent<Self>,
    ) {
        self.pending
            .push_back(ToSwarm::GenerateEvent((peer, id, result.ok())));
    }
    fn poll(&mut self, _: &mut Context<'_>) -> Poll<ToSwarm<Event, THandlerInEvent<Self>>> {
        self.pending.pop_front().map_or(Poll::Pending, Poll::Ready)
    }
}
