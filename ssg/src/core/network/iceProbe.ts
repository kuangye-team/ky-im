import { runtimeLog } from "../../runtime-logs";
import { isTurnServer, rtcIceServer, type IceServer } from "../../ice-servers";

export type IceProbeResult = {
  url: string;
  state: "available" | "unavailable" | "cancelled";
  elapsedMs?: number;
  testedAt?: number;
};

function probe(server: IceServer, timeoutMs: number, signal?: AbortSignal): Promise<IceProbeResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let pc: RTCPeerConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (state: IceProbeResult["state"]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (pc) {
        pc.onicecandidate = null;
        pc.onicegatheringstatechange = null;
        pc.close();
      }
      runtimeLog("debug", "connection", "辅助线路检查已结束", { raw: {
        phase: "ice-candidate-gathering", kind: isTurnServer(server.urls) ? "turn" : "stun",
        outcome: state, elapsedMs: Math.round(performance.now() - started),
      } });
      resolve({ url: server.urls, state, testedAt: Date.now(), ...(state === "available"
        ? { elapsedMs: Math.max(1, Math.round(performance.now() - started)) }
        : {}) });
    };
    const abort = () => finish("cancelled");
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish("unavailable"), timeoutMs);
    try {
      const relay = isTurnServer(server.urls);
      pc = new RTCPeerConnection({ iceServers: [rtcIceServer(server)], iceTransportPolicy: relay ? "relay" : "all" });
      pc.onicecandidate = ({ candidate }) => {
        // Host candidates do not prove a server responded. TURN must allocate a relay.
        const type = candidate?.type ?? candidate?.candidate.match(/\btyp (\w+)/)?.[1];
        if (type === (relay ? "relay" : "srflx")) finish("available");
        else if (!candidate) finish("unavailable");
      };
      pc.onicegatheringstatechange = () => {
        if (pc?.iceGatheringState === "complete") finish("unavailable");
      };
      // A per-interface icecandidateerror (e.g. IPv6) is not a global failure.
      pc.createDataChannel("ice-probe");
      void pc.createOffer().then((offer) => {
        if (!finished) return pc!.setLocalDescription(offer);
      }).catch(() => finish("unavailable"));
    } catch {
      finish("unavailable");
    }
  });
}

/** Start every probe together. The first success settles independently of slow/failing servers. */
export function probeIceServers(
  servers: IceServer[],
  options: { signal?: AbortSignal; timeoutMs?: number; onResult?: (result: IceProbeResult) => void } = {},
) {
  let winner: IceProbeResult | undefined;
  let resolveFirst!: (result: IceProbeResult | undefined) => void;
  const first = new Promise<IceProbeResult | undefined>((resolve) => { resolveFirst = resolve; });
  const completed = Promise.all(servers.map((server) =>
    probe(server, options.timeoutMs ?? 5000, options.signal).then((result) => {
      if (!winner && result.state === "available") {
        winner = result;
        resolveFirst(result);
      }
      options.onResult?.(result);
      return result;
    }),
  )).then((results) => {
    if (!winner) resolveFirst(undefined);
    return results;
  });
  return { first, completed };
}
