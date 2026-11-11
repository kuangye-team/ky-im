use super::*;

fn profile(id: &str) -> Profile {
    Profile {
        id: id.into(),
        name: "设备".into(),
        bio: "".into(),
        color: "#123abc".into(),
        avatar: "🌿".into(),
        device: "test".into(),
        client_type: ClientType::App,
    }
}

struct Cleanup(Vec<Arc<LanNode>>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        for node in &self.0 {
            node.shutdown();
        }
    }
}

async fn node(
    profile: Profile,
    room: &str,
) -> (Arc<LanNode>, mpsc::UnboundedReceiver<NetworkEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        LanNode::start(profile, room.into(), move |event| {
            let _ = tx.send(event);
        })
        .await
        .unwrap(),
        rx,
    )
}

fn inject(a: &LanNode, b: &LanNode) {
    let profile = b.profile.lock().unwrap().clone();
    a.peers.lock().unwrap().insert(
        profile.id.clone(),
        Peer {
            profile,
            instance: b.instance.clone(),
            fullname: b.fullname.clone(),
            addresses: vec![SocketAddr::from((Ipv4Addr::LOCALHOST, b.port))],
        },
    );
}

async fn opened(events: &mut mpsc::UnboundedReceiver<NetworkEvent>) -> String {
    timeout(Duration::from_secs(5), async {
        loop {
            if let Some(NetworkEvent::Open { connection_id, .. }) = events.recv().await {
                break connection_id;
            }
        }
    })
    .await
    .expect("TCP stream should open")
}

async fn data(events: &mut mpsc::UnboundedReceiver<NetworkEvent>) -> (u8, Vec<u8>) {
    loop {
        match events.recv().await.unwrap() {
            NetworkEvent::Data { kind, data, .. } => return (kind, data),
            NetworkEvent::Closed { .. } => panic!("Stream closed before payload"),
            _ => {}
        }
    }
}

#[test]
fn profiles_are_chunked_into_valid_txt_records_and_namespaces_are_isolated() {
    let mut p = profile("10000000-0000-4000-8000-000000000000");
    p.name = "名".repeat(40);
    p.bio = "😀".repeat(80);
    p.device = "机".repeat(64);
    p.validate().unwrap();
    let instance = Uuid::new_v4().to_string();
    let info = service_info(&p, "test", &instance, 1234).unwrap();
    for txt in info.get_properties().iter() {
        assert!(txt.key().len() + txt.val().unwrap_or_default().len() < 255);
    }
    // Add a loopback address to exercise exactly the production record parser.
    let info = ServiceInfo::new(
        SERVICE,
        &instance,
        "test.local.",
        "127.0.0.1",
        1234,
        info.get_properties().iter().cloned().collect::<Vec<_>>(),
    )
    .unwrap()
    .as_resolved_service();
    assert_eq!(parse_service(&info, "test").unwrap().profile, p);
    assert!(parse_service(&info, "other-room").is_none());
    p.bio.push('x');
    assert!(p.validate().is_err());
    let malformed = ServiceInfo::new(
        SERVICE,
        "bad",
        "test.local.",
        "127.0.0.1",
        1234,
        [
            ("version", "1"),
            ("room", "test"),
            ("instance", &instance),
            ("parts", "999999"),
        ]
        .as_slice(),
    )
    .unwrap()
    .as_resolved_service();
    assert!(parse_service(&malformed, "test").is_none());
}

#[tokio::test]
async fn simultaneous_connects_share_one_stream_and_receive_credit_bounds_delivery() {
    let room = Uuid::new_v4().to_string();
    let a_id = "10000000-0000-4000-8000-000000000000";
    let b_id = "20000000-0000-4000-8000-000000000000";
    let (a, mut a_events) = node(profile(a_id), &room).await;
    let (b, mut b_events) = node(profile(b_id), &room).await;
    let _cleanup = Cleanup(vec![a.clone(), b.clone()]);
    inject(&a, &b);
    inject(&b, &a);
    let (ra, rb) = tokio::join!(a.connect(b_id), b.connect(a_id));
    ra.unwrap();
    rb.unwrap();
    let a_connection = opened(&mut a_events).await;
    let b_connection = opened(&mut b_events).await;
    assert_eq!(a_connection, b_connection);
    assert_eq!(a.connections.lock().unwrap().len(), 1);
    assert_eq!(b.connections.lock().unwrap().len(), 1);

    a.send(b_id, &a_connection, frame::TEXT, "你好".as_bytes().to_vec())
        .await
        .unwrap();
    let binary: Vec<u8> = (0..frame::MAX_BINARY).map(|i| i as u8).collect();
    a.send(b_id, &a_connection, frame::BINARY, binary.clone())
        .await
        .unwrap();
    assert_eq!(
        timeout(CONNECT_TIMEOUT, data(&mut b_events)).await.unwrap(),
        (frame::TEXT, "你好".as_bytes().to_vec())
    );
    b.consumed(a_id, "stale-connection");
    assert!(
        timeout(Duration::from_millis(80), data(&mut b_events))
            .await
            .is_err()
    );
    b.consumed(a_id, &b_connection);
    assert_eq!(
        timeout(CONNECT_TIMEOUT, data(&mut b_events)).await.unwrap(),
        (frame::BINARY, binary)
    );
    b.consumed(a_id, &b_connection);
    b.send(a_id, &b_connection, frame::TEXT, b"reply".to_vec())
        .await
        .unwrap();
    assert_eq!(
        timeout(CONNECT_TIMEOUT, data(&mut a_events)).await.unwrap(),
        (frame::TEXT, b"reply".to_vec())
    );
    a.consumed(b_id, &a_connection);

    a.close_peer(b_id, Some("stale-connection"));
    assert!(a.connections.lock().unwrap().contains_key(b_id));
    a.removed(&b.fullname);
    assert!(
        a.send(b_id, &a_connection, frame::TEXT, b"late".to_vec())
            .await
            .is_err()
    );
    assert!(a.connect(b_id).await.is_err());
}

#[tokio::test]
async fn larger_identity_can_initiate_and_unknown_or_stale_handshakes_are_rejected() {
    let room = Uuid::new_v4().to_string();
    let a_id = "10000000-0000-4000-8000-000000000000";
    let b_id = "20000000-0000-4000-8000-000000000000";
    let (a, mut a_events) = node(profile(a_id), &room).await;
    let (b, mut b_events) = node(profile(b_id), &room).await;
    let _cleanup = Cleanup(vec![a.clone(), b.clone()]);
    inject(&a, &b);
    inject(&b, &a);
    b.connect(a_id).await.unwrap();
    assert_eq!(opened(&mut a_events).await, opened(&mut b_events).await);
    let peer = b.peers.lock().unwrap().get(a_id).unwrap().clone();
    let mut hello = b.hello(&peer, Uuid::new_v4().to_string(), true);
    hello.instance = Uuid::new_v4().to_string();
    assert!(a.validate_hello(&hello).is_err());
    hello.from = Uuid::new_v4().to_string();
    assert!(a.validate_hello(&hello).is_err());
    assert!(a.connect(&Uuid::new_v4().to_string()).await.is_err());
}

#[tokio::test]
#[ignore = "Requires a LAN interface with multicast; run explicitly on a development machine"]
async fn mdns_discovers_updates_and_removes_real_peers() {
    let room = Uuid::new_v4().to_string();
    let a_id = Uuid::new_v4().to_string();
    let b_id = Uuid::new_v4().to_string();
    let (a, _) = node(profile(&a_id), &room).await;
    let (b, _) = node(profile(&b_id), &room).await;
    let _cleanup = Cleanup(vec![a.clone(), b.clone()]);
    timeout(Duration::from_secs(20), async {
        while !(a.peers.lock().unwrap().contains_key(&b_id)
            && b.peers.lock().unwrap().contains_key(&a_id))
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("multicast discovery");
    let mut updated = profile(&b_id);
    updated.bio = "updated over mDNS".into();
    b.update_profile(updated.clone()).unwrap();
    timeout(Duration::from_secs(15), async {
        while a
            .peers
            .lock()
            .unwrap()
            .get(&b_id)
            .is_none_or(|p| p.profile != updated)
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("profile update");
    b.shutdown();
    timeout(Duration::from_secs(15), async {
        while a.peers.lock().unwrap().contains_key(&b_id) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("goodbye removal");
}

#[tokio::test]
async fn cancelling_a_dial_does_not_remove_its_replacement_attempt() {
    let room = Uuid::new_v4().to_string();
    let (a, _) = node(profile("10000000-0000-4000-8000-000000000000"), &room).await;
    let _cleanup = Cleanup(vec![a.clone()]);
    let peer_id = "20000000-0000-4000-8000-000000000000";
    // Accept TCP at the OS level, but never reply to the application handshake.
    let blackhole = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    a.peers.lock().unwrap().insert(
        peer_id.into(),
        Peer {
            profile: profile(peer_id),
            instance: Uuid::new_v4().to_string(),
            fullname: "blackhole".into(),
            addresses: vec![blackhole.local_addr().unwrap()],
        },
    );
    let first_node = a.clone();
    let first = tokio::spawn(async move { first_node.connect(peer_id).await });
    while a.connecting.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    a.close_peer(peer_id, None);
    // Poll the replacement into the pending map before the cancelled task cleans up.
    let replacement_node = a.clone();
    let mut replacement = Box::pin(replacement_node.connect(peer_id));
    tokio::select! { biased; _ = &mut replacement => panic!("Handshake should wait"), _ = tokio::task::yield_now() => {} }
    let replacement_id = a.connecting.lock().unwrap().get(peer_id).unwrap().id;
    assert!(first.await.unwrap().is_err());
    assert_eq!(
        a.connecting.lock().unwrap().get(peer_id).unwrap().id,
        replacement_id
    );
    a.shutdown();
    assert!(replacement.await.is_err());
}

#[tokio::test]
async fn native_negotiation_works_with_tcp_content_and_mdns_disabled() {
    let (tx_a, _rx_a) = mpsc::unbounded_channel();
    let (tx_b, mut rx_b) = mpsc::unbounded_channel();
    let a = LanNode::start_configured(
        profile("10000000-0000-4000-8000-000000000000"),
        "test".into(),
        false,
        false,
        move |e| {
            let _ = tx_a.send(e);
        },
    )
    .await
    .unwrap();
    let b = LanNode::start_configured(
        profile("20000000-0000-4000-8000-000000000000"),
        "test".into(),
        false,
        false,
        move |e| {
            let _ = tx_b.send(e);
        },
    )
    .await
    .unwrap();
    let _cleanup = Cleanup(vec![a.clone(), b.clone()]);
    assert!(a.mdns.is_none());
    assert!(b.mdns.is_none());
    inject(&a, &b);
    inject(&b, &a);
    let id = b.profile.lock().unwrap().id.clone();
    assert!(a.connect(&id).await.is_err());
    assert!(
        a.signal(&id, serde_json::json!({"text":"not negotiation"}))
            .await
            .is_err()
    );
    let signal = serde_json::json!({"description":{"type":"offer","sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"}});
    a.signal(&id, signal.clone()).await.unwrap();
    match timeout(Duration::from_secs(3), rx_b.recv())
        .await
        .unwrap()
        .unwrap()
    {
        NetworkEvent::Signal { peer_id, data } => {
            assert_eq!(peer_id, a.profile.lock().unwrap().id);
            assert_eq!(data, signal);
        }
        event => panic!("Unexpected event: {event:?}"),
    }
    assert!(a.connections.lock().unwrap().is_empty());
    assert!(b.connections.lock().unwrap().is_empty());
}

#[tokio::test]
async fn centrally_registered_devices_connect_without_mdns() {
    let (tx_a, mut rx_a) = mpsc::unbounded_channel();
    let (tx_b, mut rx_b) = mpsc::unbounded_channel();
    let a = LanNode::start_configured(
        profile("10000000-0000-4000-8000-000000000000"),
        "test".into(),
        false,
        true,
        move |e| {
            let _ = tx_a.send(e);
        },
    )
    .await
    .unwrap();
    let b = LanNode::start_configured(
        profile("20000000-0000-4000-8000-000000000000"),
        "test".into(),
        false,
        true,
        move |e| {
            let _ = tx_b.send(e);
        },
    )
    .await
    .unwrap();
    let _cleanup = Cleanup(vec![a.clone(), b.clone()]);
    let a_id = a.profile.lock().unwrap().id.clone();
    let b_id = b.profile.lock().unwrap().id.clone();
    // Registration validates advertised addresses. Local sockets use loopback to make the test independent of LAN routing.
    a.register_peer(
        b.profile.lock().unwrap().clone(),
        TcpEndpoint {
            instance: b.instance.clone(),
            port: b.port,
            addresses: vec![Ipv4Addr::new(192, 168, 1, 2)],
        },
    )
    .unwrap();
    b.register_peer(
        a.profile.lock().unwrap().clone(),
        TcpEndpoint {
            instance: a.instance.clone(),
            port: a.port,
            addresses: vec![Ipv4Addr::new(192, 168, 1, 1)],
        },
    )
    .unwrap();
    a.peers.lock().unwrap().get_mut(&b_id).unwrap().addresses =
        vec![SocketAddr::from((Ipv4Addr::LOCALHOST, b.port))];
    b.peers.lock().unwrap().get_mut(&a_id).unwrap().addresses =
        vec![SocketAddr::from((Ipv4Addr::LOCALHOST, a.port))];
    a.connect(&b_id).await.unwrap();
    let connection = opened(&mut rx_a).await;
    opened(&mut rx_b).await;
    a.send(&b_id, &connection, frame::TEXT, b"central TCP".to_vec())
        .await
        .unwrap();
    assert_eq!(data(&mut rx_b).await, (frame::TEXT, "central TCP".into()));
    a.forget_peer(&b_id);
    assert!(!a.peers.lock().unwrap().contains_key(&b_id));
    assert!(!a.remote_peers.lock().unwrap().contains_key(&b_id));
    assert!(!a.connections.lock().unwrap().contains_key(&b_id));
}

#[tokio::test]
async fn mdns_departure_keeps_a_centrally_discovered_peer() {
    let (a, _) = node(profile("10000000-0000-4000-8000-000000000000"), "test").await;
    let (b, _) = node(profile("20000000-0000-4000-8000-000000000000"), "test").await;
    let _cleanup = Cleanup(vec![a.clone(), b.clone()]);
    inject(&a, &b);
    a.register_peer(
        b.profile.lock().unwrap().clone(),
        TcpEndpoint {
            instance: b.instance.clone(),
            port: b.port,
            addresses: vec![Ipv4Addr::new(192, 168, 1, 2)],
        },
    )
    .unwrap();
    a.removed(&b.fullname);
    let id = b.profile.lock().unwrap().id.clone();
    assert!(a.peers.lock().unwrap().contains_key(&id));
}
