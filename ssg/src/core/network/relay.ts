import { runtimeLog } from "../../runtime-logs";
import { CONNECTION_CONFIG, MAX_CONTROL_BYTES } from "../../config";
import { CHUNK_SIZE, HEADER_SIZE, newId } from "../protocol";
import type {
  DiscoverySession,
  TransportAdapter,
  TransportChannel,
  TransportConnection,
  TransportOptions,
} from "./types";

type Packet =
  | { kind: "open" | "accept" | "close" | "ack" }
  | { kind: "data"; binary: boolean; payload: string };
type Route = {
  socket: WebSocket;
  supported: boolean;
  peers: Set<string>;
  send(raw: string): void;
  dispose(): void;
};
const WINDOW = 8;
const MAX_BUFFER = 1024 * 1024;
// Includes TCP's four-second attempt when enabled, then gives WebRTC six seconds.
export const DIRECT_TIMEOUT_MS = 10_000;

// Share a bounded output budget across all peers on a server. Stay below both
// server relay limits, including receive-credit acknowledgments and burst edges.
function createRoute(socket: WebSocket): Route {
  let at = Date.now(),
    bytes = 0,
    frames = 0,
    queuedBytes = 0,
    closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: string[] = [];
  const flush = () => {
    timer = undefined;
    if (closed) return;
    if (Date.now() - at >= 1000) {
      at = Date.now();
      bytes = 0;
      frames = 0;
    }
    while (queue.length) {
      if (frames >= 600 || bytes + queue[0].length > 4 * 1024 * 1024) {
        timer = setTimeout(
          () => {
            try {
              flush();
            } catch {
              socket.close();
            }
          },
          Math.max(1, 1000 - (Date.now() - at)),
        );
        return;
      }
      const raw = queue.shift()!;
      queuedBytes -= raw.length;
      bytes += raw.length;
      frames++;
      socket.send(raw);
    }
  };
  return {
    socket,
    supported: false,
    peers: new Set(),
    send(raw) {
      if (
        closed ||
        socket.readyState !== 1 ||
        queuedBytes + raw.length > 8 * 1024 * 1024
      )
        throw new Error("连接暂时繁忙，请稍后重试");
      queue.push(raw);
      queuedBytes += raw.length;
      if (!timer) flush();
    },
    dispose() {
      closed = true;
      clearTimeout(timer);
      queue.length = 0;
      queuedBytes = 0;
    },
  };
}

function encode(bytes: Uint8Array) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}

/** Relay stays dormant until direct transports fail. Each route has independent consent. */
export class RelayTransportAdapter implements TransportAdapter {
  readonly name: string;
  private routes = new Set<Route>();
  private connections = new Map<string, RelayFallback>();
  private incoming?: (peerId: string) => void;
  constructor(
    private direct: TransportAdapter,
    private timeoutMs = DIRECT_TIMEOUT_MS,
  ) {
    this.name = `${direct.name}+relay`;
  }
  set onIncoming(value: ((peerId: string) => void) | undefined) {
    this.incoming = value;
    this.direct.onIncoming = value;
  }
  route(peerId: string) {
    return [...this.routes].find((route) => this.allowed(route, peerId));
  }
  private allowed(route: Route, peerId: string) {
    return (
      route.supported &&
      route.socket.readyState === 1 &&
      route.peers.has(peerId)
    );
  }
  /** Wrap only a server for which this device explicitly enabled relay. */
  session(socket: WebSocket): DiscoverySession {
    const route = createRoute(socket);
    this.routes.add(route);
    const lost = () => {
      route.dispose();
      route.supported = false;
      route.peers.clear();
      this.routes.delete(route);
      for (const connection of [...this.connections.values()])
        connection.lost(route);
    };
    const outer: DiscoverySession = {
      get readyState() {
        return socket.readyState;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(raw) {
        const packet = JSON.parse(raw);
        if (packet.type === "join" || packet.type === "profile")
          packet.profile = { ...packet.profile, relay: true };
        socket.send(JSON.stringify(packet));
      },
      close() {
        lost();
        socket.close();
      },
    };
    socket.onopen = (event) => outer.onopen?.(event);
    socket.onerror = (event) => {
      lost();
      outer.onerror?.(event);
    };
    socket.onclose = (event) => {
      lost();
      outer.onclose?.(event);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data.length > 512 * 1024)
        return;
      let packet;
      try {
        packet = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!packet || typeof packet !== "object") return;
      const remember = (peer: { id?: unknown; relay?: unknown }) => {
        if (!peer || typeof peer.id !== "string") return;
        if (peer.relay === true) route.peers.add(peer.id);
        else route.peers.delete(peer.id);
      };
      if (packet.type === "welcome") {
        route.supported = packet.relay === true;
        route.peers.clear();
      }
      if (
        ["welcome", "group_resolved"].includes(packet.type) &&
        Array.isArray(packet.peers)
      )
        packet.peers.forEach(remember);
      if (
        ["peer_joined", "peer_updated", "peer_resolved"].includes(packet.type)
      )
        remember(packet.peer);
      if (packet.type === "peer_left") route.peers.delete(packet.id);
      for (const [id, connection] of this.connections)
        if (!this.allowed(route, id)) connection.lost(route);
      if (packet.type === "relay") {
        if (
          !this.allowed(route, packet.from) ||
          typeof packet.session !== "string" ||
          !packet.data
        )
          return;
        if (packet.data.kind === "open") this.incoming?.(packet.from);
        this.connections
          .get(packet.from)
          ?.receive(route, packet.session, packet.data);
        return;
      }
      if (packet.type === "relay_error") {
        this.connections.get(packet.to)?.rejected(route, packet.session);
        return;
      }
      outer.onmessage?.(event);
    };
    return outer;
  }
  create(options: TransportOptions): TransportConnection {
    const connection = new RelayFallback(
      this,
      this.direct,
      options,
      this.timeoutMs,
      () => {
        if (this.connections.get(options.peerId) === connection)
          this.connections.delete(options.peerId);
      },
    );
    this.connections.set(options.peerId, connection);
    return connection;
  }
}

class RelayFallback implements TransportConnection {
  private direct: TransportConnection = {
    start() {},
    async signal() {},
    close() {},
  };
  private probe?: TransportChannel;
  private relay?: RelayChannel;
  private timer?: ReturnType<typeof setTimeout>;
  private selected = false;
  private closed = false;
  private started = false;
  constructor(
    private router: RelayTransportAdapter,
    direct: TransportAdapter,
    private options: TransportOptions,
    private timeoutMs: number,
    private remove: () => void,
  ) {
    try {
      this.direct = direct.create({
        ...options,
        onChannel: (channel) => this.watch(channel),
        onState: (state) => {
          if (this.closed || this.relay) return;
          if (this.selected) options.onState(state);
          else if (state === "failed") this.fallback();
        },
        onError: (error) => {
          if (this.closed || this.relay) return;
          if (this.selected) options.onError(error);
          else this.fallback();
        },
      });
      if (this.direct.channel) this.watch(this.direct.channel);
    } catch {
      queueMicrotask(() => this.fallback());
    }
  }
  private clearProbe() {
    clearTimeout(this.timer);
    if (this.probe)
      this.probe.onopen = this.probe.onclose = this.probe.onerror = null;
    this.probe = undefined;
  }
  private watch(channel: TransportChannel) {
    if (this.closed || this.relay) {
      channel.close();
      return;
    }
    this.probe = channel;
    channel.onopen = () => {
      if (this.closed || this.relay || this.selected) return;
      this.selected = true;
      this.clearProbe();
      this.options.onChannel(channel);
    };
    channel.onerror = channel.onclose = () => this.fallback();
    if (channel.readyState === "open")
      queueMicrotask(() => channel.onopen?.(new Event("open")));
  }
  private fallback(
    route = this.router.route(this.options.peerId),
    initiate = true,
  ) {
    if (this.closed || this.selected || this.relay) return;
    if (!route) {
      this.options.onError(new Error("暂时连不上对方，请稍后重试"));
      return;
    }
    this.clearProbe();
    runtimeLog("info", "connection", "正在尝试通过服务器转送", { peerId: this.options.peerId });
    this.relay = new RelayChannel(route, this.options.peerId);
    this.direct.close();
    this.options.onChannel(this.relay);
    if (initiate) this.relay.start();
  }
  start() {
    if (this.closed || this.started) return;
    this.started = true;
    this.timer = setTimeout(() => {
      const route = this.router.route(this.options.peerId);
      // Without mutual consent, retain the direct transport's normal deadline.
      if (route) this.fallback(route);
    }, this.timeoutMs);
    this.direct.start();
  }
  async signal(data: unknown) {
    if (!this.closed && !this.relay) await this.direct.signal(data);
  }
  receive(route: Route, session: string, packet: Packet) {
    if (this.closed || this.selected) return;
    if (packet.kind === "open") {
      this.fallback(route, false);
      if (!this.relay) return;
      // Simultaneous fallback attempts converge on the lower device ID's offer.
      if (this.relay.session && this.options.localId < this.options.peerId)
        return;
      this.relay.accept(route, session);
    } else this.relay?.receive(route, session, packet);
  }
  lost(route: Route) {
    if (this.relay?.route === route) this.relay.fail();
  }
  rejected(route: Route, session: string) {
    if (this.relay?.route === route && this.relay.session === session)
      this.relay.fail();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearProbe();
    this.direct.close();
    this.relay?.close();
    this.remove();
  }
}

class RelayChannel extends EventTarget implements TransportChannel {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = CONNECTION_CONFIG.sendBufferLowBytes as number;
  onopen: TransportChannel["onopen"] = null;
  onmessage: TransportChannel["onmessage"] = null;
  onerror: TransportChannel["onerror"] = null;
  onclose: TransportChannel["onclose"] = null;
  session?: string;
  private queued: { packet: Packet; bytes: number }[] = [];
  private inflight: number[] = [];
  private receiving = 0;
  private handshake?: ReturnType<typeof setTimeout>;
  constructor(
    public route: Route,
    private peerId: string,
  ) {
    super();
  }
  private write(data: Packet) {
    if (this.route.socket.readyState !== 1)
      throw new Error("连接已断开，请重新发送");
    this.route.send(
      JSON.stringify({
        type: "relay",
        to: this.peerId,
        session: this.session,
        data,
      }),
    );
  }
  start() {
    this.session = newId();
    this.handshake = setTimeout(() => this.fail(), 4000);
    try {
      this.write({ kind: "open" });
    } catch {
      this.fail();
    }
  }
  accept(route: Route, session: string) {
    if (this.readyState !== "connecting") return;
    this.route = route;
    this.session = session;
    try {
      this.write({ kind: "accept" });
      this.open();
    } catch {
      this.fail();
    }
  }
  private open() {
    if (this.readyState !== "connecting") return;
    clearTimeout(this.handshake);
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }
  receive(route: Route, session: string, packet: Packet) {
    if (
      this.route !== route ||
      session !== this.session ||
      this.readyState === "closed"
    )
      return;
    if (packet.kind === "accept") {
      this.open();
      return;
    }
    if (packet.kind === "close") {
      this.finish();
      return;
    }
    if (this.readyState !== "open") return;
    if (packet.kind === "ack") {
      const bytes = this.inflight.shift();
      if (bytes === undefined) {
        this.fail();
        return;
      }
      this.bufferedAmount -= bytes;
      this.flush();
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold)
        this.dispatchEvent(new Event("bufferedamountlow"));
    } else if (packet.kind === "data") {
      if (
        typeof packet.payload !== "string" ||
        packet.payload.length > Math.ceil((packet.binary ? CHUNK_SIZE + HEADER_SIZE : MAX_CONTROL_BYTES) / 3) * 4 ||
        typeof packet.binary !== "boolean" ||
        this.receiving >= WINDOW
      ) {
        this.fail();
        return;
      }
      try {
        const raw = atob(packet.payload);
        const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        if (!bytes.length || bytes.length > (packet.binary ? CHUNK_SIZE + HEADER_SIZE : MAX_CONTROL_BYTES))
          throw new Error("Invalid relay frame size");
        this.receiving++;
        this.onmessage?.({
          data: packet.binary
            ? bytes.buffer
            : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        });
      } catch {
        this.fail();
      }
    }
  }
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("连接已断开，请重新发送");
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data);
    if (
      !bytes.length ||
      bytes.length > (typeof data === "string" ? MAX_CONTROL_BYTES : CHUNK_SIZE + HEADER_SIZE) ||
      this.bufferedAmount + bytes.length > MAX_BUFFER ||
      this.queued.length >= 512
    )
      throw new Error("发送内容过多，请稍后重试");
    this.queued.push({
      packet: {
        kind: "data",
        binary: typeof data !== "string",
        payload: encode(bytes),
      },
      bytes: bytes.length,
    });
    this.bufferedAmount += bytes.length;
    this.flush();
  }
  private flush() {
    while (
      this.readyState === "open" &&
      this.inflight.length < WINDOW &&
      this.queued.length
    ) {
      const item = this.queued.shift()!;
      this.inflight.push(item.bytes);
      try {
        this.write(item.packet);
      } catch {
        this.fail();
      }
    }
  }
  consumed() {
    if (this.readyState !== "open" || !this.receiving) return;
    this.receiving--;
    try {
      this.write({ kind: "ack" });
    } catch {
      this.fail();
    }
  }
  private finish() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    clearTimeout(this.handshake);
    this.queued = [];
    this.inflight = [];
    this.bufferedAmount = 0;
    this.onclose?.(new Event("close"));
    this.dispatchEvent(new Event("close"));
  }
  fail() {
    this.close();
  }
  close() {
    if (this.readyState === "closed") return;
    if (this.session) {
      try {
        this.write({ kind: "close" });
      } catch {
        /* Socket already lost. */
      }
    }
    this.finish();
  }
}
