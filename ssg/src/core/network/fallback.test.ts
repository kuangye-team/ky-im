import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferredTransportAdapter } from "./fallback";
import type {
  TransportAdapter,
  TransportChannel,
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
function setup() {
  const channel = new Channel();
  const options: TransportOptions = {
    localId: "A",
    peerId: "B",
    sendSignal: vi.fn(),
    onChannel: vi.fn(),
    onState: vi.fn(),
    onError: vi.fn(),
  };
  const rtcConnection = {
    start: vi.fn(),
    signal: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const rtc: TransportAdapter = {
    name: "webrtc",
    create: vi.fn(() => rtcConnection),
  };
  const tcp: TransportAdapter = {
    name: "tcp",
    create: () => ({
      channel,
      start: vi.fn(),
      signal: async () => {},
      close: () => channel.close(),
    }),
  };
  const connection = new PreferredTransportAdapter(tcp, rtc, 100).create(
    options,
  );
  return { channel, options, rtc, rtcConnection, connection };
}
afterEach(() => vi.useRealTimers());
describe("TCP preference and WebRTC fallback", () => {
  it("uses a successful TCP connection without starting WebRTC", async () => {
    vi.useFakeTimers();
    const { channel, options, rtc, connection } = setup();
    connection.start();
    channel.open();
    await vi.advanceTimersByTimeAsync(500);
    expect(options.onChannel).toHaveBeenCalledWith(channel);
    expect(rtc.create).not.toHaveBeenCalled();
    connection.close();
  });
  it.each(["error", "timeout", "close"])(
    "falls back exactly once on %s without exposing a broken TCP channel",
    async (reason) => {
      vi.useFakeTimers();
      const { channel, options, rtc, rtcConnection, connection } = setup();
      connection.start();
      if (reason === "error") channel.onerror?.(new Event("error"));
      if (reason === "close") channel.close();
      await vi.advanceTimersByTimeAsync(150);
      expect(rtc.create).toHaveBeenCalledTimes(1);
      expect(rtcConnection.start).toHaveBeenCalledTimes(1);
      expect(options.onChannel).not.toHaveBeenCalled();
      expect(options.onError).not.toHaveBeenCalled();
      connection.close();
      expect(rtcConnection.close).toHaveBeenCalled();
    },
  );
  it("accepts a browser's offer and cancels TCP without starting a second offer", async () => {
    const { connection, channel, rtcConnection } = setup();
    await connection.signal({ description: { type: "offer" } });
    expect(channel.readyState).toBe("closed");
    expect(rtcConnection.signal).toHaveBeenCalled();
    expect(rtcConnection.start).not.toHaveBeenCalled();
    connection.close();
  });
  it("cancels timeout fallback when the user disconnects", async () => {
    vi.useFakeTimers();
    const { connection, rtc } = setup();
    connection.start();
    connection.close();
    await vi.advanceTimersByTimeAsync(200);
    expect(rtc.create).not.toHaveBeenCalled();
  });
});
