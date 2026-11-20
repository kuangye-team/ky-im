import { requireServer, CompatibilityError, type RuntimeInfo } from "../capabilities";
import { SIGNALING_CONFIG } from "../../config";
import type { DiscoveryAdapter, DiscoverySession } from "./types";
export interface SignalingHook { socket?(address: string): WebSocket; session(socket: WebSocket): DiscoverySession }

/** Server responses that reach discovery. The transport reports consumed relay and RTC traffic separately. */
export function confirmsActivity(packet: Record<string, unknown>) {
  switch (packet.type) {
    case "welcome": case "discovery_updated": case "group_resolved": return Array.isArray(packet.peers);
    case "peer_joined": case "peer_updated": case "peer_resolved": return !!packet.peer && typeof packet.peer === "object";
    case "peer_left": case "numeric_id_changed": return typeof packet.id === "string";
    case "signal": return typeof packet.from === "string" && !!packet.data && typeof packet.data === "object";
    case "numeric_id_rejected": case "connect_error": case "error": return typeof packet.code === "string";
    case "pong": return true;
    default: return false;
  }
}

export function signalingAddress(url?: string) {
  return (
    url ||
    SIGNALING_CONFIG.url ||
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`
  );
}

export class SignalingDiscoveryAdapter implements DiscoveryAdapter {
  readonly name = "signaling";
  readonly supportsNumericIds = true;
  readonly usesBrowserNetworkStatus = true;

  constructor(
    private readonly url?: string,
    private readonly relay?: SignalingHook,
    private readonly authorization?: string,
  ) {}

  open(): DiscoverySession {
    return new NegotiatedSession(openSignalingSession(this.url, this.relay, this.authorization), this.authorization);
  }
}

export function openSignalingSession(
  url?: string,
  relay?: SignalingHook,
  credential?: string,
): DiscoverySession {
  const target = new URL(signalingAddress(url));
  target.search = "";
  target.searchParams.set("room", SIGNALING_CONFIG.room);
  if (target.protocol !== "wss:" && (target.protocol !== "ws:" || (credential && !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))))
    throw new Error("请使用 wss:// 安全地址连接此服务器");
  const socket = relay?.socket?.(target.href) ?? new WebSocket(target.href);
  return relay?.session(socket) ?? socket;
}

/** Protocol boundary: no application join is sent before minimum server requirements pass. */
class NegotiatedSession implements DiscoverySession {
  onactivity?: () => void;
  onopen: DiscoverySession["onopen"] = null;
  onmessage: DiscoverySession["onmessage"] = null;
  onerror: DiscoverySession["onerror"] = null;
  onclose: DiscoverySession["onclose"] = null;
  private info?: RuntimeInfo;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  get readyState() { return this.closed ? 3 : this.info ? this.inner.readyState : 0; }
  constructor(private inner: DiscoverySession, authorization?: string) {
    inner.onactivity = () => { if (this.info && !this.closed) this.onactivity?.(); };
    const fail = (error: unknown) => {
      const cause = error instanceof CompatibilityError ? error : new CompatibilityError(["server-unsupported"]);
      this.onerror?.(Object.assign(new Event("error"), { message: cause.message, cause }));
      this.close(); this.onclose?.(new Event("close"));
    };
    inner.onopen = () => {
      if (this.closed) return;
      this.timer = setTimeout(() => fail(new CompatibilityError(["server-unsupported"])), 5000);
      try { inner.send(JSON.stringify({ type: "auth", authorization })); } catch (error) { fail(error); }
    };
    inner.onmessage = event => {
      if (this.closed) return;
      if (!this.info) {
        try {
          if (typeof event.data !== "string" || event.data.length > SIGNALING_CONFIG.maxMessageChars) throw new CompatibilityError(["server-unsupported"]);
          const packet = JSON.parse(event.data);
          if (packet.type === "error" && packet.code === "unauthorized") {
            this.onerror?.(Object.assign(new Event("error"), {message: "访问密钥不正确或无权访问，请检查后重试"}));
            this.close();
            return;
          }
          if (packet.type !== "capabilities") throw new CompatibilityError(["server-unsupported"]);
          this.info = requireServer(packet); clearTimeout(this.timer); this.onopen?.(new Event("open"));
        } catch (error) { fail(error); }
      } else this.onmessage?.(event);
    };
    inner.onerror = event => this.onerror?.(event);
    inner.onclose = event => { this.closed = true; clearTimeout(this.timer); this.onclose?.(event); };
  }
  send(packet: string) {
    if (this.readyState !== 1) throw new Error("连接已断开，请重新发送");
    this.inner.send(packet);
  }
  close() { this.closed = true; clearTimeout(this.timer); this.inner.close(); }
}
