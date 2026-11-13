import { afterEach, expect, it, vi } from "vitest";
import { listHeartbeatInterval } from "./config";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it.each([undefined, "", "0", "-1", "100.5", "NaN", "Infinity", "300001"])(
  "uses the default for invalid interval %s",
  (value) => {
    expect(listHeartbeatInterval(value)).toBe(10000);
  },
);
it.each([1000, 10000, 45000, 300000])(
  "accepts an interval of %s milliseconds",
  (value) => {
    expect(listHeartbeatInterval(String(value))).toBe(value);
  },
);
it("reads the list check interval from the frontend environment", async () => {
  vi.stubEnv("VITE_PEER_CHECK_INTERVAL_MS", "45000");
  vi.resetModules();
  const { CONNECTION_CONFIG } = await import("./config");
  expect(CONNECTION_CONFIG.listHeartbeatIntervalMs).toBe(45000);
  expect(CONNECTION_CONFIG.peerHeartbeatIntervalMs).toBe(10000);
});
