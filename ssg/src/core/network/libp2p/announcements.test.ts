import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { expect, it, vi } from "vitest";
import { CAP, localRuntime } from "../../capabilities";
import { defaultSettings } from "../settings";
import { CentralBridge } from "./bridge";
import { NativePeerNode, type P2pBridge } from "./native";

it("coalesces discovery and listener changes and republishes after a peer rejoins", async () => {
  const key = await generateKeyPair("Ed25519");
  const id = peerIdFromPrivateKey(key).toString();
  const central = new CentralBridge(Promise.resolve({ id, key }), [], false);
  let onEvent: Parameters<P2pBridge["request"]>[2];
  const node = new NativePeerNode(central, defaultSettings(true), {
    async request<T>(...[, , handler]: Parameters<P2pBridge["request"]>) {
      if (handler) onEvent = handler;
      return undefined as T;
    },
    async write() {},
  });
  await node.publish({ ...localRuntime(true), id, name: "Desktop", numericId: "123456",
    bio: "", color: "#123456", avatar: "🐦", device: "Linux", clientType: "desktop" });
  await node.start();
  const send = vi.fn<(message: string) => void>();
  const socket = { readyState: 1, send, close() {} } as unknown as WebSocket;
  central.hook("test", false).session(socket);
  const peer = { id: crypto.randomUUID(), numericId: "654321", name: "Browser", clientType: "web", capabilities: [CAP.web, CAP.webtransport] };
  const receive = (packet: unknown) => socket.onmessage!(new MessageEvent("message", { data: JSON.stringify(packet) }));
  const signal = (addresses: string[]) => JSON.stringify({ type: "signal", to: peer.id, data: { addresses } });
  const addresses = Array.from({ length: 7 }, (_, i) =>
    `/ip4/192.168.1.${i + 1}/udp/1234/quic-v1/webtransport/certhash/uEiDOGUDrvzJr74nMaV5Dj_fKywOdmJD7uYoCZYtso-h4XQ`);
  const listen = (addresses: string[]) => onEvent!({ type: "addresses", addresses, id });
  vi.useFakeTimers();
  try {
    listen(addresses.slice(0, 2));
    receive({ type: "peer_joined", peer });
    await vi.advanceTimersByTimeAsync(80);
    listen(addresses);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    listen([...addresses].reverse().concat("/ip4/192.168.1.1/tcp/1234"));
    receive({ type: "peer_updated", peer });
    await vi.advanceTimersByTimeAsync(100);
    expect(send.mock.calls).toEqual([[signal(addresses)]]);

    listen([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(send.mock.calls).toEqual([[signal(addresses)], [signal([])]]);

    listen(addresses);
    await vi.advanceTimersByTimeAsync(100);
    receive({ type: "peer_left", id: peer.id });
    receive({ type: "peer_joined", peer });
    await vi.advanceTimersByTimeAsync(100);
    expect(send.mock.calls.slice(2)).toEqual([[signal(addresses)], [signal(addresses)]]);

    const backupSend = vi.fn();
    const backup = { readyState: 1, send: backupSend, close() {} } as unknown as WebSocket;
    central.hook("backup", false).session(backup);
    backup.onmessage!(new MessageEvent("message", { data: JSON.stringify({ type: "peer_joined", peer }) }));
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(4);
    expect(backupSend).not.toHaveBeenCalled();
    socket.onclose!(new Event("close") as CloseEvent);
    await vi.advanceTimersByTimeAsync(100);
    expect(backupSend.mock.calls).toEqual([[signal(addresses)]]);
  } finally {
    await node.stop();
    vi.useRealTimers();
  }
});
