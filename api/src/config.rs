use std::{path::PathBuf, time::Duration};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub static_dir: PathBuf,
    pub cors_origins: Vec<String>,
    pub trust_proxy_headers: bool,
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
            cors_origins: Vec::new(),
            trust_proxy_headers: true,
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
            let url = url::Url::parse(origin).map_err(|_| "Invalid CORS_ORIGINS entry")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.origin().ascii_serialization() != *origin
            {
                return Err(
                    "CORS_ORIGINS must contain exact HTTP(S) origins, without paths".into(),
                );
            }
        }
        Ok(Self {
            bind_addr: value("BIND_ADDR").unwrap_or(defaults.bind_addr),
            static_dir: value("STATIC_DIR")
                .map(PathBuf::from)
                .unwrap_or(defaults.static_dir),
            cors_origins,
            trust_proxy_headers: boolean("TRUST_PROXY_HEADERS", defaults.trust_proxy_headers)?,
            max_connections: integer("MAX_CONNECTIONS", defaults.max_connections, 2, 4096)?,
            max_rooms: integer("MAX_ROOMS", defaults.max_rooms, 1, 256)?,
            max_peers_per_room: integer("MAX_PEERS_PER_ROOM", defaults.max_peers_per_room, 2, 512)?,
            ..defaults
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
