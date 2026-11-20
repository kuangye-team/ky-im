import { STORAGE_CONFIG } from "../../config";
import { usesBulkFile } from "../network/libp2p/rtc-bulk";
import { CHUNK_SIZE, HEADER_SIZE } from '../protocol';
import type { TransportChannel } from '../network/types';
import type { AttachmentSource } from "../types";

export const imageTypes = /^(image\/(png|jpeg|gif|webp|avif|bmp))$/i;

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试"; }
export function fileChunkSize(channel: TransportChannel): number {
  const limit = channel.maxMessageSize;
  const size = Math.min(CHUNK_SIZE, limit === undefined ? CHUNK_SIZE : limit - HEADER_SIZE);
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error("对方暂不支持接收文件，请更新后重试");
  return size;
}

export async function readFileBlock(file: AttachmentSource, offset: number, readBytes: number) {
  const end = Math.min(file.size, offset + readBytes);
  const read = async (start: number, stop: number) => {
    const part = await file.slice(start, stop).arrayBuffer();
    if (part.byteLength !== stop - start) throw new Error("文件已发生变化，请重新选择文件");
    return part;
  };
  if (end - offset <= STORAGE_CONFIG.chunkBytes) return read(offset, end);
  // A single RTC record may span multiple reads from a bounded storage source.
  const block = new Uint8Array(end - offset);
  for (let at = offset; at < end; at += STORAGE_CONFIG.chunkBytes) {
    const part = await read(at, Math.min(end, at + STORAGE_CONFIG.chunkBytes));
    block.set(new Uint8Array(part), at - offset);
  }
  return block.buffer;
}

/** Keep intermediate disk reads on record boundaries, including after resuming at an arbitrary offset. */
export function singleFileReadPlan(channel: TransportChannel, size: number, offset = 0, sequence = 0) {
  const chunkBytes = fileChunkSize(channel);
  const bulk = usesBulkFile(size) ? channel.bulkFilePayloadBytes : undefined;
  const preferred = bulk === undefined ? undefined : Math.min(bulk, (channel.maxMessageSize ?? Infinity) - HEADER_SIZE);
  // A 32-bit sequence must still address every remaining byte of a maximum-size file.
  if (preferred !== undefined && Number.isSafeInteger(preferred) && preferred > 0 &&
      Math.ceil((size - offset) / preferred) <= 2 ** 32 - sequence) {
    return { chunkBytes: preferred, readBytes: Math.max(1, Math.floor(STORAGE_CONFIG.chunkBytes / preferred)) * preferred };
  }
  return { chunkBytes, readBytes: STORAGE_CONFIG.chunkBytes };
}
