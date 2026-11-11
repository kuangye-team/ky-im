use serde::{Deserialize, Serialize};
use serde_json::Value;

// The signaling socket has no chat/file transport. Only connection negotiation
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
    serde_json::from_value::<TcpSignal>(data.clone()).is_ok_and(|signal| signal.tcp.validate())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TcpEndpoint {
    pub instance: String,
    pub port: u16,
    pub addresses: Vec<std::net::Ipv4Addr>,
}
impl TcpEndpoint {
    pub fn validate(&self) -> bool {
        self.instance.len() == 36
            && self
                .instance
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-')
            && self.port > 0
            && !self.addresses.is_empty()
            && self.addresses.len() <= 16
            && self.addresses.iter().all(|ip| {
                !ip.is_unspecified()
                    && !ip.is_multicast()
                    && !ip.is_broadcast()
                    && !ip.is_loopback()
            })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TcpSignal {
    tcp: TcpEndpoint,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn tcp_negotiation_is_bounded_and_cannot_carry_chat_content() {
        let endpoint = json!({"tcp":{"instance":"10000000-0000-4000-8000-000000000000","port":1234,"addresses":["192.168.1.2"]}});
        assert!(valid_signal(&endpoint));
        for field in ["text", "file", "profile", "url"] {
            let mut invalid = endpoint.clone();
            invalid["tcp"][field] = json!("payload");
            assert!(!valid_signal(&invalid));
        }
        for ip in [
            "127.0.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "example.com",
        ] {
            let mut invalid = endpoint.clone();
            invalid["tcp"]["addresses"] = json!([ip]);
            assert!(!valid_signal(&invalid));
        }
        let mut invalid = endpoint.clone();
        invalid["tcp"]["port"] = json!(0);
        assert!(!valid_signal(&invalid));
        invalid = endpoint;
        invalid["tcp"]["addresses"] = json!(vec!["192.168.1.2"; 17]);
        assert!(!valid_signal(&invalid));
    }
}
