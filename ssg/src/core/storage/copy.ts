import { STORAGE_CONFIG } from "../../config";
import type { FileDestination, Message, StorageAdapter } from "../types";

/** Export an already committed file into the writer obtained by the original picker. */
export async function copySavedFile(storage: StorageAdapter, message: Message, target: FileDestination) {
  const source = storage.getAttachmentSource
    ? await storage.getAttachmentSource(message.id) : await storage.getAttachment(message.id);
  if (!source || source.size !== message.size) throw new Error("附件尚未接收完成或已被清除");
  for (let at = 0; at < source.size; at += STORAGE_CONFIG.chunkBytes) {
    const end = Math.min(at + STORAGE_CONFIG.chunkBytes, source.size);
    const part = source.slice(at, end);
    const blob = part instanceof Blob ? part : new Blob([await part.arrayBuffer()]);
    if (blob.size !== end - at) throw new Error("文件没有读取完整，请重试");
    await target.write(blob);
  }
  await target.close();
}
