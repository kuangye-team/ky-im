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
  it("sends Authorization only in HTTP headers, then connects, probes, and closes with a ticket", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ticket: "signed-short-ticket" }),
      });
    vi.stubGlobal("fetch", fetcher);
    const result = testServer(
      "wss://private.test/custom/ws",
      5000,
      "Bearer secret",
    );
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://private.test/custom/ws/ticket",
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer secret" },
      redirect: "error",
      credentials: "omit",
    });
    const socket = Socket.all[0];
    expect(socket.url).toBe(
      "wss://private.test/custom/ws?ticket=signed-short-ticket",
    );
    socket.readyState = 1;
    socket.onopen!(new Event("open"));
    expect(socket.send).toHaveBeenCalledWith('{"type":"capabilities"}');
    socket.onmessage!({ data: '{"type":"capabilities","relay":true}' });
    await expect(result).resolves.toEqual({ relay: true });
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("reports a rejected key without opening a WebSocket", async () => {
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(
      testServer("wss://private.test/api/ws", 5000, "wrong"),
    ).rejects.toThrow("访问密钥不正确");
    expect(Socket.all).toHaveLength(0);
  });

  it("cancels authentication when closed and never opens a late connection", async () => {
    vi.stubGlobal("WebSocket", Socket);
    let resolve!: (response: unknown) => void;
    const fetcher = vi.fn(
      (_url: URL, _options: RequestInit) =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const session = new SignalingDiscoveryAdapter(
      "wss://private.test/api/ws",
      undefined,
      "Bearer secret",
    ).open();
    session.close();
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    resolve({ ok: true, json: async () => ({ ticket: "late-ticket" }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(session.readyState).toBe(3);
    expect(Socket.all).toHaveLength(0);
  });

  it("acquires a fresh ticket on each reconnect and routes normal messages", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ticket: "ticket" }),
      });
    vi.stubGlobal("fetch", fetcher);
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
    first.send('{"type":"join"}');
    expect(Socket.all[0].send).toHaveBeenCalledWith('{"type":"join"}');
    Socket.all[0].onmessage!({ data: "welcome" });
    expect(opened).toHaveBeenCalledOnce();
    expect(message).toHaveBeenCalledWith({ data: "welcome" });
    first.close();
    const second = adapter.open();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(2));
    expect(fetcher).toHaveBeenCalledTimes(2);
    second.close();
  });
});
