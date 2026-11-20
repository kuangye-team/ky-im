import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeLogs, getRuntimeLogs } from "../../runtime-logs";
import type { OutgoingTransfer } from "./state";
import { FileTrace } from "./diagnostics";

afterEach(() => { vi.useRealTimers(); clearRuntimeLogs(); });

it("flushes the last partial interval, retains the saved receipt and stops sampling", () => {
  vi.useFakeTimers();
  const task: OutgoingTransfer = { peerId: "peer", sentBytes: 0, message: {
    id: "file-id", peerId: "peer", senderId: "self", kind: "file", size: 128000,
    fileName: "private-name.txt", createdAt: Date.now(), status: "sending",
  } };
  const trace = task.trace = new FileTrace(task);
  for (let i = 0; i < 19; i++) trace.record("sourceRead", 3);
  trace.record("sourceRead", 100);
  task.sentBytes = 120000;
  task.receivedBytes = 90000;
  vi.advanceTimersByTime(4000);
  task.sentBytes = task.message.size;
  vi.advanceTimersByTime(250);
  trace.finish("delivered");
  vi.advanceTimersByTime(10000);

  const logs = getRuntimeLogs().filter(entry => entry.raw?.includes("file-id"));
  expect(logs.map(entry => entry.message)).toEqual(["文件传输性能", "文件传输性能", "文件处理耗时"]);
  expect(JSON.stringify(logs)).not.toContain("private-name.txt");
  const [batch, end, timings] = logs.map(entry => JSON.parse(entry.raw!).diagnostic);
  expect(batch.samples).toHaveLength(4);
  expect(batch.samples[0].inFlightBytes).toBe(30000);
  expect(end.samples).toHaveLength(1);
  expect(end.samples[0]).toMatchObject({ deltaBytes: 8000, intervalMs: 250, inFlightBytes: 0 });
  expect(timings.stages.sourceRead).toEqual({ count: 20, totalMs: 157, maxMs: 100, p95UpperMs: 4 });
  expect(task.trace).toBeUndefined();
});
