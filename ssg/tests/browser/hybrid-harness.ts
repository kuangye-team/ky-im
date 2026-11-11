// Browser integration harness: real WebSockets/WebRTC, injected native IPC.
// Real TCP sockets, framing and negotiation are covered by app/src/network/tests.rs.
import { ChatEngine } from "../../src/core/engine";
import { IndexedDBStorageAdapter } from "../../src/core/storage";
import { newId } from "../../src/core/protocol";
import {
  desktopNetwork,
  type NativeBridge,
  type NativeEvent,
} from "../../src/core/network/desktop";
import { browserNetwork } from "../../src/core/network";
import { defaultSettings } from "../../src/core/network/settings";
import type { Profile } from "../../src/core/types";

const nodes = new Map<
  string,
  { profile: Profile; emit: (e: NativeEvent) => void; discover: boolean }
>();
export const calls: string[] = [];
export const engines: ChatEngine[] = [];
const stores: IndexedDBStorageAdapter[] = [];
function bridge(): NativeBridge {
  let id = "";
  return {
    async invokeBinary() { throw new Error("Test TCP connection unavailable"); },
    channel: (receive) => receive,
    async invoke(command, args) {
      calls.push(command);
      if (command === "lan_start") {
        const profile = args.profile as Profile;
        id = profile.id;
        const emit = args.onEvent as (e: NativeEvent) => void;
        const discover = Boolean(args.discover);
        for (const node of nodes.values())
          if (node.discover && discover) {
            emit({ type: "peer", profile: node.profile });
            node.emit({ type: "peer", profile });
          }
        nodes.set(id, { profile, emit, discover });
        return { instance: newId(), port: 9, addresses: ["192.168.1.250"] };
      }
      if (command === "lan_signal")
        nodes
          .get(String(args.peerId))
          ?.emit({ type: "signal", peerId: id, data: args.data });
      if (command === "lan_stop") nodes.delete(id);
      if (command === "tcp_connect")
        throw new Error("Test TCP connection unavailable");
    },
  };
}
export async function start(mode: "fallback" | "mdns") {
  const desktopSettings = defaultSettings(true);
  desktopSettings.discovery = {
    signaling: mode === "fallback",
    mdns: mode === "mdns",
  };
  desktopSettings.transport = { tcp: mode === "fallback", webrtc: true };
  desktopSettings.servers = [
    {
      id: "test",
      name: "test",
      url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`,
      enabled: true,
    },
  ];
  for (let i = 0; i < 2; i++) {
    const storage = new IndexedDBStorageAdapter(`hybrid-${newId()}`);
    stores.push(storage);
    const profile: Profile = {
      id: newId(),
      name: `hybrid-${i}`,
      avatar: "🌿",
      bio: "",
      color: "#123abc",
      device: i === 0 || mode === "mdns" ? "Desktop" : "Browser",
      clientType: i === 0 || mode === "mdns" ? "app" : "web",
    };
    const network =
      i === 0 || mode === "mdns"
        ? desktopNetwork(bridge(), desktopSettings)
        : browserNetwork(defaultSettings(false));
    const engine = new ChatEngine(storage, profile, [], network);
    engines.push(engine);
    engine.start();
  }
}
export async function send() {
  const [a, b] = engines;
  await a.selectPeer(b.getSnapshot().profile);
  await a.sendText("真实 WebRTC 通道");
  await b.selectPeer(a.getSnapshot().profile);
}
export async function reply() {
  await engines[1].sendText("双向连接成功");
}
export async function stop() {
  engines.forEach((e) => e.stop());
  await Promise.all(stores.map((s) => s.close()));
}
