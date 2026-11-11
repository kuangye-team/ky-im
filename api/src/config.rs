use std::{path::PathBuf, time::Duration};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub static_dir: PathBuf,
    pub latest_json_url: url::Url,
    pub cors_origins: Vec<String>,
    pub trust_proxy_headers: bool,
    pub relay_enabled: bool,
    pub authorization: String,
    pub max_connections: usize,
    pub max_rooms: usize,
    pub max_peers_per_room: usize,
    pub heartbeat_interval: Duration,
    pub idle_timeout: Duration,
    pub join_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind_addr: "0.0.0.0:8080".into(),
            static_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ssg/dist"),
            latest_json_url: url::Url::parse(crate::client_release::DEFAULT_URL)
                .expect("valid default release URL"),
            cors_origins: Vec::new(),
            trust_proxy_headers: true,
            relay_enabled: false,
            authorization: String::new(),
            max_connections: 256,
            max_rooms: 32,
            max_peers_per_room: 128,
            heartbeat_interval: Duration::from_secs(20),
            idle_timeout: Duration::from_secs(65),
            join_timeout: Duration::from_secs(10),
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_values(|name| std::env::var(name).ok())
    }

    pub(crate) fn from_values(value: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let defaults = Self::default();
        let integer = |name: &str, default: usize, min: usize, max: usize| {
            let n = value(name)
                .unwrap_or_else(|| default.to_string())
                .parse::<usize>()
                .map_err(|_| format!("{name} must be an integer"))?;
            if !(min..=max).contains(&n) {
                return Err(format!("{name} must be between {min} and {max}"));
            }
            Ok(n)
        };
        let boolean = |name: &str, default: bool| {
            let Some(value) = value(name) else {
                return Ok(default);
            };
            match value.trim().to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => Ok(true),
                "0" | "false" | "no" | "off" => Ok(false),
                _ => Err(format!("{name} must be a boolean")),
            }
        };
        let cors_origins = value("CORS_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        for origin in &cors_origins {
            if is_desktop_origin(origin) {
                continue;
            }
            let url = url::Url::parse(origin).map_err(|_| "Invalid CORS_ORIGINS entry")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.origin().ascii_serialization() != *origin
            {
                return Err(
                    "CORS_ORIGINS must contain exact HTTP(S) or Tauri origins, without paths"
                        .into(),
                );
            }
        }
        let authorization = value("API_AUTH").unwrap_or_default().trim().to_owned();
        if authorization.len() > 4096 || !authorization.bytes().all(|b| (32..=126).contains(&b)) {
            return Err("API_AUTH must contain at most 4096 printable ASCII characters".into());
        }
        let latest_json_url = value("LATEST_JSON_URL").unwrap_or_default();
        let latest_json_url = crate::client_release::source(if latest_json_url.trim().is_empty() {
            crate::client_release::DEFAULT_URL
        } else {
            latest_json_url.trim()
        })
        .ok_or("LATEST_JSON_URL must be an HTTP(S) URL without credentials or a fragment")?;
        Ok(Self {
            latest_json_url,
            authorization,
            bind_addr: value("BIND_ADDR").unwrap_or(defaults.bind_addr),
            static_dir: value("STATIC_DIR")
                .map(PathBuf::from)
                .unwrap_or(defaults.static_dir),
            cors_origins,
            trust_proxy_headers: boolean("TRUST_PROXY_HEADERS", defaults.trust_proxy_headers)?,
            relay_enabled: boolean("RELAY_ENABLED", defaults.relay_enabled)?,
            max_connections: integer("MAX_CONNECTIONS", defaults.max_connections, 2, 4096)?,
            max_rooms: integer("MAX_ROOMS", defaults.max_rooms, 1, 256)?,
            max_peers_per_room: integer("MAX_PEERS_PER_ROOM", defaults.max_peers_per_room, 2, 512)?,
            ..defaults
        })
    }
}

/// Packaged Tauri WebViews have these fixed origins. Other cross-origin sites still need explicit configuration.
pub fn is_desktop_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_json_url_defaults_and_accepts_an_operator_configured_upstream() {
        for value in [None, Some(""), Some(" ")] {
            let config = Config::from_values(|key| {
                (key == "LATEST_JSON_URL")
                    .then_some(value)
                    .flatten()
                    .map(str::to_owned)
            })
            .unwrap();
            assert_eq!(
                config.latest_json_url.as_str(),
                crate::client_release::DEFAULT_URL
            );
        }
        let config = Config::from_values(|key| {
            (key == "LATEST_JSON_URL").then(|| "http://localhost:8081/custom.json".into())
        })
        .unwrap();
        assert_eq!(
            config.latest_json_url.as_str(),
            "http://localhost:8081/custom.json"
        );
        assert!(
            Config::from_values(|key| {
                (key == "LATEST_JSON_URL").then(|| "file:///latest.json".into())
            })
            .is_err()
        );
    }

    #[test]
    fn authorization_is_optional_and_validates_header_values() {
        assert!(
            Config::from_values(|_| None)
                .unwrap()
                .authorization
                .is_empty()
        );
        let configured =
            Config::from_values(|key| (key == "API_AUTH").then(|| "Bearer secret".into())).unwrap();
        assert_eq!(configured.authorization, "Bearer secret");
        for invalid in [
            "bad\r\nheader".to_owned(),
            "密钥".to_owned(),
            "x".repeat(4097),
        ] {
            assert!(
                Config::from_values(|key| (key == "API_AUTH").then(|| invalid.clone())).is_err()
            );
        }
    }

    #[test]
    fn relay_is_opt_in_and_parses_environment_booleans() {
        assert!(!Config::from_values(|_| None).unwrap().relay_enabled);
        for flag in ["true", "1", "yes", "on"] {
            assert!(
                Config::from_values(|key| (key == "RELAY_ENABLED").then(|| flag.into()))
                    .unwrap()
                    .relay_enabled
            );
        }
        assert!(
            !Config::from_values(|key| (key == "RELAY_ENABLED").then(|| "false".into()))
                .unwrap()
                .relay_enabled
        );
        assert!(
            Config::from_values(|key| (key == "RELAY_ENABLED").then(|| "maybe".into())).is_err()
        );
    }

    #[test]
    fn validates_limits_and_origins() {
        assert!(Config::from_values(|_| None).is_ok());
        assert!(Config::from_values(|key| (key == "MAX_ROOMS").then(|| "1024".into())).is_err());
        assert!(
            Config::from_values(
                |key| (key == "CORS_ORIGINS").then(|| "https://example.com/path".into())
            )
            .is_err()
        );
        assert!(
            Config::from_values(|key| (key == "TRUST_PROXY_HEADERS").then(|| "maybe".into()))
                .is_err()
        );
        assert!(
            Config::from_values(|key| (key == "TRUST_PROXY_HEADERS").then(|| "true".into()))
                .unwrap()
                .trust_proxy_headers
        );
    }

    #[test]
    fn accepts_exact_tauri_origins_and_rejects_other_custom_origins() {
        assert!(Config::from_values(|key| (key == "CORS_ORIGINS").then(||
            "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420".into()
        )).is_ok());
        for origin in [
            "tauri://other",
            "tauri://localhost/",
            "tauri://localhost/path",
            "null",
            "*",
        ] {
            assert!(
                Config::from_values(|key| (key == "CORS_ORIGINS").then(|| origin.into())).is_err()
            );
        }
    }
}
