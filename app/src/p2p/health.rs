use super::{CHAT, Node, PeerHealth};
use futures::{
    AsyncReadExt, AsyncWriteExt, FutureExt, StreamExt,
    future::{BoxFuture, Shared},
    stream::FuturesUnordered,
};
use libp2p::swarm::ConnectionId;
use libp2p::{PeerId, StreamProtocol, swarm::Stream};
type IncomingStreams = futures::channel::mpsc::Receiver<(PeerId, ConnectionId, Stream)>;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(super) const PROTOCOL: StreamProtocol = StreamProtocol::new("/hummingbird/ping/2.0.0");
const PROFILE_FRAME_BYTES: usize = 32 * 1024;
const TIMEOUT: Duration = Duration::from_secs(8);
pub(super) type Probe = Shared<BoxFuture<'static, Result<PeerHealth, String>>>;

pub(super) async fn read(stream: &mut Stream, max: usize) -> io::Result<Value> {
    let mut header = [0; 5];
    stream.read_exact(&mut header).await?;
    let len = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
    if header[4] != 1 || len == 0 || len > max {
        return Err(io::Error::other("Invalid JSON frame"));
    }
    let mut data = vec![0; len];
    stream.read_exact(&mut data).await?;
    serde_json::from_slice(&data).map_err(io::Error::other)
}
pub(super) async fn write(stream: &mut Stream, value: &Value) -> io::Result<()> {
    let data = serde_json::to_vec(value)?;
    stream.write_all(&(data.len() as u32).to_be_bytes()).await?;
    stream.write_all(&[1]).await?;
    stream.write_all(&data).await?;
    stream.flush().await
}

pub(super) fn revision(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|r| (1..=9_007_199_254_740_991).contains(r))
}
fn valid_profile(value: &Value, peer: PeerId) -> bool {
    let runtime = &value["runtime"];
    let string = |field: &Value, max| {
        field
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= max)
    };
    value["id"].as_str() == Some(&peer.to_string())
        && revision(&value["revision"]).is_some()
        && value["numericId"].as_str().is_some_and(|s| {
            s.len() == 6 && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit())
        })
        && value["name"]
            .as_str()
            .is_some_and(|s| s.chars().count() <= 48)
        && value["name"].as_str().is_some_and(|s| !s.trim().is_empty())
        && string(&value["bio"], 160)
        && string(&value["avatar"], 16)
        && value["avatar"] != ""
        && value["color"].as_str().is_some_and(|c| {
            c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
        && runtime.get("device").is_none_or(|d| {
            matches!(
                d.as_str(),
                Some("Win" | "Mac" | "IOS" | "Android" | "Linux" | "Harmony")
            )
        })
        && serde_json::from_value::<crate::capabilities::ClientType>(runtime["clientType"].clone())
            .is_ok()
        && serde_json::from_value::<crate::capabilities::RuntimeInfo>(runtime.clone())
            .is_ok_and(|r| r.valid())
        && value.get("extend").is_none_or(Value::is_object)
}
impl Node {
    pub fn cache_profile(&self, peer: PeerId, value: Value) -> bool {
        if !valid_profile(&value, peer) {
            return false;
        }
        let mut profiles = self.network.profiles.lock().unwrap();
        if profiles.get(&peer).and_then(|v| revision(&v["revision"]))
            >= revision(&value["revision"])
        {
            return true;
        }
        profiles.insert(peer, value.clone());
        drop(profiles);
        (self.emit)(json!({"type":"profile","profile":value}));
        true
    }
    fn known_revision(&self, peer: PeerId) -> u64 {
        self.network
            .profiles
            .lock()
            .unwrap()
            .get(&peer)
            .and_then(|v| revision(&v["revision"]))
            .unwrap_or(0)
    }
}

async fn request(
    node: &Node,
    connection: ConnectionId,
    peer: PeerId,
    packet: Value,
) -> Result<Value, String> {
    let mut stream = node
        .open_stream(peer, connection, PROTOCOL)
        .await
        .map_err(|e| e.to_string())?;
    stream.ignore_for_keep_alive();
    write(&mut stream, &packet)
        .await
        .map_err(|e| e.to_string())?;
    let value = read(&mut stream, PROFILE_FRAME_BYTES)
        .await
        .map_err(|e| e.to_string())?;
    if value["requestId"] != packet["requestId"] {
        return Err("设备响应无效".into());
    }
    Ok(value)
}
fn fetch_profile(node: Node, connection: ConnectionId, peer: PeerId, minimum: u64) {
    tokio::spawn(async move {
        let packet = json!({"type":"profile_get","requestId":uuid::Uuid::new_v4().to_string(),"knownPeerRevision":node.known_revision(peer)});
        if let Ok(Ok(reply)) =
            tokio::time::timeout(TIMEOUT, request(&node, connection, peer, packet)).await
            && reply["type"] == "profile_result"
            && revision(&reply["profile"]["revision"]).is_some_and(|r| r >= minimum)
        {
            node.cache_profile(peer, reply["profile"].clone());
        }
    });
}
pub(super) fn probe(
    connection: ConnectionId,
    peer: PeerId,
    node: Node,
    request_id: String,
) -> Probe {
    async move {
        tokio::time::timeout(TIMEOUT, async {
            let local = node.local.lock().unwrap()["revision"].clone();
            let known = node.known_revision(peer);
            let packet = json!({"type":"ping","requestId":request_id,"selfRevision":local,"knownPeerRevision":known});
            let start = Instant::now();
            let reply = request(&node, connection, peer, packet).await?;
            let remote = revision(&reply["selfRevision"]).filter(|_| reply["type"]=="pong").ok_or("设备响应无效")?;
            if remote > known && !(reply["profile"]["revision"] == remote && node.cache_profile(peer, reply["profile"].clone())) {
                fetch_profile(node, connection, peer, remote);
            }
            Ok(PeerHealth { round_trip_ms: start.elapsed().as_secs_f64()*1000., age_ms: 0. })
        }).await.map_err(|e|e.to_string())?
    }.boxed().shared()
}

pub(super) async fn listen(mut incoming: IncomingStreams, node: Node) {
    let mut active = HashMap::<PeerId, usize>::new();
    let mut responders = FuturesUnordered::new();
    loop {
        tokio::select! {
            _ = node.cancel.cancelled() => break,
            item = incoming.next() => {
                let Some((peer, physical, stream)) = item else {break};
                let count = active.entry(peer).or_default();
                if *count < 4 {
                    *count += 1;
                    let node = node.clone();

                    responders.push(async move {
                        let _ = tokio::time::timeout(TIMEOUT, serve(node, physical, peer, stream)).await;
                        peer
                    });
                }
            }
            Some(peer) = responders.next(), if !responders.is_empty() => {
                let count = active.get_mut(&peer).unwrap();
                *count -= 1;
                if *count == 0 {active.remove(&peer);}
            }
        }
    }
}
async fn serve(
    node: Node,
    physical: ConnectionId,
    peer: PeerId,
    mut stream: Stream,
) -> io::Result<()> {
    let key = (peer.to_string(), CHAT.to_owned());
    let connection = node
        .writers
        .lock()
        .unwrap()
        .get(&key)
        .map(|(_, id)| id.clone());
    let packet = read(&mut stream, PROFILE_FRAME_BYTES).await?;
    let Some(id) = packet["requestId"].as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    }) else {
        return Ok(());
    };
    let Some(known) = packet["knownPeerRevision"]
        .as_u64()
        .filter(|r| *r <= 9_007_199_254_740_991)
    else {
        return Ok(());
    };
    let local = node.local.lock().unwrap().clone();
    if packet["type"] == "profile_get" {
        write(
            &mut stream,
            &json!({"type":"profile_result","requestId":id,"profile":local}),
        )
        .await?;
    } else if packet["type"] == "ping" {
        let Some(remote) = revision(&packet["selfRevision"]) else {
            return Ok(());
        };
        let mut reply = json!({"type":"pong","requestId":id,"selfRevision":local["revision"]});
        if known < revision(&local["revision"]).unwrap_or(0) {
            reply["profile"] = local;
        }
        write(&mut stream, &reply).await?;
        if let Some(channel_id) = connection.filter(|_| node.selected(peer) == Some(physical)) {
            let received = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            (node.emit)(
                json!({"type":"ping_answered","peerId":key.0,"connectionId":channel_id,"requestId":id,"receivedAt":received.as_millis() as u64}),
            );
        }
        if node.known_revision(peer) < remote {
            fetch_profile(node, physical, peer, remote);
        }
    }
    stream.close().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_client_and_device_in_peer_profiles() {
        let peer = libp2p::identity::Keypair::generate_ed25519()
            .public()
            .to_peer_id();
        let mut profile = json!({"id":peer.to_string(), "revision":1, "numericId":"123456",
            "name":"Test", "bio":"", "avatar":"A", "color":"#123456",
            "runtime":{"version":"1", "capabilities":[], "clientType":"web"}});
        assert!(valid_profile(&profile, peer));
        for (client, device) in [
            ("web", "IOS"),
            ("mobile", "Android"),
            ("mobile", "Harmony"),
            ("desktop", "Win"),
            ("desktop", "Mac"),
            ("desktop", "Linux"),
        ] {
            profile["runtime"]["clientType"] = json!(client);
            profile["runtime"]["device"] = json!(device);
            assert!(valid_profile(&profile, peer));
        }
        profile["runtime"]["device"] = json!("Windows");
        assert!(!valid_profile(&profile, peer));
        profile["runtime"]["device"] = json!("Win");
        profile["runtime"]["clientType"] = json!("app");
        assert!(!valid_profile(&profile, peer));
    }
}
