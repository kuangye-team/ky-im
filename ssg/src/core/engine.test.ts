import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatEngine, MAX_REMARK_LENGTH } from "./engine";
import { IndexedDBStorageAdapter } from "./storage";
import { newId } from "./protocol";
import type { Profile } from "./types";

const adapters: IndexedDBStorageAdapter[] = [];
function adapter(name = `send-engine-test-${newId()}`) {
  const value = new IndexedDBStorageAdapter(name);
  adapters.push(value);
  return value;
}
const peer = (): Profile => ({
  id: newId(),
  name: "邻居",
  bio: "",
  avatar: "🌙",
  color: "#597461",
  device: "Mac",
});

describe("local automatic file receiving", () => {
  it("defaults off for existing contacts, persists only for the selected contact, and preserves remarks and ordering", async () => {
    const storage = adapter();
    const target = peer();
    const other = peer();
    await storage.saveConversation({
      peer: target,
      updatedAt: 100,
      unread: 3,
      remark: "朋友",
    });
    await storage.saveConversation({
      peer: other,
      updatedAt: 200,
      unread: 1,
    });
    const engine = await createChatEngine(storage);
    expect(
      engine.getSnapshot().conversations.every((c) => !c.autoAcceptFiles),
    ).toBe(true);
    await engine.updatePeerAutoAcceptFiles(target.id, true);
    const reopened = await createChatEngine(storage);
    expect(reopened.getSnapshot().conversations).toEqual([
      { peer: other, updatedAt: 200, unread: 1 },
      {
        peer: target,
        updatedAt: 100,
        unread: 3,
        remark: "朋友",
        autoAcceptFiles: true,
      },
    ]);
    await reopened.selectPeer(target);
    await reopened.updatePeerRemark(target.id, "新备注");
    expect(reopened.getSnapshot().conversations[1].autoAcceptFiles).toBe(true);
    await reopened.updatePeerAutoAcceptFiles(target.id, false);
    expect(
      (await createChatEngine(storage)).getSnapshot().conversations[1]
        .autoAcceptFiles,
    ).toBe(false);
  });

  it("keeps the previous permission on storage failure and does not create unknown contacts", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await engine.selectPeer(target);
    const conversations = engine.getSnapshot().conversations;
    vi.spyOn(storage, "saveConversation").mockRejectedValueOnce(
      new Error("quota"),
    );
    await expect(
      engine.updatePeerAutoAcceptFiles(target.id, true),
    ).rejects.toThrow("quota");
    expect(engine.getSnapshot().conversations).toBe(conversations);
    expect(
      (await storage.getConversations())[0].autoAcceptFiles,
    ).toBeUndefined();
    await engine.updatePeerAutoAcceptFiles(target.id, true);
    await expect(
      engine.updatePeerAutoAcceptFiles(newId(), true),
    ).rejects.toThrow("未找到聊天对象");
    expect(engine.getSnapshot().conversations).toHaveLength(1);
  });
});

describe("local peer remarks", () => {
  it("persists an offline peer's trimmed remark after reopening without changing unread counts or ordering", async () => {
    const name = `send-engine-test-${newId()}`;
    const storage = adapter(name);
    const target = peer();
    const other = peer();
    await storage.saveConversation({ peer: target, updatedAt: 100, unread: 3 });
    await storage.saveConversation({ peer: other, updatedAt: 200, unread: 1 });
    const engine = await createChatEngine(storage);

    await engine.updatePeerRemark(target.id, "  工作电脑  ");
    expect(engine.getSnapshot().conversations).toEqual([
      { peer: other, updatedAt: 200, unread: 1 },
      { peer: target, updatedAt: 100, unread: 3, remark: "工作电脑" },
    ]);
    expect(engine.getSnapshot().activePeerId).toBeNull();
    expect(engine.getSnapshot().messages).toEqual([]);
    await storage.close();

    const reopened = await createChatEngine(adapter(name));
    expect(reopened.getSnapshot().conversations).toEqual(
      engine.getSnapshot().conversations,
    );
    await reopened.selectPeer(target);
    expect(reopened.getSnapshot().conversations[1]?.remark).toBe("工作电脑");
  });

  it("removes whitespace-only remarks from both the snapshot and stored conversation", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await engine.selectPeer(target);
    await engine.updatePeerRemark(target.id, "工作电脑");
    await engine.updatePeerRemark(target.id, " \n\t ");

    expect(engine.getSnapshot().conversations[0]).not.toHaveProperty("remark");
    expect((await storage.getConversations())[0]).not.toHaveProperty("remark");
    expect(engine.getSnapshot().conversations[0]?.peer.name).toBe(target.name);
  });

  it("keeps the previous remark on storage failure and allows the next queued update", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await engine.selectPeer(target);
    await engine.updatePeerRemark(target.id, "旧备注");
    const conversations = engine.getSnapshot().conversations;
    vi.spyOn(storage, "saveConversation").mockRejectedValueOnce(
      new Error("quota"),
    );

    await expect(engine.updatePeerRemark(target.id, "新备注")).rejects.toThrow(
      "quota",
    );
    expect(engine.getSnapshot().conversations).toBe(conversations);
    expect((await storage.getConversations())[0]?.remark).toBe("旧备注");
    expect(engine.getSnapshot().error).toBe("quota");

    await engine.updatePeerRemark(target.id, "保存成功");
    expect(engine.getSnapshot().conversations[0]?.remark).toBe("保存成功");
  });

  it("validates trimmed remark length and rejects unknown peers without creating history", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await engine.selectPeer(target);
    const limit = "字".repeat(MAX_REMARK_LENGTH);
    await engine.updatePeerRemark(target.id, ` ${limit} `);
    expect(engine.getSnapshot().conversations[0]?.remark).toBe(limit);

    const save = vi.spyOn(storage, "saveConversation");
    await expect(
      engine.updatePeerRemark(target.id, `${limit}字`),
    ).rejects.toThrow(`${MAX_REMARK_LENGTH}`);
    await expect(engine.updatePeerRemark(newId(), "陌生设备")).rejects.toThrow(
      "未找到聊天对象",
    );
    expect(save).not.toHaveBeenCalled();
    expect(engine.getSnapshot().conversations).toHaveLength(1);
    expect(engine.getSnapshot().conversations[0]?.remark).toBe(limit);
  });

  it("serializes remark saves with opening history and writing messages", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await engine.selectPeer(target);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = storage.saveConversation.bind(storage);
    vi.spyOn(storage, "saveConversation").mockImplementationOnce(
      async (value) => {
        await gate;
        await save(value);
      },
    );

    const updating = engine.updatePeerRemark(target.id, "并发备注");
    const selecting = engine.selectPeer(target);
    const sending = engine.sendText("消息").catch((error) => error as Error);
    await Promise.resolve();
    expect(engine.getSnapshot().conversations[0]?.remark).toBeUndefined();
    release();
    await Promise.all([updating, selecting]);
    expect(await sending).toBeInstanceOf(Error);
    expect(engine.getSnapshot().conversations[0]?.remark).toBe("并发备注");
    expect((await storage.getConversations())[0]?.remark).toBe("并发备注");
    expect(engine.getSnapshot().messages[0]).toMatchObject({
      text: "消息",
      status: "failed",
    });
  });
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((value) => value.close()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chat engine persistence and offline behavior", () => {
  it("creates a stable identity without seeded peers or conversations", async () => {
    const storage = adapter();
    const first = await createChatEngine(storage);
    const second = await createChatEngine(storage);
    expect(first.getSnapshot().profile).toEqual(second.getSnapshot().profile);
    expect(first.getSnapshot().peers).toEqual([]);
    expect(first.getSnapshot().messages).toEqual([]);
    expect(first.getSnapshot().conversations).toEqual([]);
  });
  it("preserves failed offline messages after engine reload", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await engine.selectPeer(target);
    await expect(engine.sendText("离线消息")).rejects.toThrow("离线");
    expect(engine.getSnapshot().messages[0]).toMatchObject({
      text: "离线消息",
      status: "failed",
      peerId: target.id,
    });
    expect(engine.getSnapshot().error).toContain("离线");
    const reloaded = await createChatEngine(storage);
    await reloaded.selectPeer(target);
    expect(reloaded.getSnapshot().messages[0]?.status).toBe("failed");
    engine.dismissError();
    expect(engine.getSnapshot().error).toBeNull();
  });
  it("marks interrupted transmissions as failed when loading history", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await storage.saveMessage({
      id: newId(),
      peerId: target.id,
      senderId: engine.getSnapshot().profile.id,
      kind: "file",
      fileName: "unfinished.zip",
      createdAt: Date.now(),
      status: "sending",
    });
    await engine.selectPeer(target);
    expect(engine.getSnapshot().messages[0]?.status).toBe("failed");
    expect((await storage.getMessages(target.id))[0]?.status).toBe("failed");
  });
  it("updates profiles without allowing identity changes or invalid values", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const originalId = engine.getSnapshot().profile.id;
    await engine.updateProfile({ id: newId(), name: "小林", bio: "周末好" });
    expect(engine.getSnapshot().profile).toMatchObject({
      id: originalId,
      name: "小林",
      bio: "周末好",
    });
    expect((await storage.getProfile())?.name).toBe("小林");
    await expect(engine.updateProfile({ name: "" })).rejects.toThrow("昵称");
    expect(engine.getSnapshot().profile.name).toBe("小林");
    expect(engine.getSnapshot().error).toContain("昵称");
  });
  it("deletes active history, retains identity and emits stable snapshots", async () => {
    const engine = await createChatEngine(adapter());
    const original = engine.getSnapshot();
    expect(engine.getSnapshot()).toBe(original);
    let updates = 0;
    const unsubscribe = engine.subscribe(() => updates++);
    const target = peer();
    await engine.selectPeer(target);
    await expect(engine.sendText("测试")).rejects.toThrow("离线");
    expect(engine.getSnapshot()).not.toBe(original);
    expect(updates).toBeGreaterThan(0);
    await engine.deleteConversation(target.id);
    expect(engine.getSnapshot().conversations).toEqual([]);
    expect(engine.getSnapshot().activePeerId).toBeNull();
    await engine.selectPeer(target);
    expect(engine.getSnapshot().messages).toEqual([]);
    await engine.clearHistory();
    expect(engine.getSnapshot().profile).toEqual(original.profile);
    expect(await engine.storage.getConversations()).toEqual([]);
    unsubscribe();
    const count = updates;
    engine.dismissError();
    expect(updates).toBe(count);
  });
  it("deletes individual messages locally and keeps cached peers, remarks and identity", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    const other = peer();
    await engine.selectPeer(target);
    await engine.updatePeerRemark(target.id, "保留备注");
    await expect(engine.sendText("删除这条")).rejects.toThrow("离线");
    const removed = engine.getSnapshot().messages[0]!;
    await expect(engine.sendText("保留这条")).rejects.toThrow("离线");
    await engine.selectPeer(other);
    await expect(engine.sendText("另一个联系人")).rejects.toThrow("离线");
    const otherMessage = engine.getSnapshot().messages[0]!;
    const contacts = engine.getSnapshot().conversations;
    const identity = engine.getSnapshot().profile;

    await engine.deleteMessage(removed.id);
    expect(engine.getSnapshot().messages).toEqual([otherMessage]);
    expect(engine.getSnapshot().activePeerId).toBe(other.id);
    expect(engine.getSnapshot().conversations).toEqual(contacts);
    expect(engine.getSnapshot().profile).toEqual(identity);
    await engine.selectPeer(target);
    expect(
      engine.getSnapshot().messages.map((message) => message.text),
    ).toEqual(["保留这条"]);
    expect(
      engine
        .getSnapshot()
        .conversations.find((entry) => entry.peer.id === target.id)?.remark,
    ).toBe("保留备注");
    const reloaded = await createChatEngine(storage);
    await reloaded.selectPeer(target);
    expect(
      reloaded.getSnapshot().messages.map((message) => message.text),
    ).toEqual(["保留这条"]);
  });
  it("does not hide messages on deletion failure and lets a later retry succeed", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await engine.selectPeer(target);
    await expect(engine.sendText("保留直到成功删除")).rejects.toThrow("离线");
    const messages = engine.getSnapshot().messages;
    vi.spyOn(storage, "deleteMessages").mockRejectedValueOnce(
      new Error("delete failed"),
    );
    await expect(engine.deleteMessage(messages[0]!.id)).rejects.toThrow(
      "delete failed",
    );
    expect(engine.getSnapshot().messages).toBe(messages);
    expect(await storage.getMessages(target.id)).toEqual(messages);
    await engine.deleteMessage(messages[0]!.id);
    expect(engine.getSnapshot().messages).toEqual([]);
    expect(await storage.getMessages(target.id)).toEqual([]);
  });
  it("stops reconnecting when another tab takes over the same identity", async () => {
    class Socket {
      static OPEN = 1;
      static instances: Socket[] = [];
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      sent: string[] = [];
      constructor(_url: string) {
        Socket.instances.push(this);
      }
      send(value: string) {
        this.sent.push(value);
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("location", { protocol: "http:", host: "192.168.1.2:5173" });
    vi.stubGlobal("WebSocket", Socket);
    const engine = await createChatEngine(adapter());
    vi.useFakeTimers();
    engine.start();
    const socket = Socket.instances[0]!;
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "join",
      room: "local",
      profile: engine.getSnapshot().profile,
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "welcome",
        id: engine.getSnapshot().profile.id,
        peers: [],
      }),
    });
    expect(engine.getSnapshot().status).toBe("connected");
    socket.onmessage?.({
      data: JSON.stringify({
        type: "error",
        code: "session_replaced",
        message: "replaced",
      }),
    });
    expect(engine.getSnapshot().status).toBe("disconnected");
    expect(engine.getSnapshot().error).toContain("另一个标签页");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(Socket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects storage failures so the UI cannot falsely report successful changes", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const target = peer();
    await engine.selectPeer(target);
    const originalProfile = engine.getSnapshot().profile;
    vi.spyOn(storage, "saveProfile").mockRejectedValueOnce(new Error("quota"));
    await expect(engine.updateProfile({ name: "无法保存" })).rejects.toThrow(
      "quota",
    );
    expect(engine.getSnapshot().profile).toEqual(originalProfile);
    vi.spyOn(storage, "deleteConversation").mockRejectedValueOnce(
      new Error("quota"),
    );
    await expect(engine.deleteConversation(target.id)).rejects.toThrow("quota");
    expect(engine.getSnapshot().conversations).toHaveLength(1);
    vi.spyOn(storage, "clearHistory").mockRejectedValueOnce(new Error("quota"));
    await expect(engine.clearHistory()).rejects.toThrow("quota");
    expect(engine.getSnapshot().conversations).toHaveLength(1);
  });
  it("does not replace a newly selected peer with the result of a slower history load", async () => {
    const storage = adapter();
    const engine = await createChatEngine(storage);
    const alice = peer();
    const bob = peer();
    const message = {
      id: newId(),
      peerId: alice.id,
      senderId: alice.id,
      kind: "text" as const,
      text: "Alice history",
      createdAt: 1,
      status: "delivered" as const,
    };
    await storage.saveMessage(message);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = storage.getMessages.bind(storage);
    vi.spyOn(storage, "getMessages").mockImplementationOnce(async (id) => {
      await gate;
      return read(id);
    });
    const first = engine.selectPeer(alice);
    const second = engine.selectPeer(bob);
    expect(engine.getSnapshot().activePeerId).toBe(bob.id);
    release();
    await Promise.all([first, second]);
    expect(engine.getSnapshot().activePeerId).toBe(bob.id);
    expect(engine.getSnapshot().messages).toEqual([]);
  });
});
