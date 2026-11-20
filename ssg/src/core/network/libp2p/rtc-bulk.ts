import { MAX_FILE_CHUNK_BYTES, MAX_RTC_MESSAGE_BYTES } from "../../../config";
import { HEADER_SIZE } from "../../protocol";
import { pEvent } from "p-event";
import { rtcFileChunkBytes, rtcLowWater, waitForRtcBuffer } from "./rtc-limits";

export const bulkAttribute = "a=x-hummingbird-file:2";
export const BULK_LABEL = "hummingbird-file-v2";
export const BULK_OPEN = Uint8Array.of(83, 78, 79, 50); // SNO2, authenticated file-stream request
export function usesBulkFile(size: number) { return size > 2 * 1024 * 1024; }
const MAX_RECORD = MAX_FILE_CHUNK_BYTES + HEADER_SIZE;
const SLOT_BYTES = 8; // Reserve room for each fragment reference before accepting the record.
const MAX_BUFFER = 16 * 1024 * 1024;
const HEADER = 16; // random record ID, fragment index, fragment count
const marker = [83, 78, 68, 51]; // SND3, carried only inside the authenticated file stream

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HELLO = "SNB2", READY = "SNK2", DISABLE = "SNN2";

export function bindingControl(bytes: Uint8Array) {
  const tag = decoder.decode(bytes.subarray(0, 4));
  return tag === HELLO || tag === READY || tag === DISABLE;
}

// This PC carries only SCTP. Resolve the actual transport's certificate IDs, never a signaling peer's assertion.
async function certificatePair(pc: RTCPeerConnection) {
  if (pc.sctp?.transport.state !== "connected") return;
  const stats = await pc.getStats();
  const transports = [...stats.values()].filter(s => s.type === "transport" && s.dtlsState === "connected");
  if (transports.length !== 1) return;
  const read = (id: string) => {
    const cert = stats.get(id);
    if (cert?.type !== "certificate" || cert.fingerprintAlgorithm?.toLowerCase() !== "sha-256" ||
        !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i.test(cert.fingerprint)) return;
    return cert.fingerprint.replaceAll(":", "").toLowerCase() as string;
  };
  const local = read(transports[0].localCertificateId), remote = read(transports[0].remoteCertificateId);
  if (local && remote && local !== remote) return { local, remote };
}

export function bulkDescriptor(data: Uint8Array) {
  return data.length === 20 && marker.every((v, i) => data[i] === v);
}

function recordId(bytes: Uint8Array) {
  return String.fromCharCode(...bytes.subarray(0, 12));
}

type Assembly = { parts: (Uint8Array | undefined)[]; count: number; size: number; since: number };

/** Noise authenticates the DTLS endpoints once for this RTC session. DTLS protects the fragments. */
export class BulkDataChannel {
  enabled = false;
  private dc?: RTCDataChannel;
  private started = false;
  private evidence?: ReturnType<typeof certificatePair>;
  private verified = false;
  private confirmed = false;
  private stopped = new AbortController();
  private changed = new EventTarget();
  private records = new Map<string, Assembly>();
  private buffered = 0;
  sentBytes = 0;
  receivedBytes = 0;
  constructor(private pc: RTCPeerConnection, private dialer: boolean,
    private limit: () => number, private high: number, private sessionId: string) {}

  negotiate(sdp: string, supported: boolean) {
    this.enabled = supported && sdp.split(/\r?\n/).includes(bulkAttribute);
  }
  private certificates() {
    // A missing stats result must also release the Noise stream that carried the binding.
    return this.evidence ??= new Promise(resolve => {
      const timer = setTimeout(() => resolve(undefined), 3000);
      void certificatePair(this.pc).then(resolve, () => resolve(undefined)).finally(() => clearTimeout(timer));
    });
  }
  async hello() {
    const pair = await this.certificates();
    if (!pair) { this.close(); return encoder.encode(DISABLE); }
    return encoder.encode(HELLO + this.sessionId + pair.local + pair.remote);
  }
  async onBinding(bytes: Uint8Array) {
    if (!this.enabled || this.stopped.signal.aborted) return;
    const message = decoder.decode(bytes);
    if (message === READY) {
      this.confirmed = true;
    } else if (message === DISABLE) {
      this.close();
      return;
    } else {
      const pair = await this.certificates();
      if (!pair || message !== HELLO + this.sessionId + pair.remote + pair.local) {
        this.close();
        return encoder.encode(DISABLE);
      }
      this.verified = true;
    }
    if (this.verified && this.confirmed) this.changed.dispatchEvent(new Event("bound"));
    if (message !== READY) return encoder.encode(READY);
  }
  async bound() {
    if (!this.enabled || this.stopped.signal.aborted) return false;
    if (this.verified && this.confirmed) return true;
    try {
      await pEvent(this.changed, "bound", {
        signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(3000)]),
      });
      return this.verified && this.confirmed && !this.stopped.signal.aborted;
    } catch { this.close(); return false; }
  }
  prepare() {
    if (!this.verified || !this.enabled || this.started || !this.dialer || this.stopped.signal.aborted) return;
    this.started = true;
    try { this.attach(this.pc.createDataChannel(BULK_LABEL, { ordered: false })); }
    catch { this.close(); }
  }
  attach(dc: RTCDataChannel) {
    if (!this.verified || this.dc || this.stopped.signal.aborted || dc.label !== BULK_LABEL || dc.ordered ||
        dc.maxRetransmits != null || dc.maxPacketLifeTime != null) { dc.close(); return; }
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = rtcLowWater;
    dc.onopen = () => this.changed.dispatchEvent(new Event("open"));
    if (dc.readyState === "open") this.changed.dispatchEvent(new Event("open"));
    dc.onmessage = e => {
      try {
        if (!(e.data instanceof ArrayBuffer)) throw new Error("文件分片无效");
        this.admit(new Uint8Array(e.data));
      } catch { this.close(); }
    };
    dc.onclose = dc.onerror = () => this.close();
  }
  get filePayloadBytes() {
    const stride = this.limit() - HEADER;
    if (!this.enabled || this.stopped.signal.aborted || stride <= 0) return undefined;
    return rtcFileChunkBytes;
  }
  get queueBytes() { return this.dc?.bufferedAmount ?? 0; }
  close() {
    if (this.stopped.signal.aborted) return;
    this.stopped.abort();
    this.dc?.close();
    this.records.clear();
    this.buffered = 0;
  }
  private admit(packet: Uint8Array) {
    if (packet.length <= HEADER || packet.length > MAX_RTC_MESSAGE_BYTES) throw new Error("文件分片无效");
    const view = new DataView(packet.buffer, packet.byteOffset);
    const index = view.getUint16(12), count = view.getUint16(14);
    if (!count || index >= count) throw new Error("文件分片无效");
    const id = recordId(packet);
    // Map insertion order also orders expiry. Bound unattached fragments when descriptors race the data.
    for (const [key, r] of this.records) {
      if (performance.now() - r.since < 60_000) break;
      this.buffered -= r.size + r.parts.length * SLOT_BYTES;
      this.records.delete(key);
    }
    let r = this.records.get(id);
    if (!r) {
      if (this.records.size >= 256 || this.buffered + count * SLOT_BYTES > MAX_BUFFER) throw new Error("文件接收缓冲已满");
      this.buffered += count * SLOT_BYTES;
      r = { parts: new Array(count), count: 0, size: 0, since: performance.now() };
      this.records.set(id, r);
    }
    if (r.parts.length !== count) throw new Error("文件分片无效");
    if (r.parts[index]) return;
    const part = packet.subarray(HEADER);
    if (r.size + part.length > MAX_RECORD || this.buffered + part.length > MAX_BUFFER)
      throw new Error("文件接收缓冲已满");
    r.parts[index] = part;
    r.size += part.length;
    this.buffered += part.length;
    this.receivedBytes += part.length;
    if (++r.count === count) this.changed.dispatchEvent(new Event("record"));
  }
  async send(plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | undefined> {
    if (!plain.length || plain.length > MAX_RECORD || !this.verified || !this.confirmed || this.stopped.signal.aborted) return;
    this.prepare();
    const signal = this.stopped.signal;
    try {
      if (this.dc?.readyState !== "open")
        await pEvent(this.changed, "open", { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      const dc = this.dc!;
      const stride = this.limit() - HEADER;
      if (stride <= 0) return;
      const count = Math.ceil(plain.length / stride);
      if (count > 0xffff) return;
      const descriptor = new Uint8Array(20);
      descriptor.set(marker);
      const id = crypto.getRandomValues(descriptor.subarray(4, 16));
      new DataView(descriptor.buffer).setUint32(16, plain.length);
      const size = Math.floor(plain.length / count);
      const extra = plain.length % count;
      let offset = 0;
      for (let i = 0; i < count; i++) {
        const end = offset + size + (i < extra ? 1 : 0);
        const part = plain.subarray(offset, end);
        offset = end;
        const packet = new Uint8Array(HEADER + part.length);
        packet.set(id);
        const view = new DataView(packet.buffer);
        view.setUint16(12, i); view.setUint16(14, count);
        packet.set(part, HEADER);
        if (dc.bufferedAmount + packet.length > this.high)
          await waitForRtcBuffer(dc, packet.length, this.high, AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
        dc.send(packet);
        this.sentBytes += part.length;
      }
      return descriptor;
    } catch {
      // No descriptor has been published. The complete original frame can still use the ordered stream.
      this.close();
    }
  }
  async receive(descriptor: Uint8Array<ArrayBuffer>) {
    const length = new DataView(descriptor.buffer, descriptor.byteOffset).getUint32(16);
    if (!length || length > MAX_RECORD || !this.verified || this.stopped.signal.aborted) throw new Error("文件分片无效");
    const id = recordId(descriptor.subarray(4));
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(60_000)]);
    let record = this.records.get(id);
    while (!record || record.count !== record.parts.length) {
      signal.throwIfAborted();
      await pEvent(this.changed, "record", {signal});
      record = this.records.get(id);
    }
    this.records.delete(id);
    this.buffered -= record.size + record.parts.length * SLOT_BYTES;
    if (record.size !== length) throw new Error("文件分片长度有误");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of record.parts) { bytes.set(part!, offset); offset += part!.length; }
    return bytes.buffer;
  }
}
