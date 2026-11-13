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
  onclose: TransportChannel["onclose"] = null;
  onerror: TransportChannel["onerror"] = null;
  onmessage: TransportChannel["onmessage"] = null;
  packets: { type: string; id: string }[] = [];
  autoPong = false;
  consumed = vi.fn();
  send(raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    const packet = JSON.parse(raw);
    this.packets.push(packet);
    if (packet.type === "peer-ping" && this.autoPong)
      this.receive({ type: "peer-pong", id: packet.id });
  }
  receive(packet: unknown) {
    this.onmessage?.({ data: JSON.stringify(packet) });
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
  clientType: "app",
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
  return { channel: channels[0], channels, options, receive, network, storage };
}
it("opens for sending without requiring pong and answers incoming probes", async () => {
  const { channel } = await setup();
  channel.open();
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  channel.receive({ type: "peer-pong", id: newId() });
  const request = { type: "peer-ping", id: newId() };
  channel.receive(request);
  expect(channel.packets.at(-1)).toEqual({ type: "peer-pong", id: request.id });
  channel.receive({ type: "peer-pong", id: channel.packets[0].id });
  expect(engine.getSnapshot().messages).toEqual([]);
  expect(channel.consumed).toHaveBeenCalledTimes(3);
});
it("sends to a legacy client without pong and only marks delivery after its ack", async () => {
  const { channel } = await setup();
  channel.open();
  expect(await engine.sendText("legacy message")).toBe(true);
  const message = engine.getSnapshot().messages[0];
  expect(channel.packets).toContainEqual(expect.objectContaining({ type: "text", id: message.id }));
  expect(message.status).toBe("sent");
  // A heartbeat deadline must not preempt the content's acknowledgement deadline.
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs + 1000);
  expect(channel.readyState).toBe("open");
  expect(engine.getSnapshot().messages[0].status).toBe("sent");
  channel.receive({ type: "ack", id: message.id });
  await vi.advanceTimersByTimeAsync(1000);
  expect(engine.getSnapshot().messages[0].status).toBe("delivered");
  expect(channel.readyState).toBe("open");
});
it("keeps legacy content flowing across multiple missing pong deadlines", async () => {
  const { channel, channels } = await setup();
  channel.open();
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(6000);
    channel.receive({ type: "text", id: newId(), text: `legacy ${i}`, createdAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(channels).toHaveLength(1);
  expect(engine.getSnapshot().messages).toHaveLength(4);
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
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
it("does not trust wrong or malformed pong replies as liveness", async () => {
  const { channel } = await setup();
  channel.open();
  channel.receive({ type: "peer-pong", id: newId() });
  channel.receive({ type: "peer-pong", id: "bad-id" });
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(channel.readyState).toBe("closed");
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connecting");
});
it("restores an open transport after a temporary disconnect without waiting for pong", async () => {
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
it("renegotiates a silent peer and retries only that peer, then recovers with a new pong", async () => {
  const { channel, channels, network } = await setup(true, [peer, other]);
  channel.autoPong = true;
  channel.open();
  await engine.selectPeer(other);
  const extra = channels[1];
  extra.autoPong = true;
  extra.open();
  await engine.selectPeer(peer);
  channel.autoPong = false;
  await vi.advanceTimersByTimeAsync(18_000);
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connecting");
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
  expect(extra.readyState).toBe("open");
  await vi.advanceTimersByTimeAsync(1000);
  expect(channels).toHaveLength(3);
  channels[2].autoPong = true;
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
  const old = channel.packets[0];
  vi.setSystemTime(Date.now() + 120_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(channel.readyState).toBe("open");
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  channel.receive({ type: "peer-pong", id: old.id });
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
  channel.receive({ type: "peer-pong", id: channel.packets.at(-1)!.id });
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
});
it("answers probes even while a message is waiting for local storage", async () => {
  const { channel, storage } = await setup();
  channel.autoPong = true;
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
  const id = newId();
  channel.receive({ type: "peer-ping", id });
  expect(channel.packets.at(-1)).toEqual({ type: "peer-pong", id });
  finish();
  await vi.advanceTimersByTimeAsync(1);
});
it("retires an old channel when the remote sends a fresh offer and ignores its late pong", async () => {
  const { channel, channels, receive } = await setup();
  channel.autoPong = true;
  channel.open();
  receive({
    type: "signal",
    from: peer.id,
    data: { description: { type: "offer", sdp: "fresh" } },
  });
  expect(channel.readyState).toBe("closed");
  expect(channels).toHaveLength(2);
  channel.receive({ type: "peer-pong", id: channel.packets[0].id });
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connecting");
  channels[1].autoPong = true;
  channels[1].open();
  expect(engine.getSnapshot().peerStates[peer.id]).toBe("connected");
});
it("stops probing and retrying when the user goes offline", async () => {
  const { channel, channels } = await setup();
  channel.open();
  engine.setAvailability("offline");
  const count = channel.packets.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(channels).toHaveLength(1);
  expect(channel.packets).toHaveLength(count);
});
it("ignores a matching pong received after its deadline, before the timer runs", async () => {
  const { channel } = await setup();
  channel.open();
  vi.setSystemTime(Date.now() + CONNECTION_CONFIG.peerHeartbeatTimeoutMs + 1);
  channel.receive({ type: "peer-pong", id: channel.packets[0].id });
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
it("allows an explicit send to retry an offline contact without pong", async () => {
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
  const third = channels[2];
  channels[0].receive({ type: "peer-pong", id: channels[0].packets[0].id });
  third.receive({ type: "peer-pong", id: newId() });
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

it.each(["pong", "ping", "message", "ack"])(
  "resets consecutive misses on valid %s, including clients without pong",
  async (evidence) => {
    const { channels } = await missTwoCycles();
    const current = channels[2];
    if (evidence === "pong")
      current.receive({ type: "peer-pong", id: current.packets[0].id });
    else if (evidence === "ping")
      current.receive({ type: "peer-ping", id: newId() });
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
  expect(channel.packets.filter((packet) => packet.type === "peer-ping")).toHaveLength(3);
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

it("forgets missed cycles when a device departs and is discovered again", async () => {
  const { channels, receive } = await missTwoCycles();
  receive({ type: "peer_left", id: peer.id });
  receive({ type: "peer_joined", peer });
  channels[3].open();
  await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.peerHeartbeatTimeoutMs);
  expect(engine.getSnapshot().peerPresence[peer.id]).toBe("online");
});
