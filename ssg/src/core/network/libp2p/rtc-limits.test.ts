import { expect, it, vi } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { ByteConnection } from "./bytes";
import { rtcMessageSizeFromEnv } from "../../../config";
import { rtcCanSend, rtcHighWater, rtcMessageLimit, rtcSliceSize } from "./rtc-limits";
import { RtcWriter } from "./rtc-writer";

it("immediately sends lone messages and flushes grouped replies within the live limit", () => {
  const writes: number[][] = [];
  const dc = { readyState: "open", bufferedAmount: 0, send: (bytes: Uint8Array) => writes.push([...bytes]) };
  let limit = 16384;
  const writer = new RtcWriter(dc as unknown as RTCDataChannel, () => limit);
  writer.write(Uint8Array.of(0));
  expect(writes).toEqual([[0]]);
  const original = Uint8Array.of(99, 1, 2, 99);
  writer.batchReplies(() => {
    writer.write(original.subarray(1, 3));
    original.fill(0);
    writer.write(Uint8Array.of(3, 4, 5));
    limit = 3;
  });
  expect(writes).toEqual([[0], [1, 2, 3], [4, 5]]);
});

it("counts pending bytes at high water, retries without duplication and releases a failed batch", () => {
  const writes: number[] = [];
  const dc = { readyState: "open", bufferedAmount: rtcHighWater - 3, send(bytes: Uint8Array) {
    writes.push(...bytes); this.bufferedAmount += bytes.length;
  } };
  const writer = new RtcWriter(dc as unknown as RTCDataChannel, () => 65536);
  writer.batchReplies(() => {
    expect(writer.write(Uint8Array.of(1, 2))).toBe(true);
    expect(writer.write(Uint8Array.of(3, 4))).toBe(false);
  });
  dc.bufferedAmount = 0;
  expect(writer.write(Uint8Array.of(3, 4))).toBe(true);
  expect(writes).toEqual([1, 2, 3, 4]);
  dc.send = () => { throw new Error("closed"); };
  expect(() => writer.batchReplies(() => writer.write(Uint8Array.of(5)))).toThrow("closed");
  dc.send = bytes => { writes.push(...bytes); };
  writer.write(Uint8Array.of(6));
  expect(writes).toEqual([1, 2, 3, 4, 6]);
});

it.each([
  [undefined, undefined, undefined, 1048576, 262144, 262144],
  ["900000", "123456", "200003", 900000, 123456, 200003],
  ["65536", "0", "1048576", 65536, 0, 1048576],
  ["0", "4294967296", "1048577", 1048576, 262144, 262144],
] as const)("reads independent RTC send settings (%s, %s, %s)", async (high, low, chunk, ...expected) => {
  vi.stubEnv("VITE_RTC_MAX_MESSAGE_SIZE", "65536");
  vi.stubEnv("VITE_RTC_MAX_BUFFERED_AMOUNT", high);
  vi.stubEnv("VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD", low);
  vi.stubEnv("VITE_RTC_FILE_CHUNK_SIZE", chunk);
  vi.resetModules();
  try {
    const limits = await import("./rtc-limits");
    expect([limits.rtcHighWater, limits.rtcLowWater, limits.rtcFileChunkBytes]).toEqual(expected);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

it("validates an explicitly configured RTC limit and preserves the default", () => {
  expect(rtcMessageSizeFromEnv(" ")).toBe(65536);
  expect(rtcMessageSizeFromEnv("32768")).toBe(32768);
  expect(rtcMessageSizeFromEnv("65537")).toBe(65537);
  expect(rtcMessageSizeFromEnv("131072")).toBe(131072);
  for (const value of ["0", "-1", "abc", "16.5", "131073"])
    expect(() => rtcMessageSizeFromEnv(value)).toThrow("VITE_RTC_MAX_MESSAGE_SIZE");
});

it("applies each profile fallback independently and honors the SCTP limit", () => {
  expect(rtcSliceSize(undefined, 8192, Infinity)).toBe(8192);
  expect(rtcSliceSize(65536, 0, 65536)).toBe(16384);
  expect(rtcSliceSize(65536, 65536, 32768)).toBe(32768);
  expect(rtcSliceSize(131072, 262144, Infinity)).toBe(rtcMessageLimit);
});

it("resumes queued bytes at the negotiated size after a low-water notification", () => {
  let buffered = 0;
  let remote: number | undefined;
  const writes: number[] = [];
  const connection = new ByteConnection(multiaddr("/ip4/127.0.0.1/tcp/1"), "outbound", bytes => {
    if (!rtcCanSend(buffered, bytes.length, 65536)) return false;
    writes.push(bytes.length);
    buffered += bytes.length;
    return true;
  }, () => {}, () => rtcSliceSize(65536, remote, 32768));
  connection.send(new Uint8Array(16384));
  remote = 65536;
  connection.send(new Uint8Array(65536));
  expect(writes).toEqual([16384, 32768]);
  buffered = 0;
  connection.drain();
  expect(writes).toEqual([16384, 32768, 32768]);
  connection.abort(new Error("test finished"));
});
