use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

const TICKET_TTL_MS: u64 = 30_000;

pub fn authorized(secret: &str, header: Option<&str>) -> bool {
    secret.is_empty()
        || header.is_some_and(|header| bool::from(secret.as_bytes().ct_eq(header.as_bytes())))
}

fn signature(secret: &str, expires: &str) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(b"hummingbird-websocket-ticket-v1:");
    mac.update(expires.as_bytes());
    mac
}

/// Short-lived bearer credential for browsers, which cannot set WebSocket request headers.
pub fn ticket(secret: &str, now: u64) -> Option<String> {
    if secret.is_empty() {
        return None;
    }
    let expires = (now + TICKET_TTL_MS).to_string();
    let digest = signature(secret, &expires).finalize().into_bytes();
    Some(format!("{expires}.{}", URL_SAFE_NO_PAD.encode(digest)))
}

pub fn valid_ticket(secret: &str, ticket: &str, now: u64) -> bool {
    if secret.is_empty() {
        return false;
    }
    let Some((expires, digest)) = ticket.split_once('.') else {
        return false;
    };
    let Ok(deadline) = expires.parse::<u64>() else {
        return false;
    };
    if deadline <= now || deadline > now.saturating_add(TICKET_TTL_MS) {
        return false;
    }
    let Ok(digest) = URL_SAFE_NO_PAD.decode(digest) else {
        return false;
    };
    signature(secret, expires).verify_slice(&digest).is_ok()
}

pub fn websocket_authorized(secret: &str, header: Option<&str>, query: &str, now: u64) -> bool {
    authorized(secret, header)
        || url::form_urlencoded::parse(query.as_bytes())
            .any(|(key, value)| key == "ticket" && valid_ticket(secret, &value, now))
}

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
    fn credentials_and_tickets_are_required_only_when_configured() {
        assert!(authorized("", None));
        assert!(!authorized("Bearer secret", None));
        assert!(!authorized("Bearer secret", Some("Bearer wrong")));
        assert!(authorized("Bearer secret", Some("Bearer secret")));
        let token = ticket("Bearer secret", 1_000).unwrap();
        assert!(valid_ticket("Bearer secret", &token, 1_001));
        assert!(!valid_ticket("Bearer secret", &token, 31_000));
        assert!(!valid_ticket("Bearer changed", &token, 1_001));
        assert!(!valid_ticket("Bearer secret", &format!("{token}x"), 1_001));
        assert!(!valid_ticket("", &token, 1_001));
        assert!(!valid_ticket("Bearer secret", "invalid", 1_001));
        assert!(!valid_ticket("Bearer secret", &token, 0));
    }
}
