import { transferMetrics as metrics } from "../../transferMetrics";
import { pEvent } from "p-event";
import type { MessageStream } from "@libp2p/interface";

/** Wait for this drain cycle. @libp2p/utils 7.4.5 caches its first onDrain promise. */
export async function drain(stream: MessageStream, timeout = 60_000) {
  while (stream.writableNeedsDrain) {
    await metrics.timed("transport.drain", 0, () => pEvent(stream, "drain", {
      rejectionEvents: ["close"],
      signal: AbortSignal.timeout(timeout),
    }));
  }
  if (stream.status !== "open") throw new Error("设备连接已断开");
}
