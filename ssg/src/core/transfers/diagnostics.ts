import { runtimeLog } from "../../runtime-logs";
import type { IncomingTransfer, OutgoingTransfer } from "./state";

const preference = "hummingbird.file-performance";
const latencyBoundsMs = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096, Infinity];
type Stage = "sourceRead" | "sourceCopy" | "windowWait" | "destinationWrite";
export function fileDiagnosticsEnabled() {
  try { return localStorage.getItem(preference) === "1"; } catch { return false; }
}
export function setFileDiagnostics(enabled: boolean) {
  localStorage.setItem(preference, enabled ? "1" : "0");
}

/** Per-file counters. Read the active channel again after a resume. */
export class FileTrace {
  writtenBytes?: number;
  confirmedBytes?: number;
  windowWaitMs = 0;
  destinationWriteMs = 0;
  fileEndAt?: number;
  finalAckMs?: number;
  private durations = new Map<Stage, { count: number; totalMs: number; maxMs: number; buckets: number[] }>();
  private readonly start = performance.now();
  private previous = this.start;
  private previousBytes = 0;
  private samples: Record<string, unknown>[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private task: IncomingTransfer | OutgoingTransfer) {
    task.channel?.rtcSample?.();
    this.timer = setInterval(() => this.sample(), 1000);
  }

  record(stage: Stage, elapsed: number) {
    let timing = this.durations.get(stage);
    if (!timing) {
      timing = { count: 0, totalMs: 0, maxMs: 0, buckets: latencyBoundsMs.map(() => 0) };
      this.durations.set(stage, timing);
    }
    timing.count++;
    timing.totalMs += elapsed;
    timing.maxMs = Math.max(timing.maxMs, elapsed);
    timing.buckets[latencyBoundsMs.findIndex(bound => elapsed <= bound)]++;
    if (stage === "windowWait") this.windowWaitMs += elapsed;
    if (stage === "destinationWrite") this.destinationWriteMs += elapsed;
  }

  finish(outcome: string) {
    clearInterval(this.timer);
    this.sample(outcome);
    if (this.durations.size) {
      const stages = Object.fromEntries([...this.durations].map(([stage, t]) => {
        const rank = Math.ceil(t.count * 0.95);
        let count = 0;
        const index = t.buckets.findIndex(n => {
          count += n;
          return count >= rank;
        });
        const bound = latencyBoundsMs[index];
        return [stage, { count: t.count, totalMs: Math.round(t.totalMs), maxMs: Math.ceil(t.maxMs),
          p95UpperMs: Math.ceil(Math.min(bound, t.maxMs)) }];
      }));
      runtimeLog("debug", "message", "文件处理耗时", { peerId: this.task.peerId,
        raw: { transferId: this.task.message.id, outcome, stages } });
    }
    this.task.trace = undefined;
  }

  private sample(outcome?: string) {
    const now = performance.now();
    const task = this.task;
    const receiving = "chunks" in task;
    const bytes = receiving ? task.nativeBytes ?? task.received : task.sentBytes ?? 0;
    const confirmed = receiving ? undefined : outcome === "delivered" ? task.message.size : this.confirmedBytes ?? task.receivedBytes;
    const channel = task.channel;
    this.samples.push({
      elapsedMs: Math.round(now - this.start), intervalMs: Math.round(now - this.previous),
      transferredBytes: bytes, deltaBytes: bytes - this.previousBytes,
      confirmedBytes: confirmed, inFlightBytes: confirmed === undefined ? undefined : Math.max(0, bytes - confirmed),
      writtenBytes: this.writtenBytes, windowWaitMs: Math.round(this.windowWaitMs),
      destinationWriteMs: Math.round(this.destinationWriteMs), applicationQueueBytes: channel?.bufferedAmount,
      connectionId: channel?.physicalConnectionId ?? channel?.connectionId, ...structuredClone(channel?.rtcSample?.()),
    });
    this.previous = now;
    this.previousBytes = bytes;
    if (!outcome && this.samples.length < 4) return;
    runtimeLog("debug", "message", "文件传输性能", {
      peerId: this.task.peerId, raw: {
        transferId: this.task.message.id, direction: receiving ? "receive" : "send",
        fileBytes: this.task.message.size, storage: this.task.message.attachmentStorage,
        outcome, finalAckMs: this.finalAckMs, samples: this.samples,
      },
    });
    this.samples = [];
  }
}
