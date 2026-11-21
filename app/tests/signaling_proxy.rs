// The proxy overrides are process-local to this integration test executable.
use hummingbird::p2p::ipc::probe_signaling_server;
use std::{net::TcpListener, thread};
use tungstenite::Message;

fn responder(route: &'static str, count: usize) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let task = thread::spawn(move || {
        for stream in listener.incoming().take(count) {
            let mut ws = tungstenite::accept(stream.unwrap()).unwrap();
            let auth: serde_json::Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(auth["type"], "auth");
            ws.send(Message::text(route)).unwrap();
        }
    });
    (address, task)
}

#[tokio::test]
async fn server_connections_follow_system_bypass_and_direct_preferences() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (origin, origin_task) = responder("origin", 2);
    let (proxy, proxy_task) = responder("proxy", 1);
    proxyres::config::set_proxy_override(Some(&format!("http://{proxy}")));
    proxyres::config::set_bypass_list_override(Some("<-loopback>"));
    let probe = |follow_system| {
        probe_signaling_server(format!("ws://{origin}/api/ws"), None, follow_system, 5000)
    };
    assert_eq!(probe(true).await.unwrap(), "proxy");
    assert_eq!(probe(false).await.unwrap(), "origin");
    proxyres::config::set_bypass_list_override(Some("127.0.0.1"));
    assert_eq!(probe(true).await.unwrap(), "origin");
    proxy_task.join().unwrap();
    origin_task.join().unwrap();
}
