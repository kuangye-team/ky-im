use url::Url;

pub const MAX_BYTES: usize = 256 * 1024;
pub const CACHE_SECONDS: u64 = 300;
pub const DEFAULT_URL: &str =
    "https://github.com/kuangye-team/ky-im/releases/latest/download/latest.json";

// The upstream is controlled only by server configuration, never request input.
pub fn source(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url)
}

pub fn allowed_redirect(upstream: &Url, target: &Url) -> bool {
    source(target.as_str()).is_some()
        && (upstream.scheme() != "https" || target.scheme() == "https")
}

pub fn valid_manifest(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_BYTES
        && serde_json::from_slice::<serde_json::Value>(bytes).is_ok_and(|value| {
            value
                .get("version")
                .is_some_and(serde_json::Value::is_string)
                && value
                    .get("platforms")
                    .is_some_and(serde_json::Value::is_object)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_configured_hosts_and_rejects_invalid_urls_or_https_downgrades() {
        assert!(source(DEFAULT_URL).is_some());
        assert!(source("https://cdn.example.com/app/latest.json?channel=stable").is_some());
        assert!(source("http://localhost:8081/latest.json").is_some());
        for url in [
            "file:///latest.json",
            "/latest.json",
            "not a URL",
            "https://user:pass@example.com/latest.json",
            "https://example.com/latest.json#fragment",
        ] {
            assert!(source(url).is_none(), "{url}");
        }
        let upstream = source(DEFAULT_URL).unwrap();
        assert!(allowed_redirect(
            &upstream,
            &Url::parse("https://cdn.example.com/latest.json").unwrap()
        ));
        assert!(!allowed_redirect(
            &upstream,
            &Url::parse("http://cdn.example.com/latest.json").unwrap()
        ));
        assert!(!valid_manifest(b"<html>Not found</html>"));
        assert!(valid_manifest(br#"{"version":"1.2.3","platforms":{}}"#));
    }
}
