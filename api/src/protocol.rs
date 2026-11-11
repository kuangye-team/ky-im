use serde::{Deserialize, Serialize};
use serde_json::Value;

#[path = "../../shared/client_type.rs"]
mod client_type;
pub use client_type::ClientType;

pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;
pub const MAX_RELAY_BINARY_BYTES: usize = 128 * 1024 + 44;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    // Shared automatic discovery group code, never a device identity.
    #[serde(default, rename = "numericId", skip_serializing_if = "Option::is_none")]
    pub numeric_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub device: String,
    #[serde(rename = "clientType")]
    pub client_type: ClientType,
    /// Effective consent on this server, never inherited from another server.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub relay: bool,
}

impl Profile {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_identifier(&self.id) {
            return Err("id must contain 1–64 ASCII letters, digits, '-' or '_'");
        }
        if self
            .numeric_id
            .as_deref()
            .is_some_and(|id| !valid_numeric_id(id))
        {
            return Err("numericId must contain six digits, without a leading zero");
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 48 {
            return Err("name must contain 1–48 characters");
        }
        if self.bio.chars().count() > 160
            || self.color.len() > 32
            || self.avatar.len() > 2048
            || self.device.chars().count() > 64
        {
            return Err("profile exceeds the allowed field lengths");
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

#[path = "../../shared/network_signal.rs"]
mod network_signal;
pub use network_signal::valid_signal;

fn default_room() -> String {
    "local".into()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientMessage {
    Capabilities,
    Relay {
        to: String,
        session: String,
        data: RelayPacket,
    },
    Join {
        #[serde(default = "default_room")]
        room: String,
        profile: Profile,
    },
    Profile {
        profile: Profile,
    },
    RefreshNumber {
        #[serde(rename = "requestId")]
        request_id: String,
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
        relay: bool,
    },
    Relay {
        from: String,
        session: String,
        data: RelayPacket,
    },
    RelayError {
        to: String,
        session: String,
        code: String,
        message: String,
    },
    NumberUpdated {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(rename = "numericId")]
        numeric_id: String,
        #[serde(rename = "peerIds")]
        peer_ids: Vec<String>,
    },
    Welcome {
        relay: bool,
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
    PeerUpdated {
        peer: Box<Profile>,
    },
    PeerLeft {
        id: String,
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

/// Bounded frames, with receive credit returned by the consuming device.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RelayPacket {
    Open,
    Accept,
    Close,
    Ack,
    Data { binary: bool, payload: String },
}

impl RelayPacket {
    pub fn valid(&self) -> bool {
        match self {
            Self::Data { payload, binary } => {
                let limit = if *binary {
                    MAX_RELAY_BINARY_BYTES
                } else {
                    48 * 1024
                };
                !payload.is_empty()
                    && payload.len() <= limit.div_ceil(3) * 4
                    && payload.len().is_multiple_of(4)
                    && payload
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
            }
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
