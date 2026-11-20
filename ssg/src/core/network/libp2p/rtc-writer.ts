import { transferMetrics as metrics } from "../../transferMetrics";
import { rtcCanSend, rtcHighWater } from "./rtc-limits";

/** Coalesce synchronous Noise/Yamux replies to one incoming DataChannel message. */
export class RtcWriter {
  private readonly batch = new Uint8Array(4096);
  private used = 0;
  private collecting = false;
  private blockedAt?: number;
  private waitedMs = 0;

  get bufferWaitMs() {
    return Math.round(this.waitedMs + (this.blockedAt === undefined ? 0 : performance.now() - this.blockedAt));
  }

  drained() {
    if (this.blockedAt === undefined) return;
    this.waitedMs += performance.now() - this.blockedAt;
    this.blockedAt = undefined;
  }

  constructor(private dc: RTCDataChannel, private limit: () => number) {}

  batchReplies(receive: () => void) {
    this.collecting = true;
    try {
      receive();
      this.flush();
    } finally {
      this.collecting = false;
      this.used = 0;
    }
  }

  write(bytes: Uint8Array): boolean {
    if (this.dc.readyState !== "open") return false;
    if (!rtcCanSend(this.dc.bufferedAmount + this.used, bytes.length, rtcHighWater)) {
      this.blockedAt ??= performance.now();
      this.flush();
      return false;
    }
    if (this.used + bytes.length > this.batch.length) this.flush();
    if (!this.collecting || bytes.length >= this.batch.length) {
      this.send(bytes);
    } else {
      this.batch.set(bytes, this.used);
      this.used += bytes.length;
    }
    return true;
  }

  flush() {
    const length = this.used;
    this.used = 0;
    if (!length || this.dc.readyState !== "open") return;
    const limit = this.limit();
    for (let start = 0; start < length; start += limit)
      this.send(this.batch.subarray(start, Math.min(start + limit, length)));
  }

  private send(bytes: Uint8Array) {
    if (metrics.enabled) {
      metrics.record("rtc.send", bytes.byteLength);
      metrics.record("rtc.buffer", this.dc.bufferedAmount);
    }
    // send() snapshots the view synchronously. Copy only shared backing storage.
    this.dc.send(bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes));
  }
}
