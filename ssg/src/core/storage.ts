import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conversation, Message, Profile, StorageAdapter } from "./types";
import { STORAGE_CONFIG } from "../config";

export { LARGE_FILE_BYTES } from "../config";

interface ChatDatabase extends DBSchema {
  settings: { key: string; value: Profile };
  conversations: { key: string; value: Conversation };
  messages: { key: string; value: Message; indexes: { "by-peer": string } };
  attachments: { key: string; value: Blob };
}

/** All history belongs to this adapter, including the binary attachment payloads. */
export class IndexedDBStorageAdapter implements StorageAdapter {
  readonly name = "浏览器本地存储";
  private readonly database: Promise<IDBPDatabase<ChatDatabase>>;

  constructor(databaseName: string = STORAGE_CONFIG.databaseName) {
    this.database = openDB<ChatDatabase>(databaseName, 1, {
      upgrade(db) {
        db.createObjectStore("settings");
        db.createObjectStore("conversations", { keyPath: "peer.id" });
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("by-peer", "peerId");
        db.createObjectStore("attachments");
      },
    });
  }

  async getProfile() {
    return (await this.database).get("settings", "profile");
  }
  async saveProfile(profile: Profile) {
    await (await this.database).put("settings", profile, "profile");
  }
  async getConversations() {
    return (await (await this.database).getAll("conversations")).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }
  async saveConversation(conversation: Conversation) {
    await (await this.database).put("conversations", conversation);
  }
  async getMessages(peerId: string) {
    return (
      await (await this.database).getAllFromIndex("messages", "by-peer", peerId)
    ).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async saveMessage(message: Message) {
    const tx = (await this.database).transaction("messages", "readwrite");
    const existing = await tx.store.get(message.id);
    if (
      existing &&
      (existing.peerId !== message.peerId ||
        existing.senderId !== message.senderId)
    ) {
      // An untrusted peer must not overwrite another conversation using a guessed ID.
      await tx.done;
      throw new Error("消息标识发生冲突");
    }
    await tx.store.put(message);
    await tx.done;
  }
  async getAttachment(id: string) {
    return (await this.database).get("attachments", id);
  }
  async saveAttachment(id: string, blob: Blob) {
    await (await this.database).put("attachments", blob, id);
  }

  async getFiles(minSize = 0) {
    const tx = (await this.database).transaction(
      ["messages", "attachments"],
      "readonly",
    );
    const files: Message[] = [];
    let cursor = await tx.objectStore("attachments").openCursor();
    while (cursor) {
      // Use the stored bytes, not peer-supplied file metadata, for cleanup totals.
      if (cursor.value.size >= minSize) {
        const message = await tx.objectStore("messages").get(cursor.key);
        if (message && message.kind !== "text")
          files.push({ ...message, size: cursor.value.size });
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return files.sort(
      (a, b) => (b.size || 0) - (a.size || 0) || b.createdAt - a.createdAt,
    );
  }

  async deleteMessages(ids: string[]) {
    // Validate the whole batch before opening a transaction: invalid IDB keys
    // throw synchronously and would otherwise leave earlier requests queued.
    if (ids.some((id) => typeof id !== "string"))
      throw new Error("消息标识无效，请刷新后重试");
    if (!ids.length) return;
    const tx = (await this.database).transaction(
      ["messages", "attachments"],
      "readwrite",
    );
    await Promise.all(
      [...new Set(ids)].flatMap((id) => [
        tx.objectStore("messages").delete(id),
        tx.objectStore("attachments").delete(id),
      ]),
    );
    await tx.done;
  }

  async deleteConversation(peerId: string) {
    const tx = (await this.database).transaction(
      ["conversations", "messages", "attachments"],
      "readwrite",
    );
    await tx.objectStore("conversations").delete(peerId);
    let cursor = await tx
      .objectStore("messages")
      .index("by-peer")
      .openCursor(peerId);
    while (cursor) {
      await tx.objectStore("attachments").delete(cursor.value.id);
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  async clearHistory() {
    const tx = (await this.database).transaction(
      ["conversations", "messages", "attachments"],
      "readwrite",
    );
    await Promise.all([
      tx.objectStore("conversations").clear(),
      tx.objectStore("messages").clear(),
      tx.objectStore("attachments").clear(),
    ]);
    await tx.done;
  }

  /** Useful for adapter replacement and tests. This does not remove stored data. */
  async close() {
    (await this.database).close();
  }
}

export type StorageAdapterFactory = (
  options?: Record<string, unknown>,
) => StorageAdapter | Promise<StorageAdapter>;
const adapters = new Map<string, StorageAdapterFactory>([
  [
    "browser",
    (options) =>
      new IndexedDBStorageAdapter(
        typeof options?.databaseName === "string"
          ? options.databaseName
          : undefined,
      ),
  ],
]);

/** A future HTTP/SQL adapter can register here without changing the chat UI. */
export function registerStorageAdapter(
  type: string,
  factory: StorageAdapterFactory,
) {
  if (!type.trim()) throw new Error("存储适配器名称不能为空");
  adapters.set(type, factory);
}

export async function createStorageAdapter(
  type = "browser",
  options?: Record<string, unknown>,
): Promise<StorageAdapter> {
  const factory = adapters.get(type);
  if (!factory) throw new Error(`未找到存储适配器：${type}`);
  return factory(options);
}
