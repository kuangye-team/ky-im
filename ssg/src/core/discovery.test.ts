import { describe, expect, it, vi } from "vitest";
import { ChatEngine } from "./engine";
import { newId } from "./protocol";
import { testNetwork } from "./test-network";
import { controls, me, peer, PeerConnection, requests, Socket, transportFixture } from "./test-transport";
import type { Message } from "./types";

const { setup, engines } = transportFixture();

describe("hummingbird group discovery", () => {
  it("uses inbound presence to defer a center ping and resumes probing after silence", async () => {
    const { engine, socket } = await setup();
    vi.useFakeTimers({toFake: ["Date"]});
    const start = Date.now();
    vi.setSystemTime(start + 15000);
    socket.receive({type: "peer_updated", peer});
    vi.setSystemTime(start + 20000);
    engine["discovery"].checkHeartbeat();
    expect(requests(socket, "ping")).toHaveLength(0);
    vi.setSystemTime(start + 36000);
    engine["discovery"].checkHeartbeat();
    expect(requests(socket, "ping")).toHaveLength(1);
  });
  it("includes recent saved chat numbers on every join and reconnect without changing our own number", async () => {
    const { engine, storage } = await setup();
    engine.stop();
    const saved = [
      { peer: { ...peer, numericId: "234567" }, updatedAt: 10, unread: 0 },
      { peer: { ...peer, id: newId(), numericId: "345678" }, updatedAt: 20, unread: 0 },
    ];
    for (const conversation of saved) await storage.saveConversation(conversation);
    const restored = new ChatEngine(storage, me, await storage.getConversations(), testNetwork());
    engines.push(restored);
    restored.start();
    let socket = Socket.instances.at(-1)!;
    socket.onopen?.();
    expect(requests(socket, "join")[0]).toMatchObject({
      recentNumericIds: ["345678", "234567"],
      profile: { id: me.id, numericId: me.numericId },
    });
    expect(requests(socket, "connect_group")).toEqual([]);
    restored.reconnect();
    socket = Socket.instances.at(-1)!;
    socket.onopen?.();
    expect(requests(socket, "join")[0].recentNumericIds).toEqual(["345678", "234567"]);
  });

  it("updates discovery only when recent number membership changes and does not retry empty groups", async () => {
    const { engine, socket } = await setup();
    socket.receive({ type: "peer_updated", peer: { ...peer, numericId: "234567" } });
    await vi.waitFor(() => expect(requests(socket, "discover")).toHaveLength(1));
    expect(requests(socket, "discover")[0].recentNumericIds).toEqual(["234567"]);
    await engine.updatePeerRemark(peer.id, "朋友");
    expect(requests(socket, "discover")).toHaveLength(1);
    socket.receive({ type: "peer_left", id: peer.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests(socket, "discover")).toHaveLength(1);
    expect(engine.getSnapshot().conversations[0].peer.numericId).toBe("234567");
    await engine.deleteConversation(peer.id);
    await vi.waitFor(() => expect(requests(socket, "discover")).toHaveLength(2));
    expect(requests(socket, "discover")[1].recentNumericIds).toEqual([]);
  });

  it("applies discovery changes without deleting saved chats or accepting malformed batches", async () => {
    const { engine, socket, storage, channel } = await setup();
    const remote = { ...peer, id: newId(), numericId: "345678" };
    socket.receive({ type: "discovery_updated", peers: [remote], removedPeerIds: [peer.id] });
    await vi.waitFor(() => expect(engine.getSnapshot().peers).toEqual([remote, peer]));
    expect(channel.readyState).toBe("open");
    channel.close();
    expect(engine.getSnapshot().peers).toEqual([remote]);
    expect((await storage.getConversations())[0].peer.id).toBe(peer.id);
    socket.receive({ type: "discovery_updated", peers: [{ ...remote, id: "bad" }], removedPeerIds: [remote.id] });
    await Promise.resolve();
    expect(engine.getSnapshot().peers).toEqual([remote]);
  });

  it("keeps a later departure authoritative while a discovery batch is being saved", async () => {
    const { engine, socket } = await setup();
    const first = { ...peer, id: newId(), numericId: "234567" };
    const leaving = { ...peer, id: newId(), numericId: "345678" };
    socket.receive({ type: "discovery_updated", peers: [first, leaving], removedPeerIds: [] });
    socket.receive({ type: "peer_left", id: leaving.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.getSnapshot().peers.map((peer) => peer.id)).toEqual([peer.id, first.id]);
  });

  it("refreshes only our number while preserving contacts, history and RTC channels", async () => {
    const { engine, storage, socket, channel, pc } = await setup();
    await engine.updatePeerRemark(peer.id, "本地备注");
    await engine.sendText("换号前的消息");
    const before = engine.getSnapshot();
    const refresh = engine.refreshNumericId();
    await expect(engine.refreshNumericId()).rejects.toThrow("正在刷新");
    await refresh;
    const number = engine.getSnapshot().profile.numericId;
    expect(number).toMatch(/^[1-9][0-9]{5}$/);
    expect(number).not.toBe(before.profile.numericId);
    expect(engine.getSnapshot().profile.id).toBe(me.id);
    expect(await storage.getProfile()).toEqual(engine.getSnapshot().profile);
    expect(engine.getSnapshot().conversations).toEqual(before.conversations);
    expect(engine.getSnapshot().peers).toEqual(before.peers);
    expect(engine.getSnapshot().messages).toEqual(before.messages);
    expect(requests(socket, "change_numeric_id").at(-1)).toMatchObject({ numericId: number, revision: engine.getSnapshot().profile.revision });
    expect(PeerConnection.instances).toEqual([pc]);
    expect(channel.readyState).toBe("open");
    await engine.sendText("换号后继续聊天");
    expect(controls(channel).filter((p) => p.type === "text").map((p) => p.text))
      .toEqual(["换号前的消息", "换号后继续聊天"]);

  });

  it("refreshes offline, preserves the saved number on failure and allows retry", async () => {
    const { engine, storage, socket } = await setup();
    engine.setAvailability("offline");
    const old = engine.getSnapshot().profile.numericId;
    vi.spyOn(storage, "saveProfile").mockRejectedValueOnce(new Error("disk full"));
    await expect(engine.refreshNumericId()).rejects.toThrow("disk full");
    expect(engine.getSnapshot().profile.numericId).toBe(old);
    await engine.refreshNumericId();
    const number = engine.getSnapshot().profile.numericId;
    expect(number).not.toBe(old);
    expect((await storage.getProfile())?.numericId).toBe(number);
    expect(socket.readyState).toBe(3);
    engine.setAvailability("online");
    const replacement = Socket.instances.at(-1)!;
    replacement.onopen?.();
    expect(JSON.parse(replacement.sent[0]!)).toMatchObject({ profile: { numericId: number } });
  });

  it("retains its local number through server replies and reconnects", async () => {
    const { engine, storage, socket } = await setup();
    socket.receive({ type: "welcome", id: me.id, numericId: "654321", peers: [peer] });
    socket.receive({ type: "discovery_number" });
    await engine.updateProfile({ bio: "after reconnect" });
    expect(engine.getSnapshot().profile.numericId).toBe(me.numericId);
    expect((await storage.getProfile())?.numericId).toBe(me.numericId);
    engine.reconnect();
    const replacement = Socket.instances.at(-1)!;
    replacement.onopen?.();
    expect(JSON.parse(replacement.sent[0]!)).toMatchObject({ profile: { id: me.id, numericId: me.numericId } });
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
    expect(engine.getSnapshot().profile).toEqual({ ...ownProfile, revision: 1, ...engine.getRuntimeInfo() });
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
    expect((await storage.getConversations()).map(c => c.peer.id).sort()).toEqual(devices.map(p => p.id));
    expect(PeerConnection.instances).toHaveLength(1);
    for (const device of devices)
      expect(engine.getSnapshot().peerStates[device.id]).toBeUndefined();
    const later = { ...devices[0]!, id: newId() };
    socket.receive({ type: "peer_joined", peer: later });
    await vi.waitFor(async () => expect((await storage.getConversations()).map(c => c.peer.id)).toContain(later.id));
    await engine.selectPeer(devices[0]!);
    expect(PeerConnection.instances).toHaveLength(2);
    PeerConnection.instances[1]!.channel.open();
    expect(engine.getSnapshot().peerStates[devices[0]!.id]).toBe("connected");
    expect(engine.getSnapshot().peerStates[devices[1]!.id]).toBeUndefined();
  });

  it("reports a failed contact save and lets the user retry the lookup", async () => {
    const { engine, socket, storage } = await setup();
    const device = { ...peer, id: newId(), numericId: "345678" };
    const lookup = () => {
      const result = engine.connectByNumericId(device.numericId);
      socket.receive({ type: "group_resolved", requestId: requests(socket).at(-1)!.requestId,
        numericId: device.numericId, peers: [device] });
      return result;
    };
    await engine["history"].writing;
    vi.spyOn(storage, "saveConversation").mockRejectedValueOnce(new Error("storage full"));
    await expect(lookup()).rejects.toThrow("联系人未能保存");
    await lookup();
    expect((await storage.getConversations()).filter(c => c.peer.id === device.id)).toHaveLength(1);
  });

  it("remembers the resolved number when the device has a cached profile under its old number", async () => {
    const { engine, socket, storage } = await setup();
    const cached = { ...peer, numericId: "234567", revision: 4, bio: "Previously verified" };
    engine["network"].transport.onProfile?.(cached);
    const found = engine.connectByNumericId("345678");
    socket.receive({ type: "group_resolved", requestId: requests(socket).at(-1)!.requestId,
      numericId: "345678", peers: [{ ...peer, numericId: "345678" }] });
    await found;
    const updated = { ...cached, numericId: "345678" };
    expect((await storage.getConversations())[0].peer).toEqual(updated);
    const restored = new ChatEngine(storage, me, await storage.getConversations(),
      testNetwork(), await storage.getPeerProfiles());
    engines.push(restored);
    expect(restored["network"].transport.cachedProfile?.(peer.id)).toEqual(updated);
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
      channel.close();
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
