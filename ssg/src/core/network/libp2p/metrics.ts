import { pureJsCrypto, type ICryptoInterface } from "@chainsafe/libp2p-noise";
import { transferMetrics as metrics } from "../../transferMetrics";
import type { P2pBridge } from "./native";

export function measuredBridge(bridge: P2pBridge): P2pBridge {
  return {
    nativeIO: bridge.nativeIO,
    request: (session, request, onEvent) => metrics.timed(`ipc.request.${request.op}`, 0,
      () => bridge.request(session, request, onEvent && (event => {
        metrics.record(`ipc.event.${event.type}`, event.data?.byteLength ?? 0);
        onEvent(event);
      }))),
    write: (session, data, headers) => metrics.timed(
      headers["x-pipe-token"] ? "ipc.write.pipe" : "ipc.write.frame", data.byteLength,
      () => bridge.write(session, data, headers)),
  };
}

/** Matches Noise's browser default; leave Node's native crypto unchanged. */
export function measuredNoiseCrypto(): ICryptoInterface | undefined {
  if (!metrics.enabled || typeof window === "undefined") return undefined;
  return {
    ...pureJsCrypto,
    chaCha20Poly1305Encrypt: (...args) => {
      const start = metrics.start();
      try { return pureJsCrypto.chaCha20Poly1305Encrypt(...args); }
      finally { metrics.finish("noise.encrypt", start, args[0].byteLength); }
    },
    chaCha20Poly1305Decrypt: (...args) => {
      const start = metrics.start();
      try { return pureJsCrypto.chaCha20Poly1305Decrypt(...args); }
      finally { metrics.finish("noise.decrypt", start, args[0].byteLength); }
    },
  };
}
