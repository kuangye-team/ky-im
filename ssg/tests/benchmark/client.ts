import { ChatEngine } from "../../src/core/engine";
import { IndexedDBStorageAdapter } from "../../src/core/storage";
import { createDesktopStorage } from "../../src/core/storage/desktop";
import { browserNetwork } from "../../src/core/network";
import { desktopNetwork } from "../../src/core/network/desktop";
import { identityFor } from "../../src/core/network/libp2p/identity";
import { defaultSettings } from "../../src/core/network/settings";
import { configuredRuntime } from "../../src/core/capabilities";
import { transferMetrics as metrics } from "../../src/core/transferMetrics";
import { localMessageSize } from "../../src/core/network/libp2p/rtc-limits";
import { setFileDiagnostics } from "../../src/core/transfers/diagnostics";
import { getRuntimeLogs } from "../../src/runtime-logs";
import { newId } from "../../src/core/protocol";
import { desktopSources } from "../../src/components/desktopSources";
import type { AttachmentSource, StorageAdapter } from "../../src/core/types";

const query = new URLSearchParams(location.search);
const native = "__TAURI_INTERNALS__" in window;
let engine: ChatEngine, store: StorageAdapter, source: AttachmentSource;
let closed = 0;
let samples: { at: number; bytes: number }[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let latestName = "";
let measureStages = true;
let directRtc = false;
const status = (value: string) => { document.querySelector("#status")!.textContent = value; };
const until = async (ready: () => boolean | Promise<boolean>, timeout = 30000, interval = 20) => {
  const end = performance.now() + timeout;
  while (!await ready()) {
    if (performance.now() > end) throw new Error("Condition timed out");
    await new Promise(resolve => setTimeout(resolve, interval));
  }
};
function transport(): any { return (engine as any).network.transport; }
async function nativeMetrics(reset = false) {
  return native ? transport().call({ op: "metrics", enabled: measureStages, reset }) : undefined;
}
async function routes() {
  const t = transport(), central = t.central ?? t.bridge;
  const rtc = [];
  for (const session of central.rtc.values()) {
    const state = session.pc.connectionState;
    const report: RTCStatsReport = await session.pc.getStats();
    const rtcSliceBytes = session.sample?.()?.rtcSliceBytes;
    const rtcFileChunkBytes = session.bulk.filePayloadBytes;
    const bulkSent = session.bulk.sentBytes, bulkReceived = session.bulk.receivedBytes;
    const items = [...report.values()];
    const active = items.find((v: any) => v.type === "transport" && v.selectedCandidatePairId);
    const pair = active ? report.get(active.selectedCandidatePairId)
      : items.find((v: any) => v.type === "candidate-pair" && v.nominated && v.state === "succeeded");
    const local = pair && report.get(pair.localCandidateId), remote = pair && report.get(pair.remoteCandidateId);
    rtc.push({ state, rtcSliceBytes, rtcFileChunkBytes, bulkSent, bulkReceived, rttMs: pair?.currentRoundTripTime * 1000,
      local: local && { type: local.candidateType, protocol: local.protocol },
      remote: remote && { type: remote.candidateType, protocol: remote.protocol },
      dataChannels: items.filter((v: any) => v.type === "data-channel") });
  }
  return { rtc, native: t.diagnosticRoutes, web: t.node?.getConnections().map((c: any) => c.remoteAddr.toString()) };
}
const operations: Record<string, (arg: any) => Promise<any>> = {
  async start({ name, mode, diagnostics, stages, macosSendActivity }) {
    setFileDiagnostics(diagnostics === true);
    measureStages = stages !== false;
    directRtc = mode === "rtc";
    metrics.reset(measureStages);
    store = native ? await createDesktopStorage() : new IndexedDBStorageAdapter(`benchmark-${query.get("token")}-${name}`);
    const settings = defaultSettings(native);
    settings.servers = [{ ...settings.servers[0], url: query.get("api")!, enabled: true,
      authorization: "", relay: mode === "relay", relaySupported: mode === "relay" }];
    settings.iceServers = [];
    settings.transport = { tcp: ["tcp", "quic", "webtransport"].includes(mode), webrtc: mode === "rtc" };
    settings.discovery.mdns = false;
    const identity = identityFor(store), id = (await identity).id;
    const network = native ? desktopNetwork(undefined, settings, identity) : browserNetwork(settings, identity);
    if (native && (macosSendActivity !== undefined || ["tcp", "quic"].includes(mode))) {
      const t: any = network.transport, original = t.bridge.request.bind(t.bridge);
      t.bridge.request = (session: string, request: any, handler: any) => {
        if (macosSendActivity !== undefined && request.op === "start") request.macosSendActivity = macosSendActivity;
        if (request.op === "register" && ["tcp", "quic"].includes(mode))
          request.addresses = request.addresses.filter((a: string) => a.includes(mode === "tcp" ? "/tcp/" : "/quic-v1"));
        return original(session, request, handler);
      };
    }
    const profile = { ...configuredRuntime(native, settings), id, name,
      numericId: name === "A" ? "123456" : "234567", bio: "", avatar: "🌿", color: "#597461",
      device: "Linux" as const, clientType: native ? "desktop" as const : "web" as const, revision: 1,
      maxMessageSize: await localMessageSize(native) };
    await store.saveProfile(profile);
    engine = new ChatEngine(store, profile, [], network);
    engine.start();
    status(`${name} · 已准备`);
    return { native, userAgent: navigator.userAgent, storage: store.name };
  },
  async connect() {
    await until(() => engine.getSnapshot().peers.length === 1);
    const peer = engine.getSnapshot().peers[0];
    await engine.selectPeer(peer);
    await engine.updatePeerAutoAcceptFiles(peer.id, true);
    await engine.sendText("ready");
    if (directRtc) {
      // A short file can finish before the browser publishes the first nominated pair.
      await until(async () => (await routes()).rtc.some(session => session.state === "connected" &&
        session.local?.type === "host" && session.remote?.type === "host"), 10000, 150);
    }
    transport().channels.get(peer.id).addEventListener("close", () => closed++);
    return routes();
  },
  async prepare({ size, diskSource }) {
    if (diskSource) {
      const file = native ? (await desktopSources([diskSource])).files[0]
        : document.querySelector<HTMLInputElement>("#source")?.files?.[0];
      if (file?.size !== size) throw new Error("Disk fixture size mismatch");
      source = file;
      return { size };
    }
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    const file = new File([bytes], "source.bin");
    if (native) {
      const id = newId();
      await store.saveAttachment(id, file);
      source = (await store.getAttachmentSource!(id))!;
    } else source = file;
    return { size };
  },
  async reset({ name }) {
    latestName = name;
    closed = 0;
    samples = [];
    clearInterval(timer);
    await nativeMetrics(true);
    metrics.reset(measureStages);
    let last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      metrics.record("eventLoop.lag", 0, Math.max(0, now - last - 100));
      last = now;
      const message = engine.getSnapshot().messages.find(m => m.fileName === name);
      if (message) {
        // Transfers are removed after delivery, so never interpret the final zero as progress.
        const bytes = engine.getTransferredBytes(message.id);
        if (bytes) samples.push({ at: now, bytes });
      }
    }, 100);
    status(`正在传输 ${name}`);
  },
  async send({ name }) {
    const file = source instanceof Blob ? new File([source], name) : { ...source, name,
      size: source.size, type: source.type, slice: source.slice.bind(source) };
    const started = performance.now();
    const ok = await engine.transfers.sendFiles([file], engine.getSnapshot().activePeerId);
    if (!ok) throw new Error("Send failed");
    const receiptTimeout = source.size > 256 * 1048576 ? 900000 : 120000;
    await until(() => engine.getSnapshot().messages.find(m => m.fileName === name)?.status === "delivered", receiptTimeout);
    const seconds = (performance.now() - started) / 1000;
    document.querySelector("#result")!.textContent = `已完成：${name}\n文件大小：${(source.size / 1048576).toFixed(2)} MiB\n总耗时：${seconds.toFixed(3)} 秒\n平均速度：${(source.size / 1048576 / seconds).toFixed(2)} MiB/s`;
    status("传输完成");
    return { seconds, size: source.size, MiBps: source.size / 1048576 / seconds };
  },
  async metrics() {
    clearInterval(timer);
    const id = engine.getSnapshot().messages.find(m => m.fileName === latestName)?.id;
    const fileLogs = getRuntimeLogs().filter(e => e.message === "文件传输性能" && e.raw)
      .map(e => ({ ...JSON.parse(e.raw!).diagnostic, loggedUnixMs: e.time })).filter(s => s.transferId === id);
    const connectionLogs = closed ? getRuntimeLogs().filter(e => e.category === "connection" || e.category === "heartbeat") : undefined;
    return { frontend: metrics.snapshot(), native: await nativeMetrics(), routes: await routes(), samples, fileLogs, closed, connectionLogs };
  },
  async verify({ name, size }) {
    await until(() => engine.getSnapshot().messages.find(m => m.fileName === name)?.status === "delivered");
    const message = engine.getSnapshot().messages.find(m => m.fileName === name)!;
    const attachment = store.getAttachmentSource ? await store.getAttachmentSource(message.id) : await store.getAttachment(message.id);
    if (!attachment || attachment.size !== size) throw new Error("Attachment size mismatch");
    for (let offset = 0; offset < size; offset += 2 * 1048576) {
      const end = Math.min(size, offset + 2 * 1048576);
      const block = new Uint8Array(await attachment.slice(offset, end).arrayBuffer());
      if (block.byteLength !== end - offset) throw new Error(`Short read at ${offset}`);
      for (let i = 0; i < block.length; i++) if (block[i] !== (offset + i) % 251) throw new Error(`Content mismatch at ${offset + i}`);
    }
    status("接收完成，内容校验通过");
    return true;
  },
  async cleanup() {
    const messages = engine.getSnapshot().messages.filter(m => m.fileName === latestName);
    await store.deleteMessages(messages.map(m => m.id));
  },
};
const socket = new WebSocket(`ws://${location.host}/control?token=${query.get("token")}&role=${query.get("role")}`);
socket.onopen = () => socket.send(JSON.stringify({ hello: true, native, diskFixture: true, userAgent: navigator.userAgent }));
socket.onmessage = async ({ data }) => {
  const { id, op, arg } = JSON.parse(data);
  try { socket.send(JSON.stringify({ id, result: await operations[op](arg) })); }
  catch (error) {
    const detail = String(error);
    status(detail);
    socket.send(JSON.stringify({ id, error: detail, logs: localStorage.getItem("hummingbird.v2.runtime-logs") }));
  }
};
