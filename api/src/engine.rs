use crate::{
    Config,
    hub::{Hub, Identity, Peer, Transport},
    protocol::{ClientMessage, ServerMessage, valid_identifier},
};
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
}

impl AppState {
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Self {
            #[cfg(not(target_arch = "wasm32"))]
            connections: Arc::new(Semaphore::new(config.max_connections)),
            config,
            hub: Mutex::new(Hub::default()),
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
        ClientMessage::Auth { .. } => Err(ServerMessage::error(
            "unexpected_auth",
            "Already authenticated",
        )),
        ClientMessage::Relay { to, session, data } => {
            let result = require_identity(identity)
                .and_then(|owner| state.relay(owner, &to, &session, data));
            result.map_err(|error| {
                let (code, message) = match error {
                    ServerMessage::Error { code, message } => (code, message),
                    _ => ("relay_failed".into(), "Relay unavailable".into()),
                };
                ServerMessage::RelayError {
                    to,
                    session,
                    code,
                    message,
                }
            })
        }
        ClientMessage::Join {
            room,
            profile,
            recent_numeric_ids,
            proof,
        } => {
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
            if !proof.verify(&profile.id, generation) {
                return Err(ServerMessage::error(
                    "invalid_identity",
                    "Device identity could not be verified",
                ));
            }
            profile
                .validate()
                .map_err(|message| ServerMessage::error("invalid_profile", message))?;
            if !profile.supports_discovery() {
                return Err(ServerMessage::error(
                    "capability_required",
                    "Required capabilities are missing",
                ));
            }
            *identity = Some(state.join(
                format!("{room}@{}", source_ip.to_canonical()),
                Peer {
                    number_revision: 0,
                    profile,
                    generation: generation.to_owned(),
                    transport: transport.clone(),
                },
                recent_numeric_ids,
            )?);
            Ok(())
        }
        ClientMessage::Discover { recent_numeric_ids } => {
            state.discover(require_identity(identity)?, recent_numeric_ids)
        }
        ClientMessage::ChangeNumericId {
            numeric_id,
            revision,
        } => state
            .change_numeric_id(require_identity(identity)?, numeric_id, revision)
            .map_err(|error| match error {
                ServerMessage::Error { code, .. } => ServerMessage::NumericIdRejected { code },
                other => other,
            }),
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
            require_identity(identity)?;
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
