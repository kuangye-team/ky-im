import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  IndexedDBStorageAdapter,
  LARGE_FILE_BYTES,
  createStorageAdapter,
  registerStorageAdapter,
} from "./storage";
import { newId } from "./protocol";
import type { Message, Profile } from "./types";

const profile = (id = newId()): Profile => ({
  id,
  name: "测试设备",
  avatar: "🌿",
  color: "#597461",
  bio: "你好",
  device: "浏览器",
});
const adapters: IndexedDBStorageAdapter[] = [];
function adapter(name = `send-test-${newId()}`) {
  const value = new IndexedDBStorageAdapter(name);
  adapters.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((value) => value.close()));
});
async function conversation(
  storage: IndexedDBStorageAdapter,
  peer: Profile,
  text = "你好",
) {
  const message: Message = {
    id: newId(),
    peerId: peer.id,
    senderId: peer.id,
    kind: "file",
    text,
    fileName: "hello.txt",
    mimeType: "text/plain",
    size: 5,
    createdAt: Date.now(),
    status: "delivered",
  };
  await storage.saveConversation({
    peer,
    updatedAt: message.createdAt,
    unread: 1,
  });
  await storage.saveMessage(message);
  await storage.saveAttachment(
    message.id,
    new Blob(["hello"], { type: "text/plain" }),
  );
  return message;
}

describe("browser storage adapter", () => {
  it("restores identity, conversations, ordered messages and binary attachments after reopening", async () => {
    const name = `send-test-${newId()}`;
    const first = adapter(name);
    const me = profile();
    const peer = profile();
    await first.saveProfile(me);
    const message = await conversation(first, peer);
    await first.saveMessage({
      ...message,
      id: newId(),
      kind: "text",
      text: "更早的消息",
      createdAt: message.createdAt - 10,
    });
    await first.close();
    const reopened = adapter(name);
    expect(await reopened.getProfile()).toEqual(me);
    expect((await reopened.getConversations())[0]?.peer).toEqual(peer);
    expect(
      (await reopened.getMessages(peer.id)).map((value) => value.text),
    ).toEqual(["更早的消息", "你好"]);
    expect(await (await reopened.getAttachment(message.id))?.text()).toBe(
      "hello",
    );
  });
  it("deletes all conversation data while preserving other peers and profile", async () => {
    const storage = adapter();
    const me = profile();
    const alice = profile();
    const bob = profile();
    await storage.saveProfile(me);
    const first = await conversation(storage, alice);
    const second = await conversation(storage, bob);
    await storage.deleteConversation(alice.id);
    expect(await storage.getMessages(alice.id)).toEqual([]);
    expect(await storage.getAttachment(first.id)).toBeUndefined();
    expect(
      (await storage.getConversations()).map((value) => value.peer.id),
    ).toEqual([bob.id]);
    expect(await (await storage.getAttachment(second.id))?.text()).toBe(
      "hello",
    );
    expect(await storage.getProfile()).toEqual(me);
  });
  it("clears history and payloads without resetting identity", async () => {
    const storage = adapter();
    const me = profile();
    const peer = profile();
    await storage.saveProfile(me);
    const message = await conversation(storage, peer);
    await storage.clearHistory();
    expect(await storage.getConversations()).toEqual([]);
    expect(await storage.getMessages(peer.id)).toEqual([]);
    expect(await storage.getAttachment(message.id)).toBeUndefined();
    expect(await storage.getProfile()).toEqual(me);
  });
  it("deletes selected messages and blobs across peers while preserving contacts and unselected data", async () => {
    const storage = adapter();
    const me = profile();
    const alice = profile();
    const bob = profile();
    await storage.saveProfile(me);
    const first = await conversation(storage, alice);
    const second = await conversation(storage, bob);
    const kept: Message = {
      ...first,
      id: newId(),
      kind: "text",
      text: "保留文字",
    };
    await storage.saveMessage(kept);
    const contacts = await storage.getConversations();
    await storage.deleteMessages([first.id, second.id, first.id, newId()]);
    expect(await storage.getMessages(alice.id)).toEqual([kept]);
    expect(await storage.getMessages(bob.id)).toEqual([]);
    expect(await storage.getAttachment(first.id)).toBeUndefined();
    expect(await storage.getAttachment(second.id)).toBeUndefined();
    expect(await storage.getConversations()).toEqual(contacts);
    expect(await storage.getProfile()).toEqual(me);
  });
  it("lists saved files using actual byte sizes, including empty files and the large-file threshold", async () => {
    const storage = adapter();
    const target = profile();
    const base = await conversation(storage, target);
    const boundary = { ...base, id: newId(), size: 1 };
    const larger = { ...base, id: newId(), kind: "image" as const, size: 1 };
    const missing = { ...base, id: newId(), size: LARGE_FILE_BYTES * 4 };
    const text = { ...base, id: newId(), kind: "text" as const };
    const small = { ...base, id: newId(), size: LARGE_FILE_BYTES * 2 };
    const empty = { ...base, id: newId() };
    for (const message of [boundary, larger, missing, text, small, empty])
      await storage.saveMessage(message);
    await storage.saveAttachment(small.id, new Blob(["hello!"]));
    await storage.saveAttachment(empty.id, new Blob([]));
    await storage.saveAttachment(
      boundary.id,
      new Blob([new Uint8Array(LARGE_FILE_BYTES)]),
    );
    await storage.saveAttachment(
      larger.id,
      new Blob([new Uint8Array(LARGE_FILE_BYTES + 1)]),
    );
    await storage.saveAttachment(
      text.id,
      new Blob([new Uint8Array(LARGE_FILE_BYTES)]),
    );
    await storage.saveAttachment(
      newId(),
      new Blob([new Uint8Array(LARGE_FILE_BYTES)]),
    );
    expect(await storage.getFiles(LARGE_FILE_BYTES)).toEqual([
      { ...larger, size: LARGE_FILE_BYTES + 1 },
      { ...boundary, size: LARGE_FILE_BYTES },
    ]);
    expect(await storage.getFiles(LARGE_FILE_BYTES + 1)).toHaveLength(1);
    expect(await storage.getFiles()).toEqual([
      { ...larger, size: LARGE_FILE_BYTES + 1 },
      { ...boundary, size: LARGE_FILE_BYTES },
      { ...small, size: 6 },
      { ...base, size: 5 },
      { ...empty, size: 0 },
    ]);
    await storage.deleteMessages([boundary.id, larger.id]);
    expect(await storage.getFiles(LARGE_FILE_BYTES)).toEqual([]);
  });
  it("rejects an invalid deletion batch without partially removing earlier messages", async () => {
    const storage = adapter();
    const target = profile();
    const message = await conversation(storage, target);
    await expect(
      storage.deleteMessages([message.id, undefined as unknown as string]),
    ).rejects.toThrow("消息标识无效");
    expect(await storage.getMessages(target.id)).toEqual([message]);
    expect(await (await storage.getAttachment(message.id))?.text()).toBe(
      "hello",
    );
  });
  it("rejects ID collisions from another peer without overwriting history", async () => {
    const storage = adapter();
    const peer = profile();
    const message = await conversation(storage, peer);
    await expect(
      storage.saveMessage({
        ...message,
        peerId: newId(),
        senderId: newId(),
        text: "伪造内容",
      }),
    ).rejects.toThrow("冲突");
    expect((await storage.getMessages(peer.id))[0]?.text).toBe("你好");
  });
  it("resolves registered adapters with configuration", async () => {
    const storage = adapter();
    registerStorageAdapter("test", (options) => {
      expect(options).toEqual({ endpoint: "local" });
      return storage;
    });
    expect(await createStorageAdapter("test", { endpoint: "local" })).toBe(
      storage,
    );
    await expect(createStorageAdapter("missing")).rejects.toThrow("未找到");
  });
});
