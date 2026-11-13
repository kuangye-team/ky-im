import { runtimeLog } from "../../runtime-logs";
import { SIGNALING_CONFIG } from "../../config";
import { isNumericId, isProfile } from "../protocol";
import type { Profile } from "../types";
import type { DiscoveryAdapter, DiscoverySession } from "./types";

type Source = {
  adapter: DiscoveryAdapter;
  session?: DiscoverySession;
  peers: Map<string, Profile>;
  joined: boolean;
  numericId?: string;
  retry?: ReturnType<typeof setTimeout>;
  lastSeen: number;
  attempts: number;
};

type Lookup = {
  type: "connect" | "connect_group";
  numericId: string;
  expectedPeerId?: string;
  pending: Set<Source>;
  resolved: boolean;
  error?: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
};

/** Each discovery service owns its presence, retries and heartbeat. Identity is always the local UUID. */
export class CombinedDiscoveryAdapter implements DiscoveryAdapter {
  readonly name: string;
  readonly supportsNumericIds: boolean;
  readonly usesBrowserNetworkStatus: boolean;
  constructor(private readonly adapters: DiscoveryAdapter[]) {
    this.name = [...new Set(adapters.map((a) => a.name))].join("+");
    this.supportsNumericIds = adapters.some((a) => a.supportsNumericIds);
    this.usesBrowserNetworkStatus = adapters.every(
      (a) => a.usesBrowserNetworkStatus,
    );
  }
  open(): DiscoverySession {
    return new CombinedSession(this.adapters);
  }
}

class CombinedSession implements DiscoverySession {
  readyState = 0;
  onopen: DiscoverySession["onopen"] = null;
  onmessage: DiscoverySession["onmessage"] = null;
  onerror: DiscoverySession["onerror"] = null;
  onclose: DiscoverySession["onclose"] = null;
  private sources: Source[];
  private join?: { type: string; room: string; profile: Profile };
  private welcomed = false;
  private visible = new Map<string, Profile>();
  private routes = new Map<string, Source>();
  private lookups = new Map<string, Lookup>();
  private primary?: Source;
  private numberPublished = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(adapters: DiscoveryAdapter[]) {
    this.sources = adapters.map((adapter) => ({
      adapter,
      peers: new Map(),
      joined: false,
      lastSeen: Date.now(),
      attempts: 0,
    }));
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  private emit(packet: unknown) {
    if (this.readyState !== 3)
      this.onmessage?.({ data: JSON.stringify(packet) });
  }
  private open(source: Source) {
    if (this.readyState === 3) return;
    try {
      const session = source.adapter.open();
      source.session = session;
      source.lastSeen = Date.now();
      session.onopen = () => {
        if (source.session === session && this.join) {
          try {
            session.send(JSON.stringify(this.join));
          } catch {
            this.lost(source, session);
          }
        }
      };
      session.onmessage = ({ data }) => {
        if (
          source.session !== session ||
          typeof data !== "string" ||
          data.length > SIGNALING_CONFIG.maxMessageChars
        )
          return;
        try {
          this.receive(source, JSON.parse(data));
        } catch {
          /* Ignore malformed discovery packets. */
        }
      };
      session.onerror = (event) => {
        if (source.session !== session) return;
        this.lost(source, session);
        if (!this.sources.some((s) => s.joined)) this.onerror?.(event);
      };
      session.onclose = () => this.lost(source, session);
    } catch {
      this.lost(source);
    }
  }
  private lost(source: Source, session = source.session) {
    if (this.readyState === 3 || (session && source.session !== session))
      return;
    runtimeLog("warn", "discovery", "设备查找来源已断开，准备重试", { detail: source.adapter.name });
    source.session = undefined;
    if (session) {
      session.onclose = session.onerror = null;
      session.close();
    }
    source.joined = false;
    source.numericId = undefined;
    source.peers.clear();
    for (const [id, route] of this.routes)
      if (route === source) this.routes.delete(id);
    this.publish();
    this.selectPrimary();
    for (const requestId of this.lookups.keys())
      this.finishLookupSource(requestId, source, {
        type: "connect_error",
        requestId,
        code: "connection_closed",
      });
    clearTimeout(source.retry);
    const delay = Math.min(
      SIGNALING_CONFIG.reconnectMaxDelayMs,
      SIGNALING_CONFIG.reconnectInitialDelayMs *
        2 ** Math.min(source.attempts++, 16),
    );
    source.retry = setTimeout(
      () => this.open(source),
      delay * (0.5 + Math.random() * 0.5),
    );
  }
  private selectPrimary() {
    const next = this.primary?.joined
      ? this.primary
      : this.sources.find((s) => s.joined && s.adapter.supportsNumericIds);
    if (next !== this.primary || !this.numberPublished) {
      this.primary = next;
      this.numberPublished = true;
      this.emit({ type: "discovery_number", numericId: next?.numericId });
    }
  }
  private publish() {
    const peers = new Map<string, Profile>();
    // Prefer the numeric identity of the server used to reach that device.
    for (const source of [...this.sources].reverse())
      if (source.joined)
        for (const [id, peer] of source.peers)
          peers.set(id, { ...peers.get(id), ...peer });
    for (const [id, peer] of peers) {
      if (id === this.join?.profile.id) {
        peers.delete(id);
        continue;
      }
      if (
        !this.visible.has(id) ||
        (
          [
            "id",
            "name",
            "bio",
            "color",
            "avatar",
            "device",
            "clientType",
            "numericId",
          ] as const
        ).some((key) => this.visible.get(id)?.[key] !== peer[key])
      )
        this.emit({ type: "peer_updated", peer });
    }
    for (const id of this.visible.keys())
      if (!peers.has(id)) this.emit({ type: "peer_left", id });
    this.visible = peers;
  }
  private lookup(packet: Record<string, any>, raw: string) {
    const sources = this.sources.filter(
      (source) =>
        source.adapter.supportsNumericIds &&
        source.joined &&
        source.session?.readyState === 1,
    );
    if (!sources.length)
      throw new Error("暂时无法联系设备，请检查发现方式和服务器设置");
    const requestId = packet.requestId;
    this.lookups.set(requestId, {
      type: packet.type,
      numericId: packet.numericId,
      expectedPeerId: packet.expectedPeerId,
      pending: new Set(sources),
      resolved: false,
      // The engine owns the user-facing timeout; bound our response bookkeeping too.
      timer: setTimeout(
        () => this.lookups.delete(requestId),
        SIGNALING_CONFIG.lookupTimeoutMs,
      ),
    });
    for (const source of sources) {
      try {
        source.session!.send(raw);
      } catch {
        this.lost(source);
      }
    }
  }
  private finishLookupSource(
    requestId: string,
    source: Source,
    error?: Record<string, unknown>,
  ) {
    const lookup = this.lookups.get(requestId);
    if (!lookup?.pending.delete(source)) return;
    if (error) lookup.error = error;
    if (lookup.pending.size) return;
    clearTimeout(lookup.timer);
    this.lookups.delete(requestId);
    if (!lookup.resolved && lookup.error) this.emit(lookup.error);
  }
  private receiveLookup(source: Source, packet: Record<string, any>) {
    const lookup = this.lookups.get(packet.requestId);
    if (!lookup?.pending.has(source)) return;
    if (packet.type === "connect_error") {
      this.finishLookupSource(packet.requestId, source, packet);
      return;
    }
    const validGroup =
      lookup.type === "connect_group" &&
      packet.type === "group_resolved" &&
      packet.numericId === lookup.numericId &&
      Array.isArray(packet.peers) &&
      packet.peers.every(
        (peer: unknown) =>
          isProfile(peer) && peer.numericId === lookup.numericId,
      );
    const validPeer =
      lookup.type === "connect" &&
      packet.type === "peer_resolved" &&
      isProfile(packet.peer) &&
      packet.peer.id !== this.join?.profile.id &&
      packet.peer.numericId === lookup.numericId &&
      (!lookup.expectedPeerId || packet.peer.id === lookup.expectedPeerId);
    if (!validGroup && !validPeer) {
      this.finishLookupSource(packet.requestId, source, {
        type: "connect_error",
        requestId: packet.requestId,
        code: "invalid_response",
      });
      return;
    }
    const peers: Profile[] = validGroup ? packet.peers : [packet.peer];
    for (const peer of peers) source.peers.set(peer.id, peer);
    this.publish();
    // Resolve promptly, but keep merging later successes from the other servers.
    if (!lookup.resolved) {
      lookup.resolved = true;
      this.emit(packet);
    }
    this.finishLookupSource(packet.requestId, source);
  }
  private receive(source: Source, packet: Record<string, any>) {
    if (!packet || typeof packet !== "object") return;
    if (
      packet.type === "group_resolved" ||
      packet.type === "peer_resolved" ||
      (packet.type === "connect_error" && this.lookups.has(packet.requestId))
    ) {
      this.receiveLookup(source, packet);
      return;
    }
    if (packet.type === "pong" || packet.type === "welcome")
      source.lastSeen = Date.now();
    if (packet.type === "welcome" && Array.isArray(packet.peers)) {
      source.joined = true;
      source.attempts = 0;
      source.numericId = isNumericId(packet.numericId)
        ? packet.numericId
        : undefined;
      source.peers = new Map(
        packet.peers.filter(isProfile).map((p: Profile) => [p.id, p]),
      );
      if (!this.welcomed) {
        this.welcomed = true;
        this.emit({ type: "welcome", peers: [] });
      }
      this.selectPrimary();
      this.publish();
    } else if (
      (packet.type === "peer_joined" || packet.type === "peer_updated") &&
      isProfile(packet.peer)
    ) {
      source.peers.set(packet.peer.id, packet.peer);
      this.publish();
    } else if (packet.type === "peer_left" && typeof packet.id === "string") {
      source.peers.delete(packet.id);
      if (this.routes.get(packet.id) === source) this.routes.delete(packet.id);
      this.publish();
    } else if (
      packet.type === "signal" &&
      typeof packet.from === "string" &&
      source.peers.has(packet.from)
    ) {
      this.routes.set(packet.from, source);
      this.emit(packet);
    } else if (packet.type === "number_updated") {
      if (Array.isArray(packet.peerIds) && isNumericId(packet.numericId)) {
        if (packet.peerIds.includes(this.join?.profile.id))
          source.numericId = packet.numericId;
        for (const id of packet.peerIds) {
          const peer = source.peers.get(id);
          if (peer)
            source.peers.set(id, { ...peer, numericId: packet.numericId });
        }
        this.publish();
        if (source === this.primary) this.emit(packet);
      }
    } else if (
      packet.type === "connect_error" ||
      (packet.type === "error" &&
        (packet.code === "replaced" || !this.sources.some((s) => s.joined)))
    )
      this.emit(packet);
    else if (packet.type === "pong") this.emit(packet);
  }
  send(raw: string) {
    if (this.readyState !== 1) throw new Error("连接已关闭");
    const packet = JSON.parse(raw);
    if (packet.type === "join") {
      this.join = packet;
      for (const source of this.sources) this.open(source);
      this.heartbeat = setInterval(() => {
        for (const source of this.sources) {
          if (!source.session) continue;
          if (
            Date.now() - source.lastSeen >
            SIGNALING_CONFIG.heartbeatTimeoutMs
          )
            this.lost(source);
          else if (source.session.readyState === 1) {
            try {
              source.session.send('{"type":"ping"}');
            } catch {
              this.lost(source);
            }
          }
        }
      }, SIGNALING_CONFIG.heartbeatIntervalMs);
    } else if (packet.type === "connect" || packet.type === "connect_group") {
      this.lookup(packet, raw);
    } else if (packet.type === "profile") {
      if (this.join) this.join.profile = packet.profile;
      for (const source of this.sources)
        if (source.joined) {
          try {
            source.session?.send(raw);
          } catch {
            this.lost(source);
          }
        }
    } else if (packet.type === "ping") {
      if (this.sources.some((s) => s.joined))
        queueMicrotask(() => this.emit({ type: "pong" }));
    } else {
      const source =
        packet.type === "signal"
          ? (this.routes.get(packet.to) ??
            this.sources.find((s) => s.joined && s.peers.has(packet.to)))
          : this.primary;
      if (!source?.joined || source.session?.readyState !== 1)
        throw new Error("暂时无法联系设备，请检查发现方式和服务器设置");
      source.session.send(raw);
    }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearInterval(this.heartbeat);
    for (const lookup of this.lookups.values()) clearTimeout(lookup.timer);
    this.lookups.clear();
    for (const source of this.sources) {
      clearTimeout(source.retry);
      if (source.session) {
        source.session.onclose = source.session.onerror = null;
        source.session.close();
      }
    }
    this.onclose?.(new Event("close"));
  }
}
