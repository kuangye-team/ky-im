//! Bounded raw IPC payloads; metadata remains JSON or small request headers.
use tauri::ipc::{InvokeBody, Request};

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
}
