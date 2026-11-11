import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  MAX_TEXT_BYTES,
  decodeChunk,
  encodeChunk,
  isProfile,
  newId,
  parseControlPacket,
} from "./protocol";
import { MAX_TRANSFER_SIZE } from "../config";

afterEach(() => vi.unstubAllGlobals());
const id = "7458d107-39cf-48cf-82ea-2c2b6c267c91";
const file = {
  type: "file-start",
  id,
  kind: "file",
  fileName: "hello.txt",
  mimeType: "text/plain",
  size: 5,
  createdAt: 1_780_000_000_000,
};

describe("RTC wire protocol", () => {
  it("round trips the full 128 KiB network block", () => {
    expect(CHUNK_SIZE).toBe(128 * 1024);
    const bytes = Uint8Array.from({ length: CHUNK_SIZE }, (_, i) => i % 256);
    const encoded = encodeChunk(id, 1, bytes.buffer);
    expect(encoded.byteLength).toBe(128 * 1024 + 44);
    expect(decodeChunk(encoded)?.data).toEqual(bytes);
  });
  it("round trips a binary chunk with its sequence and payload", () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const encoded = encodeChunk(id, 12, bytes.buffer);
    expect(decodeChunk(encoded)).toEqual({ id, sequence: 12, data: bytes });
    expect(encoded.byteLength).toBe(bytes.byteLength + 44);
  });
  it("rejects malformed, oversized and unrelated binary frames", () => {
    expect(decodeChunk(new ArrayBuffer(43))).toBeNull();
    expect(decodeChunk(new ArrayBuffer(CHUNK_SIZE + 45))).toBeNull();
    expect(decodeChunk(new ArrayBuffer(50))).toBeNull();
    expect(() => encodeChunk("not-a-uuid", 0, new ArrayBuffer(1))).toThrow();
    expect(() => encodeChunk(id, 0, new ArrayBuffer(CHUNK_SIZE + 1))).toThrow();
  });
  it("accepts valid metadata including zero-byte and exact-limit files", () => {
    expect(parseControlPacket(JSON.stringify(file))).toEqual(file);
    expect(
      parseControlPacket(JSON.stringify({ ...file, size: 0 })),
    ).not.toBeNull();
    expect(
      parseControlPacket(JSON.stringify({ ...file, size: MAX_FILE_SIZE })),
    ).not.toBeNull();
    expect(MAX_FILE_SIZE).toBe(256 * 1024 ** 2);
    expect(
      parseControlPacket(JSON.stringify({ ...file, size: MAX_FILE_SIZE + 1 })),
    ).not.toBeNull();
  });
  it.each([
    null,
    [],
    { ...file, id: "__proto__" },
    { ...file, size: MAX_TRANSFER_SIZE + 1 },
    { type: "file-progress", id, received: -1 },
    { type: "file-progress", id, received: 1.5 },
    { ...file, size: -1 },
    { ...file, size: 1.5 },
    { ...file, fileName: "" },
    { ...file, fileName: "a".repeat(256) },
    { ...file, kind: "script" },
    { ...file, mimeType: "x".repeat(129) },
    { ...file, createdAt: -1 },
    { type: "text", id, text: " ", createdAt: 1 },
    { type: "text", id, text: "x".repeat(MAX_TEXT_BYTES + 1), createdAt: 1 },
  ])("rejects invalid input %#", (packet) => {
    expect(parseControlPacket(JSON.stringify(packet))).toBeNull();
  });
  it("rejects malformed JSON and validates acknowledgement identities", () => {
    expect(parseControlPacket("{no")).toBeNull();
    expect(parseControlPacket(JSON.stringify({ type: "ack", id }))).toEqual({
      type: "ack",
      id,
    });
    expect(
      parseControlPacket(JSON.stringify({ type: "ack", id: "untrusted" })),
    ).toBeNull();
  });
  it("generates unique IDs on HTTP LAN contexts without randomUUID", () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const first = newId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newId()).not.toBe(first);
  });
  it("validates profile limits and colors", () => {
    const profile = {
      id,
      name: "Alice",
      bio: "",
      color: "#597461",
      avatar: "🌿",
      device: "Mac",
      clientType: "web" as const,
    };
    expect(isProfile(profile)).toBe(true);
    expect(isProfile({ ...profile, clientType: "app" })).toBe(true);
    expect(isProfile({ ...profile, clientType: "unknown" })).toBe(false);
    expect(isProfile({ ...profile, clientType: undefined })).toBe(false);
    expect(isProfile({ ...profile, color: "url(javascript:alert(1))" })).toBe(
      false,
    );
    expect(isProfile({ ...profile, name: "" })).toBe(false);
    expect(isProfile({ ...profile, bio: "x".repeat(161) })).toBe(false);
  });
});
