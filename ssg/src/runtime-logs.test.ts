import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LOG_LIMIT,
  clearRuntimeLogs,
  flushRuntimeLogs,
  getRuntimeLogs,
  runtimeLog,
  sanitizeLog,
} from "./runtime-logs";
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  clearRuntimeLogs();
});
afterEach(() => {
  flushRuntimeLogs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("bounds retained history and persists it without blocking logging on storage failure", () => {
  for (let i = 0; i < LOG_LIMIT + 5; i++)
    runtimeLog("debug", "heartbeat", `probe ${i}`);
  expect(getRuntimeLogs()).toHaveLength(LOG_LIMIT);
  expect(getRuntimeLogs()[0].message).toBe("probe 5");
  flushRuntimeLogs();
  expect(localStorage.setItem).toHaveBeenCalled();
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw new Error("full");
  });
  expect(() => runtimeLog("error", "app", "storage error")).not.toThrow();
});
it("removes expired logs and clears persisted history", () => {
  runtimeLog("info", "app", "old");
  vi.setSystemTime(Date.now() + 8 * 86400000);
  runtimeLog("info", "app", "new");
  expect(getRuntimeLogs().map((entry) => entry.message)).toEqual(["new"]);
  clearRuntimeLogs();
  expect(getRuntimeLogs()).toEqual([]);
  expect(localStorage.setItem).toHaveBeenLastCalledWith(
    "hummingbird.runtime-logs",
    "[]",
  );
});
it("redacts credentials and URL query values, retaining useful endpoint diagnostics", () => {
  const detail = sanitizeLog(
    "wss://user:password@example.com/ws?token=private#secret Authorization=private Bearer abc.def token=another",
  );
  expect(detail).toContain("wss://example.com/ws");
  for (const value of [
    "user",
    "password",
    "private",
    "abc.def",
    "another",
    "#secret",
  ])
    expect(detail).not.toContain(value);
});
it("retains source location, original error stack, and bounded sanitized diagnostic objects", () => {
  const error = new Error("connect failed");
  const diagnostic: Record<string, unknown> = {
    error,
    authorization: "private-key",
    payload: "private-chat",
  };
  diagnostic.self = diagnostic;
  runtimeLog("error", "connection", "连接失败", { raw: diagnostic });
  const log = getRuntimeLogs().at(-1)!;
  expect(log.source).toContain("runtime-logs.test");
  expect(log.raw).toContain("connect failed");
  expect(log.raw).toContain("stack");
  expect(log.raw).toContain("[circular]");
  expect(log.raw).not.toContain("private-key");
  expect(log.raw).not.toContain("private-chat");
  flushRuntimeLogs();
  expect(localStorage.setItem).toHaveBeenLastCalledWith(
    "hummingbird.runtime-logs",
    JSON.stringify(getRuntimeLogs()),
  );
});
it("caps total storage even when source events contain large stacks", () => {
  for (let i = 0; i < 1000; i++)
    runtimeLog("info", "connection", "test", {
      raw: { reason: "x".repeat(3000), stack: "y".repeat(3000) },
    });
  expect(JSON.stringify(getRuntimeLogs()).length * 2).toBeLessThan(
    3 * 1024 * 1024 + 4000,
  );
  expect(getRuntimeLogs().length).toBeLessThan(1000);
});
