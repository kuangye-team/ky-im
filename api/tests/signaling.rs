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

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

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
        connect_async(&self.url).await.unwrap().0
    }

    async fn join(&self, id: &str, room: &str) -> (Socket, Value) {
        let mut socket = self.connect().await;
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
    json!({"id":id, "name":format!("User {id}"), "bio":"Hello", "color":"#9266dd", "avatar":"🐱", "device":"Browser", "clientType":"web"})
}

fn numbered_profile(id: &str, welcome: &Value) -> Value {
    let mut result = profile(id);
    result["numericId"] = welcome["numericId"].clone();
    assert!(im_api::protocol::valid_numeric_id(
        result["numericId"].as_str().unwrap()
    ));
    result
}

async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn receive(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                other => panic!("Expected protocol JSON, received {other:?}"),
            }
        }
    })
    .await
    .expect("timed out waiting for protocol message")
}

#[tokio::test]
async fn discovery_preserves_web_and_app_client_types() {
    let server = Server::start(Config::default()).await;
    let (mut web, _) = server.join("web", "local").await;
    let mut app = server.connect().await;
    let mut app_profile = profile("app");
    app_profile["clientType"] = json!("app");
    send(&mut app, json!({"type":"join", "profile":app_profile})).await;
    assert_eq!(receive(&mut app).await["peers"][0]["clientType"], "web");
    assert_eq!(receive(&mut web).await["peer"]["clientType"], "app");
    app_profile["clientType"] = json!("web");
    send(&mut app, json!({"type":"profile", "profile":app_profile})).await;
    assert_eq!(receive(&mut web).await["peer"]["clientType"], "web");
    app_profile["clientType"] = json!("other");
    send(&mut app, json!({"type":"profile", "profile":app_profile})).await;
    assert_eq!(receive(&mut app).await["type"], "error");
}

#[tokio::test]
async fn refresh_number_updates_group_and_observers_without_changing_discovery() {
    let server = Server::start(Config::default()).await;
    let (mut alice, original) = server.join("alice", "local").await;
    let (mut bob, _) = server.join("bob", "local").await;
    receive(&mut alice).await;
    let (mut observer, observer_welcome) = server.join("observer", "remote").await;
    let (mut unrelated, _) = server.join("unrelated", "isolated").await;
    send(
        &mut observer,
        json!({"type":"connect_group", "requestId":"find", "numericId":original["numericId"]}),
    )
    .await;
    receive(&mut observer).await;
    receive(&mut alice).await;
    receive(&mut bob).await;

    send(
        &mut alice,
        json!({"type":"refresh_number", "requestId":"refresh"}),
    )
    .await;
    let refreshed = receive(&mut alice).await;
    let number = &refreshed["numericId"];
    assert_eq!(refreshed["type"], "number_updated");
    assert_eq!(refreshed["requestId"], "refresh");
    assert_eq!(refreshed["peerIds"], json!(["alice", "bob"]));
    assert_ne!(number, &original["numericId"]);
    assert_ne!(number, &observer_welcome["numericId"]);
    assert!(im_api::protocol::valid_numeric_id(number.as_str().unwrap()));
    let notification =
        json!({"type":"number_updated", "numericId":number, "peerIds":["alice", "bob"]});
    assert_eq!(receive(&mut bob).await, notification);
    assert_eq!(receive(&mut observer).await, notification);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), unrelated.next())
            .await
            .is_err()
    );

    send(
        &mut observer,
        json!({"type":"connect_group", "requestId":"old", "numericId":original["numericId"]}),
    )
    .await;
    assert_eq!(receive(&mut observer).await["code"], "peer_unavailable");
    send(
        &mut observer,
        json!({"type":"connect_group", "requestId":"new", "numericId":number}),
    )
    .await;
    let found = receive(&mut observer).await;
    assert_eq!(found["peers"].as_array().unwrap().len(), 2);
    assert!(
        found["peers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| &p["numericId"] == number)
    );

    // Existing pair permissions and group subscriptions survive the change.
    send(
        &mut observer,
        json!({"type":"signal", "to":"alice", "data":{"candidate":{"candidate":""}}}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["type"], "signal");
    let (_, welcome) = server.join("newcomer", "local").await;
    assert_eq!(&welcome["numericId"], number);
    assert_eq!(receive(&mut observer).await["peer"]["id"], "newcomer");
}

#[tokio::test]
async fn number_refresh_requires_join_and_rejects_content_and_excess_requests() {
    let server = Server::start(Config::default()).await;
    let mut socket = server.connect().await;
    send(
        &mut socket,
        json!({"type":"refresh_number", "requestId":"before-join"}),
    )
    .await;
    assert_eq!(receive(&mut socket).await["code"], "join_required");
    let (mut alice, _) = server.join("alice", "local").await;
    send(
        &mut alice,
        json!({"type":"refresh_number", "requestId":"content", "text":"not signaling"}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "invalid_message");
    for index in 0..10 {
        send(
            &mut alice,
            json!({"type":"refresh_number", "requestId":format!("refresh-{index}")}),
        )
        .await;
        assert_eq!(receive(&mut alice).await["type"], "number_updated");
    }
    send(
        &mut alice,
        json!({"type":"refresh_number", "requestId":"too-many"}),
    )
    .await;
    assert_eq!(receive(&mut alice).await["code"], "connect_rate_limited");
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

    let offer = json!({"description":{"type":"offer", "sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"}});
    send(
        &mut alice,
        json!({"type":"signal", "to":"bob", "data":offer}),
    )
    .await;
    assert_eq!(
        receive(&mut bob).await,
        json!({"type":"signal", "from":"alice", "data":offer})
    );
    let mut edited = profile("attempted-identity-change");
    edited["name"] = "Bobby".into();
    send(&mut bob, json!({"type":"profile", "profile":edited})).await;
    edited["id"] = "bob".into();
    edited["numericId"] = bob_profile["numericId"].clone();
    assert_eq!(
        receive(&mut alice).await,
        json!({"type":"peer_updated", "peer":edited})
    );

    let (mut carol, welcome) = server.join("carol", "local").await;
    assert_eq!(welcome["peers"], json!([alice_profile, edited]));
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
        json!({"type":"signal", "to":"alice", "data":{"candidate":{"candidate":"candidate:new"}}}),
    )
    .await;
    assert_eq!(receive(&mut new_alice).await["from"], "bob");
    send(
        &mut new_alice,
        json!({"type":"signal", "to":"bob", "data":{"description":{"type":"answer","sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"}}}),
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
    send(
        &mut carol,
        json!({"type":"join", "room":"another", "profile":profile("carol")}),
    )
    .await;
    assert_eq!(receive(&mut carol).await["code"], "room_limit");
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
    let (mut socket, _) = connect_async(allowed).await.unwrap();
    send(&mut socket, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut socket).await["type"], "pong");
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
    let mut socket = server.connect().await;
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
    json!({"description":{"type":"offer", "sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"}})
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
async fn numeric_ids_are_global_collision_safe_and_survive_replacement() {
    let server = Server::start(Config::default()).await;
    let (mut alice, first) = join_with_number(&server, "alice", "one", "123456").await;
    assert_eq!(first["numericId"], "123456");
    let (_bob, second) = join_with_number(&server, "bob", "two", "123456").await;
    assert_ne!(first["numericId"], second["numericId"]);
    assert!(im_api::protocol::valid_numeric_id(
        second["numericId"].as_str().unwrap()
    ));
    let (mut new_alice, third) = join_with_number(&server, "alice", "one", "654321").await;
    assert_eq!(third["numericId"], first["numericId"]);
    assert_eq!(receive(&mut alice).await["code"], "session_replaced");
    let mut edited = profile("impostor");
    edited["numericId"] = "777777".into();
    send(&mut new_alice, json!({"type":"profile", "profile":edited})).await;
    send(&mut new_alice, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut new_alice).await["type"], "pong");
    let (_carol, welcome) = server.join("carol", "one").await;
    assert_eq!(welcome["peers"][0]["id"], "alice");
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
    let mut edited = profile("bob");
    edited["name"] = "Newest Bob".into();
    send(&mut bob, json!({"type":"profile", "profile":edited})).await;
    let update = receive(&mut alice).await;
    assert_eq!(update["type"], "peer_updated");
    assert_eq!(update["peer"]["name"], "Newest Bob");
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
        json!({"description":{"type":"offer", "sdp":"chat message"}}),
        json!({"description":{"type":"offer", "sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n", "text":"secret"}}),
        json!({"candidate":{"candidate":"chat message"}}),
        json!({"candidate":{"candidate":"candidate:1", "file":"file content"}}),
        json!({"candidate":{"candidate":"candidate:1"}, "text":"chat"}),
        json!({"candidate":null}),
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
    let candidate = json!({"candidate":{"candidate":"candidate:1 1 udp 2122260223 192.168.1.2 5000 typ host", "sdpMid":"0", "sdpMLineIndex":0, "usernameFragment":"abcd"}});
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

#[tokio::test]
async fn group_discovery_connects_all_members_without_changing_own_group() {
    let server = Server::start(Config::default()).await;
    let (mut alice, alice_welcome) = server.join("alice", "home").await;
    let (mut bob, bob_welcome) = server.join("bob", "target").await;
    let (mut carol, carol_welcome) = server.join("carol", "target").await;
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
    let (mut dan, dan_welcome) = server.join("dan", "target").await;
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
    assert_eq!(home_welcome["numericId"], alice_welcome["numericId"]);
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
    assert_eq!(
        own["peers"],
        json!([numbered_profile("home-peer", &home_welcome)])
    );
    carol.close(None).await.unwrap();
    for peer in [&mut alice, &mut bob, &mut dan, &mut eve] {
        assert_eq!(
            receive(peer).await,
            json!({"type":"peer_left", "id":"carol"})
        );
    }
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
    let (mut bob, _) = connect_async(request).await.unwrap();
    send(&mut bob, json!({"type":"join", "profile":profile("bob")})).await;
    let bob_welcome = receive(&mut bob).await;
    assert_eq!(bob_welcome["numericId"], welcome["numericId"]);
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
    let (mut alice, _) = connect_async(alice_request).await.unwrap();
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
    let (mut bob, _) = connect_async(bob_request).await.unwrap();
    send(
        &mut bob,
        json!({"type":"join", "room":"local", "profile":profile("bob")}),
    )
    .await;
    let bob_welcome = receive(&mut bob).await;
    assert_eq!(bob_welcome["numericId"], alice_welcome["numericId"]);
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
    let endpoint = json!({"tcp":{"instance":"10000000-0000-4000-8000-000000000000","port":1234,"addresses":["192.168.1.2"]}});
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
    invalid["tcp"]["text"] = json!("chat content");
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
        send(&mut probe, json!({"type":"capabilities"})).await;
        assert_eq!(
            receive(&mut probe).await,
            json!({"type":"capabilities","relay":enabled})
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
            assert_eq!(receive(&mut alice).await["relay"], enabled);
            send(&mut bob, json!({"type":"join","profile":bp})).await;
            let welcome = receive(&mut bob).await;
            assert_eq!(
                welcome["peers"][0]["relay"].as_bool().unwrap_or(false),
                enabled && a
            );
            receive(&mut alice).await;
            let data = json!({"kind":"data","binary":false,"payload":"aGVsbG8="});
            send(
                &mut alice,
                json!({"type":"relay","to":"relay-bob","session":"session-1","data":data}),
            )
            .await;
            if enabled && a && b {
                assert_eq!(
                    receive(&mut bob).await,
                    json!({"type":"relay","from":"relay-alice","session":"session-1","data":data})
                );
            } else {
                let error = receive(&mut alice).await;
                assert_eq!(error["type"], "relay_error");
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

#[tokio::test]
async fn relay_is_bounded_scoped_and_does_not_use_the_signaling_rate_budget() {
    let server = Server::start(Config {
        relay_enabled: true,
        ..Config::default()
    })
    .await;
    let mut alice = server.connect().await;
    let mut bob = server.connect().await;
    let mut outsider = server.connect().await;
    for (socket, id, room) in [
        (&mut alice, "alice", "local"),
        (&mut bob, "bob", "local"),
        (&mut outsider, "outsider", "other"),
    ] {
        let mut p = profile(id);
        p["relay"] = json!(true);
        send(socket, json!({"type":"join","room":room,"profile":p})).await;
        receive(socket).await;
    }
    receive(&mut alice).await;
    let packet = json!({"type":"relay","to":"bob","session":"transfer","data":{"kind":"data","binary":true,"payload":"AAAA"}});
    send(&mut outsider, packet.clone()).await;
    assert_eq!(receive(&mut outsider).await["code"], "peer_unavailable");
    for _ in 0..300 {
        send(&mut alice, packet.clone()).await;
        assert_eq!(receive(&mut bob).await["data"]["payload"], "AAAA");
    }
    let mut full_block = packet.clone();
    let binary: Vec<u8> = (0..128 * 1024 + 44).map(|i| i as u8).collect();
    full_block["data"]["payload"] =
        json!(base64::engine::general_purpose::STANDARD.encode(&binary));
    send(&mut alice, full_block.clone()).await;
    assert_eq!(
        receive(&mut bob).await["data"]["payload"],
        full_block["data"]["payload"]
    );
    send(&mut alice, json!({"type":"ping"})).await;
    assert_eq!(receive(&mut alice).await["type"], "pong");
    let mut oversized = packet.clone();
    oversized["data"]["payload"] = json!("A".repeat((128_usize * 1024 + 44).div_ceil(3) * 4 + 4));
    send(&mut alice, oversized).await;
    assert_eq!(receive(&mut alice).await["code"], "invalid_relay");
    let mut bp = profile("bob");
    bp["relay"] = json!(false);
    send(&mut bob, json!({"type":"profile","profile":bp})).await;
    receive(&mut alice).await;
    send(&mut alice, packet).await;
    assert_eq!(receive(&mut alice).await["code"], "relay_not_allowed");
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
async fn authorization_protects_http_and_websocket_and_supports_browser_tickets() {
    let server = Server::start(Config {
        authorization: "Bearer test-secret".into(),
        cors_origins: vec!["https://frontend.example".into()],
        ..Config::default()
    })
    .await;
    for path in ["/api/ws/ticket", "/api/health/details"] {
        for header in ["", "Authorization: Bearer wrong\r\n"] {
            let response = http_get(&server, "GET", path, header).await;
            assert!(response.starts_with("HTTP/1.1 401"), "{response}");
        }
    }
    assert!(
        http_get(&server, "GET", "/api/health", "")
            .await
            .starts_with("HTTP/1.1 200")
    );
    for value in [None, Some("Bearer wrong")] {
        let mut request = server.url.as_str().into_client_request().unwrap();
        if let Some(value) = value {
            request
                .headers_mut()
                .insert("Authorization", HeaderValue::from_static(value));
        }
        let error = connect_async(request).await.unwrap_err();
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 401)
        );
    }
    let mut request = server.url.as_str().into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_static("Bearer test-secret"),
    );
    let mut socket = connect_async(request).await.unwrap().0;
    send(&mut socket, json!({"type":"capabilities"})).await;
    assert_eq!(receive(&mut socket).await["relay"], false);
    socket.close(None).await.unwrap();

    let response = http_get(
        &server,
        "GET",
        "/api/ws/ticket",
        "Authorization: Bearer test-secret\r\nOrigin: https://frontend.example\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("cache-control: no-store"));
    assert!(response.contains("access-control-allow-origin: https://frontend.example"));
    let body: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
    let ticket = body["ticket"].as_str().unwrap();
    assert!(!ticket.contains("test-secret"));
    let mut socket = connect_async(format!("{}?ticket={ticket}", server.url))
        .await
        .unwrap()
        .0;
    send(
        &mut socket,
        json!({"type":"join", "room":"auth", "profile":profile("authorized")}),
    )
    .await;
    assert_eq!(receive(&mut socket).await["type"], "welcome");
    socket.close(None).await.unwrap();
    assert!(
        connect_async(format!("{}?ticket={ticket}x", server.url))
            .await
            .is_err()
    );

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
    for origin in ["https://frontend.example", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
        let response = http_get(&server, "OPTIONS", "/api/ws/ticket", &format!("Origin: {origin}\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: authorization\r\n")).await;
        assert!(response.contains(&format!("access-control-allow-origin: {origin}")));
        assert!(response.contains("authorization"));
    }
}
