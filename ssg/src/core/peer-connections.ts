import { CONNECTION_CONFIG, MAX_FILE_CHUNK_BYTES, SIGNALING_CONFIG } from "../config";
import { runtimeLog } from "../runtime-logs";
import { CAP, commonCapabilities, CompatibilityError, isRuntimeInfo, requirePeer, type RuntimeInfo } from "./capabilities";
import type { DeviceDiscovery } from "./discovery";
import type { ChatHistory } from "./history";
import { priorityControl, transferId } from "./network/sendQueue";
import type { TransportAdapter, TransportChannel, TransportConnection } from "./network/types";
import { HEADER_SIZE, newId, MAX_CONTROL_BYTES, parseControlPacket } from "./protocol";
import { errorMessage } from "./transfers/io";
import type { TransferService } from "./transfers/service";
import type { TransferLink } from "./transfers/types";
import type { ChatSnapshot, Profile } from "./types";

interface ConnectionHost {
  readonly transport: TransportAdapter;
  readonly snapshot: ChatSnapshot;
  readonly running: boolean;
  readonly discovery: DeviceDiscovery;
  readonly history: ChatHistory;
  readonly transfers: TransferService;
  getRuntimeInfo(): RuntimeInfo;
  peerProfile(peerId: string): Profile | undefined;
  patch(values: Partial<ChatSnapshot>): void;
  showError(error: unknown): void;
}
type Timer = ReturnType<typeof setTimeout>;
type PeerLink = TransferLink & {
  connection: TransportConnection;
  openedAt?: number;
  receiveQueues?: Map<string, Promise<void>>;
  disconnectTimer?: Timer;
  queuedPackets: number;
  queuedBytes?: number;
  createdAt: number;
  lastProbeSuccessAt?: number;
  revisionTimer?: ReturnType<typeof setTimeout>;
  lastReceivedAt?: number;
  roundTripMs?: number;
  receiptsChecked?: boolean;
  lastProbeAt?: number;
  probeLogAt?: number;
  lastRemoteProbe?: string;
  lastAnsweredLogAt?: number;
  successfulProbes?: number;
  probe?: { requestId: string; sentAt: number; deadline: number; controller: AbortController };
};

export class PeerConnections {
  readonly links = new Map<string, PeerLink>();
  private readonly discoveredPeers = new Map<string, Profile>();
  // A new connection must wait for the previous connection's in-flight disk write.
  private fileReceiveQueues = new Map<string, Promise<void>>();
  private peerHeartbeat?: ReturnType<typeof setInterval>;
  private peerTickAt = Date.now();
  private peerCheckAt = new Map<string, number>();
  private rejoinedPeers = new Set<string>();
  private peerRetries = new Map<string, { attempt: number; at: number }>();
  private peerMisses = new Map<string, number>();
  private readonly lastOnline = new Map<string, number>();
  private readonly evictedUntil = new Map<string, number>();
  private readonly closing = new Map<string, Promise<void>>();
  private queuedReceiveBytes = 0;
  private queuedReceivePackets = 0;

  constructor(private readonly host: ConnectionHost) {}

  /** Insert a local storage change between ordered file frames, also across reconnects. */
  withFileLane(peerId: string, id: string, action: () => Promise<void>) {
    const key = peerId + ":file:" + id;
    const next = (this.fileReceiveQueues.get(key) ?? Promise.resolve()).then(action);
    const tail: Promise<void> = next.catch(() => {}).finally(() => {
      if (this.fileReceiveQueues.get(key) === tail) this.fileReceiveQueues.delete(key);
    });
    this.fileReceiveQueues.set(key, tail);
    return next;
  }
  isDiscovered(peerId: string) {
    return this.discoveredPeers.has(peerId);
  }
  peerJoined(peerId: string) {
    this.lastOnline.set(peerId, Date.now());
    if (this.host.snapshot.peerPresence[peerId] !== "offline" || this.rejoinedPeers.has(peerId)) return;
    this.rejoinedPeers.add(peerId);
    this.peerCheckAt.set(peerId, Date.now());
    this.peerRetries.delete(peerId);
  }
  private slowProbe(peerId: string) {
    return this.host.snapshot.peerPresence[peerId] === "offline" &&
      peerId !== this.host.snapshot.activePeerId && !this.rejoinedPeers.has(peerId) &&
      !this.host.transfers.isBusy(peerId);
  }
  private probeInterval(peerId: string) {
    if (peerId === this.host.snapshot.activePeerId) return CONNECTION_CONFIG.peerHeartbeatIntervalMs;
    return this.slowProbe(peerId) ? CONNECTION_CONFIG.offlineHeartbeatIntervalMs : CONNECTION_CONFIG.listHeartbeatIntervalMs;
  }
  retryAt(peerId: string) {
    return this.peerRetries.get(peerId)?.at ?? 0;
  }
  start() {
    this.peerTickAt = Date.now();
    this.peerHeartbeat = setInterval(() => this.checkPeers(), 1000);
  }
  stop() {
    clearInterval(this.peerHeartbeat);
    this.rejoinedPeers.clear();
    this.peerRetries.clear();
    this.peerMisses.clear();
    this.evictedUntil.clear();
  }
  disconnect(preserveConnections: boolean) {
    if (!preserveConnections) {
      this.discoveredPeers.clear();
      for (const id of new Set([...this.links.keys(),
        ...this.host.transfers.peerIds()]))
        this.closeLink(id, "连接已关闭");
    }
    this.updatePeers([], [], true);
  }
  /** Discovery loss does not revoke an already established content session. */
  updatePeers(peers: Profile[], removed: string[] = [], replaceAll = false) {
    if (replaceAll) this.discoveredPeers.clear();
    for (const id of removed) this.discoveredPeers.delete(id);
    for (const peer of peers) {
      this.discoveredPeers.set(peer.id, peer);
      const link = this.links.get(peer.id);
      if (link) {
        link.profile = peer;
        link.receipts = commonCapabilities(this.host.getRuntimeInfo(), peer).includes(CAP.receipts);
      }
    }
    for (const [id, link] of this.links) {
      if (!this.discoveredPeers.has(id) && link.channel?.readyState !== "open")
        this.closeLink(id, "暂时无法联系对方，请稍后重试", true);
    }
    this.publishPeers();
  }
  private publishPeers() {
    const peers = new Map(this.discoveredPeers);
    for (const link of this.links.values())
      if (link.channel?.readyState === "open" && link.profile && !peers.has(link.peerId))
        peers.set(link.peerId, link.profile);
    // Keep verified display details without using a contact's saved capabilities to dial.
    for (const [id, live] of peers) {
      const saved = this.host.peerProfile(id);
      if (saved && (saved.revision ?? 0) > (live.revision ?? 0)) peers.set(id, saved);
    }
    const peerStates = Object.fromEntries(Object.entries(this.host.snapshot.peerStates)
      .filter(([id]) => peers.has(id)));
    const peerPresence: ChatSnapshot["peerPresence"] = {};
    for (const peer of peers.values()) {
      peerPresence[peer.id] = this.host.snapshot.peerPresence[peer.id] ?? "online";
      if (!this.peerCheckAt.has(peer.id))
        this.peerCheckAt.set(
          peer.id,
          Date.now() + CONNECTION_CONFIG.listHeartbeatIntervalMs,
        );
    }
    for (const id of this.peerCheckAt.keys()) {
      if (!(id in peerPresence)) {
        this.peerCheckAt.delete(id);
        this.evictedUntil.delete(id);
        this.lastOnline.delete(id);
        this.rejoinedPeers.delete(id);
        this.peerRetries.delete(id);
        this.peerMisses.delete(id);
      }
    }
    this.host.patch({ peers: [...peers.values()], peerPresence, peerStates });
  }
  private rank(a: string, b: string) {
    const lastContent = (id: string) => this.host.snapshot.conversations.find(c => c.peer.id === id)?.lastDeliveredAt ?? 0;
    return lastContent(b) - lastContent(a) || (this.lastOnline.get(b) ?? 0) - (this.lastOnline.get(a) ?? 0);
  }
  private trimIdleConnections(now: number) {
    // Pending dials, in-flight transfers and receive queues never consume idle cache entries.
    const idle = [...this.links.values()].filter(link =>
      link.channel?.readyState === "open" && !link.recoveryPending &&
      !this.host.transfers.isBusy(link.peerId) && !link.queuedPackets && !link.channel.bufferedAmount);
    if (idle.length <= CONNECTION_CONFIG.maxRetainedPeers) return;
    const surplus = idle.sort((a, b) => this.rank(a.peerId, b.peerId)).slice(CONNECTION_CONFIG.maxRetainedPeers);
    for (const link of surplus) {
      // An inbound sender may still be exchanging profiles before sending its first frame.
      if (link.probe || now - (link.openedAt ?? now) < CONNECTION_CONFIG.peerHeartbeatTimeoutMs) continue;
      runtimeLog("info", "connection", "连接池释放空闲设备", {peerId: link.peerId, raw: {
        action: "evict-idle", connectionId: link.channel?.physicalConnectionId ?? link.channel?.connectionId,
        reason: "idle-cache-limit", retainedLimit: CONNECTION_CONFIG.maxRetainedPeers }});
      const retryAt = now + CONNECTION_CONFIG.evictionRetryMs;
      this.evictedUntil.set(link.peerId, retryAt);
      this.peerCheckAt.set(link.peerId, retryAt);
      this.closeLink(link.peerId, "暂时没有传输内容");
      this.host.patch({peerStates: Object.fromEntries(Object.entries(this.host.snapshot.peerStates)
        .filter(([id]) => id !== link.peerId))});
    }
  }
  private startLink(link: PeerLink) {
    if (link.channel?.readyState === "open") return;
    const closing = this.closing.get(link.peerId);
    if (!closing) link.connection.start();
    else void closing.then(() => {
      if (this.links.get(link.peerId) === link && link.channel?.readyState !== "open") link.connection.start();
    });
  }
  ensureLink(peerId: string, initiate = true, background = false): PeerLink | undefined {
    const existing = this.links.get(peerId);
    if (existing) {
      if (initiate) this.startLink(existing);
      return existing;
    }
    let link: PeerLink;
    try {
      const remote = this.discoveredPeers.get(peerId);
      if (!remote || !isRuntimeInfo(remote)) throw new CompatibilityError(["peer-unsupported"]);
      requirePeer(this.host.getRuntimeInfo(), remote);
      const connection = this.host.transport.create({
        localId: this.host.snapshot.profile.id,
        peerId,
        capabilities: commonCapabilities(this.host.getRuntimeInfo(), remote),
        sendSignal: (data) => this.host.discovery.sendSignal(peerId, data),
        onChannel: (channel, replace) => {
          if (replace || link.channel?.readyState === "closed") {
            this.host.transfers.suspendTransfers(link.peerId);
            if (link.channel) {
              link.channel.onclose = link.channel.onerror = null;
              link.channel.close();
            }
            link.channel = undefined;
          }
          this.attachChannel(link, channel);
        },
        onState: (state) => {
          if (this.links.get(peerId) !== link) return;
          clearTimeout(link.disconnectTimer);
          if (state === "failed") {
            this.failLink(link, "设备连接已中断");
          }
          else if (state === "disconnected") {
            link.lastProbeSuccessAt = undefined;
            this.host.patch({
              peerStates: {
                ...this.host.snapshot.peerStates,
                [peerId]: "connecting",
              },
            });
            link.disconnectTimer = setTimeout(
              () => {
                this.failLink(link, "设备连接已中断");
              },
              CONNECTION_CONFIG.disconnectGraceMs,
            );
          } else if (state === "connected" && link.channel?.readyState === "open")
            this.markPeerConnected(peerId);
        },
        onError: (error) => {
          runtimeLog("error", "connection", "连接处理失败", {
            peerId,
            detail: errorMessage(error),
            raw: error,
          });
          this.failLink(link, errorMessage(error), false);
        },
      });
      link = {
        peerId,
        profile: remote,
        connection,
        receipts: commonCapabilities(this.host.getRuntimeInfo(), remote).includes(CAP.receipts),
        queuedPackets: 0,
        createdAt: Date.now(),
      };
    } catch (error) {
      runtimeLog("warn", "connection", "暂时无法与对方通信", {
        peerId,
        detail: errorMessage(error),
        raw: error,
      });
      if (peerId === this.host.snapshot.activePeerId || (!background && error instanceof CompatibilityError)) this.host.showError(error);
      this.host.patch({
        peerPresence: error instanceof CompatibilityError ? this.host.snapshot.peerPresence : { ...this.host.snapshot.peerPresence, [peerId]: "offline" },
        peerStates: { ...this.host.snapshot.peerStates, [peerId]: "failed" },
      });
      this.schedulePeerRetry(peerId);
      return;
    }
    runtimeLog("info", "connection", "正在连接对方", {
      peerId,
      detail: this.host.transport.name,
      raw: { trigger: !initiate ? "inbound" : this.host.transfers.isBusy(peerId) ? "content" : background ? "list" : "focus" },
    });
    this.links.set(peerId, link);
    this.host.patch({
      peerStates: { ...this.host.snapshot.peerStates, [peerId]: "connecting" },
    });
    if (link.connection.channel)
      this.attachChannel(link, link.connection.channel);
    if (initiate) this.startLink(link);
    return link;
  }
  private attachChannel(link: PeerLink, channel: TransportChannel) {
    if (link.channel && link.channel !== channel) {
      channel.close();
      return;
    }
    link.channel = channel;
    channel.onpinganswered = (receivedAt, requestId) => {
      const age = Date.now() - receivedAt;
      if (this.links.get(link.peerId) === link && link.channel === channel && channel.readyState === "open" &&
          Number.isFinite(age) && age >= 0 && age < CONNECTION_CONFIG.peerHeartbeatTimeoutMs &&
          receivedAt >= (link.lastProbeSuccessAt ?? link.createdAt)) {
        link.lastRemoteProbe = requestId;
        if (!link.lastAnsweredLogAt || receivedAt - link.lastAnsweredLogAt >= 60_000 || link.recoveryPending) {
          link.lastAnsweredLogAt = receivedAt;
          runtimeLog("debug", "heartbeat", "已应答设备探测", {peerId: link.peerId,
            raw: {requestId, receivedAt, connectionId: channel.physicalConnectionId ?? channel.connectionId}});
        }
        this.checkedRevision(link, receivedAt);
        this.receivedFromPeer(link, receivedAt);
      }
    };
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = CONNECTION_CONFIG.sendBufferLowBytes;
    channel.onopen = () => {
      if (this.links.get(link.peerId) !== link || link.channel !== channel)
        return;
      link.openedAt = Date.now();
      runtimeLog("info", "connection", "通道已打开", {
        peerId: link.peerId,
        raw: { connectionId: channel.connectionId, readyElapsedMs: Date.now() - link.createdAt },
      });
      link.lastProbeSuccessAt = undefined;
      link.lastReceivedAt = undefined;
      link.lastProbeAt = undefined;
      link.probe?.controller.abort();
      link.probe = undefined;
      link.recoveryPending = false;
      clearTimeout(link.disconnectTimer);
      this.markPeerConnected(link.peerId);
      this.probePeer(link);
    };
    channel.onfileprogress = event => this.host.transfers.handleProgress(link, event);
    channel.onmessage = (event) => {
      if (this.links.get(link.peerId) !== link || link.channel !== channel)
        return;
      const bytes =
        typeof event.data === "string"
          ? new TextEncoder().encode(event.data).byteLength
          : event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : 0;
      if (
        !bytes ||
        (typeof event.data === "string"
          ? bytes > MAX_CONTROL_BYTES
          : bytes > MAX_FILE_CHUNK_BYTES + HEADER_SIZE)
      ) {
        event.consumed?.();
        return;
      }
      if (typeof event.data === "string" && parseControlPacket(event.data)) {
        this.receivedFromPeer(link);
      }
      // A peer can keep sending while IndexedDB is busy. Bound that async backlog independently of transfer reservations.
      if (
        this.queuedReceiveBytes + bytes >
          CONNECTION_CONFIG.maxReceiveQueueBytes ||
        link.queuedPackets >= CONNECTION_CONFIG.maxReceiveQueuePackets ||
        this.queuedReceivePackets >=
          CONNECTION_CONFIG.maxTotalReceiveQueuePackets
      ) {
        this.failLink(link, "接收数据过快，连接已暂停，请重新发送");
        return;
      }
      link.queuedPackets++;
      link.queuedBytes = (link.queuedBytes ?? 0) + bytes;
      this.queuedReceiveBytes += bytes;
      this.queuedReceivePackets++;
      const historyRevision = this.host.history.revision;
      const peerRevision = this.host.history.peerRevisions.get(link.peerId) || 0;
      // Credit means admission into this bounded queue, not durable completion.
      // File order is per transfer; independent controls never wait for disk I/O.
      const raw = event.data as string | ArrayBuffer;
      const id = transferId(raw) ?? "invalid";
      const independent = priorityControl(raw);
      const releaseEarly = independent || (link.queuedBytes <= CONNECTION_CONFIG.sendBufferHighBytes &&
        this.queuedReceiveBytes <= CONNECTION_CONFIG.maxReceiveQueueBytes / 4);
      const release = event.consumed ?? (() => {});
      const key = `${independent ? "control" : "file"}:${id}`;
      const queues: Map<string, Promise<void>> = independent
        ? (link.receiveQueues ??= new Map<string, Promise<void>>()) : this.fileReceiveQueues;
      const queueKey = `${link.peerId}:${key}`;
      const task: Promise<void> = (queues.get(queueKey) ?? Promise.resolve())
        .then(() => {
          if (this.host.history.revision !== historyRevision ||
              (this.host.history.peerRevisions.get(link.peerId) || 0) !== peerRevision ||
              this.links.get(link.peerId) !== link ||
              link.channel !== channel ||
              (!independent && link.cancelledTransfers?.has(id))) return;
          return this.host.transfers.handleData(link, raw);
        })
        .catch((error) => this.host.showError(error))
        .finally(() => {
          link.queuedPackets--;
          link.queuedBytes = Math.max(0, (link.queuedBytes ?? 0) - bytes);
          this.queuedReceiveBytes -= bytes;
          this.queuedReceivePackets--;
          if (queues.get(queueKey) === task) queues.delete(queueKey);
          if (!releaseEarly) release();
        });
      queues.set(queueKey, task);
      if (releaseEarly) release();
    };
    channel.onerror = () => {
      if (link.channel === channel)
        this.failLink(link, "传输遇到问题，请重新发送");
    };
    channel.onclose = () => {
      if (this.links.get(link.peerId) === link && link.channel === channel)
        this.failLink(link, "连接已断开，请重新发送");
    };
    if (channel.readyState === "open") channel.onopen(new Event("open"));
  }
  private schedulePeerRetry(peerId: string) {
    this.rejoinedPeers.delete(peerId);
    // Only background polling observes this deadline. Sends and transfer recovery can dial sooner.
    if (this.host.snapshot.peerPresence[peerId] === "offline" && this.isDiscovered(peerId))
      this.peerCheckAt.set(peerId, Date.now() + CONNECTION_CONFIG.offlineHeartbeatIntervalMs);
    const attempt = (this.peerRetries.get(peerId)?.attempt || 0) + 1;
    const delay = Math.max(
      peerId === this.host.snapshot.activePeerId
        ? 0
        : CONNECTION_CONFIG.listHeartbeatIntervalMs,
      Math.min(
        1000 * 2 ** Math.min(attempt - 1, 5),
        CONNECTION_CONFIG.peerRetryMaxMs,
      ) *
        (0.8 + Math.random() * 0.2),
    );
    this.peerRetries.set(peerId, {
      attempt,
      at: Date.now() + delay,
    });
  }
  checkPeers(resumed = false) {
    if (!this.host.running) return;
    const now = Date.now();
    const suspended =
      now - this.peerTickAt > CONNECTION_CONFIG.peerHeartbeatIntervalMs * 2;
    this.peerTickAt = now;
    // Time spent suspended is not a completed probe cycle.
    if (resumed || suspended) this.peerMisses.clear();
    for (const link of this.links.values()) {
      if (resumed || suspended) {
        link.probe?.controller.abort();
        link.probe = undefined;
        link.lastProbeSuccessAt = undefined;
        link.lastReceivedAt = undefined;
        link.lastProbeAt = undefined;
        link.recoveryPending = false;
        link.createdAt = now;
        clearTimeout(link.disconnectTimer);
      }
      if (link.channel?.readyState !== "open") {
        if (now - link.createdAt >= CONNECTION_CONFIG.readyTimeoutMs)
          this.failLink(link, "连接等待超时，正在重新尝试");
        continue;
      }
      if (link.probe && now >= link.probe.deadline) {
        const probe = link.probe;
        link.probe?.controller.abort();
        link.probe = undefined;
        if (
          link.lastReceivedAt === undefined ||
          link.lastReceivedAt < probe.sentAt
        ) {
          const misses = Math.min(
            (this.peerMisses.get(link.peerId) || 0) + 1,
            CONNECTION_CONFIG.peerHeartbeatMissLimit,
          );
          this.peerMisses.set(link.peerId, misses);
          this.rejoinedPeers.delete(link.peerId);
          link.recoveryPending = true;
          runtimeLog("debug", "heartbeat", "暂未收到对方响应", {
            peerId: link.peerId,
            raw: { missedCycles: misses, connectionId: link.channel.physicalConnectionId ?? link.channel.connectionId, lastReceivedAt: link.lastReceivedAt, action: "stop-reuse", probe },
          });
          if (
            misses >= CONNECTION_CONFIG.peerHeartbeatMissLimit &&
            this.host.snapshot.peerPresence[link.peerId] !== "offline"
          ) {
            runtimeLog("warn", "heartbeat", "连续多次未收到对方响应，已标记离线", {
              peerId: link.peerId,
              raw: { missedCycles: misses, probe },
            });
            this.host.patch({
              peerPresence: { ...this.host.snapshot.peerPresence, [link.peerId]: "offline" },
            });
          }
        }
      }
      const interval = this.probeInterval(link.peerId);
      if (
        link.recoveryPending &&
        link.queuedPackets === 0 &&
        !this.host.transfers.hasInFlight(link.peerId, link.channel)
      ) {
        // Preserve content's own deadlines while continuing liveness cycles.
        this.failLink(link, "对方暂时没有响应，正在重新连接", false);
      } else if (
        !link.probe &&
        (now - (link.lastProbeSuccessAt ?? link.createdAt) >= 60_000 || this.rejoinedPeers.has(link.peerId) || (
          (link.lastReceivedAt === undefined || now - link.lastReceivedAt >= interval) &&
          (link.lastProbeAt === undefined || now - link.lastProbeAt >= interval)
        ))
      ) {
        this.probePeer(link);
      }
    }
    this.trimIdleConnections(now);
    const peerId = this.host.snapshot.activePeerId;
    if (
      peerId &&
      this.host.snapshot.status === "connected" &&
      this.host.snapshot.peers.some((peer) => peer.id === peerId) &&
      !this.links.has(peerId) && now >= (this.evictedUntil.get(peerId) ?? 0) &&
      now >= (this.peerRetries.get(peerId)?.at || 0)
    ) {
      if (this.ensureLink(peerId)) runtimeLog("info", "connection", "重新尝试连接对方", { peerId });
    }
    if (this.host.snapshot.status !== "connected") return;
    const background = [...this.links.values()].filter(link => link.peerId !== peerId);
    let pending = [...this.links.values()].filter((link) => link.channel?.readyState !== "open").length;
    let offlineDialPending = background.some(link => link.channel?.readyState !== "open" && this.slowProbe(link.peerId));
    const queued = [...this.host.snapshot.peers].sort(
      (a, b) =>
        this.rank(a.id, b.id) || (this.peerCheckAt.get(a.id) || 0) - (this.peerCheckAt.get(b.id) || 0),
    );
    for (const peer of queued) {
      if (pending >= 4) break;
      if (
        peer.id === peerId ||
        this.links.has(peer.id) ||
        now < (this.peerCheckAt.get(peer.id) ?? Infinity) ||
        now < (this.peerRetries.get(peer.id)?.at ?? 0)
      )
        continue;
      const slow = this.slowProbe(peer.id);
      if (slow && offlineDialPending) continue;
      if (this.host.transport.handleBackgroundDial?.(peer.id)) {
        this.peerCheckAt.set(peer.id, now + this.probeInterval(peer.id));
        continue;
      }
      if (!this.ensureLink(peer.id, true, true)) continue;
      this.peerCheckAt.set(peer.id, now + this.probeInterval(peer.id));
      if (slow) offlineDialPending = true;
      pending++;
    }
  }
  private checkedRevision(link: PeerLink, at: number) {
    link.lastProbeSuccessAt = Math.max(link.lastProbeSuccessAt ?? 0, at);
    clearTimeout(link.revisionTimer);
    link.revisionTimer = setTimeout(() => {
      if (this.host.running && this.links.get(link.peerId) === link) this.probePeer(link);
    }, Math.max(0, link.lastProbeSuccessAt + 60_000 - Date.now()));
  }
  private probePeer(link: PeerLink) {
    const channel = link.channel;
    if (link.probe || channel?.readyState !== "open") return;
    const sentAt = Date.now();
    const controller = new AbortController();
    const probe = { requestId: newId(), sentAt, controller, deadline: sentAt + Math.max(
      channel.probeTimeoutMs ?? CONNECTION_CONFIG.peerHeartbeatTimeoutMs,
      Math.min(30_000, (link.roundTripMs ?? 0) * 4),
    ) };
    link.lastProbeAt = sentAt;
    link.probe = probe;
    const logCycle = !link.probeLogAt || sentAt - link.probeLogAt >= 60_000 || link.recoveryPending;
    if (logCycle) runtimeLog("debug", "heartbeat", "检查对方是否可通信", {
      peerId: link.peerId,
      raw: { connectionId: channel.physicalConnectionId ?? channel.connectionId, requestId: probe.requestId, sentAt, deadline: probe.deadline, transport: this.host.transport.name },
    });
    const current = () => this.links.get(link.peerId) === link && link.channel === channel &&
      channel.readyState === "open" && link.probe === probe && !controller.signal.aborted;
    let result: ReturnType<TransportChannel["probe"]>;
    try { result = channel.probe(controller.signal, probe.requestId); }
    catch { probe.deadline = sentAt; return; }
    void result.then(({ roundTripMs, ageMs }) => {
      if (!current() || Date.now() >= probe.deadline) return;
      if (!Number.isFinite(roundTripMs) || roundTripMs < 0 || !Number.isFinite(ageMs) || ageMs < 0 ||
          ageMs >= CONNECTION_CONFIG.peerHeartbeatTimeoutMs) throw new Error("设备响应无效");
      link.roundTripMs = link.roundTripMs === undefined ? roundTripMs : 0.8 * link.roundTripMs + 0.2 * roundTripMs;
      const checkedAt = Date.now() - ageMs;
      this.checkedRevision(link, checkedAt);
      link.probe = undefined;
      this.receivedFromPeer(link, checkedAt);
      link.successfulProbes = (link.successfulProbes ?? 0) + 1;
      if (logCycle) {
        link.probeLogAt = sentAt;
        runtimeLog("debug", "heartbeat", "对方已响应", {
        peerId: link.peerId, detail: `${Math.round(roundTripMs)} ms`, raw: { roundTripMs, ageMs, requestId: probe.requestId, connectionId: channel.physicalConnectionId ?? channel.connectionId, successfulProbes: link.successfulProbes },
        });
        link.successfulProbes = 0;
      }
    }).catch(error => {
      if (current()) runtimeLog("debug", "heartbeat", "存活探测失败", {peerId: link.peerId,
        raw: {connectionId: channel.physicalConnectionId ?? channel.connectionId, requestId: probe.requestId, sentAt, deadline: probe.deadline,
          lastReceivedAt: link.lastReceivedAt, missedCycles: this.peerMisses.get(link.peerId) ?? 0, error}});
      // Count one failed cycle in checkPeers; content keeps its own deadlines.
      if (current()) probe.deadline = Math.min(probe.deadline, Date.now());
    });
  }
  receivedFromPeer(link: PeerLink, observedAt = Date.now()) {
    this.lastOnline.set(link.peerId, observedAt);
    link.lastReceivedAt = Math.max(link.lastReceivedAt ?? 0, observedAt);
    link.recoveryPending = false;
    clearTimeout(link.disconnectTimer);
    this.peerRetries.delete(link.peerId);
    this.rejoinedPeers.delete(link.peerId);
    this.peerMisses.delete(link.peerId);
    this.markPeerConnected(link.peerId, true);
    if (link.receipts && !link.receiptsChecked) {
      link.receiptsChecked = true;
      const failed = (this.host.history.cache.get(link.peerId) ?? []).filter((m) =>
        m.senderId === this.host.snapshot.profile.id && m.status === "failed" && !this.host.history.deletedMessages.has(m.id)).slice(-20);
      for (const message of failed) this.host.transfers.queryReceipt(link, message.id);
    }
  }
  private markPeerConnected(peerId: string, confirmed = false) {
    // Opening a replacement channel permits sending, but does not prove liveness.
    const presence = confirmed ? "online" : this.host.snapshot.peerPresence[peerId] ?? "online";
    if (
      this.host.snapshot.peerStates[peerId] !== "connected" ||
      this.host.snapshot.peerPresence[peerId] !== presence
    ) {
      this.host.patch({
        peerPresence: {
          ...this.host.snapshot.peerPresence,
          [peerId]: presence,
        },
        peerStates: { ...this.host.snapshot.peerStates, [peerId]: "connected" },
      });
    }
  }
  failLink(link: PeerLink, reason: string, offline = true) {
    if (this.links.get(link.peerId) !== link) return;
    const eventId = runtimeLog("warn", "connection", "暂时无法与对方通信", {
      peerId: link.peerId,
      detail: reason,
      raw: {
        reason,
        channelState: link.channel?.readyState,
        connectionId: link.channel?.physicalConnectionId ?? link.channel?.connectionId, channelId: link.channel?.connectionId, causeEventId: link.channel?.causeEventId,
        lastProbeSuccessAt: link.lastProbeSuccessAt, lastRemoteProbeId: link.lastRemoteProbe, action: "close-link", probe: link.probe,
      },
    });
    if (link.channel) link.channel.causeEventId ??= eventId;
    this.closeLink(link.peerId, reason, true);
    this.host.patch({
      ...(offline
        ? {
            peerPresence: {
              ...this.host.snapshot.peerPresence,
              [link.peerId]: "offline" as const,
            },
          }
        : {}),
      peerStates: {
        ...this.host.snapshot.peerStates,
        [link.peerId]: offline ? "failed" : "connecting",
      },
    });
    this.schedulePeerRetry(link.peerId);
  }
  private closeLink(peerId: string, reason: string, recover = false) {
    const link = this.links.get(peerId);
    if (link?.channel && !link.channel.causeEventId)
      link.channel.causeEventId = runtimeLog("info", "connection", "关闭业务通道", {peerId,
        raw: {reason, origin: "local", expected: !recover, action: recover ? "close-link" : "retire-peer",
          connectionId: link.channel.physicalConnectionId ?? link.channel.connectionId}});
    if (recover) this.host.transfers.suspendTransfers(peerId);
    this.links.delete(peerId);
    if (link) {
      clearTimeout(link.revisionTimer);
      clearTimeout(link.disconnectTimer);
      link.probe?.controller.abort();
      const done = link.connection.close(!recover);
      if (done) {
        const closing = done.catch(() => {});
        this.closing.set(peerId, closing);
        void closing.then(() => { if (this.closing.get(peerId) === closing) this.closing.delete(peerId); });
      }
      link.channel?.close();
    }
    this.host.transfers.disconnected(peerId, reason, recover);
    if (!this.discoveredPeers.has(peerId)) this.publishPeers();
  }
  async readyChannel(
    peerId: string,
  ): Promise<{ link: PeerLink; channel: TransportChannel }> {
    if (this.host.snapshot.availability === "offline")
      throw new Error("你已离线，请先上线再发送");
    const existing = this.links.get(peerId);
    if (!existing?.recoveryPending && existing?.channel?.readyState === "open") {
      requirePeer(this.host.getRuntimeInfo(), existing.profile);
      return { link: existing, channel: existing.channel };
    }
    const discoveryDeadline = Date.now() + SIGNALING_CONFIG.openTimeoutMs;
    while (
      this.host.snapshot.status === "connecting" &&
      !this.host.snapshot.peers.some((p) => p.id === peerId) &&
      Date.now() < discoveryDeadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, CONNECTION_CONFIG.pollIntervalMs),
      );
    }
    if (!this.host.snapshot.peers.some((p) => p.id === peerId)) {
      const peer = this.host.peerProfile(peerId);
      if (!peer?.numericId) throw new Error("对方当前离线，消息未发送");
      await this.host.discovery.restorePeer(peer);
    }
    // Keep the existing same-peer recovery boundary while an old transfer drains.
    while (this.links.get(peerId)?.recoveryPending) {
      if (!this.host.running || !this.host.transfers.hasActive(peerId)) throw new Error("发送已取消");
      await new Promise(resolve => setTimeout(resolve, CONNECTION_CONFIG.pollIntervalMs));
    }
    const advertised = this.discoveredPeers.get(peerId);
    if (advertised) requirePeer(this.host.getRuntimeInfo(), advertised);
    const link = this.ensureLink(peerId, true, peerId !== this.host.snapshot.activePeerId);
    if (!link) throw new Error("无法建立设备连接");
    // Share the transport's actual start time with checkPeers, independent of lookup latency.
    const deadline = link.createdAt + CONNECTION_CONFIG.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (this.links.get(peerId) !== link) throw new Error("设备连接已断开");
      if (link.channel?.readyState === "open" && !link.recoveryPending)
        return { link, channel: link.channel };
      await new Promise((resolve) =>
        setTimeout(resolve, CONNECTION_CONFIG.pollIntervalMs),
      );
    }
    const reason =
      "暂时连不上对方，请确认双方连接同一网络，并保持页面打开后重试。";
    this.failLink(link, reason);
    throw new Error(reason);
  }


  focus(peer: Profile) {
    if (this.host.snapshot.peers.some((p) => p.id === peer.id)) {
      const link = this.ensureLink(peer.id);
      if (link?.channel?.readyState === "open" &&
          (link.lastReceivedAt === undefined || Date.now() - link.lastReceivedAt >= CONNECTION_CONFIG.peerHeartbeatIntervalMs))
        this.probePeer(link);
    }
    if (
      peer.numericId &&
      this.host.snapshot.status === "connected" &&
      !this.host.snapshot.peers.some((p) => p.id === peer.id)
    )
      void this.host.discovery.restorePeer(peer).catch(() => undefined);
  }
}
