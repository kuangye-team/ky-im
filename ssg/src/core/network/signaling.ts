import { SIGNALING_CONFIG } from "../../config";
import type { DiscoveryAdapter, DiscoverySession } from "./types";
import type { RelayTransportAdapter } from "./relay";

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
    private readonly relay?: RelayTransportAdapter,
    private readonly authorization?: string,
  ) {}

  open(): DiscoverySession {
    return openSignalingSession(this.url, this.authorization, this.relay);
  }
}

export function openSignalingSession(
  url?: string,
  authorization?: string,
  relay?: RelayTransportAdapter,
): DiscoverySession {
  const address = signalingAddress(url);
  const open = (address: string) => {
    const socket = new WebSocket(address);
    return relay ? relay.session(socket) : socket;
  };
  if (!authorization) return open(address);
  return new AuthorizedSession(address, authorization, open);
}

const AUTHORIZATION_ERROR = "访问密钥不正确或无权访问，请检查后重试";
const CONNECTION_ERROR = "连接失败，请检查服务器地址或稍后重试";

class AuthorizedSession implements DiscoverySession {
  onopen: DiscoverySession["onopen"] = null;
  onmessage: DiscoverySession["onmessage"] = null;
  onerror: DiscoverySession["onerror"] = null;
  onclose: DiscoverySession["onclose"] = null;
  private session?: DiscoverySession;
  private closed = false;
  private controller = new AbortController();
  get readyState() {
    return this.closed ? 3 : (this.session?.readyState ?? 0);
  }

  constructor(
    address: string,
    authorization: string,
    open: (url: string) => DiscoverySession,
  ) {
    void this.connect(address, authorization, open);
  }

  private async connect(
    address: string,
    authorization: string,
    open: (url: string) => DiscoverySession,
  ) {
    const timer = setTimeout(() => this.controller.abort(), 5000);
    try {
      const endpoint = new URL(address);
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
      endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/ticket";
      endpoint.searchParams.delete("ticket");
      const response = await fetch(endpoint, {
        headers: { Authorization: authorization },
        signal: this.controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403)
        throw new Error(AUTHORIZATION_ERROR);
      if (!response.ok) throw new Error(CONNECTION_ERROR);
      const result = await response.json();
      if (
        result.ticket !== null &&
        (typeof result.ticket !== "string" ||
          !result.ticket ||
          result.ticket.length > 512)
      )
        throw new Error(CONNECTION_ERROR);
      if (this.closed) return;
      const target = new URL(address);
      target.searchParams.delete("ticket");
      if (result.ticket) target.searchParams.set("ticket", result.ticket);
      this.session = open(target.href);
      this.session.onopen = (event) => this.onopen?.(event);
      this.session.onmessage = (event) => this.onmessage?.(event);
      this.session.onerror = (event) => this.onerror?.(event);
      this.session.onclose = (event) => {
        this.closed = true;
        this.onclose?.(event);
      };
    } catch (error) {
      if (this.closed) return;
      this.closed = true;
      const event = Object.assign(new Event("error"), {
        message:
          error instanceof Error && error.message === AUTHORIZATION_ERROR
            ? AUTHORIZATION_ERROR
            : CONNECTION_ERROR,
      });
      this.onerror?.(event);
      this.onclose?.(new Event("close"));
    } finally {
      clearTimeout(timer);
    }
  }

  send(packet: string) {
    if (this.readyState !== 1) throw new Error("连接已断开，请重新发送");
    this.session!.send(packet);
  }

  close() {
    this.closed = true;
    this.controller.abort();
    this.session?.close();
  }
}
