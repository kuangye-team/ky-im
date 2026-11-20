import { expect, it } from "vitest";
import { BULK_LABEL, BulkDataChannel, bulkAttribute, usesBulkFile } from "./rtc-bulk";

import { rtcFileChunkBytes, rtcLowWater } from "./rtc-limits";
import { STORAGE_CONFIG } from "../../../config";
import { singleFileReadPlan } from "../../transfers/io";
import type { TransportChannel } from "../types";

const session = "65ec9365-2d4f-4b26-bb1e-7e230e332c95";
function endpoint(local: string, remote: string, sessionId = session, limit = 4096, high = 262144) {
  const packets: Uint8Array<ArrayBuffer>[] = [];
  const dc = {
    label: BULK_LABEL, ordered: false, maxRetransmits: null, maxPacketLifeTime: null,
    readyState: "open", bufferedAmount: 0, bufferedAmountLowThreshold: 0, close() {},
    send(packet: Uint8Array<ArrayBuffer>) { packets.push(packet.slice()); },
    onmessage: undefined as ((event: { data: ArrayBuffer }) => void) | undefined,
  };
  const cert = (byte: string) => ({ type: "certificate", fingerprintAlgorithm: "sha-256", fingerprint: Array(32).fill(byte).join(":") });
  const pc = {
    sctp: { transport: { state: "connected" } },
    getStats: async () => new Map<string, object>([
      ["transport", { type: "transport", dtlsState: "connected", localCertificateId: "L", remoteCertificateId: "R" }],
      ["L", cert(local)], ["R", cert(remote)],
    ]),
  };
  const endpoint = new BulkDataChannel(pc as unknown as RTCPeerConnection, false, () => limit, high, sessionId);
  endpoint.negotiate(bulkAttribute, true);
  return { endpoint, dc, attach: () => endpoint.attach(dc as unknown as RTCDataChannel),
    packets, deliver: (packet: Uint8Array<ArrayBuffer>) => dc.onmessage!({ data: packet.buffer }) };
}

async function boundPair(limit = 4096, high = 262144) {
  const a = endpoint("11", "22", session, limit, high), b = endpoint("22", "11", session, limit, high);
  const ackA = await a.endpoint.onBinding(await b.endpoint.hello());
  const ackB = await b.endpoint.onBinding(await a.endpoint.hello());
  expect(await a.endpoint.send(Uint8Array.of(42))).toBeUndefined();
  await a.endpoint.onBinding(ackB!);
  await b.endpoint.onBinding(ackA!);
  expect(await a.endpoint.bound()).toBe(true);
  a.attach(); b.attach();
  return [a, b] as const;
}

it("resumes a full-size packet below the configured threshold without another low event", async () => {
  const limit = 64 * 1024;
  const [sender] = await boundPair(limit, limit);
  expect(sender.dc.bufferedAmountLowThreshold).toBe(rtcLowWater);
  sender.dc.bufferedAmount = 1;
  const sending = sender.endpoint.send(new Uint8Array(limit - 16));
  expect(sender.packets).toHaveLength(0);
  sender.dc.bufferedAmount = 0;
  expect(await sending).toBeDefined();
  expect(sender.packets.map(packet => packet.length)).toEqual([limit]);
});

it("routes only sizes strictly larger than two MiB", () => {
  const threshold = 2 ** 21;
  for (const size of [0, threshold - 1, threshold, threshold + 1])
    expect(usesBulkFile(size)).toBe(size > threshold);
});

it.each([131072, 65536, 16384, 65062, 1040, 512])("balances complete records under the %i-byte message limit", async limit => {
  const [sender, receiver] = await boundPair(limit);
  const channel = { bulkFilePayloadBytes: sender.endpoint.filePayloadBytes } as TransportChannel;
  const { chunkBytes, readBytes } = singleFileReadPlan(channel, 2 ** 30);
  expect(chunkBytes).toBe(rtcFileChunkBytes);
  expect(readBytes % chunkBytes).toBe(0);
  expect(readBytes + chunkBytes).toBeGreaterThan(STORAGE_CONFIG.chunkBytes);
  const record = Uint8Array.from({ length: chunkBytes + 44 }, (_, i) => i % 251);
  const desc = (await sender.endpoint.send(record))!;
  const lengths = sender.packets.map(p => p.length);
  expect(lengths.length).toBe(Math.ceil(record.length / (limit - 16)));
  expect(Math.max(...lengths)).toBeLessThanOrEqual(limit);
  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
  for (const packet of sender.packets.reverse()) receiver.deliver(packet);
  expect(new Uint8Array(await receiver.endpoint.receive(desc))).toEqual(record);
  expect(singleFileReadPlan(channel, 2 ** 21).chunkBytes).toBe(131072);
});

it("honors the remaining sequence space when resuming", () => {
  const channel = { bulkFilePayloadBytes: 1024 } as TransportChannel;
  expect(singleFileReadPlan(channel, 2 ** 30, 2 ** 30 - 131072, 2 ** 32 - 1).chunkBytes).toBe(131072);
});

it("requires both observed certificates and the same RTC session before sending", async () => {
  for (const [local, remote, id] of [["22", "33", session], ["33", "11", session],
    ["22", "11", "another-session"], ["xx", "11", session], ["11", "11", session]]) {
    const a = endpoint("11", "22"), b = endpoint(local, remote, id);
    await a.endpoint.onBinding(new TextEncoder().encode("SNK2"));
    expect(await a.endpoint.send(Uint8Array.of(1))).toBeUndefined();
    await a.endpoint.onBinding(await b.endpoint.hello());
    expect(await a.endpoint.bound()).toBe(false);
    expect(await a.endpoint.send(Uint8Array.of(1))).toBeUndefined();
    expect(a.packets).toHaveLength(0);
  }
});

it("sends unwrapped payload via DTLS and reassembles reversed and duplicated fragments", async () => {
  const [sender, receiver] = await boundPair();
  const first = Uint8Array.from({ length: 18000 }, (_, i) => i % 251);
  const desc1 = (await sender.endpoint.send(first))!;
  expect(desc1.length).toBe(20);
  expect(sender.packets[0].subarray(16)).toEqual(first.subarray(0, 3600));
  const firstPackets = sender.packets.splice(0).reverse();
  const second = first.slice(0, 14000);
  const desc2 = (await sender.endpoint.send(second))!;
  const reading = receiver.endpoint.receive(desc1);
  for (const packet of sender.packets.reverse()) receiver.deliver(packet);
  receiver.deliver(firstPackets[0]);
  for (const packet of firstPackets) receiver.deliver(packet);
  expect(new Uint8Array(await reading)).toEqual(first);
  expect(new Uint8Array(await receiver.endpoint.receive(desc2))).toEqual(second);
  expect(receiver.endpoint.receivedBytes).toBe(first.length + second.length);
});

it("rejects a length mismatch and wakes a missing-record reader on close", async () => {
  const [sender, receiver] = await boundPair();
  const desc = (await sender.endpoint.send(Uint8Array.of(1, 2, 3)))!;
  receiver.deliver(sender.packets[0]);
  new DataView(desc.buffer).setUint32(16, 4);
  await expect(receiver.endpoint.receive(desc)).rejects.toThrow();
  const pending = receiver.endpoint.receive(desc);
  receiver.endpoint.close();
  await expect(pending).rejects.toThrow();
});
