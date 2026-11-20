import { runtimeLog } from "../../../runtime-logs";
import { pEvent } from "p-event";
import { transferMetrics as metrics } from "../../transferMetrics";
import { publicKeyToProtobuf } from "@libp2p/crypto/keys";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import type { DiscoverySession } from "../types";
import type { Profile } from "../../types";
import type { DeviceIdentity } from "./identity";
import { CAP, canDialWebTransport } from "../../capabilities";
import { pinnedAddresses } from "./webtransport";
import { ByteConnection } from "./bytes";
import {
  relayAddress,
  RTC_ADDRESS,
  targetPeer,
  type TransportBridge,
} from "./transports";
import { newId } from "../../protocol";

import { discoverySummary, discoveryView } from "../../profile-wire";
import { rtcSliceSize, rtcHighWater, rtcLowWater, waitForRtcBuffer } from "./rtc-limits";
import { BulkDataChannel, BULK_LABEL, bulkAttribute } from "./rtc-bulk";
import { RtcWriter } from "./rtc-writer";
import { cachedRtcStats, rtcCounters } from "./rtc-stats";

function localDescription(pc: RTCPeerConnection, bulk: boolean) {
  const description = pc.localDescription!;
  const sdp = bulk ? description.sdp.trimEnd() + "\r\n" + bulkAttribute + "\r\n" : description.sdp;
  return { type: description.type, sdp };
}
const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
type Packet = { kind: "open" | "accept" | "close" | "credit"; count?: number };
type Source = {
  webTransport: Map<string, Multiaddr[]>;
  announcedAddresses: Map<string, string>;
  id: string;
  socket: WebSocket;
  permitted: boolean;
  reverseDial: boolean;
  peers: Map<string, Profile & { relay?: boolean }>;
};
type Tunnel = {
  raw: ByteConnection;
  source: Source;
  peer: string;
  id: string;
  credit: number;
  sent: number;
  received: number;
  release: number;
  timer: ReturnType<typeof setInterval>;
  accept?: () => void;
};
export type RtcSignal = { session: string; description: RTCSessionDescriptionInit };
type DialIntent = "background" | "connect";
type RtcExchange = (offer: RtcSignal, signal: AbortSignal) => Promise<RtcSignal>;
type RtcSource = Pick<Source, "id">;
type Rtc = {
  pc: RTCPeerConnection;
  bulk: BulkDataChannel;
  sample?: () => Record<string, unknown>;
  id: string;
  inbound: boolean;
  started: number;
  lifetime: AbortController;
  candidates: Record<string, number>;
  sent?: string;
  received?: string;
  close(error?: Error): void;
  source: RtcSource;
  peer: string;
  raw?: ByteConnection;
  accept?: (raw: ByteConnection) => void;
  reject?: (error: Error) => void;
};

// RTC offers and relay opens can arrive before libp2p sees a byte stream.
function handshakeLimitReached(routes: Iterable<{raw?: ByteConnection}>) {
  let pending = 0;
  for (const route of routes) {
    if (!route.raw?.managed && ++pending >= 16) return true;
  }
  return false;
}

export class CentralBridge implements TransportBridge {
  incoming: TransportBridge["incoming"] = {};
  sources = new Map<string, Source>();
  tunnels = new Map<string, Tunnel>();
  rtc = new Map<string, Rtc>();
  readonly connectionByTimeline = new WeakMap<object, string>();
  activeConnection?: (peer: string) => string | undefined;
  readonly sessionByTimeline = new WeakMap<object, string>();
  onProfile?: (peer: Profile, source: string) => void;
  onRemove?: (peer: string, source: string) => void;
  readonly addressUpdates = new EventTarget();
  onAddresses?: (peer: string, addresses: string[], source: string) => void;
  admitInbound?: (peer: string) => boolean;
  onReverseDial?: (peer: string, intent: DialIntent) => void;
  webTransportExchange?: (peer: string) => RtcExchange | undefined;
  reverseSource(peer: string, role: typeof CAP.web | typeof CAP.app) {
    return [...this.sources.values()].find(source => {
      const caps = source.peers.get(peer)?.capabilities;
      return source.socket.readyState === 1 && source.reverseDial && caps?.includes(role) && caps.includes(CAP.reverseDial);
    });
  }
  sendAddresses(peer: string, localAddresses: string[], reason: "announce" | "desktop-rtc" | "connect" = "announce") {
    const reverse = this.reverseSource(peer, CAP.web);
    const source = reverse ?? [...this.sources.values()].find(s => s.peers.has(peer) && s.socket.readyState === 1);
    if (!source || (reason === "connect" && !reverse)) return false;
    const caps = source.peers.get(peer)!.capabilities;
    const browser = caps.includes(CAP.web);
    if (browser && (reason === "desktop-rtc" || (reason === "announce" && !caps.includes(CAP.webtransport)))) return false;
    const addresses = browser && !caps.includes(CAP.webtransport) ? [] :
      localAddresses.filter(a => a.includes("/webtransport/") === browser);
    const previous = source.announcedAddresses.get(peer);
    if (browser && !addresses.length && previous === undefined && reason === "announce") return false;
    // Compare sets but preserve the listener's candidate order on the wire.
    const signature = JSON.stringify([...addresses].sort());
    if (reason === "announce" && signature === previous) return false;
    const dial = reason === "connect" ? "connect" : reverse && addresses.length ? "background" : undefined;
    source.socket.send(JSON.stringify({ type: "signal", to: peer, data: { addresses, dial } }));
    source.announcedAddresses.set(peer, signature);
    return dial ?? "addresses";
  }
  supportsBulk = false;
  private readonly streamSource = { id: "authenticated-stream" };
  local?: Profile;
  cachedProfile?: (id: string) => Profile | undefined;
  beforeJoin: () => Promise<void> = async () => {};
  constructor(
    readonly identity: Promise<DeviceIdentity>,
    readonly iceServers: RTCIceServer[],
    readonly rtcEnabled: boolean,
  ) {}
  visible(peer: string) {
    return [...this.sources.values()].some((s) => s.peers.has(peer));
  }
  closePeer(peer: string) {
    for (const rtc of this.rtc.values()) if (rtc.peer === peer) rtc.close();
    for (const [key, tunnel] of this.tunnels) if (tunnel.peer === peer) this.closeTunnel(key, true);
  }
  negotiating(peer: string) {
    return [...this.rtc.values()].some(rtc => rtc.peer === peer && !rtc.lifetime.signal.aborted) ||
      [...this.tunnels.values()].some(tunnel => tunnel.peer === peer && tunnel.raw.status === "open");
  }
  private rtcLog(rtc: Rtc, stage: string, fields: Record<string, unknown> = {}) {
    const pc = rtc.pc;
    const connectionId = rtc.raw && this.connectionByTimeline.get(rtc.raw.timeline);
    return runtimeLog(fields.error ? "warn" : "debug", "connection", "RTC 连接状态", {
      peerId: rtc.peer, raw: { layer: "rtc", stage, rtcSessionId: rtc.id, attemptId: rtc.id,
        direction: rtc.inbound ? "inbound" : "outbound", transport: "webrtc", sourceId: rtc.source.id,
        connectionId: connectionId ?? null, connectionIdStatus: connectionId ? "assigned" : "not-yet-assigned",
        activeConnectionId: this.activeConnection?.(rtc.peer) ?? null, elapsedMs: Math.round(performance.now() - rtc.started),
        signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState,
        iceConnectionState: pc.iceConnectionState, connectionState: pc.connectionState,
        candidates: { ...rtc.candidates }, sent: rtc.sent ?? null, received: rtc.received ?? null, ...fields },
    });
  }
  addresses(peer: string, onlySource?: string): Multiaddr[] {
    const sources = [...this.sources.values()].filter((s) => s.peers.has(peer) && (!onlySource || s.id === onlySource));
    return [
      ...(this.rtcEnabled && sources.some(s => s.peers.get(peer)?.capabilities.includes(CAP.webrtc))
        ? [multiaddr(`${RTC_ADDRESS}/p2p/${peer}`)]
        : []),
      ...sources
        .filter((s) => s.permitted && s.peers.get(peer)?.relay)
        .map((s) => multiaddr(`${relayAddress(s.id)}/p2p/${peer}`)),
    ];
  }
  webTransportAddresses(peer: string) {
    return [...this.sources.values()].flatMap(source => source.webTransport.get(peer) ?? []);
  }
  expectsWebTransport(peer: string) {
    return canDialWebTransport() && [...this.sources.values()].some(source =>
      source.peers.get(peer)?.capabilities.includes(CAP.app) && source.peers.get(peer)?.capabilities.includes(CAP.webtransport));
  }
  hook(id: string, permitted: boolean, extend?: Record<string, unknown>) {
    return {
      session: (socket: WebSocket): DiscoverySession =>
        this.session(socket, id, permitted, extend),
    };
  }
  private session(
    socket: WebSocket,
    id: string,
    permitted: boolean,
    extend?: Record<string, unknown>,
  ): DiscoverySession {
    socket.binaryType = "arraybuffer";
    const source: Source = { id, socket, permitted, reverseDial: false, peers: new Map(), webTransport: new Map(), announcedAddresses: new Map() };
    const previous = this.sources.get(id);
    if (previous) {
      for (const peer of previous.peers.keys()) this.onRemove?.(peer, id);
      previous.socket.close();
    }
    this.sources.set(id, source);
    let challenge = "";
    let closed = false;
    const session: DiscoverySession = {
      get readyState() {
        return socket.readyState;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (raw) => {
        const packet = JSON.parse(raw);
        if (packet.type === "join") {
          void (async () => {
            await this.beforeJoin();
            const identity = await this.identity;
            if (closed || !challenge.startsWith("hummingbird/v2/register:"))
              throw new Error("无法验证服务器连接，请重试");
            packet.profile = discoverySummary(this.local ?? packet.profile, source.permitted, extend);
            packet.profile.id = identity.id;
            packet.proof = {
              publicKey: base64(publicKeyToProtobuf(identity.key.publicKey)),
              signature: base64(
                await identity.key.sign(encoder.encode(challenge)),
              ),
            };
            if (!closed && this.sources.get(id) === source) socket.send(JSON.stringify(packet));
          })().catch((error) => {
            session.onerror?.(
              Object.assign(new Event("error"), { message: String(error) }),
            );
            socket.close();
          });
        } else {
          socket.send(JSON.stringify(packet));
        }
      },
      close: () => socket.close(),
    };
    socket.onopen = (event) => session.onopen?.(event);
    if ("onactivity" in socket) socket.onactivity = () => {
      if (this.sources.get(id) === source) session.onactivity?.();
    };
    socket.onerror = (event) => session.onerror?.(event);
    socket.onclose = (event) => {
      closed = true;
      if (this.sources.get(id) === source) {
        this.sources.delete(id);
        for (const peer of source.peers.keys()) this.onRemove?.(peer, id);
        for (const rtc of this.rtc.values()) {
          if (rtc.source === source && !["connected", "disconnected"].includes(rtc.pc.connectionState)) rtc.close();
        }
      }
      for (const [key, tunnel] of this.tunnels)
        if (tunnel.source === source) this.closeTunnel(key, false);
      session.onclose?.(event);
    };
    socket.onmessage = (event) => {
      if (this.sources.get(id) !== source) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          if (this.binary(source, new Uint8Array(event.data))) session.onactivity?.();
          return;
        }
        if (typeof event.data !== "string" || event.data.length > 512 * 1024)
          return;
        const packet = JSON.parse(event.data);
        if (packet.type === "capabilities") {
          challenge = packet.challenge ?? "";
          source.reverseDial = packet.capabilities?.includes(CAP.reverseDial) === true;
          source.permitted = permitted && packet.capabilities?.includes(CAP.relay);
        }
        if (packet.type === "tunnel") {
          this.tunnelPacket(source, packet.from, packet.session, packet.data);
          session.onactivity?.();
          return;
        }
        if (packet.type === "tunnel_error") {
          this.closeTunnel(`${id}:${packet.to}:${packet.session}`, false);
          session.onactivity?.();
          return;
        }
        if (packet.type === "signal" && Array.isArray(packet.data?.addresses)) {
          const peer = source.peers.get(packet.from);
          if (!peer) return;
          session.onactivity?.();
          if (this.onAddresses) this.onAddresses(packet.from, packet.data.addresses, source.id);
          else if (canDialWebTransport() && peer.capabilities.includes(CAP.app) && peer.capabilities.includes(CAP.webtransport)) {
            const addresses = pinnedAddresses(packet.data.addresses, peer.id);
            source.webTransport.set(peer.id, addresses);
            this.addressUpdates.dispatchEvent(new Event(peer.id));
          }
          const dial = packet.data.dial;
          if (source.reverseDial && peer.capabilities.includes(CAP.app) && peer.capabilities.includes(CAP.reverseDial)
              && (dial === "connect" || (dial === "background" && source.webTransport.get(peer.id)?.length)))
            this.onReverseDial?.(peer.id, dial);
          return;
        }
        if (packet.type === "signal" && packet.data?.description) {
          if (!source.peers.has(packet.from)) return;
          session.onactivity?.();
          void this.signalRtc(source, packet.from, packet.data, data => this.sendRtc(source, packet.from, data)).catch(
            error => runtimeLog("warn", "connection", "入站信令处理失败", { peerId: packet.from,
              raw: { rtcSessionId: packet.data.session, sourceId: source.id, error } }),
          );
          return;
        }
        if (packet.type === "numeric_id_changed") {
          const previous = source.peers.get(packet.id);
          if (!previous || !/^[1-9][0-9]{5}$/.test(packet.numericId)) return;
          const peer = { ...previous, numericId: packet.numericId };
          source.peers.set(peer.id, peer);
          this.onProfile?.(peer, id);
          session.onmessage?.({data: JSON.stringify({type: "peer_updated", peer})});
          return;
        }
        const observe = (value: unknown) => {
          const peer = discoveryView(value);
          if (peer) {
            if (peer.capabilities.includes(CAP.web) && !peer.capabilities.includes(CAP.webtransport))
              source.announcedAddresses.delete(peer.id);
            if (!peer.capabilities.includes(CAP.webtransport) || !peer.capabilities.includes(CAP.app))
              source.webTransport.delete(peer.id);
            source.peers.set(peer.id, peer);
            this.onProfile?.(peer, id);
          }
          return peer;
        };
        if (Array.isArray(packet.peers)) packet.peers = packet.peers.map(observe).filter(Boolean);
        if (packet.peer) packet.peer = observe(packet.peer);
        for (const peer of packet.removedPeerIds ??
          (packet.type === "peer_left" ? [packet.id] : [])) {
          source.peers.delete(peer);
          source.announcedAddresses.delete(peer);
          source.webTransport.delete(peer);
          this.onRemove?.(peer, id);
          for (const [key, tunnel] of this.tunnels)
            if (tunnel.source === source && tunnel.peer === peer)
              this.closeTunnel(key, true);
        }
        // Revocation applies immediately to every tunnel owned by this center.
        for (const [key, tunnel] of this.tunnels)
          if (tunnel.source === source && !source.peers.get(tunnel.peer)?.relay)
            this.closeTunnel(key, true);
        session.onmessage?.({data: JSON.stringify(packet)});
      } catch {
        socket.close();
      }
    };
    return session;
  }
  private packet(source: Source, peer: string, id: string, data: Packet) {
    source.socket.send(
      JSON.stringify({ type: "tunnel", to: peer, session: id, data }),
    );
  }
  private newTunnel(
    source: Source,
    peer: string,
    id: string,
    inbound: boolean,
  ) {
    const key = `${source.id}:${peer}:${id}`;
    const raw = new ByteConnection(
      multiaddr(`${relayAddress(source.id)}/p2p/${peer}`),
      inbound ? "inbound" : "outbound",
      (bytes) => {
        if (
          tunnel.credit <= 0 ||
          source.socket.readyState !== 1 ||
          source.socket.bufferedAmount > 256 * 1024
        )
          return false;
        const a = encoder.encode(peer),
          b = encoder.encode(id),
          frame = new Uint8Array(10 + a.length + b.length + bytes.length);
        frame.set([75, 73, 77, 50, a.length, b.length]);
        new DataView(frame.buffer).setUint32(6, tunnel.sent);
        tunnel.sent = (tunnel.sent + 1) >>> 0;
        frame.set(a, 10);
        frame.set(b, 10 + a.length);
        frame.set(bytes, 10 + a.length + b.length);
        source.socket.send(frame);
        tunnel.credit--;
        return true;
      },
      () => this.closeTunnel(key, true),
    );
    const tunnel: Tunnel = {
      raw,
      source,
      peer,
      id,
      credit: 8,
      sent: 0,
      received: 0,
      release: 0,
      timer: setInterval(() => {
        if (
          tunnel.release &&
          raw.readBufferLength < 64 * 1024 &&
          source.socket.readyState === 1
        ) {
          this.packet(source, peer, id, {
            kind: "credit",
            count: tunnel.release,
          });
          tunnel.release = 0;
        }
        if (source.socket.bufferedAmount < 128 * 1024 && tunnel.credit > 0)
          raw.drain();
      }, 10),
    };
    this.tunnels.set(key, tunnel);
    return tunnel;
  }
  private closeTunnel(key: string, notify: boolean) {
    const t = this.tunnels.get(key);
    if (!t) return;
    this.tunnels.delete(key);
    clearInterval(t.timer);
    if (notify && t.source.socket.readyState === 1)
      this.packet(t.source, t.peer, t.id, { kind: "close" });
    t.raw.onTransportClosed(new Error("设备连接已断开"));
  }
  private tunnelPacket(
    source: Source,
    peer: string,
    id: string,
    packet: Packet,
  ) {
    const key = `${source.id}:${peer}:${id}`;
    if (packet.kind === "open") {
      if (
        !source.permitted ||
        !source.peers.get(peer)?.relay ||
        this.tunnels.has(key) ||
        handshakeLimitReached(this.tunnels.values()) ||
        !this.incoming.relay || this.admitInbound?.(peer) === false
      )
        return;
      const t = this.newTunnel(source, peer, id, true);
      this.packet(source, peer, id, { kind: "accept" });
      this.incoming.relay(t.raw);
      return;
    }
    const t = this.tunnels.get(key);
    if (!t) return;
    if (packet.kind === "accept") {
      t.accept?.();
      t.accept = undefined;
    } else if (
      packet.kind === "credit" &&
      Number.isInteger(packet.count) &&
      packet.count! > 0 &&
      t.credit + packet.count! <= 8
    ) {
      t.credit += packet.count!;
      t.raw.drain();
    } else if (packet.kind === "close") this.closeTunnel(key, false);
    else this.closeTunnel(key, true);
  }
  private binary(source: Source, bytes: Uint8Array) {
    if (
      bytes.length < 10 ||
      new TextDecoder().decode(bytes.subarray(0, 4)) !== "KIM2"
    )
      throw new Error("Invalid tunnel");
    const a = bytes[4],
      b = bytes[5],
      peer = new TextDecoder().decode(bytes.subarray(10, 10 + a)),
      id = new TextDecoder().decode(bytes.subarray(10 + a, 10 + a + b));
    const key = `${source.id}:${peer}:${id}`,
      t = this.tunnels.get(key);
    if (!t) return;
    const payload = bytes.subarray(10 + a + b),
      seq = new DataView(bytes.buffer, bytes.byteOffset).getUint32(6);
    if (
      seq !== t.received ||
      !payload.length ||
      payload.length > 16384 ||
      t.release >= 8
    ) {
      this.closeTunnel(key, true);
      return;
    }
    t.received = (t.received + 1) >>> 0;
    t.raw.onData(payload);
    t.release++;
    return true;
  }
  async dial(
    kind: "relay" | "rtc",
    address: Multiaddr,
    signal: AbortSignal,
    sessionId?: string,
  ): Promise<ByteConnection> {
    const peer = targetPeer(address);
    signal.throwIfAborted();
    const exchange = kind === "rtc" && this.webTransportExchange?.(peer);
    if (exchange) {
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
      try {
        return await this.dialStream(peer, newId(), attempt, offer => exchange(offer, attempt));
      } catch (error) {
        signal.throwIfAborted();
        runtimeLog("debug", "connection", "直连协商已结束，尝试信令服务", {peerId: peer, raw: {error}});
      }
    }
    const source = [...this.sources.values()].find(
      (s) =>
        s.peers.has(peer) &&
        (kind === "rtc" ||
          (address.toString().startsWith(relayAddress(s.id)) &&
            s.permitted &&
            s.peers.get(peer)?.relay)),
    );
    if (!source) throw new Error("暂时无法联系这台设备");
    signal.throwIfAborted();
    const id = sessionId ?? newId();
    if (kind === "rtc") return this.dialRtc(source, peer, id, signal, data => this.sendRtc(source, peer, data));
    const t = this.newTunnel(source, peer, id, false),
      key = `${source.id}:${peer}:${id}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.closeTunnel(key, true);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      t.raw.addEventListener(
        "close",
        () => {
          signal.removeEventListener("abort", abort);
          reject(new Error("设备连接已断开"));
        },
        { once: true },
      );
      t.accept = () => {
        signal.removeEventListener("abort", abort);
        resolve(t.raw);
      };
      this.packet(source, peer, id, { kind: "open" });
    });
  }
  private sendRtc(source: Source, peer: string, data: RtcSignal) {
    source.socket.send(
      JSON.stringify({ type: "signal", to: peer, data }),
    );
  }
  private createRtc(
    source: RtcSource,
    peer: string,
    id: string,
    inbound: boolean,
  ): Rtc {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const close = (error?: Error) => {
      if (rtc.lifetime.signal.aborted) return;
      this.rtcLog(rtc, "close", { error, action: "close-rtc" });
      rtc.lifetime.abort(error);
      if (this.rtc.get(id) === rtc) this.rtc.delete(id);
      rtc.bulk.close();
      pc.close();
      rtc.raw?.onTransportClosed();
      rtc.reject?.(error ?? new Error("设备连接已断开"));
    };
    const sliceSize = () => rtcSliceSize(this.local?.maxMessageSize, this.cachedProfile?.(peer)?.maxMessageSize, pc.sctp?.maxMessageSize);
    const bulk = new BulkDataChannel(pc, !inbound, sliceSize, rtcHighWater, id);
    const rtc: Rtc = { pc, bulk, peer, source, id, inbound, close, started: performance.now(),
      candidates: {}, lifetime: new AbortController() };
    this.rtc.set(id, rtc);
    this.rtcLog(rtc, "create");
    pc.onicecandidate = ({ candidate }) => {
      if (candidate?.type) rtc.candidates[candidate.type] = (rtc.candidates[candidate.type] ?? 0) + 1;
    };
    pc.onicecandidateerror = event => {
      this.rtcLog(rtc, "ice-candidate-error", { errorCode: event.errorCode,
        serverIndex: this.iceServers.findIndex(server => [server.urls].flat().includes(event.url)) });
    };
    const attach = (dc: RTCDataChannel) => {
      dc.binaryType = "arraybuffer";
      dc.bufferedAmountLowThreshold = rtcLowWater;
      if (rtc.raw || dc.label !== "hummingbird-v2" || !dc.ordered || dc.maxRetransmits != null || dc.maxPacketLifeTime != null) { dc.close(); return; }
      const writer = new RtcWriter(dc, sliceSize);
      const counters = cachedRtcStats(async () => rtcCounters(await pc.getStats(), dc.id));
      rtc.sample = () => ({ ...counters(), rtcSessionId: id, rtcQueueBytes: dc.bufferedAmount + bulk.queueBytes,
        rtcSliceBytes: sliceSize(), rtcFileChunkBytes: bulk.filePayloadBytes, rtcHighBytes: rtcHighWater, rtcLowBytes: dc.bufferedAmountLowThreshold,
        rtcBulkSentBytes: bulk.sentBytes, rtcBulkReceivedBytes: bulk.receivedBytes, rtcBufferWaitMs: writer.bufferWaitMs });
      const raw = new ByteConnection(
        multiaddr(`${RTC_ADDRESS}/p2p/${peer}`),
        inbound ? "inbound" : "outbound",
        bytes => {
          if (writer.write(bytes)) return true;
          if (dc.readyState === "open") {
            void waitForRtcBuffer(dc, bytes.length, rtcHighWater, rtc.lifetime.signal).then(() => {
              writer.drained();
              rtc.raw?.drain();
            }).catch(error => close(error));
          }
          return false;
        },
        () => { try { writer.flush(); } finally { close(); } },
        sliceSize,
      );
      rtc.raw = raw;
      this.sessionByTimeline.set(raw.timeline, id);
      dc.onbufferedamountlow = () => metrics.record("rtc.low", dc.bufferedAmount);
      dc.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          metrics.record("rtc.receive", e.data.byteLength);
          try { writer.batchReplies(() => raw.onData(new Uint8Array(e.data))); }
          catch (error) { close(error instanceof Error ? error : new Error(String(error))); }
        }
        else close();
      };
      dc.onclose = () => close();
      dc.onerror = event => close(new Error(event.error?.message || "DataChannel error"));
      dc.onopen = () => {
        this.rtcLog(rtc, "datachannel-open");
        if (inbound) this.incoming.rtc?.(raw);
        else rtc.accept?.(raw);
      };
    };
    pc.ondatachannel = ({ channel }) => {
      if (channel.label === BULK_LABEL && inbound && bulk.enabled) bulk.attach(channel);
      else attach(channel);
    };
    pc.onconnectionstatechange = () => {
      this.rtcLog(rtc, "connection-state");
      if (["failed", "closed"].includes(pc.connectionState)) close();
    };
    // Full SDP avoids candidate races across independent central sources.
    if (!inbound)
      attach(pc.createDataChannel("hummingbird-v2", { ordered: true }));
    return rtc;
  }
  private async gathered(rtc: Rtc) {
    const signal = AbortSignal.any([rtc.lifetime.signal, AbortSignal.timeout(12000)]);
    try {
      signal.throwIfAborted();
      while (rtc.pc.iceGatheringState !== "complete")
        await pEvent(rtc.pc, "icegatheringstatechange", { signal });
      this.rtcLog(rtc, "ice-gathered");
    } catch (error) {
      this.rtcLog(rtc, "ice-gathering", { timeoutMs: 12000, error, action: "release-attempt" });
      throw error;
    }
  }
  async dialStream(peer: string, session: string, signal: AbortSignal, exchange: (offer: RtcSignal) => Promise<RtcSignal>) {
    return this.dialRtc(this.streamSource, peer, session, signal, async offer => {
      const answer = await exchange(offer);
      if (answer.session !== session || answer.description?.type !== "answer") throw new Error("连接应答无效");
      await this.signalRtc(this.streamSource, peer, answer);
    });
  }
  async answerStream(peer: string, offer: RtcSignal) {
    if (offer.description?.type !== "offer") throw new Error("连接请求无效");
    let answer: RtcSignal | undefined;
    await this.signalRtc(this.streamSource, peer, offer, data => { answer = data; });
    if (!answer) throw new Error("连接请求已关闭");
    return answer;
  }
  private async dialRtc(
    source: RtcSource,
    peer: string,
    id: string,
    signal: AbortSignal,
    send: (offer: RtcSignal) => void | Promise<void>,
  ): Promise<ByteConnection> {
    const rtc = this.createRtc(source, peer, id, false);
    const ready = new Promise<ByteConnection>((resolve, reject) => {
      rtc.accept = resolve;
      rtc.reject = reject;
    });
    // An aborted dial may reject before SDP gathering reaches the ready await.
    void ready.catch(() => {});
    const abort = () => rtc.close(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await rtc.pc.setLocalDescription(await rtc.pc.createOffer());
      await this.gathered(rtc);
      signal.throwIfAborted();
      await send({
        session: id, description: localDescription(rtc.pc, this.supportsBulk),
      });
      rtc.sent = "offer";
      this.rtcLog(rtc, "signal-sent");
      return await ready;
    } catch (error) {
      rtc.close(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async signalRtc(
    source: RtcSource,
    peer: string,
    data: RtcSignal,
    respond?: (answer: RtcSignal) => void,
  ) {
    if (
      !this.rtcEnabled ||
      typeof data.session !== "string" ||
      data.session.length > 64
    )
      return;
    let rtc = this.rtc.get(data.session);
    if (rtc && (rtc.peer !== peer || rtc.source !== source)) return;
    if (data.description?.type === "offer") {
      if (!respond || rtc || handshakeLimitReached(this.rtc.values()) || !this.incoming.rtc || this.admitInbound?.(peer) === false) return;
      rtc = this.createRtc(source, peer, data.session, true);
      rtc.received = "offer";
      rtc.bulk.negotiate(data.description.sdp ?? "", this.supportsBulk);
      const current = rtc;
      const timeout = setTimeout(() => current.close(new Error("RTC handshake timeout")), 25000);
      const clear = () => clearTimeout(timeout);
      rtc.lifetime.signal.addEventListener("abort", clear, {once: true});
      rtc.pc.addEventListener("connectionstatechange", () => {
        if (current.pc.connectionState === "connected") clear();
      }, {signal: rtc.lifetime.signal});
      try {
        await rtc.pc.setRemoteDescription(data.description);
        await rtc.pc.setLocalDescription(await rtc.pc.createAnswer());
        await this.gathered(rtc);
        respond({
          session: data.session, description: localDescription(rtc.pc, rtc.bulk.enabled),
        });
        rtc.sent = "answer";
        this.rtcLog(rtc, "signal-sent");
      } catch (error) {
        rtc.close(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    } else if (rtc?.peer === peer && data.description?.type === "answer") {
      rtc.received = "answer";
      rtc.bulk.negotiate(data.description.sdp ?? "", this.supportsBulk);
      await rtc.pc.setRemoteDescription(data.description);
      this.rtcLog(rtc, "signal-received");
    }
  }
  close() {
    for (const source of this.sources.values()) source.announcedAddresses.clear();
    for (const key of [...this.tunnels.keys()]) this.closeTunnel(key, true);
    for (const rtc of this.rtc.values()) rtc.close();
    this.rtc.clear();
  }
}
