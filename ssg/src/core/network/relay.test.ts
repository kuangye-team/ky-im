import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferredTransportAdapter } from "./fallback";
import { RelayTransportAdapter } from "./relay";
import type {
  TransportAdapter,
  TransportChannel,
  TransportConnection,
  TransportOptions,
} from "./types";

class Channel extends EventTarget implements TransportChannel {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: TransportChannel["onopen"] = null;
  onclose: TransportChannel["onclose"] = null;
  onerror: TransportChannel["onerror"] = null;
  onmessage: TransportChannel["onmessage"] = null;
  send() {}
  close() {
    this.readyState = "closed";
    this.onclose?.(new Event("close"));
  }
  open() {
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }
}
class Socket {
  readyState = 1;
  onopen: WebSocket["onopen"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: any[] = [];
  other?: Socket;
  constructor(public id: string) {}
  send(raw: string) {
    const packet = JSON.parse(raw);
    this.sent.push(packet);
    if (packet.type === "relay")
      queueMicrotask(() => this.other?.receive({ ...packet, from: this.id }));
  }
  receive(packet: unknown) {
    this.onmessage?.({ data: JSON.stringify(packet) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.call(
      this as unknown as WebSocket,
      new Event("close") as CloseEvent,
    );
  }
}
function setup(server = true, peer = true) {
  vi.useFakeTimers();
  function device(id: string, peerId: string) {
    const direct = new Channel();
    const directOptions: TransportOptions[] = [];
    const adapter: TransportAdapter = {
      name: "direct",
      create(options) {
        directOptions.push(options);
        return {
          channel: direct,
          start() {},
          async signal() {},
          close: () => direct.close(),
        };
      },
    };
    const relay = new RelayTransportAdapter(adapter, 100);
    const socket = new Socket(id);
    relay.session(socket as unknown as WebSocket);
    socket.receive({
      type: "welcome",
      relay: server,
      peers: [{ id: peerId, relay: peer }],
    });
    const received: unknown[] = [];
    let channel: TransportChannel | undefined;
    const options: TransportOptions = {
      localId: id,
      peerId,
      sendSignal: vi.fn(),
      onChannel(c) {
        channel = c;
        c.onmessage = ({ data }) => {
          received.push(data);
          c.consumed?.();
        };
      },
      onState: vi.fn(),
      onError: vi.fn(),
    };
    let connection: TransportConnection | undefined;
    const connect = () => (connection ??= relay.create(options));
    relay.onIncoming = connect;
    return {
      socket,
      relay,
      direct,
      directOptions,
      options,
      connect,
      received,
      get channel() {
        return channel;
      },
    };
  }
  const a = device("a", "b"),
    b = device("b", "a");
  a.socket.other = b.socket;
  b.socket.other = a.socket;
  return { a, b };
}
afterEach(() => vi.useRealTimers());
describe("relay fallback", () => {
  it("keeps successful direct transfers off the server", async () => {
    const { a } = setup();
    a.connect().start();
    a.direct.open();
    await vi.advanceTimersByTimeAsync(500);
    expect(a.channel).toBe(a.direct);
    expect(a.socket.sent).toEqual([]);
    a.connect().close();
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
  ])(
    "never relays without server and peer consent (%s, %s)",
    async (server, peer) => {
      const { a } = setup(server, peer);
      a.connect().start();
      await vi.advanceTimersByTimeAsync(110);
      expect(a.socket.sent).toEqual([]);
      expect(a.options.onError).not.toHaveBeenCalled();
      a.connect().close();
    },
  );
  it("falls back after timeout, streams ordered text and binary with receive credit", async () => {
    const { a, b } = setup();
    a.connect().start();
    await vi.advanceTimersByTimeAsync(99);
    expect(a.socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(a.channel?.readyState).toBe("open");
    expect(b.channel?.readyState).toBe("open");
    a.channel!.send("你好 relay");
    const binary = new Uint8Array([0, 255, 127, 1]).buffer;
    for (let i = 0; i < 300; i++) a.channel!.send(binary);
    expect(a.channel!.bufferedAmount).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.received).toHaveLength(301);
    expect(b.received[0]).toBe("你好 relay");
    expect(b.received[300]).toEqual(binary);
    expect(a.channel!.bufferedAmount).toBe(0);
    b.channel!.send("reply");
    await vi.advanceTimersByTimeAsync(0);
    expect(a.received).toEqual(["reply"]);
    a.connect().close();
    b.connect().close();
  });
  it("converges simultaneous fallback and rejects stale frames", async () => {
    const { a, b } = setup();
    a.connect().start();
    b.connect().start();
    await vi.advanceTimersByTimeAsync(101);
    expect(a.channel?.readyState).toBe("open");
    expect(b.channel?.readyState).toBe("open");
    b.socket.receive({
      type: "relay",
      from: "a",
      session: "old",
      data: { kind: "data", binary: false, payload: btoa("stale") },
    });
    expect(b.received).toEqual([]);
    a.channel!.send("new");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.received).toEqual(["new"]);
    a.connect().close();
    b.connect().close();
  });
  it("fails over immediately on direct failure and closes when consent or socket is lost", async () => {
    const { a, b } = setup();
    a.connect().start();
    a.direct.onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.channel?.readyState).toBe("open");
    a.socket.receive({ type: "peer_updated", peer: { id: "b", relay: false } });
    expect(a.channel?.readyState).toBe("closed");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.channel?.readyState).toBe("closed");
    a.connect().close();
    b.connect().close();
  });
  it("cancels pending fallback on disconnect", async () => {
    const { a } = setup();
    a.connect().start();
    a.connect().close();
    await vi.advanceTimersByTimeAsync(500);
    expect(a.socket.sent).toEqual([]);
  });
  it("waits for TCP then WebRTC before starting relay", async () => {
    vi.useFakeTimers();
    const tcp = new Channel(),
      rtc = new Channel();
    const make = (channel: Channel): TransportAdapter => ({
      name: "direct",
      create: vi.fn(() => ({
        channel,
        start: vi.fn(),
        async signal() {},
        close: () => channel.close(),
      })),
    });
    const tcpAdapter = make(tcp),
      rtcAdapter = make(rtc);
    const transport = new RelayTransportAdapter(
      new PreferredTransportAdapter(tcpAdapter, rtcAdapter, 40),
      100,
    );
    const socket = new Socket("a");
    transport.session(socket as unknown as WebSocket);
    socket.receive({
      type: "welcome",
      relay: true,
      peers: [{ id: "b", relay: true }],
    });
    const connection = transport.create({
      localId: "a",
      peerId: "b",
      sendSignal: vi.fn(),
      onChannel: vi.fn(),
      onState: vi.fn(),
      onError: vi.fn(),
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(39);
    expect(rtcAdapter.create).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(rtcAdapter.create).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(60);
    expect(socket.sent[0]).toMatchObject({
      type: "relay",
      data: { kind: "open" },
    });
    expect(tcp.readyState).toBe("closed");
    expect(rtc.readyState).toBe("closed");
    connection.close();
  });
  it("uses consent from the same server and ignores unrelated server loss", async () => {
    const { a, b } = setup(true, false);
    const secondA = new Socket("a"),
      secondB = new Socket("b");
    secondA.other = secondB;
    secondB.other = secondA;
    a.relay.session(secondA as unknown as WebSocket);
    b.relay.session(secondB as unknown as WebSocket);
    secondA.receive({
      type: "welcome",
      relay: true,
      peers: [{ id: "b", relay: true }],
    });
    secondB.receive({
      type: "welcome",
      relay: true,
      peers: [{ id: "a", relay: true }],
    });
    a.connect().start();
    await vi.advanceTimersByTimeAsync(101);
    expect(a.channel?.readyState).toBe("open");
    expect(a.socket.sent).toEqual([]);
    expect(b.socket.sent).toEqual([]);
    a.socket.close();
    b.socket.close();
    expect(a.channel?.readyState).toBe("open");
    a.channel!.send("common server");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.received).toEqual(["common server"]);
    secondA.close();
    expect(a.channel?.readyState).toBe("closed");
    a.connect().close();
    b.connect().close();
  });
  it("bounds file output until the receiver consumes pending frames", async () => {
    const { a, b } = setup();
    a.connect().start();
    await vi.advanceTimersByTimeAsync(101);
    // Consume slowly to keep only eight frames in flight, independently of the
    // engine's IndexedDB/file writes and the WebSocket implementation's buffer.
    const received: ArrayBuffer[] = [];
    b.channel!.onmessage = ({ data }) => received.push(data as ArrayBuffer);
    const chunk = new Uint8Array(16 * 1024).buffer;
    for (let i = 0; i < 40; i++) a.channel!.send(chunk);
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(8);
    expect(a.channel!.bufferedAmount).toBe(40 * chunk.byteLength);
    for (let i = 0; i < 40; i++) {
      b.channel!.consumed!();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(received).toHaveLength(40);
    expect(a.channel!.bufferedAmount).toBe(0);
    a.connect().close();
    b.connect().close();
  });
});
