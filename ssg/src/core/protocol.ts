import type { Profile } from "./types";
import { validFolderName, validPath } from "./folders";
import {
  CHUNK_SIZE,
  FOLDER_CONFIG,
  MAX_CONTROL_BYTES,
  MAX_TRANSFER_SIZE,
  MAX_TEXT_BYTES,
  PROFILE_BIO_MAX_LENGTH,
} from "../config";

export {
  CHUNK_SIZE,
  MAX_CONTROL_BYTES,
  MAX_FILE_SIZE,
  MAX_TEXT_BYTES,
} from "../config";
// 以下为线协议布局，不是部署配置；修改需要同时升级通信双方。
export const HEADER_SIZE = 44;
const MAGIC = 0x534e4431;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID needs HTTPS in some browsers; getRandomValues also works on HTTP LAN origins.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type ControlPacket =
  | { type: "peer-ping" | "peer-pong"; id: string }
  | {
      type: "folder-start";
      id: string;
      fileName: string;
      size: number;
      fileCount: number;
      directoryCount: number;
      createdAt: number;
    }
  | { type: "folder-supported"; id: string }
  | { type: "folder-end"; id: string }
  | {
      type: "folder-entry";
      id: string;
      index: number;
      path: string;
      kind: "directory" | "file";
      size: number;
    }
  | {
      type: "folder-entry-ready" | "folder-entry-end" | "folder-entry-saved";
      id: string;
      index: number;
    }
  | { type: "text"; id: string; text: string; createdAt: number }
  | {
      type: "file-start";
      id: string;
      kind: "image" | "file";
      fileName: string;
      mimeType: string;
      size: number;
      createdAt: number;
    }
  | { type: "file-end"; id: string }
  | { type: "file-accept"; id: string; streaming?: boolean }
  | { type: "file-progress"; id: string; received: number }
  | { type: "ack"; id: string }
  | { type: "transfer-error"; id: string; message: string };

export function parseControlPacket(raw: string): ControlPacket | null {
  if (
    raw.length > MAX_CONTROL_BYTES ||
    encoder.encode(raw).byteLength > MAX_CONTROL_BYTES
  )
    return null;
  let packet: unknown;
  try {
    packet = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!packet || typeof packet !== "object") return null;
  const p = packet as Record<string, unknown>;
  if (typeof p.id !== "string" || !uuidPattern.test(p.id)) return null;
  if (p.type === "peer-ping" || p.type === "peer-pong")
    return { type: p.type, id: p.id };
  if (p.type === "folder-supported" || p.type === "folder-end")
    return { type: p.type, id: p.id };
  if (
    typeof p.index === "number" &&
    Number.isSafeInteger(p.index) &&
    p.index >= 0 &&
    p.index < FOLDER_CONFIG.maxEntries
  ) {
    if (
      p.type === "folder-entry-ready" ||
      p.type === "folder-entry-end" ||
      p.type === "folder-entry-saved"
    )
      return { type: p.type, id: p.id, index: p.index };
    if (
      p.type === "folder-entry" &&
      validPath(p.path) &&
      (p.kind === "directory" || p.kind === "file") &&
      typeof p.size === "number" &&
      Number.isSafeInteger(p.size) &&
      p.size >= 0 &&
      p.size <= MAX_TRANSFER_SIZE &&
      (p.kind === "file" || p.size === 0)
    )
      return {
        type: p.type,
        id: p.id,
        index: p.index,
        path: p.path,
        kind: p.kind,
        size: p.size,
      };
  }
  if (p.type === "file-accept")
    return {
      type: p.type,
      id: p.id,
      ...(p.streaming === true ? { streaming: true } : {}),
    };
  if (p.type === "ack" || p.type === "file-end")
    return { type: p.type, id: p.id };
  if (
    p.type === "file-progress" &&
    typeof p.received === "number" &&
    Number.isSafeInteger(p.received) &&
    p.received >= 0 &&
    p.received <= MAX_TRANSFER_SIZE
  )
    return { type: p.type, id: p.id, received: p.received };
  if (
    p.type === "transfer-error" &&
    typeof p.message === "string" &&
    p.message.length <= 250
  )
    return { type: p.type, id: p.id, message: p.message };
  if (
    typeof p.createdAt !== "number" ||
    !Number.isSafeInteger(p.createdAt) ||
    p.createdAt < 0
  )
    return null;
  if (
    p.type === "text" &&
    typeof p.text === "string" &&
    p.text.trim() &&
    encoder.encode(p.text).byteLength <= MAX_TEXT_BYTES
  ) {
    return { type: "text", id: p.id, text: p.text, createdAt: p.createdAt };
  }
  if (
    p.type === "folder-start" &&
    validFolderName(p.fileName) &&
    typeof p.size === "number" &&
    Number.isSafeInteger(p.size) &&
    p.size >= 0 &&
    p.size <= MAX_TRANSFER_SIZE &&
    typeof p.fileCount === "number" &&
    Number.isSafeInteger(p.fileCount) &&
    p.fileCount >= 0 &&
    typeof p.directoryCount === "number" &&
    Number.isSafeInteger(p.directoryCount) &&
    p.directoryCount >= 0 &&
    p.fileCount + p.directoryCount <= FOLDER_CONFIG.maxEntries &&
    (p.fileCount > 0 || p.size === 0)
  )
    return {
      type: p.type,
      id: p.id,
      fileName: p.fileName,
      size: p.size,
      fileCount: p.fileCount,
      directoryCount: p.directoryCount,
      createdAt: p.createdAt,
    };
  if (
    p.type === "file-start" &&
    (p.kind === "image" || p.kind === "file") &&
    typeof p.fileName === "string" &&
    p.fileName.length > 0 &&
    p.fileName.length <= 255 &&
    typeof p.mimeType === "string" &&
    p.mimeType.length <= 128 &&
    typeof p.size === "number" &&
    Number.isSafeInteger(p.size) &&
    p.size >= 0 &&
    p.size <= MAX_TRANSFER_SIZE
  ) {
    return {
      type: p.type,
      id: p.id,
      kind: p.kind,
      fileName: p.fileName,
      mimeType: p.mimeType,
      size: p.size,
      createdAt: p.createdAt,
    };
  }
  return null;
}

export function encodeChunk(
  id: string,
  sequence: number,
  data: ArrayBuffer,
): ArrayBuffer {
  if (
    !uuidPattern.test(id) ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    sequence >= 2 ** 32 ||
    data.byteLength > CHUNK_SIZE ||
    !data.byteLength
  )
    throw new Error("无效的数据块");
  const buffer = new ArrayBuffer(HEADER_SIZE + data.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC);
  new Uint8Array(buffer, 4, 36).set(encoder.encode(id));
  view.setUint32(40, sequence);
  new Uint8Array(buffer, HEADER_SIZE).set(new Uint8Array(data));
  return buffer;
}

export function decodeChunk(
  buffer: ArrayBuffer,
): { id: string; sequence: number; data: Uint8Array<ArrayBuffer> } | null {
  if (
    buffer.byteLength <= HEADER_SIZE ||
    buffer.byteLength > HEADER_SIZE + CHUNK_SIZE
  )
    return null;
  const view = new DataView(buffer);
  if (view.getUint32(0) !== MAGIC) return null;
  const id = decoder.decode(new Uint8Array(buffer, 4, 36));
  if (!uuidPattern.test(id)) return null;
  return {
    id,
    sequence: view.getUint32(40),
    data: new Uint8Array(buffer.slice(HEADER_SIZE)),
  };
}

export function isProfile(value: unknown): value is Profile {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    uuidPattern.test(p.id) &&
    (p.numericId === undefined || isNumericId(p.numericId)) &&
    typeof p.name === "string" &&
    p.name.trim().length > 0 &&
    p.name.length <= 40 &&
    typeof p.bio === "string" &&
    p.bio.length <= PROFILE_BIO_MAX_LENGTH &&
    typeof p.color === "string" &&
    /^#[0-9a-f]{6}$/i.test(p.color) &&
    typeof p.avatar === "string" &&
    p.avatar.length > 0 &&
    p.avatar.length <= 16 &&
    typeof p.device === "string" &&
    p.device.length <= 64 &&
    (p.clientType === "web" || p.clientType === "app")
  );
}

export function isNumericId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{5}$/.test(value);
}
