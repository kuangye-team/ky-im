/** Opt-in diagnostics. Aggregates only: no payloads, paths, or per-packet logs. */
type Sample = { count: number; bytes: number; totalMs: number; maxMs: number; maxBytes: number };
class TransferMetrics {
  enabled = false;
  private epoch = 0;
  private samples: Record<string, Sample> = {};
  reset(enabled = true) {
    this.enabled = enabled;
    this.epoch = performance.now();
    this.samples = {};
  }
  start() { return this.enabled ? performance.now() : undefined; }
  record(name: string, bytes = 0, ms = 0) {
    if (!this.enabled) return;
    const sample = this.samples[name] ??= { count: 0, bytes: 0, totalMs: 0, maxMs: 0, maxBytes: 0 };
    sample.count++;
    sample.bytes += bytes;
    sample.totalMs += ms;
    sample.maxMs = Math.max(sample.maxMs, ms);
    sample.maxBytes = Math.max(sample.maxBytes, bytes);
  }
  finish(name: string, start: number | undefined, bytes = 0) {
    if (start !== undefined && start >= this.epoch)
      this.record(name, bytes, performance.now() - start);
  }
  timed<T>(name: string, bytes: number, run: () => Promise<T>): Promise<T> {
    if (!this.enabled) return run();
    const start = this.start();
    return run().finally(() => this.finish(name, start, bytes));
  }
  snapshot() {
    return { elapsedMs: performance.now() - this.epoch, samples: structuredClone(this.samples) };
  }
}
export const transferMetrics = new TransferMetrics();
