import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeIceServers } from "./iceProbe";

vi.mock("../../runtime-logs", () => ({ runtimeLog: vi.fn() }));

class Peer {
  static all: Peer[] = [];
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  iceGatheringState = "gathering";
  close = vi.fn();
  createDataChannel = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "probe" }));
  setLocalDescription = vi.fn(async () => {});
  constructor(readonly config: RTCConfiguration) { Peer.all.push(this); }
  candidate(type: string) { this.onicecandidate?.({ candidate: { type } }); }
}

beforeEach(() => {
  Peer.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("RTCPeerConnection", Peer);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("parallel ICE probes", () => {
  it("starts all servers together and resolves the first success without waiting for slow peers", async () => {
    const update = vi.fn();
    const race = probeIceServers([{ urls: "stun:slow" }, { urls: "stun:fast" }, { urls: "stun:offline" }], { onResult: update });
    expect(Peer.all).toHaveLength(3);
    const done = vi.fn();
    void race.completed.then(done);
    Peer.all[0].candidate("host");
    await vi.advanceTimersByTimeAsync(25);
    expect(update).not.toHaveBeenCalled();
    Peer.all[1].candidate("srflx");
    expect(await race.first).toMatchObject({ url: "stun:fast", state: "available" });
    expect(done).not.toHaveBeenCalled();
    expect(Peer.all[1].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    Peer.all[0].candidate("srflx");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await race.completed).map((r) => r.state)).toEqual(["available", "available", "unavailable"]);
    expect(await race.first).toMatchObject({ url: "stun:fast" });
    expect(update).toHaveBeenCalledTimes(3);
    expect(Peer.all.every((p) => p.close.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires TURN relay candidates and waits past irrelevant candidates", async () => {
    const server = { urls: "turn:relay", username: "me", credential: "password" };
    const race = probeIceServers([server]);
    expect(Peer.all[0].config).toEqual({ iceServers: [server], iceTransportPolicy: "relay" });
    Peer.all[0].candidate("srflx");
    expect(Peer.all[0].close).not.toHaveBeenCalled();
    Peer.all[0].candidate("relay");
    expect(await race.first).toMatchObject({ state: "available" });
    await race.completed;
  });

  it("settles on complete, timeout, negotiation rejection, unsupported browser and empty input", async () => {
    const race = probeIceServers([{ urls: "stun:complete" }, { urls: "stun:timeout" }]);
    Peer.all[0].iceGatheringState = "complete";
    Peer.all[0].onicegatheringstatechange?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await race.first).toBeUndefined();
    expect((await race.completed).every((r) => r.state === "unavailable")).toBe(true);
    vi.stubGlobal("RTCPeerConnection", class extends Peer {
      createOffer = vi.fn(async () => { throw Error("rejected"); });
    });
    expect(await probeIceServers([{ urls: "stun:rejected" }]).first).toBeUndefined();
    vi.stubGlobal("RTCPeerConnection", undefined);
    expect(await probeIceServers([{ urls: "stun:unsupported" }]).first).toBeUndefined();
    expect(await probeIceServers([]).first).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts pending offers and all probes without leaking timers or late results", async () => {
    const controller = new AbortController();
    const race = probeIceServers([{ urls: "stun:one" }, { urls: "stun:two" }], { signal: controller.signal });
    controller.abort();
    expect(await race.first).toBeUndefined();
    expect((await race.completed).map((r) => r.state)).toEqual(["cancelled", "cancelled"]);
    for (const pc of Peer.all) {
      expect(pc.close).toHaveBeenCalledOnce();
      expect(pc.setLocalDescription).not.toHaveBeenCalled();
      expect(pc.onicecandidate).toBeNull();
    }
    expect(vi.getTimerCount()).toBe(0);
    await probeIceServers([{ urls: "stun:never-started" }], { signal: controller.signal }).completed;
    expect(Peer.all).toHaveLength(2);
  });
});

it("tests a manually selected disabled TURN server without passing list metadata to WebRTC", async () => {
  const race = probeIceServers([{ urls: "turn:relay.test", name: "Relay", enabled: false, username: "user", credential: "secret" }]);
  expect(Peer.all[0].config).toEqual({ iceServers: [{ urls: "turn:relay.test", username: "user", credential: "secret" }], iceTransportPolicy: "relay" });
  Peer.all[0].candidate("host");
  expect(Peer.all[0].close).not.toHaveBeenCalled();
  Peer.all[0].candidate("relay");
  expect(await race.first).toMatchObject({ state: "available" });
  await race.completed;
});
