import { testStorage } from "./storage/test-opfs";
import { localRuntime } from "./capabilities";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEngine } from "./engine";
import { IndexedDBStorageAdapter } from "./storage";
import { decodeChunk, newId, parseControlPacket } from "./protocol";
import type { FileDestination, Profile } from "./types";
import type { DiscoverySession, NetworkAdapters, TransportAdapter, TransportChannel, TransportOptions } from "./network/types";

vi.mock("../config", async (original) => {
  const config = await original<typeof import("../config")>();
  return { ...config, CONNECTION_CONFIG: { ...config.CONNECTION_CONFIG, pollIntervalMs: 5, peerRetryMaxMs: 10 },
    TRANSFER_CONFIG: { ...config.TRANSFER_CONFIG, resumeTimeoutMs: 1500 } };
});
class Channel extends EventTarget implements TransportChannel {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: TransportChannel["onopen"] = null;
  onclose: TransportChannel["onclose"] = null;
  onerror: TransportChannel["onerror"] = null;
  onmessage: TransportChannel["onmessage"] = null;
  async probe(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.other?.readyState !== "open") throw new Error("closed");
    return { roundTripMs: 1, ageMs: 0 };
  }
  other?: Channel;
  sent: (string | ArrayBuffer)[] = [];
  constructor(readonly maxMessageSize: number, readonly hub: Hub, readonly owner: string) { super(); }
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("closed");
    this.sent.push(data);
    if (this.hub.intercept?.(this, data)) return;
    queueMicrotask(() => { if (this.other?.readyState === "open") this.other.onmessage?.({ data }); });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed"; this.other?.close();
    this.onclose?.(new Event("close")); this.dispatchEvent(new Event("close"));
  }
}
class Hub {
  adapters = new Map<string, TransportAdapter>();
  active = new Map<string, Channel>();
  channels: Channel[] = [];
  available = true;
  intercept?: (channel: Channel, data: string | ArrayBuffer) => boolean;
  adapter(id: string): TransportAdapter {
    const adapter: TransportAdapter = { name: "test routes", create: (options: TransportOptions) => {
      const channel = new Channel(this.channels.length < 2 ? 64 * 1024 : 16 * 1024, this, id);
      this.channels.push(channel); this.active.set(id, channel);
      queueMicrotask(() => {
        options.onChannel(channel);
        if (!this.available) return;
        let other = this.active.get(options.peerId);
        if (!other || other.readyState === "closed") {
          this.adapters.get(options.peerId)?.onIncoming?.(id); other = this.active.get(options.peerId);
        }
        if (!other || other.readyState === "closed" || channel.readyState === "closed") return;
        channel.other = other; other.other = channel;
        queueMicrotask(() => {
          for (const endpoint of [channel, other!]) {
            if (endpoint.readyState !== "connecting") continue;
            endpoint.readyState = "open"; endpoint.onopen?.(new Event("open"));
          }
        });
      });
      return { start() {}, async signal() {}, close: () => channel.close() };
    } };
    this.adapters.set(id, adapter); return adapter;
  }
}
const engines: ChatEngine[] = [], stores: IndexedDBStorageAdapter[] = [];
const pending: Promise<unknown>[] = [], releases: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("navigator", { storage: testStorage, onLine: true });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release()); engines.splice(0).forEach((engine) => engine.stop());
  await Promise.allSettled(pending.splice(0));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await Promise.all(stores.splice(0).map((store) => store.close())); vi.unstubAllGlobals();
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; }); releases.push(release);
  return { promise, release };
}
async function setup() {
  const hub = new Hub();
  const profiles: Profile[] = [0, 1].map((n) => ({ id: newId(), name: `peer-${n}`, bio: "", avatar: "🌿", color: "#597461", device: "Linux", clientType: "web", ...localRuntime(true) }));
  const transports = new Map<string, TransportAdapter>();
  for (const profile of profiles) {
    transports.set(profile.id, hub.adapter(profile.id));
  }
  const pair = profiles.map((profile, index) => {
    const peer = profiles[1 - index];
    const storage = new IndexedDBStorageAdapter(`resume-${newId()}`); stores.push(storage);
    const network: NetworkAdapters = { runtime: localRuntime(true), transport: transports.get(profile.id)!, discovery: {
      name: "test", supportsNumericIds: false, usesBrowserNetworkStatus: false, open() {
        const session: DiscoverySession = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
          send(raw) { if (JSON.parse(raw).type === "join") queueMicrotask(() => session.onmessage?.({ data: JSON.stringify({ type: "welcome", peers: [peer] }) })); }, close() {} };
        queueMicrotask(() => session.onopen?.(new Event("open"))); return session;
      } } };
    const engine = new ChatEngine(storage, profile, [{ peer, updatedAt: 0, unread: 0, autoAcceptFiles: true }], network);
    engines.push(engine); return { engine, storage, profile };
  });
  pair.forEach(({ engine }) => engine.start());
  await vi.waitFor(() => expect(pair[0].engine.getSnapshot().peers).toHaveLength(1));
  await pair[0].engine.selectPeer(profiles[1]); await pair[1].engine.selectPeer(profiles[0]);
  await vi.waitFor(() => expect([...hub.active.values()].every((c) => c.readyState === "open")).toBe(true));
  return { hub, a: pair[0], b: pair[1] };
}
function managed(storage: IndexedDBStorageAdapter, firstWrite?: Promise<void>) {
  const chunks: Blob[] = [];
  const abort = vi.fn(async () => {}), close = vi.fn();
  const write = vi.fn(async (blob: Blob) => { if (!chunks.length) await firstWrite; chunks.push(blob); });
  Object.assign(storage, { createFileDestination: async (message: { id: string }) => ({
    write, abort, close: async () => { close(); await storage.saveAttachment(message.id, new Blob(chunks)); },
  } satisfies FileDestination) });
  return { chunks, write, abort, close };
}
const payload = () => Uint8Array.from({ length: 2 * 1024 * 1024 + 113 }, (_, i) => (i * 17 + (i >> 10)) % 251);
function send(engine: ChatEngine, bytes = payload()) {
  const promise = engine.sendFiles([new File([bytes], "resume.bin")]); pending.push(promise.catch(() => undefined)); return promise;
}
const controls = (channel: Channel, type: string) => channel.sent.filter((raw): raw is string => typeof raw === "string")
  .map((raw) => JSON.parse(raw)).filter((p) => p.type === type);

describe("folder checkpoints in the open page", () => {
  it.each(["entry-ready", "payload", "entry-saved", "final-ack"])("recovers a lost %s without duplicate entries or bytes", async (cut) => {
    const { hub, a, b } = await setup();
    const bytes = payload(), listings: string[][] = [], copies: Blob[][] = [];
    for (const store of [a.storage, b.storage]) {
      const paths: string[] = [], chunks: Blob[] = [];
      listings.push(paths); copies.push(chunks);
      Object.assign(store, { createFolderDestination: async () => ({
        async createDirectory(path: string) { paths.push(path); },
        async createFile(path: string) {
          paths.push(path);
          return { async write(blob: Blob) { chunks.push(blob); }, async close() {}, async abort() {} };
        },
        async close() {}, async abort() {},
      }) });
    }
    let dropped = false, frames = 0;
    hub.intercept = (channel, raw) => {
      if (dropped) return false;
      const packet = typeof raw === "string" && JSON.parse(raw);
      const shouldCut = cut === "payload" ? raw instanceof ArrayBuffer && ++frames === 7 :
        (cut === "entry-ready" && packet.type === "folder-entry-ready" && packet.index === 2) ||
        (cut === "entry-saved" && packet.type === "folder-entry-saved" && packet.index === 1) ||
        (cut === "final-ack" && packet.type === "ack");
      if (!shouldCut) return false;
      dropped = true; channel.close(); return true;
    };
    const sending = a.engine.sendFolder(async () => ({ name: "folder", entries: [
      { kind: "directory", path: "nested" },
      { kind: "file", path: "empty", file: new File([], "empty") },
      { kind: "file", path: "nested/data", file: new File([bytes], "data") },
    ] }), () => {}, new AbortController().signal);
    pending.push(sending.catch(() => {}));
    await expect(sending).resolves.toBe(true);
    expect(dropped).toBe(true);
    const replies = hub.channels.flatMap(c => controls(c, "file-resumed"));
    if (cut === "payload") expect(replies.some(r => r.folder?.offset > 0)).toBe(true);
    if (cut === "final-ack") expect(replies.some(r => r.complete)).toBe(true);
    for (const paths of listings) expect(paths).toEqual(["nested", "empty", "nested/data"]);
    for (const chunks of copies) expect(Buffer.from(await new Blob(chunks).arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    for (const side of [a, b]) expect(side.engine.getSnapshot().messages[0].status).toBe("delivered");
  });
});

describe("receive to a selected file", () => {
  const target = () => {
    const chunks: Blob[] = [];
    return { chunks, write: vi.fn(async (blob: Blob) => { chunks.push(blob); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  };
  it("accepts directly into the selected destination without creating a managed copy", async () => {
    const { a, b } = await setup(), bytes = payload(), selected = target();
    await b.engine.updatePeerAutoAcceptFiles(a.profile.id, false);
    const create = vi.spyOn(b.storage, "createFileDestination");
    const sending = send(a.engine, bytes);
    await vi.waitFor(() => expect(b.engine.getSnapshot().messages[0]?.status).toBe("awaiting-acceptance"));
    const message = b.engine.getSnapshot().messages[0];
    await b.engine.transfers.saveFileAs(message, selected);
    await sending;
    expect(create).not.toHaveBeenCalled(); expect(selected.close).toHaveBeenCalledOnce();
    expect(Buffer.from(await new Blob(selected.chunks).arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(await b.storage.getAttachment(message.id)).toBeUndefined();
  });
  it.each([false, true])("moves a live OPFS prefix and preserves bytes on copy failure=%s", async (fail) => {
    const { a, b, hub } = await setup(), bytes = payload(), selected = target();
    const gateWrite = gate(), gateMigration = gate();
    const create = b.storage.createFileDestination.bind(b.storage);
    let writing = false;
    vi.spyOn(b.storage, "createFileDestination").mockImplementation(async message => {
      const file = await create(message);
      return { ...file, write: async blob => { writing = true; await gateWrite.promise; await file.write(blob); } };
    });
    selected.write.mockImplementationOnce(async blob => {
      await gateMigration.promise;
      if (fail) throw new Error("disk full");
      selected.chunks.push(blob);
    });
    const sending = send(a.engine, bytes);
    await vi.waitFor(() => expect(writing).toBe(true));
    const message = b.engine.getSnapshot().messages[0];
    const migration = b.engine.transfers.saveFileAs(message, selected);
    gateWrite.release();
    await vi.waitFor(() => expect(selected.write).toHaveBeenCalled());
    expect(hub.channels.flatMap(c => controls(c, "file-hold")).some(p => p.active)).toBe(true);
    let reconnect = false;
    if (!fail) hub.intercept = (channel, raw) => {
      if (reconnect || channel.owner !== a.profile.id || !(raw instanceof ArrayBuffer)) return false;
      reconnect = true;
      channel.close();
      return true;
    };
    gateMigration.release();
    if (fail) await expect(migration).rejects.toThrow("disk full");
    else await migration;
    await expect(sending).resolves.toBe(true);
    const attachment = await b.storage.getAttachment(message.id);
    if (fail) {
      expect(selected.abort).toHaveBeenCalledOnce();
      expect(Buffer.from(await attachment!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    } else {
      expect(reconnect).toBe(true);
      expect(attachment).toBeUndefined();
      expect(Buffer.from(await new Blob(selected.chunks).arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
      expect(selected.close).toHaveBeenCalledOnce();
    }
    expect(b.engine.getSnapshot().messages[0]).toMatchObject({ status: "delivered", attachmentStorage: fail ? "managed" : "external" });
  });
  it("exports the completed local attachment when the chooser returns late", async () => {
    const { a, b } = await setup(), selected = target(), bytes = payload();
    await send(a.engine, bytes);
    const message = b.engine.getSnapshot().messages[0];
    await b.engine.transfers.saveFileAs({ ...message, status: "sending" }, selected);
    expect(selected.close).toHaveBeenCalledOnce();
    expect(Buffer.from(await new Blob(selected.chunks).arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(await b.storage.getAttachment(message.id)).toBeDefined();
  });
});

describe("single-file recovery in the open page", () => {
  it("waits for the old write and resumes with smaller frames without duplicating either local copy", async () => {
    const { hub, a, b } = await setup();
    const disk = gate(), sender = managed(a.storage), receiver = managed(b.storage, disk.promise), bytes = payload();
    const sending = send(a.engine, bytes);
    await vi.waitFor(() => expect(receiver.write).toHaveBeenCalled());
    const old = hub.active.get(a.profile.id)!, staleReceive = hub.active.get(b.profile.id)!.onmessage!;
    old.close();
    await vi.waitFor(() => expect(hub.channels.some((c) => controls(c, "file-resume").length)).toBe(true));
    expect(hub.channels.flatMap((c) => controls(c, "file-resumed"))).toEqual([]);
    disk.release(); await expect(sending).resolves.toBe(true);
    const id = a.engine.getSnapshot().messages[0].id;
    expect(Buffer.from(await (await b.storage.getAttachment(id))!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(Buffer.from(await (await a.storage.getAttachment(id))!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(sender.close).toHaveBeenCalledOnce(); expect(receiver.close).toHaveBeenCalledOnce();
    expect(sender.abort).not.toHaveBeenCalled(); expect(receiver.abort).not.toHaveBeenCalled();
    const reply = hub.channels.flatMap((c) => controls(c, "file-resumed"))[0]; expect(reply.received).toBeGreaterThan(0);
    const first = hub.active.get(a.profile.id)!.sent.find((raw): raw is ArrayBuffer => raw instanceof ArrayBuffer)!;
    expect(first.byteLength).toBeLessThanOrEqual(16 * 1024); expect(decodeChunk(first)?.sequence).toBe(reply.sequence);
    staleReceive({ data: old.sent.find((raw) => raw instanceof ArrayBuffer) });
    expect(b.engine.getSnapshot().messages[0].status).toBe("delivered");
  });
  it("recovers a lost final acknowledgment without sending the completed bytes again", async () => {
    const { hub, a, b } = await setup(); let dropped = false;
    hub.intercept = (channel, raw) => {
      if (!dropped && channel.owner === b.profile.id && typeof raw === "string" && JSON.parse(raw).type === "ack") {
        dropped = true; channel.close(); return true;
      } return false;
    };
    await expect(send(a.engine)).resolves.toBe(true); expect(dropped).toBe(true);
    expect(hub.channels.flatMap((c) => controls(c, "file-resumed")).some((p) => p.complete)).toBe(true);
    expect(hub.active.get(a.profile.id)!.sent.some((raw) => raw instanceof ArrayBuffer)).toBe(false);
    expect(a.engine.getSnapshot().messages[0].status).toBe("delivered");
  });
  it("does not revive a receiver cancellation made while disconnected", async () => {
    const { hub, a, b } = await setup(); const disk = gate(), receiver = managed(b.storage, disk.promise);
    const sending = send(a.engine); await vi.waitFor(() => expect(receiver.write).toHaveBeenCalled());
    hub.available = false; hub.active.get(a.profile.id)!.close();
    const id = b.engine.getSnapshot().messages[0].id; await b.engine.cancelTransfer(id);
    disk.release(); hub.available = true;
    for (const channel of hub.active.values()) if (channel.readyState === "connecting") channel.close();
    await expect(sending).rejects.toThrow(/取消|无法继续/);
    expect(receiver.abort).toHaveBeenCalledOnce(); expect(await b.storage.getAttachment(id)).toBeUndefined();
    expect(b.engine.getSnapshot().messages[0].status).toBe("failed");
  });
  it("expires disconnected tasks and releases partial destinations", async () => {
    const { hub, a, b } = await setup(); const disk = gate(), receiver = managed(b.storage, disk.promise);
    const sending = send(a.engine); await vi.waitFor(() => expect(receiver.write).toHaveBeenCalled());
    hub.available = false; hub.active.get(a.profile.id)!.close(); disk.release();
    await expect(sending).rejects.toThrow(/超时/);
    await vi.waitFor(() => expect(receiver.abort).toHaveBeenCalledOnce());
    expect(a.engine.hasPendingTransfers()).toBe(false); expect(b.engine.hasPendingTransfers()).toBe(false);
  });
  it("handles repeated disconnects and empty files", async () => {
    const { hub, a, b } = await setup();
    let failures = 0, chunks = 0;
    hub.intercept = (channel, raw) => {
      if (channel.owner === a.profile.id && raw instanceof ArrayBuffer && ++chunks % 6 === 0 && failures < 2) {
        failures++; channel.close(); return true;
      }
      return false;
    };
    const bytes = payload(); await expect(send(a.engine, bytes)).resolves.toBe(true);
    expect(failures).toBe(2);
    const id = a.engine.getSnapshot().messages[0].id;
    expect(Buffer.from(await (await b.storage.getAttachment(id))!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    await expect(send(a.engine, new Uint8Array(0))).resolves.toBe(true);
    expect(a.engine.getSnapshot().messages.every((m) => m.status === "delivered")).toBe(true);
  });
  it.each(["cancel", "offline"])("releases a paused sender when the user chooses %s", async (action) => {
    const { hub, a, b } = await setup();
    const disk = gate(), sender = managed(a.storage), receiver = managed(b.storage, disk.promise);
    const sending = send(a.engine);
    await vi.waitFor(() => expect(receiver.write).toHaveBeenCalled());
    hub.available = false; hub.active.get(a.profile.id)!.close(); disk.release();
    const id = a.engine.getSnapshot().messages[0].id;
    if (action === "cancel") await a.engine.cancelTransfer(id);
    else a.engine.setAvailability("offline");
    await expect(sending).rejects.toThrow();
    expect(sender.abort).toHaveBeenCalledOnce();
    expect(a.engine.hasPendingTransfers()).toBe(false);
  });
  it("validates request IDs, offsets and sequence limits", () => {
    const packet = { type: "file-resumed", id: newId(), request: newId(), received: 100, sequence: 2 };
    expect(parseControlPacket(JSON.stringify(packet))).toEqual(packet);
    for (const patch of [{ request: "bad" }, { received: -1 }, { received: 1.5 }, { sequence: -1 }, { sequence: 2 ** 32 + 1 }])
      expect(parseControlPacket(JSON.stringify({ ...packet, ...patch }))).toBeNull();
  });
  it("cancels recovery even while the sender's old disk write is still pending", async () => {
    const { hub, a } = await setup();
    const disk = gate(), sender = managed(a.storage, disk.promise);
    let frames = 0;
    hub.intercept = (channel, raw) => {
      if (channel.owner === a.profile.id && raw instanceof ArrayBuffer && ++frames === 6) {
        channel.close(); return true;
      }
      return false;
    };
    const sending = send(a.engine);
    await vi.waitFor(() => expect(a.engine.isTransferRecovering(a.engine.getSnapshot().messages[0].id)).toBe(true));
    await a.engine.cancelTransfer(a.engine.getSnapshot().messages[0].id);
    await expect(sending).rejects.toThrow(/取消/);
    expect(sender.abort).toHaveBeenCalledOnce();
    disk.release();
  });
  it("treats a disk failure as terminal and stops the other end", async () => {
    const { hub, a, b } = await setup();
    const sender = managed(a.storage);
    sender.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(send(a.engine)).rejects.toThrow("disk full");
    await vi.waitFor(() => expect(b.engine.hasPendingTransfers()).toBe(false));
    expect(sender.abort).toHaveBeenCalledOnce();
    expect(hub.channels.flatMap((c) => controls(c, "file-resume"))).toHaveLength(0);
  });
});
