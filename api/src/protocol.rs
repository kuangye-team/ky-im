use serde::{Deserialize, Serialize};
#[path = "../../shared/capabilities.rs"]
pub mod capabilities;
use serde_json::Value;

pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    #[serde(rename = "numericId")]
    pub numeric_id: Option<String>,
    pub name: String,
    #[serde(rename = "clientType")]
    pub client_type: capabilities::ClientType,
    pub capabilities: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_object"
    )]
    pub extend: Option<serde_json::Map<String, Value>>,
    /// Effective consent on this server, never inherited from another server.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub relay: bool,
}

fn optional_object<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Map<String, Value>>, D::Error> {
    serde_json::Map::deserialize(deserializer).map(Some)
}

impl Profile {
    pub fn supports(&self, name: &str) -> bool {
        self.capabilities
            .iter()
            .any(|v| v == capabilities::capability(name))
    }
    pub fn supports_discovery(&self) -> bool {
        ["discovery", "signaling", "query"]
            .iter()
            .all(|name| self.supports(name))
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if !capabilities::valid_capabilities(&self.capabilities) {
            return Err("invalid runtime information");
        }
        if self.id.parse::<libp2p_identity::PeerId>().is_err() {
            return Err("invalid PeerId");
        }
        if self
            .numeric_id
            .as_deref()
            .is_none_or(|id| !valid_numeric_id(id))
        {
            return Err("numericId must contain six digits, without a leading zero");
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 48 {
            return Err("name must contain 1–48 characters");
        }
        if self.extend.as_ref().is_some_and(|object| {
            serde_json::to_vec(object).map_or(true, |bytes| bytes.len() > 8192)
        }) {
            return Err("discovery extension too large");
        }
        Ok(())
    }
}

pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn valid_numeric_id(value: &str) -> bool {
    value.len() == 6 && value.bytes().all(|b| b.is_ascii_digit()) && !value.starts_with('0')
}

mod network_signal;
pub use network_signal::valid_signal;

fn default_room() -> String {
    "local".into()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientMessage {
    Auth {
        authorization: Option<String>,
    },
    #[serde(rename = "tunnel")]
    Relay {
        to: String,
        session: String,
        data: RelayPacket,
    },
    Join {
        #[serde(default = "default_room")]
        room: String,
        profile: Profile,
        proof: IdentityProof,
        #[serde(default, rename = "recentNumericIds")]
        recent_numeric_ids: Vec<String>,
    },
    Discover {
        #[serde(rename = "recentNumericIds")]
        recent_numeric_ids: Vec<String>,
    },
    ChangeNumericId {
        #[serde(rename = "numericId")]
        numeric_id: String,
        revision: u64,
    },
    ConnectGroup {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "numericId")]
        numeric_id: String,
    },
    Connect {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "numericId")]
        numeric_id: String,
        #[serde(default, rename = "expectedPeerId")]
        expected_peer_id: Option<String>,
    },
    Signal {
        to: String,
        data: Value,
    },
    Ping,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Capabilities {
        challenge: String,
        #[serde(flatten)]
        runtime: capabilities::RuntimeInfo,
    },
    #[serde(rename = "tunnel")]
    Relay {
        from: String,
        session: String,
        data: RelayPacket,
    },
    #[serde(rename = "tunnel_error")]
    RelayError {
        to: String,
        session: String,
        code: String,
        message: String,
    },
    Welcome {
        #[serde(flatten)]
        runtime: capabilities::RuntimeInfo,
        id: String,
        room: String,
        #[serde(rename = "numericId")]
        numeric_id: String,
        peers: Vec<Profile>,
    },
    GroupResolved {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "numericId")]
        numeric_id: String,
        peers: Vec<Profile>,
    },
    PeerResolved {
        #[serde(rename = "requestId")]
        request_id: String,
        peer: Box<Profile>,
    },
    ConnectError {
        #[serde(rename = "requestId")]
        request_id: String,
        code: String,
        message: String,
    },
    PeerJoined {
        peer: Box<Profile>,
    },
    NumericIdRejected {
        code: String,
    },
    NumericIdChanged {
        id: String,
        #[serde(rename = "previousNumericId")]
        previous_numeric_id: String,
        #[serde(rename = "numericId")]
        numeric_id: String,
        revision: u64,
    },
    PeerLeft {
        id: String,
    },
    DiscoveryUpdated {
        peers: Vec<Profile>,
        #[serde(rename = "removedPeerIds")]
        removed_peer_ids: Vec<String>,
    },
    Signal {
        from: String,
        data: Value,
    },
    Pong,
    Error {
        code: String,
        message: String,
    },
}

/// Reliable ordered encrypted bytes, independent of application protocol streams.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RelayPacket {
    Open,
    Accept,
    Close,
    Credit {
        count: u8,
    },
    #[serde(skip)]
    Bytes {
        sequence: u32,
        payload: Vec<u8>,
    },
}
impl RelayPacket {
    pub fn valid(&self) -> bool {
        match self {
            Self::Credit { count } => *count > 0 && *count <= 8,
            Self::Bytes { payload, .. } => !payload.is_empty() && payload.len() <= 16 * 1024,
            _ => true,
        }
    }
}

impl ServerMessage {
    pub fn error(code: &str, message: &str) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Independent traffic budgets keep file chunks from exhausting signaling limits.
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct MessageRate {
    at: u64,
    signaling: u32,
    relay_frames: u32,
    relay_bytes: usize,
}
impl MessageRate {
    pub fn allow(&mut self, now: u64, relay: bool, bytes: usize) -> bool {
        if now.saturating_sub(self.at) >= 10_000 {
            *self = Self {
                at: now,
                ..Self::default()
            };
        }
        if relay {
            self.relay_frames += 1;
            self.relay_bytes += bytes;
            self.relay_frames <= 8192 && self.relay_bytes <= 64 * 1024 * 1024
        } else {
            self.signaling += 1;
            self.signaling <= 240
        }
    }
}

// KIM2, peer length, tunnel length, uint32 sequence (BE), routing IDs, ciphertext.
pub fn decode_relay_binary(raw: &[u8]) -> Option<ClientMessage> {
    if raw.len() < 10 || &raw[..4] != b"KIM2" {
        return None;
    }
    let a = raw[4] as usize;
    let b = raw[5] as usize;
    if a == 0 || b == 0 || a > 128 || b > 64 || raw.len() <= 10 + a + b {
        return None;
    }
    let to = std::str::from_utf8(&raw[10..10 + a]).ok()?.to_owned();
    let session = std::str::from_utf8(&raw[10 + a..10 + a + b])
        .ok()?
        .to_owned();
    if !valid_identifier(&session) || to.parse::<libp2p_identity::PeerId>().is_err() {
        return None;
    }
    let data = RelayPacket::Bytes {
        sequence: u32::from_be_bytes(raw[6..10].try_into().ok()?),
        payload: raw[10 + a + b..].to_vec(),
    };
    data.valid()
        .then_some(ClientMessage::Relay { to, session, data })
}
pub fn encode_relay_binary(message: &ServerMessage) -> Option<Vec<u8>> {
    let ServerMessage::Relay {
        from,
        session,
        data: RelayPacket::Bytes { sequence, payload },
    } = message
    else {
        return None;
    };
    let mut raw = Vec::with_capacity(10 + from.len() + session.len() + payload.len());
    raw.extend_from_slice(b"KIM2");
    raw.extend_from_slice(&[from.len() as u8, session.len() as u8]);
    raw.extend_from_slice(&sequence.to_be_bytes());
    raw.extend_from_slice(from.as_bytes());
    raw.extend_from_slice(session.as_bytes());
    raw.extend_from_slice(payload);
    Some(raw)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityProof {
    pub public_key: String,
    pub signature: String,
}
impl IdentityProof {
    pub fn verify(&self, peer: &str, generation: &str) -> bool {
        use base64::{Engine, engine::general_purpose::STANDARD};
        if self.public_key.len() > 256 || self.signature.len() > 256 {
            return false;
        }
        let Ok(bytes) = STANDARD.decode(&self.public_key) else {
            return false;
        };
        let Ok(key) = libp2p_identity::PublicKey::try_decode_protobuf(&bytes) else {
            return false;
        };
        let Ok(signature) = STANDARD.decode(&self.signature) else {
            return false;
        };
        key.to_peer_id().to_string() == peer
            && key.verify(challenge(generation).as_bytes(), &signature)
    }
}
pub fn challenge(generation: &str) -> String {
    format!("hummingbird/v2/register:{generation}")
}

pub(crate) fn validate_recent_numbers(numbers: &[String]) -> Result<(), ServerMessage> {
    if numbers.len() > 10 || numbers.iter().any(|number| !valid_numeric_id(number)) {
        return Err(ServerMessage::error(
            "invalid_discovery",
            "Expected at most 10 valid recent numeric IDs",
        ));
    }
    Ok(())
}
