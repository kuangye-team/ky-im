type Handler<T> = { handle(event: T): void }["handle"];

/** Discovery carries presence and negotiation. Optional relay frames are consumed by the transport adapter. */
export interface DiscoverySession {
  readonly readyState: number;
  /** Valid traffic consumed below the discovery protocol (SDP or relay). */
  onactivity?: () => void;
  onopen: Handler<Event> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onerror: Handler<Event> | null;
  onclose: Handler<Event> | null;
  /** Recheck individual upstreams when this session combines discovery sources. */
  recheckNetwork?(): void;
  updateLocalProfile?(profile: import("../types").Profile): void;
  send(packet: string): void;
  close(): void;
}

export const DISCOVERY_OPEN = 1;

export interface DiscoveryAdapter {
  readonly name: string;
  readonly supportsNumericIds: boolean;
  /** LAN discovery must work even when the OS reports no Internet connection. */
  readonly usesBrowserNetworkStatus: boolean;
  open(): DiscoverySession;
}

/** A standard connection probe with explicit measurement freshness. */
export interface PeerHealth {
  roundTripMs: number;
  /** Age of the actual round-trip measurement. */
  ageMs: number;
}

/** Reliable bounded streams. File boundaries and blocks stay ordered; independent controls may overtake them. */
export interface TransportChannel extends EventTarget {
  /** Standard libp2p health measurement, independently of content queues. */
  probe(signal: AbortSignal, requestId?: string): Promise<PeerHealth>;
  /** Optional transport-specific probe budget. */
  readonly probeTimeoutMs?: number;
  onpinganswered?: (receivedAt: number, requestId?: string) => void;
  readonly fileTasks?: import("../transfers/types").FileTaskExecutor;
  onfileprogress?: (event: import("../transfers/types").FileProgress) => void;
  readonly readyState: string;
  /** Negotiated complete-frame limit, including the application header. */
  readonly maxMessageSize?: number;
  /** Preferred large-file record payload on the negotiated RTC connection. */
  readonly bulkFilePayloadBytes?: number;
  readonly separateControl?: boolean;
  readonly connectionId?: string;
  causeEventId?: string;
  readonly physicalConnectionId?: string;
  /** Synchronous RTC counters for optional transfer diagnostics. */
  rtcSample?(): Record<string, unknown> | undefined;
  binaryType: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: Handler<Event> | null;
  onmessage: Handler<{ data: unknown; consumed?: () => void }> | null;
  onerror: Handler<Event> | null;
  onclose: Handler<Event> | null;
  send(data: string | ArrayBuffer, largeFileChunk?: boolean): void;
  /** Drop unsent frames for a cancelled transfer. Already transmitted frames are ignored by its receiver. */
  cancelTransfer?(id: string): void;
  close(): void;
}

export interface TransportConnection {
  readonly channel?: TransportChannel;
  start(): void;
  signal(data: unknown): Promise<void>;
  close(retirePeer?: boolean): void | Promise<void>;
}

export interface TransportOptions {
  localId: string;
  peerId: string;
  /** Intersection of current local and peer capabilities. */
  capabilities: readonly string[];
  sendSignal(data: unknown): void;
  onChannel(channel: TransportChannel, replace?: boolean): void;
  onState(state: "connected" | "disconnected" | "failed"): void;
  onError(error: unknown): void;
}

export interface TransportAdapter {
  readonly name: string;
  onProfile?: (profile: import("../types").Profile) => void;
  cachedProfile?: (id: string) => import("../types").Profile | undefined;
  publish?(profile: import("../types").Profile): void;
  stop?(): Promise<void>;
  /** Unsolicited native connections must also pass the engine's discovered-peer check. */
  onIncoming?: (peerId: string) => boolean | void;
  onConnectRequest?: (peerId: string) => void;
  /** A reverse-dial peer warms a direct route when it announces addresses. */
  handleBackgroundDial?(peerId: string): boolean;
  /** Callbacks run after create returns; an existing channel is exposed on the result. */
  create(options: TransportOptions): TransportConnection;
}

export interface NetworkAdapters {
  needsNearbyPermission?: boolean;
  runtime?: import("../capabilities").RuntimeInfo;
  discovery: DiscoveryAdapter;
  transport: TransportAdapter;
}
