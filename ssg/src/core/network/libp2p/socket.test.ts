import { describe, expect, it, vi } from "vitest";
import { NativeSocket } from "./socket";
import type { NativePeerNode } from "./native";

describe("native central socket lifecycle", () => {
  it("does not open a native socket after closing during node startup", async () => {
    let ready!: () => void;
    const node = { sockets: new Map(), socketReady: () => new Promise<void>(r => { ready = r; }), call: vi.fn().mockResolvedValue(null) };
    const socket = new NativeSocket(node as unknown as NativePeerNode, "s0", "ws://localhost", false);
    socket.close(); ready();
    await Promise.resolve(); await Promise.resolve();
    expect(node.call.mock.calls.map(([request]) => request.op)).toEqual(["socket_close"]);
    expect(node.sockets.size).toBe(0);
  });
  it("keeps control messages ordered and releases a failed socket", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const node = { sockets: new Map(), socketReady: async () => {}, call };
    const socket = new NativeSocket(node as unknown as NativePeerNode, "s0", "ws://localhost", false);
    await Promise.resolve(); socket.event("open");
    socket.send("one"); socket.send("two");
    await vi.waitFor(() => expect(call.mock.calls.filter(([r]) => r.op === "socket_send").map(([r]) => r.message)).toEqual(["one", "two"]));
    call.mockRejectedValueOnce(new Error("closed"));
    const error = vi.fn(), close = vi.fn(); socket.onerror = error; socket.onclose = close;
    socket.send("three");
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(error).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(node.sockets.size).toBe(0);
  });
});
