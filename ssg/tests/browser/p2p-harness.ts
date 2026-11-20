import { localMessageSize } from "../../src/core/network/libp2p/rtc-limits";
import { DesktopStorageAdapter } from "../../src/core/storage/desktop";
import { ChatEngine } from "../../src/core/engine";
import { IndexedDBStorageAdapter } from "../../src/core/storage";
import { identityFor } from "../../src/core/network/libp2p/identity";
import { browserNetwork } from "../../src/core/network";
import { desktopNetwork } from "../../src/core/network/desktop";
import { defaultSettings } from "../../src/core/network/settings";
import { configuredRuntime } from "../../src/core/capabilities";
import { decodeNativeEvent, type P2pBridge } from "../../src/core/network/libp2p/native";
import { priorityControl } from "../../src/core/network/sendQueue";

const host = window as unknown as {
  engine: ChatEngine;
  start: (name: string, kind: string, mode: string) => Promise<void>;
  render: () => Promise<void>;
  events: unknown[];
  priorityControl: typeof priorityControl;
};
host.events = [];
host.render = async () => {
  const [{ App }, { createRoot }, { createElement }, { HashRouter }] = await Promise.all([
    import("../../src/App"), import("react-dom/client"), import("react"), import("react-router"),
  ]);
  await import("../../src/styles.css");
  await import("../../src/themes.css");
  const root = document.createElement("div"); document.body.append(root);
  createRoot(root).render(createElement(HashRouter, null, createElement(App, { engine: host.engine })));
};
host.priorityControl = priorityControl;
host.start = async (name, kind, mode) => {
  const fullNative = kind === "desktop";
  const native = kind === "native" || fullNative,
    settings = defaultSettings(native),
    store = new IndexedDBStorageAdapter();
  settings.servers[0] = {
    ...settings.servers[0],
    url:
      new URLSearchParams(location.search).get("server") ??
      `ws://${location.host}/api/ws`,
    relay: ["relay", "mixed"].includes(mode),
    relaySupported: true,
    authorization: new URLSearchParams(location.search).get("authorization") ?? undefined,
  };
  settings.iceServers = [];
  settings.transport.webrtc = ["rtc", "turn", "mixed", "fallback", "mdns-rtc", "webtransport-rtc"].includes(mode)
    || (mode === "webtransport" && !native);
  settings.transport.tcp = ["native", "tcp", "quic", "fallback", "webtransport", "webtransport-rtc"].includes(mode);
  settings.discovery.mdns = mode.startsWith("mdns");
  if (mode.startsWith("mdns")) {
    settings.discovery.signaling = false;
    settings.transport.tcp = true;
  }
  if (mode === "turn")
    settings.iceServers = [
      {
        urls: fullNative || new URLSearchParams(location.search).has("nativeTurn") ? "turn:127.0.0.1:3479?transport=udp" : "turn:127.0.0.1:3478?transport=udp",
        username: "test",
        credential: "test-password",
        enabled: true,
        name: "test",
      },
    ];
  const identity = identityFor(store),
    id = (await identity).id;
  let storage: import("../../src/core/types").StorageAdapter = store;
  let bridge: P2pBridge | undefined;
  if (native) {
    const ws = new WebSocket("ws://127.0.0.1:4320");
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    let sequence = 0,
      handler: Parameters<P2pBridge["request"]>[2];
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const decoded = decodeNativeEvent(event.data);
        if (fullNative) host.events.push({ type: "payloadIPC", kind: decoded.type, frameKind: decoded.kind });
        handler?.(decoded);
        return;
      }
      const value = JSON.parse(event.data);
      if (value.event) {
        host.events.push(value.event);
        handler?.(value.event);
      } else {
        const item = pending.get(value.id);
        pending.delete(value.id);
        if (value.error) item?.reject(new Error(value.error));
        else item?.resolve(value.result);
      }
    };
    const call = <T>(request: Record<string, unknown>, data?: ArrayBuffer) =>
      new Promise<T>((resolve, reject) => {
        if (request.op === "register")
          host.events.push({
            type: "registered",
            addresses: request.addresses,
          });
        const id = ++sequence;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        const header = JSON.stringify({ ...request, rpcId: id });
        if (data) {
          const json = new TextEncoder().encode(header);
          const frame = new Uint8Array(4 + json.length + data.byteLength);
          new DataView(frame.buffer).setUint32(0, json.length);
          frame.set(json, 4);
          frame.set(new Uint8Array(data), 4 + json.length);
          ws.send(frame);
        } else ws.send(header);
      });
    if (fullNative) storage = new DesktopStorageAdapter(async <T>(request: Record<string, unknown>): Promise<T> => {
      if (request.op === "read") return new Uint8Array(await call<number[]>({ op: "storage_read", key: request.id, offset: request.offset, length: request.length })).buffer as T;
      if (request.op === "write") return call({ op: "storage_write", token: request.token }, request.data as ArrayBuffer);
      return call({ op: "storage", request });
    });
    bridge = {
      nativeIO: fullNative,
      request: (_session, request, onEvent) => {
        if (onEvent) handler = onEvent;
        // These mDNS fixtures run both desktops on the same host.
        if (request.op === "start" && settings.discovery.mdns) request.announceLoopback = true;
        if (request.op === "register" && ["tcp", "quic"].includes(mode))
          request.addresses = (request.addresses as string[]).filter((a) =>
            a.includes(mode === "tcp" ? "/tcp/" : "/quic-v1"),
          );
        if (request.op === "register" && mode === "fallback") {
          request.addresses = ["/ip4/127.0.0.1/tcp/1", ...(request.addresses as string[]).filter(a => a.includes("/webrtc"))];
        }
        return call(request);
      },
      write: (_session, data, headers) =>
        call({ op: "write", headers }, data),
    };
  }
  const network = native
    ? desktopNetwork(bridge, settings, identity)
    : browserNetwork(settings, identity);
  const profile = {
    ...configuredRuntime(native, settings),
    id,
    name,
    numericId: name === "A" ? "123456" : "234567",
    bio: "",
    avatar: "🌿",
    color: "#597461",
    device: "Linux" as const,
    clientType: native ? ("desktop" as const) : ("web" as const),
    revision: 1, maxMessageSize: await localMessageSize(native),
  };
  await storage.saveProfile(profile);
  host.engine = new ChatEngine(storage, profile, [], network);
  host.engine.start();
};
