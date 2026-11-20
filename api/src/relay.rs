//! Bounded, opaque byte tunnels. Noise and Yamux run only at the endpoints.
use crate::protocol::RelayPacket;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct RelayRegistry {
    tunnels: HashMap<String, Tunnel>,
}
#[derive(Serialize, Deserialize)]
struct Tunnel {
    a: String,
    b: String,
    ag: String,
    bg: String,
    accepted: bool,
    credit: [u8; 2],
    sequence: [u32; 2],
}
impl RelayRegistry {
    pub fn remove_owner(&mut self, peer: &str) -> Vec<(String, String, String)> {
        let mut closed = Vec::new();
        self.tunnels.retain(|key, t| {
            if t.a != peer && t.b != peer {
                return true;
            }
            closed.push((
                t.a.clone(),
                t.b.clone(),
                key.rsplit(':').next().unwrap().into(),
            ));
            false
        });
        closed
    }
    pub fn route(
        &mut self,
        from: &str,
        to: &str,
        fg: &str,
        tg: &str,
        id: &str,
        packet: &RelayPacket,
    ) -> bool {
        let key = if from < to {
            format!("{from}:{to}:{id}")
        } else {
            format!("{to}:{from}:{id}")
        };
        if matches!(packet, RelayPacket::Open) {
            if self.tunnels.contains_key(&key)
                || self
                    .tunnels
                    .values()
                    .filter(|t| t.a == from || t.b == from)
                    .count()
                    >= 16
                || self
                    .tunnels
                    .values()
                    .filter(|t| t.a == to || t.b == to)
                    .count()
                    >= 16
            {
                return false;
            }
            self.tunnels.insert(
                key,
                Tunnel {
                    a: from.into(),
                    b: to.into(),
                    ag: fg.into(),
                    bg: tg.into(),
                    accepted: false,
                    credit: [8, 8],
                    sequence: [0, 0],
                },
            );
            return true;
        }
        let Some(t) = self.tunnels.get_mut(&key) else {
            return false;
        };
        let side = if t.a == from && t.ag == fg && t.b == to && t.bg == tg {
            0
        } else if t.b == from && t.bg == fg && t.a == to && t.ag == tg {
            1
        } else {
            return false;
        };
        match packet {
            RelayPacket::Accept if side == 1 && !t.accepted => {
                t.accepted = true;
                true
            }
            RelayPacket::Close => {
                self.tunnels.remove(&key);
                true
            }
            RelayPacket::Credit { count }
                if t.accepted && *count > 0 && t.credit[1 - side] + *count <= 8 =>
            {
                t.credit[1 - side] += count;
                true
            }
            RelayPacket::Bytes { sequence, .. }
                if t.accepted && t.credit[side] > 0 && t.sequence[side] == *sequence =>
            {
                t.credit[side] -= 1;
                t.sequence[side] = t.sequence[side].wrapping_add(1);
                true
            }
            _ => false,
        }
    }
}
