import { afterEach, describe, expect, it, vi } from "vitest";
import { CombinedDiscoveryAdapter } from "./combined";
import { SIGNALING_CONFIG } from "../../config";
import type { DiscoveryAdapter, DiscoverySession } from "./types";
import type { Profile } from "../types";

const peer = (id: string, numericId?: string): Profile => ({
  id,
  name: "same name",
  numericId,
  avatar: "🌿",
  bio: "",
  color: "#123abc",
  device: "Desktop",
  clientType: "web" as const,
});
class Session implements DiscoverySession {
  readyState = 0;
  onopen: DiscoverySession["onopen"] = null;
  onclose: DiscoverySession["onclose"] = null;
  onerror: DiscoverySession["onerror"] = null;
  onmessage: DiscoverySession["onmessage"] = null;
  sent: any[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  receive(packet: unknown) {
    this.onmessage?.({ data: JSON.stringify(packet) });
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  close() {
    this.readyState = 3;
    this.onclose?.(new Event("close"));
  }
}
function source(name: string): DiscoveryAdapter & { sessions: Session[] } {
  return {
    name,
    supportsNumericIds: name !== "mdns",
    usesBrowserNetworkStatus: name !== "mdns",
    sessions: [],
    open() {
      const s = new Session();
      this.sessions.push(s);
      return s;
    },
  };
}
const active: DiscoverySession[] = [];
afterEach(() => {
  active.splice(0).forEach((s) => s.close());
  vi.useRealTimers();
});
async function setup(names = ["signaling", "mdns"]) {
  const central = source(names[0]),
    lan = source(names[1]);
  const session = new CombinedDiscoveryAdapter([central, lan]).open();
  active.push(session);
  const received: any[] = [];
  session.onmessage = ({ data }) => received.push(JSON.parse(String(data)));
  session.onopen = () =>
    session.send(
      JSON.stringify({
        type: "join",
        room: "test",
        profile: peer("10000000-0000-4000-8000-000000000000"),
      }),
    );
  await Promise.resolve();
  const a = central.sessions[0],
    b = lan.sessions[0];
  a.open();
  b.open();
  return { session, central, lan, a, b, received };
}
describe("combined discovery", () => {
  it("keeps authentication errors when no discovery source is connected", async () => {
    const { session, a, b } = await setup();
    const error = Object.assign(new Event("error"), { message: "访问密钥不正确" });
    const onerror = vi.fn();
    session.onerror = onerror;
    a.onerror?.(error);
    expect(onerror).toHaveBeenCalledWith(error);
    b.receive({ type: "welcome", peers: [] });
    onerror.mockClear();
    b.onerror?.(error);
    expect(onerror).toHaveBeenCalledWith(error);
  });
  it("merges by stable device ID, preserves peers on later welcomes, and removes only the final source", async () => {
    const { a, b, received } = await setup();
    a.receive({
      type: "welcome",
      peers: [
        peer("20000000-0000-4000-8000-000000000000", "123456"),
        peer("10000000-0000-4000-8000-000000000000"),
      ],
    });
    b.receive({
      type: "welcome",
      peers: [
        peer("20000000-0000-4000-8000-000000000000"),
        peer("30000000-0000-4000-8000-000000000000"),
      ],
    });
    expect(received.filter((p) => p.type === "welcome")).toHaveLength(1);
    expect(
      received.filter((p) => p.type === "peer_updated").map((p) => p.peer.id),
    ).toEqual([
      "20000000-0000-4000-8000-000000000000",
      "30000000-0000-4000-8000-000000000000",
    ]);
    b.receive({
      type: "peer_left",
      id: "20000000-0000-4000-8000-000000000000",
    });
    expect(received.some((p) => p.type === "peer_left")).toBe(false);
    a.receive({
      type: "peer_left",
      id: "20000000-0000-4000-8000-000000000000",
    });
    expect(received.filter((p) => p.type === "peer_left")).toEqual([
      { type: "peer_left", id: "20000000-0000-4000-8000-000000000000" },
    ]);
  });
  it("clears server-specific numbers when only nearby discovery remains", async () => {
    const { a, b, received } = await setup();
    const id = "20000000-0000-4000-8000-000000000000";
    a.receive({
      type: "welcome",
      numericId: "123456",
      peers: [peer(id, "123456")],
    });
    b.receive({ type: "welcome", peers: [peer(id)] });
    a.close();
    expect(
      received.filter((p) => p.type === "peer_updated").at(-1).peer.numericId,
    ).toBeUndefined();
    expect(
      received.filter((p) => p.type === "discovery_number").at(-1).numericId,
    ).toBeUndefined();
    expect(received.some((p) => p.type === "peer_left")).toBe(false);
  });
  it("retries failed services independently while LAN discovery stays online", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    const { a, b, central, session, received } = await setup();
    a.receive({
      type: "welcome",
      peers: [peer("20000000-0000-4000-8000-000000000000")],
    });
    b.receive({
      type: "welcome",
      peers: [peer("20000000-0000-4000-8000-000000000000")],
    });
    a.close();
    expect(session.readyState).toBe(1);
    expect(received.some((p) => p.type === "peer_left")).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(central.sessions).toHaveLength(2);
    expect(b.readyState).toBe(1);
    session.close();
    await vi.advanceTimersByTimeAsync(120000);
    expect(central.sessions).toHaveLength(2);
  });
  it("answers a negotiation on its source and routes a restored device", async () => {
    const { a, b, session } = await setup();
    a.receive({
      type: "welcome",
      peers: [peer("20000000-0000-4000-8000-000000000000")],
    });
    b.receive({
      type: "welcome",
      peers: [peer("20000000-0000-4000-8000-000000000000")],
    });
    b.receive({
      type: "signal",
      from: "20000000-0000-4000-8000-000000000000",
      data: { candidate: {} },
    });
    session.send(
      JSON.stringify({
        type: "signal",
        to: "20000000-0000-4000-8000-000000000000",
        data: { description: {} },
      }),
    );
    expect(b.sent.at(-1).type).toBe("signal");
    expect(a.sent.at(-1).type).toBe("join");
    session.send(
      JSON.stringify({
        type: "connect",
        requestId: "x",
        numericId: "123456",
        expectedPeerId: "40000000-0000-4000-8000-000000000000",
      }),
    );
    expect(b.sent.some((p) => p.type === "connect")).toBe(false);
    a.receive({
      type: "peer_resolved",
      requestId: "x",
      peer: peer("40000000-0000-4000-8000-000000000000", "123456"),
    });
    session.send(
      JSON.stringify({
        type: "signal",
        to: "40000000-0000-4000-8000-000000000000",
        data: {},
      }),
    );
    expect(a.sent.at(-1).to).toBe("40000000-0000-4000-8000-000000000000");
  });
  it("keeps the displayed number and refresh on the chosen server, switching on loss", async () => {
    const a = source("one"),
      b = source("two");
    const session = new CombinedDiscoveryAdapter([a, b]).open();
    active.push(session);
    const received: any[] = [];
    session.onmessage = ({ data }) => received.push(JSON.parse(String(data)));
    session.onopen = () =>
      session.send(
        JSON.stringify({
          type: "join",
          profile: peer("10000000-0000-4000-8000-000000000000"),
          room: "test",
        }),
      );
    await Promise.resolve();
    a.sessions[0].open();
    b.sessions[0].open();
    b.sessions[0].receive({ type: "welcome", peers: [], numericId: "222222" });
    a.sessions[0].receive({ type: "welcome", peers: [], numericId: "111111" });
    session.send(
      JSON.stringify({ type: "refresh_number", requestId: "refresh" }),
    );
    expect(b.sessions[0].sent.at(-1).type).toBe("refresh_number");
    expect(a.sessions[0].sent.at(-1).type).toBe("join");
    b.sessions[0].close();
    expect(
      received
        .filter((p) => p.type === "discovery_number")
        .map((p) => p.numericId),
    ).toEqual(["222222", "111111"]);
  });
});

describe("multi-server number lookups", () => {
  const request = {
    type: "connect_group",
    requestId: "group",
    numericId: "345678",
  };
  const alice = peer("20000000-0000-4000-8000-000000000000", request.numericId);
  const bob = peer("30000000-0000-4000-8000-000000000000", request.numericId);
  const resolved = (peers: Profile[]) => ({
    ...request,
    type: "group_resolved",
    peers,
  });
  const error = {
    type: "connect_error",
    requestId: request.requestId,
    code: "peer_unavailable",
  };
  async function connected() {
    const state = await setup(["one", "two"]);
    // The second configured server connects first; lookups must still reach both.
    state.b.receive({ type: "welcome", peers: [], numericId: "222222" });
    state.a.receive({ type: "welcome", peers: [], numericId: "111111" });
    state.received.length = 0;
    return state;
  }

  it("queries both servers and waits for a success after an early not-found error", async () => {
    const { session, a, b, received } = await connected();
    session.send(JSON.stringify(request));
    expect(a.sent.at(-1)).toEqual(request);
    expect(b.sent.at(-1)).toEqual(request);
    b.receive(error);
    expect(received).toEqual([]);
    a.receive(resolved([alice]));
    expect(received.filter((p) => p.type === "connect_error")).toEqual([]);
    expect(received.filter((p) => p.type === "group_resolved")).toEqual([
      resolved([alice]),
    ]);
    session.send(JSON.stringify({ type: "signal", to: alice.id, data: {} }));
    expect(a.sent.at(-1)).toMatchObject({ type: "signal", to: alice.id });
    expect(b.sent.at(-1)).toEqual(request);
  });

  it("merges later successes by device ID and preserves each server's subscriptions", async () => {
    const { session, a, b, received } = await connected();
    session.send(JSON.stringify(request));
    a.receive(resolved([alice]));
    expect(received.filter((p) => p.type === "group_resolved")).toHaveLength(1);
    b.receive(resolved([alice, bob]));
    expect(
      received.filter((p) => p.type === "peer_updated").map((p) => p.peer),
    ).toEqual([alice, bob]);
    expect(received.filter((p) => p.type === "group_resolved")).toHaveLength(1);
    a.receive({ type: "peer_left", id: alice.id });
    expect(received.some((p) => p.type === "peer_left")).toBe(false);
    b.receive({ type: "peer_left", id: alice.id });
    expect(received.filter((p) => p.type === "peer_left")).toEqual([
      { type: "peer_left", id: alice.id },
    ]);
    session.send(JSON.stringify({ type: "signal", to: bob.id, data: {} }));
    expect(b.sent.at(-1)).toMatchObject({ type: "signal", to: bob.id });
  });

  it("does not report a later server error after a successful lookup", async () => {
    const { session, a, b, received } = await connected();
    session.send(JSON.stringify(request));
    a.receive(resolved([]));
    b.receive(error);
    expect(received).toEqual([resolved([])]);
  });

  it("reports an error only after every queried server fails", async () => {
    const { session, a, b, received } = await connected();
    session.send(JSON.stringify(request));
    a.receive(error);
    expect(received).toEqual([]);
    b.receive(error);
    expect(received).toEqual([error]);
  });

  it("continues after a server disconnects or throws while sending", async () => {
    const { session, a, b, received } = await connected();
    vi.spyOn(a, "send").mockImplementation(() => {
      throw new Error("closed");
    });
    session.send(JSON.stringify(request));
    expect(b.sent.at(-1)).toEqual(request);
    expect(received.some((p) => p.type === "connect_error")).toBe(false);
    b.receive(resolved([bob]));
    expect(received.filter((p) => p.type === "group_resolved")).toEqual([
      resolved([bob]),
    ]);

    session.send(JSON.stringify({ ...request, requestId: "disconnect" }));
    b.close();
    expect(received.filter((p) => p.type === "connect_error")).toEqual([
      {
        type: "connect_error",
        requestId: "disconnect",
        code: "connection_closed",
      },
    ]);
  });

  it("skips servers that have not joined and refuses lookup with no connected server", async () => {
    const { session, a, b } = await setup(["one", "two"]);
    expect(() => session.send(JSON.stringify(request))).toThrow("服务器设置");
    a.receive({ type: "welcome", peers: [] });
    session.send(JSON.stringify(request));
    expect(a.sent.at(-1)).toEqual(request);
    expect(b.sent.at(-1).type).toBe("join");
  });

  it("ignores malformed group results while another server can still succeed", async () => {
    const { session, a, b, received } = await connected();
    session.send(JSON.stringify(request));
    a.receive(resolved([{ ...alice, numericId: "456789" }]));
    expect(received).toEqual([]);
    b.receive(resolved([bob]));
    expect(
      received.filter((p) => p.type === "peer_updated").map((p) => p.peer),
    ).toEqual([bob]);
    expect(received.filter((p) => p.type === "group_resolved")).toEqual([
      resolved([bob]),
    ]);
  });

  it("restores a contact on any server while rejecting a mismatched device identity", async () => {
    const { session, a, b, received } = await connected();
    const restore = { ...request, type: "connect", expectedPeerId: alice.id };
    session.send(JSON.stringify(restore));
    expect(a.sent.at(-1)).toEqual(restore);
    expect(b.sent.at(-1)).toEqual(restore);
    b.receive({ type: "peer_resolved", requestId: request.requestId, peer: bob });
    expect(received).toEqual([]);
    a.receive({
      type: "peer_resolved",
      requestId: request.requestId,
      peer: alice,
    });
    expect(received.filter((p) => p.type === "peer_resolved")).toEqual([
      { type: "peer_resolved", requestId: request.requestId, peer: alice },
    ]);
    expect(
      received.filter((p) => p.type === "peer_updated").map((p) => p.peer),
    ).toEqual([alice]);
  });

  it("isolates concurrent requests, expires silent lookups, and cleans up on close", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const { session, a, b, received } = await connected();
    session.send(JSON.stringify(request));
    const other = { ...request, requestId: "other", numericId: "456789" };
    session.send(JSON.stringify(other));
    a.receive(error);
    b.receive({ ...other, type: "group_resolved", peers: [] });
    expect(received).toEqual([{ ...other, type: "group_resolved", peers: [] }]);
    await vi.advanceTimersByTimeAsync(SIGNALING_CONFIG.lookupTimeoutMs + 1);
    b.receive(resolved([bob]));
    expect(received.some((p) => p.type === "peer_updated")).toBe(false);
    session.send(JSON.stringify({ ...request, requestId: "closing" }));
    session.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
