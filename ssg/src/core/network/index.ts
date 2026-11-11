import { CombinedDiscoveryAdapter } from "./combined";
import { readSettings, type NetworkSettings } from "./settings";
import { SignalingDiscoveryAdapter } from "./signaling";
import { WebRTCTransportAdapter } from "./webrtc";
import { RelayTransportAdapter } from "./relay";
import type { NetworkAdapters } from "./types";

export * from "./types";
export { SignalingDiscoveryAdapter, WebRTCTransportAdapter };

export function browserNetwork(
  settings: NetworkSettings = readSettings(false),
): NetworkAdapters {
  const direct = new WebRTCTransportAdapter();
  const relay = settings.servers.some(
    (s) => s.enabled && s.relay && s.relaySupported,
  )
    ? new RelayTransportAdapter(direct)
    : undefined;
  const sources = settings.servers
    .filter((s) => s.enabled)
    .map(
      (s) =>
        new SignalingDiscoveryAdapter(
          s.url,
          s.relay && s.relaySupported ? relay : undefined,
          s.authorization,
        ),
    );
  return {
    discovery:
      sources.length === 1 ? sources[0] : new CombinedDiscoveryAdapter(sources),
    transport: relay ?? direct,
  };
}

export async function defaultNetwork(
  settings = readSettings(),
): Promise<NetworkAdapters> {
  if (import.meta.env.VITE_DESKTOP) {
    const { desktopNetwork } = await import("./desktop");
    return desktopNetwork(undefined, settings);
  }
  return browserNetwork(settings);
}
