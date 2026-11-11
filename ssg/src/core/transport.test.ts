import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEngine } from "./engine";
import { IndexedDBStorageAdapter } from "./storage";
import { MAX_FILE_SIZE, decodeChunk, encodeChunk, newId } from "./protocol";
import type { Message, Profile } from "./types";
import { SIGNALING_CONFIG } from "../config";

class Channel extends EventTarget {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  sent: unknown[] = [];
  send(data: unknown) {
    this.sent.push(data);
  }
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
class PeerConnection {
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
class Socket {
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
const me: Profile = {
  id: "10000000-0000-4000-8000-000000000000",
  name: "本机",
  avatar: "🌿",
  color: "#597461",
  bio: "",
  device: "Mac",
  clientType: "web" as const,
};
const peer: Profile = {
  ...me,
  id: "20000000-0000-4000-8000-000000000000",
  name: "对方",
};
const engines: ChatEngine[] = [];
const adapters: IndexedDBStorageAdapter[] = [];
async function setup(open = true) {
  const storage = new IndexedDBStorageAdapter(`send-transport-${newId()}`);
  adapters.push(storage);
  const engine = new ChatEngine(storage, me, []);
  engines.push(engine);
  await engine.selectPeer(peer);
  engine.start();
  const socket = Socket.instances.at(-1)!;
  socket.onopen?.();
  socket.receive({ type: "welcome", id: me.id, peers: [peer] });
  const pc = PeerConnection.instances.at(-1)!;
  await Promise.resolve();
  if (open) pc.channel.open();
  return { engine, storage, socket, pc, channel: pc.channel };
}
const controls = (channel: Channel) =>
  channel.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
async function acceptOutgoing(channel: Channel) {
  await vi.waitFor(() =>
    expect(
      controls(channel).some((packet) => packet.type === "file-start"),
    ).toBe(true),
  );
  const start = controls(channel).find(
    (packet) => packet.type === "file-start",
  )!;
  channel.receive(JSON.stringify({ type: "file-accept", id: start.id }));
}
const requests = (socket: Socket, type = "connect_group") =>
  socket.sent
    .map((value) => JSON.parse(value) as Record<string, unknown>)
    .filter((value) => value.type === type);
beforeEach(() => {
  PeerConnection.instances = [];
  Socket.instances = [];
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  vi.stubGlobal("navigator", { onLine: true });
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

async function discoveryOnly(own = me, visible = [peer]) {
  const storage = new IndexedDBStorageAdapter(`send-idle-${newId()}`);
  adapters.push(storage);
  const engine = new ChatEngine(storage, own, []);
  engines.push(engine);
  engine.start();
  const socket = Socket.instances.at(-1)!;
  socket.onopen?.();
  socket.receive({ type: "welcome", id: own.id, peers: visible });
  await Promise.resolve();
  return { engine, storage, socket };
}

describe("idle signaling and reconnect costs", () => {
  it("keeps discovered devices idle until one is selected and accepts an offer from either ID", async () => {
    const extra = { ...peer, id: "30000000-0000-4000-8000-000000000000" };
    const { engine, socket } = await discoveryOnly(me, [peer, extra]);
    socket.receive({
      type: "peer_updated",
      peer: { ...peer, name: "new name" },
    });
    expect(PeerConnection.instances).toHaveLength(0);
    expect(requests(socket, "signal")).toEqual([]);
    socket.receive({
      type: "signal",
      from: peer.id,
      data: {
        description: { type: "offer", sdp: "incoming-offer" },
      },
    });
    await vi.waitFor(() => expect(requests(socket, "signal")).toHaveLength(1));
    expect(requests(socket, "signal")[0]).toMatchObject({
      data: { description: { type: "answer" } },
    });
    expect(engine.getSnapshot().activePeerId).toBeNull();
    expect(engine.getSnapshot().conversations).toEqual([]);
    expect(PeerConnection.instances).toHaveLength(1);
    await engine.selectPeer(extra);
    expect(PeerConnection.instances).toHaveLength(2);
  });

  it("starts an offer when the larger ID selects an idle peer", async () => {
    const { engine, socket } = await discoveryOnly(peer, [me]);
    await engine.selectPeer(me);
    await vi.waitFor(() => expect(requests(socket, "signal")).toHaveLength(1));
    expect(requests(socket, "signal")[0]).toMatchObject({
      to: me.id,
      data: { description: { type: "offer" } },
    });
  });

  it.each([false, true])(
    "resolves simultaneous offers without closing the peer, polite=%s",
    async (polite) => {
      const own = polite ? peer : me;
      const other = polite ? me : peer;
      const { engine, socket } = await discoveryOnly(own, [other]);
      await engine.selectPeer(other);
      await vi.waitFor(() =>
        expect(requests(socket, "signal")).toHaveLength(1),
      );
      const pc = PeerConnection.instances[0]!;
      const oldChannel = pc.channel;
      socket.receive({
        type: "signal",
        from: other.id,
        data: {
          description: { type: "offer", sdp: "colliding-offer" },
        },
      });
      if (polite) {
        await vi.waitFor(() =>
          expect(pc.localDescription).toMatchObject({ type: "answer" }),
        );
        const remoteChannel = new Channel();
        (pc.ondatachannel as (event: { channel: Channel }) => void)({
          channel: remoteChannel,
        });
        remoteChannel.open();
        expect(oldChannel.readyState).toBe("closed");
        expect(engine.getSnapshot().peerStates[other.id]).toBe("connected");
      } else {
        socket.receive({
          type: "signal",
          from: other.id,
          data: {
            description: { type: "answer", sdp: "accepted-answer" },
          },
        });
        await vi.waitFor(() =>
          expect(pc.remoteDescription).toMatchObject({ type: "answer" }),
        );
        oldChannel.open();
        expect(engine.getSnapshot().peerStates[other.id]).toBe("connected");
        expect(requests(socket, "signal")).toHaveLength(1);
      }
      expect(pc.connectionState).not.toBe("closed");
      expect(Socket.instances).toHaveLength(1);
    },
  );

  it("opens a connection on first send to an unselected device and keeps chat content off signaling", async () => {
    const { engine, socket } = await discoveryOnly();
    const sending = engine.sendText("按需发送", peer.id);
    await vi.waitFor(() => expect(PeerConnection.instances).toHaveLength(1));
    const channel = PeerConnection.instances[0]!.channel;
    channel.open();
    expect(await sending).toBe(true);
    expect(engine.getSnapshot().activePeerId).toBeNull();
    expect(controls(channel)).toContainEqual(
      expect.objectContaining({ text: "按需发送" }),
    );
    expect(JSON.stringify(socket.sent)).not.toContain("按需发送");
  });

  it("does not save or send an unchanged local profile", async () => {
    const { engine, storage, socket } = await discoveryOnly();
    const save = vi.spyOn(storage, "saveProfile");
    await engine.updateProfile({ name: ` ${me.name} `, id: peer.id });
    expect(save).not.toHaveBeenCalled();
    expect(requests(socket, "profile")).toEqual([]);
    await engine.updateProfile({ bio: "新的签名" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(requests(socket, "profile")).toHaveLength(1);
  });

  it.each([false, true])(
    "probes after a long suspension and only reconnects without a reply, pong=%s",
    async (pong) => {
      vi.useFakeTimers();
      const { socket } = await discoveryOnly();
      vi.setSystemTime(Date.now() + 300_000);
      await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.heartbeatIntervalMs);
      expect(socket.readyState).toBe(Socket.OPEN);
      expect(requests(socket, "ping")).toEqual([{ type: "ping" }]);
      await vi.advanceTimersByTimeAsync(
        SIGNALING_CONFIG.heartbeatResumeGraceMs - 1,
      );
      expect(socket.readyState).toBe(Socket.OPEN);
      if (pong) socket.receive({ type: "pong" });
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.readyState).toBe(pong ? Socket.OPEN : 3);
      expect(Socket.instances).toHaveLength(1);
    },
  );

  it("starts a foreground probe without extending it on repeated visibility events", async () => {
    vi.useFakeTimers();
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible",
    });
    vi.stubGlobal("document", document);
    const { socket } = await discoveryOnly();
    vi.setSystemTime(Date.now() + 300_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.readyState).toBe(3);
    expect(requests(socket, "ping")).toHaveLength(1);
  });

  it("still closes an unresponsive connection when timers are running normally", async () => {
    vi.useFakeTimers();
    const { socket } = await discoveryOnly();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.readyState).toBe(3);
  });

  it("backs off across short-lived welcomes, caps with jitter, and resets only after stable pongs", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let { socket } = await discoveryOnly();
    for (const ceiling of [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000, 120_000,
    ]) {
      socket.close();
      const before = Socket.instances.length;
      await vi.advanceTimersByTimeAsync(ceiling * 0.75 - 1);
      expect(Socket.instances).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(Socket.instances).toHaveLength(before + 1);
      socket = Socket.instances.at(-1)!;
      socket.onopen?.();
      socket.receive({ type: "welcome", id: me.id, peers: [] });
    }
    for (let n = 0; n < 3; n++) {
      await vi.advanceTimersByTimeAsync(20_000);
      socket.receive({ type: "pong" });
    }
    socket.close();
    const before = Socket.instances.length;
    await vi.advanceTimersByTimeAsync(749);
    expect(Socket.instances).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(Socket.instances).toHaveLength(before + 1);
  });

  it("does not replace a healthy signaling socket on duplicate online events", async () => {
    const { socket } = await discoveryOnly();
    window.dispatchEvent(new Event("online"));
    expect(Socket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(Socket.OPEN);
  });
});

describe("RTC transport lifecycle", () => {
  it("shows useful connection errors without exposing server diagnostics", async () => {
    const { engine, socket } = await setup();
    socket.receive({
      type: "error",
      code: "room_full",
      message: "The room is full",
    });
    expect(engine.getSnapshot().error).toBe("当前在线人数较多，请稍后再来");
    socket.receive({
      type: "error",
      code: "unknown_error",
      message: "Internal signaling failure",
    });
    expect(engine.getSnapshot().error).toBe("连接遇到问题，请重新连接后重试");
  });

  it("creates a local remark for an online peer without selecting them or broadcasting it", async () => {
    const { engine, storage, socket, channel } = await setup();
    await engine.deleteConversation(peer.id);
    const signals = [...socket.sent];
    const packets = [...channel.sent];

    await engine.updatePeerRemark(peer.id, "同事的电脑");

    expect(engine.getSnapshot().conversations).toHaveLength(1);
    expect(engine.getSnapshot().conversations[0]).toMatchObject({
      peer,
      remark: "同事的电脑",
      unread: 0,
    });
    expect((await storage.getConversations())[0]?.remark).toBe("同事的电脑");
    expect(engine.getSnapshot().activePeerId).toBeNull();
    expect(engine.getSnapshot().messages).toEqual([]);
    expect(engine.getSnapshot().peers).toEqual([peer]);
    expect(socket.sent).toEqual(signals);
    expect(channel.sent).toEqual(packets);
  });

  it("preserves local remarks through remote profile changes and received and sent messages", async () => {
    const { engine, storage, socket, channel } = await setup();
    await engine.updatePeerRemark(peer.id, "同事的电脑");
    const updated = { ...peer, name: "新的公开昵称", bio: "更新简介" };
    socket.receive({ type: "peer_updated", peer: updated });
    await vi.waitFor(() =>
      expect(engine.getSnapshot().conversations[0]?.peer).toEqual(updated),
    );
    expect(engine.getSnapshot().conversations[0]?.remark).toBe("同事的电脑");

    channel.receive(
      JSON.stringify({
        type: "text",
        id: newId(),
        text: "收到的消息",
        createdAt: Date.now(),
      }),
    );
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.text).toBe("收到的消息"),
    );
    expect(engine.getSnapshot().conversations[0]?.remark).toBe("同事的电脑");

    await engine.sendText("回复");
    expect(engine.getSnapshot().conversations[0]?.remark).toBe("同事的电脑");
    expect((await storage.getConversations())[0]).toMatchObject({
      peer: updated,
      remark: "同事的电脑",
    });
    expect(JSON.stringify(channel.sent)).not.toContain("同事的电脑");
    expect(JSON.stringify(socket.sent)).not.toContain("同事的电脑");
  });

  it("rejoins signaling and recreates RTC when sending after an RTC failure", async () => {
    const { engine, pc } = await setup();
    pc.fail();
    expect(engine.getSnapshot().peerStates[peer.id]).toBe("failed");
    const sending = engine.sendText("重试成功");
    const socket = Socket.instances.at(-1)!;
    expect(Socket.instances).toHaveLength(2);
    socket.onopen?.();
    socket.receive({ type: "welcome", id: me.id, peers: [peer] });
    const replacement = PeerConnection.instances.at(-1)!;
    expect(replacement).not.toBe(pc);
    replacement.channel.open();
    await sending;
    const message = engine.getSnapshot().messages[0]!;
    replacement.channel.receive(
      JSON.stringify({ type: "ack", id: message.id }),
    );
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("delivered"),
    );
  });

  it("closes a stalled handshake on timeout and exposes a retryable failure", async () => {
    const { engine, pc } = await setup(false);
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    const sending = engine.sendText("连接中");
    const result = sending.catch((error) => error as Error);
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages).toHaveLength(1),
    );
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await result).toBeInstanceOf(Error);
    expect(pc.connectionState).toBe("closed");
    expect(engine.getSnapshot().peerStates[peer.id]).toBe("failed");
    expect(engine.getSnapshot().messages[0]?.status).toBe("failed");
  });

  it("does not mark an acknowledged message failed while a history read is pending", async () => {
    const { engine, storage, channel } = await setup();
    await engine.sendText("并发确认");
    const message = engine.getSnapshot().messages[0]!;
    const originalRead = storage.getMessages.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading = false;
    vi.spyOn(storage, "getMessages").mockImplementationOnce(async (id) => {
      const snapshot = await originalRead(id);
      reading = true;
      await gate;
      return snapshot;
    });
    const save = vi.spyOn(storage, "saveMessage");
    const selecting = engine.selectPeer(peer);
    await vi.waitFor(() => expect(reading).toBe(true));
    channel.receive(JSON.stringify({ type: "ack", id: message.id }));
    await Promise.resolve();
    await Promise.resolve();
    release();
    await selecting;
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("delivered"),
    );
    expect(save.mock.calls.some(([value]) => value.status === "failed")).toBe(
      false,
    );
  });

  it("blocks updates from file preparation until acknowledgement, including other chats", async () => {
    const { engine, channel } = await setup();
    expect(engine.hasPendingTransfers()).toBe(false);
    const sending = engine.sendFiles([new File(["hello"], "hello.txt")]);
    expect(engine.hasPendingTransfers()).toBe(true);
    await acceptOutgoing(channel);
    await sending;
    const id = engine.getSnapshot().messages[0].id;
    await engine.selectPeer({ ...peer, id: newId(), name: "另一个会话" });
    expect(engine.getSnapshot().messages).toHaveLength(0);
    expect(engine.hasPendingTransfers()).toBe(true);
    channel.receive(JSON.stringify({ type: "ack", id }));
    await vi.waitFor(() => expect(engine.hasPendingTransfers()).toBe(false));
    const incomingId = newId();
    channel.receive(
      JSON.stringify({
        type: "file-start",
        id: incomingId,
        kind: "file",
        fileName: "incoming.txt",
        mimeType: "text/plain",
        size: 1,
        createdAt: Date.now(),
      }),
    );
    await vi.waitFor(() => expect(engine.hasPendingTransfers()).toBe(true));
    await engine.acceptFile(incomingId);
    channel.receive(encodeChunk(incomingId, 0, new Uint8Array([42]).buffer));
    channel.receive(JSON.stringify({ type: "file-end", id: incomingId }));
    await vi.waitFor(() => expect(engine.hasPendingTransfers()).toBe(false));
  });

  it("saves complete file bytes before acknowledging and never saves incomplete files", async () => {
    const { engine, channel } = await setup();
    await engine.updatePeerAutoAcceptFiles(peer.id, true);
    const id = newId();
    const start = {
      type: "file-start",
      id,
      kind: "file",
      fileName: "sample.bin",
      mimeType: "application/octet-stream",
      size: 3,
      createdAt: Date.now(),
    };
    channel.receive(JSON.stringify(start));
    channel.receive(encodeChunk(id, 0, new Uint8Array([4, 5, 6]).buffer));
    channel.receive(JSON.stringify({ type: "file-end", id }));
    await vi.waitFor(() =>
      expect(
        controls(channel).some(
          (packet) => packet.type === "ack" && packet.id === id,
        ),
      ).toBe(true),
    );
    expect(
      new Uint8Array(await (await engine.getAttachment(id))!.arrayBuffer()),
    ).toEqual(new Uint8Array([4, 5, 6]));
    const incomplete = newId();
    channel.receive(JSON.stringify({ ...start, id: incomplete, size: 10 }));
    channel.receive(encodeChunk(incomplete, 0, new Uint8Array([1]).buffer));
    channel.receive(JSON.stringify({ type: "file-end", id: incomplete }));
    await vi.waitFor(() =>
      expect(
        engine
          .getSnapshot()
          .messages.find((message) => message.id === incomplete)?.status,
      ).toBe("failed"),
    );
    expect(await engine.getAttachment(incomplete)).toBeUndefined();
    expect(
      controls(channel).some(
        (packet) => packet.type === "ack" && packet.id === incomplete,
      ),
    ).toBe(false);
  });

  it("rejects transfers exceeding the total 200 MiB reservation without allocating their payload", async () => {
    const { engine, channel } = await setup();
    const ids = [newId(), newId(), newId()];
    for (const id of ids)
      channel.receive(
        JSON.stringify({
          type: "file-start",
          id,
          kind: "file",
          fileName: "large.bin",
          mimeType: "",
          size: MAX_FILE_SIZE,
          createdAt: Date.now(),
        }),
      );
    await vi.waitFor(() =>
      expect(
        controls(channel).some(
          (packet) => packet.type === "transfer-error" && packet.id === ids[2],
        ),
      ).toBe(true),
    );
    expect(Object.keys(engine.getSnapshot().transfers)).toHaveLength(2);
    expect(await engine.getAttachment(ids[2]!)).toBeUndefined();
  });

  it("closes a peer flooding the asynchronous receive queue", async () => {
    const { engine, pc, channel } = await setup();
    const packet = JSON.stringify({
      type: "text",
      id: newId(),
      text: "flood",
      createdAt: Date.now(),
    });
    for (let index = 0; index < 1025; index++) channel.receive(packet);
    expect(pc.connectionState).toBe("closed");
    expect(engine.getSnapshot().peerStates[peer.id]).toBe("failed");
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages).toHaveLength(0),
    );
  });
  it("does not resurrect deleted history with the next file in a pending batch", async () => {
    const { engine, storage, channel } = await setup();
    const originalSave = storage.saveMessage.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completingFirst = false;
    vi.spyOn(storage, "saveMessage").mockImplementation(async (message) => {
      if (message.status === "sent" && !completingFirst) {
        completingFirst = true;
        await gate;
      }
      await originalSave(message);
    });
    const sending = engine.sendFiles([
      new File(["first"], "first.txt"),
      new File(["second"], "second.txt"),
    ]);
    await acceptOutgoing(channel);
    await vi.waitFor(() => expect(completingFirst).toBe(true));
    const deleting = engine.deleteConversation(peer.id);
    release();
    await Promise.all([sending, deleting]);
    expect(await storage.getMessages(peer.id)).toEqual([]);
    expect(engine.getSnapshot().conversations).toEqual([]);
    expect(
      controls(channel).filter((packet) => packet.type === "file-start"),
    ).toHaveLength(1);
  });
  it("keeps a deleted outgoing message removed when its acknowledgment arrives during deletion", async () => {
    const { engine, storage, channel, socket } = await setup();
    await engine.sendText("只删本地");
    const message = engine.getSnapshot().messages[0]!;
    const remove = storage.deleteMessages.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deleting = false;
    vi.spyOn(storage, "deleteMessages").mockImplementationOnce(async (ids) => {
      deleting = true;
      await gate;
      await remove(ids);
    });
    const signaling = [...socket.sent];
    const deletion = engine.deleteMessage(message.id);
    await vi.waitFor(() => expect(deleting).toBe(true));
    channel.receive(JSON.stringify({ type: "ack", id: message.id }));
    await Promise.resolve();
    release();
    await deletion;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await storage.getMessages(peer.id)).toEqual([]);
    expect(engine.getSnapshot().messages).toEqual([]);
    expect(engine.getSnapshot().activePeerId).toBe(peer.id);
    expect(socket.sent).toEqual(signaling);
    expect(channel.readyState).toBe("open");
    await engine.sendText("继续聊天");
    expect(engine.getSnapshot().messages[0]?.text).toBe("继续聊天");
  });
  it("retains an active outgoing transfer when deletion fails", async () => {
    const { engine, storage, channel } = await setup();
    await engine.sendText("未删除的消息");
    const message = engine.getSnapshot().messages[0]!;
    vi.spyOn(storage, "deleteMessages").mockRejectedValueOnce(
      new Error("storage failed"),
    );
    await expect(engine.deleteMessage(message.id)).rejects.toThrow(
      "storage failed",
    );
    channel.receive(JSON.stringify({ type: "ack", id: message.id }));
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("delivered"),
    );
    expect((await storage.getMessages(peer.id))[0]?.status).toBe("delivered");
  });
  it("does not send a deleted message after a pending connection opens", async () => {
    const { engine, storage, channel } = await setup(false);
    const sending = engine.sendText("连接中的消息");
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages).toHaveLength(1),
    );
    const message = engine.getSnapshot().messages[0]!;
    await engine.deleteMessage(message.id);
    channel.open();
    await sending;
    expect(
      controls(channel).filter((packet) => packet.type === "text"),
    ).toEqual([]);
    expect(await storage.getMessages(peer.id)).toEqual([]);
  });
  it("removes an incoming attachment being saved and ignores its delayed duplicate packets", async () => {
    const { engine, storage, channel } = await setup();
    await engine.updatePeerAutoAcceptFiles(peer.id, true);
    const id = newId();
    const start = {
      type: "file-start",
      id,
      kind: "file",
      fileName: "remove.bin",
      mimeType: "application/octet-stream",
      size: 3,
      createdAt: Date.now(),
    };
    channel.receive(JSON.stringify(start));
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages).toHaveLength(1),
    );
    const save = storage.saveAttachment.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    vi.spyOn(storage, "saveAttachment").mockImplementationOnce(
      async (messageId, blob) => {
        saving = true;
        await gate;
        await save(messageId, blob);
      },
    );
    channel.receive(encodeChunk(id, 0, new Uint8Array([1, 2, 3]).buffer));
    channel.receive(JSON.stringify({ type: "file-end", id }));
    await vi.waitFor(() => expect(saving).toBe(true));
    const deletion = engine.deleteMessage(id);
    release();
    await deletion;
    channel.receive(JSON.stringify(start));
    channel.receive(encodeChunk(id, 0, new Uint8Array([1, 2, 3]).buffer));
    channel.receive(JSON.stringify({ type: "file-end", id }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.getSnapshot().messages).toEqual([]);
    expect(engine.getSnapshot().transfers).toEqual({});
    expect(await storage.getMessages(peer.id)).toEqual([]);
    expect(await storage.getAttachment(id)).toBeUndefined();
  });
  it.each([false, true])(
    "discards old receive events when clearing history, handling started=%s",
    async (started) => {
      const { engine, storage, channel } = await setup();
      channel.receive(
        JSON.stringify({
          type: "text",
          id: newId(),
          text: "清理前的积压消息",
          createdAt: Date.now(),
        }),
      );
      if (started) await Promise.resolve();
      await engine.clearHistory();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await storage.getMessages(peer.id)).toEqual([]);
      expect(engine.getSnapshot().conversations).toEqual([]);
      channel.receive(
        JSON.stringify({
          type: "text",
          id: newId(),
          text: "清理后的新消息",
          createdAt: Date.now(),
        }),
      );
      await vi.waitFor(() =>
        expect(engine.getSnapshot().conversations).toHaveLength(1),
      );
      expect((await storage.getMessages(peer.id))[0]?.text).toBe(
        "清理后的新消息",
      );
    },
  );
});

describe("my availability", () => {
  it("actively goes offline, closes discovery and RTC, and keeps local history", async () => {
    const { engine, socket, pc, channel, storage } = await setup();
    const messageId = newId();
    channel.receive(
      JSON.stringify({
        type: "text",
        id: messageId,
        text: "离线后仍保留",
        createdAt: 100,
      }),
    );
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages).toHaveLength(1),
    );
    const pending = engine
      .connectByNumericId("345678")
      .catch((error) => error as Error);
    const request = requests(socket).at(-1)!;
    engine.setAvailability("offline");
    expect(await pending).toMatchObject({
      message: expect.stringContaining("连接已关闭"),
    });
    expect(socket.readyState).toBe(3);
    expect(pc.connectionState).toBe("closed");
    expect(channel.readyState).toBe("closed");
    expect(engine.getSnapshot()).toMatchObject({
      availability: "offline",
      status: "disconnected",
      peers: [],
      peerStates: {},
      activePeerId: peer.id,
    });
    expect((await storage.getMessages(peer.id))[0]?.id).toBe(messageId);
    expect(engine.getSnapshot().messages[0]?.text).toBe("离线后仍保留");
    // Closed transports cannot reintroduce peers or receive chat content.
    socket.receive({
      type: "group_resolved",
      requestId: request.requestId,
      numericId: "345678",
      peers: [{ ...peer, numericId: "345678" }],
    });
    channel.receive(
      JSON.stringify({
        type: "text",
        id: newId(),
        text: "过期消息",
        createdAt: 200,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.getSnapshot().peers).toEqual([]);
    expect(await storage.getMessages(peer.id)).toHaveLength(1);
  });

  it("does not come online through network events, start, or reconnect after opting offline", async () => {
    const { engine } = await setup();
    engine.setAvailability("offline");
    engine.stop();
    window.dispatchEvent(new Event("online"));
    engine.start();
    engine.reconnect();
    expect(Socket.instances).toHaveLength(1);
    expect(engine.getSnapshot().status).toBe("disconnected");
    await expect(engine.connectByNumericId("345678")).rejects.toThrow(
      "你已离线",
    );
    expect(Socket.instances).toHaveLength(1);

    engine.setAvailability("online");
    expect(Socket.instances).toHaveLength(2);
    expect(engine.getSnapshot()).toMatchObject({
      availability: "online",
      status: "connecting",
    });
    const socket = Socket.instances.at(-1)!;
    socket.onopen?.();
    socket.receive({ type: "welcome", id: me.id, peers: [peer] });
    expect(engine.getSnapshot().status).toBe("connected");
    expect(PeerConnection.instances).toHaveLength(2);
    expect(engine.getSnapshot().peerStates[peer.id]).toBe("connecting");
  });

  it("persists the offline choice across engine recreation and persists opting back online", async () => {
    const { engine, storage } = await setup();
    engine.setAvailability("offline");
    expect(localStorage.getItem("hummingbird.availability")).toBe("offline");
    const restored = new ChatEngine(
      storage,
      me,
      await storage.getConversations(),
    );
    engines.push(restored);
    restored.start();
    expect(restored.getSnapshot()).toMatchObject({
      availability: "offline",
      status: "disconnected",
    });
    expect(Socket.instances).toHaveLength(1);
    expect(restored.getSnapshot().conversations).toHaveLength(1);
    restored.setAvailability("online");
    expect(localStorage.getItem("hummingbird.availability")).toBe("online");
    expect(Socket.instances).toHaveLength(2);
  });

  it("closes RTC immediately on network loss while preserving intent to return online", async () => {
    const { engine, socket, pc, channel } = await setup();
    vi.stubGlobal("navigator", { onLine: false });
    window.dispatchEvent(new Event("offline"));
    expect(engine.getSnapshot()).toMatchObject({
      availability: "online",
      status: "disconnected",
      peers: [],
      peerStates: {},
    });
    expect(socket.readyState).toBe(3);
    expect(pc.connectionState).toBe("closed");
    expect(channel.readyState).toBe("closed");
    expect(localStorage.getItem("hummingbird.availability")).not.toBe(
      "offline",
    );
    vi.stubGlobal("navigator", { onLine: true });
    window.dispatchEvent(new Event("online"));
    expect(Socket.instances).toHaveLength(2);
    expect(engine.getSnapshot().status).toBe("connecting");
  });
});

describe("hummingbird group discovery", () => {
  it("refreshes group numbers while preserving identities, remarks, history and RTC channels", async () => {
    const { engine, storage, socket, channel, pc } = await setup();
    await engine.updatePeerRemark(peer.id, "本地备注");
    await engine.sendText("换号前的消息");
    const messages = engine.getSnapshot().messages;
    const refresh = engine.refreshNumericId();
    const request = requests(socket, "refresh_number").at(-1)!;
    await expect(engine.refreshNumericId()).rejects.toThrow("正在刷新");
    socket.receive({
      type: "number_updated",
      requestId: request.requestId,
      numericId: "654321",
      peerIds: [me.id, peer.id],
    });
    await refresh;
    expect(engine.getSnapshot().profile).toEqual({
      ...me,
      numericId: "654321",
    });
    expect(await storage.getProfile()).toEqual(engine.getSnapshot().profile);
    expect(engine.getSnapshot().conversations[0]).toMatchObject({
      remark: "本地备注",
      peer: { id: peer.id, numericId: "654321" },
    });
    expect((await storage.getConversations())[0]).toMatchObject({
      remark: "本地备注",
      peer: { id: peer.id, numericId: "654321" },
    });
    expect(engine.getSnapshot().messages).toEqual(messages);
    expect(PeerConnection.instances).toEqual([pc]);
    expect(channel.readyState).toBe("open");
    await engine.sendText("换号后继续聊天");
    expect(
      controls(channel)
        .filter((p) => p.type === "text")
        .map((p) => p.text),
    ).toEqual(["换号前的消息", "换号后继续聊天"]);
    // A remote group's refresh changes that contact only, not our number.
    socket.receive({
      type: "number_updated",
      numericId: "765432",
      peerIds: [peer.id],
    });
    await vi.waitFor(() =>
      expect(engine.getSnapshot().peers[0]?.numericId).toBe("765432"),
    );
    expect(engine.getSnapshot().profile.numericId).toBe("654321");
  });

  it("recovers refresh controls after rejection, malformed responses, timeout and disconnect", async () => {
    const { engine, socket } = await setup();
    let refresh = engine.refreshNumericId();
    let failed = expect(refresh).rejects.toThrow("操作过于频繁");
    socket.receive({
      type: "connect_error",
      requestId: requests(socket, "refresh_number").at(-1)!.requestId,
      code: "connect_rate_limited",
    });
    await failed;
    refresh = engine.refreshNumericId();
    failed = expect(refresh).rejects.toThrow("刷新蜂鸟号失败");
    socket.receive({
      type: "number_updated",
      requestId: requests(socket, "refresh_number").at(-1)!.requestId,
      numericId: "012345",
      peerIds: [me.id],
    });
    await failed;
    vi.useFakeTimers();
    refresh = engine.refreshNumericId();
    failed = expect(refresh).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(10_001);
    await failed;
    vi.useRealTimers();
    refresh = engine.refreshNumericId();
    failed = expect(refresh).rejects.toThrow("连接已关闭");
    engine.setAvailability("offline");
    await failed;
    await expect(engine.refreshNumericId()).rejects.toThrow("尚未连上");
    expect(requests(socket, "refresh_number")).toHaveLength(4);
  });

  it("persists the assigned number and sends it with the stable identity when rejoining", async () => {
    const { engine, storage, socket } = await setup();
    socket.receive({
      type: "welcome",
      id: me.id,
      numericId: "123456",
      peers: [peer],
    });
    await vi.waitFor(async () =>
      expect(await storage.getProfile()).toEqual({
        ...me,
        numericId: "123456",
      }),
    );
    expect(engine.getSnapshot().profile.id).toBe(me.id);

    engine.reconnect();
    const replacement = Socket.instances.at(-1)!;
    replacement.onopen?.();
    expect(JSON.parse(replacement.sent[0]!)).toMatchObject({
      type: "join",
      profile: { id: me.id, numericId: "123456" },
    });
  });

  it("rejects malformed group numbers and allows refreshing our own group", async () => {
    const { engine, socket, storage } = await setup();
    const ownProfile = { ...me, numericId: "123456" };
    const sameGroupPeer = { ...peer, numericId: "123456" };
    socket.receive({
      type: "welcome",
      id: me.id,
      numericId: "123456",
      peers: [sameGroupPeer],
    });
    await vi.waitFor(() =>
      expect(engine.getSnapshot().profile.numericId).toBe("123456"),
    );
    for (const value of ["", "12345", "1234567", "012345", "abcdef", "123 456"])
      await expect(engine.connectByNumericId(value)).rejects.toThrow(
        "6 位蜂鸟号",
      );
    expect(requests(socket)).toEqual([]);

    const connecting = engine.connectByNumericId(" 123456 ");
    const request = requests(socket).at(-1)!;
    expect(request.numericId).toBe("123456");
    socket.receive({
      type: "group_resolved",
      requestId: request.requestId,
      numericId: "123456",
      peers: [ownProfile, sameGroupPeer],
    });
    await connecting;
    expect(engine.getSnapshot().profile).toEqual(ownProfile);
    expect(await storage.getProfile()).toEqual(ownProfile);
    expect(engine.getSnapshot().peers).toEqual([sameGroupPeer]);
    expect(engine.getSnapshot().activePeerId).toBe(peer.id);
    expect(PeerConnection.instances).toHaveLength(1);
  });

  it("discovers every device in a remote group without changing our group or opening a conversation", async () => {
    const { engine, socket, storage } = await setup();
    await engine.deleteConversation(peer.id);
    socket.receive({
      type: "welcome",
      id: me.id,
      numericId: "123456",
      peers: [peer],
    });
    await vi.waitFor(() =>
      expect(engine.getSnapshot().profile.numericId).toBe("123456"),
    );
    const devices = [
      "30000000-0000-4000-8000-000000000000",
      "40000000-0000-4000-8000-000000000000",
    ].map((id) => ({ ...peer, id, numericId: "345678" }));
    const connecting = engine.connectByNumericId("345678");
    const request = requests(socket).at(-1)!;
    expect(request).toMatchObject({
      type: "connect_group",
      numericId: "345678",
    });
    socket.receive({
      type: "group_resolved",
      requestId: request.requestId,
      numericId: "345678",
      peers: devices,
    });
    await connecting;

    expect(engine.getSnapshot().peers).toEqual([peer, ...devices]);
    expect(engine.getSnapshot().profile.numericId).toBe("123456");
    expect((await storage.getProfile())?.numericId).toBe("123456");
    expect(engine.getSnapshot().activePeerId).toBeNull();
    expect(engine.getSnapshot().conversations).toEqual([]);
    expect(PeerConnection.instances).toHaveLength(1);
    for (const device of devices)
      expect(engine.getSnapshot().peerStates[device.id]).toBeUndefined();
    await engine.selectPeer(devices[0]!);
    expect(PeerConnection.instances).toHaveLength(2);
    PeerConnection.instances[1]!.channel.open();
    expect(engine.getSnapshot().peerStates[devices[0]!.id]).toBe("connected");
    expect(engine.getSnapshot().peerStates[devices[1]!.id]).toBeUndefined();
  });

  it("defers RTC allocation until selection and keeps other devices usable after allocation fails", async () => {
    const { engine, socket } = await setup();
    let failNext = true;
    vi.stubGlobal(
      "RTCPeerConnection",
      class extends PeerConnection {
        constructor() {
          if (failNext) {
            failNext = false;
            throw new Error("RTC resource limit");
          }
          super();
        }
      },
    );
    const devices = [
      "30000000-0000-4000-8000-000000000000",
      "40000000-0000-4000-8000-000000000000",
    ].map((id) => ({ ...peer, id, numericId: "345678" }));
    let resolved = false;
    const discovery = engine.connectByNumericId("345678").then(() => {
      resolved = true;
    });
    const request = requests(socket).at(-1)!;
    socket.receive({
      type: "group_resolved",
      requestId: request.requestId,
      numericId: "345678",
      peers: devices,
    });
    await vi.waitFor(() => expect(resolved).toBe(true));
    await discovery;
    expect(engine.getSnapshot().peerStates[devices[0]!.id]).toBeUndefined();
    expect(engine.getSnapshot().peerStates[devices[1]!.id]).toBeUndefined();
    expect(PeerConnection.instances).toHaveLength(1);
    await engine.selectPeer(devices[0]!);
    expect(engine.getSnapshot().peerStates[devices[0]!.id]).toBe("failed");
    await engine.selectPeer(devices[1]!);
    expect(engine.getSnapshot().peerStates[devices[1]!.id]).toBe("connecting");
    expect(engine.getSnapshot().peers).toEqual([peer, ...devices]);
    expect(PeerConnection.instances).toHaveLength(2);

    const another = {
      ...peer,
      id: "50000000-0000-4000-8000-000000000000",
      numericId: "456789",
    };
    const nextDiscovery = engine.connectByNumericId(another.numericId);
    const nextRequest = requests(socket).at(-1)!;
    expect(requests(socket)).toHaveLength(2);
    expect(nextRequest.numericId).toBe(another.numericId);
    socket.receive({
      type: "group_resolved",
      requestId: nextRequest.requestId,
      numericId: another.numericId,
      peers: [another],
    });
    await nextDiscovery;
    expect(engine.getSnapshot().peerStates[another.id]).toBeUndefined();
  });

  it("queries a group with failed peers without reconnecting the signaling socket", async () => {
    const { engine, socket, pc } = await setup();
    pc.fail();
    const retrying = engine.connectByNumericId("345678");
    const request = requests(socket).at(-1)!;
    socket.receive({
      type: "group_resolved",
      requestId: request.requestId,
      numericId: "345678",
      peers: [{ ...peer, numericId: "345678" }],
    });
    await retrying;
    expect(Socket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(Socket.OPEN);
    expect(PeerConnection.instances).toHaveLength(1);
    await engine.selectPeer({ ...peer, numericId: "345678" });
    expect(PeerConnection.instances).toHaveLength(2);
  });

  it("cancels group discovery when the user goes offline and ignores late results", async () => {
    const { engine, socket } = await setup();
    const result = engine
      .connectByNumericId("345678")
      .catch((error) => error as Error);
    const request = requests(socket).at(-1)!;
    engine.setAvailability("offline");
    expect(await result).toBeInstanceOf(Error);
    socket.receive({
      type: "group_resolved",
      requestId: request.requestId,
      numericId: "345678",
      peers: [{ ...peer, numericId: "345678" }],
    });
    window.dispatchEvent(new Event("online"));
    engine.reconnect();
    expect(Socket.instances).toHaveLength(1);
    expect(engine.getSnapshot()).toMatchObject({
      availability: "offline",
      peers: [],
    });
  });

  it.each(["wrong-number", "wrong-peer-group", "malformed-peer"])(
    "rejects an invalid group list: %s",
    async (reason) => {
      const { engine, socket } = await setup();
      const result = engine
        .connectByNumericId("345678")
        .catch((error) => error as Error);
      const request = requests(socket).at(-1)!;
      socket.receive({
        type: "group_resolved",
        requestId: request.requestId,
        numericId: reason === "wrong-number" ? "456789" : "345678",
        peers: [
          {
            ...peer,
            id: reason === "malformed-peer" ? "invalid" : peer.id,
            numericId: reason === "wrong-peer-group" ? "456789" : "345678",
          },
        ],
      });
      expect(await result).toMatchObject({
        message: expect.stringContaining("设备列表无效"),
      });
      expect(engine.getSnapshot().peers).toEqual([peer]);
      expect(PeerConnection.instances).toHaveLength(1);
    },
  );

  it("keeps the original contact and its history when lookup fails", async () => {
    const { engine, storage, socket, channel } = await setup();
    const messageId = newId();
    channel.receive(
      JSON.stringify({
        type: "text",
        id: messageId,
        text: "保留记录",
        createdAt: 100,
      }),
    );
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages).toHaveLength(1),
    );
    await engine.updatePeerRemark(peer.id, "已有联系人");
    const before = await storage.getConversations();
    const result = engine
      .connectByNumericId("999999")
      .catch((error) => error as Error);
    const request = requests(socket).at(-1)!;
    socket.receive({
      type: "connect_error",
      requestId: request.requestId,
      code: "peer_unavailable",
      message: "offline",
    });

    expect(await result).toMatchObject({
      message: expect.stringContaining("未找到在线设备"),
    });
    expect(await storage.getConversations()).toEqual(before);
    expect((await storage.getMessages(peer.id))[0]?.id).toBe(messageId);
    expect(engine.getSnapshot().activePeerId).toBe(peer.id);
    expect(engine.getSnapshot().messages[0]?.text).toBe("保留记录");
  });

  it.each(["timeout", "disconnect"])(
    "rejects a pending lookup on %s and ignores its late reply",
    async (reason) => {
      const { engine, socket } = await setup();
      vi.useFakeTimers({
        toFake: [
          "Date",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
        ],
      });
      const result = engine
        .connectByNumericId("345678")
        .catch((error) => error as Error);
      const request = requests(socket).at(-1)!;
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(10_100);
      else socket.close();
      expect(await result).toMatchObject({
        message: expect.stringContaining(
          reason === "timeout" ? "查找超时" : "已断开",
        ),
      });

      const late = {
        ...peer,
        id: "30000000-0000-4000-8000-000000000000",
        numericId: "345678",
      };
      socket.receive({
        type: "group_resolved",
        requestId: request.requestId,
        numericId: "345678",
        peers: [late],
      });
      await Promise.resolve();
      expect(engine.getSnapshot().peers.some((p) => p.id === late.id)).toBe(
        false,
      );
      expect(PeerConnection.instances).toHaveLength(1);
      expect(engine.getSnapshot().conversations).toHaveLength(1);
    },
  );

  it("keeps a single history when the same stable identity has a new number", async () => {
    const { engine, storage, socket, channel } = await setup();
    channel.receive(
      JSON.stringify({
        type: "text",
        id: newId(),
        text: "同一个人的记录",
        createdAt: 100,
      }),
    );
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages).toHaveLength(1),
    );
    await engine.updatePeerRemark(peer.id, "朋友");
    const messages = await storage.getMessages(peer.id);
    const latest = {
      ...peer,
      numericId: "345678",
      name: "新名字",
      bio: "新资料",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const connecting = engine.connectByNumericId("345678");
      const request = requests(socket).at(-1)!;
      socket.receive({
        type: "group_resolved",
        requestId: request.requestId,
        numericId: "345678",
        peers: [latest],
      });
      await connecting;
    }
    expect(engine.getSnapshot().conversations).toHaveLength(1);
    await vi.waitFor(() =>
      expect(engine.getSnapshot().conversations[0]).toMatchObject({
        peer: latest,
        remark: "朋友",
      }),
    );
    expect(engine.getSnapshot().messages).toEqual(messages);
    expect(await storage.getMessages(peer.id)).toEqual(messages);
    expect(PeerConnection.instances).toHaveLength(1);
  });

  it("keeps histories and attachments keyed by identity when discovering another device in a group", async () => {
    const { engine, storage, socket, pc } = await setup();
    const target = {
      ...peer,
      id: "30000000-0000-4000-8000-000000000000",
      name: "旧资料",
    };
    const first: Message = {
      id: newId(),
      peerId: peer.id,
      senderId: peer.id,
      kind: "file",
      fileName: "kept.txt",
      mimeType: "text/plain",
      size: 4,
      createdAt: 100,
      status: "delivered",
    };
    const second: Message = {
      id: newId(),
      peerId: target.id,
      senderId: me.id,
      kind: "text",
      text: "第二段记录",
      createdAt: 200,
      status: "delivered",
    };
    await storage.saveMessage(first);
    await storage.saveAttachment(first.id, new Blob(["kept"]));
    await engine.selectPeer(target);
    await storage.saveMessage(second);
    await engine.selectPeer(peer);
    const latest = {
      ...target,
      name: "最新名字",
      bio: "最新资料",
      numericId: "345678",
    };
    const connecting = engine.connectByNumericId("345678");
    const request = requests(socket).at(-1)!;
    socket.receive({
      type: "group_resolved",
      requestId: request.requestId,
      numericId: "345678",
      peers: [latest],
    });
    expect(PeerConnection.instances).toEqual([pc]);
    expect(await storage.getMessages(peer.id)).toEqual([first]);
    expect(engine.getSnapshot().conversations).toHaveLength(2);
    await connecting;

    expect(engine.getSnapshot().activePeerId).toBe(peer.id);
    expect(engine.getSnapshot().messages).toEqual([first]);
    await engine.selectPeer(latest);
    const newConnection = PeerConnection.instances.at(-1)!;
    expect(newConnection).not.toBe(pc);
    newConnection.channel.open();
    expect(engine.getSnapshot().activePeerId).toBe(target.id);
    expect(engine.getSnapshot().conversations).toHaveLength(2);
    expect(
      engine.getSnapshot().conversations.find((c) => c.peer.id === target.id)
        ?.peer,
    ).toEqual(latest);
    expect(
      engine.getSnapshot().conversations.find((c) => c.peer.id === peer.id)
        ?.peer,
    ).toEqual(peer);
    expect(engine.getSnapshot().messages).toEqual([second]);
    expect(await storage.getMessages(peer.id)).toEqual([first]);
    expect(await storage.getMessages(target.id)).toEqual([second]);
    expect(await (await engine.getAttachment(first.id))?.text()).toBe("kept");
    expect(pc.connectionState).not.toBe("closed");
    await engine.selectPeer(peer);
    expect(engine.getSnapshot().messages).toEqual([first]);
    expect(JSON.stringify(socket.sent)).not.toContain("第二段记录");
  });

  it.each([false, true])(
    "pins an offline contact lookup to the saved identity and protects message content, mismatch=%s",
    async (mismatch) => {
      const { engine, socket, channel } = await setup();
      const savedPeer = { ...peer, numericId: "345678" };
      socket.receive({ type: "peer_updated", peer: savedPeer });
      await vi.waitFor(() =>
        expect(engine.getSnapshot().conversations[0]?.peer.numericId).toBe(
          "345678",
        ),
      );
      socket.receive({ type: "peer_left", id: peer.id });
      const result = engine
        .sendText("只给原联系人")
        .catch((error) => error as Error);
      await vi.waitFor(() =>
        expect(requests(socket, "connect")).toHaveLength(1),
      );
      const request = requests(socket, "connect")[0]!;
      expect(request).toMatchObject({
        numericId: "345678",
        expectedPeerId: peer.id,
      });
      const resolved = mismatch
        ? { ...savedPeer, id: "30000000-0000-4000-8000-000000000000" }
        : savedPeer;
      socket.receive({
        type: "peer_resolved",
        requestId: request.requestId,
        peer: resolved,
      });
      if (mismatch) {
        expect(await result).toMatchObject({
          message: expect.stringContaining("不是原联系人"),
        });
        expect(PeerConnection.instances).toHaveLength(1);
        expect(engine.getSnapshot().messages[0]?.status).toBe("failed");
        expect(controls(channel)).toEqual([]);
      } else {
        const replacement = PeerConnection.instances.at(-1)!;
        replacement.channel.open();
        expect(await result).toBe(true);
        expect(controls(replacement.channel)).toContainEqual(
          expect.objectContaining({ type: "text", text: "只给原联系人" }),
        );
      }
      expect(engine.getSnapshot().activePeerId).toBe(peer.id);
      expect(engine.getSnapshot().conversations).toHaveLength(1);
      expect(JSON.stringify(socket.sent)).not.toContain("只给原联系人");
    },
  );
});

describe("forwarding saved messages", () => {
  const recipient: Profile = {
    ...peer,
    id: "30000000-0000-4000-8000-000000000000",
    name: "转发联系人",
  };
  async function withRecipient() {
    const context = await setup();
    context.socket.receive({ type: "peer_joined", peer: recipient });
    await context.engine.selectPeer(recipient);
    const targetChannel = PeerConnection.instances.at(-1)!.channel;
    targetChannel.open();
    await context.engine.selectPeer(peer);
    return { ...context, targetChannel };
  }
  function savedMessage(patch: Partial<Message> = {}): Message {
    return {
      id: newId(),
      peerId: peer.id,
      senderId: peer.id,
      kind: "text",
      text: "转发已保存的原文",
      createdAt: 1,
      status: "delivered",
      ...patch,
    };
  }

  it("forwards the stored text to the explicit recipient without changing the visible chat or using signaling", async () => {
    const { engine, storage, socket, channel, targetChannel } =
      await withRecipient();
    const original = savedMessage();
    await storage.saveMessage(original);
    await engine.selectPeer(peer);
    const visible = engine.getSnapshot().messages;
    const signals = [...socket.sent];

    // The local stored record, not a stale caller-provided copy, is forwarded.
    await engine.forwardMessage(
      { ...original, text: "过期内容" },
      recipient.id,
    );

    const forwarded = (await storage.getMessages(recipient.id))[0]!;
    expect(forwarded).toMatchObject({
      peerId: recipient.id,
      senderId: me.id,
      kind: "text",
      text: original.text,
      status: "sent",
    });
    expect(forwarded.id).not.toBe(original.id);
    expect(forwarded.createdAt).toBeGreaterThan(original.createdAt);
    expect(engine.getSnapshot().activePeerId).toBe(peer.id);
    expect(engine.getSnapshot().messages).toBe(visible);
    expect(await storage.getMessages(peer.id)).toEqual([original]);
    expect(controls(channel)).toEqual([]);
    expect(controls(targetChannel)).toEqual([
      {
        type: "text",
        id: forwarded.id,
        text: original.text,
        createdAt: forwarded.createdAt,
      },
    ]);
    expect(socket.sent).toEqual(signals);
    targetChannel.receive(JSON.stringify({ type: "ack", id: forwarded.id }));
    await vi.waitFor(async () =>
      expect((await storage.getMessages(recipient.id))[0]?.status).toBe(
        "delivered",
      ),
    );
  });

  it.each(["image", "file"] as const)(
    "forwards a saved %s with its original metadata and bytes while the original sender is offline",
    async (kind) => {
      const { engine, storage, socket, targetChannel } = await withRecipient();
      const contents = new Uint8Array([0, 1, 12, 128, 255]);
      // A file may intentionally carry an image MIME type; preserve its kind too.
      const original = savedMessage({
        kind,
        text: undefined,
        fileName: "原始图片.png",
        mimeType: "image/png",
        size: contents.length,
      });
      await storage.saveMessage(original);
      await storage.saveAttachment(
        original.id,
        new Blob([contents], { type: original.mimeType }),
      );
      await engine.selectPeer(peer);
      socket.receive({ type: "peer_left", id: peer.id });
      const signals = [...socket.sent];

      const forwarding = engine.forwardMessage(original, recipient.id);
      await acceptOutgoing(targetChannel);
      await forwarding;

      const forwarded = (await storage.getMessages(recipient.id))[0]!;
      expect(forwarded).toMatchObject({
        kind,
        senderId: me.id,
        fileName: original.fileName,
        mimeType: original.mimeType,
        size: contents.length,
        status: "sent",
      });
      expect(forwarded.id).not.toBe(original.id);
      const attachment = await storage.getAttachment(forwarded.id);
      expect(new Uint8Array(await attachment!.arrayBuffer())).toEqual(contents);
      expect(controls(targetChannel)).toEqual([
        {
          type: "file-start",
          id: forwarded.id,
          kind,
          fileName: original.fileName,
          mimeType: original.mimeType,
          size: contents.length,
          createdAt: forwarded.createdAt,
        },
        { type: "file-end", id: forwarded.id },
      ]);
      const packet = targetChannel.sent.find(
        (value): value is ArrayBuffer => value instanceof ArrayBuffer,
      );
      expect(packet).toBeDefined();
      expect(decodeChunk(packet!)?.data).toEqual(contents);
      expect(await storage.getMessages(peer.id)).toEqual([original]);
      expect(await storage.getAttachment(original.id)).toBeDefined();
      expect(engine.getSnapshot().activePeerId).toBe(peer.id);
      expect(socket.sent).toEqual(signals);
    },
  );

  it.each(["deleted", "missing", "incomplete", "sending"])(
    "rejects a %s attachment before sending or writing a new record",
    async (state) => {
      const { engine, storage, targetChannel } = await withRecipient();
      const original = savedMessage({
        kind: "file",
        text: undefined,
        fileName: "附件.txt",
        mimeType: "text/plain",
        size: 10,
        status: state === "sending" ? "sending" : "delivered",
      });
      if (state !== "deleted") await storage.saveMessage(original);
      if (state === "incomplete")
        await storage.saveAttachment(original.id, new Blob(["short"]));
      if (state === "sending")
        await storage.saveAttachment(original.id, new Blob(["0123456789"]));

      await expect(
        engine.forwardMessage(original, recipient.id),
      ).rejects.toThrow(/已被删除|尚未接收完成|尚未完成/);
      expect(await storage.getMessages(recipient.id)).toEqual([]);
      expect(targetChannel.sent).toEqual([]);
      expect(engine.getSnapshot().activePeerId).toBe(peer.id);
    },
  );

  it("rejects forwarding when the recipient disconnects while the copied attachment is being saved", async () => {
    const { engine, storage, socket, targetChannel } = await withRecipient();
    const original = savedMessage({
      kind: "file",
      fileName: "saved.txt",
      mimeType: "text/plain",
      size: 5,
    });
    await storage.saveMessage(original);
    await storage.saveAttachment(original.id, new Blob(["saved"]));
    const save = storage.saveAttachment.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    vi.spyOn(storage, "saveAttachment").mockImplementationOnce(
      async (id, blob) => {
        saving = true;
        await gate;
        await save(id, blob);
      },
    );
    const result = engine
      .forwardMessage(original, recipient.id)
      .catch((error) => error as Error);
    await vi.waitFor(() => expect(controls(targetChannel).some((p) => p.type === "file-start")).toBe(true));
    const offer = controls(targetChannel).find((p) => p.type === "file-start")!;
    expect(saving).toBe(false);
    targetChannel.receive(JSON.stringify({ type: "file-accept", id: offer.id }));
    await vi.waitFor(() => expect(saving).toBe(true));
    socket.receive({ type: "peer_left", id: recipient.id });
    release();

    expect(await result).toMatchObject({
      message: expect.stringMatching(/已取消|已离线|已关闭/),
    });
    await vi.waitFor(async () =>
      expect((await storage.getMessages(recipient.id))[0]?.status).toBe(
        "failed",
      ),
    );
    expect(controls(targetChannel).some((p) => p.type === "file-end")).toBe(false);
    expect(await storage.getMessages(peer.id)).toEqual([original]);
    expect(await storage.getAttachment(original.id)).toBeDefined();
  });

  it("rejects a queued forward when the recipient disconnects before its transfer starts", async () => {
    const { engine, storage, socket, targetChannel } = await withRecipient();
    const original = savedMessage({
      kind: "file",
      fileName: "queued.txt",
      mimeType: "text/plain",
      size: 6,
    });
    await storage.saveMessage(original);
    await storage.saveAttachment(original.id, new Blob(["queued"]));
    targetChannel.bufferedAmount = 1024 * 1024;
    const first = engine
      .sendFiles([new File(["first"], "first.txt")], recipient.id)
      .catch((error) => error as Error);
    await vi.waitFor(() =>
      expect(
        controls(targetChannel).filter(
          (packet) => packet.type === "file-start",
        ),
      ).toHaveLength(1),
    );
    const result = engine
      .forwardMessage(original, recipient.id)
      .catch((error) => error as Error);
    await vi.waitFor(async () => {
      const queued = (await storage.getMessages(recipient.id)).find(
        (message) => message.fileName === original.fileName,
      );
      expect(queued).toBeDefined();
      expect(engine.getSnapshot().transfers[queued!.id]).toBe(0);
    });
    socket.receive({ type: "peer_left", id: recipient.id });
    targetChannel.dispatchEvent(new Event("close"));

    expect(await first).toBeInstanceOf(Error);
    expect(await result).toMatchObject({
      message: expect.stringContaining("转发未完成"),
    });
    expect(controls(targetChannel)).toEqual([
      expect.objectContaining({ type: "file-start", fileName: "first.txt" }),
    ]);
    expect(await storage.getMessages(peer.id)).toEqual([original]);
  });

  it("rejects an offline recipient and offline local device without writing forwarded messages", async () => {
    const { engine, storage, socket, targetChannel } = await withRecipient();
    const original = savedMessage();
    await storage.saveMessage(original);
    socket.receive({ type: "peer_left", id: recipient.id });
    await expect(engine.forwardMessage(original, recipient.id)).rejects.toThrow(
      "对方当前离线",
    );
    expect(await storage.getMessages(recipient.id)).toEqual([]);
    engine.setAvailability("offline");
    await expect(engine.forwardMessage(original, peer.id)).rejects.toThrow(
      "请先上线",
    );
    expect(await storage.getMessages(peer.id)).toEqual([original]);
    expect(targetChannel.sent).toEqual([]);
  });
});
