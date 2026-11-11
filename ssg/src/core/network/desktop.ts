import { RelayTransportAdapter } from "./relay";
import { SIGNALING_CONFIG } from "../../config";
import { CombinedDiscoveryAdapter } from "./combined";
import { SignalingDiscoveryAdapter } from "./signaling";
import { WebRTCTransportAdapter } from "./webrtc";
import { PreferredTransportAdapter } from "./fallback";
import { readSettings, type NetworkSettings } from "./settings";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  CHUNK_SIZE,
  HEADER_SIZE,
  MAX_CONTROL_BYTES,
  isProfile,
  newId,
} from "../protocol";
import type { Profile } from "../types";
import type {
  DiscoveryAdapter,
  DiscoverySession,
  NetworkAdapters,
  TransportAdapter,
  TransportChannel,
  TransportConnection,
  TransportOptions,
} from "./types";

export type NativeEvent =
  | { type: "peer"; profile: Profile }
  | { type: "left"; peerId: string }
  | { type: "open" | "closed"; peerId: string; connectionId: string }
  | {
      type: "data";
      peerId: string;
      connectionId: string;
      kind: number;
      data: ArrayBuffer;
    }
  | { type: "signal"; peerId: string; data: unknown }
  | { type: "error" };

/** Inject the bridge for tests without a WebView or any network globals. */
export interface NativeBridge {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  invokeBinary(command: string, data: ArrayBuffer, headers: Record<string, string>): Promise<unknown>;
  channel(receive: (event: NativeEvent | ArrayBuffer) => void): unknown;
}
const nativeBridge: NativeBridge = {
  invoke,
  invokeBinary: (command, data, headers) => invoke(command, data, { headers }),
  channel(receive) {
    const channel = new Channel<NativeEvent | ArrayBuffer>();
    channel.onmessage = receive;
    return channel;
  },
};

function decodeEvent(raw: NativeEvent | ArrayBuffer): NativeEvent {
  if (!(raw instanceof ArrayBuffer)) return raw;
  // The Rust channel prefixes raw frames with two 36-byte UUIDs and a kind byte.
  const bytes = new Uint8Array(raw);
  if (bytes.length <= 73) throw new Error("Invalid native frame");
  const kind = bytes[72];
  const limit = kind === 1 ? MAX_CONTROL_BYTES : kind === 2 ? CHUNK_SIZE + HEADER_SIZE : 0;
  if (bytes.length - 73 > limit) throw new Error("Invalid native frame");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    type: "data",
    peerId: decoder.decode(bytes.subarray(0, 36)),
    connectionId: decoder.decode(bytes.subarray(36, 72)),
    kind,
    data: raw.slice(73),
  };
}

class DesktopRuntime {
  session?: MdnsSession;
  readonly knownPeers = new Set<string>();
  readonly channels = new Map<string, TcpChannel>();
  readonly closing = new Map<string, Promise<unknown>>();
  incoming?: (peerId: string) => void;
  /** Serialize lifecycle calls, including close while a native start is pending. */
  lifecycle: Promise<unknown> = Promise.resolve();
  endpoint?: { instance: string; port: number; addresses: string[] };
  onReady?: () => void;
  constructor(
    readonly bridge: NativeBridge,
    readonly settings: NetworkSettings,
  ) {}
  call(command: string, args: Record<string, unknown> = {}) {
    if (!this.session || this.session.readyState === 3)
      return Promise.reject(new Error("连接已关闭"));
    return this.bridge.invoke(command, { sessionId: this.session.id, ...args });
  }
  send(peerId: string, connectionId: string, kind: number, data: ArrayBuffer) {
    if (!this.session || this.session.readyState === 3)
      return Promise.reject(new Error("连接已关闭"));
    return this.bridge.invokeBinary("tcp_send", data, {
      "x-session-id": this.session.id,
      "x-peer-id": peerId,
      "x-connection-id": connectionId,
      "x-frame-kind": String(kind),
    });
  }
  closePeer(peerId: string, connectionId?: string) {
    const operation = this.call("tcp_close", { peerId, connectionId }).catch(
      () => {},
    );
    this.closing.set(peerId, operation);
    void operation.finally(() => {
      if (this.closing.get(peerId) === operation) this.closing.delete(peerId);
    });
  }
  event(event: NativeEvent) {
    if (event.type === "peer") {
      if (isProfile(event.profile)) {
        this.knownPeers.add(event.profile.id);
        this.session?.receive({ type: "peer_updated", peer: event.profile });
      }
    } else if (event.type === "left") {
      this.session?.receive({ type: "peer_left", id: event.peerId });
    } else if (event.type === "signal") {
      this.session?.receive({
        type: "signal",
        from: event.peerId,
        data: event.data,
      });
    } else if (event.type === "error") {
      this.session?.fail();
    } else {
      if (event.type === "open") {
        const previous = this.channels.get(event.peerId);
        if (
          previous?.connectionId &&
          previous.connectionId !== event.connectionId
        )
          previous.finish();
        if (!this.channels.has(event.peerId)) this.incoming?.(event.peerId);
      }
      const channel = this.channels.get(event.peerId);
      if (event.type === "open") {
        if (channel) channel.open(event.connectionId);
        else
          void this.call("tcp_close", {
            peerId: event.peerId,
            connectionId: event.connectionId,
          }).catch(() => {});
      } else if (channel?.connectionId === event.connectionId) {
        if (event.type === "closed") channel.finish();
        else if (event.type === "data") channel.receive(event);
      }
    }
  }
}

class MdnsSession implements DiscoverySession {
  readonly id = newId();
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private joined = false;
  private pending: NativeEvent[] = [];
  constructor(private readonly runtime: DesktopRuntime) {
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }
  receive(packet: unknown) {
    if (this.readyState !== 3)
      this.onmessage?.({ data: JSON.stringify(packet) });
  }
  send(raw: string) {
    if (this.readyState !== 1) throw new Error("连接已关闭");
    const packet = JSON.parse(raw);
    if (packet.type === "join") {
      const onEvent = this.runtime.bridge.channel((raw) => {
        if (this.readyState === 3) return;
        try {
          const event = decodeEvent(raw);
          if (this.joined) this.runtime.event(event);
          else if (this.pending.length < 1024) this.pending.push(event);
          else this.fail();
        } catch { this.fail(); }
      });
      this.runtime.lifecycle = this.runtime.lifecycle
        .catch(() => {})
        .then(async () => {
          if (this.readyState === 3) return;
          this.runtime.endpoint = (await this.runtime.bridge.invoke(
            "lan_start",
            {
              sessionId: this.id,
              profile: packet.profile,
              room: packet.room,
              onEvent,
              discover: this.runtime.settings.discovery.mdns,
              tcpEnabled: this.runtime.settings.transport.tcp,
            },
          )) as DesktopRuntime["endpoint"];
          if (this.readyState === 3) return;
          this.joined = true;
          this.receive({ type: "welcome", peers: [] });
          for (const event of this.pending.splice(0)) this.runtime.event(event);
          this.runtime.onReady?.();
        })
        .catch(() => this.fail());
    } else if (packet.type === "profile") {
      void this.runtime
        .call("lan_profile", { profile: packet.profile })
        .catch(() => this.fail());
    } else if (packet.type === "signal") {
      void this.runtime
        .call("lan_signal", { peerId: packet.to, data: packet.data })
        .catch(() => {
          this.receive({ type: "error", code: "signal_failed" });
        });
    } else if (packet.type === "ping") {
      if (this.joined) queueMicrotask(() => this.receive({ type: "pong" }));
    } else if (packet.type !== "pong") {
      throw new Error("局域网内的设备会自动出现，无需蜂鸟号");
    }
  }
  fail() {
    if (this.readyState === 3) return;
    this.onerror?.();
    this.close();
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.pending = [];
    this.runtime.knownPeers.clear();
    for (const channel of [...this.runtime.channels.values()]) channel.finish();
    this.runtime.lifecycle = this.runtime.lifecycle
      .catch(() => {})
      .then(() =>
        this.runtime.bridge.invoke("lan_stop", { sessionId: this.id }),
      )
      .catch(() => {});
    this.onclose?.();
  }
}

export class MdnsDiscoveryAdapter implements DiscoveryAdapter {
  readonly name = "mdns";
  readonly supportsNumericIds = false;
  readonly usesBrowserNetworkStatus = false;
  constructor(private readonly runtime: DesktopRuntime) {}
  open(): DiscoverySession {
    this.runtime.session?.close();
    return (this.runtime.session = new MdnsSession(this.runtime));
  }
}

class TcpChannel extends EventTarget implements TransportChannel {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  connectionId?: string;
  private writing = Promise.resolve();
  constructor(
    private readonly runtime: DesktopRuntime,
    readonly peerId: string,
  ) {
    super();
  }
  private args() {
    return { peerId: this.peerId, connectionId: this.connectionId };
  }
  open(id: string) {
    if (this.readyState === "closed") return;
    this.connectionId = id;
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }
  fail() {
    if (this.readyState === "closed") return;
    this.onerror?.(new Event("error"));
    this.dispatchEvent(new Event("error"));
    this.close();
  }
  receive(event: Extract<NativeEvent, { type: "data" }>) {
    if (this.readyState !== "open") return;
    try {
      const data =
        event.kind === 1
          ? new TextDecoder("utf-8", { fatal: true }).decode(event.data)
          : event.data;
      if (this.onmessage) this.onmessage({ data });
      else this.consumed();
    } catch {
      this.fail();
    }
  }
  consumed() {
    void this.runtime
      .call("tcp_consumed", this.args())
      .catch(() => this.fail());
  }
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("设备连接已断开");
    const size =
      typeof data === "string"
        ? new TextEncoder().encode(data).byteLength
        : data.byteLength;
    if (
      !size ||
      size >
        (typeof data === "string"
          ? MAX_CONTROL_BYTES
          : CHUNK_SIZE + HEADER_SIZE) ||
      this.bufferedAmount + size > 1024 * 1024
    )
      throw new Error("传输缓冲区已满，请稍后重试");
    const kind = typeof data === "string" ? 1 : 2;
    const payload =
      typeof data === "string"
        ? new TextEncoder().encode(data).buffer
        : data;
    this.bufferedAmount += size;
    this.writing = this.writing
      .then(async () => {
        if (this.readyState !== "open") return;
        await this.runtime.send(this.peerId, this.connectionId!, kind, payload);
      })
      .catch(() => this.fail())
      .finally(() => {
        this.bufferedAmount -= size;
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold)
          this.dispatchEvent(new Event("bufferedamountlow"));
      });
  }
  finish() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    if (this.runtime.channels.get(this.peerId) === this)
      this.runtime.channels.delete(this.peerId);
    this.onclose?.(new Event("close"));
    this.dispatchEvent(new Event("close"));
  }
  close() {
    if (this.readyState === "closed") return;
    this.runtime.closePeer(this.peerId, this.connectionId);
    this.finish();
  }
}

export class TcpTransportAdapter implements TransportAdapter {
  readonly name = "tcp";
  constructor(private readonly runtime: DesktopRuntime) {}
  set onIncoming(callback: ((peerId: string) => void) | undefined) {
    this.runtime.incoming = callback;
  }
  create(options: TransportOptions): TransportConnection {
    const channel = new TcpChannel(this.runtime, options.peerId);
    this.runtime.channels.set(options.peerId, channel);
    let started = false;
    return {
      channel,
      start: () => {
        if (started || channel.readyState === "open") return;
        started = true;
        const session = this.runtime.session;
        void (this.runtime.closing.get(options.peerId) ?? Promise.resolve())
          .then(async () => {
            await this.runtime.lifecycle;
            const deadline = Date.now() + 1500;
            while (
              !this.runtime.knownPeers.has(options.peerId) &&
              channel.readyState !== "closed" &&
              Date.now() < deadline
            )
              await new Promise((resolve) => setTimeout(resolve, 25));
            if (
              channel.readyState === "closed" ||
              this.runtime.session !== session
            )
              return;
            return this.runtime.call("tcp_connect", { peerId: options.peerId });
          })
          .catch(() => channel.fail());
      },
      signal: async () => {},
      close: () => channel.close(),
    };
  }
}

/** Keep native listeners alive independently of the selected discovery sources. */
class DesktopDiscoveryAdapter implements DiscoveryAdapter {
  readonly supportsNumericIds: boolean;
  readonly usesBrowserNetworkStatus = false;
  readonly name: string;
  constructor(
    private readonly runtime: DesktopRuntime,
    private readonly central: DiscoveryAdapter[],
  ) {
    this.supportsNumericIds = central.length > 0;
    this.name = [
      central.length ? "signaling" : "",
      runtime.settings.discovery.mdns ? "mdns" : "",
    ]
      .filter(Boolean)
      .join("+");
  }
  open(): DiscoverySession {
    const runtime = this.runtime;
    const mdns = new MdnsDiscoveryAdapter(runtime);
    const useMdns = runtime.settings.discovery.mdns;
    const inner = new CombinedDiscoveryAdapter([
      ...this.central,
      ...(useMdns ? [mdns] : []),
    ]).open();
    let auxiliary = useMdns ? undefined : mdns.open();
    let auxiliaryRetry: ReturnType<typeof setTimeout> | undefined;
    let auxiliaryAttempts = 0;
    const profiles = new Map<string, Profile>();
    const announced = new Set<string>();
    const endpoints = new Map<string, unknown>();
    let auxiliaryJoined = false;
    let join: string | undefined;
    const announce = (peerId: string) => {
      if (
        announced.has(peerId) ||
        !runtime.settings.transport.tcp ||
        !this.central.length
      )
        return;
      announced.add(peerId);
      void runtime.lifecycle.then(() => {
        if (
          outer.readyState === 3 ||
          !profiles.has(peerId) ||
          runtime.session?.readyState !== 1 ||
          !runtime.endpoint?.addresses.length
        )
          return;
        try {
          inner.send(
            JSON.stringify({
              type: "signal",
              to: peerId,
              data: { tcp: runtime.endpoint },
            }),
          );
        } catch {
          announced.delete(peerId);
        }
      });
    };
    const register = (peerId: string, endpoint: unknown) => {
      const session = runtime.session;
      void runtime.lifecycle
        .then(async () => {
          const profile = profiles.get(peerId);
          if (
            !profile ||
            outer.readyState === 3 ||
            runtime.session !== session ||
            endpoints.get(peerId) !== endpoint
          )
            return;
          await runtime.call("lan_peer", { profile, endpoint });
          if (profiles.has(peerId) && runtime.session === session)
            runtime.knownPeers.add(peerId);
        })
        .catch(() => {});
    };
    runtime.onReady = () => {
      auxiliaryAttempts = 0;
      announced.clear();
      for (const peerId of profiles.keys()) announce(peerId);
      for (const [peerId, endpoint] of endpoints) register(peerId, endpoint);
    };
    const outer: DiscoverySession = {
      get readyState() {
        return inner.readyState;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(raw) {
        const packet = JSON.parse(raw);
        if (packet.type === "join") {
          join = raw;
          if (auxiliary?.readyState === 1) {
            auxiliary.send(raw);
            auxiliaryJoined = true;
          }
        } else if (
          packet.type === "profile" &&
          auxiliaryJoined &&
          auxiliary?.readyState === 1
        )
          auxiliary?.send(raw);
        inner.send(raw);
      },
      close() {
        clearTimeout(auxiliaryRetry);
        inner.close();
        auxiliary?.close();
      },
    };
    const watchAuxiliary = () => {
      if (!auxiliary) return;
      auxiliary.onopen = () => {
        if (join) {
          auxiliary?.send(join);
          auxiliaryJoined = true;
        }
      };
      // Retry native startup separately; an available WebRTC service stays online.
      auxiliary.onerror = () => {
        auxiliaryJoined = false;
        clearTimeout(auxiliaryRetry);
        const delay = Math.min(
          SIGNALING_CONFIG.reconnectMaxDelayMs,
          SIGNALING_CONFIG.reconnectInitialDelayMs *
            2 ** Math.min(auxiliaryAttempts++, 16),
        );
        auxiliaryRetry = setTimeout(() => {
          if (outer.readyState === 3) return;
          auxiliary = mdns.open();
          watchAuxiliary();
        }, delay);
      };
    };
    watchAuxiliary();
    inner.onopen = (event) => outer.onopen?.(event);
    inner.onclose = (event) => {
      clearTimeout(auxiliaryRetry);
      auxiliary?.close();
      outer.onclose?.(event);
    };
    inner.onerror = (event) => outer.onerror?.(event);
    inner.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const packet = JSON.parse(event.data);
      if (
        packet.type === "peer_updated" ||
        packet.type === "peer_joined" ||
        packet.type === "peer_resolved"
      ) {
        if (isProfile(packet.peer)) {
          profiles.set(packet.peer.id, packet.peer);
          announce(packet.peer.id);
        }
      } else if (packet.type === "peer_left") {
        runtime.knownPeers.delete(packet.id);
        profiles.delete(packet.id);
        announced.delete(packet.id);
        endpoints.delete(packet.id);
        void runtime.call("lan_forget", { peerId: packet.id }).catch(() => {});
      } else if (packet.type === "signal" && packet.data?.tcp) {
        if (profiles.has(packet.from)) {
          const changed =
            JSON.stringify(endpoints.get(packet.from)) !==
            JSON.stringify(packet.data.tcp);
          endpoints.set(packet.from, packet.data.tcp);
          register(packet.from, packet.data.tcp);
          if (changed) {
            announced.delete(packet.from);
            announce(packet.from);
          }
        }
        return;
      }
      outer.onmessage?.(event);
    };
    return outer;
  }
}

export function desktopNetwork(
  bridge = nativeBridge,
  settings = readSettings(true),
): NetworkAdapters {
  const runtime = new DesktopRuntime(bridge, settings);
  const tcp = new TcpTransportAdapter(runtime);
  const rtc = new WebRTCTransportAdapter();
  const direct =
    settings.transport.tcp && settings.transport.webrtc
      ? new PreferredTransportAdapter(tcp, rtc)
      : settings.transport.tcp
        ? tcp
        : rtc;
  const relay =
    settings.discovery.signaling &&
    settings.servers.some((s) => s.enabled && s.relay && s.relaySupported)
      ? new RelayTransportAdapter(direct)
      : undefined;
  const central = settings.discovery.signaling
    ? settings.servers
        .filter((s) => s.enabled)
        .map(
          (s) =>
            new SignalingDiscoveryAdapter(
              s.url,
              s.relay && s.relaySupported ? relay : undefined,
              s.authorization,
            ),
        )
    : [];
  return {
    discovery:
      !settings.discovery.mdns && !settings.transport.tcp
        ? central.length === 1
          ? central[0]
          : new CombinedDiscoveryAdapter(central)
        : new DesktopDiscoveryAdapter(runtime, central),
    transport: relay ?? direct,
  };
}
