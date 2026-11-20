use subtle::ConstantTimeEq;

pub fn authorized(secret: &str, header: Option<&str>) -> bool {
    secret.is_empty()
        || header.is_some_and(|header| bool::from(secret.as_bytes().ct_eq(header.as_bytes())))
}

pub fn room(query: &str) -> Option<String> {
    let mut values = url::form_urlencoded::parse(query.as_bytes()).filter(|(key, _)| key == "room");
    let room = values
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| "local".into());
    (values.next().is_none() && crate::protocol::valid_identifier(&room)).then_some(room)
}

pub fn authenticate(
    secret: &str,
    packet: Option<&crate::protocol::ClientMessage>,
    sid: &str,
    relay: bool,
) -> Option<crate::protocol::ServerMessage> {
    let crate::protocol::ClientMessage::Auth { authorization } = packet? else {
        return None;
    };
    authorized(secret, authorization.as_deref()).then(|| {
        crate::protocol::ServerMessage::Capabilities {
            challenge: crate::protocol::challenge(sid),
            runtime: crate::protocol::capabilities::server_runtime(relay),
        }
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub fn sensitive_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "sec-websocket-protocol"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_required_only_when_configured() {
        assert!(authorized("", None));
        assert!(!authorized("Bearer secret", None));
        assert!(!authorized("Bearer secret", Some("Bearer wrong")));
        assert!(authorized("Bearer secret", Some("Bearer secret")));
    }
}
