import { describe, expect, it } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { ByteConnection } from "./bytes";
import { drain } from "./flow";
import { decodeNativeEvent } from "./native";
import { CentralBridge } from "./bridge";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

it("allows relay opens past the handshake limit once existing transports have been handed off", async () => {
  const key = await generateKeyPair("Ed25519");
  const peer = peerIdFromPrivateKey(key).toString();
  const bridge = new CentralBridge(Promise.resolve({key, id: peer}), [], false);
  const socket = {readyState: 1, send() {}, close() {}} as unknown as WebSocket;
  bridge.hook("test", true).session(socket);
  const received: ByteConnection[] = [];
  bridge.incoming.relay = raw => { received.push(raw); };
  const packet = (value: unknown) => socket.onmessage!(new MessageEvent("message", {data: JSON.stringify(value)}));
  const open = (session: number) => packet({type: "tunnel", session: String(session), from: peer, data: {kind: "open"}});
  try {
    packet({type: "peer_joined", peer: {id: peer, name: "Peer", numericId: "123456", clientType: "web", capabilities: ["client.web.v1"], relay: true}});
    for (let i = 0; i < 20; i++) {
      open(i);
      received[i].managed = true;
    }
    for (let i = 20; i <= 36; i++) open(i);
    expect(received).toHaveLength(36);
    received[20].managed = true;
    open(37);
    expect(received).toHaveLength(37);
  } finally { bridge.close(); }
});

describe("libp2p byte backpressure", () => {
  it("wakes writers only after pending bytes drain, on every buffer cycle", async () => {
    let capacity = 0, written = 0;
    const raw = new ByteConnection(multiaddr("/ip4/127.0.0.1/tcp/1"), "outbound", bytes => {
      if (!capacity) return false;
      capacity--;
      written += bytes.length;
      return true;
    }, () => {});
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(raw.send(new Uint8Array(32 * 1024))).toBe(false);
      let settled = false;
      const pending = drain(raw).then(() => { settled = true; });
      capacity = 1;
      raw.drain();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(raw.writeBufferLength).toBe(16 * 1024);
      capacity = 1;
      raw.drain();
      await pending;
      expect(raw.writeBufferLength).toBe(0);
    }
    expect(written).toBe(96 * 1024);
    raw.abort(new Error("Test complete"));
  });

  it("releases a blocked writer when the connection closes", async () => {
    const raw = new ByteConnection(multiaddr("/ip4/127.0.0.1/tcp/1"), "outbound", () => false, () => {});
    raw.send(new Uint8Array(1));
    const pending = drain(raw);
    const error = new Error("Disconnected");
    raw.abort(error);
    await expect(pending).rejects.toMatchObject({ error });
  });
});

it("decodes a native binary event without including its routing header in the file", () => {
  const header = new TextEncoder().encode(JSON.stringify({ type: "pipe_data", token: "pipe" }));
  const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 251);
  const frame = new Uint8Array(4 + header.length + bytes.length);
  new DataView(frame.buffer).setUint32(0, header.length);
  frame.set(header, 4);
  frame.set(bytes, 4 + header.length);
  const event = decodeNativeEvent(frame.buffer);
  expect(event).toMatchObject({ type: "pipe_data", token: "pipe" });
  expect(event.data).toEqual(bytes);
  expect(event.data!.buffer).toBe(frame.buffer);
  expect(() => decodeNativeEvent(frame.buffer.slice(0, 3))).toThrow();
  new DataView(frame.buffer).setUint32(0, 4097);
  expect(() => decodeNativeEvent(frame.buffer)).toThrow();
});
