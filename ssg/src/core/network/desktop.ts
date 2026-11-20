import { configuredRuntime } from "../capabilities";
import { CombinedDiscoveryAdapter } from "./combined";
import { SignalingDiscoveryAdapter } from "./signaling";
import { readSettings } from "./settings";
import { activeIceServers } from "../../ice-servers";
import { CentralBridge } from "./libp2p/bridge";
import { identityFor, type DeviceIdentity } from "./libp2p/identity";
import { NativePeerNode, nativeBridge, type P2pBridge } from "./libp2p/native";
import { DesktopStorageAdapter } from "../storage/desktop";
import type { DiscoveryAdapter, NetworkAdapters } from "./types";
export { nativeBridge };
export type { P2pBridge as NativeBridge };
export function desktopNetwork(
  bridge: P2pBridge = nativeBridge,
  settings = readSettings(true),
  identity?: Promise<DeviceIdentity>,
): NetworkAdapters {
  const central = new CentralBridge(
    identity ?? identityFor(new DesktopStorageAdapter()),
    activeIceServers(settings.iceServers),
    settings.transport.webrtc,
  );
  const transport = new NativePeerNode(central, settings, bridge);
  const sources: DiscoveryAdapter[] = settings.discovery.signaling
    ? settings.servers
        .filter((s) => s.enabled)
        .map(
          (s, i) =>
            new SignalingDiscoveryAdapter(
              s.url,
              { ...central.hook(`s${i}`, !!(s.relay && s.relaySupported), s.extend),
                ...(bridge.nativeIO ? { socket: (url: string) => transport.socket(`s${i}`, url, !!(s.relay && s.relaySupported)) } : {}),
              },
              s.authorization,
            ),
        )
    : [];
  // This source starts the single native node even when LAN browsing is disabled.
  sources.push({
    name: settings.discovery.mdns ? "mdns" : "native",
    supportsNumericIds: true,
    usesBrowserNetworkStatus: false,
    open: () => transport.discovery(),
  });
  return {
    runtime: configuredRuntime(true, settings),
    discovery: new CombinedDiscoveryAdapter(sources),
    transport,
  };
}
