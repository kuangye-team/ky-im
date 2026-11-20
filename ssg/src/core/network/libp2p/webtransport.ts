import { webTransport } from "@libp2p/webtransport";
import { base64url } from "multiformats/bases/base64";
import { multiaddr } from "@multiformats/multiaddr";

export const webTransportBudgetMs = 4500;

/** Accept only pinned IP endpoints. The signaling sender supplies the authenticated dial target. */
export function pinnedAddresses(addresses: unknown[], peer: string) {
  return addresses.slice(0, 32).flatMap(value => {
    if (typeof value !== "string" || value.length > 512) return [];
    try {
      // Round-trip so every multibase certhash is represented in base64url.
      const address = multiaddr(multiaddr(value).bytes);
      const [ip, udp, quic, wt, ...pins] = address.getComponents();
      if (!["ip4", "ip6"].includes(ip?.name) || udp?.name !== "udp" || !Number(udp.value) ||
          quic?.name !== "quic-v1" || wt?.name !== "webtransport" || !pins.length || pins.length > 2) return [];
      for (const pin of pins) {
        if (pin.name !== "certhash" || !pin.value) return [];
        const hash = base64url.decode(pin.value);
        if (hash.length !== 34 || hash[0] !== 0x12 || hash[1] !== 32) return [];
      }
      return [address.encapsulate(`/p2p/${peer}`)];
    } catch { return []; }
  });
}

/** Bound only these probes so unreachable interfaces leave time for an ICE negotiation. */
export function browserWebTransport(): ReturnType<typeof webTransport> {
  return components => {
    const transport = webTransport()(components);
    const dial = transport.dial.bind(transport);
    transport.dial = (address, options) => {
      const signals = [options.signal, AbortSignal.timeout(1500)];
      return dial(address, { ...options, signal: AbortSignal.any(signals) });
    };
    return transport;
  };
}
