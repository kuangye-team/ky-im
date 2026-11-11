type Handler<T> = { handle(event: T): void }["handle"];

/** Discovery carries presence and negotiation. Optional relay frames are consumed by the transport adapter. */
export interface DiscoverySession {
  readonly readyState: number;
  onopen: Handler<Event> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onerror: Handler<Event> | null;
  onclose: Handler<Event> | null;
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

/** Ordered, reliable, bounded message stream. Implementations preserve frame boundaries. */
export interface TransportChannel extends EventTarget {
  readonly readyState: string;
  /** Negotiated complete-frame limit, including the application header. */
  readonly maxMessageSize?: number;
  binaryType: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: Handler<Event> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onerror: Handler<Event> | null;
  onclose: Handler<Event> | null;
  send(data: string | ArrayBuffer): void;
  /** Return native receive credit after the asynchronous engine consumer finishes. */
  consumed?(): void;
  close(): void;
}

export interface TransportConnection {
  readonly channel?: TransportChannel;
  start(): void;
  signal(data: unknown): Promise<void>;
  close(): void;
}

export interface TransportOptions {
  localId: string;
  peerId: string;
  sendSignal(data: unknown): void;
  onChannel(channel: TransportChannel, replace?: boolean): void;
  onState(state: "connected" | "disconnected" | "failed"): void;
  onError(error: unknown): void;
}

export interface TransportAdapter {
  readonly name: string;
  /** Unsolicited native connections must also pass the engine's discovered-peer check. */
  onIncoming?: (peerId: string) => void;
  /** Callbacks run after create returns; an existing channel is exposed on the result. */
  create(options: TransportOptions): TransportConnection;
}

export interface NetworkAdapters {
  discovery: DiscoveryAdapter;
  transport: TransportAdapter;
}
