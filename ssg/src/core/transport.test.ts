import { bufferedStorage } from "./storage/test-buffered-storage";
import { testStorage } from "./storage/test-opfs";
import { testNetwork } from "./test-network";
import { describe, expect, it, vi } from "vitest";
import { ChatEngine } from "./engine";
import { desktopNetwork, type NativeBridge } from "./network/desktop";
import { identityFor } from "./network/libp2p/identity";
import { defaultSettings } from "./network/settings";
import { MAX_BUFFERED_FILE_BYTES, decodeChunk, encodeChunk, newId } from "./protocol";
import type { Message, Profile } from "./types";
import { CONNECTION_CONFIG, SIGNALING_CONFIG } from "../config";

import { Channel, controls, me, peer, PeerConnection, requests, Socket, transportFixture } from "./test-transport";

const { setup, engines, adapters } = transportFixture();

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

async function discoveryOnly(own = me, visible = [peer]) {
  const storage = bufferedStorage(`send-idle-${newId()}`);
  adapters.push(storage);
  const engine = new ChatEngine(storage, own, [], testNetwork());
  engines.push(engine);
  engine.start();
  const socket = Socket.instances.at(-1)!;
  socket.onopen?.();
  socket.receive({ type: "welcome", id: own.id, peers: visible });
  await Promise.resolve();
  return { engine, storage, socket };
}

describe("idle signaling and reconnect costs", () => {
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
    expect(requests(socket, "profile")).toHaveLength(0);
    expect(engine.getSnapshot().profile.revision).toBeGreaterThan(1);
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

  it("skips a long backoff after a network change and starts the next retry at the initial delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const connection = new EventTarget();
    Object.assign(navigator, { connection });
    let { socket } = await discoveryOnly();
    for (const ceiling of [1000, 2000, 4000, 8000, 16000, 32000, 64000]) {
      socket.close();
      await vi.advanceTimersByTimeAsync(ceiling * 0.75);
      socket = Socket.instances.at(-1)!;
    }
    socket.close(); // The scheduled retry is now 90 seconds away.
    const count = Socket.instances.length;
    connection.dispatchEvent(new Event("change"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.networkChangeDelayMs);
    expect(Socket.instances).toHaveLength(count + 1);
    Socket.instances.at(-1)!.close();
    await vi.advanceTimersByTimeAsync(750);
    expect(Socket.instances).toHaveLength(count + 2);
  });

  it("replaces a pending web handshake once and ignores a late reply from the old socket", async () => {
    vi.useFakeTimers();
    const { engine, socket } = await discoveryOnly();
    socket.close();
    await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.reconnectInitialDelayMs);
    const pending = Socket.instances.at(-1)!;
    pending.onopen?.();
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.networkChangeDelayMs);
    const replacement = Socket.instances.at(-1)!;
    expect(replacement).not.toBe(pending);
    pending.receive({ type: "welcome", peers: [] });
    expect(engine.getSnapshot().status).toBe("connecting");
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.networkChangeDelayMs);
    expect(Socket.instances.at(-1)).toBe(replacement);
    replacement.onopen?.();
    replacement.receive({ type: "welcome", peers: [] });
    expect(engine.getSnapshot().status).toBe("connected");
  });

  it("recovers a desktop signaling handshake on native interface changes without browser events", async () => {
    const storage = bufferedStorage(`desktop-recovery-${newId()}`);
    adapters.push(storage);
    const identity = await identityFor(storage);
    const settings = defaultSettings(true);
    settings.discovery.mdns = false;
    settings.servers[0].url = "ws://127.0.0.1/api/ws";
    let emit: Parameters<NativeBridge["request"]>[2];
    const starts = vi.fn();
    const network = desktopNetwork({
      async request<T>(...[, command, handler]: Parameters<NativeBridge["request"]>) {
        if (command.op === "start") { emit = handler; starts(); }
        return undefined as T;
      },
      async write() {},
    }, settings, Promise.resolve(identity));
    const engine = new ChatEngine(storage, { ...me, id: identity.id, clientType: "desktop" }, [], network);
    engines.push(engine);
    vi.useFakeTimers();
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getSnapshot().status).toBe("connected");
    const stale = Socket.instances[0];
    emit!({ type: "network_changed", id: identity.id });
    await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.networkChangeDelayMs);
    expect(stale.readyState).toBe(3);
    expect(Socket.instances).toHaveLength(2);
    emit!({ type: "network_changed", id: identity.id });
    await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.networkChangeDelayMs);
    expect(Socket.instances).toHaveLength(2);
    expect(starts).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("checks even a recently active socket once and keeps it only if it replies, pong=%s", async pong => {
    vi.useFakeTimers();
    const connection = new EventTarget();
    Object.assign(navigator, { connection });
    const { engine, socket } = await discoveryOnly();
    // The old OS connection can take much longer to report close.
    vi.spyOn(socket, "close").mockImplementation(() => { socket.readyState = 2; });
    connection.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.networkChangeDelayMs);
    expect(requests(socket, "ping")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    window.dispatchEvent(new Event("online"));
    if (pong) socket.receive({ type: "pong" });
    await vi.advanceTimersByTimeAsync(6000);
    if (pong) {
      expect(socket.readyState).toBe(Socket.OPEN);
      expect(Socket.instances).toHaveLength(1);
    } else {
      expect(requests(socket, "ping")).toHaveLength(1);
      expect(Socket.instances).toHaveLength(2);
      const replacement = Socket.instances.at(-1)!;
      replacement.onopen?.();
      replacement.receive({ type: "welcome", peers: [] });
      socket.onclose?.();
      expect(engine.getSnapshot().status).toBe("connected");
    }
    connection.dispatchEvent(new Event("change"));
    engine.setAvailability("offline");
    const count = Socket.instances.length;
    connection.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(120000);
    expect(Socket.instances).toHaveLength(count);
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

  it("recreates only the failed peer when sending after an RTC failure", async () => {
    const { engine, pc } = await setup();
    pc.fail();
    expect(engine.getSnapshot().peerStates[peer.id]).toBe("failed");
    const sending = engine.sendText("重试成功");
    expect(Socket.instances).toHaveLength(1);
    await vi.waitFor(() => expect(PeerConnection.instances).toHaveLength(2));
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
    await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.readyTimeoutMs + 1000);
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
          size: MAX_BUFFERED_FILE_BYTES,
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
  it("cancels every file in a concurrent batch when its conversation is deleted", async () => {
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
    ).toHaveLength(2);
    expect(
      controls(channel).filter((packet) => packet.type === "file-end"),
    ).toHaveLength(1);
    expect(engine.hasPendingTransfers()).toBe(false);
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

  it("keeps an established RTC session when discovery reports network loss", async () => {
    const { engine, socket, pc, channel } = await setup();
    vi.stubGlobal("navigator", { storage: testStorage, onLine: false });
    window.dispatchEvent(new Event("offline"));
    expect(engine.getSnapshot()).toMatchObject({
      availability: "online",
      status: "disconnected",
      peers: [peer],
      peerStates: { [peer.id]: "connected" },
    });
    expect(socket.readyState).toBe(3);
    expect(pc.connectionState).not.toBe("closed");
    expect(channel.readyState).toBe("open");
    expect(localStorage.getItem("hummingbird.availability")).not.toBe(
      "offline",
    );
    vi.stubGlobal("navigator", { storage: testStorage, onLine: true });
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
    expect(engine.getSnapshot().status).toBe("connecting");
  });
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
      expect(controls(targetChannel)).toEqual([]);
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
    targetChannel.close();
    socket.receive({ type: "peer_left", id: recipient.id });
    release();

    expect(await result).toMatchObject({
      message: expect.stringMatching(/已取消|已离线|已关闭|已断开/),
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

  it("offers a forward alongside a pending file and fails both when the recipient disconnects", async () => {
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
    await vi.waitFor(() =>
      expect(controls(targetChannel).filter((p) => p.type === "file-start")).toHaveLength(2),
    );
    targetChannel.close();
    socket.receive({ type: "peer_left", id: recipient.id });
    targetChannel.dispatchEvent(new Event("close"));

    expect(await first).toBeInstanceOf(Error);
    expect(await result).toMatchObject({
      message: expect.stringMatching(/已离线|已断开/),
    });
    expect(controls(targetChannel)).toEqual([
      expect.objectContaining({ type: "file-start", fileName: "first.txt" }),
      expect.objectContaining({ type: "file-start", fileName: "queued.txt" }),
    ]);
    expect(await storage.getMessages(peer.id)).toEqual([original]);
  });

  it("records a failed offline forward while respecting the local offline choice", async () => {
    const { engine, storage, socket, targetChannel } = await withRecipient();
    const original = savedMessage();
    await storage.saveMessage(original);
    targetChannel.close();
    socket.receive({ type: "peer_left", id: recipient.id });
    await expect(engine.forwardMessage(original, recipient.id)).rejects.toThrow(
      "对方当前离线",
    );
    expect(await storage.getMessages(recipient.id)).toEqual([expect.objectContaining({ status: "failed", text: original.text })]);
    engine.setAvailability("offline");
    await expect(engine.forwardMessage(original, peer.id)).rejects.toThrow(
      "请先上线",
    );
    expect(await storage.getMessages(peer.id)).toEqual([original]);
    expect(controls(targetChannel)).toEqual([]);
  });
});

describe("separate discovery and content deadlines", () => {
  it("gives a slow contact lookup a fresh content negotiation budget", async () => {
    const { engine, socket, channel } = await setup();
    const saved = { ...peer, numericId: "345678" };
    socket.receive({ type: "peer_updated", peer: saved });
    await vi.waitFor(() => expect(engine.getSnapshot().conversations[0]?.peer.numericId).toBe("345678"));
    channel.close(); socket.receive({ type: "peer_left", id: peer.id });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const sending = engine.sendText("查找耗时不挤占建连").catch((error) => error);
    await vi.waitFor(() => expect(requests(socket, "connect")).toHaveLength(1));
    const request = requests(socket, "connect")[0];
    await vi.advanceTimersByTimeAsync(9000);
    socket.receive({ type: "peer_resolved", requestId: request.requestId, peer: saved });
    await vi.advanceTimersByTimeAsync(CONNECTION_CONFIG.readyTimeoutMs - 1000);
    const replacement = PeerConnection.instances.at(-1)!;
    expect(replacement.connectionState).not.toBe("closed");
    replacement.channel.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(await sending).toBe(true);
  });
});
