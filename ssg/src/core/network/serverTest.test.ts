import { afterEach, describe, expect, it, vi } from "vitest";
import { testServer } from "./serverTest";
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
  it.each([true, false])(
    "returns live relay support %s without joining or uploading a profile",
    async (relay) => {
      vi.stubGlobal("WebSocket", Socket);
      const result = testServer("wss://example.test/custom/ws");
      const socket = Socket.last;
      socket.onopen!();
      expect(socket.send).toHaveBeenCalledExactlyOnceWith(
        '{"type":"capabilities"}',
      );
      socket.onmessage!({
        data: JSON.stringify({ type: "capabilities", relay }),
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
      const rejected = expect(result).rejects.toThrow("连接失败");
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
