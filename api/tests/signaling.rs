use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use im_api::{AppState, Config, router};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{net::TcpStream, task::JoinHandle};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};

type RawSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
struct Socket {
    raw: RawSocket,
    handshake: Value,
}
impl std::ops::Deref for Socket {
    type Target = RawSocket;
    fn deref(&self) -> &RawSocket {
        &self.raw
    }
}
impl std::ops::DerefMut for Socket {
    fn deref_mut(&mut self) -> &mut RawSocket {
        &mut self.raw
    }
}
async fn authenticate(mut raw: RawSocket, authorization: Option<&str>) -> Socket {
    let mut auth = json!({"type":"auth"});
    if let Some(value) = authorization {
        auth["authorization"] = value.into();
    }
    raw.send(Message::Text(auth.to_string().into()))
        .await
        .unwrap();
    loop {
        match raw.next().await.unwrap().unwrap() {
            Message::Text(text) => {
                return Socket {
                    raw,
                    handshake: serde_json::from_str(&text).unwrap(),
                };
            }
            Message::Ping(p) => raw.send(Message::Pong(p)).await.unwrap(),
            other => panic!("{other:?}"),
        }
    }
}

struct Server {
    url: String,
    task: JoinHandle<()>,
}

impl Server {
    async fn start(config: Config) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/api/ws", listener.local_addr().unwrap());
        let app = router(AppState::new(config)).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self { url, task }
    }

    async fn connect(&self) -> Socket {
        self.connect_room("local").await
    }
    async fn connect_room(&self, room: &str) -> Socket {
        authenticate(
            connect_async(format!("{}?room={room}", self.url))
                .await
                .unwrap()
                .0,
            None,
        )
        .await
    }

    async fn join(&self, id: &str, room: &str) -> (Socket, Value) {
        let mut socket = self.connect_room(room).await;
        send(
            &mut socket,
            json!({"type":"join", "room":room, "profile":profile(id)}),
        )
        .await;
        let welcome = receive(&mut socket).await;
        (socket, welcome)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn profile(id: &str) -> Value {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(id.as_bytes());
    let number =
        (100_000 + u32::from_be_bytes(hash[..4].try_into().unwrap()) % 900_000).to_string();
    json!({"numericId":number, "id":id, "name":format!("User {id}"), "clientType":"web", "capabilities": ["capabilities.query.v1", "discovery.v1", "signaling.v1", "transfer.webrtc.v1", "transport.ws-relay.v1", "transfer.relay-split.v1", "chat.v1", "file.v1"]})
}

fn numbered_profile(id: &str, welcome: &Value) -> Value {
    let mut result = profile(id);
    result["numericId"] = welcome["numericId"].clone();
    assert!(im_api::protocol::valid_numeric_id(
        result["numericId"].as_str().unwrap()
    ));
    result
}

fn keys(label: &str) -> libp2p_identity::Keypair {
    use sha2::{Digest, Sha256};
    libp2p_identity::Keypair::ed25519_from_bytes(Sha256::digest(label.as_bytes())).unwrap()
}
fn aliases() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static ALIASES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, String>>,
    > = std::sync::OnceLock::new();
    ALIASES.get_or_init(Default::default)
}
fn peer(label: &str) -> String {
    let id = keys(label).public().to_peer_id().to_string();
    aliases().lock().unwrap().insert(id.clone(), label.into());
    id
}
fn wire(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if ["id", "to", "expectedPeerId"].contains(&key.as_str()) {
                    if let Some(label) = value.as_str() {
                        *value = json!(peer(label));
                    }
                } else {
                    wire(value);
                }
            }
        }
        Value::Array(array) => {
            for value in array {
                wire(value);
            }
        }
        _ => {}
    }
}
fn readable(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("challenge");
            for value in object.values_mut() {
                readable(value);
            }
        }
        Value::Array(array) => {
            for value in array.iter_mut() {
                readable(value);
            }
            if array.iter().all(|v| v.get("id").is_some()) {
                array.sort_by_key(|v| v["id"].as_str().unwrap_or_default().to_owned());
            }
        }
        Value::String(s) => {
            if let Some(label) = aliases().lock().unwrap().get(s).cloned() {
                *s = label;
            }
        }
        _ => {}
    }
}
async fn send(socket: &mut Socket, mut value: Value) {
    let label = value["profile"]["id"].as_str().map(str::to_owned);
    wire(&mut value);
    if value["type"] == "join" {
        let challenge = socket.handshake["challenge"].as_str().unwrap();
        let key = keys(label.as_deref().unwrap_or("invalid"));
        value["proof"] = json!({"publicKey":base64::engine::general_purpose::STANDARD.encode(key.public().encode_protobuf()),"signature":base64::engine::general_purpose::STANDARD.encode(key.sign(challenge.as_bytes()).unwrap())});
    }
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn receive(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => {
                    let mut value = serde_json::from_str(&text).unwrap();
                    readable(&mut value);
                    return value;
                }
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                other => panic!("Expected protocol JSON, received {other:?}"),
            }
        }
    })
    .await
    .expect("timed out waiting for protocol message")
}

#[tokio::test]
async fn discovery_preserves_only_explicit_extensions() {
    let server = Server::start(Config::default()).await;
    let (mut web, _) = server.join("web", "local").await;
    let mut app = server.connect().await;
    let mut summary = profile("app");
    summary["extend"] = json!({"nested":{"values":[1,true,null]}});
    send(&mut app, json!({"type":"join","profile":summary})).await;
    assert_eq!(receive(&mut app).await["type"], "welcome");
    let joined = receive(&mut web).await;
    assert_eq!(joined["peer"]["extend"], summary["extend"]);
    assert!(joined["peer"].get("runtime").is_none());
    let mut third = server.connect().await;
    summary["bio"] = "private".into();
    send(&mut third, json!({"type":"join","profile":summary})).await;
    assert_eq!(receive(&mut third).await["code"], "invalid_message");
}

#[tokio::test]
async fn presence_signal_profile_and_disconnect() {
    let server = Server::start(Config::default()).await;
    let (mut alice, welcome) = server.join("alice", "local").await;
    assert_eq!(welcome["type"], "welcome");
    assert_eq!(welcome["id"], "alice");
    assert_eq!(welcome["room"], "local@127.0.0.1");
    assert_eq!(welcome["peers"], json!([]));
    let alice_profile = numbered_profile("alice", &welcome);
    let (mut bob, welcome) = server.join("bob", "local").await;
    assert_eq!(welcome["peers"], json!([alice_profile.clone()]));
    let bob_profile = numbered_profile("bob", &welcome);
    assert_eq!(
        receive(&mut alice).await,
        json!({"type":"peer_joined", "peer":bob_profile})
    );

    let offer = offer();
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":offer}),
    )
    .await;
    assert_eq!(
        receive(&mut bob).await,
        json!({"type":"signal", "from":"alice", "data":offer})
    );
    let mut answer = offer;
    answer["description"]["type"] = json!("answer");
    send(
        &mut bob,
        json!({"type":"signal", "to":"alice", "data":answer}),
    )
    .await;
    assert_eq!(
        receive(&mut alice).await,
        json!({"type":"signal", "from":"bob", "data":answer})
    );
    send(&mut bob, json!({"type":"profile","profile":bob_profile})).await;
    assert_eq!(receive(&mut bob).await["code"], "invalid_message");
    let (mut carol, welcome) = server.join("carol", "local").await;
    assert_eq!(welcome["peers"], json!([alice_profile, bob_profile]));
    assert_eq!(receive(&mut alice).await["type"], "peer_joined");
    assert_eq!(receive(&mut bob).await["type"], "peer_joined");
    bob.close(None).await.unwrap();
    assert_eq!(
        receive(&mut alice).await,
        json!({"type":"peer_left", "id":"bob"})
    );
    assert_eq!(
        receive(&mut carol).await,
        json!({"type":"peer_left", "id":"bob"})
    );
    send(&mut alice, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut alice).await, json!({"type":"pong"}));
}

#[tokio::test]
async fn rooms_are_isolated_and_signal_sender_cannot_be_forged() {
    let server = Server::start(Config::default()).await;
    let (mut alice, _) = server.join("alice", "local").await;
    let (mut bob, welcome) = server.join("bob", "private").await;
    assert_eq!(welcome["room"], "private@127.0.0.1");
    assert_eq!(welcome["peers"], json!([]));
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":{"candidate":null}}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "peer_unavailable");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), bob.next())
            .await
            .is_err()
    );
    send(
        &mut alice,
        json!({"type":"signal", "from":"bob", "to":"bob", "data":{}}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "invalid_message");
    send(
        &mut alice,
        json!({"type":"signal", "to":"alice", "data":{}}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "invalid_target");
    bob.close(None).await.unwrap();
    send(&mut alice, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut alice).await["type"], "pong");
}

#[tokio::test]
async fn replacing_an_identity_cannot_remove_its_new_connection() {
    let server = Server::start(Config::default()).await;
    let (mut old_alice, alice_welcome) = server.join("alice", "local").await;
    let alice_profile = numbered_profile("alice", &alice_welcome);
    let (mut bob, bob_welcome) = server.join("bob", "local").await;
    let bob_profile = numbered_profile("bob", &bob_welcome);
    assert_eq!(receive(&mut old_alice).await["type"], "peer_joined");
    let (mut new_alice, welcome) = server.join("alice", "local").await;
    assert_eq!(welcome["peers"], json!([bob_profile.clone()]));
    assert_eq!(receive(&mut old_alice).await["code"], "session_replaced");
    assert!(matches!(
        old_alice.next().await.unwrap().unwrap(),
        Message::Close(_)
    ));
    assert_eq!(
        receive(&mut bob).await,
        json!({"type":"peer_left", "id":"alice"})
    );
    assert_eq!(
        receive(&mut bob).await,
        json!({"type":"peer_joined", "peer":alice_profile})
    );

    send(
        &mut bob,
        json!({"type":"signal", "to":"alice", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut new_alice).await["from"], "bob");
    send(
        &mut new_alice,
        json!({"type":"signal", "to":"bob", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut bob).await["from"], "alice");
    let (_carol, welcome) = server.join("carol", "local").await;
    assert_eq!(welcome["peers"], json!([alice_profile, bob_profile]));
}

#[tokio::test]
async fn validates_join_and_does_not_allow_rejoining() {
    let server = Server::start(Config::default()).await;
    let mut socket = server.connect().await;
    send(&mut socket, json!({"type":"signal", "to":"bob", "data":{}})).await;
    assert_eq!(receive(&mut socket).await["code"], "join_required");
    send(
        &mut socket,
        json!({"type":"join", "room":"invalid room", "profile":profile("alice")}),
    )
    .await;
    assert_eq!(receive(&mut socket).await["code"], "invalid_room");
    let mut invalid = profile("alice");
    invalid["name"] = " ".into();
    send(&mut socket, json!({"type":"join", "profile":invalid})).await;
    assert_eq!(receive(&mut socket).await["code"], "invalid_profile");
    send(
        &mut socket,
        json!({"type":"join", "profile":profile("alice")}),
    )
    .await;
    let welcome = receive(&mut socket).await;
    assert_eq!(welcome["type"], "welcome");
    assert_eq!(welcome["room"], "local@127.0.0.1");
    send(
        &mut socket,
        json!({"type":"join", "profile":profile("bob")}),
    )
    .await;
    assert_eq!(receive(&mut socket).await["code"], "already_joined");
    socket
        .send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    assert_eq!(receive(&mut socket).await["code"], "unsupported_message");
}

#[tokio::test]
async fn enforces_room_and_connection_capacity() {
    let server = Server::start(Config {
        max_connections: 4,
        max_rooms: 1,
        max_peers_per_room: 2,
        ..Config::default()
    })
    .await;
    let (_alice, _) = server.join("alice", "local").await;
    let (_bob, _) = server.join("bob", "local").await;
    let (mut carol, error) = server.join("carol", "local").await;
    assert_eq!(error["code"], "room_full");
    carol.close(None).await.unwrap();
    let (_other, rejected) = server.join("carol", "another").await;
    assert_eq!(rejected["code"], "room_limit");
    let _fourth = server.connect().await;
    let error = connect_async(&server.url).await.unwrap_err();
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => assert_eq!(response.status(), 503),
        other => panic!("Expected HTTP 503, got {other:?}"),
    }
}

#[tokio::test]
async fn rejects_foreign_browser_origins_but_allows_configured_origins() {
    let server = Server::start(Config {
        cors_origins: vec!["http://localhost:5173".into()],
        ..Config::default()
    })
    .await;
    let mut foreign = server.url.clone().into_client_request().unwrap();
    foreign.headers_mut().insert(
        "Origin",
        HeaderValue::from_static("https://untrusted.example"),
    );
    match connect_async(foreign).await.unwrap_err() {
        tokio_tungstenite::tungstenite::Error::Http(response) => assert_eq!(response.status(), 403),
        other => panic!("Expected HTTP 403, got {other:?}"),
    }
    let mut allowed = server.url.clone().into_client_request().unwrap();
    allowed
        .headers_mut()
        .insert("Origin", HeaderValue::from_static("http://localhost:5173"));
    let mut socket = authenticate(connect_async(allowed).await.unwrap().0, None).await;
    send(&mut socket, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut socket).await["code"], "join_required");
}

#[tokio::test]
async fn expires_connections_that_never_join() {
    let server = Server::start(Config {
        join_timeout: Duration::from_millis(40),
        ..Config::default()
    })
    .await;
    let mut socket = server.connect().await;
    assert_eq!(receive(&mut socket).await["code"], "join_timeout");
    assert!(matches!(
        socket.next().await.unwrap().unwrap(),
        Message::Close(_)
    ));
}

#[tokio::test]
async fn recent_valid_messages_defer_websocket_ping_until_the_connection_is_idle() {
    let server = Server::start(Config {
        heartbeat_interval: Duration::from_millis(150),
        ..Config::default()
    })
    .await;
    let (mut socket, _) = server.join("active", "local").await;
    for _ in 0..12 {
        send(
            &mut socket,
            json!({"type":"discover","recentNumericIds":[]}),
        )
        .await;
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("unexpected heartbeat on active connection");
        };
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()["type"],
            "discovery_updated"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let idle = tokio::time::timeout(Duration::from_secs(1), socket.next())
        .await
        .unwrap();
    assert!(matches!(idle.unwrap().unwrap(), Message::Ping(_)));
}

#[tokio::test]
async fn heartbeat_removes_unresponsive_peers_and_keeps_responsive_peers() {
    let server = Server::start(Config {
        heartbeat_interval: Duration::from_millis(20),
        idle_timeout: Duration::from_millis(100),
        ..Config::default()
    })
    .await;
    let (mut alice, _) = server.join("alice", "local").await;
    let (mut bob, _) = server.join("bob", "local").await;
    assert_eq!(receive(&mut alice).await["type"], "peer_joined");
    // Stop polling Alice, so its native socket cannot process Ping and reply Pong.
    // Bob continues processing control frames in receive().
    assert_eq!(
        receive(&mut bob).await,
        json!({"type":"peer_left", "id":"alice"})
    );
    send(&mut bob, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut bob).await["type"], "pong");
}

#[tokio::test]
async fn closes_oversized_signaling_messages() {
    let server = Server::start(Config::default()).await;
    let (mut socket, _) = server.join("alice", "local").await;
    send(&mut socket, json!({"type":"signal", "to":"bob", "data":"x".repeat(im_api::protocol::MAX_MESSAGE_BYTES)})).await;
    let result = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap();
    assert!(matches!(
        result,
        Some(Ok(Message::Close(_))) | Some(Err(_)) | None
    ));
}

async fn join_with_number(server: &Server, id: &str, room: &str, number: &str) -> (Socket, Value) {
    let mut socket = server.connect_room(room).await;
    let mut p = profile(id);
    p["numericId"] = number.into();
    send(
        &mut socket,
        json!({"type":"join", "room":room, "profile":p}),
    )
    .await;
    let response = receive(&mut socket).await;
    (socket, response)
}

fn offer() -> Value {
    json!({
        "session": "10000000-0000-4000-8000-000000000000",
        "description": {"type": "offer", "sdp": "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"}
    })
}

async fn connect_number(
    socket: &mut Socket,
    number: &Value,
    request: &str,
    expected: &str,
) -> Value {
    send(
        socket,
        json!({"type":"connect", "requestId":request, "numericId":number, "expectedPeerId":expected}),
    )
    .await;
    receive(socket).await
}

#[tokio::test]
async fn device_numbers_form_groups_across_networks_and_survive_replacement() {
    let server = Server::start(Config::default()).await;
    let (mut alice, first) = join_with_number(&server, "alice", "one", "123456").await;
    let (mut bob, second) = join_with_number(&server, "bob", "two", "123456").await;
    assert_eq!(first["numericId"], second["numericId"]);
    assert_eq!(second["peers"][0]["id"], "alice");
    assert_eq!(receive(&mut alice).await["peer"]["id"], "bob");
    let (mut new_alice, third) = join_with_number(&server, "alice", "one", "654321").await;
    assert_eq!(third["numericId"], "654321");
    assert_eq!(receive(&mut alice).await["code"], "session_replaced");
    assert_eq!(receive(&mut bob).await["type"], "peer_left");
    let mut edited = profile("impostor");
    edited["numericId"] = "123456".into();
    send(
        &mut new_alice,
        json!({"type":"change_numeric_id","numericId":edited["numericId"],"revision":2}),
    )
    .await;
    let updated = receive(&mut bob).await;
    assert_eq!(updated["peer"]["id"], "alice");
    assert_eq!(updated["peer"]["numericId"], "123456");
    assert_eq!(receive(&mut new_alice).await["peer"]["id"], "bob");
    let (_, welcome) = server.join("carol", "one").await;
    assert_ne!(welcome["numericId"], "123456");
    assert_eq!(welcome["peers"][0]["numericId"], "123456");
}

#[tokio::test]
async fn explicit_numeric_connect_crosses_rooms_and_forwards_presence_only_to_pair() {
    let server = Server::start(Config::default()).await;
    let (mut alice, alice_welcome) = server.join("alice", "one").await;
    let (mut bob, bob_welcome) = server.join("bob", "two").await;
    let (mut carol, _) = server.join("carol", "three").await;
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "peer_unavailable");
    let response = connect_number(&mut alice, &bob_welcome["numericId"], "lookup-1", "bob").await;
    assert_eq!(response["type"], "peer_resolved");
    assert_eq!(response["requestId"], "lookup-1");
    assert_eq!(response["peer"], numbered_profile("bob", &bob_welcome));
    assert_eq!(
        receive(&mut bob).await,
        json!({"type":"peer_joined", "peer":numbered_profile("alice", &alice_welcome)})
    );
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut bob).await["from"], "alice");
    send(
        &mut bob,
        json!({"type":"signal", "to":"alice", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["from"], "bob");
    // Repeated lookup must not duplicate peer_joined or interrupt an established RTC link.
    assert_eq!(
        connect_number(&mut alice, &bob_welcome["numericId"], "lookup-2", "bob").await["type"],
        "peer_resolved"
    );
    send(&mut bob, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut bob).await["type"], "pong");
    bob.close(None).await.unwrap();
    assert_eq!(
        receive(&mut alice).await,
        json!({"type":"peer_left", "id":"bob"})
    );
    send(&mut carol, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut carol).await["type"], "pong");
    let (mut replacement, _) = join_with_number(
        &server,
        "new-owner",
        "four",
        bob_welcome["numericId"].as_str().unwrap(),
    )
    .await;
    // Old pair permission is not transferred to whoever receives the released number.
    send(
        &mut alice,
        json!({"type":"signal", "to":"new-owner", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "peer_unavailable");
    send(&mut alice, json!({"type":"connect", "requestId":"restore", "numericId":bob_welcome["numericId"], "expectedPeerId":"bob"})).await;
    assert_eq!(receive(&mut alice).await["code"], "peer_unavailable");
    send(&mut replacement, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut replacement).await["type"], "pong");
}

#[tokio::test]
async fn replacing_cross_room_peer_cleans_permissions_and_preserves_new_session() {
    let server = Server::start(Config::default()).await;
    let (mut alice, _) = server.join("alice", "one").await;
    let (mut old_bob, bob_welcome) = server.join("bob", "two").await;
    connect_number(&mut alice, &bob_welcome["numericId"], "connect", "bob").await;
    assert_eq!(receive(&mut old_bob).await["type"], "peer_joined");
    let (mut new_bob, welcome) = join_with_number(
        &server,
        "bob",
        "three",
        bob_welcome["numericId"].as_str().unwrap(),
    )
    .await;
    assert_eq!(welcome["numericId"], bob_welcome["numericId"]);
    assert_eq!(receive(&mut old_bob).await["code"], "session_replaced");
    assert_eq!(receive(&mut alice).await["type"], "peer_left");
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "peer_unavailable");
    send(&mut alice, json!({"type":"connect", "requestId":"restore", "numericId":welcome["numericId"], "expectedPeerId":"bob"})).await;
    assert_eq!(receive(&mut alice).await["type"], "peer_resolved");
    assert_eq!(receive(&mut new_bob).await["type"], "peer_joined");
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut new_bob).await["from"], "alice");
}

#[tokio::test]
async fn connect_reports_correlated_errors_and_limits_lookup_rate() {
    let server = Server::start(Config::default()).await;
    let mut socket = server.connect().await;
    let error = connect_number(&mut socket, &json!("123456"), "unjoined", "bob").await;
    assert_eq!(error["type"], "connect_error");
    assert_eq!(error["code"], "join_required");
    assert_eq!(error["requestId"], "unjoined");
    send(
        &mut socket,
        json!({"type":"join", "profile":profile("alice")}),
    )
    .await;
    let welcome = receive(&mut socket).await;
    let error = connect_number(&mut socket, &welcome["numericId"], "self", "alice").await;
    assert_eq!(error["code"], "invalid_target");
    for (i, number) in ["12345", "012345", "1234567", "abcdef"].iter().enumerate() {
        let request = format!("invalid-{i}");
        let error = connect_number(&mut socket, &json!(number), &request, "bob").await;
        assert_eq!(error["type"], "connect_error");
        assert_eq!(error["requestId"], request);
        assert_eq!(error["code"], "invalid_numeric_id");
    }
    for i in 0..5 {
        let error = connect_number(
            &mut socket,
            &json!("999999"),
            &format!("missing-{i}"),
            "bob",
        )
        .await;
        assert_eq!(error["code"], "peer_unavailable");
    }
    let error = connect_number(&mut socket, &json!("999999"), "limited", "bob").await;
    assert_eq!(error["code"], "connect_rate_limited");
    assert_eq!(error["requestId"], "limited");
}

#[tokio::test]
async fn rejects_chat_payloads_disguised_as_signals() {
    let server = Server::start(Config::default()).await;
    let (mut alice, _) = server.join("alice", "one").await;
    let (mut bob, _) = server.join("bob", "one").await;
    receive(&mut alice).await;
    for data in [
        json!({"type":"text", "text":"chat message"}),
        json!({"file":"base64-file"}),
        json!({"v2":offer()}),
        json!({"description":{"type":"offer", "sdp":"chat message"}}),
        json!({"description":{"type":"offer", "sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n", "text":"secret"}}),
        json!({"candidate":{"candidate":"chat message"}}),
        json!({"candidate":{"candidate":"candidate:1", "file":"file content"}}),
        json!({"candidate":{"candidate":"candidate:1"}, "text":"chat"}),
        json!({"candidate":null}),
        json!({"session":"10000000-0000-4000-8000-000000000001","candidates":["candidate:1 1 udp 123 127.0.0.1 1234 typ host"]}),
        json!({"session":"10000000-0000-4000-8000-000000000001","candidates":[""]}),
    ] {
        send(
            &mut alice,
            json!({"type":"signal", "to":"bob", "data":data}),
        )
        .await;
        assert_eq!(receive(&mut alice).await["code"], "invalid_signal");
    }
    send(&mut bob, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut bob).await["type"], "pong");
    let candidate = offer();
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":candidate}),
    )
    .await;
    assert_eq!(receive(&mut bob).await["data"], candidate);
}

#[tokio::test]
async fn failed_cross_room_replacement_keeps_previous_session_and_number() {
    let server = Server::start(Config {
        max_peers_per_room: 1,
        ..Config::default()
    })
    .await;
    let (mut alice, first) = server.join("alice", "one").await;
    let (mut bob, _) = server.join("bob", "two").await;
    let (_replacement, error) = server.join("alice", "two").await;
    assert_eq!(error["code"], "room_full");
    let resolved = connect_number(&mut bob, &first["numericId"], "still-online", "alice").await;
    assert_eq!(resolved["peer"]["id"], "alice");
    assert_eq!(receive(&mut alice).await["type"], "peer_joined");
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut bob).await["from"], "alice");
}

async fn connect_group(socket: &mut Socket, number: &Value, request: &str) -> Value {
    send(
        socket,
        json!({"type":"connect_group", "requestId":request, "numericId":number}),
    )
    .await;
    receive(socket).await
}

async fn join_recent(
    server: &Server,
    id: &str,
    room: &str,
    number: &str,
    recent: Value,
) -> (Socket, Value) {
    let mut socket = server.connect_room(room).await;
    let mut p = profile(id);
    p["numericId"] = number.into();
    send(
        &mut socket,
        json!({"type":"join", "room":room, "profile":p, "recentNumericIds":recent}),
    )
    .await;
    let welcome = receive(&mut socket).await;
    (socket, welcome)
}

#[tokio::test]
async fn recent_numbers_merge_with_network_and_own_group_without_exposing_subscribers() {
    let server = Server::start(Config::default()).await;
    let (mut own, _) = join_with_number(&server, "own", "other", "111111").await;
    let (mut local, _) = join_with_number(&server, "local", "home", "222222").await;
    let (mut remote, _) = join_with_number(&server, "remote", "remote", "333333").await;
    let (mut alice, welcome) = join_recent(
        &server,
        "alice",
        "home",
        "111111",
        json!(["333333", "333333", "111111", "999999"]),
    )
    .await;
    assert_eq!(welcome["numericId"], "111111");
    assert_eq!(
        welcome["peers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["local", "own", "remote"]
    );
    for socket in [&mut own, &mut local, &mut remote] {
        let joined = receive(socket).await;
        assert_eq!(joined["peer"]["id"], "alice");
        assert!(joined["peer"].get("recentNumericIds").is_none());
    }
    let (mut observer, found) =
        join_recent(&server, "observer", "isolated", "444444", json!(["333333"])).await;
    assert_eq!(found["peers"].as_array().unwrap().len(), 1);
    assert_eq!(found["peers"][0]["id"], "remote");
    assert_eq!(receive(&mut remote).await["peer"]["id"], "observer");
    send(&mut alice, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut alice).await["type"], "pong");
    let (_, later) = join_with_number(&server, "later", "elsewhere", "333333").await;
    assert_eq!(later["peers"].as_array().unwrap().len(), 3);
    assert_eq!(receive(&mut alice).await["peer"]["id"], "later");
    assert_eq!(receive(&mut observer).await["peer"]["id"], "later");
}

#[tokio::test]
async fn recent_numbers_follow_empty_groups_and_stop_after_explicit_unsubscribe() {
    let server = Server::start(Config::default()).await;
    let (mut alice, welcome) =
        join_recent(&server, "alice", "home", "111111", json!(["222222"])).await;
    assert_eq!(welcome["peers"], json!([]));
    let (mut bob, welcome) = join_with_number(&server, "bob", "remote", "222222").await;
    assert_eq!(welcome["peers"][0]["id"], "alice");
    assert_eq!(receive(&mut alice).await["peer"]["id"], "bob");
    bob.close(None).await.unwrap();
    assert_eq!(receive(&mut alice).await["type"], "peer_left");
    let (mut replacement, welcome) =
        join_with_number(&server, "replacement", "new-network", "222222").await;
    assert_eq!(welcome["peers"][0]["id"], "alice");
    assert_eq!(receive(&mut alice).await["peer"]["id"], "replacement");
    send(&mut alice, json!({"type":"discover","recentNumericIds":[]})).await;
    assert_eq!(
        receive(&mut alice).await["removedPeerIds"],
        json!(["replacement"])
    );
    assert_eq!(receive(&mut replacement).await["type"], "peer_left");
    replacement.close(None).await.unwrap();
    let (_, welcome) = join_with_number(&server, "later", "remote", "222222").await;
    assert_eq!(welcome["peers"], json!([]));
    send(&mut alice, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut alice).await["type"], "pong");
}

#[tokio::test]
async fn replacing_recent_numbers_preserves_explicit_lookups_and_other_discovery_sources() {
    let server = Server::start(Config::default()).await;
    let (mut bob, _) = join_with_number(&server, "bob", "remote", "222222").await;
    let (mut carol, _) = join_with_number(&server, "carol", "another", "333333").await;
    let (mut alice, _) = join_recent(&server, "alice", "home", "111111", json!(["222222"])).await;
    receive(&mut bob).await;
    connect_group(&mut alice, &json!("333333"), "manual").await;
    receive(&mut carol).await;
    send(
        &mut alice,
        json!({"type":"discover", "recentNumericIds":["333333"]}),
    )
    .await;
    assert_eq!(
        receive(&mut alice).await,
        json!({"type":"discovery_updated", "peers":[], "removedPeerIds":["bob"]})
    );
    assert_eq!(receive(&mut bob).await["id"], "alice");
    send(
        &mut alice,
        json!({"type":"discover", "recentNumericIds":[]}),
    )
    .await;
    assert_eq!(
        receive(&mut alice).await,
        json!({"type":"discovery_updated", "peers":[], "removedPeerIds":[]})
    );
    send(&mut carol, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut carol).await["type"], "pong");
    send(
        &mut alice,
        json!({"type":"signal", "to":"carol", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut carol).await["from"], "alice");
}

#[tokio::test]
async fn invalid_recent_numbers_do_not_join_or_replace_existing_subscriptions() {
    let server = Server::start(Config::default()).await;
    let (mut bob, _) = join_with_number(&server, "bob", "remote", "222222").await;
    let (mut alice, rejected) =
        join_recent(&server, "alice", "home", "111111", json!(["012345"])).await;
    assert_eq!(rejected["code"], "invalid_discovery");
    send(&mut alice, json!({"type":"join", "room":"home", "profile":profile("alice"), "recentNumericIds":["222222"]})).await;
    assert_eq!(receive(&mut alice).await["peers"][0]["id"], "bob");
    receive(&mut bob).await;
    for invalid in [json!(["invalid"]), json!(vec!["222222"; 11])] {
        send(
            &mut alice,
            json!({"type":"discover", "recentNumericIds":invalid}),
        )
        .await;
        assert_eq!(receive(&mut alice).await["code"], "invalid_discovery");
    }
    send(
        &mut bob,
        json!({"type":"signal","to":"alice","data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["from"], "bob");
    let mut unjoined = server.connect().await;
    send(
        &mut unjoined,
        json!({"type":"discover", "recentNumericIds":[]}),
    )
    .await;
    assert_eq!(receive(&mut unjoined).await["code"], "join_required");
}

#[tokio::test]
async fn recent_discovery_batches_large_groups_instead_of_overflowing_the_signal_queue() {
    let server = Server::start(Config::default()).await;
    let mut members = Vec::new();
    for index in 0..40 {
        let (socket, _) =
            join_with_number(&server, &format!("member-{index}"), "remote", "222222").await;
        for peer in &mut members {
            receive(peer).await;
        }
        members.push(socket);
    }
    let (mut alice, _) = server.join("alice", "home").await;
    send(
        &mut alice,
        json!({"type":"discover", "recentNumericIds":["222222"]}),
    )
    .await;
    let response = receive(&mut alice).await;
    assert_eq!(response["type"], "discovery_updated");
    assert_eq!(response["peers"].as_array().unwrap().len(), 40);
    send(&mut alice, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut alice).await["type"], "pong");
}

#[tokio::test]
async fn group_discovery_connects_all_members_without_changing_own_group() {
    let server = Server::start(Config::default()).await;
    let (mut alice, alice_welcome) = server.join("alice", "home").await;
    let (mut bob, bob_welcome) = join_with_number(&server, "bob", "target", "234567").await;
    let (mut carol, carol_welcome) =
        join_with_number(&server, "carol", "other-network", "234567").await;
    assert_eq!(bob_welcome["numericId"], carol_welcome["numericId"]);
    assert_eq!(receive(&mut bob).await["peer"]["id"], "carol");
    let resolved = connect_group(&mut alice, &bob_welcome["numericId"], "group-1").await;
    assert_eq!(resolved["type"], "group_resolved");
    assert_eq!(resolved["requestId"], "group-1");
    assert_eq!(resolved["numericId"], bob_welcome["numericId"]);
    assert_eq!(
        resolved["peers"],
        json!([
            numbered_profile("bob", &bob_welcome),
            numbered_profile("carol", &carol_welcome)
        ])
    );
    for member in [&mut bob, &mut carol] {
        assert_eq!(
            receive(member).await["peer"],
            numbered_profile("alice", &alice_welcome)
        );
    }
    // A third member joining later is included by the live group subscription.
    let (mut dan, dan_welcome) = join_with_number(&server, "dan", "third-network", "234567").await;
    assert_eq!(dan_welcome["numericId"], bob_welcome["numericId"]);
    assert_eq!(dan_welcome["peers"].as_array().unwrap().len(), 3);
    for peer in [&mut alice, &mut bob, &mut carol] {
        assert_eq!(receive(peer).await["peer"]["id"], "dan");
    }
    for (id, member) in [("bob", &mut bob), ("carol", &mut carol), ("dan", &mut dan)] {
        send(
            &mut alice,
            json!({"type":"signal", "to":id, "data":offer()}),
        )
        .await;
        assert_eq!(receive(member).await["from"], "alice");
        send(
            member,
            json!({"type":"signal", "to":"alice", "data":offer()}),
        )
        .await;
        assert_eq!(receive(&mut alice).await["from"], id);
    }
    // Discovering another group never moves Alice into it or changes her number.
    let (mut home_peer, home_welcome) = server.join("home-peer", "home").await;
    assert_ne!(home_welcome["numericId"], alice_welcome["numericId"]);
    assert_eq!(
        home_welcome["peers"],
        json!([numbered_profile("alice", &alice_welcome)])
    );
    assert_eq!(receive(&mut alice).await["peer"]["id"], "home-peer");
    send(
        &mut home_peer,
        json!({"type":"signal", "to":"bob", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut home_peer).await["code"], "peer_unavailable");
    // Independent subscribers see members, never one another.
    let (mut eve, _) = server.join("eve", "elsewhere").await;
    let resolved = connect_group(&mut eve, &bob_welcome["numericId"], "group-eve").await;
    assert_eq!(resolved["peers"].as_array().unwrap().len(), 3);
    for member in [&mut bob, &mut carol, &mut dan] {
        assert_eq!(receive(member).await["peer"]["id"], "eve");
    }
    send(&mut alice, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut alice).await["type"], "pong");
    send(
        &mut eve,
        json!({"type":"signal", "to":"alice", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut eve).await["code"], "peer_unavailable");
    assert_eq!(
        connect_group(&mut alice, &bob_welcome["numericId"], "repeat").await["peers"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    for member in [&mut bob, &mut carol, &mut dan] {
        send(member, json!({"type":"ping"})).await;
        assert_eq!(receive(member).await["type"], "pong");
    }
    // A lookup of one's own group is an idempotent refresh, excluding self.
    let own = connect_group(&mut alice, &alice_welcome["numericId"], "own").await;
    assert_eq!(own["peers"], json!([]));
    carol.close(None).await.unwrap();
    for peer in [&mut alice, &mut bob, &mut dan, &mut eve] {
        assert_eq!(
            receive(peer).await,
            json!({"type":"peer_left", "id":"carol"})
        );
    }
}

#[tokio::test]
async fn local_number_refresh_moves_only_one_member_and_keeps_group_subscriptions() {
    let server = Server::start(Config::default()).await;
    let (mut bob, _) = join_with_number(&server, "bob", "one", "222222").await;
    let (mut carol, _) = join_with_number(&server, "carol", "two", "222222").await;
    receive(&mut bob).await;
    let (mut observer, _) = join_with_number(&server, "observer", "home", "333333").await;
    let found = connect_group(&mut observer, &json!("222222"), "find").await;
    assert_eq!(found["peers"].as_array().unwrap().len(), 2);
    receive(&mut bob).await;
    receive(&mut carol).await;
    let mut changed = profile("bob");
    changed["numericId"] = "444444".into();
    send(
        &mut bob,
        json!({"type":"change_numeric_id","numericId":changed["numericId"],"revision":2}),
    )
    .await;
    for socket in [&mut carol, &mut observer] {
        let update = receive(socket).await;
        assert_eq!(
            update,
            json!({"type":"numeric_id_changed","id":"bob","previousNumericId":"222222","numericId":"444444","revision":2})
        );
    }
    let old_group = connect_group(&mut observer, &json!("222222"), "old").await;
    assert_eq!(old_group["peers"].as_array().unwrap().len(), 1);
    assert_eq!(old_group["peers"][0]["id"], "carol");
    let new_group = connect_group(&mut observer, &json!("444444"), "new").await;
    assert_eq!(new_group["peers"][0]["id"], "bob");
    send(
        &mut observer,
        json!({"type":"signal", "to":"bob", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut bob).await["from"], "observer");
    let (_, joined) = join_with_number(&server, "dan", "three", "222222").await;
    assert_eq!(joined["peers"].as_array().unwrap().len(), 2);
    assert_eq!(receive(&mut carol).await["peer"]["id"], "dan");
    assert_eq!(receive(&mut observer).await["peer"]["id"], "dan");
    send(&mut bob, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut bob).await["type"], "pong");
    let (_, home) = server.join("home-peer", "home").await;
    assert_eq!(home["peers"][0]["numericId"], "333333");
}

#[tokio::test]
async fn group_subscription_survives_member_replacement_but_not_empty_group_or_subscriber_logout() {
    let server = Server::start(Config::default()).await;
    let (mut alice, _) = server.join("alice", "home").await;
    let (mut bob, first) = server.join("bob", "target").await;
    connect_group(&mut alice, &first["numericId"], "lookup").await;
    assert_eq!(receive(&mut bob).await["peer"]["id"], "alice");
    let (mut new_bob, second) = server.join("bob", "target").await;
    assert_eq!(first["numericId"], second["numericId"]);
    assert_eq!(receive(&mut bob).await["code"], "session_replaced");
    assert_eq!(receive(&mut alice).await["type"], "peer_left");
    assert_eq!(receive(&mut alice).await["type"], "peer_joined");
    assert_eq!(second["peers"][0]["id"], "alice");
    new_bob.close(None).await.unwrap();
    assert_eq!(receive(&mut alice).await["type"], "peer_left");
    let (mut replacement, reused) = join_with_number(
        &server,
        "stranger",
        "different",
        first["numericId"].as_str().unwrap(),
    )
    .await;
    assert_eq!(reused["numericId"], first["numericId"]);
    assert_eq!(reused["peers"], json!([]));
    send(
        &mut alice,
        json!({"type":"signal", "to":"stranger", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "peer_unavailable");
    connect_group(&mut alice, &reused["numericId"], "explicit-again").await;
    assert_eq!(receive(&mut replacement).await["type"], "peer_joined");
    alice.close(None).await.unwrap();
    assert_eq!(receive(&mut replacement).await["id"], "alice");
    let (mut new_alice, welcome) = server.join("alice", "home").await;
    assert_eq!(welcome["peers"], json!([]));
    send(
        &mut new_alice,
        json!({"type":"signal", "to":"stranger", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut new_alice).await["code"], "peer_unavailable");
    send(&mut replacement, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut replacement).await["type"], "pong");
}

#[tokio::test]
async fn group_lookup_requires_online_group_and_respects_limits() {
    let server = Server::start(Config::default()).await;
    let mut socket = server.connect().await;
    assert_eq!(
        connect_group(&mut socket, &json!("123456"), "unjoined").await["code"],
        "join_required"
    );
    send(
        &mut socket,
        json!({"type":"join", "profile":profile("alice")}),
    )
    .await;
    let welcome = receive(&mut socket).await;
    let missing = if welcome["numericId"] == "999999" {
        "999998"
    } else {
        "999999"
    };
    assert_eq!(
        connect_group(&mut socket, &json!(missing), "missing").await["code"],
        "peer_unavailable"
    );
    for (index, invalid) in ["012345", "12345", "1234567", "abcdef"].iter().enumerate() {
        assert_eq!(
            connect_group(&mut socket, &json!(invalid), &format!("invalid-{index}")).await["code"],
            "invalid_numeric_id"
        );
    }
    for index in 0..5 {
        assert_eq!(
            connect_group(&mut socket, &welcome["numericId"], &format!("own-{index}")).await["type"],
            "group_resolved"
        );
    }
    assert_eq!(
        connect_group(&mut socket, &welcome["numericId"], "limited").await["code"],
        "connect_rate_limited"
    );
}

#[tokio::test]
async fn exact_contact_restore_requires_identity_and_matching_group() {
    let server = Server::start(Config::default()).await;
    let (mut alice, alice_welcome) = server.join("alice", "home").await;
    let (mut bob, bob_welcome) = server.join("bob", "target").await;
    let (mut carol, _) = server.join("carol", "target").await;
    receive(&mut bob).await;
    send(
        &mut alice,
        json!({"type":"connect", "requestId":"no-identity", "numericId":bob_welcome["numericId"]}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "identity_required");
    assert_eq!(
        connect_number(
            &mut alice,
            &alice_welcome["numericId"],
            "wrong-group",
            "bob"
        )
        .await["code"],
        "identity_changed"
    );
    assert_eq!(
        connect_number(&mut alice, &bob_welcome["numericId"], "restore", "bob").await["peer"]["id"],
        "bob"
    );
    assert_eq!(receive(&mut bob).await["peer"]["id"], "alice");
    send(&mut carol, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut carol).await["type"], "pong");
    send(
        &mut alice,
        json!({"type":"signal", "to":"carol", "data":offer()}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "peer_unavailable");
}

#[tokio::test]
async fn forwarded_ip_headers_cannot_change_automatic_discovery_group() {
    let server = Server::start(Config {
        trust_proxy_headers: false,
        ..Config::default()
    })
    .await;
    let (mut alice, welcome) = server.join("alice", "local").await;
    let mut request = server.url.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("X-Forwarded-For", HeaderValue::from_static("203.0.113.9"));
    let mut bob = authenticate(connect_async(request).await.unwrap().0, None).await;
    send(&mut bob, json!({"type":"join", "profile":profile("bob")})).await;
    let bob_welcome = receive(&mut bob).await;
    assert_ne!(bob_welcome["numericId"], welcome["numericId"]);
    assert_eq!(bob_welcome["peers"][0]["id"], "alice");
    assert_eq!(receive(&mut alice).await["peer"]["id"], "bob");
}

#[tokio::test]
async fn trusted_proxy_headers_define_automatic_discovery_group() {
    let server = Server::start(Config {
        trust_proxy_headers: true,
        ..Config::default()
    })
    .await;
    let mut alice_request = server.url.clone().into_client_request().unwrap();
    alice_request.headers_mut().insert(
        "X-Forwarded-For",
        HeaderValue::from_static("198.51.100.24, 10.0.0.2"),
    );
    let mut alice = authenticate(connect_async(alice_request).await.unwrap().0, None).await;
    send(
        &mut alice,
        json!({"type":"join", "room":"local", "profile":profile("alice")}),
    )
    .await;
    let alice_welcome = receive(&mut alice).await;
    assert_eq!(alice_welcome["room"], "local@198.51.100.24");

    let mut bob_request = server.url.clone().into_client_request().unwrap();
    bob_request.headers_mut().insert(
        "Forwarded",
        HeaderValue::from_static("for=198.51.100.24;proto=https;by=10.0.0.2"),
    );
    let mut bob = authenticate(connect_async(bob_request).await.unwrap().0, None).await;
    send(
        &mut bob,
        json!({"type":"join", "room":"local", "profile":profile("bob")}),
    )
    .await;
    let bob_welcome = receive(&mut bob).await;
    assert_ne!(bob_welcome["numericId"], alice_welcome["numericId"]);
    assert_eq!(bob_welcome["peers"][0]["id"], "alice");
    assert_eq!(receive(&mut alice).await["peer"]["id"], "bob");
}

#[tokio::test]
async fn accepts_packaged_desktop_origins_but_not_similar_foreign_origins() {
    let server = Server::start(Config::default()).await;
    for origin in [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ] {
        let mut request = server.url.clone().into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_str(origin).unwrap());
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket.close(None).await.unwrap();
    }
    for origin in [
        "http://tauri.localhost.evil.example",
        "tauri://other",
        "https://evil.example",
    ] {
        let mut request = server.url.clone().into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_str(origin).unwrap());
        assert!(connect_async(request).await.is_err());
    }
}

#[tokio::test]
async fn forwards_only_valid_tcp_connection_addresses_between_discovered_devices() {
    let server = Server::start(Config::default()).await;
    let (mut alice, _) = server.join("alice", "local").await;
    let (mut bob, _) = server.join("bob", "local").await;
    receive(&mut alice).await;
    let endpoint = json!({"addresses":["/ip4/192.168.1.2/tcp/1234"]});
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":endpoint}),
    )
    .await;
    assert_eq!(
        receive(&mut bob).await,
        json!({"type":"signal", "from":"alice", "data":endpoint})
    );
    let mut invalid = endpoint;
    invalid["text"] = json!("chat content");
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":invalid}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "invalid_signal");
}

#[tokio::test]
async fn relay_requires_server_and_both_devices_to_opt_in() {
    for enabled in [false, true] {
        let server = Server::start(Config {
            relay_enabled: enabled,
            ..Config::default()
        })
        .await;
        let mut probe = server.connect().await;
        assert_eq!(probe.handshake["type"], "capabilities");
        assert_eq!(
            probe.handshake["capabilities"],
            json!(im_api::protocol::capabilities::server_runtime(enabled).capabilities)
        );
        probe.close(None).await.unwrap();
        for (a, b) in [(false, false), (true, false), (false, true), (true, true)] {
            let mut alice = server.connect().await;
            let mut bob = server.connect().await;
            let mut ap = profile("relay-alice");
            ap["relay"] = json!(a);
            let mut bp = profile("relay-bob");
            bp["relay"] = json!(b);
            send(&mut alice, json!({"type":"join","profile":ap})).await;
            assert_eq!(
                receive(&mut alice).await["capabilities"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("transport.ws-relay.v1")),
                enabled
            );
            send(&mut bob, json!({"type":"join","profile":bp})).await;
            let welcome = receive(&mut bob).await;
            assert_eq!(
                welcome["peers"][0]["relay"].as_bool().unwrap_or(false),
                enabled && a
            );
            receive(&mut alice).await;
            let data = json!({"kind":"open"});
            send(
                &mut alice,
                json!({"type":"tunnel","to":"relay-bob","session":"session-1","data":data}),
            )
            .await;
            if enabled && a && b {
                assert_eq!(
                    receive(&mut bob).await,
                    json!({"type":"tunnel","from":"relay-alice","session":"session-1","data":data})
                );
            } else {
                let error = receive(&mut alice).await;
                assert_eq!(error["type"], "tunnel_error");
                assert_eq!(error["session"], "session-1");
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), bob.next())
                        .await
                        .is_err()
                );
            }
            alice.close(None).await.unwrap();
            bob.close(None).await.unwrap();
            // Await server cleanup before reusing the identities in the next case.
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

async fn http_get(server: &Server, method: &str, path: &str, headers: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let url = url::Url::parse(&server.url).unwrap();
    let address = format!("{}:{}", url.host_str().unwrap(), url.port().unwrap());
    let mut stream = TcpStream::connect(&address).await.unwrap();
    stream
        .write_all(
            format!(
                "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n{headers}\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

#[tokio::test]
async fn authorization_protects_http_and_websocket_with_first_packet_credentials() {
    let server = Server::start(Config {
        authorization: "Bearer test-secret".into(),
        cors_origins: vec!["https://frontend.example".into()],
        ..Config::default()
    })
    .await;
    assert!(
        http_get(&server, "GET", "/api/ws/ticket", "")
            .await
            .starts_with("HTTP/1.1 404")
    );
    assert!(
        http_get(&server, "GET", "/api/health/details", "")
            .await
            .starts_with("HTTP/1.1 401")
    );
    assert!(
        http_get(&server, "GET", "/api/health", "")
            .await
            .starts_with("HTTP/1.1 200")
    );
    for auth in [None, Some("Bearer wrong")] {
        let raw = connect_async(&server.url).await.unwrap().0;
        let mut s = authenticate(raw, auth).await;
        assert_eq!(s.handshake["code"], "unauthorized");
        assert!(matches!(
            s.next().await.unwrap().unwrap(),
            Message::Close(_)
        ));
    }
    let mut invalid = connect_async(&server.url).await.unwrap().0;
    invalid
        .send(Message::Text(r#"{"type":"ping"}"#.into()))
        .await
        .unwrap();
    assert!(
        matches!(invalid.next().await.unwrap().unwrap(),Message::Text(raw) if raw.contains("unauthorized"))
    );
    let mut socket = authenticate(
        connect_async(format!("{}?room=auth", server.url))
            .await
            .unwrap()
            .0,
        Some("Bearer test-secret"),
    )
    .await;
    send(
        &mut socket,
        json!({"type":"join","room":"auth","profile":profile("authorized")}),
    )
    .await;
    assert_eq!(receive(&mut socket).await["type"], "welcome");

    let details = http_get(
        &server,
        "GET",
        "/api/health/details",
        "Authorization: Bearer test-secret\r\nCookie: session=private\r\n",
    )
    .await;
    assert!(details.starts_with("HTTP/1.1 200"));
    assert!(!details.contains("test-secret"));
    assert!(!details.contains("session=private"));
    for origin in [
        "https://frontend.example",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ] {
        let response = http_get(&server, "OPTIONS", "/api/health/details", &format!("Origin: {origin}\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: authorization\r\n")).await;
        assert!(response.contains(&format!("access-control-allow-origin: {origin}")));
        assert!(response.contains("authorization"));
    }
}

#[tokio::test]
async fn turn_credential_endpoint_is_not_exposed() {
    let server = Server::start(Config::default()).await;
    let response = http_get(&server, "GET", "/api/ws/ice?device=device-1", "").await;
    assert!(response.starts_with("HTTP/1.1 404"));
    assert!(response.contains("not_found"));
}

#[tokio::test]
async fn runtime_metadata_is_queryable_and_minimum_client_requirements_are_enforced() {
    let server = Server::start(Config::default()).await;
    let mut alice = server.connect().await;
    let mut unsupported = profile("alice");
    unsupported["capabilities"] = json!(["chat.v1"]);
    send(&mut alice, json!({"type":"join","profile":unsupported})).await;
    assert_eq!(receive(&mut alice).await["code"], "capability_required");
    let info = &alice.handshake;
    assert_eq!(
        info["version"],
        im_api::protocol::capabilities::RELEASE_VERSION
    );
    assert!(
        info["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("capabilities.query.v1"))
    );
    let mut mobile = profile("alice");
    mobile["clientType"] = json!("mobile");
    send(&mut alice, json!({"type":"join","profile":mobile})).await;
    receive(&mut alice).await;
    let mut bob = server.connect().await;
    send(&mut bob, json!({"type":"join","profile":profile("bob")})).await;
    let welcome = receive(&mut bob).await;
    assert!(welcome["peers"][0].get("version").is_none());
    assert_eq!(welcome["peers"][0]["clientType"], "mobile");
    assert!(welcome["peers"][0]["capabilities"].is_array());
    receive(&mut alice).await;
    let data = json!({"runtimeQuery":"10000000-0000-4000-8000-000000000000"});
    send(&mut alice, json!({"type":"signal","to":"bob","data":data})).await;
    assert_eq!(receive(&mut bob).await["data"], data);
}

#[tokio::test]
async fn registration_rejects_impersonation_replay_and_unsigned_join() {
    let server = Server::start(Config::default()).await;
    let mut first = server.connect().await;
    let challenge = first.handshake["challenge"].as_str().unwrap();
    let key = keys("victim");
    let proof = json!({"publicKey":base64::engine::general_purpose::STANDARD.encode(key.public().encode_protobuf()),"signature":base64::engine::general_purpose::STANDARD.encode(key.sign(challenge.as_bytes()).unwrap())});
    let mut victim = profile("victim");
    wire(&mut victim);
    let mut join = json!({"type":"join","profile":victim,"proof":proof});
    let mut second = server.connect().await;
    second
        .send(Message::Text(join.to_string().into()))
        .await
        .unwrap();
    assert_eq!(receive(&mut second).await["code"], "invalid_identity");
    join["profile"]["id"] = json!(peer("attacker"));
    first
        .send(Message::Text(join.to_string().into()))
        .await
        .unwrap();
    assert_eq!(receive(&mut first).await["code"], "invalid_identity");
    first
        .send(Message::Text(
            json!({"type":"join","profile":profile("unsigned")})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(receive(&mut first).await["code"], "invalid_message");
}

#[tokio::test]
async fn opaque_tunnels_enforce_open_accept_credit_order_and_revoke_consent() {
    use im_api::protocol::{RelayPacket, ServerMessage, encode_relay_binary};
    let server = Server::start(Config {
        relay_enabled: true,
        ..Config::default()
    })
    .await;
    let mut a = server.connect().await;
    let mut b = server.connect().await;
    for (socket, id) in [(&mut a, "tunnel-a"), (&mut b, "tunnel-b")] {
        let mut p = profile(id);
        p["relay"] = json!(true);
        send(socket, json!({"type":"join","profile":p})).await;
        receive(socket).await;
    }
    receive(&mut a).await;
    let packet = |to: &str, kind: &str| json!({"type":"tunnel","to":to,"session":"test-tunnel","data":{"kind":kind}});
    send(&mut a, packet("tunnel-b", "open")).await;
    assert_eq!(receive(&mut b).await["data"]["kind"], "open");
    send(&mut b, packet("tunnel-a", "accept")).await;
    assert_eq!(receive(&mut a).await["data"]["kind"], "accept");
    for sequence in 0..9 {
        let bytes = encode_relay_binary(&ServerMessage::Relay {
            from: peer("tunnel-b"),
            session: "test-tunnel".into(),
            data: RelayPacket::Bytes {
                sequence,
                payload: vec![42; 16384],
            },
        })
        .unwrap();
        a.send(Message::Binary(bytes.into())).await.unwrap();
        if sequence < 8 {
            loop {
                match b.next().await.unwrap().unwrap() {
                    Message::Binary(bytes) => {
                        assert_eq!(&bytes[..4], b"KIM2");
                        break;
                    }
                    Message::Ping(p) => b.send(Message::Pong(p)).await.unwrap(),
                    other => panic!("{other:?}"),
                }
            }
        } else {
            assert_eq!(receive(&mut a).await["code"], "invalid_tunnel");
        }
    }
    send(&mut b,json!({"type":"tunnel","to":"tunnel-a","session":"test-tunnel","data":{"kind":"credit","count":8}})).await;
    assert_eq!(receive(&mut a).await["data"]["count"], 8);
    b.close(None).await.unwrap();
    assert_eq!(receive(&mut a).await["data"]["kind"], "close");
    assert_eq!(receive(&mut a).await["type"], "peer_left");
    let mut replacement = server.connect().await;
    send(
        &mut replacement,
        json!({"type":"join","profile":profile("tunnel-b")}),
    )
    .await;
    receive(&mut replacement).await;
    assert_eq!(receive(&mut a).await["type"], "peer_joined");
    send(&mut a, packet("tunnel-b", "open")).await;
    assert_eq!(receive(&mut a).await["code"], "relay_not_allowed");
}

#[tokio::test]
#[ignore = "requires a local Workers runtime with RELAY_ENABLED=true"]
async fn sharded_worker_orders_concurrent_tunnel_frames() {
    let server = Server {
        url: std::env::var("WORKER_TEST_WS").unwrap(),
        task: tokio::spawn(async {}),
    };
    let mut peers = Vec::new();
    for (id, room) in [("relay-alpha", "relay-one"), ("relay-beta", "relay-two")] {
        let mut ws = server.connect_room(room).await;
        let mut summary = profile(id);
        summary["numericId"] = "912345".into();
        summary["relay"] = true.into();
        send(
            &mut ws,
            json!({"type":"join","room":room,"profile":summary}),
        )
        .await;
        assert_eq!(receive(&mut ws).await["type"], "welcome");
        peers.push(ws);
    }
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    assert_eq!(receive(&mut a).await["type"], "peer_joined");
    let session = "ordered-frames";
    send(
        &mut a,
        json!({"type":"tunnel","to":"relay-beta","session":session,"data":{"kind":"open"}}),
    )
    .await;
    assert_eq!(receive(&mut b).await["data"]["kind"], "open");
    send(
        &mut b,
        json!({"type":"tunnel","to":"relay-alpha","session":session,"data":{"kind":"accept"}}),
    )
    .await;
    assert_eq!(receive(&mut a).await["data"]["kind"], "accept");
    for round in 0..3 {
        for seq in round * 8..round * 8 + 8 {
            let raw =
                im_api::protocol::encode_relay_binary(&im_api::protocol::ServerMessage::Relay {
                    from: peer("relay-beta"),
                    session: session.into(),
                    data: im_api::protocol::RelayPacket::Bytes {
                        sequence: seq,
                        payload: vec![seq as u8; 16384],
                    },
                })
                .unwrap();
            a.send(Message::Binary(raw.into())).await.unwrap();
        }
        for seq in round * 8..round * 8 + 8 {
            let Message::Binary(bytes) = tokio::time::timeout(Duration::from_secs(3), b.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
            else {
                panic!("expected encrypted bytes")
            };
            assert_eq!(u32::from_be_bytes(bytes[6..10].try_into().unwrap()), seq);
            assert_eq!(bytes.last().copied(), Some(seq as u8));
        }
        send(&mut b,json!({"type":"tunnel","to":"relay-alpha","session":session,"data":{"kind":"credit","count":8}})).await;
        assert_eq!(receive(&mut a).await["data"]["count"], 8);
    }
    a.close(None).await.unwrap();
    b.close(None).await.unwrap();
}

/// Run against an isolated local Wrangler instance with no other connected clients.
#[tokio::test]
#[ignore = "requires a local Workers runtime; set WORKER_TEST_WS"]
async fn sharded_worker_routes_across_rooms_and_reports_unique_owners() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let server = Server {
        url: std::env::var("WORKER_TEST_WS").expect("local Worker URL"),
        task: tokio::spawn(async {}),
    };
    let (mut a, wa) = join_with_number(&server, "alice", "worker-a", "111111").await;
    assert_eq!(wa["type"], "welcome", "{wa}");
    let (mut b, wb) = join_with_number(&server, "bob", "worker-b", "222222").await;
    assert_eq!(wb["peers"], json!([]));
    let found = connect_group(&mut a, &wb["numericId"], "lookup").await;
    assert_eq!(found["peers"][0]["id"], "bob");
    assert_eq!(receive(&mut b).await["peer"]["id"], "alice");
    send(
        &mut b,
        json!({"type":"change_numeric_id","numericId":"333333","revision":2}),
    )
    .await;
    assert_eq!(receive(&mut a).await["previousNumericId"], "222222");
    send(&mut a, json!({"type":"signal","to":"bob","data":offer()})).await;
    assert_eq!(receive(&mut b).await["from"], "alice");
    let (mut replacement, welcome) = join_with_number(&server, "bob", "worker-c", "333333").await;
    assert_eq!(welcome["type"], "welcome");
    assert_eq!(receive(&mut b).await["code"], "session_replaced");
    send(&mut replacement, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut replacement).await["type"], "pong");
    let base = server
        .url
        .replace("ws://", "http://")
        .replace("/api/ws", "/api/health/details");
    let live: Value = serde_json::from_str(
        &reqwest::get(format!("{base}?room={}", wa["room"].as_str().unwrap()))
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(live["peers"], 1);
    assert_eq!(live["pending"], 0);
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let snap: Value =
                serde_json::from_str(&reqwest::get(&base).await.unwrap().text().await.unwrap())
                    .unwrap();
            if snap["rooms"] == 2 && snap["peers"] == 2 && snap["connections"] == 2 {
                let warnings = snap["warnings"].as_array().unwrap();
                for key in ["rooms", "connections"] {
                    let threshold = snap["warningThresholds"][key].as_u64().unwrap();
                    assert_eq!(warnings.contains(&json!(key)), 2 >= threshold);
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .expect("global snapshot must reflect takeover");
}
