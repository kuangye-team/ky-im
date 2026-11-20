use serde::Deserialize;
use serde_json::Value;

/// Validates address announcements, WebRTC descriptions, and runtime queries.
pub fn valid_signal(data: &Value) -> bool {
    if let Some(fields) = data.as_object()
        && let Some(addresses) = fields.get("addresses")
    {
        let valid_fields = fields.len() == 1
            || (fields.len() == 2
                && matches!(data["dial"].as_str(), Some("background" | "connect")));
        return valid_fields
            && addresses.as_array().is_some_and(|a| {
                a.len() <= 32 && a.iter().all(|v| v.as_str().is_some_and(valid_address))
            });
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Description {
        #[serde(rename = "type")]
        kind: String,
        sdp: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Negotiation {
        session: String,
        description: Description,
    }
    if let Ok(Negotiation {
        session,
        description,
    }) = Negotiation::deserialize(data)
    {
        return session.len() == 36
            && session.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            && matches!(description.kind.as_str(), "offer" | "answer")
            && description.sdp.len() < 128 * 1024
            && description.sdp.lines().next() == Some("v=0")
            && description
                .sdp
                .lines()
                .any(|line| line.starts_with("m=application "));
    }
    if let Some(object) = data.as_object() {
        let id = |v: &Value| {
            v.as_str().is_some_and(|s| {
                s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            })
        };
        if object.len() == 1 && object.get("runtimeQuery").is_some_and(id) {
            return true;
        }
        if object.len() == 2 && object.get("runtimeReply").is_some_and(id) {
            return object.get("runtime").is_some_and(|v| {
                serde_json::from_value::<super::capabilities::RuntimeInfo>(v.clone())
                    .is_ok_and(|info| info.valid())
            });
        }
    }
    false
}
fn valid_address(address: &str) -> bool {
    if address.len() > 512 {
        return false;
    }
    let parts = address.split('/').collect::<Vec<_>>();
    if parts.len() < 5 || !parts[0].is_empty() || !matches!(parts[1], "ip4" | "ip6") {
        return false;
    }
    let valid_ip = match parts[1] {
        "ip4" => parts[2]
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast()),
        _ => parts[2].parse::<std::net::Ipv6Addr>().is_ok_and(|ip| {
            !ip.is_unspecified() && !ip.is_multicast() && !ip.is_unicast_link_local()
        }),
    };
    if !valid_ip
        || !parts[4].bytes().all(|c| c.is_ascii_digit())
        || !parts[4].parse::<u16>().is_ok_and(|port| port > 0)
    {
        return false;
    }
    let sha256 = |hash: &str| {
        multibase::decode(hash)
            .is_ok_and(|(_, bytes)| bytes.len() == 34 && bytes.starts_with(&[0x12, 32]))
    };
    match (parts[3], &parts[5..]) {
        ("tcp", []) | ("udp", ["quic-v1"]) => true,
        ("udp", ["quic-v1", "webtransport", "certhash", hash]) => sha256(hash),
        (
            "udp",
            [
                "quic-v1",
                "webtransport",
                "certhash",
                first,
                "certhash",
                next,
            ],
        ) => sha256(first) && sha256(next),
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn validates_pinned_webtransport_announcements() {
        let hash = multibase::encode(
            multibase::Base::Base64Url,
            [vec![0x12, 32], vec![1; 32]].concat(),
        );
        let base = "/ip4/192.168.1.2/udp/9443/quic-v1/webtransport";
        let valid = format!("{base}/certhash/{hash}");
        assert!(valid_signal(&json!({"addresses":[valid]})));
        assert!(valid_signal(&json!({"addresses":[]})));
        assert!(valid_signal(
            &json!({"addresses":[valid],"dial":"background"})
        ));
        assert!(valid_signal(&json!({"addresses":[],"dial":"connect"})));
        assert!(!valid_signal(&json!({"addresses":[],"dial":"other"})));
        assert!(!valid_signal(
            &json!({"addresses":[],"dial":"connect","body":"unknown"})
        ));
        assert!(!valid_signal(
            &json!({"addresses":[valid], "requestDial":true})
        ));
        assert!(valid_address(&format!("{valid}/certhash/{hash}")));
        for address in [
            base.to_owned(),
            format!("{base}/certhash/uEiA"),
            format!("{valid}/p2p/other"),
            valid.replace("/udp/", "/tcp/"),
            valid.replace(&hash, "bad"),
            valid.replace(
                &hash,
                &multibase::encode(multibase::Base::Base64Url, [0; 34]),
            ),
        ] {
            assert!(!valid_address(&address));
        }
    }

    #[test]
    fn rejects_invalid_addresses_and_malformed_negotiations() {
        assert!(valid_signal(
            &json!({"addresses":["/ip4/192.168.1.2/tcp/1234","/ip6/::1/udp/2345/quic-v1"]})
        ));
        for address in [
            "/ip4/0.0.0.0/tcp/1234",
            "/ip4/127.0.0.1/tcp/0",
            "/dns4/example.com/tcp/80",
            "/ip4/192.168.1.2/tcp/1234/chat/text",
        ] {
            assert!(!valid_signal(&json!({"addresses":[address]})));
        }
        assert!(!valid_signal(
            &json!({"addresses":vec!["/ip4/192.168.1.2/tcp/1234";33]})
        ));
        assert!(!valid_signal(
            &json!({"description":{"type":"offer","sdp":"v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\n"}})
        ));
        assert!(!valid_signal(
            &json!({"tcp":{"instance":"00000000-0000-4000-8000-000000000000","port":1234,"addresses":["192.168.1.2"]}})
        ));
    }
}
