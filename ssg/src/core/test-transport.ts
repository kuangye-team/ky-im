import "fake-indexeddb/auto";
import { afterEach, beforeEach, vi } from "vitest";
import { CAP, localRuntime } from "./capabilities";
import { ChatEngine } from "./engine";
import { newId } from "./protocol";
import type { IndexedDBStorageAdapter } from "./storage";
import { bufferedStorage } from "./storage/test-buffered-storage";
import { testStorage } from "./storage/test-opfs";
import { testNetwork } from "./test-network";
import type { Profile } from "./types";

export class Channel extends EventTarget {
  maxMessageSize?: number;
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  sent: unknown[] = [];
  probe = async () => ({ roundTripMs: 12, ageMs: 0 });
  send(data: unknown) { this.sent.push(data); }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}
export class PeerConnection {
  static instances: PeerConnection[] = [];
  connectionState = "new";
  signalingState = "stable";
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  channel = new Channel();
  onconnectionstatechange?: () => void;
  onicecandidate?: unknown;
  ondatachannel?: unknown;
  constructor() {
    PeerConnection.instances.push(this);
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "test-offer" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "test-answer" };
  }
  async setLocalDescription(value: { type: string }) {
    this.localDescription = value;
    this.signalingState =
      value.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(value: { type: string }) {
    this.remoteDescription = value;
    this.signalingState =
      value.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }
  fail() {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}
export class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: string[] = [];
  constructor() {
    Socket.instances.push(this);
  }
  send(value: string) {
    if (JSON.parse(value).type === "capabilities") {
      this.receive({ type: "capabilities", ...localRuntime() });
      return;
    }
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(packet: unknown) {
    this.onmessage?.({ data: JSON.stringify(packet) });
  }
}

export const controls = (channel: Channel) =>
  channel.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
export const requests = (socket: Socket, type = "connect_group") =>
  socket.sent
    .map((value) => JSON.parse(value) as Record<string, unknown>)
    .filter((value) => value.type === type);

export const me: Profile = {
  id: "10000000-0000-4000-8000-000000000000",
  numericId: "123456",
  name: "本机",
  avatar: "🌿",
  color: "#597461",
  bio: "",
  device: "Mac",
  clientType: "web" as const, ...localRuntime(false), capabilities: localRuntime(false).capabilities.filter(c => c !== CAP.resume && c !== CAP.folderResume && c !== CAP.relay),
};
export const peer: Profile = {
  id: "20000000-0000-4000-8000-000000000000",
  name: "对方",
  avatar: me.avatar,
  color: me.color,
  bio: me.bio,
  device: me.device,
  clientType: me.clientType, version: me.version, capabilities: [...me.capabilities],
};

export function transportFixture({ local = me, remote = peer, persistProfile = true } = {}) {
  const engines: ChatEngine[] = [];
  const adapters: IndexedDBStorageAdapter[] = [];
  async function setup(open = true) {
    const storage = bufferedStorage(`send-transport-${newId()}`);
    adapters.push(storage);
    if (persistProfile) await storage.saveProfile(local);
    const engine = new ChatEngine(storage, local, [], testNetwork());
    engines.push(engine);
    await engine.selectPeer(remote);
    engine.start();
    const socket = Socket.instances.at(-1)!;
    socket.onopen?.();
    socket.receive({ type: "welcome", id: local.id, peers: [remote] });
    const pc = PeerConnection.instances.at(-1)!;
    await Promise.resolve();
    if (open) pc.channel.open();
    return { engine, storage, socket, pc, channel: pc.channel };
  }

  beforeEach(() => {
    PeerConnection.instances = [];
    Socket.instances = [];
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
    vi.stubGlobal("navigator", { storage: testStorage, onLine: true });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("location", { protocol: "http:", host: "192.168.1.2:5173" });
    vi.stubGlobal("RTCPeerConnection", PeerConnection);
    vi.stubGlobal("WebSocket", Socket);
  });
  afterEach(async () => {
    for (const engine of engines.splice(0)) engine.stop();
    vi.useRealTimers();
    // Finish queued IDB failure updates before closing the databases.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.all(adapters.splice(0).map((storage) => storage.close()));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  return { setup, engines, adapters };
}
