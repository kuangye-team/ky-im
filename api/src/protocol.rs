use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;

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

// The signaling socket has no chat/file transport. Only WebRTC negotiation
// envelopes are accepted, with strict field names and bounded SDP/ICE strings.
pub fn valid_signal(data: &Value) -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Description {
        #[serde(rename = "type")]
        kind: String,
        sdp: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct DescriptionSignal {
        description: Description,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Candidate {
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
        username_fragment: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CandidateSignal {
        candidate: Candidate,
    }
    if let Ok(signal) = serde_json::from_value::<DescriptionSignal>(data.clone()) {
        let sdp = signal.description.sdp;
        return matches!(signal.description.kind.as_str(), "offer" | "answer")
            && sdp.len() < 128 * 1024
            && sdp.lines().next() == Some("v=0")
            && sdp.lines().any(|line| line.starts_with("m=application "));
    }
    if let Ok(signal) = serde_json::from_value::<CandidateSignal>(data.clone()) {
        let candidate = signal.candidate;
        let _ = candidate.sdp_m_line_index;
        return candidate.candidate.len() < 4096
            && (candidate.candidate.is_empty() || candidate.candidate.starts_with("candidate:"))
            && candidate
                .sdp_mid
                .as_ref()
                .is_none_or(|mid| mid.len() <= 256)
            && candidate
                .username_fragment
                .as_ref()
                .is_none_or(|fragment| fragment.len() <= 256);
    }
    false
}

fn default_room() -> String {
    "local".into()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientMessage {
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
    NumberUpdated {
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(rename = "numericId")]
        numeric_id: String,
        #[serde(rename = "peerIds")]
        peer_ids: Vec<String>,
    },
    Welcome {
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

impl ServerMessage {
    pub fn error(code: &str, message: &str) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
        }
    }
}
