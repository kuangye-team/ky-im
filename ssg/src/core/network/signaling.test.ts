import { localRuntime } from "../capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalingDiscoveryAdapter } from "./signaling";
import { testServer } from "./serverTest";

class Socket {
  static all: Socket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    Socket.all.push(this);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Socket.all = [];
});

describe("authorized signaling", () => {
  it("sends the credential in the first socket message", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const result = testServer("wss://private.test/custom/ws",5000,"Bearer secret");
    const socket = Socket.all[0];
    expect(socket.url).toBe("wss://private.test/custom/ws?room=local");
    socket.readyState = 1;
    socket.onopen!(new Event("open"));
    expect(socket.send).toHaveBeenCalledExactlyOnceWith('{"type":"auth","authorization":"Bearer secret"}');
    socket.onmessage!({ data: JSON.stringify({ type: "capabilities", ...localRuntime() }) });
    await expect(result).resolves.toEqual({ relay: true });
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("reports a rejected first packet", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const result = testServer("wss://private.test/api/ws",5000,"wrong");
    const socket = Socket.all[0];
    socket.onopen!(new Event("open"));
    socket.onmessage!({data:JSON.stringify({type:"error",code:"unauthorized"})});
    await expect(result).rejects.toThrow("访问密钥不正确");
  });
  it("ignores an open event after cancellation", () => {
    vi.stubGlobal("WebSocket", Socket);
    const session = new SignalingDiscoveryAdapter("wss://private.test/api/ws").open();
    session.close();
    Socket.all[0].onopen!(new Event("open"));
    expect(Socket.all[0].send).not.toHaveBeenCalled();
    expect(session.readyState).toBe(3);
  });
  it("authenticates each connection before forwarding messages", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const adapter = new SignalingDiscoveryAdapter(
      "wss://private.test/api/ws",
      undefined,
      "Bearer secret",
    );
    const first = adapter.open();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    const opened = vi.fn(),
      message = vi.fn();
    first.onopen = opened;
    first.onmessage = message;
    Socket.all[0].readyState = 1;
    Socket.all[0].onopen!(new Event("open"));
    Socket.all[0].onmessage!({ data: JSON.stringify({ type: "capabilities", ...localRuntime() }) });
    first.send('{"type":"join"}');
    expect(Socket.all[0].send).toHaveBeenCalledWith('{"type":"join"}');
    Socket.all[0].onmessage!({ data: "welcome" });
    expect(opened).toHaveBeenCalledOnce();
    expect(message).toHaveBeenCalledWith({ data: "welcome" });
    first.close();
    const second = adapter.open();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(2));
    Socket.all[1].onopen!(new Event("open"));
    expect(Socket.all[1].send).toHaveBeenCalledExactlyOnceWith('{"type":"auth","authorization":"Bearer secret"}');
    second.close();
  });
});
