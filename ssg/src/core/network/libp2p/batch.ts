import { Uint8ArrayList } from "uint8arraylist";
import { transferMetrics as metrics } from "../../transferMetrics";

export const PIPE_BATCH_BYTES = 256 * 1024;
export const PIPE_QUEUE_BYTES = 2 * 1024 * 1024;
const PIPE_BATCH_TARGET = 64 * 1024;

/** One ordered IPC write in flight; pending small messages share its next batch. */
export class ByteBatchWriter {
  private queue = new Uint8ArrayList();
  private inFlight = 0;
  private writing = false;
  private ended = false;
  private settled = false;
  private timer?: ReturnType<typeof setTimeout>;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  readonly done = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  constructor(private write: (bytes: ArrayBuffer) => Promise<void>) {}
  get bufferedBytes() { return this.queue.byteLength + this.inFlight; }
  push(bytes: Uint8Array | Uint8ArrayList) {
    if (this.ended || this.settled) return;
    if (this.bufferedBytes + bytes.byteLength > PIPE_QUEUE_BYTES) {
      this.abort(new Error("Pipe receive queue exceeded"));
      return;
    }
    this.queue.append(bytes);
    metrics.record("pipe.pending", this.bufferedBytes);
    if (!this.writing) this.schedule();
  }
  end() {
    this.ended = true;
    if (!this.writing) { clearTimeout(this.timer); this.timer = undefined; void this.flush(); }
  }
  abort(error: Error) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.queue.consume(this.queue.byteLength);
    this.reject(error);
  }
  private schedule() {
    if (this.settled || this.writing) return;
    if (this.queue.byteLength >= PIPE_BATCH_TARGET || this.ended) {
      clearTimeout(this.timer); this.timer = undefined;
      void this.flush();
    } else if (this.timer === undefined) {
      // Bound the gathering delay; a full target bypasses timer throttling.
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1);
    }
  }
  private async flush() {
    if (this.writing || this.settled) return;
    this.writing = true;
    try {
      while (this.queue.byteLength && !this.settled) {
        const size = Math.min(this.queue.byteLength, PIPE_BATCH_BYTES);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of this.queue.sublist(0, size)) { bytes.set(part, offset); offset += part.length; }
        this.queue.consume(size);
        this.inFlight = size;
        try { await this.write(bytes.buffer); }
        finally { this.inFlight = 0; }
        if (!this.ended && this.queue.byteLength < PIPE_BATCH_TARGET) break;
      }
      if (this.ended && !this.settled) { this.settled = true; this.resolve(); }
    } catch (error) { this.abort(error instanceof Error ? error : new Error(String(error))); }
    finally {
      this.writing = false;
      if (this.queue.byteLength && !this.settled) this.schedule();
    }
  }
}

/** Acknowledges only the contiguous consumed prefix, even when consumers finish out of order. */
export class CumulativeAcks {
  private entries = new Map<string, { consumed: number; sent: number; completed: Set<number> }>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private send: (token: string, sequence: number) => void) {}
  consume(token: string, sequence: number) {
    if (this.closed) return;
    const entry = this.entries.get(token) ?? { consumed: 0, sent: 0, completed: new Set<number>() };
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > entry.consumed + 4)
      throw new Error("Invalid receive credit sequence");
    if (sequence <= entry.consumed) return;
    this.entries.set(token, entry);
    entry.completed.add(sequence);
    while (entry.completed.delete(entry.consumed + 1)) entry.consumed++;
    // Return half the four-frame window immediately; sparse traffic never waits for a full batch.
    if (entry.consumed - entry.sent >= 2) this.flush();
    else if (this.timer === undefined)
      this.timer = setTimeout(() => this.flush(), 0);
  }
  private flush() {
    clearTimeout(this.timer); this.timer = undefined;
    for (const [token, entry] of this.entries) {
      if (entry.consumed === entry.sent) continue;
      entry.sent = entry.consumed;
      this.send(token, entry.sent);
    }
  }
  forget(token: string) { this.entries.delete(token); }
  close() { this.closed = true; clearTimeout(this.timer); this.entries.clear(); }
}
