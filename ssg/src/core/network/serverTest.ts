import { openSignalingSession } from "./signaling";
import type { DiscoverySession } from "./types";

/** Probe the actual WebSocket path/origin without registering a device. */
export function testServer(
  url: string,
  timeoutMs = 5000,
  authorization?: string,
): Promise<{ relay: boolean }> {
  return new Promise((resolve, reject) => {
    let socket: DiscoverySession;
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (relay?: boolean, message?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket) {
        socket.onopen =
          socket.onmessage =
          socket.onclose =
          socket.onerror =
            null;
        socket.close();
      }
      if (relay === undefined)
        reject(new Error(message || "连接失败，请检查服务器地址或稍后重试"));
      else resolve({ relay });
    };
    try {
      socket = openSignalingSession(url, authorization);
      timer = setTimeout(() => finish(), timeoutMs);
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ type: "capabilities" }));
        } catch {
          finish();
        }
      };
      socket.onmessage = ({ data }) => {
        try {
          const packet = JSON.parse(String(data));
          if (
            packet.type === "capabilities" &&
            typeof packet.relay === "boolean"
          )
            finish(packet.relay);
          else finish();
        } catch {
          finish();
        }
      };
      socket.onerror = (event) =>
        finish(undefined, (event as ErrorEvent)?.message);
      socket.onclose = () => finish();
    } catch {
      finish();
    }
  });
}
