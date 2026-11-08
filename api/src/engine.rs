use crate::{
    Config,
    hub::{Hub, Identity, Peer, Transport},
    protocol::{ClientMessage, ServerMessage, valid_identifier},
};
#[cfg(not(target_arch = "wasm32"))]
use std::sync::atomic::AtomicU64;
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
};
#[cfg(not(target_arch = "wasm32"))]
use tokio::sync::Semaphore;

pub struct AppState {
    pub config: Config,
    pub(crate) hub: Mutex<Hub>,
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) connections: Arc<Semaphore>,
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) next_generation: AtomicU64,
}

impl AppState {
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Self {
            #[cfg(not(target_arch = "wasm32"))]
            connections: Arc::new(Semaphore::new(config.max_connections)),
            config,
            hub: Mutex::new(Hub::default()),
            #[cfg(not(target_arch = "wasm32"))]
            next_generation: AtomicU64::new(1),
        })
    }
}

pub(crate) fn process_message(
    state: &AppState,
    message: ClientMessage,
    source_ip: IpAddr,
    identity: &mut Option<Identity>,
    generation: &str,
    transport: &Arc<dyn Transport>,
) -> Result<(), ServerMessage> {
    match message {
        ClientMessage::Join { room, profile } => {
            if identity.is_some() {
                return Err(ServerMessage::error(
                    "already_joined",
                    "A connection can join only once",
                ));
            }
            if !valid_identifier(&room) {
                return Err(ServerMessage::error(
                    "invalid_room",
                    "room must contain 1–64 ASCII letters, digits, '-' or '_'",
                ));
            }
            profile
                .validate()
                .map_err(|message| ServerMessage::error("invalid_profile", message))?;
            *identity = Some(state.join(
                format!("{room}@{}", source_ip.to_canonical()),
                Peer {
                    profile,
                    generation: generation.to_owned(),
                    transport: transport.clone(),
                },
            )?);
            Ok(())
        }
        ClientMessage::Profile { profile } => {
            state.update_profile(require_identity(identity)?, profile)
        }
        ClientMessage::RefreshNumber { request_id } => {
            let Some(identity) = identity.as_ref() else {
                return Err(ServerMessage::ConnectError {
                    request_id,
                    code: "join_required".into(),
                    message: "请先连接信令服务".into(),
                });
            };
            state.refresh_number(identity, request_id)
        }
        ClientMessage::ConnectGroup {
            request_id,
            numeric_id,
        } => {
            let Some(identity) = identity.as_ref() else {
                return Err(ServerMessage::ConnectError {
                    request_id,
                    code: "join_required".into(),
                    message: "请先连接信令服务".into(),
                });
            };
            state.connect_group(identity, request_id, &numeric_id)
        }
        ClientMessage::Connect {
            request_id,
            numeric_id,
            expected_peer_id,
        } => {
            let Some(identity) = identity.as_ref() else {
                return Err(ServerMessage::ConnectError {
                    request_id,
                    code: "join_required".into(),
                    message: "请先连接信令服务".into(),
                });
            };
            state.connect_peer(
                identity,
                request_id,
                &numeric_id,
                expected_peer_id.as_deref(),
            )
        }
        ClientMessage::Signal { to, data } => state.signal(require_identity(identity)?, &to, data),
        ClientMessage::Ping => {
            if transport.send(ServerMessage::Pong) {
                Ok(())
            } else {
                Err(ServerMessage::error(
                    "slow_consumer",
                    "Outgoing queue is full",
                ))
            }
        }
    }
}

fn require_identity(identity: &Option<Identity>) -> Result<&Identity, ServerMessage> {
    identity.as_ref().ok_or_else(|| {
        ServerMessage::error(
            "join_required",
            "Send join before profile or signal messages",
        )
    })
}
