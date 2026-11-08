use crate::{
    AppState,
    protocol::{Profile, ServerMessage, valid_identifier, valid_numeric_id, valid_signal},
};
use serde_json::Value;
use std::{
    collections::{
        HashMap, HashSet,
        hash_map::{DefaultHasher, RandomState},
    },
    hash::{BuildHasher, Hash, Hasher},
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
    pub rooms: HashMap<String, HashMap<String, Peer>>,
    peer_rooms: HashMap<String, String>,
    // Numbers identify automatic discovery groups (namespace + observed source IP).
    numeric_ids: HashMap<String, String>,
    room_numbers: HashMap<String, String>,
    // A subscriber sees group members; subscribers do not discover one another.
    subscriptions: HashMap<String, HashSet<String>>,
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
    fn peer(&self, id: &str) -> Option<&Peer> {
        self.rooms.get(self.peer_rooms.get(id)?)?.get(id)
    }

    fn current(&self, identity: &Identity) -> Result<&Peer, ServerMessage> {
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
            for (subscriber, groups) in &self.subscriptions {
                if groups.contains(room) {
                    ids.insert(subscriber.clone());
                }
            }
        }
        if let Some(groups) = self.subscriptions.get(id) {
            for group in groups {
                if let Some(peers) = self.rooms.get(group) {
                    ids.extend(peers.keys().cloned());
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

    fn remove(&mut self, id: &str, preserve_room: bool) -> Option<Peer> {
        let observers = self.observers(id);
        let room = self.peer_rooms.remove(id)?;
        let peers = self.rooms.get_mut(&room)?;
        let peer = peers.remove(id)?;
        if peers.is_empty() && !preserve_room {
            self.rooms.remove(&room);
            if let Some(number) = self.room_numbers.remove(&room) {
                self.numeric_ids.remove(&number);
            }
            // A released number must never transfer subscriptions to a new group.
            self.subscriptions.retain(|_, groups| {
                groups.remove(&room);
                !groups.is_empty()
            });
        }
        self.subscriptions.remove(id);
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

    fn assign_number(
        &self,
        room: &str,
        preferred: Option<&str>,
        replacing_id: &str,
    ) -> Result<String, ServerMessage> {
        if let Some(number) = self.room_numbers.get(room) {
            return Ok(number.clone());
        }
        if let Some(number) = preferred.filter(|number| {
            self.numeric_ids.get(*number).is_none_or(|existing_room| {
                self.peer_rooms.get(replacing_id) == Some(existing_room)
                    && self
                        .rooms
                        .get(existing_room)
                        .is_some_and(|peers| peers.len() == 1)
            })
        }) {
            return Ok(number.to_owned());
        }
        // A stable group starting point helps reconnects retain their code.
        // Saved codes are preferences; collisions never merge different source groups.
        let mut hasher = DefaultHasher::new();
        room.hash(&mut hasher);
        let start = hasher.finish() % 900_000;
        self.available_number(start)
    }

    fn available_number(&self, start: u64) -> Result<String, ServerMessage> {
        for offset in 0..900_000 {
            let number = (100_000 + (start + offset) % 900_000).to_string();
            if !self.numeric_ids.contains_key(&number) {
                return Ok(number);
            }
        }
        Err(ServerMessage::error(
            "id_limit",
            "No numeric IDs are available",
        ))
    }
}

impl AppState {
    pub(crate) fn join(&self, room: String, mut peer: Peer) -> Result<Identity, ServerMessage> {
        // Nonblocking sends under this lock preserve presence-before-signal ordering.
        let mut hub = self.hub.lock().expect("hub lock poisoned");
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
        let number = hub.assign_number(&room, peer.profile.numeric_id.as_deref(), &id)?;
        peer.profile.numeric_id = Some(number.clone());
        // Do not evict the existing session until every capacity check has succeeded.
        let preserve_room = hub.peer_rooms.get(&id) == Some(&room);
        if let Some(old) = hub.remove(&id, preserve_room) {
            old.transport.close(CloseReason::Replaced);
        }
        let identity = Identity {
            room: room.clone(),
            id: id.clone(),
            generation: peer.generation.clone(),
        };
        hub.numeric_ids.insert(number.clone(), room.clone());
        hub.room_numbers.insert(room.clone(), number.clone());
        hub.peer_rooms.insert(id.clone(), room.clone());
        hub.rooms
            .entry(room)
            .or_default()
            .insert(id.clone(), peer.clone());
        let observers = hub.observers(&id);
        peer.send(ServerMessage::Welcome {
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

    pub(crate) fn update_profile(
        &self,
        identity: &Identity,
        mut profile: Profile,
    ) -> Result<(), ServerMessage> {
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        let current = hub.current(identity)?;
        profile.id.clone_from(&identity.id);
        profile.numeric_id.clone_from(&current.profile.numeric_id);
        profile
            .validate()
            .map_err(|message| ServerMessage::error("invalid_profile", message))?;
        if profile == current.profile {
            return Ok(());
        }
        hub.rooms
            .get_mut(&identity.room)
            .unwrap()
            .get_mut(&identity.id)
            .unwrap()
            .profile = profile.clone();
        for id in hub.observers(&identity.id) {
            if let Some(other) = hub.peer(&id) {
                other.send(ServerMessage::PeerUpdated {
                    peer: Box::new(profile.clone()),
                });
            }
        }
        Ok(())
    }

    pub(crate) fn refresh_number(
        &self,
        identity: &Identity,
        request_id: String,
    ) -> Result<(), ServerMessage> {
        let mut hub = self.hub.lock().expect("hub lock poisoned");
        let old_number = hub.current(identity)?.profile.numeric_id.clone().unwrap();
        // Share discovery's request validation and per-identity rate limit.
        hub.check_lookup(identity, &request_id, &old_number)?;
        let start = RandomState::new().hash_one((&identity.id, now_ms())) % 900_000;
        // Keep the old number occupied until a different free number is found.
        let number = hub
            .available_number(start)
            .map_err(|_| connect_error(&request_id, "id_limit", "当前在线人数较多，请稍后再来"))?;
        hub.numeric_ids.remove(&old_number);
        hub.numeric_ids
            .insert(number.clone(), identity.room.clone());
        hub.room_numbers
            .insert(identity.room.clone(), number.clone());
        let members = hub.rooms.get_mut(&identity.room).unwrap();
        for member in members.values_mut() {
            member.profile.numeric_id = Some(number.clone());
        }
        let member_ids = members.keys().cloned().collect::<Vec<_>>();
        // One batch per recipient avoids overflowing signaling queues in large groups.
        // Only include identities this recipient already has permission to discover.
        let mut updates: HashMap<String, Vec<String>> = HashMap::new();
        for id in member_ids {
            let mut recipients = hub.observers(&id);
            recipients.insert(id.clone());
            for recipient in recipients {
                updates.entry(recipient).or_default().push(id.clone());
            }
        }
        for (recipient, mut peer_ids) in updates {
            peer_ids.sort();
            if let Some(peer) = hub.peer(&recipient) {
                peer.send(ServerMessage::NumberUpdated {
                    request_id: (recipient == identity.id).then(|| request_id.clone()),
                    numeric_id: number.clone(),
                    peer_ids,
                });
            }
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
        let group = hub.numeric_ids.get(numeric_id).cloned().ok_or_else(|| {
            connect_error(
                &request_id,
                "peer_unavailable",
                "未找到这个蜂鸟号的在线设备",
            )
        })?;
        let requester = hub.current(identity)?.clone();
        let previous = hub.observers(&identity.id);
        let members = hub
            .rooms
            .get(&group)
            .unwrap()
            .keys()
            .filter(|id| *id != &identity.id)
            .cloned()
            .collect::<HashSet<_>>();
        if group != identity.room {
            hub.subscriptions
                .entry(identity.id.clone())
                .or_default()
                .insert(group);
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
                "Only WebRTC SDP descriptions and ICE candidates are allowed",
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

// Keep the existing DO row format so a Wasm deployment can restore TS sessions.
#[cfg(target_arch = "wasm32")]
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct StoredPeer {
    pub sid: String,
    pub room: String,
    pub profile: Profile,
    pub subscriptions: Vec<String>,
    pub pairs: Vec<String>,
}

#[cfg(target_arch = "wasm32")]
impl Hub {
    pub fn restore(
        &mut self,
        stored: StoredPeer,
        transport: Arc<dyn Transport>,
        lookup: (u64, u8),
    ) {
        let id = stored.profile.id.clone();
        let number = stored
            .profile
            .numeric_id
            .clone()
            .expect("stored group number");
        self.numeric_ids.insert(number.clone(), stored.room.clone());
        self.room_numbers.insert(stored.room.clone(), number);
        self.peer_rooms.insert(id.clone(), stored.room.clone());
        self.subscriptions
            .insert(id.clone(), stored.subscriptions.into_iter().collect());
        self.pairs
            .insert(id.clone(), stored.pairs.into_iter().collect());
        self.connect_attempts.insert(id.clone(), lookup);
        self.rooms.entry(stored.room).or_default().insert(
            id,
            Peer {
                profile: stored.profile,
                generation: stored.sid,
                transport,
            },
        );
    }

    pub fn stored_peers(&self) -> Vec<StoredPeer> {
        self.rooms
            .iter()
            .flat_map(|(room, peers)| {
                peers.values().map(|peer| {
                    let id = &peer.profile.id;
                    let sorted = |map: &HashMap<String, HashSet<String>>| {
                        let mut values = map
                            .get(id)
                            .into_iter()
                            .flatten()
                            .cloned()
                            .collect::<Vec<_>>();
                        values.sort();
                        values
                    };
                    StoredPeer {
                        sid: peer.generation.clone(),
                        room: room.clone(),
                        profile: peer.profile.clone(),
                        subscriptions: sorted(&self.subscriptions),
                        pairs: sorted(&self.pairs),
                    }
                })
            })
            .collect()
    }

    pub fn identity_for_session(&self, sid: &str) -> Option<Identity> {
        self.rooms.iter().find_map(|(room, peers)| {
            peers
                .values()
                .find(|peer| peer.generation == sid)
                .map(|peer| Identity {
                    room: room.clone(),
                    id: peer.profile.id.clone(),
                    generation: sid.to_owned(),
                })
        })
    }

    pub fn lookup_rate(&self, identity: &Identity) -> (u64, u8) {
        self.connect_attempts
            .get(&identity.id)
            .copied()
            .unwrap_or((now_ms(), 0))
    }
}
