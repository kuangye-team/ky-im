use super::{CHAT, Node};
use libp2p::identity::Keypair;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

struct TestPeer {
    node: Node,
    id: String,
    address: String,
    events: mpsc::UnboundedReceiver<Value>,
}

impl TestPeer {
    async fn start() -> Self {
        let key = Keypair::generate_ed25519();
        let id = key.public().to_peer_id().to_string();
        let (events, mut rx) = mpsc::unbounded_channel();
        let data = events.clone();
        let node = Node::start(
            key.to_protobuf_encoding().unwrap(),
            json!({"id":id}),
            "test".into(),
            super::ListenOptions {
                tcp: true,
                announce_loopback: true,
                ..Default::default()
            },
            Arc::new(move |event| {
                let _ = events.send(event);
            }),
            Arc::new(move |header, bytes| {
                let _ = data.send(json!({"from":header["peerId"], "payload":bytes}));
            }),
        )
        .await
        .unwrap();
        let address = loop {
            let event = rx.recv().await.unwrap();
            if let Some(address) = event["addresses"].as_array().and_then(|addresses| {
                addresses
                    .iter()
                    .filter_map(Value::as_str)
                    .find(|addr| addr.starts_with("/ip4/127.0.0.1/tcp/"))
            }) {
                break address.to_owned();
            }
        };
        Self {
            node,
            id,
            address,
            events: rx,
        }
    }

    async fn register(&self, other: &TestPeer) {
        self.node
            .register(
                json!({"id":other.id}),
                vec![other.address.clone()],
                "test".into(),
            )
            .await
            .unwrap();
    }

    async fn wait_payload(&mut self, from: &str, payload: &[u8]) {
        while let Some(event) = self.events.recv().await {
            if event["from"] == from && event["payload"] == json!(payload) {
                return;
            }
        }
        panic!("node stopped before delivering the payload");
    }

    async fn wait_open(&mut self, id: &str) {
        while let Some(event) = self.events.recv().await {
            if event["type"] == "open" && event["peerId"] == id {
                return;
            }
        }
        panic!("node stopped before its business streams opened");
    }
}

impl Drop for TestPeer {
    fn drop(&mut self) {
        self.node.stop();
    }
}

#[test]
fn mdns_announces_the_current_discovery_capabilities() {
    use mdns_sd::IntoTxtProperties;
    let profile = json!({"id":"peer", "numericId":"123456", "name":"Alice",
        "runtime":{"clientType":"mobile","capabilities":["client.app.v1","discovery.v1","file.v1","transfer.webrtc.v1"]}});
    let ips = [std::net::Ipv4Addr::LOCALHOST.into()];
    let mut service = super::mdns_info(&profile, "test", 1234, "test", &ips)
        .unwrap()
        .as_resolved_service();
    let summary = super::decode_mdns(&service).unwrap();
    assert_eq!(summary["clientType"], "mobile");
    let mut expected = profile["runtime"]["capabilities"]
        .as_array()
        .unwrap()
        .clone();
    let mut actual = summary["capabilities"].as_array().unwrap().clone();
    expected.sort_by_key(Value::to_string);
    actual.sort_by_key(Value::to_string);
    assert_eq!(actual, expected);
    let mut previous = service.txt_properties.into_property_map_str();
    previous.insert("protocol".into(), "hummingbird/2".into());
    service.txt_properties = previous.into_txt_properties();
    assert!(super::decode_mdns(&service).is_none());
}

#[tokio::test]
async fn swarm_accepts_and_dials_beyond_ten_retained_peers() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut hub = TestPeer::start().await;
        let mut peers = Vec::new();
        for index in 0..12 {
            let mut peer = TestPeer::start().await;
            hub.register(&peer).await;
            peer.register(&hub).await;
            if index == 10 {
                peer.node.connect(&hub.id).await.unwrap();
            } else {
                hub.node.connect(&peer.id).await.unwrap();
            }
            hub.wait_open(&peer.id).await;
            peer.wait_open(&hub.id).await;
            peers.push(peer);
        }
        for peer in &mut peers {
            hub.node
                .send(&peer.id, CHAT, 1, b"hello".to_vec())
                .await
                .unwrap();
            peer.wait_payload(&hub.id, b"hello").await;
            peer.node
                .send(&hub.id, CHAT, 1, b"reply".to_vec())
                .await
                .unwrap();
            hub.wait_payload(&peer.id, b"reply").await;
        }
    })
    .await
    .expect("all twelve connections should be usable");
}
