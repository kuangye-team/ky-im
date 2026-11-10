use std::io::{Error, ErrorKind, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME: usize = 48 * 1024;
pub const MAX_BINARY: usize = 128 * 1024 + 44;
pub const HELLO: u8 = 0;
pub const TEXT: u8 = 1;
pub const BINARY: u8 = 2;
pub const SIGNAL: u8 = 3;
pub const MAX_SIGNAL: usize = 256 * 1024;

pub fn limit(kind: u8) -> usize {
    match kind {
        HELLO => 4096,
        TEXT => MAX_FRAME,
        BINARY => MAX_BINARY,
        SIGNAL => MAX_SIGNAL,
        _ => 0,
    }
}

pub fn validate(kind: u8, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > limit(kind) {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "Invalid frame size or type",
        ));
    }
    if kind != BINARY && std::str::from_utf8(bytes).is_err() {
        return Err(Error::new(ErrorKind::InvalidData, "Invalid UTF-8"));
    }
    Ok(())
}

// u32 big-endian payload length, u8 kind, then payload. TCP reads/writes may split anywhere.
pub async fn read(reader: &mut (impl AsyncRead + Unpin)) -> Result<(u8, Vec<u8>)> {
    let len = reader.read_u32().await? as usize;
    let kind = reader.read_u8().await?;
    if len == 0 || len > limit(kind) {
        return Err(Error::new(ErrorKind::InvalidData, "Invalid frame header"));
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).await?;
    validate(kind, &bytes)?;
    Ok((kind, bytes))
}

pub async fn write(writer: &mut (impl AsyncWrite + Unpin), kind: u8, bytes: &[u8]) -> Result<()> {
    validate(kind, bytes)?;
    writer.write_u32(bytes.len() as u32).await?;
    writer.write_u8(kind).await?;
    writer.write_all(bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn fragmented_and_coalesced_frames_preserve_boundaries() {
        let (mut tx, mut rx) = tokio::io::duplex(3);
        let task = tokio::spawn(async move {
            write(&mut tx, TEXT, "你好".as_bytes()).await.unwrap();
            write(&mut tx, BINARY, &[0, 1, 255, 3]).await.unwrap();
        });
        assert_eq!(
            read(&mut rx).await.unwrap(),
            (TEXT, "你好".as_bytes().to_vec())
        );
        assert_eq!(read(&mut rx).await.unwrap(), (BINARY, vec![0, 1, 255, 3]));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn full_binary_blocks_fit_even_when_larger_than_text_frames() {
        assert_eq!(MAX_BINARY, 128 * 1024 + 44);
        let bytes: Vec<u8> = (0..MAX_BINARY).map(|i| i as u8).collect();
        let (mut tx, mut rx) = tokio::io::duplex(4096);
        let expected = bytes.clone();
        let task = tokio::spawn(async move {
            write(&mut tx, BINARY, &bytes).await.unwrap();
        });
        assert_eq!(read(&mut rx).await.unwrap(), (BINARY, expected));
        task.await.unwrap();
        assert!(validate(TEXT, &vec![b'x'; MAX_FRAME + 1]).is_err());
    }
    #[tokio::test]
    async fn invalid_lengths_are_rejected_before_allocating_payloads() {
        for (kind, len) in [
            (TEXT, u32::MAX),
            (BINARY, MAX_BINARY as u32 + 1),
            (HELLO, 4097),
            (9, 1),
            (TEXT, 0),
        ] {
            let mut bytes = len.to_be_bytes().to_vec();
            bytes.push(kind);
            assert_eq!(
                read(&mut bytes.as_slice()).await.unwrap_err().kind(),
                ErrorKind::InvalidData
            );
        }
        assert!(validate(TEXT, &[255]).is_err());
        assert!(read(&mut [0, 0, 0, 2, BINARY, 1].as_slice()).await.is_err());
    }
}
