use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::LazyLock};
pub const RELEASE_VERSION: &str = env!("RELEASE_VERSION");
static CATALOG: LazyLock<serde_json::Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("capabilities.json")).unwrap());
pub fn capability(name: &str) -> &'static str {
    CATALOG[name].as_str().expect("known capability")
}
pub fn known_capabilities() -> impl Iterator<Item = &'static str> {
    CATALOG
        .as_object()
        .expect("capability catalog")
        .values()
        .map(|value| value.as_str().expect("capability identifier"))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientType {
    Web,
    Desktop,
    Mobile,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub version: String,
    pub capabilities: Vec<String>,
}
impl RuntimeInfo {
    pub fn supports(&self, name: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability(name))
    }
    pub fn valid(&self) -> bool {
        !self.version.is_empty()
            && self.version.len() <= 64
            && self.version.as_bytes()[0].is_ascii_alphanumeric()
            && self
                .version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
            && valid_capabilities(&self.capabilities)
    }
}
pub fn valid_capabilities(capabilities: &[String]) -> bool {
    capabilities.len() <= 64
        && capabilities.iter().collect::<HashSet<_>>().len() == capabilities.len()
        && capabilities.iter().all(|c| {
            let Some((name, version)) = c.rsplit_once(".v") else {
                return false;
            };
            c.len() <= 96
                && !name.is_empty()
                && name.len() <= 80
                && name.as_bytes()[0].is_ascii_lowercase()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
                && !version.is_empty()
                && !version.starts_with('0')
                && version.bytes().all(|b| b.is_ascii_digit())
        })
}
pub fn runtime(names: &[&str]) -> RuntimeInfo {
    RuntimeInfo {
        version: RELEASE_VERSION.into(),
        capabilities: names.iter().map(|name| capability(name).into()).collect(),
    }
}
pub fn server_runtime(relay: bool) -> RuntimeInfo {
    let mut info = runtime(&["server", "discovery", "signaling", "reverseDial", "query"]);
    if relay {
        info.capabilities.push(capability("relay").into());
    }
    info
}
pub fn app_runtime() -> RuntimeInfo {
    runtime(&[
        "app",
        "discovery",
        "signaling",
        "reverseDial",
        "query",
        "chat",
        "file",
        "resume",
        "folder",
        "folderResume",
        "receipts",
        "webrtc",
        "webtransport",
        "relay",
        "tcp",
    ])
}
