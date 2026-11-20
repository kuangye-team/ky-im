import type { Connection, Stream } from "@libp2p/interface";
import { byteStream } from "@libp2p/utils";
import { Uint8ArrayList } from "uint8arraylist";
import type { PeerHealth, TransportChannel } from "../types";
import { priorityControl, transferId } from "../sendQueue";
import { runtimeLog } from "../../../runtime-logs";
import { CONNECTION_CONFIG, MAX_FILE_CHUNK_BYTES } from "../../../config";
import { HEADER_SIZE, newId } from "../../protocol";
import { bindingControl, bulkDescriptor, BULK_OPEN, type BulkDataChannel } from "./rtc-bulk";
import { drain } from "./flow";

export const CHAT_PROTOCOL = "/hummingbird/chat/2.0.0",
  FILE_PROTOCOL = "/hummingbird/file/2.0.0",
  PING_PROTOCOL = "/hummingbird/ping/2.0.0";
export const MAX_FRAME = MAX_FILE_CHUNK_BYTES + HEADER_SIZE;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function frame(data: string | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const bytes =
    typeof data === "string"
      ? encoder.encode(data)
      : new Uint8Array(data);
  if (!bytes.length || bytes.length > MAX_FRAME)
    throw new Error("内容过大，无法发送");
  const out = new Uint8Array(5 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out[4] = typeof data === "string" ? 1 : 2;
  out.set(bytes, 5);
  return out;
}
async function* incomingBytes(stream: Stream, webTransport: boolean) {
  if (webTransport) {
    // The WebTransport adapter owns one ReadableStream reader. Resuming it per
    // frame can start overlapping reads or attempt to reuse a released lock.
    // Bound queued bytes while the consumer writes to disk.
    const reader = byteStream(stream, {maxBufferSize: 4 * MAX_FRAME});
    for (let chunk = await reader.read(); chunk; chunk = await reader.read()) yield chunk;
    return;
  }
  for await (const chunk of stream) {
    if (stream.readStatus === "readable") stream.pause();
    yield chunk;
    if (stream.readStatus === "paused") stream.resume();
  }
}

export async function readFrames(
  stream: Stream,
  receive: (data: string | ArrayBuffer) => Promise<void>,
  webTransport = false,
) {
  const buffer = new Uint8ArrayList();
  for await (const chunk of incomingBytes(stream, webTransport)) {
    buffer.append(chunk);
    while (buffer.byteLength >= 5) {
      const size = buffer.getUint32(0),
        kind = buffer.get(4);
      if (!size || size > MAX_FRAME || ![1, 2].includes(kind))
        throw new Error("Invalid frame");
      if (buffer.byteLength < 5 + size) break;
      // Make one owned frame directly from the segments; library input can be a pooled view.
      const bytes = buffer.slice(5, 5 + size);
      buffer.consume(5 + size);
      await receive(
        kind === 1
          ? decoder.decode(bytes)
          : bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer : new Uint8Array(bytes).buffer,
      );
    }
    if (buffer.byteLength > MAX_FRAME + 5) throw new Error("Frame limit");
  }
  if (buffer.byteLength) throw new Error("Incomplete frame");
}
export class ProtocolChannel extends EventTarget implements TransportChannel {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly separateControl = true;
  readonly maxMessageSize = MAX_FRAME;
  onopen: TransportChannel["onopen"] = null;
  onpinganswered?: TransportChannel["onpinganswered"];
  onclose: TransportChannel["onclose"] = null;
  onerror: TransportChannel["onerror"] = null;
  onmessage: TransportChannel["onmessage"] = null;
  readonly attemptId = newId();
  connection?: Connection;
  bulk?: () => BulkDataChannel | undefined;
  get bulkFilePayloadBytes() { return this.bulk?.()?.filePayloadBytes; }
  rtcSample?: TransportChannel["rtcSample"];
  get connectionId() { return this.connection?.id; }
  causeEventId?: string;
  readonly lifetime = new AbortController();
  streams = new Map<string, Stream>();
  private queues = new Map<string, { bytes: Uint8Array<ArrayBuffer>; id?: string; large: boolean }[]>();
  private requestedBulk = false;
  private writing = new Set<string>();
  constructor(
    readonly peer: string,
    readonly probe: (signal: AbortSignal, requestId?: string) => Promise<PeerHealth>,
  ) {
    super();
  }
  attach(protocol: string, stream: Stream, connection: Connection) {
    if (this.readyState === "closed" || this.streams.has(protocol) || this.connection !== connection) {
      stream.abort(new Error("Duplicate stream"));
      return;
    }
    this.streams.set(protocol, stream);
    const ended = (error?: unknown) => {
      if (this.streams.get(protocol) !== stream) return;
      this.causeEventId = runtimeLog("warn", "connection", "接收中断", {
        peerId: this.peer, detail: String(error ?? "EOF"),
        raw: { layer: "libp2p", protocol, streamId: stream.id, streamState: stream.status,
          connectionId: connection.id, activeConnectionId: this.connectionId, direction: stream.direction,
          error, origin: error instanceof Error && error.name === "StreamResetError" ? "remote-reset" : "unknown",
          action: this.readyState === "open" ? "close-channel" : "release-candidate" },
      });
      if (this.readyState === "open") this.close();
      else { this.release(connection); connection.abort(new Error("Incomplete channel")); }
    };
    const bulkChat = protocol === CHAT_PROTOCOL ? this.bulk?.() : undefined;
    const sendBinding = async (payload: Uint8Array<ArrayBuffer>) => {
      if (!stream.send(frame(payload.buffer))) await drain(stream);
    };
    if (bulkChat?.enabled) void bulkChat.hello().then(sendBinding).catch(ended);
    void readFrames(stream, async (data) => {
      if (this.readyState === "closed") return;
      if (bulkChat?.enabled && typeof data !== "string" && bindingControl(new Uint8Array(data))) {
        const response = await bulkChat.onBinding(new Uint8Array(data));
        if (response) await sendBinding(response);
        return;
      }
      if (protocol === FILE_PROTOCOL && typeof data !== "string") {
        const bulk = this.bulk?.();
        const bytes = new Uint8Array(data);
        if (bytes.length === BULK_OPEN.length && BULK_OPEN.every((v, i) => bytes[i] === v)) {
          bulk?.prepare();
          return;
        }
        if (bulkDescriptor(bytes)) {
          if (!bulk) throw new Error("文件连接已断开");
          data = await bulk.receive(new Uint8Array(data));
        }
      }
      await new Promise<void>((resolve) => {
        if (this.onmessage) this.onmessage({ data, consumed: resolve });
        else resolve();
      });
    }, connection.multiplexer === "/webtransport")
      .then(() => ended(), ended);
    if (this.streams.size === 2) {
      this.readyState = "open";
      this.onopen?.(new Event("open"));
    }
  }
  send(data: string | ArrayBuffer, largeFileChunk = false) {
    if (this.readyState !== "open") throw new Error("设备连接已断开");
    const bytes = frame(data),
      protocol = priorityControl(data) ? CHAT_PROTOCOL : FILE_PROTOCOL;
    if (this.bufferedAmount + bytes.length > 1024 * 1024 && this.bufferedAmount > CONNECTION_CONFIG.sendBufferHighBytes)
      throw new Error("传输繁忙，请稍后重试");
    this.bufferedAmount += bytes.length;
    const queue = this.queues.get(protocol) ?? [];
    queue.push({ bytes, id: transferId(data), large: largeFileChunk && typeof data !== "string" });
    this.queues.set(protocol, queue);
    void this.flush(protocol);
  }
  private async flush(protocol: string) {
    if (this.writing.has(protocol)) return;
    this.writing.add(protocol);
    try {
      const stream = this.streams.get(protocol)!;
      const queue = this.queues.get(protocol)!;
      while (queue.length && this.readyState === "open") {
        const item = queue.shift()!;
        let bytes = item.bytes;
        const bulk = item.large && this.bulk?.();
        if (bulk && await bulk.bound()) {
          if (!this.requestedBulk) {
            this.requestedBulk = true;
            if (!stream.send(frame(BULK_OPEN.buffer))) await drain(stream);
          }
          const descriptor = await bulk.send(bytes.subarray(5));
          if (descriptor) bytes = frame(descriptor.buffer);
        }
        if (!stream.send(bytes))
          await drain(stream);
        this.bufferedAmount = Math.max(
          0,
          this.bufferedAmount - item.bytes.length,
        );
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold)
          this.dispatchEvent(new Event("bufferedamountlow"));
      }
    } catch (error) {
      this.causeEventId ??= runtimeLog("warn", "connection", "发送中断", {
        peerId: this.peer,
        detail: String(error), raw: { error, protocol, connectionId: this.connectionId, action: "close-channel" },
      });
      this.close();
    } finally {
      this.writing.delete(protocol);
    }
  }
  cancelTransfer(id: string) {
    for (const queue of this.queues.values())
      for (let index = queue.length - 1; index >= 0; index--)
        if (queue[index].id === id) {
          this.bufferedAmount -= queue[index].bytes.length;
          queue.splice(index, 1);
        }
    if (this.bufferedAmount <= this.bufferedAmountLowThreshold)
      this.dispatchEvent(new Event("bufferedamountlow"));
  }
  release(connection: Connection) {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.requestedBulk = false;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.abort(new Error("Channel closed"));
  }
  close() {
    if (this.readyState === "closed") return;
    this.causeEventId ??= runtimeLog("debug", "connection", "关闭业务通道", {peerId: this.peer,
      raw: {layer: "libp2p", attemptId: this.attemptId, connectionId: this.connectionId ?? null,
        action: "close-channel", origin: "local", previousState: this.readyState}});
    this.readyState = "closed";
    this.lifetime.abort();
    if (this.connection) this.release(this.connection);
    this.queues.clear();
    this.bufferedAmount = 0;
    this.dispatchEvent(new Event("close"));
    this.onclose?.(new Event("close"));
  }
}
