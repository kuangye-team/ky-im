import { localRuntime } from "./capabilities";
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDB } from "idb";
import { attachmentDirectory, folderEntries } from "./storage/opfs";
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
  numericId: "123456",
  avatar: "🌿",
  color: "#597461",
  bio: "你好",
  device: "Linux",
  clientType: "web" as const, ...localRuntime(true),
});
const adapters: IndexedDBStorageAdapter[] = [];
function adapter(name = `send-test-${newId()}`) {
  const value = new IndexedDBStorageAdapter(name);
  adapters.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((value) => value.close()));
  vi.restoreAllMocks();
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
  it("stores metadata only, commits complete streams, and cancels writes when their message is deleted", async () => {
    const name = `opfs-${newId()}`, storage = adapter(name), id = newId();
    const writer = await storage.createFileDestination({ id, size: 6, fileName: "保留.txt", mimeType: "text/plain" });
    await writer.write(new Blob(["abc"]));
    expect(await storage.getAttachment(id)).toBeUndefined();
    await expect(writer.close()).rejects.toThrow("尚未接收完整");
    await writer.write(new Blob(["def"]));
    await writer.close();
    const db = await openDB(name);
    const record = await db.get("attachments", id);
    expect(record).toMatchObject({ size: 6, name: "保留.txt", mimeType: "text/plain", folder: false });
    expect(record).not.toBeInstanceOf(Blob);
    expect(await db.count("pendingAttachments")).toBe(0);
    expect(await (await storage.getAttachment(id))!.text()).toBe("abcdef");
    const pendingId = newId();
    const pending = await storage.createFileDestination({ id: pendingId, size: 3 });
    await pending.write(new Blob(["abc"]));
    await storage.deleteMessages([pendingId]);
    await expect(pending.close()).rejects.toThrow("已取消");
    expect(await storage.getAttachment(pendingId)).toBeUndefined();
    expect(await db.count("pendingAttachments")).toBe(0);
    db.close();
  });
  it("preserves nested and empty directories, and removes folder payloads with their history", async () => {
    const name = `opfs-${newId()}`, storage = adapter(name);
    const message = await conversation(storage, profile());
    const folder = await storage.createFolderDestination({ ...message, size: 3, folder: { fileCount: 2, directoryCount: 2 } });
    await folder.createDirectory("空目录");
    await folder.createDirectory("子目录");
    const empty = await folder.createFile("空.txt", 0); await empty.close();
    const file = await folder.createFile("子目录/内容.txt", 3);
    await file.write(new Blob(["abc"])); await file.close(); await folder.close!();
    const db = await openDB(name), record = await db.get("attachments", message.id);
    const root = await (await attachmentDirectory(name)).getDirectoryHandle(record.path);
    const paths = []; for await (const entry of folderEntries(root)) paths.push(entry.path);
    expect(paths.sort()).toEqual(["子目录", "子目录/内容.txt", "空.txt", "空目录"].sort());
    expect(await storage.getAttachment(message.id)).toBeUndefined();
    expect((await storage.getFiles())[0].size).toBe(3);
    await storage.deleteConversation(message.peerId);
    await expect((await attachmentDirectory(name)).getDirectoryHandle(record.path)).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await db.count("attachments")).toBe(0); db.close();
  });
  it("cleans abandoned staging on reopen but preserves another adapter's active write", async () => {
    const name = `opfs-${newId()}`, storage = adapter(name), id = newId();
    const live = await storage.createFileDestination({ id, size: 3 });
    const db = await openDB(name), root = await attachmentDirectory(name), path = newId();
    await root.getDirectoryHandle(path, { create: true });
    await db.put("pendingAttachments", { id: newId(), record: { path, name: "partial", size: 3, folder: false, mimeType: "" } }, path);
    const reopened = adapter(name);
    await reopened.saveAttachment(newId(), new Blob(["other"]));
    await expect(root.getDirectoryHandle(path)).rejects.toMatchObject({ name: "NotFoundError" });
    await live.write(new Blob(["abc"])); await live.close();
    expect(await (await reopened.getAttachment(id))!.text()).toBe("abc");
    expect(await db.count("pendingAttachments")).toBe(0); db.close();
  });
  it("reports exhausted quota without publishing attachment metadata", async () => {
    const name = `opfs-${newId()}`, storage = adapter(name);
    vi.spyOn(navigator.storage, "estimate").mockResolvedValue({ quota: 10, usage: 9 });
    await expect(storage.saveAttachment(newId(), new Blob(["full"]))).rejects.toThrow("可用空间不足");
    const db = await openDB(name);
    expect(await db.count("attachments")).toBe(0);
    expect(await db.count("pendingAttachments")).toBe(0); db.close();
  });
  it("resets identity, contacts, history and orphan attachments across reopen", async () => {
    const name = `send-test-${newId()}`;
    const storage = adapter(name);
    const me = profile();
    const target = profile();
    await storage.saveProfile(me);
    await conversation(storage, target);
    const orphan = newId();
    await storage.saveAttachment(orphan, new Blob(["orphan"]));
    await storage.resetData();
    await storage.close();
    const reopened = adapter(name);
    expect(await reopened.getProfile()).toBeUndefined();
    expect(await reopened.getConversations()).toEqual([]);
    expect(await reopened.getMessages(target.id)).toEqual([]);
    expect(await reopened.getFiles()).toEqual([]);
    expect(await reopened.getAttachment(orphan)).toBeUndefined();
  });
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
