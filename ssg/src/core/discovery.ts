import { confirmsActivity } from "./network/signaling";
import { CONNECTION_CONFIG, SIGNALING_CONFIG } from "../config";
import { runtimeLog } from "../runtime-logs";
import { CompatibilityError, isRuntimeInfo, type RuntimeInfo } from "./capabilities";
import { recentNumericIds } from "./device-number";
import { DISCOVERY_OPEN, type DiscoveryAdapter, type DiscoverySession } from "./network/types";
import { isNumericId, isProfile, newId } from "./protocol";
import type { ChatSnapshot, Profile } from "./types";

interface DiscoveryHost {
  readonly snapshot: ChatSnapshot;
  readonly adapter: DiscoveryAdapter;
  readonly running: boolean;
  isDiscovered(peerId: string): boolean;
  peerJoined(peerId: string): void;
  peerProfile(peerId: string): Profile | undefined;
  updatePeers(peers: Profile[], removed?: string[], replaceAll?: boolean): void;
  refreshPeer(peer: Profile): Promise<void>;
  ensureLink(peerId: string): void;
  networkChanged(): void;
  patch(values: Partial<ChatSnapshot>): void;
  showError(error: unknown): void;
  stop(): void;
  getRuntimeInfo(): RuntimeInfo;
}
type Timer = ReturnType<typeof setTimeout>;
type PendingLookup = {
  resolve: (peer: Profile) => void;
  reject: (error: Error) => void;
  timer: Timer;
  expectedPeerId?: string;
};
type PendingGroupLookup = {
  numericId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: Timer;
};

export class DeviceDiscovery {
  private session?: DiscoverySession;
  private reconnectTimer?: Timer;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatProbe?: Timer;
  private discoveryDeadline?: Timer;
  private lastHeartbeatAt = Date.now();
  private welcomedAt?: number;
  private reconnectAttempt = 0;
  private openedAfterNetworkChange = false;
  private lastReceivedAt = Date.now();
  private lookups = new Map<string, PendingLookup>();
  private groupLookups = new Map<string, PendingGroupLookup>();
  private lastRecentNumericIds = "";
  private discoveryQueued = false;
  private restoringPeers = new Map<string, Promise<Profile>>();
  private connectingById = false;
  private readonly runtimeQueries = new Map<string, {
    peerId: string;
    resolve: (info: RuntimeInfo) => void;
    reject: (error: Error) => void;
    timer: Timer;
  }>();

  constructor(private readonly host: DiscoveryHost) {}

  queryPeerRuntime(peerId: string): Promise<RuntimeInfo> {
    if (!this.host.isDiscovered(peerId))
      return Promise.reject(new Error("暂时找不到对方，请确认对方保持页面打开"));
    return new Promise((resolve, reject) => {
      const request = newId();
      const timer = setTimeout(() => {
        this.runtimeQueries.delete(request);
        reject(new Error("对方暂时没有回应，请稍后重试"));
      }, 5000);
      this.runtimeQueries.set(request, { peerId, resolve, reject, timer });
      try {
        this.sendSignal(peerId, { runtimeQuery: request });
      } catch (error) {
        clearTimeout(timer);
        this.runtimeQueries.delete(request);
        reject(error);
      }
    });
  }
  private recentNumbers() {
    return recentNumericIds(
      this.host.snapshot.conversations,
      this.host.snapshot.profile.numericId,
    );
  }
  queueDiscovery() {
    if (this.discoveryQueued) return;
    this.discoveryQueued = true;
    queueMicrotask(() => {
      this.discoveryQueued = false;
      if (
        this.host.snapshot.status !== "connected" ||
        this.session?.readyState !== DISCOVERY_OPEN
      )
        return;
      const numbers = this.recentNumbers();
      const signature = [...numbers].sort().join(",");
      if (signature === this.lastRecentNumericIds) return;
      try {
        this.session.send(
          JSON.stringify({ type: "discover", recentNumericIds: numbers }),
        );
        this.lastRecentNumericIds = signature;
      } catch (error) {
        runtimeLog("warn", "discovery", "最近联系人的查找将在重新连接后继续", {
          detail: String(error),
        });
      }
    });
  }
  disconnect() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.discoveryDeadline);
    this.clearHeartbeatProbe();
    this.welcomedAt = undefined;
    const socket = this.session;
    this.session = undefined;
    socket?.close();
    this.rejectLookups("连接已关闭，请重试");
  }
  recheckNetwork() {
    this.resetBackoff();
    const socket = this.session;
    if (socket?.recheckNetwork) {
      socket.recheckNetwork();
    } else if (socket?.readyState === DISCOVERY_OPEN && this.welcomedAt !== undefined) {
      if (!this.heartbeatProbe) this.probeHeartbeat(socket);
    } else if (!socket || socket.readyState > DISCOVERY_OPEN || !this.openedAfterNetworkChange) {
      // Replace a handshake on the old route once. Further notifications share the new attempt.
      if (socket) this.disconnect();
      this.connect(true);
    }
  }

  resetBackoff() {
    this.reconnectAttempt = 0;
  }
  connect(afterNetworkChange = false) {
    if (!this.host.running || this.host.snapshot.availability === "offline") return;
    clearTimeout(this.reconnectTimer);
    if (
      this.host.adapter.usesBrowserNetworkStatus &&
      typeof navigator !== "undefined" &&
      navigator.onLine === false
    ) {
      this.host.patch({ status: "disconnected" });
      return;
    }
    runtimeLog("info", "discovery", "正在寻找设备");
    this.host.patch({ status: "connecting" });
    let socket: DiscoverySession;
    try {
      socket = this.host.adapter.open();
    } catch (error) {
      this.host.showError(error);
      this.scheduleReconnect();
      return;
    }
    this.session = socket;
    this.openedAfterNetworkChange = afterNetworkChange;
    this.welcomedAt = undefined;
    this.armDiscoveryDeadline(socket, SIGNALING_CONFIG.openTimeoutMs);
    socket.onopen = () => {
      if (this.session !== socket) return;
      this.armDiscoveryDeadline(socket, SIGNALING_CONFIG.joinTimeoutMs);
      this.lastReceivedAt = Date.now();
      this.lastHeartbeatAt = this.lastReceivedAt;
      this.welcomedAt = undefined;
      const numbers = this.recentNumbers();
      socket.send(
        JSON.stringify({
          type: "join",
          room: SIGNALING_CONFIG.room,
          profile: this.host.snapshot.profile,
          recentNumericIds: numbers,
        }),
      );
      this.lastRecentNumericIds = [...numbers].sort().join(",");
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(
        () => this.checkHeartbeat(),
        SIGNALING_CONFIG.heartbeatIntervalMs,
      );
    };
    socket.onactivity = () => { if (this.session === socket) this.receivedTraffic(); };
    socket.onmessage = (event) => {
      if (
        this.session !== socket ||
        typeof event.data !== "string" ||
        event.data.length > SIGNALING_CONFIG.maxMessageChars
      )
        return;
      void this.handleSignal(event.data).catch((error) =>
        this.host.showError(error),
      );
    };
    socket.onerror = (event) => {
      if (this.session !== socket) return;
      if (event && "cause" in event && event.cause instanceof CompatibilityError) { this.host.showError(event.cause); return; }
      const message = event && "message" in event && typeof event.message === "string" ? event.message : undefined;
      runtimeLog("error", "discovery", "设备查找遇到问题", { detail: message });
      this.host.patch({ error: message || "暂时连不上蜂鸟，请检查网络后重试。" });
    };
    socket.onclose = () => this.connectionLost(socket);
  }
  private connectionLost(socket: DiscoverySession) {
    if (this.session !== socket) return;
    runtimeLog("warn", "discovery", "设备查找已断开，准备重试");
    this.session = undefined;
    this.rejectLookups("连接已断开，请稍后重试");
    clearInterval(this.heartbeat);
    clearTimeout(this.discoveryDeadline);
    this.clearHeartbeatProbe();
    this.welcomedAt = undefined;
    this.host.updatePeers([], [], true);
    this.scheduleReconnect();
  }
  private closeUnresponsive(socket: DiscoverySession) {
    // A broken route can leave a WebSocket in CLOSING until the OS times out.
    this.connectionLost(socket);
    socket.close();
  }
  private armDiscoveryDeadline(socket: DiscoverySession, delay: number) {
    clearTimeout(this.discoveryDeadline);
    const deadline = Date.now() + delay;
    this.discoveryDeadline = setTimeout(() => {
      if (this.session !== socket || this.welcomedAt !== undefined) return;
      if (Date.now() - deadline > SIGNALING_CONFIG.heartbeatIntervalMs)
        this.armDiscoveryDeadline(socket, SIGNALING_CONFIG.joinTimeoutMs);
      else this.closeUnresponsive(socket);
    }, delay);
  }
  private clearHeartbeatProbe() {
    clearTimeout(this.heartbeatProbe);
    this.heartbeatProbe = undefined;
  }
  private receivedTraffic() {
    this.lastReceivedAt = Date.now();
    this.clearHeartbeatProbe();
    if (this.welcomedAt !== undefined && this.lastReceivedAt - this.welcomedAt >= SIGNALING_CONFIG.reconnectStableMs)
      this.reconnectAttempt = 0;
  }
  private probeHeartbeat(socket: DiscoverySession) {
    this.clearHeartbeatProbe();
    const deadline = Date.now() + SIGNALING_CONFIG.heartbeatResumeGraceMs;
    this.heartbeatProbe = setTimeout(() => {
      this.heartbeatProbe = undefined;
      if (this.session !== socket) return;
      // The page may have been suspended again while waiting for this probe.
      if (socket.readyState === DISCOVERY_OPEN && Date.now() - deadline > SIGNALING_CONFIG.heartbeatIntervalMs)
        this.probeHeartbeat(socket);
      else this.closeUnresponsive(socket);
    }, SIGNALING_CONFIG.heartbeatResumeGraceMs);
    // Keep the payload exact so Cloudflare can answer without waking the hub.
    try { socket.send('{"type":"ping"}'); }
    catch { this.closeUnresponsive(socket); }
  }
  checkHeartbeat(resumed = false) {
    const socket = this.session;
    if (!socket || socket.readyState !== DISCOVERY_OPEN) return;
    const now = Date.now();
    const delayed =
      now - this.lastHeartbeatAt > SIGNALING_CONFIG.heartbeatIntervalMs * 2;
    this.lastHeartbeatAt = now;
    const idle = now - this.lastReceivedAt;
    if (idle < SIGNALING_CONFIG.heartbeatIntervalMs) return;
    const stale = idle > SIGNALING_CONFIG.heartbeatTimeoutMs;
    if (delayed || (resumed && stale)) {
      if (!this.heartbeatProbe || delayed) this.probeHeartbeat(socket);
      return;
    }
    if (this.heartbeatProbe) return;
    if (stale) this.closeUnresponsive(socket);
    else socket.send(JSON.stringify({ type: "ping" }));
  }
  private scheduleReconnect() {
    if (!this.host.running) return;
    clearTimeout(this.reconnectTimer);
    this.host.patch({ status: "disconnected" });
    const ceiling = Math.min(
      SIGNALING_CONFIG.reconnectInitialDelayMs *
        2 ** Math.min(this.reconnectAttempt++, 16),
      SIGNALING_CONFIG.reconnectMaxDelayMs,
    );
    this.reconnectTimer = setTimeout(
      () => this.connect(),
      ceiling * (0.5 + Math.random() * 0.5),
    );
  }
  sendSignal(to: string, data: unknown) {
    if (this.session?.readyState !== DISCOVERY_OPEN)
      throw new Error("尚未连上蜂鸟，请稍后重试");
    this.session.send(JSON.stringify({ type: "signal", to, data }));
  }
  private rejectLookups(message: string) {
    for (const query of this.runtimeQueries.values()) {
      clearTimeout(query.timer);
      query.reject(new Error("连接已断开，请稍后重试"));
    }
    this.runtimeQueries.clear();
    for (const lookup of this.lookups.values()) {
      clearTimeout(lookup.timer);
      lookup.reject(new Error(message));
    }
    this.lookups.clear();
    for (const lookup of this.groupLookups.values()) {
      clearTimeout(lookup.timer);
      lookup.reject(new Error(message));
    }
    this.groupLookups.clear();
  }
  private async resolveNumericId(numericId: string, expectedPeerId?: string) {
    const deadline = Date.now() + SIGNALING_CONFIG.lookupTimeoutMs;
    while (this.host.snapshot.status === "connecting" && Date.now() < deadline)
      await new Promise((resolve) =>
        setTimeout(resolve, CONNECTION_CONFIG.pollIntervalMs),
      );
    if (
      this.host.snapshot.status !== "connected" ||
      this.session?.readyState !== DISCOVERY_OPEN
    )
      throw new Error("尚未连上蜂鸟，请检查网络后重新连接");
    return new Promise<Profile>((resolve, reject) => {
      const requestId = newId();
      const timer = setTimeout(() => {
        this.lookups.delete(requestId);
        reject(new Error("查找超时，请确认对方在线后重试"));
      }, SIGNALING_CONFIG.lookupTimeoutMs);
      this.lookups.set(requestId, { resolve, reject, timer, expectedPeerId });
      try {
        this.session!.send(
          JSON.stringify({
            type: "connect",
            requestId,
            numericId,
            ...(expectedPeerId ? { expectedPeerId } : {}),
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.lookups.delete(requestId);
        reject(error);
      }
    });
  }
  restorePeer(peer: Profile): Promise<Profile> {
    const existing = this.restoringPeers.get(peer.id);
    if (existing) return existing;
    if (!peer.numericId)
      return Promise.reject(new Error("对方当前离线，消息未发送"));
    const operation = this.resolveNumericId(peer.numericId, peer.id);
    this.restoringPeers.set(peer.id, operation);
    void operation
      .finally(() => {
        if (this.restoringPeers.get(peer.id) === operation)
          this.restoringPeers.delete(peer.id);
      })
      .catch(() => undefined);
    return operation;
  }
  /** Discover a number group without changing our number or selecting a conversation. */
  async connectByNumericId(numericId: string): Promise<void> {
    const value = numericId.trim();
    if (!isNumericId(value))
      throw new Error("请输入 6 位蜂鸟号（首位不能为 0）");
    if (this.connectingById) throw new Error("正在建立连接，请稍候");
    if (this.host.snapshot.availability === "offline")
      throw new Error("你已离线，请先将我的状态切换为在线");
    if (
      this.host.snapshot.status !== "connected" ||
      this.session?.readyState !== DISCOVERY_OPEN
    )
      throw new Error("尚未连上蜂鸟，请检查网络后重新连接");
    this.connectingById = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const requestId = newId();
        const timer = setTimeout(() => {
          this.groupLookups.delete(requestId);
          reject(new Error("查找超时，请确认对方在线后重试"));
        }, SIGNALING_CONFIG.lookupTimeoutMs);
        this.groupLookups.set(requestId, {
          numericId: value,
          resolve,
          reject,
          timer,
        });
        try {
          this.session!.send(
            JSON.stringify({
              type: "connect_group",
              requestId,
              numericId: value,
            }),
          );
        } catch (error) {
          clearTimeout(timer);
          this.groupLookups.delete(requestId);
          reject(error);
        }
      });
    } finally {
      this.connectingById = false;
    }
  }
  private async handleSignal(raw: string) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (confirmsActivity(data)) this.receivedTraffic();
    if (data.type === "network_changed") {
      if (!this.host.adapter.usesBrowserNetworkStatus) this.host.networkChanged();
      return;
    }
    if (data.type === "discovery_updated") {
      if (
        !Array.isArray(data.peers) || !data.peers.every(isProfile) ||
        !Array.isArray(data.removedPeerIds) ||
        !data.removedPeerIds.every((id) => typeof id === "string")
      )
        return;
      const discovered = data.peers.filter((peer) => peer.id !== this.host.snapshot.profile.id);
      this.host.updatePeers(discovered, data.removedPeerIds);
      for (const peer of discovered) this.host.peerJoined(peer.id);
      if (discovered.some((peer) => peer.id === this.host.snapshot.activePeerId))
        this.host.ensureLink(this.host.snapshot.activePeerId!);
      await Promise.all(discovered.map((peer) => this.host.refreshPeer(peer)));
      return;
    }
    if (
      (data.type === "group_resolved" || data.type === "connect_error") &&
      typeof data.requestId === "string" &&
      this.groupLookups.has(data.requestId)
    ) {
      const lookup = this.groupLookups.get(data.requestId)!;
      clearTimeout(lookup.timer);
      this.groupLookups.delete(data.requestId);
      if (data.type === "connect_error") {
        lookup.reject(new Error(this.lookupError(data.code)));
      } else if (
        data.numericId !== lookup.numericId ||
        !Array.isArray(data.peers) ||
        !data.peers.every(
          (peer) => isProfile(peer) && peer.numericId === lookup.numericId,
        )
      ) {
        lookup.reject(new Error("设备列表无效，请重新查找蜂鸟号"));
      } else {
        const peers = (data.peers as Profile[]).filter(
          (peer) => peer.id !== this.host.snapshot.profile.id,
        );
        this.host.updatePeers(peers);
        lookup.resolve();
        for (const peer of peers) await this.host.refreshPeer(peer);
      }
      return;
    }
    if (
      (data.type === "peer_resolved" || data.type === "connect_error") &&
      typeof data.requestId === "string"
    ) {
      const lookup = this.lookups.get(data.requestId);
      if (!lookup) return;
      clearTimeout(lookup.timer);
      this.lookups.delete(data.requestId);
      if (data.type === "connect_error") {
        lookup.reject(new Error(this.lookupError(data.code)));
      } else if (
        !isProfile(data.peer) ||
        data.peer.id === this.host.snapshot.profile.id ||
        (lookup.expectedPeerId && lookup.expectedPeerId !== data.peer.id)
      ) {
        lookup.reject(
          new Error("返回的设备不是原联系人，请向对方确认新的蜂鸟号"),
        );
      } else {
        const peer = data.peer;
        this.host.updatePeers([peer]);
        this.host.ensureLink(peer.id);
        lookup.resolve(peer);
        await this.host.refreshPeer(peer);
      }
      return;
    }
    if (data.type === "pong") return;
    if (data.type === "ping") {
      this.session?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (data.type === "error") {
      runtimeLog("warn", "discovery", "连接服务返回提醒", {
        detail: String(data.code),
      });
      if (data.code === "capability_required") {
        this.host.stop();
        this.host.showError(new CompatibilityError(["local-update"]));
      } else if (data.code === "session_replaced") {
        this.host.stop();
        this.host.patch({
          error:
            "此设备已在另一个标签页打开。请在那个标签页继续，或点击重新连接。",
        });
      } else {
        const messages: Record<string, string> = {
          join_timeout: "连接超时，请检查网络后重新连接",
          idle_timeout: "连接已断开，请重新连接",
          rate_limited: "操作过于频繁，请稍后重试",
          slow_consumer: "连接暂时繁忙，请稍后重试",
          room_full: "当前在线人数较多，请稍后再来",
          room_limit: "蜂鸟暂时繁忙，请稍后重试",
          id_limit: "当前在线人数较多，请稍后再来",
          invalid_profile: "个人资料未能保存，请检查名称和签名后重试",
          peer_unavailable: "暂时找不到对方，请确认对方保持页面打开",
          invalid_target: "请选择另一位联系人开始聊天",
          join_required: "尚未连上蜂鸟，请稍后重试",
        };
        this.host.patch({
          error:
            messages[String(data.code)] || "连接遇到问题，请重新连接后重试",
        });
      }
      return;
    }
    if (data.type === "welcome" && Array.isArray(data.peers)) {
      const peers = data.peers
        .filter(isProfile)
        .filter((peer) => peer.id !== this.host.snapshot.profile.id);
      clearTimeout(this.discoveryDeadline);
      this.welcomedAt = Date.now();
      runtimeLog("info", "discovery", "设备查找已就绪", {
        detail: `peers=${peers.length}`,
      });
      this.host.updatePeers(peers, [], true);
      for (const peer of peers) this.host.peerJoined(peer.id);
      this.host.patch({ status: "connected", error: null });
      if (peers.some((peer) => peer.id === this.host.snapshot.activePeerId))
        this.host.ensureLink(this.host.snapshot.activePeerId!);
      for (const peer of peers) await this.host.refreshPeer(peer);
      const activePeer = this.host.snapshot.activePeerId
        ? this.host.peerProfile(this.host.snapshot.activePeerId)
        : undefined;
      if (
        this.host.snapshot.status === "connected" &&
        activePeer?.numericId &&
        !this.host.snapshot.peers.some((p) => p.id === activePeer.id)
      )
        void this.restorePeer(activePeer).catch(() => undefined);
      return;
    }
    if (
      (data.type === "peer_joined" || data.type === "peer_updated") &&
      isProfile(data.peer) &&
      data.peer.id !== this.host.snapshot.profile.id
    ) {
      const peer = data.peer;
      runtimeLog("info", "discovery", "发现设备", { peerId: peer.id });
      this.host.updatePeers([peer]);
      if (data.type === "peer_joined") this.host.peerJoined(peer.id);
      if (this.host.snapshot.activePeerId === peer.id) this.host.ensureLink(peer.id);
      await this.host.refreshPeer(peer);
      return;
    }
    if (data.type === "peer_left" && typeof data.id === "string") {
      runtimeLog("info", "discovery", "设备已离开", { peerId: data.id });
      this.host.updatePeers([], [data.id]);
      return;
    }
    if (data.type === "signal" && typeof data.from === "string" && this.host.isDiscovered(data.from) && data.data && typeof data.data === "object") {
      const packet = data.data as { runtimeQuery?: unknown; runtimeReply?: unknown; runtime?: unknown };
      if (typeof packet.runtimeQuery === "string") {
        this.sendSignal(data.from, { runtimeReply: packet.runtimeQuery, runtime: this.host.getRuntimeInfo() });
        return;
      }
      if (typeof packet.runtimeReply === "string") {
        const pending = this.runtimeQueries.get(packet.runtimeReply);
        if (pending?.peerId === data.from) {
          clearTimeout(pending.timer); this.runtimeQueries.delete(packet.runtimeReply);
          if (isRuntimeInfo(packet.runtime)) pending.resolve(packet.runtime);
          else pending.reject(new CompatibilityError(["peer-unsupported"]));
        }
        return;
      }
    }
  }

  private lookupError(code: unknown): string {
    const messages: Record<string, string> = {
      peer_unavailable: "未找到在线设备，请确认对方的蜂鸟号并保持在线",
      invalid_target: "请选择另一台设备建立连接",
      invalid_numeric_id: "请输入有效的 6 位蜂鸟号",
      identity_changed: "该分组中未找到原联系人，请向对方确认新的蜂鸟号",
      identity_required: "无法确认联系人身份，请重新选择联系人",
      rate_limited: "查找过于频繁，请稍后重试",
      connect_rate_limited: "查找过于频繁，请稍后重试",
      join_required: "尚未连上蜂鸟，请稍后重试",
    };
    return messages[String(code)] || "暂时找不到对方，请稍后重试";
  }
  updateDirectory(numberChanged: boolean) {
    this.session?.updateLocalProfile?.(this.host.snapshot.profile);
    if (!numberChanged) return;
    if (this.session?.readyState !== DISCOVERY_OPEN) return;
    try {
      this.session.send(
        JSON.stringify({ type: "change_numeric_id", numericId: this.host.snapshot.profile.numericId, revision: this.host.snapshot.profile.revision }),
      );
    } catch (error) {
      runtimeLog("warn", "discovery", "资料将在重新连接后同步", {
        detail: String(error),
      });
      if (this.host.running) this.session?.close();
    }
  }
}
