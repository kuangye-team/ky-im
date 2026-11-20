import { configuredRuntime } from "../capabilities";
import { CombinedDiscoveryAdapter } from "./combined";
import { readSettings, type NetworkSettings } from "./settings";
import { SignalingDiscoveryAdapter } from "./signaling";
import { activeIceServers } from "../../ice-servers";
import { CentralBridge } from "./libp2p/bridge";
import { PeerNode } from "./libp2p/node";
import { identityFor, type DeviceIdentity } from "./libp2p/identity";
import { IndexedDBStorageAdapter } from "../storage";
import type { NetworkAdapters } from "./types";
export * from "./types";
export { SignalingDiscoveryAdapter };

export function browserNetwork(
  settings: NetworkSettings = readSettings(false),
  identity?: Promise<DeviceIdentity>,
): NetworkAdapters {
  const bridge = new CentralBridge(
    identity ?? identityFor(new IndexedDBStorageAdapter()),
    activeIceServers(settings.iceServers),
    settings.transport.webrtc,
  );
  const transport = new PeerNode(bridge);
  const sources = settings.servers
    .filter((s) => s.enabled)
    .map(
      (s, index) =>
        new SignalingDiscoveryAdapter(
          s.url,
          bridge.hook(`s${index}`, !!(s.relay && s.relaySupported), s.extend),
          s.authorization,
        ),
    );
  return {
    runtime: configuredRuntime(false, settings),
    discovery:
      sources.length === 1 ? sources[0] : new CombinedDiscoveryAdapter(sources),
    transport,
  };
}
export async function defaultNetwork(
  settings = readSettings(),
  identity?: Promise<DeviceIdentity>,
): Promise<NetworkAdapters> {
  if (import.meta.env.VITE_DESKTOP) {
    const { desktopNetwork } = await import("./desktop");
    return desktopNetwork(undefined, settings, identity);
  }
  return browserNetwork(settings, identity);
}
