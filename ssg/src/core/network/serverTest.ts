import { CAP, requireServer, CompatibilityError } from "../capabilities";
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
    const finish = (relay?: boolean, message?: string, cause?: unknown) => {
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
        reject(cause instanceof CompatibilityError ? cause : new Error(message || "连接失败，请检查服务器地址或稍后重试"));
      else resolve({ relay });
    };
    try {
      socket = openSignalingSession(url, undefined, authorization);
      timer = setTimeout(() => finish(), timeoutMs);
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ type: "auth", authorization }));
        } catch (error) {
          finish(undefined, undefined, error);
        }
      };
      socket.onmessage = ({ data }) => {
        try {
          const packet = JSON.parse(String(data));
          if (
            packet.type === "capabilities"
          )
            finish(requireServer(packet).capabilities.includes(CAP.relay));
          else if (packet.code === "unauthorized") finish(undefined, "访问密钥不正确或无权访问，请检查后重试");
          else finish(undefined, undefined, new CompatibilityError(["server-unsupported"]));
        } catch (error) {
          finish(undefined, undefined, error);
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
