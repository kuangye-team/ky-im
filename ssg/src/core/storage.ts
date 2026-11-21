import { isNative } from "../platform";
import { fullProfile, publicProfile, storedProfile } from "./profile-wire";
import { transferMetrics as metrics } from "./transferMetrics";
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import type { Conversation, FileDestination, Message, Profile, StorageAdapter, StorageUsage } from "./types";
import { STORAGE_CONFIG } from "../config";
import { newId } from "./protocol";
import { attachmentDirectory, attachmentFile, fileWriter, folderWriter, holdAttachmentLock, openWritable, removeEntry, storageError, type AttachmentRecord } from "./storage/opfs";
import { copySavedFile } from "./storage/copy";
import { exportBrowserAttachment } from "./storage/browser-export";

export { LARGE_FILE_BYTES } from "../config";

interface ChatDatabase extends DBSchema {
  settings: { key: string; value: Profile | ReturnType<typeof publicProfile> | Uint8Array | StorageUsage };
  conversations: { key: string; value: Conversation };
  messages: { key: string; value: Message; indexes: { "by-peer": string; "by-peer-time": [string, number] } };
  attachments: { key: string; value: AttachmentRecord };
  pendingAttachments: { key: string; value: { id: string; record: AttachmentRecord; cancelled?: boolean } };
}

const activePaths = new Set<string>();

/** IndexedDB owns records only; bounded attachment streams are stored in OPFS. */
export class IndexedDBStorageAdapter implements StorageAdapter {
  readonly name = "浏览器本地存储";
  private readonly database: Promise<IDBPDatabase<ChatDatabase>>;
  onDatabaseDelete?: () => Promise<void>;
  private files?: Promise<FileSystemDirectoryHandle>;
  private readonly writers = new Map<string, { id: string; abort(): Promise<void> }>();

  constructor(private readonly databaseName: string = STORAGE_CONFIG.databaseName) {
    const thisAdapter = this;
    this.database = openDB<ChatDatabase>(databaseName, 3, {
      async blocking(_current, next) {
        if (next === null) await thisAdapter.onDatabaseDelete?.();
        await thisAdapter.close();
      },
      upgrade(db, oldVersion, _newVersion, tx) {
        if (!oldVersion) {
          db.createObjectStore("settings");
          db.createObjectStore("conversations", { keyPath: "peer.id" });
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("by-peer", "peerId");
        } else if (oldVersion < 2) db.deleteObjectStore("attachments");
        // The unreleased Blob schema is replaced, without migrating binary data.
        if (oldVersion < 2) {
          db.createObjectStore("attachments");
          db.createObjectStore("pendingAttachments");
        }
        tx.objectStore("messages").createIndex("by-peer-time", ["peerId", "createdAt"]);
      },
    });
    if (typeof navigator.storage?.getDirectory === "function") void this.directory().catch(() => {});
  }

  private lockName(path: string) { return `ky-im-attachment:${this.databaseName}:${path}`; }

  private directory() {
    return this.files ??= this.initializeFiles().catch((error) => { this.files = undefined; throw error; });
  }

  private async initializeFiles() {
    const directory = await attachmentDirectory(this.databaseName);
    const db = await this.database;
    // Interrupted writes are never advertised as saved files. Locks keep another
    // tab's active transfer intact while allowing abandoned staging data to go.
    for (const pending of await db.getAll("pendingAttachments")) {
      const name = this.lockName(pending.record.path);
      if (activePaths.has(name)) continue;
      const clean = async () => {
        if (!(await db.get("pendingAttachments", pending.record.path))) return;
        await removeEntry(directory, pending.record.path);
        await db.delete("pendingAttachments", pending.record.path);
      };
      try {
        if (navigator.locks) await navigator.locks.request(name, { ifAvailable: true }, (lock) => lock ? clean() : undefined);
        else await clean();
      } catch { /* Retry locked/unavailable staging data on the next open. */ }
    }
    return directory;
  }

  private async begin(message: Pick<Message, "id" | "size" | "fileName" | "mimeType">, folder: boolean) {
    const directory = await this.directory();
    const db = await this.database;
    const size = message.size ?? 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("文件大小无法读取，请重新选择");
    const estimate = await navigator.storage.estimate?.().catch(() => undefined);
    if (estimate?.quota && size > estimate.quota - (estimate.usage ?? 0))
      throw new Error("浏览器可用空间不足，请清理文件后重试");
    const record: AttachmentRecord = {
      path: newId(), name: message.fileName || "attachment", mimeType: message.mimeType || "",
      size, folder,
    };
    const name = this.lockName(record.path);
    const release = await holdAttachmentLock(name);
    activePaths.add(name);
    const finish = () => { this.writers.delete(record.path); activePaths.delete(name); release(); };
    const abort = async () => {
      try {
        const tx = db.transaction(["attachments", "pendingAttachments"], "readwrite");
        if ((await tx.objectStore("attachments").get(message.id))?.path === record.path)
          await tx.objectStore("attachments").delete(message.id);
        await tx.objectStore("pendingAttachments").put({ id: message.id, record, cancelled: true }, record.path);
        await tx.done;
        await removeEntry(directory, record.path);
        await db.delete("pendingAttachments", record.path);
      } finally { finish(); }
    };
    const commit = async () => {
      const tx = db.transaction(["attachments", "pendingAttachments"], "readwrite");
      const pending = await tx.objectStore("pendingAttachments").get(record.path);
      if (!pending || pending.cancelled) { await tx.done; throw new Error("文件传输已取消"); }
      const previous = await tx.objectStore("attachments").get(message.id);
      await tx.objectStore("attachments").put(record, message.id);
      await tx.objectStore("pendingAttachments").delete(record.path);
      if (previous) await tx.objectStore("pendingAttachments").put({ id: message.id, record: previous, cancelled: true }, previous.path);
      await tx.done;
      finish();
      if (previous) {
        try {
          await removeEntry(directory, previous.path);
          await db.delete("pendingAttachments", previous.path);
        } catch { /* Previous copies remain registered for cleanup. */ }
      }
    };
    try {
      await db.put("pendingAttachments", { id: message.id, record }, record.path);
      const root = await directory.getDirectoryHandle(record.path, { create: true });
      return { root, commit, abort, record };
    } catch (error) { await abort().catch(() => {}); throw storageError(error); }
  }

  async createFileDestination(message: Pick<Message, "id" | "size" | "fileName" | "mimeType">) {
    return this.openFileDestination(message);
  }

  private async openFileDestination(message: Pick<Message, "id" | "size" | "fileName" | "mimeType">) {
    const stage = await this.begin(message, false);
    try {
      const handle = await stage.root.getFileHandle("file", { create: true });
      const writer = fileWriter(await openWritable(handle), stage.record.size, stage.commit, stage.abort, handle);
      this.writers.set(stage.record.path, { id: message.id, abort: writer.abort });
      return writer;
    } catch (error) { await stage.abort().catch(() => {}); throw error; }
  }

  async createFolderDestination(message: Message) {
    const stage = await this.begin(message, true);
    const writer = folderWriter(stage.root, stage.record.size, stage.commit, stage.abort);
    this.writers.set(stage.record.path, { id: message.id, abort: () => writer.abort!() });
    return writer;
  }

  async getIdentity() {
    const value = await (await this.database).get("settings", "identity");
    return value instanceof Uint8Array ? value : undefined;
  }
  async saveIdentity(key: Uint8Array) {
    const tx = (await this.database).transaction("settings", "readwrite");
    if (!(await tx.store.get("identity"))) await tx.store.put(key, "identity");
    await tx.done;
  }
  async getProfile() {
    const record = await (await this.database).get("settings", "profile");
    return storedProfile(record);
  }
  async saveProfile(profile: Profile) {
    await (await this.database).put("settings", profile.revision ? publicProfile(profile) : profile, "profile");
  }
  async getPeerProfiles() {
    const records = await (await this.database).getAll("settings", IDBKeyRange.bound("peer/", "peer0", false, true));
    return records.map(fullProfile).filter((profile): profile is Profile => !!profile);
  }
  async savePeerProfile(profile: Profile) {
    const tx = (await this.database).transaction("settings", "readwrite");
    const key = "peer/" + profile.id;
    const previous = fullProfile(await tx.store.get(key));
    if ((previous?.revision ?? 0) < (profile.revision ?? 0)) await tx.store.put(publicProfile(profile), key);
    await tx.done;
  }
  async getConversations() {
    return (await (await this.database).getAll("conversations")).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }
  async saveConversation(conversation: Conversation) {
    await (await this.database).put("conversations", conversation);
  }
  async getLatestMessage(peerId: string) {
    const db = await this.database;
    const range = IDBKeyRange.bound([peerId, -Infinity], [peerId, Infinity]);
    const cursor = await db.transaction("messages").store.index("by-peer-time").openCursor(range, "prev");
    return cursor?.value;
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
    const record = await (await this.database).get("attachments", id);
    if (!record || record.folder) return undefined;
    try { return await attachmentFile(await this.directory(), record); }
    catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
      throw error;
    }
  }
  getAttachmentSource(id: string) { return this.getAttachment(id); }
  exportAttachment(message: Message, target?: FileDestination) {
    if (target) return copySavedFile(this, message, target);
    return exportBrowserAttachment(message, async () => {
      const record = await (await this.database).get("attachments", message.id);
      if (!record) throw new Error("附件尚未接收完成或已被清除");
      return { record, directory: await this.directory() };
    }, async () => {
      const stage = await this.begin({ id: newId(), fileName: "export.zip", size: 0 }, false);
      try {
        const handle = await stage.root.getFileHandle("file", { create: true });
        const stream = await openWritable(handle);
        const abort = async () => { await stream.abort().catch(() => {}); await stage.abort(); };
        this.writers.set(stage.record.path, { id: stage.record.path, abort });
        return { handle, stream, dispose: abort };
      } catch (error) { await stage.abort().catch(() => {}); throw error; }
    });
  }
  async saveAttachment(id: string, blob: Blob) {
    await metrics.timed("storage.saveAttachment", blob.size, async () => {
      const writer = await this.openFileDestination({ id, size: blob.size, mimeType: blob.type,
        fileName: blob instanceof File ? blob.name : "attachment" });
      try { await writer.write(blob); await writer.close(); }
      catch (error) { await writer.abort().catch(() => {}); throw error; }
    });
  }

  async getCachedUsage() {
    const cached = await (await this.database).get("settings", "storage-usage") as StorageUsage | undefined;
    return cached ?? null;
  }

  async scanUsage(previous?: number): Promise<StorageUsage> {
    const estimate = await navigator.storage?.estimate?.();
    const tx = (await this.database).transaction(["settings", "messages", "attachments"], "readwrite");
    const cached = await tx.objectStore("settings").get("storage-usage") as StorageUsage | undefined;
    if (cached && cached.completedAt !== previous) return cached;
    const files = await this.listFiles(tx, 0);
    const result = { completedAt: Date.now(), usage: estimate?.usage, files };
    await tx.objectStore("settings").put(result, "storage-usage");
    await tx.done;
    return result;
  }

  async getFiles(minSize = 0) {
    const tx = (await this.database).transaction(["messages", "attachments", "settings"], "readonly");
    return this.listFiles(tx, minSize);
  }

  private async listFiles(
    tx: IDBPTransaction<ChatDatabase, ("messages" | "attachments" | "settings")[], "readonly" | "readwrite">,
    minSize: number,
  ) {
    const files: Message[] = [];
    let cursor = await tx.objectStore("attachments").openCursor();
    while (cursor) {
      // Records are published only after the exact declared byte count is written.
      if (cursor.value.size >= minSize) {
        const message = await tx.objectStore("messages").get(cursor.key);
        if (message && message.kind !== "text")
          files.push({ ...message, size: cursor.value.size });
      }
      cursor = await cursor.continue();
    }
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
    const selected = new Set(ids);
    await this.abortWriters((id) => selected.has(id));
    const tx = (await this.database).transaction(
      ["settings", "messages", "attachments", "pendingAttachments"],
      "readwrite",
    );
    const records = await this.markDeleted(tx, selected);
    await Promise.all([...selected].map((id) => tx.objectStore("messages").delete(id)));
    await tx.done;
    await this.removeRecords(records);
  }

  async deleteConversation(peerId: string) {
    const ids = new Set((await this.getMessages(peerId)).map((m) => m.id));
    await this.abortWriters((id) => ids.has(id));
    const tx = (await this.database).transaction(
      ["settings", "conversations", "messages", "attachments", "pendingAttachments"],
      "readwrite",
    );
    await tx.objectStore("conversations").delete(peerId);
    let cursor = await tx
      .objectStore("messages")
      .index("by-peer")
      .openCursor(peerId);
    while (cursor) {
      ids.add(cursor.value.id);
      await cursor.delete();
      cursor = await cursor.continue();
    }
    const records = await this.markDeleted(tx, ids);
    await tx.done;
    await this.removeRecords(records);
  }

  async clearHistory() {
    await this.clear(false);
  }

  private async clear(reset: boolean) {
    await this.abortWriters(() => true);
    const tx = (await this.database).transaction(
      ["settings", "conversations", "messages", "attachments", "pendingAttachments"],
      "readwrite",
    );
    const records = await this.markDeleted(tx);
    await Promise.all([
      tx.objectStore("conversations").clear(),
      tx.objectStore("messages").clear(),
      ...(reset ? [tx.objectStore("settings").clear()] : []),
    ]);
    await tx.done;
    await this.removeRecords(records);
  }

  async resetData() {
    await this.clear(true);
  }

  private async abortWriters(matches: (id: string) => boolean) {
    await Promise.all([...this.writers.values()].filter((w) => matches(w.id)).map((w) => w.abort().catch(() => {})));
  }

  private async markDeleted(
    tx: import("idb").IDBPTransaction<ChatDatabase, ("settings" | "conversations" | "messages" | "attachments" | "pendingAttachments")[], "readwrite">,
    ids?: Set<string>,
  ) {
    const settings = tx.objectStore("settings");
    const cached = await settings.get("storage-usage") as StorageUsage | undefined;
    if (cached) {
      cached.files = ids ? cached.files.filter((file) => !ids.has(file.id)) : [];
      await settings.put(cached, "storage-usage");
    }
    const records: AttachmentRecord[] = [];
    const attachments = tx.objectStore("attachments");
    const pending = tx.objectStore("pendingAttachments");
    let cursor = await attachments.openCursor();
    while (cursor) {
      if (!ids || ids.has(cursor.key)) {
        await pending.put({ id: cursor.key, record: cursor.value, cancelled: true }, cursor.value.path);
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }
    let staged = await pending.openCursor();
    while (staged) {
      if (!ids || ids.has(staged.value.id)) {
        records.push(staged.value.record);
        await staged.update({ ...staged.value, cancelled: true });
      }
      staged = await staged.continue();
    }
    return records;
  }

  private async removeRecords(records: AttachmentRecord[]) {
    if (!records.length) return;
    const directory = await this.directory();
    const db = await this.database;
    for (const record of records) {
      const name = this.lockName(record.path);
      if (activePaths.has(name)) continue;
      const remove = async () => {
        await removeEntry(directory, record.path);
        await db.delete("pendingAttachments", record.path);
      };
      try {
        if (navigator.locks) await navigator.locks.request(name, { ifAvailable: true }, (lock) => lock ? remove() : undefined);
        else await remove();
      } catch { /* Still tracked as cancelled; never exposed as a saved attachment. */ }
    }
  }

  /** Useful for adapter replacement and tests. This does not remove stored data. */
  async close() {
    await this.abortWriters(() => true);
    await this.files?.catch(() => {});
    (await this.database).close();
  }
}

export type StorageAdapterFactory = (
  options?: Record<string, unknown>,
) => StorageAdapter | Promise<StorageAdapter>;
const adapters = new Map<string, StorageAdapterFactory>([
  [
    "desktop",
    async () => (await import("./storage/desktop")).createDesktopStorage(),
  ],
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

/** Additional storage backends can register here without changing the chat UI. */
export function registerStorageAdapter(
  type: string,
  factory: StorageAdapterFactory,
) {
  if (!type.trim()) throw new Error("存储适配器名称不能为空");
  adapters.set(type, factory);
}

export async function createStorageAdapter(
  type = isNative() ? "desktop" : "browser",
  options?: Record<string, unknown>,
): Promise<StorageAdapter> {
  const factory = adapters.get(type);
  if (!factory) throw new Error(`未找到存储适配器：${type}`);
  return factory(options);
}
