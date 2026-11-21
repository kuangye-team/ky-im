import { binaryPayload } from "../../../native-ipc";
import { discoveryView, fullProfile, publicProfile } from "../../profile-wire";
import { runtimeLog } from "../../../runtime-logs";
import type { ByteConnection } from "./bytes";
import { NativeSocket } from "./socket";
import { ByteBatchWriter, CumulativeAcks } from "./batch";
import { measuredBridge } from "./metrics";
import { Channel, invoke } from "@tauri-apps/api/core";
import { privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { multiaddr } from "@multiformats/multiaddr";
import type { MultiaddrConnection } from "@libp2p/interface";
import type { Profile } from "../../types";
import type {
  DiscoverySession,
  TransportAdapter,
  TransportChannel,
  TransportOptions,
} from "../types";
import type { NetworkSettings } from "../settings";
import { CentralBridge, type RtcSignal } from "./bridge";
import { targetPeer } from "./transports";
import { webTransportBudgetMs } from "./webtransport";
import { CHAT_PROTOCOL, FILE_PROTOCOL, MAX_FRAME } from "./channel";
import { priorityControl, transferId } from "../sendQueue";
import { CONNECTION_CONFIG, SIGNALING_CONFIG } from "../../../config";
import { newId, isProfile } from "../../protocol";
import { CAP, localRuntime } from "../../capabilities";
import { drain } from "./flow";

const isRtcUuid = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
function rtcSession(address: string) {
  const id = address.split("/")[2]?.split(".")[0];
  return id && isRtcUuid(id) ? id : undefined;
}

type NativeEvent = import("../../transfers/types").FileProgress & {
  type: string;
  rtcSessionId?: string;
  operation?: string;
  socketId?: string;
  state?: string;
  connectionId?: string;
  physicalConnectionId?: string;
  diagnostic?: Record<string, unknown>;
  requestId?: string;
  attemptId?: string;
  sequence?: number;
  peerId?: string;
  profile?: Profile;
  source?: string;
  joined?: boolean;
  receivedAt?: number;
  token?: string;
  data?: Uint8Array<ArrayBuffer>;
  kind?: number;
  address?: string;
  addresses?: string[];
};
export function decodeNativeEvent(value: NativeEvent | ArrayBuffer): NativeEvent {
  if (!(value instanceof ArrayBuffer)) return value;
  if (value.byteLength < 4) throw new Error("Invalid network event");
  const length = new DataView(value).getUint32(0);
  if (!length || length > 4096 || 4 + length >= value.byteLength)
    throw new Error("Invalid network event");
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(value, 4, length)),
  );
  return { ...header, data: new Uint8Array(value, 4 + length) };
}
export interface P2pBridge {
  nativeIO?: boolean;
  request<T>(
    sessionId: string,
    request: Record<string, unknown>,
    onEvent?: (event: NativeEvent) => void,
  ): Promise<T>;
  write(
    sessionId: string,
    data: ArrayBuffer,
    headers: Record<string, string>,
  ): Promise<void>;
}
export const nativeBridge: P2pBridge = {
  nativeIO: true,
  request: (sessionId, request, handler) => {
    const onEvent = new Channel<NativeEvent | ArrayBuffer>();
    onEvent.onmessage = (value) => handler?.(decodeNativeEvent(value));
    return invoke("p2p_request", { sessionId, request, onEvent });
  },
  write: (sessionId, data, headers) =>
    invoke("p2p_write", binaryPayload(data), {
      headers: { "x-session-id": sessionId, ...headers },
    }),
};
export class NativePeerNode implements TransportAdapter {
  readonly name = "libp2p";
  onIncoming?: TransportAdapter["onIncoming"];
  onProfile?: (profile: Profile) => void;
  private sessionId = newId();
  private started = false;
  nativeFiles = false;
  nativeNetwork = false;
  readonly sockets = new Map<string, NativeSocket>();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private local?: Profile;
  private channels = new Map<string, NativeChannel>();
  private bindings = new WeakMap<NativeChannel, { channel: NativeChannel; options: TransportOptions }>();
  private pipes = new Map<string, MultiaddrConnection>();
  private pipeReady = new Set<string>();
  private pipeWrites = new Map<string, Promise<void>>();
  private pipeAcks = this.createPipeAcks();
  private createPipeAcks() {
    return new CumulativeAcks((token, sequence) => {
      void this.call({ op: "pipe_consumed", token, sequence }).catch(error => this.pipes.get(token)?.abort(error));
    });
  }
  private announceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reverseDialUntil = new Map<string, number>();
  private addresses: string[] = [];
  readonly diagnosticRoutes: Record<string, string> = {};
  readonly connections = new Map<string, Map<string, string>>();
  cachedProfile?: (id: string) => Profile | undefined;
  private mdnsPeers = new Map<string, Profile>();
  private remoteAddresses = new Map<string, string[]>();
  private mdns?: DiscoverySession;
  private early: unknown[] = [];
  constructor(
    readonly central: CentralBridge,
    readonly settings: NetworkSettings,
    readonly bridge: P2pBridge = nativeBridge,
  ) {
    this.bridge = measuredBridge(bridge);
    central.admitInbound = peer => this.onIncoming?.(peer) !== false;
    central.beforeJoin = () => this.start();
    central.cachedProfile = id => this.cachedProfile?.(id);
    central.onProfile = (profile, source) => {
      this.scheduleAnnouncement(profile.id);
      void this.start().then(() => this.register(profile, source)).catch(() => {});
    };
    central.onRemove = (peer, source) => {
      this.reverseDialUntil.delete(peer);
      this.remoteAddresses.delete(`${source}:${peer}`);
      clearTimeout(this.announceTimers.get(peer));
      this.announceTimers.delete(peer);
      if (central.visible(peer)) this.scheduleAnnouncement(peer);
      void this.call({ op: "forget", peerId: peer, source }).catch(() => {});
    };
    central.onAddresses = (peer, addresses, source) => {
      this.remoteAddresses.set(`${source}:${peer}`, addresses);
      const profile = central.sources.get(source)?.peers.get(peer);
      if (profile) void this.register(profile, source).then(() => {
        // Address announcements also wake the elected dialer for desktop RTC.
        if (this.local && this.local.id < peer && this.local.capabilities.includes(CAP.webrtc) &&
            profile.capabilities.includes(CAP.webrtc) && profile.capabilities.includes(CAP.app) &&
            this.onIncoming?.(peer) !== false) {
          const channel = this.channel(peer);
          if (channel.readyState === "connecting")
            return this.call({op: "connect", peerId: peer, attemptId: channel.attemptId});
        }
      }).catch(() => {});
    };
    for (const kind of ["relay", "rtc"] as const)
      central.incoming[kind] = (raw) => {
        void this.acceptPipe(raw).catch((error) => raw.abort(error));
      };
  }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.started) return;
    return (this.starting ??= (async () => {
      if (!this.local) throw new Error("个人资料尚未准备好");
      const identity = await this.central.identity;
      const profile = this.local;
      const sessionId = this.sessionId;
      const capabilities = await this.bridge.request<{ nativeFiles?: boolean; nativeNetwork?: boolean } | null>(
        this.sessionId,
        {
          op: "start",
          nativeIO: this.bridge.nativeIO === true,
          key: [...privateKeyToProtobuf(identity.key)],
          profile: publicProfile(profile),
          macosSendActivity: import.meta.env.VITE_MACOS_SEND_ACTIVITY?.trim().toLowerCase() !== "false",
          windowsSendActivity: import.meta.env.VITE_WINDOWS_SEND_ACTIVITY?.trim().toLowerCase() !== "false",
          room: SIGNALING_CONFIG.room,
          mdns: this.settings.discovery.mdns,
          tcp: profile.capabilities.includes(CAP.tcp),
          announceLoopback: import.meta.env.VITE_P2P_ANNOUNCE_LOOPBACK?.trim().toLowerCase() === "true",
        },
        (event) => { if (this.sessionId === sessionId) return this.event(event); },
      );
      this.nativeFiles = capabilities?.nativeFiles === true;
      this.nativeNetwork = capabilities?.nativeNetwork === true;
      this.central.supportsBulk = this.nativeFiles;
      this.started = true;
      if (this.local !== profile) await this.publish(this.local);
    })().catch((error) => {
      this.starting = undefined;
      throw error;
    }));
  }
  call<T = unknown>(request: Record<string, unknown>) {
    return this.bridge.request<T>(this.sessionId, request).catch(error => { throw error instanceof Error ? error : new Error(String(error)); });
  }
  private register(profile: Profile, source: string) {
    return this.call({
      op: "register",
      profile,
      cachedProfile: this.cachedProfile?.(profile.id)?.revision ? publicProfile(this.cachedProfile!(profile.id)!) : undefined,
      source,
      addresses: [
        ...this.central.addresses(profile.id, source).map((a) => a.toString()),
        ...(this.remoteAddresses.get(`${source}:${profile.id}`) ?? []),
      ],
    });
  }
  private scheduleAnnouncement(peer: string) {
    if (this.stopping) return;
    clearTimeout(this.announceTimers.get(peer));
    this.announceTimers.set(peer, setTimeout(() => {
      this.announceTimers.delete(peer);
      const sent = this.central.sendAddresses(peer, this.addresses);
      if (sent === "background" && !this.connections.get(peer)?.size)
        this.reverseDialUntil.set(peer, Date.now() + webTransportBudgetMs);
      else if (sent) this.reverseDialUntil.delete(peer);
    }, 100));
  }
  private async event(event: NativeEvent) {
    try {
      if (event.type === "peer") event.profile = discoveryView(event.profile);
      if (event.type === "profile") event.profile = fullProfile(event.profile);
      if (event.type === "diagnostic") {
        const info = event.diagnostic;
        const channel = this.channels.get(event.peerId!);
        const failed = !!(info?.error || (info?.result as {error?: unknown} | undefined)?.error);
        const eventId = runtimeLog(failed ? "warn" : "debug", "connection", "原生连接事件", {peerId: event.peerId,
          raw: { ...info, channelId: channel?.connectionId, activeConnectionId: channel?.physicalConnectionId ?? info?.activeConnectionId ?? null }});
        if (failed && channel?.physicalConnectionId && channel.physicalConnectionId === info?.connectionId)
          channel.causeEventId ??= eventId;
      } else if (event.type === "socket") {
        if (import.meta.env.VITE_ANDROID && ["open", "close", "error"].includes(event.state || "")) {
          runtimeLog(event.state === "error" ? "warn" : "debug", "discovery", "在线查找连接变化", {
            raw: { socketId: event.socketId, state: event.state, detail: (event as { detail?: string }).detail },
          });
        }
        this.sockets.get(event.socketId!)?.event(event.state!, event.message);
      } else if (event.type === "file_progress" || event.type === "file_error") {
        const channel = this.channels.get(event.peerId!);
        if (channel) channel.onfileprogress?.(event);
      } else if (event.type === "rtc_request") {
        await this.rtcRequest(event);
      } else if (event.type === "pipe_dial") {
        const address = multiaddr(event.address!);
        const isRtc = address.toString().includes("/webrtc");
        if (this.nativeNetwork && !isRtc) {
          await this.call({ op: "relay_dial", token: event.token, address: event.address });
          return;
        }
        const signal = AbortSignal.timeout(25000);
        const peer = targetPeer(address);
        const session = isRtc ? rtcSession(event.address!) : undefined;
        try {
          const raw = session && event.address!.includes("rtc-stream.hummingbird.invalid/")
            ? await this.central.dialStream(peer, session, signal, offer => this.call<RtcSignal>({ op: "rtc_exchange", peerId: peer, offer }))
            : await this.central.dial(isRtc ? "rtc" : "relay", address, signal, session);
          this.bindPipe(event.token!, raw);
          await this.call({ op: "pipe_ready", token: event.token });
        } catch (error) {
          await this.call({ op: "pipe_close", token: event.token }).catch(() => {});
          throw error;
        }
      } else if (event.type === "pipe_incoming_ready")
        this.pipeReady.add(event.token!);
      else if (event.type === "pipe_data") {
        const token = event.token!;
        const pending = (this.pipeWrites.get(token) ?? Promise.resolve()).then(
          async () => {
            const raw = this.pipes.get(token);
            if (!raw) return;
            if (!raw.send(event.data!)) await drain(raw, 15000);
            if (this.pipes.get(token) !== raw) return;
            this.pipeAcks.consume(token, event.sequence!);
          },
        );
        this.pipeWrites.set(token, pending);
        try {
          await pending;
        } finally {
          if (this.pipeWrites.get(token) === pending) this.pipeWrites.delete(token);
        }
      } else if (event.type === "pipe_close") {
        this.pipeAcks.forget(event.token!);
        this.pipes.get(event.token!)?.abort(new Error("Connection closed"));
        this.pipes.delete(event.token!);
      } else if (event.type === "request_connect") {
        // A desktop RTC dialer can be asleep even if it already has our addresses.
        this.central.sendAddresses(event.peerId!, this.addresses, "desktop-rtc");
      } else if (event.type === "connected") {
        this.reverseDialUntil.delete(event.peerId!);
        if (this.onIncoming?.(event.peerId!) === false) {
          await this.call({op: "close_route", peerId: event.peerId, physicalConnectionId: event.connectionId});
          return;
        }
        const channel = this.channel(event.peerId!);
        if (channel.readyState === "connecting") channel.physicalConnectionId ??= event.connectionId;
        const paths = this.connections.get(event.peerId!) ?? new Map();
        paths.set(event.connectionId!, event.address!);
        this.connections.set(event.peerId!, paths);
        this.diagnosticRoutes[event.peerId!] = event.address!;
      } else if (event.type === "connection_closed") {
        const paths = this.connections.get(event.peerId!);
        paths?.delete(event.connectionId!);
        if (paths?.size) this.diagnosticRoutes[event.peerId!] = [...paths.values()].at(-1)!;
        else { this.connections.delete(event.peerId!); delete this.diagnosticRoutes[event.peerId!]; }
      } else if (event.type === "network_changed") {
        this.deliver({ type: "network_changed" });
      } else if (event.type === "addresses") {
        this.addresses = event.addresses!;
        for (const source of this.central.sources.values())
          for (const peer of source.peers.keys()) this.scheduleAnnouncement(peer);
      } else if (
        event.type === "peer" &&
        event.profile &&
        isProfile(event.profile)
      ) {
        const cached = this.cachedProfile?.(event.profile.id);
        if (cached?.revision) void this.call({op: "cache_profile", profile: publicProfile(cached)}).catch(() => {});
        const type = event.joined || !this.mdnsPeers.has(event.profile.id) ? "peer_joined" : "peer_updated";
        this.mdnsPeers.set(event.profile.id, event.profile);
        this.deliver({ type, peer: event.profile });
      } else if (event.type === "left") {
        this.mdnsPeers.delete(event.peerId!);
        this.deliver({ type: "peer_left", id: event.peerId });
      } else if (
        event.type === "profile" &&
        event.profile &&
        isProfile(event.profile)
      )
        this.onProfile?.(event.profile);
      else if (event.type === "open") {
        const current = this.channels.get(event.peerId!);
        if (event.physicalConnectionId && !this.connections.get(event.peerId!)?.has(event.physicalConnectionId)) return;
        if (current?.readyState === "open" && current.connectionId !== event.connectionId) {
          const binding = this.bindings.get(current);
          if (binding) {
            const next = new NativeChannel(event.peerId!, this);
            this.channels.set(next.peer, next);
            binding.channel = next;
            this.bindings.set(next, binding);
            binding.options.onChannel(next, true);
          } else current.finish();
        }
        if (this.onIncoming?.(event.peerId!) === false) {
          if (event.physicalConnectionId) await this.call({op: "close_route", peerId: event.peerId, physicalConnectionId: event.physicalConnectionId});
          return;
        }
        this.channel(event.peerId!).open(event.connectionId, event.physicalConnectionId);
      } else if (event.type === "ping_answered") {
        const channel = this.channels.get(event.peerId!);
        if (channel?.readyState === "open" && channel.connectionId === event.connectionId && typeof event.receivedAt === "number")
          channel.onpinganswered?.(event.receivedAt, event.requestId);
      } else if (event.type === "closed") {
        const channel = this.channels.get(event.peerId!);
        if (!channel) return;
        if (!event.connectionId && !event.attemptId && !channel.physicalConnectionId && channel.readyState === "open") {
          void this.ping(channel.peer).catch(() => {
            if (this.channels.get(channel.peer) === channel && !this.connections.get(channel.peer)?.size) channel.finish();
          });
          return;
        }
        if (event.connectionId ? channel.connectionId === event.connectionId :
            channel.readyState === "connecting" && event.attemptId === channel.attemptId && !this.connections.get(event.peerId!)?.size)
          channel.finish();
      } else if (event.type === "data")
        this.channels.get(event.peerId!)?.receive(event);
    } catch {
      if (event.token)
        void this.call({ op: "pipe_close", token: event.token }).catch(
          () => {},
        );
    }
  }
  async socketReady(cancelled: () => boolean) {
    const session = this.sessionId;
    const deadline = Date.now() + 5000;
    while (!this.local && !cancelled() && !this.stopping && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    if (cancelled() || this.stopping || this.sessionId !== session) return;
    await this.start();
  }
  socket(source: string, address: string, permitted: boolean): WebSocket {
    return new NativeSocket(this, source, address, permitted) as unknown as WebSocket;
  }
  private async rtcRequest(event: NativeEvent) {
    const session = this.sessionId;
    const reply = (error?: string) => this.bridge.request(session, { op: "rtc_reply", requestId: event.requestId, error });
    try {
      const peer = event.peerId!;
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      if (event.operation === "offer") {
        const offer: RtcSignal = JSON.parse(new TextDecoder().decode(event.data));
        const answer = await this.central.answerStream(peer, offer);
        bytes = new TextEncoder().encode(JSON.stringify(answer));
      } else {
        const rtc = this.central.rtc.get(event.rtcSessionId!);
        if (!rtc || rtc.peer !== peer) throw new Error("连接已关闭");
        const bulk = rtc.bulk;
        switch (event.operation) {
          case "chunk":
            bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setUint32(0, bulk.filePayloadBytes ?? 0);
            break;
          case "hello": if (bulk.enabled) bytes = await bulk.hello(); break;
          case "binding": bytes = await bulk.onBinding(event.data!); break;
          case "bound": bytes = Uint8Array.of(Number(await bulk.bound())); break;
          case "prepare": bulk.prepare(); break;
          case "send": bytes = await bulk.send(event.data!); break;
          case "receive": bytes = new Uint8Array(await bulk.receive(event.data!)); break;
          default: throw new Error("未知的连接请求");
        }
      }
      if (bytes?.length) {
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
        await this.bridge.write(session, buffer, { "x-rtc-reply": event.requestId! });
      } else await reply();
    } catch (error) { await reply(String(error)); }
  }
  private async acceptPipe(raw: ByteConnection) {
    await this.start();
    const session = this.central.sessionByTimeline.get(raw.timeline);
    const address = raw.remoteAddr.toString();
    const token = await this.call<string>({
      op: "pipe_accept",
      address: session && isRtcUuid(session) ? address.replace("/dns4/rtc.", `/dns4/${session}.rtc.`) : address,
    });
    const end = Date.now() + 8000;
    while (!this.pipeReady.delete(token)) {
      if (Date.now() > end) throw new Error("连接等待超时");
      await new Promise((r) => setTimeout(r, 5));
    }
    this.bindPipe(token, raw);
  }
  private bindPipe(token: string, raw: ByteConnection) {
    raw.managed = true;
    this.pipes.set(token, raw);
    const writer = new ByteBatchWriter(bytes => this.bridge.write(
      this.sessionId, bytes, { "x-pipe-token": token },
    ));
    // Consume message events directly: the generic async iterator has an unbounded queue.
    const receive = (event: { data: Uint8Array | import("uint8arraylist").Uint8ArrayList }) => writer.push(event.data);
    const close = (event: { error?: Error }) => event.error ? writer.abort(event.error) : writer.end();
    raw.addEventListener("close", close);
    raw.addEventListener("message", receive);
    if (raw.status !== "open") writer.abort(new Error("Connection closed"));
    void writer.done.catch(error => raw.abort(error)).finally(async () => {
      raw.removeEventListener("message", receive);
      raw.removeEventListener("close", close);
      this.pipeAcks.forget(token);
      this.pipes.delete(token);
      await this.call({ op: "pipe_close", token }).catch(() => {});
    });
  }

  private channel(peer: string) {
    let channel = this.channels.get(peer);
    if (!channel || channel.readyState === "closed") {
      channel = new NativeChannel(peer, this);
      this.channels.set(peer, channel);
    }
    return channel;
  }
  handleBackgroundDial(peer: string) { return !!this.central.reverseSource(peer, CAP.web); }
  create(options: TransportOptions) {
    const channel = this.channel(options.peerId);
    const binding = { channel, options };
    this.bindings.set(channel, binding);
    let started = false;
    return {
      channel,
      start: () => {
        if (started || channel.readyState !== "connecting") return;
        started = true;
        void this.start()
          .then(async () => {
            // A recent announcement already asked this browser to dial. Give that attempt its budget.
            const wait = (this.reverseDialUntil.get(options.peerId) ?? 0) - Date.now();
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
            if (channel.readyState !== "connecting" || this.channels.get(options.peerId) !== channel) return;
            if (channel.physicalConnectionId && this.connections.get(options.peerId)?.has(channel.physicalConnectionId)) return;
            if (this.central.sendAddresses(options.peerId, this.addresses, "connect")) return;
            return this.call({ op: "connect", peerId: options.peerId, attemptId: channel.attemptId });
          })
          .catch((error) => {
            if (this.channels.get(options.peerId) === channel && channel.readyState === "connecting") options.onError(error);
          });
      },
      signal: async () => {},
      close: (retirePeer?: boolean) => binding.channel.close(retirePeer),
    };
  }
  async publish(profile: Profile) {
    this.central.local = this.local = profile;
    if (this.started)
      await this.call({ op: "publish", profile: publicProfile(profile) }).catch(() => {});
  }
  ping(peer: string, requestId = newId()) {
    return this.call<import("../types").PeerHealth>({ op: "ping", peerId: peer, probeId: requestId });
  }
  send(peer: string, protocol: string, data: string | ArrayBuffer) {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data).buffer : data;
    return this.bridge.write(this.sessionId, bytes, {
      "x-peer-id": peer,
      "x-protocol": protocol,
      "x-frame-kind": typeof data === "string" ? "1" : "2",
    });
  }
  async fileSource(file: import("../../types").AttachmentSource, cancelled: () => boolean) {
    const source = await this.call<{ token: string }>({ op: file.nativeSource ? "file_source" : "file_upload", ...file.nativeSource });
    try {
      if (!file.nativeSource) {
        for (let offset = 0; offset < file.size; offset += 2 * 1024 * 1024) {
          if (cancelled()) throw new Error("文件传输已取消");
          const bytes = await file.slice(offset, Math.min(file.size, offset + 2 * 1024 * 1024)).arrayBuffer();
          if (bytes.byteLength !== Math.min(2 * 1024 * 1024, file.size - offset)) throw new Error("文件已发生变化，请重新选择");
          await this.bridge.write(this.sessionId, bytes, { "x-file-source": source.token });
        }
      }
      if (cancelled()) throw new Error("文件传输已取消");
      return source.token;
    } catch (error) {
      await this.call({ op: "file_source_release", token: source.token });
      throw error;
    }
  }
  consumed(token: string, sequence: number) {
    return this.call({ op: "consumed", token, sequence });
  }
  closePeer(channel: NativeChannel, retirePeer: boolean) {
    if (this.channels.get(channel.peer) !== channel) return Promise.resolve();
    return this.call({ op: "close", peerId: channel.peer, attemptId: channel.attemptId,
      physicalConnectionId: channel.physicalConnectionId, retirePeer }).then(() => {});
  }
  private deliver(packet: unknown) {
    if (this.mdns) this.mdns.onmessage?.({ data: JSON.stringify(packet) });
    else this.early.push(packet);
  }
  discovery(): DiscoverySession {
    let ready = 0;
    const session: DiscoverySession = {
      get readyState() {
        return ready;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (raw) => {
        const packet = JSON.parse(raw);
        if (packet.type === "join") {
          this.local ??= packet.profile;
          void this.start()
            .then(() => {
              session.onmessage?.({
                data: JSON.stringify({
                  type: "welcome",
                  ...localRuntime(true),
                  id: packet.profile.id,
                  room: packet.room,
                  numericId: packet.profile.numericId,
                  peers: [...this.mdnsPeers.values()],
                }),
              });
              this.mdns = session;
              for (const event of this.early) this.deliver(event);
              this.early = [];
            })
            .catch((error) =>
              session.onerror?.(
                Object.assign(new Event("error"), { message: String(error) }),
              ),
            );
        } else if (packet.type === "change_numeric_id") return;
        else if (packet.type === "ping")
          queueMicrotask(() =>
            session.onmessage?.({ data: '{"type":"pong"}' }),
          );
        else if (packet.type === "connect_group" || packet.type === "connect") {
          const peers = [...this.mdnsPeers.values()].filter(
            (p) => p.numericId === packet.numericId,
          );
          queueMicrotask(() =>
            session.onmessage?.({
              data: JSON.stringify(
                packet.type === "connect_group"
                  ? {
                      type: "group_resolved",
                      requestId: packet.requestId,
                      numericId: packet.numericId,
                      peers,
                    }
                  : {
                      type: "peer_resolved",
                      requestId: packet.requestId,
                      peer: peers.find((p) => p.id === packet.expectedPeerId),
                    },
              ),
            }),
          );
        }
      },
      close: () => {
        ready = 3;
        if (this.mdns === session) this.mdns = undefined;
        session.onclose?.(new Event("close"));
      },
    };
    queueMicrotask(() => {
      ready = 1;
      session.onopen?.(new Event("open"));
    });
    return session;
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      for (const channel of this.channels.values()) channel.finish();
      for (const timer of this.announceTimers.values()) clearTimeout(timer);
      this.announceTimers.clear();
      this.reverseDialUntil.clear();
      this.central.close();
      for (const socket of this.sockets.values()) socket.close();
      await this.call({ op: "stop" }).catch(() => {});
      this.started = false;
      this.starting = undefined;
      this.sessionId = newId();
      this.connections.clear();
      for (const peer of Object.keys(this.diagnosticRoutes)) delete this.diagnosticRoutes[peer];
      this.addresses = [];
      this.mdnsPeers.clear();
      this.remoteAddresses.clear();
      this.pipeReady.clear();
      this.pipeAcks.close();
      this.pipeAcks = this.createPipeAcks();
    })().finally(() => (this.stopping = undefined));
    return this.stopping;
  }
}
class NativeChannel extends EventTarget implements TransportChannel {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly separateControl = true;
  readonly maxMessageSize = MAX_FRAME;
  onopen: TransportChannel["onopen"] = null;
  onclose: TransportChannel["onclose"] = null;
  onerror: TransportChannel["onerror"] = null;
  onmessage: TransportChannel["onmessage"] = null;
  private queue: {
    data: string | ArrayBuffer;
    size: number;
    id?: string;
    protocol: string;
  }[] = [];
  private writing = new Set<string>();
  private acks = new CumulativeAcks((token, sequence) => {
    void this.node.consumed(token, sequence).catch(() => this.close());
  });
  constructor(
    readonly peer: string,
    private node: NativePeerNode,
  ) {
    super();
  }
  onpinganswered?: TransportChannel["onpinganswered"];
  probe(signal: AbortSignal, requestId?: string): Promise<import("../types").PeerHealth> {
    signal.throwIfAborted();
    if (this.readyState !== "open") return Promise.reject(new Error("设备连接已断开"));
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      this.node.ping(this.peer, requestId).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }
  private cancelledFiles = new Set<string>();
  onfileprogress?: TransportChannel["onfileprogress"];
  get fileTasks(): import("../../transfers/types").FileTaskExecutor | undefined {
    if (!this.node.nativeFiles) return undefined;
    const call = <T>(op: string, id: string, args = {}): Promise<T> => this.node.call({ op, id, peerId: this.peer, ...args });
    return {
      sender: async (id, file, token) => {
        const source = await this.node.fileSource(file, () => this.cancelledFiles.has(id));
        try { await call("file_sender", id, { source, token, size: file.size }); }
        finally { await this.node.call({ op: "file_source_release", token: source }); }
      },
      receive: (id, token, size) => call("file_receive", id, { token, size, connectionId: this.connectionId }),
      retarget: (id, token) => call("file_retarget", id, { token }),
      state: (id, resume) => call("file_state", id, resume ? { connectionId: this.connectionId } : {}),
      send: (id, offset, sequence, base = 0, singleFile = false) => call("file_send", id, { offset, sequence, base, singleFile }),
      cancel: id => { this.cancelledFiles.add(id); void call("file_cancel", id).catch(() => {}); },
      release: id => call("file_release", id),
    };
  }
  connectionId?: string;
  causeEventId?: string;
  readonly attemptId = newId();
  physicalConnectionId?: string;
  open(id?: string, physical?: string) {
    if (this.readyState !== "connecting") return;
    this.connectionId = id;
    this.physicalConnectionId = physical;
    const address = physical && this.node.connections.get(this.peer)?.get(physical);
    const session = address && rtcSession(address);
    if (session) {
      const rtc = this.node.central.rtc.get(session);
      if (rtc?.peer === this.peer) this.rtcSample = rtc.sample;
    }
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }
  rtcSample?: TransportChannel["rtcSample"];
  receive(event: NativeEvent) {
    if (
      this.readyState !== "open" ||
      event.connectionId !== this.connectionId
    ) {
      void this.node.consumed(event.token!, event.sequence!).catch(() => {});
      return;
    }
    let done = false;
    const consumed = () => {
      if (!done) {
        done = true;
        this.acks.consume(event.token!, event.sequence!);
      }
    };
    if (this.onmessage)
      this.onmessage({
        data:
          event.kind === 1
            ? new TextDecoder().decode(event.data!)
            : event.data!.slice().buffer,
        consumed,
      });
    else consumed();
  }
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("设备连接已断开");
    const size =
      typeof data === "string"
        ? new TextEncoder().encode(data).length
        : data.byteLength;
    if (!size || size > MAX_FRAME || (this.bufferedAmount + size > 1024 * 1024 && this.bufferedAmount > CONNECTION_CONFIG.sendBufferHighBytes))
      throw new Error("传输繁忙，请稍后重试");
    const protocol = priorityControl(data) ? CHAT_PROTOCOL : FILE_PROTOCOL;
    this.bufferedAmount += size;
    this.queue.push({ data, size, id: transferId(data), protocol });
    void this.flush(protocol);
  }
  private async flush(protocol: string) {
    if (this.writing.has(protocol)) return;
    this.writing.add(protocol);
    try {
      while (this.readyState === "open") {
        const index = this.queue.findIndex((i) => i.protocol === protocol);
        if (index < 0) break;
        const item = this.queue.splice(index, 1)[0];
        await this.node.send(this.peer, protocol, item.data);
        this.bufferedAmount = Math.max(0, this.bufferedAmount - item.size);
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold)
          this.dispatchEvent(new Event("bufferedamountlow"));
      }
    } catch {
      this.close();
    } finally {
      this.writing.delete(protocol);
    }
  }
  cancelTransfer(id: string) {
    this.fileTasks?.cancel(id);
    this.queue = this.queue.filter((item) => {
      if (item.id !== id) return true;
      this.bufferedAmount -= item.size;
      return false;
    });
  }
  finish() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.acks.close();
    this.queue = [];
    this.bufferedAmount = 0;
    this.onclose?.(new Event("close"));
    this.dispatchEvent(new Event("close"));
  }
  private closing?: Promise<void>;
  close(retirePeer = false) {
    this.closing ??= this.node.closePeer(this, retirePeer).catch(() => {});
    this.finish();
    return this.closing;
  }
}
