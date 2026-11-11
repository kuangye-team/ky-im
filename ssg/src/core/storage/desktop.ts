import { invoke } from "@tauri-apps/api/core";
import type {
  AttachmentSource,
  Conversation,
  FileDestination,
  FolderDestination,
  Message,
  Profile,
  StorageAdapter,
  StorageInfo,
} from "../types";
import { MAX_FILE_SIZE, STORAGE_CONFIG } from "../../config";

const BLOCK = STORAGE_CONFIG.chunkBytes;
type NativeAttachment = {
  size: number;
  mime: string;
  name: string;
  folder: boolean;
};
type Request = { op: string; [key: string]: unknown };
export type StorageInvoke = <T>(request: Request) => Promise<T>;
const native: StorageInvoke = async <T>(request: Request) => {
  try {
    if (request.op === "write")
      return await invoke<T>("storage_write", request.data as ArrayBuffer, {
        headers: { "x-storage-token": String(request.token) },
      });
    if (request.op === "read") {
      const { id, offset, length } = request;
      return await invoke<T>("storage_read", { id, offset, length });
    }
    return await invoke<T>("storage_request", { request });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};
/** Metadata is in SQLite; payloads are read/written in bounded IPC blocks. */
export class DesktopStorageAdapter implements StorageAdapter {
  readonly name = "SQLite + 本地文件系统";
  constructor(private readonly call: StorageInvoke = native) {}
  async getProfile() {
    return (await this.call<Profile | null>({ op: "getProfile" })) ?? undefined;
  }
  async saveProfile(value: Profile) {
    await this.call({ op: "saveProfile", value });
  }
  getConversations() {
    return this.call<Conversation[]>({ op: "getConversations" });
  }
  async saveConversation(value: Conversation) {
    await this.call({ op: "saveConversation", value });
  }
  getMessages(id: string) {
    return this.call<Message[]>({ op: "getMessages", id });
  }
  async saveMessage(value: Message) {
    await this.call({ op: "saveMessage", value });
  }
  getFiles(minimum = 0) {
    return this.call<Message[]>({ op: "getFiles", minimum });
  }
  async deleteMessages(ids: string[]) {
    await this.call({ op: "deleteMessages", ids });
  }
  async deleteConversation(id: string) {
    await this.call({ op: "deleteConversation", id });
  }
  async clearHistory() {
    await this.call({ op: "clearHistory" });
  }
  getStorageInfo() {
    return this.call<StorageInfo>({ op: "info" });
  }
  moveStorage(directory: string) {
    return this.call<StorageInfo>({ op: "move", directory });
  }

  private async begin(
    message: Pick<Message, "id" | "fileName" | "mimeType" | "size">,
    folder: boolean,
  ) {
    return this.call<string>({
      op: "begin",
      id: message.id,
      name: message.fileName || "attachment",
      mime: message.mimeType || "",
      size: message.size || 0,
      folder,
    });
  }
  private writer(token: string, entry = false): FileDestination {
    let closed = false;
    return {
      write: async (blob) => {
        if (closed) throw new Error("文件已关闭");
        for (let offset = 0; offset < blob.size; offset += BLOCK) {
          const data = await blob.slice(offset, offset + BLOCK).arrayBuffer();
          if (closed) throw new Error("文件已关闭");
          await this.call({ op: "write", token, data });
        }
      },
      close: async () => {
        if (closed) return;
        await this.call({ op: entry ? "closeEntry" : "finish", token });
        closed = true;
      },
      // Aborting a folder entry aborts the whole transfer, even after that entry closed.
      abort: async () => {
        closed = true;
        await this.call({ op: "abort", token });
      },
    };
  }
  async createFileDestination(message: Message) {
    return this.writer(await this.begin(message, false));
  }
  async createFolderDestination(message: Message): Promise<FolderDestination> {
    const token = await this.begin(message, true);
    return {
      createDirectory: async (path) => {
        await this.call({ op: "directory", token, path });
      },
      createFile: async (path, size = 0) => {
        await this.call({ op: "entry", token, path, size });
        return this.writer(token, true);
      },
      close: async () => {
        await this.call({ op: "finish", token });
      },
      abort: async () => {
        await this.call({ op: "abort", token });
      },
    };
  }
  async saveAttachment(id: string, blob: Blob) {
    // A File retains its name; unnamed Blobs use a generic attachment name.
    const destination = this.writer(
      await this.begin(
        {
          id,
          size: blob.size,
          mimeType: blob.type,
          fileName: "name" in blob ? String(blob.name) : "attachment",
        },
        false,
      ),
    );
    try {
      await destination.write(blob);
      await destination.close();
    } catch (error) {
      await destination.abort().catch(() => undefined);
      throw error;
    }
  }
  async getAttachmentSource(id: string): Promise<AttachmentSource | undefined> {
    const attachment = await this.call<NativeAttachment | null>({
      op: "attachment",
      id,
    });
    if (!attachment || attachment.folder) return undefined;
    return {
      size: attachment.size,
      type: attachment.mime,
      name: attachment.name,
      slice: (start, end) => ({
        arrayBuffer: async () => {
          const length = Math.max(0, Math.min(end, attachment.size) - start);
          if (length > BLOCK) throw new Error("读取块过大");
          const data = await this.call<ArrayBuffer>({
            op: "read",
            id,
            offset: start,
            length,
          });
          if (!(data instanceof ArrayBuffer) || data.byteLength !== length)
            throw new Error("文件没有读取完整，请重试");
          return data;
        },
      }),
    };
  }
  async getAttachment(id: string): Promise<Blob | undefined> {
    const source = await this.getAttachmentSource(id);
    if (!source) return undefined;
    if (source.size > MAX_FILE_SIZE)
      throw new Error("大文件请使用另存为或转发");
    const chunks: ArrayBuffer[] = [];
    for (let offset = 0; offset < source.size; offset += BLOCK)
      chunks.push(await source.slice(offset, offset + BLOCK).arrayBuffer());
    return new Blob(chunks, { type: source.type });
  }
  async exportAttachment(message: Message) {
    const { save, open } = await import("@tauri-apps/plugin-dialog");
    const attachment = await this.call<NativeAttachment | null>({
      op: "attachment",
      id: message.id,
    });
    if (!attachment) throw new Error("附件尚未接收完成或已被清除");
    let destination: string | null;
    if (attachment.folder) {
      const parent = await open({ directory: true, multiple: false });
      if (!parent) return;
      const { join } = await import("@tauri-apps/api/path");
      // Native create_new semantics keep existing folders untouched.
      destination = await join(
        parent,
        `${attachment.name} (${message.id.slice(0, 8)})`,
      );
    } else {
      destination = await save({
        defaultPath:
          message.fileName?.replace(/[/\\]/g, "_") || attachment.name,
      });
    }
    if (destination)
      await this.call({ op: "export", id: message.id, destination });
  }
  /** Release unfinished native transfers when the renderer starts a new session. */
  async resetTransfers() {
    await this.call({ op: "resetTransfers" });
  }
}
let initialization: Promise<DesktopStorageAdapter> | undefined;
export function createDesktopStorage() {
  // React StrictMode can start bootstrap twice. Share initialization so a second
  // initializer cannot abort active transfers.
  return (initialization ??= initializeDesktopStorage().catch((error) => {
    initialization = undefined;
    throw error;
  }));
}
async function initializeDesktopStorage() {
  const storage = new DesktopStorageAdapter();
  await storage.getStorageInfo();
  await storage.resetTransfers();
  return storage;
}
