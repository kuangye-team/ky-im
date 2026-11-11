//! Bounded raw IPC payloads; metadata remains JSON or small request headers.
use tauri::ipc::{InvokeBody, InvokeResponseBody, Request};

pub fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| format!("Invalid {name}"))
}

pub fn raw(body: &InvokeBody, limit: usize) -> Result<Vec<u8>, String> {
    match body {
        InvokeBody::Raw(bytes) if bytes.len() <= limit => Ok(bytes.clone()),
        _ => Err("Invalid binary payload".into()),
    }
}

pub fn network_event(event: crate::network::NetworkEvent) -> tauri::Result<InvokeResponseBody> {
    match event {
        crate::network::NetworkEvent::Data {
            peer_id,
            connection_id,
            kind,
            data,
        } => {
            // Fixed ASCII UUIDs, followed by kind and the unencoded frame bytes.
            let mut bytes = Vec::with_capacity(73 + data.len());
            bytes.extend_from_slice(peer_id.as_bytes());
            bytes.extend_from_slice(connection_id.as_bytes());
            bytes.push(kind);
            bytes.extend_from_slice(&data);
            Ok(InvokeResponseBody::Raw(bytes))
        }
        event => Ok(InvokeResponseBody::Json(serde_json::to_string(&event)?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_bytes_are_bounded_and_json_payloads_are_rejected() {
        assert_eq!(
            raw(&InvokeBody::Raw(vec![0, 255, 7]), 3).unwrap(),
            [0, 255, 7]
        );
        assert!(raw(&InvokeBody::Raw(vec![0; 4]), 3).is_err());
        assert!(raw(&InvokeBody::Json(serde_json::json!([0, 255, 7])), 3).is_err());
    }

    #[test]
    fn network_frames_keep_routing_and_binary_bytes_without_json_serialization() {
        let peer_id = uuid::Uuid::new_v4().to_string();
        let connection_id = uuid::Uuid::new_v4().to_string();
        let data: Vec<u8> = (0..crate::network::frame::MAX_BINARY)
            .map(|i| i as u8)
            .collect();
        let InvokeResponseBody::Raw(bytes) = network_event(crate::network::NetworkEvent::Data {
            peer_id: peer_id.clone(),
            connection_id: connection_id.clone(),
            kind: 2,
            data: data.clone(),
        })
        .unwrap() else {
            panic!("Expected raw IPC bytes");
        };
        assert_eq!(&bytes[..36], peer_id.as_bytes());
        assert_eq!(&bytes[36..72], connection_id.as_bytes());
        assert_eq!(bytes[72], 2);
        assert_eq!(&bytes[73..], &data);
    }
}
