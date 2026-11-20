import {
  transportSymbol,
  TypedEventEmitter,
  type CreateListenerOptions,
  type DialTransportOptions,
  type Listener,
  type ListenerEvents,
  type Transport,
} from "@libp2p/interface";
import type { ByteConnection } from "./bytes";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";

export const RTC_ADDRESS = "/dns4/rtc.hummingbird.invalid/udp/1/webrtc";
export const relayAddress = (source: string) =>
  `/dns4/${source}.relay.hummingbird.invalid/tcp/443/wss`;
export const targetPeer = (ma: Multiaddr) =>
  ma.getComponents().find((c) => c.name === "p2p")?.value ?? "";
export interface TransportBridge {
  dial(
    kind: "relay" | "rtc",
    address: Multiaddr,
    signal: AbortSignal,
  ): Promise<ByteConnection>;
  incoming: Partial<
    Record<"relay" | "rtc", (connection: ByteConnection) => void>
  >;
}
export function bridgeTransport(
  bridge: TransportBridge,
  kind: "relay" | "rtc",
) {
  return (): Transport => {
    const matches = (ma: Multiaddr) =>
      kind === "rtc"
        ? ma.toString().startsWith(RTC_ADDRESS)
        : ma.toString().includes(".relay.hummingbird.invalid/");
    return {
      [Symbol.toStringTag]: `Hummingbird ${kind}`,
      [transportSymbol]: true,
      dialFilter: (addrs) => addrs.filter(matches),
      listenFilter: (addrs) => addrs.filter(matches),
      async dial(ma: Multiaddr, options: DialTransportOptions) {
        const raw = await bridge.dial(kind, ma, options.signal);
        try {
          const connection = await options.upgrader.upgradeOutbound(raw, options);
          raw.managed = true;
          return connection;
        } catch (error) {
          raw.abort(error as Error);
          throw error;
        }
      },
      createListener(options: CreateListenerOptions): Listener {
        return new (class
          extends TypedEventEmitter<ListenerEvents>
          implements Listener
        {
          address?: Multiaddr;
          controller = new AbortController();
          async listen(address: Multiaddr) {
            this.address = address;
            bridge.incoming[kind] = (raw) => {
              void options.upgrader
                .upgradeInbound(raw, { signal: this.controller.signal })
                .then(() => { raw.managed = true; })
                .catch((error) => raw.abort(error));
            };
            this.safeDispatchEvent("listening");
          }
          getAddrs() {
            return this.address ? [multiaddr(this.address)] : [];
          }
          updateAnnounceAddrs() {}
          async close() {
            this.controller.abort();
            delete bridge.incoming[kind];
            this.safeDispatchEvent("close");
          }
        })();
      },
    };
  };
}
