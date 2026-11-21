import { CAP, configuredRuntime } from "../src/core/capabilities";
import type { NetworkSettings } from "../src/core/network/settings";

// Isolate the transport under test in the integration and benchmark clients.
export function transportRuntime(native: boolean, settings: NetworkSettings, enabled: { tcp: boolean; webrtc: boolean }) {
  const runtime = configuredRuntime(native, settings);
  runtime.capabilities = runtime.capabilities.filter(cap =>
    (cap !== CAP.tcp || enabled.tcp) &&
    (cap !== CAP.webtransport || !native || enabled.tcp) &&
    (cap !== CAP.webrtc || enabled.webrtc));
  return runtime;
}
