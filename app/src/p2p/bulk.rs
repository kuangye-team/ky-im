//! Ordered control frames shared with the WebView file DataChannel.
pub const THRESHOLD: u64 = 2 * 1024 * 1024;
pub fn descriptor(bytes: &[u8]) -> bool {
    bytes.len() == 20 && bytes.starts_with(b"SND3")
}
pub const OPEN: &[u8] = b"SNO2";
pub const OPEN_FRAME: &[u8] = b"\0\0\0\x04\x02SNO2";

const HELLO: &[u8] = b"SNB2";
const READY: &[u8] = b"SNK2";
const DISABLE: &[u8] = b"SNN2";
pub fn binding_control(bytes: &[u8]) -> bool {
    [HELLO, READY, DISABLE]
        .iter()
        .any(|tag| bytes.starts_with(tag))
}
pub fn control_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.push(2);
    frame.extend_from_slice(payload);
    frame
}
