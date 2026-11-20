use crate::{
    AppState,
    protocol::{
        Profile, RelayPacket, ServerMessage, valid_identifier, valid_numeric_id, valid_signal,
        validate_recent_numbers,
    },
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

#[cfg(not(target_arch = "wasm32"))]
pub(crate) const QUEUE_CAPACITY: usize = 32;
const CONNECT_WINDOW: u64 = 10_000;
const MAX_CONNECT_ATTEMPTS: u8 = 10;

#[derive(Clone, Copy, Debug)]
pub(crate) enum CloseReason {
    Replaced,
    SlowConsumer,
}

impl CloseReason {
    pub fn message(self) -> ServerMessage {
        match self {
            Self::Replaced => ServerMessage::error(
                "session_replaced",
                "This identity connected from another window",
            ),
            Self::SlowConsumer => ServerMessage::error(
                "slow_consumer",
                "Client cannot keep up with incoming signals",
            ),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Peer {
    pub profile: Profile,
    pub number_revision: u64,
    pub generation: String,
    pub transport: Arc<dyn Transport>,
}

impl Peer {
    pub fn send(&self, message: ServerMessage) {
        if !self.transport.send(message) {
            self.transport.close(CloseReason::SlowConsumer);
        }
    }
}

#[derive(Default)]
pub(crate) struct Hub {
    pub(crate) relay: crate::relay::RelayRegistry,
    pub rooms: HashMap<String, HashMap<String, Peer>>,
    peer_rooms: HashMap<String, String>,
    // Device-owned numbers form a second discovery group, independent of source IP.
    numeric_ids: HashMap<String, HashSet<String>>,
    // A subscriber sees group members; subscribers do not discover one another.
    subscriptions: HashMap<String, HashSet<String>>,
    // Recent-chat subscriptions are replaceable, independent of explicit lookups.
    recent_subscriptions: HashMap<String, HashSet<String>>,
    // Exact UUID lookups retain independent, pair-only reconnect permission.
    pairs: HashMap<String, HashSet<String>>,
    connect_attempts: HashMap<String, (u64, u8)>,
}

#[derive(Clone)]
pub(crate) struct Identity {
    pub room: String,
    pub id: String,
    pub generation: String,
}

impl Hub {
    fn close_tunnels(&mut self, id: &str) {
        for (a, b, session) in self.relay.remove_owner(id) {
            for (from, to) in [(&a, &b), (&b, &a)] {
                if let Some(peer) = self.peer(to) {
                    peer.send(ServerMessage::Relay {
                        from: from.clone(),
                        session: session.clone(),
                        data: RelayPacket::Close,
                    });
                }
            }
        }
    }

    fn peer(&self, id: &str) -> Option<&Peer> {
        self.rooms.get(self.peer_rooms.get(id)?)?.get(id)
    }

    pub(crate) fn current(&self, identity: &Identity) -> Result<&Peer, ServerMessage> {
        self.rooms
            .get(&identity.room)
            .and_then(|peers| peers.get(&identity.id))
            .filter(|peer| peer.generation == identity.generation)
            .ok_or_else(stale_session)
    }

    fn observers(&self, id: &str) -> HashSet<String> {
        let mut ids = self.pairs.get(id).cloned().unwrap_or_default();
        if let Some(room) = self.peer_rooms.get(id) {
            if let Some(peers) = self.rooms.get(room) {
                ids.extend(peers.keys().cloned());
            }
        }
        if let Some(number) = self
            .peer(id)
            .and_then(|peer| peer.profile.numeric_id.as_ref())
        {
            if let Some(members) = self.numeric_ids.get(number) {
                ids.extend(members.iter().cloned());
            }
            for (subscriber, groups) in self.subscriptions.iter().chain(&self.recent_subscriptions)
            {
                if groups.contains(number) {
                    ids.insert(subscriber.clone());
                }
            }
        }
        for groups in self
            .subscriptions
            .get(id)
            .into_iter()
            .chain(self.recent_subscriptions.get(id))
        {
            for group in groups {
                if let Some(peers) = self.numeric_ids.get(group) {
                    ids.extend(peers.iter().cloned());
                }
            }
        }
        ids.remove(id);
        ids
    }

    fn profiles(&self, ids: &HashSet<String>) -> Vec<Profile> {
        let mut profiles = ids
            .iter()
            .filter_map(|id| self.peer(id))
            .map(|peer| peer.profile.clone())
            .collect::<Vec<_>>();
        profiles.sort_by(|a, b| a.id.cmp(&b.id));
        profiles
    }

    fn check_lookup(
        &mut self,
        identity: &Identity,
        request_id: &str,
        numeric_id: &str,
    ) -> Result<(), ServerMessage> {
        self.current(identity)?;
        let error = |code: &str, message: &str| connect_error(request_id, code, message);
        let (started, attempts) = self
            .connect_attempts
            .entry(identity.id.clone())
            .or_insert((now_ms(), 0));
        if now_ms().saturating_sub(*started) >= CONNECT_WINDOW {
            *started = now_ms();
            *attempts = 0;
        }
        if *attempts >= MAX_CONNECT_ATTEMPTS {
            return Err(error("connect_rate_limited", "尝试过于频繁，请稍后重试"));
        }
        *attempts += 1;
        if !valid_identifier(request_id) || !valid_numeric_id(numeric_id) {
            return Err(error("invalid_numeric_id", "请输入有效的 6 位蜂鸟号"));
        }
        Ok(())
    }

    fn remove_number(&mut self, id: &str, number: &str, preserve_group: bool) {
        if let Some(members) = self.numeric_ids.get_mut(number) {
            members.remove(id);
            if members.is_empty() && !preserve_group {
                self.numeric_ids.remove(number);
                // Recent contacts retain bounded subscription intent. Explicit
                // lookups keep their existing lifetime and do not follow reused groups.
                self.subscriptions.retain(|_, groups| {
                    groups.remove(number);
                    !groups.is_empty()
                });
            }
        }
    }

    fn pair(&mut self, a: &str, b: &str) {
        self.pairs
            .entry(a.to_owned())
            .or_default()
            .insert(b.to_owned());
        self.pairs
            .entry(b.to_owned())
            .or_default()
            .insert(a.to_owned());
    }

    fn remove(&mut self, id: &str, preserve_number: bool) -> Option<Peer> {
        self.close_tunnels(id);
        let observers = self.observers(id);
        let room = self.peer_rooms.remove(id)?;
        let peers = self.rooms.get_mut(&room)?;
        let peer = peers.remove(id)?;
        if peers.is_empty() {
            self.rooms.remove(&room);
        }
        if let Some(number) = &peer.profile.numeric_id {
            self.remove_number(id, number, preserve_number);
        }
        self.subscriptions.remove(id);
        self.recent_subscriptions.remove(id);
        self.connect_attempts.remove(id);
        if let Some(pairs) = self.pairs.remove(id) {
            for paired_id in pairs {
                if let Some(paired) = self.pairs.get_mut(&paired_id) {
                    paired.remove(id);
                    if paired.is_empty() {
                        self.pairs.remove(&paired_id);
                    }
                }
            }
        }
        for observer in observers {
            if let Some(other) = self.peer(&observer) {
                other.send(ServerMessage::PeerLeft { id: id.to_owned() });
            }
        }
        Some(peer)
    }

    fn recent_groups(&self, own_number: &str, numbers: Vec<String>) -> HashSet<String> {
        numbers
            .into_iter()
            .filter(|number| number != own_number)
            .collect()
    }
}

impl AppState {
    pub(crate) fn join(
        &self,
        room: String,
        mut peer: Peer,
        recent_numeric_ids: Vec<String>,
    ) -> Result<Identity, ServerMessage> {
        validate_recent_numbers(&recent_numeric_ids)?;
        // Nonblocking sends under this lock preserve presence-before-signal ordering.
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        peer.profile.relay &= self.config.relay_enabled && peer.profile.supports("relay");
        let id = peer.profile.id.clone();
        let removes_old_room = hub.peer_rooms.get(&id).is_some_and(|old_room| {
            old_room != &room
                && hub
                    .rooms
                    .get(old_room)
                    .is_some_and(|peers| peers.len() == 1)
        });
        if !hub.rooms.contains_key(&room)
            && hub.rooms.len() - usize::from(removes_old_room) >= self.config.max_rooms
        {
            return Err(ServerMessage::error(
                "room_limit",
                "The server room limit was reached",
            ));
        }
        if hub.rooms.get(&room).is_some_and(|peers| {
            !peers.contains_key(&id) && peers.len() >= self.config.max_peers_per_room
        }) {
            return Err(ServerMessage::error("room_full", "The room is full"));
        }
        let number = peer.profile.numeric_id.clone().ok_or_else(|| {
            ServerMessage::error("invalid_profile", "A device-owned numericId is required")
        })?;
        if hub.numeric_ids.get(&number).is_some_and(|members| {
            !members.contains(&id) && members.len() >= self.config.max_peers_per_room
        }) {
            return Err(ServerMessage::error(
                "room_full",
                "The number group is full",
            ));
        }
        peer.profile.numeric_id = Some(number.clone());
        // Do not evict the existing session until every capacity check has succeeded.
        let preserve_number = hub
            .peer(&id)
            .and_then(|peer| peer.profile.numeric_id.as_ref())
            == Some(&number);
        if let Some(old) = hub.remove(&id, preserve_number) {
            old.transport.close(CloseReason::Replaced);
        }
        let identity = Identity {
            room: room.clone(),
            id: id.clone(),
            generation: peer.generation.clone(),
        };
        hub.numeric_ids
            .entry(number.clone())
            .or_default()
            .insert(id.clone());
        hub.peer_rooms.insert(id.clone(), room.clone());
        hub.rooms
            .entry(room)
            .or_default()
            .insert(id.clone(), peer.clone());
        let recent_groups = hub.recent_groups(&number, recent_numeric_ids);
        if !recent_groups.is_empty() {
            hub.recent_subscriptions.insert(id.clone(), recent_groups);
        }
        let observers = hub.observers(&id);
        peer.send(ServerMessage::Welcome {
            runtime: crate::protocol::capabilities::server_runtime(self.config.relay_enabled),
            id: id.clone(),
            room: identity.room.clone(),
            numeric_id: number,
            peers: hub.profiles(&observers),
        });
        let joined = ServerMessage::PeerJoined {
            peer: Box::new(peer.profile),
        };
        for observer in observers {
            if let Some(other) = hub.peer(&observer) {
                other.send(joined.clone());
            }
        }
        Ok(identity)
    }

    pub(crate) fn discover(
        &self,
        identity: &Identity,
        recent_numeric_ids: Vec<String>,
    ) -> Result<(), ServerMessage> {
        validate_recent_numbers(&recent_numeric_ids)?;
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        let requester = hub.current(identity)?.clone();
        let previous = hub.observers(&identity.id);
        let groups = hub.recent_groups(
            requester.profile.numeric_id.as_deref().unwrap(),
            recent_numeric_ids,
        );
        if groups.is_empty() {
            hub.recent_subscriptions.remove(&identity.id);
        } else {
            hub.recent_subscriptions.insert(identity.id.clone(), groups);
        }
        let observers = hub.observers(&identity.id);
        let added = observers.difference(&previous).cloned().collect();
        let mut removed = previous.difference(&observers).cloned().collect::<Vec<_>>();
        removed.sort();
        // One response keeps a large number group from overflowing the sender's queue.
        requester.send(ServerMessage::DiscoveryUpdated {
            peers: hub.profiles(&added),
            removed_peer_ids: removed.clone(),
        });
        for id in &removed {
            if let Some(other) = hub.peer(id) {
                other.send(ServerMessage::PeerLeft {
                    id: identity.id.clone(),
                });
            }
        }
        for id in observers.difference(&previous) {
            if let Some(other) = hub.peer(id) {
                other.send(ServerMessage::PeerJoined {
                    peer: Box::new(requester.profile.clone()),
                });
            }
        }
        Ok(())
    }

    pub(crate) fn change_numeric_id(
        &self,
        identity: &Identity,
        number: String,
        revision: u64,
    ) -> Result<(), ServerMessage> {
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        let current = hub.current(identity)?;
        if !valid_numeric_id(&number) || !(1..=9_007_199_254_740_991).contains(&revision) {
            return Err(ServerMessage::error(
                "invalid_numeric_id",
                "Invalid number or revision",
            ));
        }
        if current.number_revision >= revision {
            return Ok(());
        }
        let old_number = current
            .profile
            .numeric_id
            .clone()
            .expect("registered device number");
        if old_number == number {
            return Ok(());
        }
        if hub
            .numeric_ids
            .get(&number)
            .is_some_and(|members| members.len() >= self.config.max_peers_per_room)
        {
            return Err(ServerMessage::error(
                "room_full",
                "The number group is full",
            ));
        }
        let previous = hub.observers(&identity.id);
        for id in &previous {
            hub.pair(&identity.id, id);
        }
        hub.remove_number(&identity.id, &old_number, false);
        hub.numeric_ids
            .entry(number.clone())
            .or_default()
            .insert(identity.id.clone());
        let current = hub
            .rooms
            .get_mut(&identity.room)
            .unwrap()
            .get_mut(&identity.id)
            .unwrap();
        current.number_revision = revision;
        current.profile.numeric_id = Some(number.clone());
        let profile = current.profile.clone();
        let observers = hub.observers(&identity.id);
        for id in &observers {
            if let Some(other) = hub.peer(id) {
                if previous.contains(id) {
                    other.send(ServerMessage::NumericIdChanged {
                        id: identity.id.clone(),
                        previous_numeric_id: old_number.clone(),
                        numeric_id: number.clone(),
                        revision,
                    });
                } else {
                    other.send(ServerMessage::PeerJoined {
                        peer: Box::new(profile.clone()),
                    });
                }
            }
        }
        let current = hub.current(identity)?;
        for peer in hub.profiles(&observers.difference(&previous).cloned().collect()) {
            current.send(ServerMessage::PeerJoined {
                peer: Box::new(peer),
            });
        }
        Ok(())
    }

    pub(crate) fn connect_group(
        &self,
        identity: &Identity,
        request_id: String,
        numeric_id: &str,
    ) -> Result<(), ServerMessage> {
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        hub.check_lookup(identity, &request_id, numeric_id)?;
        let members = hub.numeric_ids.get(numeric_id).cloned().ok_or_else(|| {
            connect_error(
                &request_id,
                "peer_unavailable",
                "未找到这个蜂鸟号的在线设备",
            )
        })?;
        let requester = hub.current(identity)?.clone();
        let previous = hub.observers(&identity.id);
        let members = members
            .into_iter()
            .filter(|id| id != &identity.id)
            .collect::<HashSet<_>>();
        if requester.profile.numeric_id.as_deref() != Some(numeric_id) {
            hub.subscriptions
                .entry(identity.id.clone())
                .or_default()
                .insert(numeric_id.to_owned());
        }
        requester.send(ServerMessage::GroupResolved {
            request_id,
            numeric_id: numeric_id.to_owned(),
            peers: hub.profiles(&members),
        });
        for id in members.difference(&previous) {
            if let Some(other) = hub.peer(id) {
                other.send(ServerMessage::PeerJoined {
                    peer: Box::new(requester.profile.clone()),
                });
            }
        }
        Ok(())
    }

    pub(crate) fn connect_peer(
        &self,
        identity: &Identity,
        request_id: String,
        numeric_id: &str,
        expected_peer_id: Option<&str>,
    ) -> Result<(), ServerMessage> {
        let error = |code: &str, message: &str| connect_error(&request_id, code, message);
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        hub.check_lookup(identity, &request_id, numeric_id)?;
        let requester = hub.current(identity)?.clone();
        let expected = expected_peer_id
            .filter(|id| valid_identifier(id))
            .ok_or_else(|| error("identity_required", "恢复联系人连接需要指定设备身份"))?;
        if expected == identity.id {
            return Err(error("invalid_target", "不能连接自己的设备"));
        }
        let target = hub
            .peer(expected)
            .cloned()
            .ok_or_else(|| error("peer_unavailable", "未找到该联系人的在线设备"))?;
        if target.profile.numeric_id.as_deref() != Some(numeric_id) {
            return Err(error("identity_changed", "该联系人当前不在这个蜂鸟号中"));
        }
        let already_visible = hub.observers(&identity.id).contains(expected);
        if !already_visible {
            hub.pairs
                .entry(identity.id.clone())
                .or_default()
                .insert(expected.to_owned());
            hub.pairs
                .entry(expected.to_owned())
                .or_default()
                .insert(identity.id.clone());
        }
        requester.send(ServerMessage::PeerResolved {
            request_id,
            peer: Box::new(target.profile.clone()),
        });
        if !already_visible {
            target.send(ServerMessage::PeerJoined {
                peer: Box::new(requester.profile),
            });
        }
        Ok(())
    }

    pub(crate) fn relay(
        &self,
        identity: &Identity,
        to: &str,
        session: &str,
        data: RelayPacket,
    ) -> Result<(), ServerMessage> {
        if !self.config.relay_enabled {
            return Err(ServerMessage::error(
                "relay_disabled",
                "This server does not relay content",
            ));
        }
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        let sender = hub.current(identity)?;
        if !valid_identifier(session) || !data.valid() || to == identity.id {
            return Err(ServerMessage::error("invalid_relay", "Invalid relay frame"));
        }
        let target = hub
            .peer(to)
            .filter(|_| hub.observers(&identity.id).contains(to))
            .ok_or_else(|| ServerMessage::error("peer_unavailable", "Peer is not available"))?;
        if !sender.profile.relay || !target.profile.relay {
            return Err(ServerMessage::error(
                "relay_not_allowed",
                "Both devices must enable relay",
            ));
        }
        let transport = target.transport.clone();
        let target_generation = target.generation.clone();
        if !hub.relay.route(
            &identity.id,
            to,
            &identity.generation,
            &target_generation,
            session,
            &data,
        ) {
            return Err(ServerMessage::error(
                "invalid_tunnel",
                "Tunnel is closed or its receive window is exhausted",
            ));
        }
        if !transport.send(ServerMessage::Relay {
            from: identity.id.clone(),
            session: session.into(),
            data,
        }) {
            transport.close(CloseReason::SlowConsumer);
            return Err(ServerMessage::error(
                "slow_consumer",
                "Relay recipient cannot keep up",
            ));
        }
        Ok(())
    }

    pub(crate) fn signal(
        &self,
        identity: &Identity,
        to: &str,
        data: Value,
    ) -> Result<(), ServerMessage> {
        let hub = self.hub.lock().expect("hub lock poisoned");
        hub.current(identity)?;
        if to == identity.id {
            return Err(ServerMessage::error(
                "invalid_target",
                "Cannot signal yourself",
            ));
        }
        let visible = hub.observers(&identity.id).contains(to);
        let target = hub.peer(to).filter(|_| visible).ok_or_else(|| {
            ServerMessage::error("peer_unavailable", "Peer is offline or outside this room")
        })?;
        if !valid_signal(&data) {
            return Err(ServerMessage::error(
                "invalid_signal",
                "Unsupported signaling message",
            ));
        }
        target.send(ServerMessage::Signal {
            from: identity.id.clone(),
            data,
        });
        Ok(())
    }

    pub(crate) fn leave(&self, identity: &Identity) {
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        if hub.current(identity).is_ok() {
            hub.remove(&identity.id, false);
        }
    }
}

fn stale_session() -> ServerMessage {
    ServerMessage::error(
        "session_replaced",
        "This connection no longer owns the identity",
    )
}

fn connect_error(request_id: &str, code: &str, message: &str) -> ServerMessage {
    ServerMessage::ConnectError {
        request_id: request_id.to_owned(),
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

// Both runtimes use the same synchronous business logic; only delivery differs.
pub(crate) trait Transport: Send + Sync {
    fn send(&self, message: ServerMessage) -> bool;
    fn close(&self, reason: CloseReason);
}

pub(crate) fn now_ms() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now() as u64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_millis() as u64
    }
}
