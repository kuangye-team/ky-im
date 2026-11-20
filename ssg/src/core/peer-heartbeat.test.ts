import { localRuntime } from "./capabilities";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatEngine } from "./engine";
import { newId } from "./protocol";
import { CONNECTION_CONFIG, TRANSFER_CONFIG } from "../config";
import type { Profile, StorageAdapter } from "./types";
import type {
  DiscoverySession,
  NetworkAdapters,
  TransportChannel,
  TransportOptions,
} from "./network";

class Channel extends EventTarget implements TransportChannel {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: TransportChannel["onopen"] = null;
  onpinganswered?: TransportChannel["onpinganswered"];
  onclose: TransportChannel["onclose"] = null;
  onerror: TransportChannel["onerror"] = null;
  onmessage: TransportChannel["onmessage"] = null;
  packets: { type: string; id: string }[] = [];
  autoProbe = false;
  consumed = vi.fn();
  send(raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    const packet = JSON.parse(raw);
    this.packets.push(packet);

  }
  probes: { resolve: (rtt: number, ageMs?: number) => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
  probeTimeoutMs?: number;
  probe(signal: AbortSignal): Promise<import("./network").PeerHealth> {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      const done = (rtt: number, ageMs = 0) => { signal.removeEventListener("abort", aborted); resolve({ roundTripMs: rtt, ageMs }); };
      signal.addEventListener("abort", aborted, { once: true });
      this.probes.push({ resolve: done, reject, signal });
      if (this.autoProbe) done(12);
    });
  }
  respond(index = this.probes.length - 1, rtt = 12, ageMs = 0) { this.probes[index].resolve(rtt, ageMs); }
  receive(packet: unknown) {
    this.onmessage?.({ data: JSON.stringify(packet), consumed: this.consumed });
  }
  open() {
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }
  close() {
    this.readyState = "closed";
    this.onclose?.(new Event("close"));
  }
}
const me: Profile = {
  id: newId(),
  name: "Me",
  bio: "",
  avatar: "🌱",
  color: "#123456",
  device: "Mac",
  clientType: "desktop", ...localRuntime(true), capabilities: localRuntime(true).capabilities.filter(c => c !== "receipts.v1"),
};
const peer = { ...me, id: newId(), name: "Windows" };
const other = { ...me, id: newId(), name: "Other" };
let engine: ChatEngine;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
});
afterEach(() => {
  engine?.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function setup(select = true, visible = [peer]) {
  const storage: StorageAdapter = {
    name: "memory",
    getProfile: async () => me,
    saveProfile: async () => {},
    getConversations: async () => [],
    saveConversation: async () => {},
    getMessages: async () => [],
    saveMessage: vi.fn(async () => {}),
    getAttachment: async () => undefined,
    saveAttachment: async () => {},
    getFiles: async () => [],
    deleteMessages: async () => {},
    deleteConversation: async () => {},
    clearHistory: async () => {},
  };
  const channels: Channel[] = [];
  const options: TransportOptions[] = [];
  const session: DiscoverySession = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(raw) {
      if (JSON.parse(raw).type === "ping") receive({ type: "pong" });
    },
    close: vi.fn(),
  };
  const receive = (packet: unknown) =>
    session.onmessage?.({ data: JSON.stringify(packet) });
  const network: NetworkAdapters = {
    discovery: {
      name: "test",
      supportsNumericIds: false,
      usesBrowserNetworkStatus: false,
      open: vi.fn(() => session),
    },
    transport: {
      name: "test",
      create: (opt) => {
        const channel = new Channel();
        channels.push(channel);
        options.push(opt);
        return {
          channel,
          start() {},
          signal: async () => {},
          close: () => channel.close(),
        };
      },
    },
  };
  engine = new ChatEngine(storage, me, [], network);
  engine.start();
  session.onopen?.(new Event("open"));
  receive({ type: "welcome", peers: visible });
  if (select) await engine.selectPeer(peer);
  return { channel: channels[0], channels, options, receive, network, storage, session };
}
it("opens for sending without a probe result and keeps probes out of business packets", async () => {
  const { channel } = await setup();
  channel.open();
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  expect(channel.probes).toHaveLength(1);
  expect(channel.packets).toEqual([]);
  channel.respond();
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.getSnapshot().messages).toEqual([]);
  expect(channel.consumed).not.toHaveBeenCalled();
});
it("keeps an unacknowledged send failed and renegotiates after the ack deadline", async () => {
  const { channel } = await setup();
  channel.open();
  await engine.sendText("no reply");
  await vi.advanceTimersByTimeAsync(TRANSFER_CONFIG.ackTimeoutMs + 1000);
  expect(engine.getSnapshot().messages[0]).toMatchObject({ status: "failed", error: expect.stringContaining("接收确认") });
  expect(channel.readyState).toBe("closed");
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
});
it("rejects invalid probe measurements as liveness", async () => {
  const { channel } = await setup();
  channel.open();
  channel.respond(0, Number.NaN);
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(channel.readyState).toBe("closed");
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connecting");
});
it("restores an open transport after a temporary disconnect without waiting for probe result", async () => {
  const { channel, options } = await setup();
  channel.open();
  options[0].onState("disconnected");
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connecting");
  options[0].onState("connected");
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  expect(await engine.sendText("transport recovered")).toBe(true);
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.disconnectGraceMs + 1000);
  expect(channel.readyState).toBe("open");
});
it("renegotiates a silent peer and retries only that peer, then recovers with a new probe result", async () => {
  const { channel, channels, network } = await setup(true, [peer, other]);
  channel.autoProbe = true;
  channel.open();
  await engine.selectPeer(other);
  const extra = channels[1];
  extra.autoProbe = true;
  extra.open();
  await engine.selectPeer(peer);
  channel.autoProbe = false;
  await vi.advanceTimersByTimeAsync(18_000);
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connecting");
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  expect(extra.readyState).toBe("open");
  await vi.advanceTimersByTimeAsync(1000);
  expect(channels).toHaveLength(3);
  channels[2].autoProbe = true;
  channels[2].open();
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  expect(network.discovery.open).toHaveBeenCalledTimes(1);
});
it("times out negotiation without waiting for the user to send a message", async () => {
  const { channels } = await setup();
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.readyTimeoutMs);
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("failed");
  await vi.advanceTimersByTimeAsync(1000);
  expect(channels).toHaveLength(2);
});
it("gives a resumed app a fresh probe and ignores a late response from the old probe", async () => {
  const { channel } = await setup();
  channel.open();
  const old = channel.probes[0];
  vi.setSystemTime(Date.now() + 120_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(channel.readyState).toBe("open");
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  expect(old.signal.aborted).toBe(true);
  old.resolve(1);
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  channel.respond();
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
});
it("completes probes even while a message is waiting for local storage", async () => {
  const { channel, storage } = await setup();
  channel.open();
  let finish!: () => void;
  vi.mocked(storage.saveMessage).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  channel.receive({
    type: "text",
    id: newId(),
    text: "private",
    createdAt: Date.now(),
  });
  await vi.advanceTimersByTimeAsync(1);
  channel.respond();
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(channel.readyState).toBe("open");
  expect(channel.consumed).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(1);
});

it("stops probing and retrying when the user goes offline", async () => {
  const { channel, channels } = await setup();
  channel.open();
  engine.setAvailability("offline");
  const count = channel.probes.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(channels).toHaveLength(1);
  expect(channel.probes).toHaveLength(count);
});
it("ignores a matching probe result received after its deadline, before the timer runs", async () => {
  const { channel } = await setup();
  channel.open();
  vi.setSystemTime(Date.now() + CONNECTION_CONFIG.peerHeartbeatTimeoutMs + 1);
  channel.respond(0);
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  await vi.advanceTimersByTimeAsync(1000);
  expect(channel.readyState).toBe("closed");
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connecting");
});
it("keeps a background contact online after the first missed cycle", async () => {
  const { channels, options, receive } = await setup(false);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  expect(channels).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.listHeartbeatIntervalMs);
  expect(options[0].peerId).toBe(peer.id);
  channels[0].open();
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(channels[0].readyState).toBe("closed");
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  receive({ type: "peer_updated", peer: { ...peer, bio: "updated" } });
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.listHeartbeatIntervalMs);
  expect(channels).toHaveLength(2);
  channels[1].open();
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  expect(engine.getSnapshot().activePeerId).toBeNull();
  expect(engine.getSnapshot().conversations).toEqual([]);
  expect(engine.getSnapshot().messages).toEqual([]);
});
it("allows an explicit send to retry an offline contact without probe result", async () => {
  const { channels, options } = await setup();
  options[0].onState("failed");
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
  const sending = engine.sendText("try anyway");
  await vi.advanceTimersByTimeAsync(1);
  expect(channels).toHaveLength(2);
  channels[1].open();
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.pollIntervalMs);
  expect(await sending).toBe(true);
  expect(channels[1].packets).toContainEqual(expect.objectContaining({ type: "text" }));
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
  channels[1].receive({ type: "ack", id: engine.getSnapshot().messages[0].id });
  await vi.advanceTimersByTimeAsync(1);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
});
it("forgets failed presence on departure and treats a new discovery as online", async () => {
  const { channel, options, receive } = await setup();
  channel.open();
  options[0].onState("failed");
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
  receive({ type: "peer_left", id: peer.id });
  expect(engine.getSnapshot().peerPresence[peer.id]).toBeUndefined();
  receive({ type: "peer_joined", peer });
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
});
it("checks a rejoining contact even if its announcement carries an older profile", async () => {
  const saved = { ...peer, name: "Current name", revision: 4 };
  const { options, receive } = await setup(false, [saved]);
  await engine.selectPeer(saved);
  options[0].onState("failed");
  receive({ type: "peer_left", id: peer.id });
  receive({ type: "peer_joined", peer: { ...peer, revision: 2 } });
  expect(engine.getSnapshot().peers).toEqual([saved]);
  expect(options).toHaveLength(2);
});
it("bounds background negotiations and checks previously untested devices before retrying failed ones", async () => {
  const peers = Array.from({ length: 10 }, (_, index) => ({
    ...peer,
    id: newId(),
    name: `peer-${index}`,
  }));
  const { channels, options } = await setup(false, peers);
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.listHeartbeatIntervalMs);
  expect(channels).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.readyTimeoutMs);
  expect(
    channels.filter((channel) => channel.readyState !== "closed"),
  ).toHaveLength(4);
  expect(options.slice(4).map((option) => option.peerId)).toEqual(
    peers.slice(4, 8).map((peer) => peer.id),
  );
});

it("slows offline retries, leaves slots for fast peers, and coalesces rejoin announcements", async () => {
  const late = { ...peer, id: newId(), name: "New arrival" };
  const { channels, options, receive } = await setup(false, [peer, other]);
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.listHeartbeatIntervalMs);
  options[0].onState("failed");
  options[1].onState("failed");
  receive({ type: "peer_updated", peer: { ...peer, name: "Renamed" } });
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.offlineHeartbeatIntervalMs - 1);
  expect(channels).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(options.map(o => o.peerId)).toEqual([peer.id, other.id, peer.id]);
  receive({ type: "peer_joined", peer: late });
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.listHeartbeatIntervalMs);
  expect(options.at(-1)?.peerId).toBe(late.id);
  receive({ type: "peer_joined", peer: other });
  receive({ type: "peer_joined", peer: other });
  await vi.advanceTimersByTimeAsync(1000);
  expect(options.map(o => o.peerId)).toEqual([peer.id, other.id, peer.id, late.id, other.id]);
  expect(engine.getSnapshot().peerPresence[other.id]).toBe("offline");
  const rejoined = channels.at(-1)!;
  rejoined.open();
  rejoined.respond();
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.getSnapshot().peerPresence[other.id]).toBe("online");
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.listHeartbeatIntervalMs);
  expect(rejoined.probes).toHaveLength(2);
});

it("promotes a rejoining offline peer ahead of its cooldown and lets focus dial immediately", async () => {
  const { channels, options, receive } = await setup(false);
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.listHeartbeatIntervalMs);
  options[0].onState("failed");
  receive({ type: "peer_joined", peer });
  await vi.advanceTimersByTimeAsync(1000);
  expect(channels).toHaveLength(2);
  options[1].onState("failed");
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.listHeartbeatIntervalMs);
  expect(channels).toHaveLength(2);
  await engine.selectPeer(peer);
  expect(channels).toHaveLength(3);
});

async function missTwoCycles() {
  const context = await setup();
  context.channel.open();
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  await vi.advanceTimersByTimeAsync(1000);
  context.channels[1].open();
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  await vi.advanceTimersByTimeAsync(2000);
  expect(context.channels).toHaveLength(3);
  context.channels[2].open();
  return context;
}

it("marks offline on the third silent cycle across rebuilt channels and keeps sending available", async () => {
  const { channels, options, receive } = await missTwoCycles();
  channels[0].respond(0);
  receive({ type: "peer_updated", peer: { ...peer, bio: "still discovered" } });
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs - 1);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  await vi.advanceTimersByTimeAsync(1);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
  await vi.advanceTimersByTimeAsync(4000);
  const rebuilt = channels[3];
  rebuilt.open();
  options[3].onState("connected");
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  expect(await engine.sendText("send despite offline status")).toBe(true);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
  rebuilt.receive({ type: "ack", id: engine.getSnapshot().messages[0].id });
  await vi.advanceTimersByTimeAsync(1);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  expect(engine.getSnapshot().messages[0].status).toBe("delivered");
});

it.each(["probe", "message", "ack"])(
  "resets consecutive misses on valid %s, while traffic is in flight",
  async (evidence) => {
    const { channels } = await missTwoCycles();
    const current = channels[2];
    if (evidence === "probe") current.respond();
    else if (evidence === "message")
      current.receive({ type: "text", id: newId(), text: "still here", createdAt: Date.now() });
    else {
      await engine.sendText("confirm delivery");
      current.receive({ type: "ack", id: engine.getSnapshot().messages[0].id });
    }
    await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatIntervalMs);
    expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
    await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
    expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
    await vi.advanceTimersByTimeAsync(1000);
    channels[3].open();
    await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
    expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
    await vi.advanceTimersByTimeAsync(2000);
    channels[4].open();
    await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
    expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
  },
);

it("counts each expired probe once while awaiting ack and restores online on delivery", async () => {
  const { channel, channels } = await setup();
  channel.open();
  await engine.sendText("waiting for acknowledgement");
  await vi.advanceTimersByTimeAsync(2 * CONNECTION_CONFIG.peerHeartbeatIntervalMs + CONNECTION_CONFIG.peerHeartbeatTimeoutMs - 1);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  await vi.advanceTimersByTimeAsync(1);
  expect(channel.probes).toHaveLength(3);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
  expect(engine.getSnapshot().messages[0].status).toBe("sent");
  expect(channels).toHaveLength(1);
  expect(channel.readyState).toBe("open");
  channel.receive({ type: "ack", id: engine.getSnapshot().messages[0].id });
  await vi.advanceTimersByTimeAsync(1);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  expect(engine.getSnapshot().messages[0].status).toBe("delivered");
});

it("resets consecutive misses on resume without counting suspended time", async () => {
  const { channels } = await missTwoCycles();
  vi.setSystemTime(Date.now() + 120_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(channels[2].readyState).toBe("open");
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
});

it("does not reset misses when discovery flaps on a retained channel", async () => {
  const { channels, receive } = await missTwoCycles();
  receive({ type: "peer_left", id: peer.id });
  receive({ type: "peer_joined", peer });
  expect(channels).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
});

it("retains healthy content after source loss, removes it on transport close, and still obeys user offline", async () => {
  const { channel, receive, session } = await setup();
  channel.autoProbe = true;
  channel.open();
  receive({ type: "discovery_updated", peers: [], removedPeerIds: [peer.id] });
  session.onclose?.(new Event("close"));
  expect(channel.readyState).toBe("open");
  expect(engine.getSnapshot().peers).toContainEqual(peer);
  expect(await engine.sendText("继续直连")).toBe(true);
  channel.receive({ type: "ack", id: engine.getSnapshot().messages.at(-1)!.id });
  await vi.advanceTimersByTimeAsync(1);
  expect(engine.getSnapshot().messages.at(-1)!.status).toBe("delivered");
  channel.close();
  expect(engine.getSnapshot().peers).toEqual([]);
  engine.setAvailability("offline");
  expect(engine.getSnapshot().availability).toBe("offline");
});

it("reconciles a lost final acknowledgment through a negotiated receipt query", async () => {
  const { channel } = await setup(true, [{ ...peer, capabilities: [...peer.capabilities, "receipts.v1"] }]);
  channel.autoProbe = true;
  channel.open();
  await engine.sendText("只保存一次");
  const id = engine.getSnapshot().messages[0].id;
  await vi.advanceTimersByTimeAsync(TRANSFER_CONFIG.ackTimeoutMs);
  expect(channel.packets).toContainEqual({ type: "receipt-query", id });
  channel.receive({ type: "receipt", id, status: "complete" });
  await vi.advanceTimersByTimeAsync(1);
  expect(engine.getSnapshot().messages[0].status).toBe("delivered");
  expect(channel.packets.filter((p) => p.type === "text")).toHaveLength(1);
});

it("retries a missing text at most once using the original message ID", async () => {
  const { channel } = await setup(true, [{ ...peer, capabilities: [...peer.capabilities, "receipts.v1"] }]);
  channel.autoProbe = true;
  channel.open();
  await engine.sendText("同一个 ID");
  const id = engine.getSnapshot().messages[0].id;
  await vi.advanceTimersByTimeAsync(TRANSFER_CONFIG.ackTimeoutMs);
  channel.receive({ type: "receipt", id, status: "unknown" });
  await vi.advanceTimersByTimeAsync(1);
  expect(channel.packets.filter((p) => p.type === "text").map((p) => p.id)).toEqual([id, id]);
  await vi.advanceTimersByTimeAsync(TRANSFER_CONFIG.ackTimeoutMs + 1);
  expect(engine.getSnapshot().messages[0].status).toBe("failed");
});

it("checks the revision at 60 seconds even while valid content keeps arriving", async () => {
  const { channel } = await setup();
  channel.autoProbe = true;
  channel.open();
  for (let n = 0; n < 12; n++) {
    await vi.advanceTimersByTimeAsync(5000);
    channel.receive({ type: "text", id: newId(), text: "还在传输", createdAt: Date.now() });
  }
  expect(channel.probes).toHaveLength(2);
});

it("defers the next idle probe after answering a peer ping, and resumes after silence", async () => {
  const { channel, receive } = await setup();
  channel.autoProbe = true;
  channel.open();
  const interval = CONNECTION_CONFIG.peerHeartbeatIntervalMs;
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(interval - 1000);
    channel.onpinganswered?.(Date.now());
  }
  await engine.selectPeer(peer);
  await vi.advanceTimersByTimeAsync(interval - 1000);
  expect(channel.probes).toHaveLength(1);
  receive({ type: "ping" }); // Signaling heartbeat has its own clock.
  channel.onpinganswered?.(Date.now() - interval); // Delayed IPC cannot refresh the timer.
  await vi.advanceTimersByTimeAsync(1000);
  expect(channel.probes).toHaveLength(2);
});

it("does not count an unanswered outbound probe as a silent cycle after replying to a peer ping", async () => {
  const { channel, channels } = await setup();
  channel.open();
  await vi.advanceTimersByTimeAsync(4000);
  channel.onpinganswered?.(Date.now());
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(channel.readyState).toBe("open");
  expect(channel.probes).toHaveLength(1);
  expect(channels).toHaveLength(1);
});

async function openTen(peers: Profile[], channels: Channel[], options: TransportOptions[]) {
  for (const p of peers.slice(0, 10)) {
    await engine.selectPeer(p);
    const channel = channels[options.findIndex(o => o.peerId === p.id)];
    channel.autoProbe = true;
    channel.open();
  }
  await vi.advanceTimersByTimeAsync(0);
}

it("dials the eleventh recipient while the first ten still await receipts and reuses the same connection", async () => {
  const peers = Array.from({length: 11}, () => ({...peer, id: newId()}));
  const {channels, options, receive} = await setup(false, peers.slice(0, 10));
  await openTen(peers, channels, options);
  for (const p of peers.slice(0, 10)) expect(await engine.sendText("pending", p.id)).toBe(true);

  const next = peers[10];
  receive({type: "peer_joined", peer: next});
  const sending = engine.sendText("eleventh", next.id);
  await vi.advanceTimersByTimeAsync(1);
  expect(options.map(o => o.peerId)).toEqual(peers.map(p => p.id));
  channels[10].autoProbe = true;
  channels[10].open();
  await vi.advanceTimersByTimeAsync(100);
  expect(await sending).toBe(true);
  expect(await engine.sendText("again", next.id)).toBe(true);
  expect(channels.filter(c => c.readyState === "open")).toHaveLength(11);

  // The eleventh session can also stay idle while the other ten still have work.
  for (const packet of channels[10].packets.filter(p => p.type === "text"))
    channels[10].receive({type: "ack", id: packet.id});
  await vi.advanceTimersByTimeAsync(9000);
  expect(channels.filter(c => c.readyState === "open")).toHaveLength(11);
  for (const c of channels.slice(0, 10)) {
    c.receive({type: "ack", id: c.packets.find(p => p.type === "text")!.id});
    await vi.advanceTimersByTimeAsync(1);
  }
  await vi.advanceTimersByTimeAsync(1000);
  expect(channels.filter(c => c.readyState === "open")).toHaveLength(10);
  expect(channels[10].readyState).toBe("closed"); // Its delivery was the least recent.
});

it("accepts incoming content at capacity and dials another peer while idle eviction is still closing", async () => {
  const peers = Array.from({length: 12}, () => ({...peer, id: newId()}));
  const {channels, options, network, receive} = await setup(false, peers.slice(0, 10));
  const create = network.transport.create;
  let finishClose: (() => void) | undefined;
  network.transport.create = opt => {
    const connection = create(opt);
    return {...connection, close: () => {
      connection.close();
      return new Promise<void>(resolve => { finishClose = resolve; });
    }};
  };
  await openTen(peers, channels, options);
  channels[0].receive({type: "text", id: newId(), text: "keep my conversation", createdAt: Date.now()});
  receive({type: "peer_joined", peer: peers[10]});
  expect(network.transport.onIncoming?.(peers[10].id)).toBe(true);
  channels[10].autoProbe = true;
  channels[10].open();
  channels[10].receive({type: "text", id: newId(), text: "incoming", createdAt: Date.now()});
  await vi.advanceTimersByTimeAsync(9000);
  expect(channels[0].readyState).toBe("open");
  expect(channels[10].readyState).toBe("open");
  expect(finishClose).toBeTypeOf("function");
  expect(channels.filter(c => c.readyState === "open")).toHaveLength(10);

  receive({type: "peer_joined", peer: peers[11]});
  const sending = engine.sendText("independent dial", peers[11].id);
  await vi.advanceTimersByTimeAsync(1);
  expect(options.at(-1)?.peerId).toBe(peers[11].id);
  channels[11].open();
  await vi.advanceTimersByTimeAsync(100);
  expect(await sending).toBe(true);
  finishClose!();
});

it("queries a discovered peer's current runtime and only accepts the matching reply", async () => {
  const { session, receive } = await setup(false);
  const send = vi.spyOn(session, "send");
  const pending = engine.queryPeerRuntime(peer.id);
  const request = JSON.parse(send.mock.calls.at(-1)![0]);
  expect(request).toMatchObject({ type: "signal", to: peer.id, data: { runtimeQuery: expect.any(String) } });
  const runtime = { version: "9.2.0", capabilities: ["chat.v1", "capabilities.query.v1"] };
  receive({ type: "signal", from: other.id, data: { runtimeReply: request.data.runtimeQuery, runtime } });
  receive({ type: "signal", from: peer.id, data: { runtimeReply: request.data.runtimeQuery, runtime } });
  await expect(pending).resolves.toEqual(runtime);
  receive({ type: "signal", from: peer.id, data: { runtimeQuery: newId() } });
  expect(JSON.parse(send.mock.calls.at(-1)![0]).data.runtime).toEqual(engine.getRuntimeInfo());
});

it("cleans up pending runtime queries on timeout and disconnection", async () => {
  await setup(false);
  const timedOut = expect(engine.queryPeerRuntime(peer.id)).rejects.toThrow("暂时没有回应");
  await vi.advanceTimersByTimeAsync(5001);
  await timedOut;
  const stopped = expect(engine.queryPeerRuntime(peer.id)).rejects.toThrow("连接已断开");
  engine.stop();
  await stopped;
});

it("shows capability help on the first selection without marking the discovered peer offline", async () => {
  const incompatible = { ...peer, capabilities: peer.capabilities.filter(c => c !== "chat.v1") };
  const { options } = await setup(false, [incompatible]);
  await engine.selectPeer(incompatible);
  expect(options).toHaveLength(0);
  expect(engine.getSnapshot().error).toBe("暂时无法连接");
  expect(engine.getSnapshot().compatibilityReasons).toEqual(["peer-update", "peer-unsupported"]);
  expect(engine.getSnapshot().peerPresence[peer.id]).not.toBe("offline");
});

it("honors a native probe budget and does not mistake waiting for the next ping for RTT", async () => {
  const { channel } = await setup();
  channel.probeTimeoutMs = 18_000;
  channel.open();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(channel.readyState).toBe("open");
  expect(channel.probes).toHaveLength(1);
  channel.respond(0, 25);
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  expect(channel.packets).toEqual([]);
});

it("cancels a pending probe on stop and ignores its eventual success", async () => {
  const { channel } = await setup();
  channel.open();
  const pending = channel.probes[0];
  engine.stop();
  expect(pending.signal.aborted).toBe(true);
  pending.resolve(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.getSnapshot().peerStates[peer.id]).not.toBe("connected");
});

it("counts a rejected probe once and preserves an in-flight message's deadline", async () => {
  const { channel } = await setup();
  channel.open();
  await engine.sendText("still waiting for the receipt");
  channel.probes[0].reject(new Error("ping failed"));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(channel.readyState).toBe("open");
  expect(channel.probes).toHaveLength(1);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  channel.receive({ type: "ack", id: engine.getSnapshot().messages[0].id });
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.getSnapshot().messages[0].status).toBe("delivered");
});

it("does not reset consecutive failures with an expired native health measurement", async () => {
  const { channels } = await missTwoCycles();
  channels[2].respond(0, 12, CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("offline");
});
