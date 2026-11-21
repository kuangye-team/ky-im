import { localRuntime, CAP } from "../capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testServer } from "./serverTest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
class Socket {
  static last: Socket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    Socket.last = this;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("server capability probe", () => {
  it.each(["direct", "system"] as const)("uses the selected %s desktop route to test a server", async (mode) => {
    invoke.mockResolvedValue(JSON.stringify({ type: "capabilities", ...localRuntime() }));
    const url = "wss://server.test/api/ws";
    await expect(testServer(url, 5000, "sample", mode)).resolves.toHaveProperty("relay");
    expect(invoke).toHaveBeenLastCalledWith("probe_signaling_server", {
      address: expect.stringContaining(url + "?room="), authorization: "sample",
      timeoutMs: 5000, useSystemProxy: mode === "system",
    });
  });
  it.each([true, false])(
    "returns live relay support %s without joining or uploading a profile",
    async (relay) => {
      vi.stubGlobal("WebSocket", Socket);
      const result = testServer("wss://example.test/custom/ws");
      const socket = Socket.last;
      socket.onopen!();
      expect(socket.send).toHaveBeenCalledExactlyOnceWith(
        '{"type":"auth"}',
      );
      socket.onmessage!({
        data: JSON.stringify({ type: "capabilities", ...localRuntime(), capabilities: localRuntime().capabilities.filter(c => relay || c !== CAP.relay) }),
      });
      await expect(result).resolves.toEqual({ relay });
      expect(socket.close).toHaveBeenCalledOnce();
      expect(socket.onclose).toBeNull();
    },
  );
  it.each(["timeout", "error", "close", "invalid"])(
    "cleans up a failed %s probe",
    async (failure) => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", Socket);
      const result = testServer("ws://example.test/ws", 50);
      const rejected = expect(result).rejects.toThrow(failure === "invalid" ? "暂时无法连接" : "连接失败");
      const socket = Socket.last;
      if (failure === "error") socket.onerror!();
      if (failure === "close") socket.onclose!();
      if (failure === "invalid")
        socket.onmessage!({ data: '{"type":"capabilities","relay":"true"}' });
      await vi.advanceTimersByTimeAsync(60);
      await rejected;
      expect(socket.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
