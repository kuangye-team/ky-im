import { CAP, requireServer, CompatibilityError } from "../capabilities";
import type { ProxyMode } from "./settings";
import { openSignalingSession, signalingTarget } from "./signaling";
import type { DiscoverySession } from "./types";

function probeResult(raw: string) {
  let packet;
  try { packet = JSON.parse(raw); }
  catch { throw new CompatibilityError(["server-unsupported"]); }
  if (packet?.type === "capabilities")
    return { relay: requireServer(packet).capabilities.includes(CAP.relay) };
  if (packet?.code === "unauthorized") throw new Error("访问密钥不正确或无权访问，请检查后重试");
  throw new CompatibilityError(["server-unsupported"]);
}

/** Probe the actual WebSocket path/origin without registering a device. */
export async function testServer(
  url: string,
  timeoutMs = 5000,
  authorization?: string,
  proxyMode?: ProxyMode,
): Promise<{ relay: boolean }> {
  if (proxyMode !== undefined) {
    const address = signalingTarget(url, authorization);
    const { invoke } = await import("@tauri-apps/api/core");
    let raw: string;
    try {
      raw = await invoke<string>("probe_signaling_server", {
        address, authorization, timeoutMs, useSystemProxy: proxyMode === "system",
      });
    } catch {
      throw new Error("连接失败，请检查服务器地址或稍后重试");
    }
    return probeResult(raw);
  }
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
          finish(probeResult(String(data)).relay);
        } catch (error) {
          finish(undefined, error instanceof Error ? error.message : undefined, error);
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
