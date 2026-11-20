import { pEvent } from "p-event";
import { CAP, canDialWebTransport } from "../../capabilities";
import { browserWebTransport, webTransportBudgetMs } from "./webtransport";
import { measuredNoiseCrypto } from "./metrics";
import { createLibp2p } from "libp2p";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { fullProfile, publicProfile, PROFILE_FRAME_BYTES } from "../../profile-wire";
import { byteStream } from "@libp2p/utils";
import { identify } from "@libp2p/identify";
import { peerIdFromString } from "@libp2p/peer-id";
import type { Connection, Stream } from "@libp2p/interface";
import type { Profile } from "../../types";
import type {
  TransportAdapter,
  TransportConnection,
  TransportOptions,
} from "../types";
import { CentralBridge, type RtcSignal } from "./bridge";
import { bridgeTransport, RTC_ADDRESS, relayAddress } from "./transports";
import {
  CHAT_PROTOCOL,
  FILE_PROTOCOL,
  PING_PROTOCOL,
  ProtocolChannel,
  frame,
} from "./channel";
import { newId } from "../../protocol";
import { runtimeLog } from "../../../runtime-logs";
const revision = (n: unknown, minimum = 1): n is number => Number.isSafeInteger(n) && Number(n) >= minimum;
function exchangeStream(stream: Stream, signal: AbortSignal, maxBytes = PROFILE_FRAME_BYTES) {
  const io = byteStream(stream, {maxBufferSize: Math.max(65536, maxBytes + 5)});
  return {
    async read() {
      const head = await io.read({bytes: 5, signal});
      const length = head.getUint32(0);
      if (head.get(4) !== 1 || !length || length > maxBytes) throw new Error("Invalid JSON frame");
      return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode((await io.read({bytes: length, signal})).subarray()));
    },
    write: (packet: unknown) => io.write(frame(JSON.stringify(packet)), {signal}),
  };
}

export class PeerNode implements TransportAdapter {
  readonly name = "libp2p";
  onIncoming?: TransportAdapter["onIncoming"];
  onProfile?: (profile: Profile) => void;
  node?: Awaited<ReturnType<typeof this.build>>;
  channels = new Map<string, ProtocolChannel>();
  visible = new Map<string, Set<string>>();
  private profiles = new Map<string, Profile>();
  cachedProfile?: (peer: string) => Profile | undefined;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly owners = new WeakMap<Connection, ProtocolChannel>();
  private readonly routes = new WeakMap<ProtocolChannel, Set<Connection>>();
  private readonly webTransportDials = new Map<string, { controller: AbortController; result: Promise<Connection> }>();
  private readonly warmupQueue = new Set<string>();
  private readonly warmupRetries = new Map<string, {at: number; delay: number}>();
  private readonly opening = new WeakMap<ProtocolChannel, Promise<void>>();
  private readonly retiring = new WeakMap<ProtocolChannel, Promise<void>>();
  private latest?: Profile;

  constructor(readonly bridge: CentralBridge) {
    bridge.supportsBulk = true;
    bridge.admitInbound = peer => this.onIncoming?.(peer) !== false;
    bridge.activeConnection = peer => this.channels.get(peer)?.connectionId;
    bridge.beforeJoin = () => this.start();
    bridge.cachedProfile = peer => this.cached(peer);
    bridge.onReverseDial = (peer, intent) => {
      if (this.stopping || this.channels.get(peer)?.readyState === "open") return;
      if (intent === "connect") {
        this.warmupRetries.delete(peer);
        this.warmupQueue.delete(peer);
        this.onConnectRequest?.(peer);
      } else if (!this.webTransportDials.has(peer)) {
        this.warmupQueue.add(peer);
        this.warmDirectConnections();
      }
    };
    bridge.webTransportExchange = peer => {
      const connection = this.node?.getConnections(peerIdFromString(peer)).find(c =>
        c.status === "open" && c.remoteAddr.toString().includes("/webtransport/"));
      if (!connection) return;
      return async (offer, signal) => {
        const stream = await connection.newStream("/hummingbird/rtc-signal/2.0.0", {signal});
        try {
          const io = exchangeStream(stream, signal, 160 * 1024);
          await io.write(offer);
          const answer: RtcSignal = await io.read();
          await stream.close({signal});
          return answer;
        } catch (error) { stream.abort(error as Error); throw error; }
      };
    };
    bridge.onProfile = (profile, source) => {
      const sources = this.visible.get(profile.id) ?? new Set();
      sources.add(source);
      this.visible.set(profile.id, sources);
      void this.start()
        .then(async () => {
          const node = this.node!;
          await node.peerStore.merge(peerIdFromString(profile.id), {
            multiaddrs: bridge.addresses(profile.id),
          });
        })
        .catch(() => {});
    };
    bridge.onRemove = (peer, source) => {
      const sources = this.visible.get(peer);
      sources?.delete(source);
      if (!bridge.webTransportAddresses(peer).length) {
        this.warmupRetries.delete(peer);
        this.warmupQueue.delete(peer);
        this.webTransportDials.get(peer)?.controller.abort();
      }
      if (sources?.size) return;
      this.visible.delete(peer);
    };
  }
  onConnectRequest?: TransportAdapter["onConnectRequest"];
  handleBackgroundDial(peer: string) {
    if (!this.bridge.reverseSource(peer, CAP.app)) return false;
    const retry = this.warmupRetries.get(peer);
    if (retry && Date.now() >= retry.at && !this.webTransportDials.has(peer)) {
      this.warmupQueue.add(peer);
      this.warmDirectConnections();
    }
    return true;
  }
  private warmDirectConnections() {
    for (const peer of this.warmupQueue) {
      if (this.webTransportDials.size >= 4 || this.stopping) break;
      this.warmupQueue.delete(peer);
      if (!this.node || this.channels.get(peer)?.readyState === "open" ||
          !this.bridge.webTransportAddresses(peer).length || this.bridge.negotiating(peer)) continue;
      // A background failure leaves the peer discoverable. Only a requested connection falls back.
      void this.dialWebTransport(peer).catch(() => {
        if (this.stopping || !this.bridge.webTransportAddresses(peer).length) return;
        const delay = Math.min((this.warmupRetries.get(peer)?.delay ?? 2500) * 2, 120_000);
        this.warmupRetries.set(peer, {at: Date.now() + delay, delay});
      });
    }
  }
  private dialWebTransport(peer: string) {
    const existing = this.webTransportDials.get(peer);
    if (existing) return existing.result;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(webTransportBudgetMs)]);
    const result = this.node!.dial(this.bridge.webTransportAddresses(peer), {signal}).finally(() => {
      this.webTransportDials.delete(peer);
      this.warmDirectConnections();
    });
    this.webTransportDials.set(peer, {controller, result});
    return result;
  }
  private async build() {
    const identity = await this.bridge.identity;
    return createLibp2p({
      privateKey: identity.key,
      addresses: {
        listen: [
          relayAddress("listener"),
          ...(this.bridge.rtcEnabled ? [RTC_ADDRESS] : []),
        ],
      },
      transports: [
        ...(canDialWebTransport() ? [browserWebTransport()] : []),
        bridgeTransport(this.bridge, "relay"),
        ...(this.bridge.rtcEnabled
          ? [bridgeTransport(this.bridge, "rtc")]
          : []),
      ],
      connectionEncrypters: [noise({ crypto: measuredNoiseCrypto() })],
      streamMuxers: [yamux({ maxInboundStreams: 32, maxOutboundStreams: 32 })],
      connectionManager: {
        maxConnections: 64,
        maxParallelDials: 4,
        dialTimeout: 25000,
      },
      connectionMonitor: { enabled: false },
      connectionGater: {
        denyDialMultiaddr: () => false,
        denyInboundEncryptedConnection: (peer) =>
          !this.visible.has(peer.toString()),
      },
      services: {
        identify: identify(),
      },
    });
  }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.node) return;
    return (this.starting ??= (async () => {
      this.node = await this.build();
      const node = this.node;
      await node.handle(PING_PROTOCOL, (stream, connection) => this.respond(stream, connection),
        {maxInboundStreams: 4, maxOutboundStreams: 4, runOnLimitedConnection: true});
      for (const protocol of [CHAT_PROTOCOL, FILE_PROTOCOL])
        await node.handle(
          protocol,
          (stream, connection) => {
            const peer = connection.remotePeer.toString();
            const channel = this.owners.get(connection);
            if (!channel || channel.readyState === "closed" || this.channels.get(peer) !== channel ||
                (channel.connection && channel.connection !== connection)) {
              stream.abort(new Error("Inactive connection"));
              return;
            }
            if (!channel.connection) channel.causeEventId = undefined;
            channel.connection = connection;
            channel.attach(protocol, stream, connection);
            if (channel.readyState === "open") this.closeAlternatives(channel);
          },
          { maxInboundStreams: 1, maxOutboundStreams: 1 },
        );
      node.addEventListener("connection:open", (event) => {
        const connection = event.detail;
        const peer = connection.remotePeer.toString();
        if (!this.visible.has(peer) || this.onIncoming?.(peer) === false || this.stopping) {
          connection.abort(new Error("Peer not admitted"));
          return;
        }
        const channel = this.channel(peer);
        this.warmupRetries.delete(peer);
        this.visible.get(peer)?.add("connection");
        runtimeLog("info", "connection", "底层连接已建立", {peerId: peer, raw: {
          attemptId: channel.attemptId, connectionId: connection.id, direction: connection.direction,
          rtcSessionId: this.bridge.sessionByTimeline.get(connection.timeline), layer: "libp2p" }});
        this.bridge.connectionByTimeline.set(connection.timeline, connection.id);
        this.owners.set(connection, channel);
        this.routes.get(channel)!.add(connection);
        if (channel.readyState === "open") this.closeAlternatives(channel);
        else void this.openStreams(connection, channel);
      });
      node.addEventListener("connection:close", ({detail: connection}) => {
        const peer = connection.remotePeer.toString();
        const channel = this.owners.get(connection);
        const routes = channel && this.routes.get(channel);
        routes?.delete(connection);
        const active = channel?.connection === connection;
        const eventId = runtimeLog(active ? "info" : "debug", "connection", "底层连接已关闭", {peerId: peer,
          raw: {layer: "libp2p", connectionId: connection.id, activeConnectionId: channel?.connectionId ?? null,
            causeEventId: channel?.causeEventId, action: active ? "release-active-route" : "release-old-route"}});
        if (active && channel) channel.causeEventId ??= eventId;
        if (channel?.connection === connection) {
          if (channel.readyState === "open") channel.close();
          else {
            channel.release(connection);
            const next = routes?.values().next().value;
            if (next) void this.openStreams(next, channel);
          }
        }
        if (!node.getConnections(connection.remotePeer).length) {
          this.visible.get(peer)?.delete("connection");
          if (!this.visible.get(peer)?.size) this.visible.delete(peer);
        }
      });
    })().catch((error) => {
      this.starting = undefined;
      throw error;
    }));
  }
  private channel(peer: string) {
    let channel = this.channels.get(peer);
    if (!channel || channel.readyState === "closed") {
      const current = new ProtocolChannel(peer, (signal, requestId) => this.probe(peer, signal, requestId));
      current.bulk = () => {
        const id = current.connection && this.bridge.sessionByTimeline.get(current.connection.timeline);
        return id ? this.bridge.rtc.get(id)?.bulk : undefined;
      };
      current.rtcSample = () => {
        const session = current.connection && this.bridge.sessionByTimeline.get(current.connection.timeline);
        return session ? this.bridge.rtc.get(session)?.sample?.() : undefined;
      };
      channel = current;
      const routes = new Set<Connection>();
      this.channels.set(peer, current);
      this.routes.set(current, routes);
      current.addEventListener("close", () => {
        if (this.channels.get(peer) === current) {
          this.channels.delete(peer);
        }
        const done = Promise.allSettled([...routes].map(connection => connection.close()
          .catch(error => connection.abort(error)))).then(() => {});
        this.retiring.set(current, done);
      }, { once: true });
    }
    return channel;
  }
  private closeAlternatives(channel: ProtocolChannel) {
    for (const connection of this.routes.get(channel) ?? []) {
      if (connection !== channel.connection && connection.status === "open")
        void connection.close().catch(error => connection.abort(error));
    }
  }
  create(options: TransportOptions): TransportConnection {
    const channel = this.channel(options.peerId);
    const start = () => {
      if (channel.readyState !== "connecting" || this.opening.has(channel)) return;
      const pending = this.connect(channel).catch(error => {
        const active = channel.connection;
        const current = this.channels.get(channel.peer) === channel;
        const other = !!this.routes.get(channel)?.size || this.bridge.negotiating(channel.peer);
        const terminal = current && !other && channel.readyState === "connecting";
        runtimeLog(terminal ? "warn" : "debug", "connection", "拨号尝试结束", {
          peerId: channel.peer, raw: { layer: "libp2p", attemptId: channel.attemptId, error,
            activeConnectionId: active?.id ?? null, activeChannelState: channel.readyState,
            action: terminal ? "fail-round" : "release-attempt", transferImpact: "none" },
        });
        if (terminal) options.onError(error);
      }).finally(() => this.opening.delete(channel));
      this.opening.set(channel, pending);
    };
    return {
      channel, start,
      signal: async () => {},
      close: (retirePeer = false) => {
        if (this.channels.get(channel.peer) === channel) {
          this.warmupQueue.delete(channel.peer);
          this.warmupRetries.delete(channel.peer);
          this.webTransportDials.get(channel.peer)?.controller.abort();
        }
        if (retirePeer && this.channels.get(channel.peer) === channel) this.bridge.closePeer(channel.peer);
        channel.close();
        return Promise.allSettled([this.retiring.get(channel), this.opening.get(channel)]).then(() => {});
      },
    };
  }
  private async connect(channel: ProtocolChannel) {
    await this.start();
    channel.lifetime.signal.throwIfAborted();
    if (channel.readyState === "open" || this.routes.get(channel)?.size) return;
    const peer = channel.peer;
    const signal = AbortSignal.any([channel.lifetime.signal, AbortSignal.timeout(25000)]);
    let connection: Connection | undefined;
    if (this.bridge.expectsWebTransport(peer)) {
      if (!this.bridge.webTransportAddresses(peer).length) {
        // Discovery and the desktop's first listener announcement travel separately.
        await pEvent(this.bridge.addressUpdates, peer, {
          filter: () => this.bridge.webTransportAddresses(peer).length > 0,
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.bridge.addresses(peer).length ? 600 : 4500)]),
        }).catch(() => {});
      }
      signal.throwIfAborted();
      const candidates = this.bridge.webTransportAddresses(peer);
      if (candidates.length) {
        try {
          connection = await this.dialWebTransport(peer);
        } catch (error) {
          signal.throwIfAborted();
          runtimeLog("debug", "connection", "直连尝试结束", {peerId: peer, raw: {transport: "webtransport", error}});
        }
      }
    }
    if (!connection) {
      signal.throwIfAborted();
      if (this.routes.get(channel)?.size) return;
      const addresses = this.bridge.addresses(peer);
      if (!addresses.length) throw new Error("暂时无法联系这台设备");
      connection = await this.node!.dial(addresses, {signal});
    }
    if (this.owners.get(connection) === channel) await this.openStreams(connection, channel);
  }
  private async openStreams(connection: Connection, channel: ProtocolChannel) {
    const peer = channel.peer;
    const identity = await this.bridge.identity;
    if (identity.id > peer || channel.connection || channel.readyState !== "connecting" ||
        this.owners.get(connection) !== channel || connection.status !== "open") return;
    channel.connection = connection;
    channel.causeEventId = undefined;
    try {
      for (const protocol of [CHAT_PROTOCOL, FILE_PROTOCOL]) {
        const signal = AbortSignal.any([channel.lifetime.signal, AbortSignal.timeout(8000)]);
        const stream = await connection.newStream(protocol, {signal});
        channel.attach(protocol, stream, connection);
      }
      if (channel.streams.size === 2) this.closeAlternatives(channel);
    } catch (error) {
      runtimeLog("warn", "connection", "协议流建立失败", { peerId: peer,
        raw: { attemptId: channel.attemptId, connectionId: connection.id, activeConnectionId: channel.connectionId,
          action: "release-candidate", error } });
      channel.release(connection);
      this.routes.get(channel)?.delete(connection);
      connection.abort(error instanceof Error ? error : new Error(String(error)));
      const next = this.routes.get(channel)?.values().next().value;
      if (next) await this.openStreams(next, channel);
    }
  }
  private cached(peer: string) {
    return this.profiles.get(peer) ?? this.cachedProfile?.(peer);
  }
  private receive(value: unknown, peer: string, minimum: number, exact = false) {
    const profile = fullProfile(value);
    if (!profile || profile.id !== peer || profile.revision! < minimum || (exact && profile.revision !== minimum)) return false;
    if ((this.cached(peer)?.revision ?? 0) < profile.revision!) {
      this.profiles.set(peer, profile);
      this.onProfile?.(profile);
    }
    return true;
  }
  private async request(connection: Connection, packet: {type: string; requestId: string; knownPeerRevision: number; selfRevision?: number}, signal: AbortSignal) {
    const stream = await connection.newStream(PING_PROTOCOL, {signal});
    try {
      const io = exchangeStream(stream, signal);
      await io.write(packet);
      const response = await io.read();
      if (response?.requestId !== packet.requestId || connection.status !== "open") throw new Error("设备响应无效");
      await stream.close({signal});
      return response;
    } catch (error) { stream.abort(error as Error); throw error; }
  }
  private async fetchProfile(connection: Connection, minimum: number) {
    const peer = connection.remotePeer.toString();
    const response = await this.request(connection, {type: "profile_get", requestId: crypto.randomUUID(),
      knownPeerRevision: this.cached(peer)?.revision ?? 0}, AbortSignal.timeout(8000));
    if (response.type === "profile_result") this.receive(response.profile, peer, minimum);
  }
  private async respond(stream: Stream, connection: Connection) {
    const peer = connection.remotePeer.toString();
    const channel = this.channels.get(peer);
    const signal = AbortSignal.timeout(8000);
    try {
      const io = exchangeStream(stream, signal);
      const packet = await io.read();
      const local = this.latest;
      if (!local?.revision || !packet || typeof packet.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(packet.requestId) ||
          !revision(packet.knownPeerRevision, 0)) throw new Error("Invalid request");
      const requestId = packet.requestId;
      if (packet.type === "profile_get") {
        await io.write({type: "profile_result", requestId, profile: publicProfile(local)});
      } else if (packet.type === "ping" && revision(packet.selfRevision)) {
        await io.write({type: "pong", requestId, selfRevision: local.revision,
          ...(packet.knownPeerRevision < local.revision ? {profile: publicProfile(local)} : {})});
        if (channel?.connection === connection && channel.readyState === "open" && connection.status === "open") channel.onpinganswered?.(Date.now(), requestId);
        if ((this.cached(peer)?.revision ?? 0) < packet.selfRevision)
          void this.fetchProfile(connection, packet.selfRevision).catch(() => {});
      } else throw new Error("Invalid request");
      await stream.close({signal});
    } catch (error) { stream.abort(error as Error); }
  }
  private async probe(peer: string, signal: AbortSignal, requestId = newId()) {
    const connection = this.channels.get(peer)?.connection;
    if (!connection || !this.latest?.revision) throw new Error("设备连接已断开");
    const start = performance.now();
    const knownPeerRevision = this.cached(peer)?.revision ?? 0;
    const response = await this.request(connection, {type: "ping", requestId,
      selfRevision: this.latest.revision, knownPeerRevision}, signal);
    if (response.type !== "pong" || !revision(response.selfRevision)) throw new Error("设备响应无效");
    if (response.selfRevision > knownPeerRevision && !this.receive(response.profile, peer, response.selfRevision, true))
      void this.fetchProfile(connection, response.selfRevision).catch(() => {});
    return {roundTripMs: performance.now() - start, ageMs: 0};
  }
  publish(profile: Profile) {
    this.latest = this.bridge.local = profile;
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.warmupQueue.clear();
      this.warmupRetries.clear();
      for (const dial of this.webTransportDials.values()) dial.controller.abort();
      await this.starting?.catch(() => {});
      this.bridge.close();
      for (const channel of this.channels.values()) channel.close();
      await this.node?.stop();
      this.node = undefined;
      this.starting = undefined;
    })().finally(() => (this.stopping = undefined));
    return this.stopping;
  }
}
