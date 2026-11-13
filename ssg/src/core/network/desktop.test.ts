import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEngine } from "../engine";
import { IndexedDBStorageAdapter } from "../storage";
import { CHUNK_SIZE, HEADER_SIZE, newId } from "../protocol";
import type { Profile } from "../types";
import { defaultSettings } from "./settings";
import { desktopNetwork, type NativeBridge, type NativeEvent } from "./desktop";

const profile = (name: string): Profile => ({
  id: newId(),
  name,
  bio: "",
  avatar: "🌿",
  color: "#123abc",
  device: "Desktop",
  clientType: "app" as const,
});
const lanSettings = { ...defaultSettings(true), discovery: { signaling: false, mdns: true }, transport: { tcp: true, webrtc: false } };
const engines: ChatEngine[] = [];
const stores: IndexedDBStorageAdapter[] = [];

/** Simulate the IPC contract only. Actual framing, sockets, and mDNS have Rust integration tests. */
class NativeHub {
  devices = new Map<
    string,
    { sessionId: string; profile: Profile; emit: (event: NativeEvent | ArrayBuffer) => void }
  >();
  streams = new Map<string, string>();
  queues = new Map<
    string,
    { waiting: boolean; events: Extract<NativeEvent, { type: "data" }>[] }
  >();
  calls: { command: string; args: Record<string, unknown> }[] = [];
  bridge(): NativeBridge {
    let id = "";
    return {
      channel: (receive) => receive,
      invokeBinary: async (command, data, headers) => {
        expect(data).toBeInstanceOf(ArrayBuffer);
        expect(headers["x-session-id"]).toBe(this.devices.get(id)!.sessionId);
        const peerId = headers["x-peer-id"];
        const args = { peerId, connectionId: headers["x-connection-id"], kind: Number(headers["x-frame-kind"]), data };
        this.calls.push({ command, args });
        const key = `${id}:${peerId}`;
        const queue = this.queues.get(key) || { waiting: false, events: [] };
        queue.events.push({ type: "data", peerId: id, connectionId: args.connectionId, kind: args.kind, data });
        this.queues.set(key, queue);
        this.flush(id, peerId);
      },
      invoke: async (command, args) => {
        this.calls.push({ command, args });
        if (command === "lan_start") {
          const p = args.profile as Profile;
          id = p.id;
          const emit = args.onEvent as (event: NativeEvent | ArrayBuffer) => void;
          for (const other of this.devices.values()) {
            emit({ type: "peer", profile: other.profile });
            other.emit({ type: "peer", profile: p });
          }
          this.devices.set(id, {
            sessionId: String(args.sessionId),
            profile: p,
            emit,
          });
        } else if (command === "lan_stop") {
          if (this.devices.get(id)?.sessionId !== args.sessionId) return;
          this.devices.delete(id);
          for (const other of this.devices.values())
            other.emit({ type: "left", peerId: id });
        } else if (command === "lan_profile") {
          const p = args.profile as Profile;
          this.devices.get(id)!.profile = p;
          for (const [key, other] of this.devices)
            if (key !== id) other.emit({ type: "peer", profile: p });
        } else if (command === "tcp_connect") {
          const peerId = String(args.peerId);
          const key = [id, peerId].sort().join(":");
          if (this.streams.has(key)) return;
          const connectionId = newId();
          this.streams.set(key, connectionId);
          this.devices.get(id)!.emit({ type: "open", peerId, connectionId });
          this.devices
            .get(peerId)!
            .emit({ type: "open", peerId: id, connectionId });
        } else if (command === "tcp_consumed") {
          const peerId = String(args.peerId);
          const queue = this.queues.get(`${peerId}:${id}`);
          if (queue) queue.waiting = false;
          this.flush(peerId, id);
        }
      },
    };
  }
  flush(from: string, to: string) {
    const queue = this.queues.get(`${from}:${to}`);
    if (!queue || queue.waiting || !queue.events.length) return;
    queue.waiting = true;
    const event = queue.events.shift()!;
    const raw = new Uint8Array(73 + event.data.byteLength);
    raw.set(new TextEncoder().encode(event.peerId), 0);
    raw.set(new TextEncoder().encode(event.connectionId), 36);
    raw[72] = event.kind;
    raw.set(new Uint8Array(event.data), 73);
    queueMicrotask(() => this.devices.get(to)?.emit(raw.buffer));
  }
}

async function pair() {
  const hub = new NativeHub();
  const peers = [profile("A"), profile("B")];
  const result = peers.map((p) => {
    const storage = new IndexedDBStorageAdapter(`desktop-${newId()}`);
    stores.push(storage);
    const engine = new ChatEngine(storage, p, [], desktopNetwork(hub.bridge(), lanSettings));
    engines.push(engine);
    engine.start();
    return engine;
  });
  await vi.waitFor(() =>
    expect(result.every((e) => e.getSnapshot().peers.length === 1)).toBe(true),
  );
  return { a: result[0], b: result[1], hub, peers };
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { onLine: false });
  vi.stubGlobal("WebSocket", undefined);
  vi.stubGlobal("RTCPeerConnection", undefined);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(async () => {
  for (const engine of engines.splice(0)) engine.stop();
  for (const storage of stores.splice(0)) await storage.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mDNS + TCP engine integration", () => {
  it("discovers and exchanges acknowledged text without Internet, WebSocket, or WebRTC", async () => {
    const { a, b, hub, peers } = await pair();
    expect(a.networkNames).toEqual({ discovery: "mdns", transport: "tcp" });
    expect(a.supportsNumericIds).toBe(false);
    expect(hub.calls.some((call) => call.command === "tcp_connect")).toBe(
      false,
    );
    await a.selectPeer(peers[1]);
    await b.selectPeer(peers[0]);
    expect(await a.sendText("你好，客户端")).toBe(true);
    await vi.waitFor(() => {
      expect(a.getSnapshot().messages[0].status).toBe("delivered");
      expect(b.getSnapshot().messages[0].text).toBe("你好，客户端");
    });
    await b.sendText("收到");
    await vi.waitFor(() =>
      expect(a.getSnapshot().messages[1].text).toBe("收到"),
    );
    await a.updateProfile({ bio: "updated" });
    await vi.waitFor(() =>
      expect(b.getSnapshot().peers[0].bio).toBe("updated"),
    );
    expect(
      JSON.stringify(
        hub.calls.filter((call) => call.command.startsWith("lan_")),
      ),
    ).not.toContain("你好，客户端");
    window.dispatchEvent(new Event("offline"));
    expect(a.getSnapshot().status).toBe("connected");
    await expect(a.connectByNumericId("123456")).rejects.toThrow("无需蜂鸟号");
    a.setAvailability("offline");
    await vi.waitFor(() => expect(b.getSnapshot().peers).toHaveLength(0));
  });

  it("transfers binary files only after consent and keeps their exact bytes", async () => {
    const { a, b, hub, peers } = await pair();
    await a.selectPeer(peers[1]);
    await b.selectPeer(peers[0]);
    const bytes = Uint8Array.from({ length: 2 * CHUNK_SIZE + 17 }, (_, i) => i % 256);
    const sending = a.sendFiles([new File([bytes], "binary.dat")]);
    await vi.waitFor(() =>
      expect(b.getSnapshot().messages[0]?.status).toBe("awaiting-acceptance"),
    );
    expect(
      hub.calls.filter(
        (call) => call.command === "tcp_send" && call.args.kind === 2,
      ),
    ).toHaveLength(0);
    await b.acceptFile(b.getSnapshot().messages[0].id);
    await sending;
    await vi.waitFor(() =>
      expect(a.getSnapshot().messages[0]?.status).toBe("delivered"),
    );
    const attachment = await b.getAttachment(b.getSnapshot().messages[0].id);
    expect(new Uint8Array(await attachment!.arrayBuffer())).toEqual(bytes);
    expect(hub.calls.filter((call) => call.command === "tcp_send" && call.args.kind === 2)
      .map((call) => (call.args.data as ArrayBuffer).byteLength))
      .toEqual([CHUNK_SIZE + HEADER_SIZE, CHUNK_SIZE + HEADER_SIZE, 17 + HEADER_SIZE]);
  });

  it("returns receive credit only after the engine finishes persisting a frame", async () => {
    const { a, b, hub, peers } = await pair();
    await a.selectPeer(peers[1]);
    await b.selectPeer(peers[0]);
    await vi.waitFor(() => {
      expect(a.getSnapshot().peerStates[peers[1].id]).toBe("connected");
      expect(b.getSnapshot().peerStates[peers[0].id]).toBe("connected");
      expect(hub.calls.filter((call) => call.command === "tcp_consumed").length).toBeGreaterThanOrEqual(4);
    });
    hub.calls.length = 0; // Initial ping/pong frames return credit without touching storage.
    let release!: () => void;
    const saved = b.storage.saveMessage.bind(b.storage);
    const saving = vi
      .spyOn(b.storage, "saveMessage")
      .mockImplementationOnce(async (message) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await saved(message);
      });
    await a.sendText("wait for storage");
    await vi.waitFor(() => expect(saving).toHaveBeenCalled());
    expect(
      hub.calls.filter((call) => call.command === "tcp_consumed"),
    ).toHaveLength(0);
    release();
    await vi.waitFor(() =>
      expect(a.getSnapshot().messages[0]?.status).toBe("delivered"),
    );
    expect(hub.calls.some((call) => call.command === "tcp_consumed")).toBe(
      true,
    );
  });

  it("serializes native start/stop/restart and ignores events from a closed session", async () => {
    const callbacks: ((event: NativeEvent | ArrayBuffer) => void)[] = [];
    const calls: string[] = [];
    let started!: () => void;
    const bridge: NativeBridge = {
      invokeBinary: async () => { throw new Error("Unexpected TCP send"); },
      channel(receive) {
        callbacks.push(receive);
        return receive;
      },
      async invoke(command) {
        calls.push(command);
        if (command === "lan_start" && calls.length === 1)
          await new Promise<void>((resolve) => {
            started = resolve;
          });
      },
    };
    const network = desktopNetwork(bridge, lanSettings);
    const first = network.discovery.open();
    first.onopen = () =>
      first.send(
        JSON.stringify({ type: "join", profile: profile("A"), room: "test" }),
      );
    await vi.waitFor(() => expect(calls).toEqual(["lan_start"]));
    first.close();
    const second = network.discovery.open();
    const receive = vi.fn();
    second.onmessage = receive;
    second.onopen = () =>
      second.send(
        JSON.stringify({ type: "join", profile: profile("A"), room: "test" }),
      );
    started();
    await vi.waitFor(() =>
      expect(calls).toEqual(["lan_start", "lan_stop", "lan_start"]),
    );
    callbacks[0]({ type: "peer", profile: profile("stale") });
    expect(
      receive.mock.calls.map(([event]) => JSON.parse(event.data).type),
    ).toEqual(["welcome", "discovery_number"]);
    second.close();
  });
});
