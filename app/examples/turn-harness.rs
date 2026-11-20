//! Isolated loopback TURN server for native/browser interoperability tests only.
use std::{net::SocketAddr, sync::Arc};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, UdpSocket},
};
use turn::{
    auth::{AuthHandler, generate_auth_key},
    relay::relay_static::RelayAddressGeneratorStatic,
    server::{
        Server,
        config::{ConnConfig, ServerConfig},
    },
};
struct Auth;
impl AuthHandler for Auth {
    fn auth_handle(&self, user: &str, realm: &str, _: SocketAddr) -> Result<Vec<u8>, turn::Error> {
        if user != "test" {
            return Err(turn::Error::Other("Unknown test user".into()));
        }
        Ok(generate_auth_key(user, realm, "test-password"))
    }
}
#[tokio::main]
async fn main() {
    let server = Server::new(ServerConfig {
        conn_configs: vec![ConnConfig {
            conn: Arc::new(UdpSocket::bind("127.0.0.1:3479").await.unwrap()),
            relay_addr_generator: Box::new(RelayAddressGeneratorStatic {
                relay_address: "127.0.0.1".parse().unwrap(),
                address: "127.0.0.1".into(),
                net: Arc::new(webrtc_util::vnet::net::Net::new(None)),
            }),
        }],
        realm: "native-test".into(),
        auth_handler: Arc::new(Auth),
        channel_bind_timeout: Default::default(),
        alloc_close_notify: None,
    })
    .await
    .unwrap();
    let health = TcpListener::bind("127.0.0.1:4321").await.unwrap();
    loop {
        let (mut socket, _) = health.accept().await.unwrap();
        let _ = socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await;
        let _ = &server;
    }
}
