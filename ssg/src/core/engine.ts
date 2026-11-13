import { runtimeLog } from "../runtime-logs";
import {
  readSettings,
  saveSettings,
  validateSettings,
  isDesktop,
  type NetworkSettings,
} from "./network/settings";
import type {
  AttachmentSource,
  Availability,
  ChatSnapshot,
  Conversation,
  FileDestination,
  FolderDestination,
  Message,
  Profile,
  StorageAdapter,
} from "./types";
import { createStorageAdapter } from "./storage";
import {
  compressFolder,
  inspectFolder,
  type FolderSelection,
  type FolderProgress,
  type ReadFolder,
} from "./folders";
import { FolderReceiver } from "./folderReceiver";
import {
  generateProfileBio,
  generateProfileName,
  randomChoice,
} from "./profile";
import { readLanguagePreference, resolveLanguage } from "../i18n/language";
import {
  CONNECTION_CONFIG,
  FOLDER_CONFIG,
  MAX_REMARK_LENGTH,
  MAX_TRANSFER_SIZE,
  PROFILE_AVATARS,
  PROFILE_COLORS,
  PROFILE_GENERATION_CONFIG,
  SIGNALING_CONFIG,
  STORAGE_CONFIG,
  TRANSFER_CONFIG,
} from "../config";
import {
  CHUNK_SIZE,
  HEADER_SIZE,
  MAX_CONTROL_BYTES,
  MAX_FILE_SIZE,
  MAX_TEXT_BYTES,
  decodeChunk,
  encodeChunk,
  isProfile,
  isNumericId,
  newId,
  parseControlPacket,
  type ControlPacket,
} from "./protocol";

import {
  browserNetwork,
  defaultNetwork,
  DISCOVERY_OPEN,
  type DiscoverySession,
  type NetworkAdapters,
  type TransportChannel,
  type TransportConnection,
} from "./network";

export { MAX_FILE_SIZE } from "./protocol";
export { MAX_REMARK_LENGTH } from "../config";
const imageTypes = /^(image\/(png|jpeg|gif|webp|avif|bmp))$/i;
type Timer = ReturnType<typeof setTimeout>;
type PeerLink = {
  peerId: string;
  connection: TransportConnection;
  channel?: TransportChannel;
  receiving: Promise<void>;
  disconnectTimer?: Timer;
  queuedPackets: number;
  createdAt: number;
  lastPong?: number;
  lastReceivedAt?: number;
  lastProbeAt?: number;
  recoveryPending?: boolean;
  probe?: { id: string; sentAt: number; deadline: number };
};
type IncomingTransfer = {
  peerId: string;
  message: Message;
  chunks: Uint8Array<ArrayBuffer>[];
  received: number;
  sequence: number;
  timer: Timer;
  destination?: FileDestination;
  bufferedBytes?: number;
  accepting?: boolean;
  folder?: FolderReceiver;
};
type OutgoingTransfer = {
  peerId: string;
  message: Message;
  timer?: Timer;
  accepted?: boolean;
  streaming?: boolean;
  sentBytes?: number;
  receivedBytes?: number;
  finished?: boolean;
  failureReason?: string;
  wake?: () => void;
  folderSupported?: boolean;
  folderIndex?: number;
  entryReady?: number;
  entrySaved?: number;
  entryEnded?: boolean;
};
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
type PendingNumberRefresh = {
  requestId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: Timer;
};
function savedAvailability(): Availability {
  try {
    return localStorage.getItem(STORAGE_CONFIG.availabilityKey) === "offline"
      ? "offline"
      : "online";
  } catch {
    return "online";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试";
}
function fileChunkSize(channel: TransportChannel): number {
  const limit = channel.maxMessageSize;
  const size = Math.min(CHUNK_SIZE, limit === undefined ? CHUNK_SIZE : limit - HEADER_SIZE);
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error("对方暂不支持接收文件，请更新后重试");
  return size;
}
function defaultProfile(): Profile {
  const language = resolveLanguage(readLanguagePreference());
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const device = /iPhone|iPad/.test(ua)
    ? "iPhone / iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Mac/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : PROFILE_GENERATION_CONFIG.copy[language].browser;
  return {
    id: newId(),
    name: generateProfileName(language),
    bio: generateProfileBio(language),
    avatar: randomChoice(PROFILE_AVATARS),
    color: randomChoice(PROFILE_COLORS),
    device,
    clientType: isDesktop() ? "app" : "web",
  };
}

/** Discovery, transport, and storage are independent; payloads only use the transport. */
export class ChatEngine {
  readonly storage: StorageAdapter;
  private movingStorage = false;
  private snapshot: ChatSnapshot;
  private listeners = new Set<() => void>();
  private links = new Map<string, PeerLink>();
  private cache = new Map<string, Message[]>();
  private incoming = new Map<string, IncomingTransfer>();
  private outgoing = new Map<string, OutgoingTransfer>();
  private preparations = new Map<AbortController, string>();
  private knownMessages = new Map<string, Message>();
  // Keep local tombstones for this session so delayed RTC packets cannot restore deletions.
  private deletedMessages = new Set<string>();
  private historyRevision = 0;
  private peerHistoryRevisions = new Map<string, number>();
  private writing: Promise<void> = Promise.resolve();
  private session?: DiscoverySession;
  private reconnectTimer?: Timer;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatProbe?: Timer;
  private lastHeartbeatAt = Date.now();
  private welcomedAt?: number;
  private reconnectAttempt = 0;
  private running = false;
  private peerHeartbeat?: ReturnType<typeof setInterval>;
  private peerTickAt = Date.now();
  private peerCheckAt = new Map<string, number>();
  private peerRetries = new Map<string, { attempt: number; at: number }>();
  private peerMisses = new Map<string, number>();
  private queuedReceiveBytes = 0;
  private queuedReceivePackets = 0;
  private lastPong = Date.now();
  private lookups = new Map<string, PendingLookup>();
  private groupLookups = new Map<string, PendingGroupLookup>();
  private numberRefresh?: PendingNumberRefresh;
  private restoringPeers = new Map<string, Promise<Profile>>();
  private connectingById = false;
  private readonly onOnline = () => {
    this.checkPeers(true);
    if (this.session?.readyState === DISCOVERY_OPEN) this.checkHeartbeat(true);
    else if (!this.session) this.connect();
  };
  private readonly onVisible = () => {
    if (document.visibilityState === "visible") {
      this.checkHeartbeat(true);
      this.checkPeers(true);
    }
  };
  private readonly onOffline = () => {
    if (this.network.discovery.usesBrowserNetworkStatus) this.disconnect();
  };

  constructor(
    storage: StorageAdapter,
    profile: Profile,
    conversations: Conversation[],
    private network: NetworkAdapters = browserNetwork(),
  ) {
    this.storage = storage;
    this.snapshot = {
      profile,
      conversations,
      peers: [],
      messages: [],
      activePeerId: null,
      status: "disconnected",
      availability: savedAvailability(),
      peerPresence: {},
      peerStates: {},
      transfers: {},
      error: null,
    };
    this.bindIncoming();
  }

  private bindIncoming() {
    this.network.transport.onIncoming = (peerId) => {
      if (
        this.running &&
        this.snapshot.peers.some((peer) => peer.id === peerId)
      )
        this.ensureLink(peerId, false);
    };
  }
  get networkSettings() {
    return readSettings();
  }
  async configureNetwork(value: NetworkSettings) {
    const settings = validateSettings(value);
    if (this.hasPendingTransfers())
      throw new Error("还有内容正在传输，请完成后再修改设置");
    const network = await defaultNetwork(settings);
    if (this.hasPendingTransfers())
      throw new Error("还有内容正在传输，请完成后再修改设置");
    saveSettings(settings);
    const online = this.snapshot.availability === "online";
    this.stop();
    this.network = network;
    this.bindIncoming();
    this.patch({
      profile: { ...this.snapshot.profile, numericId: undefined },
      error: null,
    });
    if (online) this.start();
  }

  get supportsNumericIds() {
    return this.network.discovery.supportsNumericIds;
  }
  get networkNames() {
    return {
      discovery: this.network.discovery.name,
      transport: this.network.transport.name,
    };
  }

  getSnapshot = (): ChatSnapshot => this.snapshot;
  /** Includes other conversations, files being prepared, and messages awaiting acknowledgement. */
  hasPendingTransfers = () =>
    this.movingStorage ||
    this.incoming.size > 0 ||
    this.outgoing.size > 0 ||
    this.preparations.size > 0;
  async moveStorage(directory: string) {
    if (!this.storage.moveStorage) throw new Error("当前存储不支持修改目录");
    if (this.hasPendingTransfers())
      throw new Error("请等待文件传输完成后再修改存储目录");
    this.movingStorage = true;
    this.patch({});
    try {
      return await this.storage.moveStorage(directory);
    } finally {
      this.movingStorage = false;
      this.patch({});
    }
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(values: Partial<ChatSnapshot>) {
    if (values.peers) {
      const peerPresence: ChatSnapshot["peerPresence"] = {};
      for (const peer of values.peers) {
        peerPresence[peer.id] = this.snapshot.peerPresence[peer.id] ?? "online";
        if (!this.peerCheckAt.has(peer.id))
          this.peerCheckAt.set(
            peer.id,
            Date.now() + CONNECTION_CONFIG.listHeartbeatIntervalMs,
          );
      }
      for (const id of this.peerCheckAt.keys()) {
        if (!(id in peerPresence)) {
          this.peerCheckAt.delete(id);
          this.peerRetries.delete(id);
          this.peerMisses.delete(id);
        }
      }
      values = { ...values, peerPresence };
    }
    this.snapshot = { ...this.snapshot, ...values };
    for (const listener of this.listeners) listener();
  }
  private showError(error: unknown) {
    runtimeLog("error", "app", "操作未完成", {
      detail: errorMessage(error),
      raw: error,
    });
    this.patch({ error: errorMessage(error) });
  }
  dismissError() {
    this.patch({ error: null });
  }
  private write<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.writing.then(action);
    this.writing = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private peerProfile(peerId: string) {
    return (
      this.snapshot.peers.find((p) => p.id === peerId) ??
      this.snapshot.conversations.find((c) => c.peer.id === peerId)?.peer
    );
  }

  start() {
    if (this.running || this.snapshot.availability === "offline") return;
    this.running = true;
    runtimeLog("info", "app", "开始连接", {
      detail: `${this.network.discovery.name} / ${this.network.transport.name}`,
    });
    this.peerTickAt = Date.now();
    this.peerHeartbeat = setInterval(() => this.checkPeers(), 1000);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }
  stop() {
    for (const controller of this.preparations.keys()) controller.abort();
    this.running = false;
    clearInterval(this.peerHeartbeat);
    this.peerRetries.clear();
    this.peerMisses.clear();
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.onVisible);
    this.disconnect();
  }
  private disconnect() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.clearHeartbeatProbe();
    this.welcomedAt = undefined;
    const socket = this.session;
    this.session = undefined;
    socket?.close();
    this.rejectLookups("连接已关闭，请重试");
    for (const id of [...this.links.keys()]) this.closeLink(id, "连接已关闭");
    this.patch({ status: "disconnected", peers: [], peerStates: {} });
  }
  setAvailability(availability: Availability) {
    if (availability === this.snapshot.availability) return;
    try {
      localStorage.setItem(STORAGE_CONFIG.availabilityKey, availability);
    } catch {
      // The switch still works for this session when browser storage is unavailable.
    }
    this.patch({ availability, error: null });
    if (availability === "offline") this.stop();
    else this.reconnect();
  }
  reconnect() {
    if (this.snapshot.availability === "offline") return;
    this.stop();
    this.reconnectAttempt = 0;
    this.patch({ error: null });
    this.start();
  }
  private connect() {
    if (!this.running || this.snapshot.availability === "offline") return;
    clearTimeout(this.reconnectTimer);
    if (
      this.network.discovery.usesBrowserNetworkStatus &&
      typeof navigator !== "undefined" &&
      navigator.onLine === false
    ) {
      this.patch({ status: "disconnected" });
      return;
    }
    runtimeLog("info", "discovery", "正在寻找设备");
    this.patch({ status: "connecting" });
    let socket: DiscoverySession;
    try {
      socket = this.network.discovery.open();
    } catch (error) {
      this.showError(error);
      this.scheduleReconnect();
      return;
    }
    this.session = socket;
    socket.onopen = () => {
      if (this.session !== socket) return;
      this.lastPong = Date.now();
      this.lastHeartbeatAt = this.lastPong;
      this.welcomedAt = undefined;
      socket.send(
        JSON.stringify({
          type: "join",
          room: SIGNALING_CONFIG.room,
          profile: this.snapshot.profile,
        }),
      );
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(
        () => this.checkHeartbeat(),
        SIGNALING_CONFIG.heartbeatIntervalMs,
      );
    };
    socket.onmessage = (event) => {
      if (
        this.session !== socket ||
        typeof event.data !== "string" ||
        event.data.length > SIGNALING_CONFIG.maxMessageChars
      )
        return;
      void this.handleSignal(event.data).catch((error) =>
        this.showError(error),
      );
    };
    socket.onerror = (event) => {
      if (this.session === socket)
        runtimeLog("error", "discovery", "设备查找遇到问题", {
          detail:
            event && "message" in event ? String(event.message) : undefined,
        });
      if (this.session === socket)
        this.patch({
          error:
            event &&
            "message" in event &&
            typeof event.message === "string" &&
            event.message
              ? event.message
              : "暂时连不上蜂鸟，请检查网络后重试。",
        });
    };
    socket.onclose = () => {
      if (this.session !== socket) return;
      runtimeLog("warn", "discovery", "设备查找已断开，准备重试");
      this.session = undefined;
      this.rejectLookups("连接已断开，请稍后重试");
      clearInterval(this.heartbeat);
      this.clearHeartbeatProbe();
      this.welcomedAt = undefined;
      for (const id of [...this.links.keys()])
        this.closeLink(id, "网络已断开，请重新发送");
      this.patch({ status: "disconnected", peers: [], peerStates: {} });
      this.scheduleReconnect();
    };
  }
  private clearHeartbeatProbe() {
    clearTimeout(this.heartbeatProbe);
    this.heartbeatProbe = undefined;
  }
  private probeHeartbeat(socket: DiscoverySession) {
    this.clearHeartbeatProbe();
    const deadline = Date.now() + SIGNALING_CONFIG.heartbeatResumeGraceMs;
    // Keep the payload exact so Cloudflare can answer without waking the hub.
    socket.send(JSON.stringify({ type: "ping" }));
    this.heartbeatProbe = setTimeout(() => {
      this.heartbeatProbe = undefined;
      if (this.session !== socket || socket.readyState !== DISCOVERY_OPEN)
        return;
      // The page may have been suspended again while waiting for this probe.
      if (Date.now() - deadline > SIGNALING_CONFIG.heartbeatIntervalMs)
        this.probeHeartbeat(socket);
      else socket.close();
    }, SIGNALING_CONFIG.heartbeatResumeGraceMs);
  }
  private checkHeartbeat(resumed = false) {
    const socket = this.session;
    if (!socket || socket.readyState !== DISCOVERY_OPEN) return;
    const now = Date.now();
    const delayed =
      now - this.lastHeartbeatAt > SIGNALING_CONFIG.heartbeatIntervalMs * 2;
    this.lastHeartbeatAt = now;
    const stale = now - this.lastPong > SIGNALING_CONFIG.heartbeatTimeoutMs;
    if (delayed || (resumed && stale)) {
      if (!this.heartbeatProbe || delayed) this.probeHeartbeat(socket);
      return;
    }
    if (this.heartbeatProbe) return;
    if (stale) socket.close();
    else socket.send(JSON.stringify({ type: "ping" }));
  }
  private scheduleReconnect() {
    if (!this.running) return;
    clearTimeout(this.reconnectTimer);
    this.patch({ status: "disconnected" });
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
  private sendSignal(to: string, data: unknown) {
    if (this.session?.readyState !== DISCOVERY_OPEN)
      throw new Error("尚未连上蜂鸟，请稍后重试");
    this.session.send(JSON.stringify({ type: "signal", to, data }));
  }
  private rejectLookups(message: string) {
    this.finishNumberRefresh(new Error(message));
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
  private finishNumberRefresh(error?: Error) {
    const pending = this.numberRefresh;
    if (!pending) return;
    this.numberRefresh = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }
  async refreshNumericId(): Promise<void> {
    if (!this.supportsNumericIds)
      throw new Error("局域网内的设备会自动出现，无需蜂鸟号");
    if (this.numberRefresh) throw new Error("正在刷新蜂鸟号，请稍候");
    if (
      this.snapshot.status !== "connected" ||
      this.session?.readyState !== DISCOVERY_OPEN
    )
      throw new Error("尚未连上蜂鸟，请稍后重试");
    const requestId = newId();
    return new Promise<void>((resolve, reject) => {
      this.numberRefresh = {
        requestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.finishNumberRefresh(new Error("刷新蜂鸟号超时，请稍后重试"));
        }, SIGNALING_CONFIG.lookupTimeoutMs),
      };
      try {
        this.session!.send(
          JSON.stringify({ type: "refresh_number", requestId }),
        );
      } catch {
        this.finishNumberRefresh(new Error("刷新蜂鸟号失败，请稍后重试"));
      }
    });
  }
  private async resolveNumericId(numericId: string, expectedPeerId?: string) {
    const deadline = Date.now() + SIGNALING_CONFIG.lookupTimeoutMs;
    while (this.snapshot.status === "connecting" && Date.now() < deadline)
      await new Promise((resolve) =>
        setTimeout(resolve, CONNECTION_CONFIG.pollIntervalMs),
      );
    if (
      this.snapshot.status !== "connected" ||
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
  private restorePeer(peer: Profile): Promise<Profile> {
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
  /** Discover the target network's devices without changing our group or selecting a conversation. */
  async connectByNumericId(numericId: string): Promise<void> {
    if (!this.supportsNumericIds)
      throw new Error("局域网内的设备会自动出现，无需蜂鸟号");
    const value = numericId.trim();
    if (!isNumericId(value))
      throw new Error("请输入 6 位蜂鸟号（首位不能为 0）");
    if (this.connectingById) throw new Error("正在建立连接，请稍候");
    if (this.snapshot.availability === "offline")
      throw new Error("你已离线，请先将我的状态切换为在线");
    if (
      this.snapshot.status !== "connected" ||
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
    if (
      data.type === "connect_error" &&
      this.numberRefresh &&
      data.requestId === this.numberRefresh.requestId
    ) {
      this.finishNumberRefresh(
        new Error(
          data.code === "connect_rate_limited"
            ? "操作过于频繁，请稍后重试"
            : "刷新蜂鸟号失败，请稍后重试",
        ),
      );
      return;
    }
    if (data.type === "number_updated") {
      const pending = this.numberRefresh;
      const isResponse = !!pending && data.requestId === pending.requestId;
      const { numericId, peerIds } = data;
      if (
        !isNumericId(numericId) ||
        !Array.isArray(peerIds) ||
        !peerIds.every((id) => typeof id === "string") ||
        (isResponse && !peerIds.includes(this.snapshot.profile.id))
      ) {
        if (isResponse)
          this.finishNumberRefresh(new Error("刷新蜂鸟号失败，请稍后重试"));
        return;
      }
      const ids = new Set(peerIds);
      try {
        await this.write(async () => {
          const profile = ids.has(this.snapshot.profile.id)
            ? { ...this.snapshot.profile, numericId }
            : this.snapshot.profile;
          if (profile !== this.snapshot.profile)
            await this.storage.saveProfile(profile);
          const conversations = this.snapshot.conversations.map(
            (conversation) =>
              ids.has(conversation.peer.id)
                ? { ...conversation, peer: { ...conversation.peer, numericId } }
                : conversation,
          );
          for (const conversation of conversations) {
            if (ids.has(conversation.peer.id))
              await this.storage.saveConversation(conversation);
          }
          this.patch({
            profile,
            conversations,
            peers: this.snapshot.peers.map((peer) =>
              ids.has(peer.id) ? { ...peer, numericId } : peer,
            ),
          });
        });
        if (isResponse && this.numberRefresh === pending)
          this.finishNumberRefresh();
      } catch (error) {
        if (isResponse && this.numberRefresh === pending)
          this.finishNumberRefresh(new Error("刷新蜂鸟号失败，请稍后重试"));
        else this.showError(error);
      }
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
          (peer) => peer.id !== this.snapshot.profile.id,
        );
        const visible = new Map(
          this.snapshot.peers.map((peer) => [peer.id, peer]),
        );
        for (const peer of peers) visible.set(peer.id, peer);
        this.patch({ peers: [...visible.values()] });
        lookup.resolve();
        for (const peer of peers) await this.refreshPeer(peer);
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
        data.peer.id === this.snapshot.profile.id ||
        (lookup.expectedPeerId && lookup.expectedPeerId !== data.peer.id)
      ) {
        lookup.reject(
          new Error("返回的设备不是原联系人，请向对方确认新的蜂鸟号"),
        );
      } else {
        const peer = data.peer;
        this.patch({
          peers: [...this.snapshot.peers.filter((p) => p.id !== peer.id), peer],
        });
        this.ensureLink(peer.id);
        lookup.resolve(peer);
        await this.refreshPeer(peer);
      }
      return;
    }
    if (data.type === "pong") {
      this.lastPong = Date.now();
      this.clearHeartbeatProbe();
      if (
        this.welcomedAt !== undefined &&
        this.lastPong - this.welcomedAt >= SIGNALING_CONFIG.reconnectStableMs
      )
        this.reconnectAttempt = 0;
      return;
    }
    if (data.type === "ping") {
      this.session?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (data.type === "error") {
      runtimeLog("warn", "discovery", "连接服务返回提醒", {
        detail: String(data.code),
      });
      if (data.code === "session_replaced") {
        this.stop();
        this.patch({
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
        this.patch({
          error:
            messages[String(data.code)] || "连接遇到问题，请重新连接后重试",
        });
      }
      return;
    }
    if (data.type === "discovery_number") {
      const numericId = isNumericId(data.numericId)
        ? data.numericId
        : undefined;
      await this.write(async () => {
        const profile = { ...this.snapshot.profile, numericId };
        await this.storage.saveProfile(profile);
        this.patch({ profile });
      });
      return;
    }
    if (data.type === "welcome" && Array.isArray(data.peers)) {
      const peers = data.peers
        .filter(isProfile)
        .filter((peer) => peer.id !== this.snapshot.profile.id);
      this.welcomedAt = Date.now();
      this.lastPong = Date.now();
      runtimeLog("info", "discovery", "设备查找已就绪", {
        detail: `peers=${peers.length}`,
      });
      this.patch({ status: "connected", peers, error: null });
      if (peers.some((peer) => peer.id === this.snapshot.activePeerId))
        this.ensureLink(this.snapshot.activePeerId!);
      const numericId = data.numericId;
      if (isNumericId(numericId))
        await this.write(async () => {
          const profile = { ...this.snapshot.profile, numericId };
          await this.storage.saveProfile(profile);
          this.patch({ profile });
        });
      for (const peer of peers) await this.refreshPeer(peer);
      const activePeer = this.snapshot.activePeerId
        ? this.peerProfile(this.snapshot.activePeerId)
        : undefined;
      if (
        this.snapshot.status === "connected" &&
        activePeer?.numericId &&
        !this.snapshot.peers.some((p) => p.id === activePeer.id)
      )
        void this.restorePeer(activePeer).catch(() => undefined);
      return;
    }
    if (
      (data.type === "peer_joined" || data.type === "peer_updated") &&
      isProfile(data.peer) &&
      data.peer.id !== this.snapshot.profile.id
    ) {
      const peer = data.peer;
      runtimeLog("info", "discovery", "发现设备", { peerId: peer.id });
      this.patch({
        peers: [...this.snapshot.peers.filter((p) => p.id !== peer.id), peer],
      });
      if (this.snapshot.activePeerId === peer.id) this.ensureLink(peer.id);
      await this.refreshPeer(peer);
      return;
    }
    if (data.type === "peer_left" && typeof data.id === "string") {
      runtimeLog("info", "discovery", "设备已离开", { peerId: data.id });
      this.peerRetries.delete(data.id);
      this.closeLink(data.id, "对方已离线，请稍后重新发送");
      const peerStates = { ...this.snapshot.peerStates };
      delete peerStates[data.id];
      this.patch({
        peers: this.snapshot.peers.filter((p) => p.id !== data.id),
        peerStates,
      });
      return;
    }
    // Native connection addresses are consumed by the desktop discovery adapter.
    // Browsers must not create an idle WebRTC connection for this metadata.
    if (
      data.type === "signal" &&
      data.data &&
      typeof data.data === "object" &&
      "tcp" in data.data
    )
      return;
    if (
      data.type === "signal" &&
      typeof data.from === "string" &&
      this.snapshot.peers.some((p) => p.id === data.from) &&
      data.data &&
      typeof data.data === "object"
    ) {
      const negotiation = data.data as { description?: { type?: string } };
      // A fresh offer on an established channel means the remote rebuilt its connection.
      // Retire the old transport before negotiating; otherwise it rejects the new channel.
      const previous = this.links.get(data.from);
      if (
        negotiation.description?.type === "offer" &&
        previous?.channel?.readyState === "open"
      ) {
        runtimeLog("info", "connection", "对方正在重新连接", {
          peerId: data.from,
        });
        this.closeLink(data.from, "对方正在重新连接，请重新发送");
      }
      const link = this.ensureLink(data.from, false);
      if (!link) return;
      await link.connection.signal(data.data);
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
  private async refreshPeer(peer: Profile) {
    await this.write(async () => {
      const conversation = this.snapshot.conversations.find(
        (c) => c.peer.id === peer.id,
      );
      if (!conversation) return;
      const next = { ...conversation, peer };
      await this.storage.saveConversation(next);
      this.patch({
        conversations: this.snapshot.conversations.map((c) =>
          c.peer.id === peer.id ? next : c,
        ),
      });
    });
  }
  private ensureLink(peerId: string, initiate = true): PeerLink | undefined {
    const existing = this.links.get(peerId);
    if (existing) {
      if (initiate) this.offerLink(existing);
      return existing;
    }
    let link: PeerLink;
    try {
      const connection = this.network.transport.create({
        localId: this.snapshot.profile.id,
        peerId,
        sendSignal: (data) => this.sendSignal(peerId, data),
        onChannel: (channel, replace) => {
          if (replace || link.channel?.readyState === "closed")
            link.channel = undefined;
          this.attachChannel(link, channel);
        },
        onState: (state) => {
          if (this.links.get(peerId) !== link) return;
          clearTimeout(link.disconnectTimer);
          if (state === "failed") this.failLink(link, "设备连接已中断");
          else if (state === "disconnected") {
            link.lastPong = undefined;
            this.patch({
              peerStates: {
                ...this.snapshot.peerStates,
                [peerId]: "connecting",
              },
            });
            link.disconnectTimer = setTimeout(
              () => this.failLink(link, "设备连接已中断"),
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
          this.failLink(link, errorMessage(error));
        },
      });
      link = {
        peerId,
        connection,
        receiving: Promise.resolve(),
        queuedPackets: 0,
        createdAt: Date.now(),
      };
    } catch (error) {
      this.schedulePeerRetry(peerId);
      runtimeLog("warn", "connection", "暂时无法与对方通信", {
        peerId,
        detail: errorMessage(error),
        raw: error,
      });
      if (peerId === this.snapshot.activePeerId) this.showError(error);
      this.patch({
        peerPresence: { ...this.snapshot.peerPresence, [peerId]: "offline" },
        peerStates: { ...this.snapshot.peerStates, [peerId]: "failed" },
      });
      return;
    }
    runtimeLog("info", "connection", "正在连接对方", {
      peerId,
      detail: this.network.transport.name,
    });
    this.links.set(peerId, link);
    this.patch({
      peerStates: { ...this.snapshot.peerStates, [peerId]: "connecting" },
    });
    if (link.connection.channel)
      this.attachChannel(link, link.connection.channel);
    if (initiate) this.offerLink(link);
    return link;
  }
  private offerLink(link: PeerLink) {
    link.connection.start();
  }
  private attachChannel(link: PeerLink, channel: TransportChannel) {
    if (link.channel && link.channel !== channel) {
      channel.close();
      return;
    }
    link.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = CONNECTION_CONFIG.sendBufferLowBytes;
    channel.onopen = () => {
      if (this.links.get(link.peerId) !== link || link.channel !== channel)
        return;
      runtimeLog("info", "connection", "通道已打开", {
        peerId: link.peerId,
      });
      link.lastPong = undefined;
      link.lastReceivedAt = undefined;
      link.lastProbeAt = undefined;
      link.probe = undefined;
      link.recoveryPending = false;
      clearTimeout(link.disconnectTimer);
      this.markPeerConnected(link.peerId);
      this.probePeer(link);
    };
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
          : bytes > CHUNK_SIZE + HEADER_SIZE)
      ) {
        channel.consumed?.();
        return;
      }
      // Heartbeats bypass persistence work, but still return native receive credit.
      if (typeof event.data === "string") {
        const packet = parseControlPacket(event.data);
        if (packet?.type === "peer-ping" || packet?.type === "peer-pong") {
          try {
            this.handlePeerHeartbeat(link, packet);
          } catch (error) {
            this.failLink(link, errorMessage(error));
          } finally {
            channel.consumed?.();
          }
          return;
        }
        if (packet) this.receivedFromPeer(link);
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
      this.queuedReceiveBytes += bytes;
      this.queuedReceivePackets++;
      const historyRevision = this.historyRevision;
      const peerRevision = this.peerHistoryRevisions.get(link.peerId) || 0;
      // Ordered channels still require an async queue: IndexedDB awaits must not let file-end overtake chunks.
      link.receiving = link.receiving
        .then(() => {
          if (
            this.historyRevision !== historyRevision ||
            (this.peerHistoryRevisions.get(link.peerId) || 0) !== peerRevision
          )
            return;
          return this.handleData(link, event.data);
        })
        .catch((error) => this.showError(error))
        .finally(() => {
          link.queuedPackets--;
          this.queuedReceiveBytes -= bytes;
          this.queuedReceivePackets--;
          channel.consumed?.();
        });
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
    const attempt = (this.peerRetries.get(peerId)?.attempt || 0) + 1;
    const delay = Math.max(
      peerId === this.snapshot.activePeerId
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
  private checkPeers(resumed = false) {
    if (!this.running) return;
    const now = Date.now();
    const suspended =
      now - this.peerTickAt > CONNECTION_CONFIG.peerHeartbeatIntervalMs * 2;
    this.peerTickAt = now;
    // Time spent suspended is not a completed probe cycle.
    if (resumed || suspended) this.peerMisses.clear();
    for (const link of this.links.values()) {
      if (resumed || suspended) {
        link.probe = undefined;
        link.lastPong = undefined;
        link.lastReceivedAt = undefined;
        link.lastProbeAt = undefined;
        link.recoveryPending = false;
        link.createdAt = now;
      }
      if (link.channel?.readyState !== "open") {
        if (now - link.createdAt >= CONNECTION_CONFIG.readyTimeoutMs)
          this.failLink(link, "连接等待超时，正在重新尝试");
        continue;
      }
      if (link.probe && now >= link.probe.deadline) {
        const probe = link.probe;
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
          link.recoveryPending = true;
          runtimeLog("debug", "heartbeat", "暂未收到对方响应", {
            peerId: link.peerId,
            raw: { missedCycles: misses, probe },
          });
          if (
            misses >= CONNECTION_CONFIG.peerHeartbeatMissLimit &&
            this.snapshot.peerPresence[link.peerId] !== "offline"
          ) {
            runtimeLog("warn", "heartbeat", "连续多次未收到对方响应，已标记离线", {
              peerId: link.peerId,
              raw: { missedCycles: misses, probe },
            });
            this.patch({
              peerPresence: { ...this.snapshot.peerPresence, [link.peerId]: "offline" },
            });
          }
        }
      }
      if (
        link.recoveryPending &&
        link.queuedPackets === 0 &&
        ![...this.incoming.values(), ...this.outgoing.values()].some(
          (transfer) => transfer.peerId === link.peerId,
        )
      ) {
        // Preserve content's own deadlines while continuing liveness cycles.
        this.failLink(link, "对方暂时没有响应，正在重新连接", false);
      } else if (
        !link.probe &&
        (link.lastProbeAt === undefined ||
          now - link.lastProbeAt >=
            (link.peerId === this.snapshot.activePeerId
              ? CONNECTION_CONFIG.peerHeartbeatIntervalMs
              : CONNECTION_CONFIG.listHeartbeatIntervalMs))
      ) {
        this.probePeer(link);
      }
    }
    const peerId = this.snapshot.activePeerId;
    if (
      peerId &&
      this.snapshot.status === "connected" &&
      this.snapshot.peers.some((peer) => peer.id === peerId) &&
      !this.links.has(peerId) &&
      now >= (this.peerRetries.get(peerId)?.at || 0)
    ) {
      runtimeLog("info", "connection", "重新尝试连接对方", { peerId });
      this.ensureLink(peerId);
    }
    if (this.snapshot.status !== "connected") return;
    // Limit simultaneous background negotiations, while an explicit chat can start immediately.
    let pending = [...this.links.values()].filter(
      (link) => link.channel?.readyState !== "open",
    ).length;
    const queued = [...this.snapshot.peers].sort(
      (a, b) =>
        (this.peerCheckAt.get(a.id) || 0) - (this.peerCheckAt.get(b.id) || 0),
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
      this.peerCheckAt.set(
        peer.id,
        now + CONNECTION_CONFIG.listHeartbeatIntervalMs,
      );
      this.ensureLink(peer.id);
      pending++;
    }
  }
  private probePeer(link: PeerLink) {
    if (link.probe || link.channel?.readyState !== "open") return;
    const sentAt = Date.now();
    link.lastProbeAt = sentAt;
    // Bulk data shares the ordered stream. Allow bounded time for disk/backpressure.
    const busy =
      link.channel.bufferedAmount > CONNECTION_CONFIG.sendBufferLowBytes ||
      link.queuedPackets > 0 ||
      [...this.incoming.values(), ...this.outgoing.values()].some(
        (transfer) =>
          transfer.peerId === link.peerId && transfer.message.kind !== "text",
      );
    link.probe = {
      id: newId(),
      sentAt,
      deadline:
        sentAt +
        (busy
          ? TRANSFER_CONFIG.timeoutMs
          : CONNECTION_CONFIG.peerHeartbeatTimeoutMs),
    };
    try {
      runtimeLog("debug", "heartbeat", "检查对方是否可通信", {
        peerId: link.peerId,
        raw: {
          direction: "outgoing",
          type: "peer-ping",
          ...link.probe,
          transport: this.network.transport.name,
        },
      });
      this.sendControl(link.channel, { type: "peer-ping", id: link.probe.id });
    } catch (error) {
      this.failLink(link, errorMessage(error));
    }
  }
  private handlePeerHeartbeat(
    link: PeerLink,
    packet: { type: "peer-ping" | "peer-pong"; id: string },
  ) {
    if (packet.type === "peer-ping") {
      this.receivedFromPeer(link);
      this.sendControl(link.channel!, { type: "peer-pong", id: packet.id });
      runtimeLog("debug", "heartbeat", "已回复对方的检查", {
        peerId: link.peerId,
        raw: { direction: "outgoing", type: "peer-pong", id: packet.id },
      });
      return;
    }
    if (
      !link.probe ||
      link.probe.id !== packet.id ||
      Date.now() >= link.probe.deadline
    )
      return;
    const elapsed = Date.now() - link.probe.sentAt;
    link.lastPong = Date.now();
    link.probe = undefined;
    this.receivedFromPeer(link);
    runtimeLog("debug", "heartbeat", "对方已响应", {
      peerId: link.peerId,
      detail: `${elapsed} ms`,
      raw: {
        direction: "incoming",
        type: "peer-pong",
        id: packet.id,
        roundTripMs: elapsed,
      },
    });
  }
  private receivedFromPeer(link: PeerLink) {
    link.lastReceivedAt = Date.now();
    link.recoveryPending = false;
    clearTimeout(link.disconnectTimer);
    this.peerRetries.delete(link.peerId);
    this.peerMisses.delete(link.peerId);
    this.markPeerConnected(link.peerId, true);
  }
  private markPeerConnected(peerId: string, confirmed = false) {
    // Opening a replacement channel permits sending, but does not prove liveness.
    const presence = confirmed ? "online" : this.snapshot.peerPresence[peerId] ?? "online";
    if (
      this.snapshot.peerStates[peerId] !== "connected" ||
      this.snapshot.peerPresence[peerId] !== presence
    ) {
      this.patch({
        peerPresence: {
          ...this.snapshot.peerPresence,
          [peerId]: presence,
        },
        peerStates: { ...this.snapshot.peerStates, [peerId]: "connected" },
      });
    }
  }
  private failLink(link: PeerLink, reason: string, offline = true) {
    if (this.links.get(link.peerId) !== link) return;
    runtimeLog("warn", "connection", "暂时无法与对方通信", {
      peerId: link.peerId,
      detail: reason,
      raw: {
        reason,
        channelState: link.channel?.readyState,
        lastPong: link.lastPong,
        probe: link.probe,
      },
    });
    this.closeLink(link.peerId, reason);
    this.schedulePeerRetry(link.peerId);
    this.patch({
      ...(offline
        ? {
            peerPresence: {
              ...this.snapshot.peerPresence,
              [link.peerId]: "offline" as const,
            },
          }
        : {}),
      peerStates: {
        ...this.snapshot.peerStates,
        [link.peerId]: offline ? "failed" : "connecting",
      },
    });
  }
  private closeLink(peerId: string, reason: string) {
    const link = this.links.get(peerId);
    this.links.delete(peerId);
    if (link) {
      clearTimeout(link.disconnectTimer);
      link.channel?.close();
      link.connection.close();
    }
    for (const [id, transfer] of this.incoming)
      if (transfer.peerId === peerId) this.failIncoming(id, reason);
    for (const [id, transfer] of this.outgoing)
      if (transfer.peerId === peerId) void this.failOutgoing(id, reason);
  }
  private async readyChannel(
    peerId: string,
  ): Promise<{ link: PeerLink; channel: TransportChannel }> {
    if (this.snapshot.availability === "offline")
      throw new Error("你已离线，请先上线再发送");
    const existing = this.links.get(peerId);
    if (existing?.channel?.readyState === "open")
      return { link: existing, channel: existing.channel };
    const deadline = Date.now() + CONNECTION_CONFIG.readyTimeoutMs;
    while (
      this.snapshot.status === "connecting" &&
      !this.snapshot.peers.some((p) => p.id === peerId) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, CONNECTION_CONFIG.pollIntervalMs),
      );
    }
    if (!this.snapshot.peers.some((p) => p.id === peerId)) {
      const peer = this.peerProfile(peerId);
      if (!peer?.numericId) throw new Error("对方当前离线，消息未发送");
      await this.restorePeer(peer);
    }
    const link = this.ensureLink(peerId);
    if (!link) throw new Error("无法建立设备连接");
    while (Date.now() < deadline) {
      if (this.links.get(peerId) !== link) throw new Error("设备连接已断开");
      if (link.channel?.readyState === "open")
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
  private sendControl(channel: TransportChannel, packet: ControlPacket) {
    if (channel.readyState !== "open") throw new Error("设备连接已断开");
    const raw = JSON.stringify(packet);
    if (new TextEncoder().encode(raw).byteLength > MAX_CONTROL_BYTES)
      throw new Error("消息过长，请减少内容后重试");
    channel.send(raw);
  }
  private async waitForBuffer(channel: TransportChannel) {
    if (channel.readyState !== "open") throw new Error("设备连接已断开");
    if (channel.bufferedAmount <= CONNECTION_CONFIG.sendBufferHighBytes) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        channel.removeEventListener("error", onClose);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("文件传输中断"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("文件传输超时"));
      }, TRANSFER_CONFIG.timeoutMs);
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose);
      channel.addEventListener("error", onClose);
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) onLow();
    });
  }

  async selectPeer(peer: Profile) {
    if (this.snapshot.peers.some((p) => p.id === peer.id)) {
      const link = this.ensureLink(peer.id);
      if (link?.channel?.readyState === "open") this.probePeer(link);
    }
    if (
      peer.numericId &&
      this.snapshot.status === "connected" &&
      !this.snapshot.peers.some((p) => p.id === peer.id)
    )
      void this.restorePeer(peer).catch(() => undefined);
    this.patch({
      activePeerId: peer.id,
      messages: this.cache.get(peer.id) || [],
    });
    try {
      await this.write(async () => {
        const previous = this.snapshot.conversations.find(
          (c) => c.peer.id === peer.id,
        );
        const conversation = {
          ...previous,
          peer,
          updatedAt: previous?.updatedAt || Date.now(),
          unread: 0,
        };
        await this.storage.saveConversation(conversation);
        const messages = await this.storage.getMessages(peer.id);
        // Interrupted transmissions do not remain permanently stuck after a reload.
        for (const message of messages) {
          if (
            (message.status === "sending" ||
              message.status === "sent" ||
              message.status === "awaiting-acceptance") &&
            !this.outgoing.has(message.id) &&
            !this.incoming.has(message.id)
          ) {
            message.status = "failed";
            message.error = "上次传输已中断，请重新发送";
            await this.storage.saveMessage(message);
          }
          this.knownMessages.set(message.id, message);
        }
        this.cache.set(peer.id, messages);
        const conversations = [
          ...this.snapshot.conversations.filter((c) => c.peer.id !== peer.id),
          conversation,
        ].sort((a, b) => b.updatedAt - a.updatedAt);
        this.patch({
          conversations,
          ...(this.snapshot.activePeerId === peer.id ? { messages } : {}),
        });
      });
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
  async updatePeerRemark(peerId: string, remark: string): Promise<void> {
    try {
      if (typeof remark !== "string") throw new Error("请输入有效的备注名称");
      const value = remark.trim();
      if (value.length > MAX_REMARK_LENGTH)
        throw new Error(`备注名称不能超过 ${MAX_REMARK_LENGTH} 字`);
      await this.write(async () => {
        const peer = this.peerProfile(peerId);
        if (!peer) throw new Error("未找到聊天对象，请刷新后重试");
        const previous = this.snapshot.conversations.find(
          (conversation) => conversation.peer.id === peerId,
        );
        const conversation: Conversation = previous
          ? { ...previous, peer }
          : { peer, updatedAt: Date.now(), unread: 0 };
        if (value) conversation.remark = value;
        else delete conversation.remark;
        await this.storage.saveConversation(conversation);
        this.patch({
          conversations: previous
            ? this.snapshot.conversations.map((entry) =>
                entry.peer.id === peerId ? conversation : entry,
              )
            : [...this.snapshot.conversations, conversation].sort(
                (a, b) => b.updatedAt - a.updatedAt,
              ),
        });
      });
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
  async updatePeerAutoAcceptFiles(
    peerId: string,
    enabled: boolean,
  ): Promise<void> {
    try {
      await this.write(async () => {
        const peer = this.peerProfile(peerId);
        if (!peer) throw new Error("未找到聊天对象，请刷新后重试");
        const previous = this.snapshot.conversations.find(
          (conversation) => conversation.peer.id === peerId,
        );
        const conversation: Conversation = {
          ...previous,
          peer,
          updatedAt: previous?.updatedAt ?? Date.now(),
          unread: previous?.unread ?? 0,
          autoAcceptFiles: enabled === true,
        };
        await this.storage.saveConversation(conversation);
        this.patch({
          conversations: previous
            ? this.snapshot.conversations.map((entry) =>
                entry.peer.id === peerId ? conversation : entry,
              )
            : [...this.snapshot.conversations, conversation].sort(
                (a, b) => b.updatedAt - a.updatedAt,
              ),
        });
      });
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
  async updateProfile(patch: Partial<Profile>) {
    try {
      await this.write(async () => {
        const profile = {
          ...this.snapshot.profile,
          ...patch,
          id: this.snapshot.profile.id,
          numericId: this.snapshot.profile.numericId,
        };
        profile.name = profile.name.trim();
        if (!isProfile(profile))
          throw new Error(
            "昵称需为 1–40 字，简介不超过 160 字，请检查个人资料",
          );
        if (
          (Object.keys(profile) as (keyof Profile)[]).every(
            (key) => profile[key] === this.snapshot.profile[key],
          )
        )
          return;
        await this.storage.saveProfile(profile);
        this.patch({ profile });
        if (this.session?.readyState === DISCOVERY_OPEN)
          this.session.send(JSON.stringify({ type: "profile", profile }));
      });
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
  private async recordMessage(message: Message, incoming = false) {
    return this.write(async () => {
      if (this.deletedMessages.has(message.id)) return;
      if (
        this.knownMessages.get(message.id)?.status === "delivered" &&
        message.status !== "delivered"
      )
        return;
      const peer = this.peerProfile(message.peerId);
      if (!peer) return;
      await this.storage.saveMessage(message);
      if (this.knownMessages.get(message.id)?.status !== message.status)
        runtimeLog(
          message.status === "failed" ? "warn" : "info",
          "message",
          incoming ? "已接收内容" : "发送进度已更新",
          {
            peerId: message.peerId,
            detail: `${message.id} / ${message.kind} / ${message.status}`,
          },
        );
      this.knownMessages.set(message.id, message);
      const previous = this.snapshot.conversations.find(
        (c) => c.peer.id === peer.id,
      );
      const conversation: Conversation = {
        ...previous,
        peer,
        updatedAt: Math.max(previous?.updatedAt || 0, message.createdAt),
        unread:
          (previous?.unread || 0) +
          (incoming && this.snapshot.activePeerId !== peer.id ? 1 : 0),
      };
      await this.storage.saveConversation(conversation);
      const messages =
        this.cache.get(peer.id) ?? (await this.storage.getMessages(peer.id));
      const nextMessages = [
        ...messages.filter((m) => m.id !== message.id),
        message,
      ].sort((a, b) => a.createdAt - b.createdAt);
      this.cache.set(peer.id, nextMessages);
      this.patch({
        conversations: [
          ...this.snapshot.conversations.filter((c) => c.peer.id !== peer.id),
          conversation,
        ].sort((a, b) => b.updatedAt - a.updatedAt),
        ...(this.snapshot.activePeerId === peer.id
          ? { messages: nextMessages }
          : {}),
      });
    });
  }
  private progress(id: string, value: number | null) {
    if (value !== null && this.deletedMessages.has(id)) return;
    const transfers = { ...this.snapshot.transfers };
    if (value === null) delete transfers[id];
    else transfers[id] = value;
    this.patch({ transfers });
  }
  private armAck(id: string) {
    const outgoing = this.outgoing.get(id);
    if (outgoing)
      outgoing.timer = setTimeout(
        () => {
          void this.failOutgoing(id, "未收到对方的接收确认，请重新发送");
        },
        outgoing.message.attachmentStorage || outgoing.streaming
          ? 2 * TRANSFER_CONFIG.timeoutMs
          : TRANSFER_CONFIG.ackTimeoutMs,
      );
  }
  private waitForTransfer(
    id: string,
    ready: (transfer: OutgoingTransfer) => boolean,
    timeout: number,
    reason: string,
  ): Promise<void> {
    const transfer = this.outgoing.get(id);
    if (!transfer) return Promise.reject(new Error("文件传输已取消"));
    if (ready(transfer)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        transfer.wake = undefined;
        reject(new Error(reason));
      }, timeout);
      transfer.wake = () => {
        if (this.outgoing.get(id) === transfer && !ready(transfer)) return;
        clearTimeout(timer);
        transfer.wake = undefined;
        if (this.outgoing.get(id) === transfer) resolve();
        else reject(new Error(transfer.failureReason || "文件传输已取消"));
      };
    });
  }
  private async failOutgoing(id: string, reason: string) {
    const transfer = this.outgoing.get(id);
    // A channel-close callback may already have queued the failure update.
    if (!transfer) {
      await this.writing;
      return;
    }
    runtimeLog("warn", "message", "内容未能送达", {
      peerId: transfer.peerId,
      detail: `${id}: ${reason}`,
    });
    this.outgoing.delete(id);
    transfer.failureReason = reason;
    transfer.wake?.();
    if (transfer.message.kind !== "text")
      this.notifyTransferError(transfer.peerId, id, reason);
    clearTimeout(transfer.timer);
    this.progress(id, null);
    await this.recordMessage({
      ...transfer.message,
      status: "failed",
      error: reason,
    }).catch((error) => this.showError(error));
  }
  /** Forward a local record over RTC without switching the currently open chat. */
  async forwardMessage(message: Message, targetPeerId: string): Promise<void> {
    try {
      const { source, attachment } = await this.write(async () => {
        const source = (await this.storage.getMessages(message.peerId)).find(
          (entry) => entry.id === message.id,
        );
        if (!source) throw new Error("这条消息已被删除，无法转发");
        if (source.kind === "text") return { source };
        if (
          source.status === "sending" ||
          source.status === "awaiting-acceptance"
        )
          throw new Error("附件传输尚未完成，请稍后转发");
        if (source.attachmentStorage === "external" || source.folder)
          throw new Error("此文件仅保留传输记录，请重新选择原文件发送");
        const attachment = this.storage.getAttachmentSource
          ? await this.storage.getAttachmentSource(source.id)
          : await this.storage.getAttachment(source.id);
        if (!attachment || attachment.size !== source.size)
          throw new Error("附件尚未接收完成或已被清除，无法转发");
        return { source, attachment };
      });
      if (this.snapshot.availability !== "online")
        throw new Error("请先上线，再转发消息");
      if (
        targetPeerId === this.snapshot.profile.id ||
        !this.peerProfile(targetPeerId)
      )
        throw new Error("未找到聊天对象，请刷新后重试");
      let sent: boolean;
      if (source.kind === "text") {
        sent = await this.sendText(source.text || "", targetPeerId);
      } else {
        const file: AttachmentSource =
          attachment instanceof Blob
            ? new File([attachment], source.fileName || "附件", {
                type: source.mimeType || attachment.type,
              })
            : {
                name: source.fileName || "附件",
                type: source.mimeType || attachment!.type,
                size: attachment!.size,
                slice: (start, end) => attachment!.slice(start, end),
              };
        sent = await this.sendAttachments([file], targetPeerId, source.kind);
      }
      if (!sent) throw new Error("转发未完成，传输已中断，请重试");
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
  async sendText(
    text: string,
    peerId = this.snapshot.activePeerId,
  ): Promise<boolean> {
    const value = text.trim();
    if (!peerId || !value) return false;
    if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) {
      const error = new Error("消息太长了，请分成几条发送");
      this.showError(error);
      throw error;
    }
    // readyChannel rebuilds only this peer; other conversations stay connected.
    const message: Message = {
      id: newId(),
      peerId,
      senderId: this.snapshot.profile.id,
      kind: "text",
      text: value,
      createdAt: Date.now(),
      status: "sending",
    };
    runtimeLog("info", "message", "准备发送文字", {
      peerId,
      detail: message.id,
    });
    this.outgoing.set(message.id, { peerId, message });
    try {
      await this.recordMessage(message);
      const { channel } = await this.readyChannel(peerId);
      if (!this.outgoing.has(message.id)) return false;
      this.sendControl(channel, {
        type: "text",
        id: message.id,
        text: value,
        createdAt: message.createdAt,
      });
      await this.recordMessage({ ...message, status: "sent" });
      this.armAck(message.id);
      return (
        this.outgoing.has(message.id) ||
        this.knownMessages.get(message.id)?.status === "delivered"
      );
    } catch (error) {
      await this.failOutgoing(message.id, errorMessage(error));
      if (this.deletedMessages.has(message.id)) return false;
      this.showError(error);
      throw error;
    }
  }
  async sendFolder(
    read: ReadFolder,
    report: (progress: FolderProgress | null) => void,
    signal: AbortSignal,
    peerId = this.snapshot.activePeerId,
  ): Promise<boolean> {
    if (!peerId) return false;
    if (this.movingStorage) throw new Error("正在迁移存储，请稍后重试");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.preparations.set(controller, peerId);
    this.patch({});
    try {
      controller.signal.throwIfAborted();
      const folder = await read(controller.signal, report);
      controller.signal.throwIfAborted();
      const stats = inspectFolder(folder);
      let archive: File | undefined;
      if (stats.compress && !this.storage.createFolderDestination) {
        report({ phase: "compressing", ...stats });
        archive = await compressFolder(folder, controller.signal);
      }
      controller.signal.throwIfAborted();
      report(null);
      // Starting the transfer immediately registers its outgoing record.
      return await (archive
        ? this.sendFiles([archive], peerId)
        : this.sendDirectory(folder, stats, peerId));
    } finally {
      this.preparations.delete(controller);
      signal.removeEventListener("abort", abort);
      this.patch({});
    }
  }

  private async sendDirectory(
    folder: FolderSelection,
    stats: ReturnType<typeof inspectFolder>,
    peerId: string,
  ): Promise<boolean> {
    // A failed peer is rebuilt independently by readyChannel.
    const message: Message = {
      id: newId(),
      peerId,
      senderId: this.snapshot.profile.id,
      kind: "file",
      fileName: folder.name,
      size: stats.size,
      createdAt: Date.now(),
      status: "awaiting-acceptance",
      attachmentStorage: "external",
      folder: {
        fileCount: stats.fileCount,
        directoryCount: stats.directoryCount,
      },
    };
    const outgoing: OutgoingTransfer = { peerId, message };
    this.outgoing.set(message.id, outgoing);
    try {
      await this.recordMessage(message);
      if (!this.outgoing.has(message.id)) return false;
      this.progress(message.id, 0);
      const { channel } = await this.readyChannel(peerId);
      const check = () => {
        if (this.outgoing.get(message.id) !== outgoing)
          throw new Error(outgoing.failureReason || "文件传输已取消");
      };
      check();
      this.sendControl(channel, {
        type: "folder-start",
        id: message.id,
        fileName: folder.name,
        size: stats.size,
        fileCount: stats.fileCount,
        directoryCount: stats.directoryCount,
        createdAt: message.createdAt,
      });
      await this.waitForTransfer(
        message.id,
        (t) => !!t.folderSupported,
        FOLDER_CONFIG.supportTimeoutMs,
        "对方暂不支持接收文件夹，请更新后重试",
      );
      await this.waitForTransfer(
        message.id,
        (t) => !!t.accepted,
        TRANSFER_CONFIG.consentTimeoutMs,
        "对方未确认接收，请重新发送",
      );
      message.status = "sending";
      await this.recordMessage(message);
      const chunkSize = fileChunkSize(channel);
      let sequence = 0;
      let sent = 0;
      let reported = -1;
      for (let index = 0; index < folder.entries.length; index++) {
        check();
        const entry = folder.entries[index];
        outgoing.folderIndex = index;
        outgoing.entryEnded = false;
        await this.waitForBuffer(channel);
        check();
        this.sendControl(channel, {
          type: "folder-entry",
          id: message.id,
          index,
          path: entry.path,
          kind: entry.kind,
          size: entry.kind === "file" ? entry.file.size : 0,
        });
        await this.waitForTransfer(
          message.id,
          (t) => t.entryReady === index,
          TRANSFER_CONFIG.timeoutMs,
          "文件传输超时",
        );
        if (entry.kind === "file") {
          for (
            let offset = 0;
            offset < entry.file.size;
            offset += chunkSize
          ) {
            check();
            await this.waitForBuffer(channel);
            await this.waitForTransfer(
              message.id,
              (t) =>
                sent <
                (t.receivedBytes || 0) + TRANSFER_CONFIG.streamWindowBytes,
              TRANSFER_CONFIG.timeoutMs,
              "文件传输超时",
            );
            const chunk = await entry.file
              .slice(offset, offset + chunkSize)
              .arrayBuffer();
            check();
            if (
              chunk.byteLength !==
              Math.min(chunkSize, entry.file.size - offset)
            )
              throw new Error("文件已发生变化，请重新选择文件夹");
            channel.send(encodeChunk(message.id, sequence++, chunk));
            sent += chunk.byteLength;
            outgoing.sentBytes = sent;
            const percentage = Math.min(
              99,
              Math.floor((sent / Math.max(stats.size, 1)) * 100),
            );
            if (reported !== percentage) {
              reported = percentage;
              this.progress(message.id, percentage);
            }
          }
        }
        check();
        outgoing.entryEnded = true;
        this.sendControl(channel, {
          type: "folder-entry-end",
          id: message.id,
          index,
        });
        await this.waitForTransfer(
          message.id,
          (t) => t.entrySaved === index,
          TRANSFER_CONFIG.timeoutMs,
          "文件传输超时",
        );
        if (!stats.size)
          this.progress(
            message.id,
            Math.min(
              99,
              Math.floor(((index + 1) / folder.entries.length) * 100),
            ),
          );
      }
      check();
      outgoing.finished = true;
      this.sendControl(channel, { type: "folder-end", id: message.id });
      await this.recordMessage({ ...message, status: "sent" });
      this.armAck(message.id);
      return (
        this.outgoing.has(message.id) ||
        this.knownMessages.get(message.id)?.status === "delivered"
      );
    } catch (error) {
      await this.failOutgoing(message.id, errorMessage(error));
      if (this.deletedMessages.has(message.id)) return false;
      throw error;
    }
  }

  async sendFiles(
    files: File[],
    peerId = this.snapshot.activePeerId,
  ): Promise<boolean> {
    return this.sendAttachments(files, peerId);
  }
  private async sendAttachments(
    files: AttachmentSource[],
    peerId: string | null,
    kind?: "image" | "file",
  ): Promise<boolean> {
    if (!peerId || files.length === 0) return false;
    if (this.movingStorage) throw new Error("正在迁移存储，请稍后重试");
    const tooLarge = files.find(
      (file) =>
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_TRANSFER_SIZE,
    );
    if (tooLarge) {
      const error = new Error("文件过大，无法传输，请拆分后发送");
      this.showError(error);
      throw error;
    }
    // Publish every request immediately; each file waits for its own consent.
    const sent = await Promise.all(
      files.map((file) => this.sendAttachment(file, peerId, kind)),
    );
    return sent.every(Boolean);
  }

  private async sendAttachment(
    file: AttachmentSource,
    peerId: string,
    kind?: "image" | "file",
  ): Promise<boolean> {
    const historyRevision = this.historyRevision;
    const peerRevision = this.peerHistoryRevisions.get(peerId) || 0;
    const streaming = file.size > MAX_FILE_SIZE;
    const external = streaming && !this.storage.createFileDestination;
    const message: Message = {
      id: newId(),
      peerId,
      senderId: this.snapshot.profile.id,
      kind: streaming
        ? "file"
        : kind || (imageTypes.test(file.type) ? "image" : "file"),
      fileName: file.name.slice(0, 255) || "未命名文件",
      mimeType: file.type.slice(0, 128) || "application/octet-stream",
      size: file.size,
      createdAt: Date.now(),
      status: "awaiting-acceptance",
      ...(external
        ? { attachmentStorage: "external" as const }
        : this.storage.createFileDestination
          ? { attachmentStorage: "managed" as const }
          : {}),
    };
    runtimeLog("info", "message", "准备发送附件", {
      peerId,
      detail: message.id,
    });
    this.outgoing.set(message.id, { peerId, message });
    this.progress(message.id, 0);
    try {
      await this.recordMessage(message);
      if (!this.outgoing.has(message.id)) return false;
      this.progress(message.id, 0);
      const { channel } = await this.readyChannel(peerId);
      if (!this.outgoing.has(message.id)) return false;
      this.sendControl(channel, {
        type: "file-start",
        id: message.id,
        kind: message.kind as "image" | "file",
        fileName: message.fileName!,
        mimeType: message.mimeType!,
        size: file.size,
        createdAt: message.createdAt,
      });
      await this.waitForTransfer(
        message.id,
        (transfer) => !!transfer.accepted,
        TRANSFER_CONFIG.consentTimeoutMs,
        "对方未确认接收，请确认双方已更新并重新发送",
      );
      message.status = "sending";
      await this.recordMessage(message);
      const check = () => {
        if (!this.outgoing.has(message.id))
          throw new Error("文件传输已取消");
      };
      let destination: FileDestination | undefined;
      // Browsers keep only small attachments in IndexedDB. Desktop copies
      // each source block to disk while sending that same block to the peer.
      const cached: ArrayBuffer[] = [];
      const chunkSize = fileChunkSize(channel);
      let sequence = 0;
      let reported = -1;
      try {
        check();
        if (this.storage.createFileDestination)
          destination = await this.storage.createFileDestination(message);
        check();
        for (
          let offset = 0;
          offset < file.size;
          offset += STORAGE_CONFIG.chunkBytes
        ) {
          check();
          const block = await file
            .slice(
              offset,
              Math.min(offset + STORAGE_CONFIG.chunkBytes, file.size),
            )
            .arrayBuffer();
          check();
          if (
            block.byteLength !==
            Math.min(STORAGE_CONFIG.chunkBytes, file.size - offset)
          )
            throw new Error("文件已发生变化，请重新选择文件");
          if (!external && !destination && !(file instanceof Blob))
            cached.push(block);
          // Only one storage block is in flight. A slow disk or receiver
          // applies backpressure before the next source read.
          await Promise.all([
            destination?.write(new Blob([block])),
            (async () => {
              for (
                let start = 0;
                start < block.byteLength;
                start += chunkSize
              ) {
                check();
                await this.waitForBuffer(channel);
                if (streaming || this.outgoing.get(message.id)?.streaming)
                  await this.waitForTransfer(
                    message.id,
                    (transfer) =>
                      offset + start <
                      (transfer.receivedBytes || 0) +
                        TRANSFER_CONFIG.streamWindowBytes,
                    TRANSFER_CONFIG.timeoutMs,
                    "文件传输超时",
                  );
                check();
                const chunk = block.slice(start, start + chunkSize);
                channel.send(encodeChunk(message.id, sequence++, chunk));
                this.outgoing.get(message.id)!.sentBytes =
                  offset + start + chunk.byteLength;
                const percentage = Math.min(
                  99,
                  Math.floor(
                    ((offset + start + chunk.byteLength) / file.size) * 100,
                  ),
                );
                if (percentage !== reported) {
                  reported = percentage;
                  this.progress(message.id, percentage);
                }
              }
            })(),
          ]);
        }
        check();
        if (destination) await destination.close();
        else if (!external)
          await this.write(async () => {
            check();
            await this.storage.saveAttachment(
              message.id,
              file instanceof Blob
                ? file
                : new Blob(cached, { type: file.type }),
            );
          });
        check();
      } catch (error) {
        // Wake the network window waiter if disk writing failed, and keep
        // incomplete local copies out of history and attachment exports.
        await this.failOutgoing(message.id, errorMessage(error));
        await destination?.abort().catch(() => undefined);
        throw error;
      }
      await this.waitForBuffer(channel);
      if (!this.outgoing.has(message.id)) return false;
      this.outgoing.get(message.id)!.finished = true;
      this.sendControl(channel, { type: "file-end", id: message.id });
      await this.recordMessage({ ...message, status: "sent" });
      if (this.outgoing.has(message.id)) this.progress(message.id, 100);
      this.armAck(message.id);
      return (
        this.outgoing.has(message.id) ||
        this.knownMessages.get(message.id)?.status === "delivered"
      );
    } catch (error) {
      await this.failOutgoing(message.id, errorMessage(error));
      if (
        this.deletedMessages.has(message.id) ||
        this.historyRevision !== historyRevision ||
        (this.peerHistoryRevisions.get(peerId) || 0) !== peerRevision
      )
        return false;
      this.showError(error);
      throw error;
    }
  }

  private async alreadyReceived(id: string, peerId: string): Promise<boolean> {
    const cached = this.knownMessages.get(id);
    if (cached)
      return (
        cached.peerId === peerId &&
        cached.senderId === peerId &&
        cached.status === "delivered"
      );
    const stored =
      this.cache.get(peerId) ??
      (await this.write(() => this.storage.getMessages(peerId)));
    for (const message of stored)
      if (!this.knownMessages.has(message.id))
        this.knownMessages.set(message.id, message);
    const existing = this.knownMessages.get(id);
    return existing?.senderId === peerId && existing.status === "delivered";
  }
  private async handleData(link: PeerLink, raw: unknown) {
    if (this.links.get(link.peerId) !== link || !link.channel) return;
    const historyRevision = this.historyRevision;
    const peerRevision = this.peerHistoryRevisions.get(link.peerId) || 0;
    const channel = link.channel;
    if (raw instanceof ArrayBuffer) {
      const chunk = decodeChunk(raw);
      if (!chunk) return;
      const transfer = this.incoming.get(chunk.id);
      if (!transfer || transfer.peerId !== link.peerId) return;
      if (transfer.message.status === "awaiting-acceptance") {
        this.rejectFile(chunk.id, "尚未同意接收此文件");
        return;
      }
      if (
        chunk.sequence !== transfer.sequence ||
        transfer.received + chunk.data.byteLength > transfer.message.size!
      ) {
        this.failIncoming(chunk.id, "文件没有接收完整，请让对方重新发送");
        this.sendControl(channel, {
          type: "transfer-error",
          id: chunk.id,
          message: "文件数据不完整",
        });
        return;
      }
      // Count validated file activity without decoding/copying every chunk twice.
      this.receivedFromPeer(link);
      if (transfer.folder) {
        try {
          if (!transfer.destination)
            throw new Error("文件夹目录不完整，请重新发送");
          transfer.folder.receive(chunk.data.byteLength);
        } catch (error) {
          this.rejectFile(chunk.id, errorMessage(error));
          return;
        }
      }
      transfer.sequence++;
      transfer.received += chunk.data.byteLength;
      transfer.chunks.push(chunk.data);
      transfer.bufferedBytes =
        (transfer.bufferedBytes || 0) + chunk.data.byteLength;
      clearTimeout(transfer.timer);
      transfer.timer = setTimeout(
        () => this.rejectFile(chunk.id, "接收文件超时，请让对方重新发送"),
        TRANSFER_CONFIG.timeoutMs,
      );
      if (
        transfer.destination &&
        transfer.bufferedBytes >= TRANSFER_CONFIG.streamWindowBytes
      ) {
        try {
          await this.flushIncoming(transfer);
          if (this.incoming.get(chunk.id) !== transfer) return;
          this.sendControl(channel, {
            type: "file-progress",
            id: chunk.id,
            received: transfer.received,
          });
        } catch {
          this.rejectFile(chunk.id, "文件无法保存，请检查磁盘空间后重试");
          return;
        }
      }
      const percentage = Math.min(
        transfer.folder ? 99 : 100,
        Math.floor(
          (transfer.received / Math.max(transfer.message.size!, 1)) * 100,
        ),
      );
      if (this.snapshot.transfers[chunk.id] !== percentage)
        this.progress(chunk.id, percentage);
      return;
    }
    if (typeof raw !== "string") return;
    const packet = parseControlPacket(raw);
    if (!packet) return;
    if (packet.type === "peer-ping" || packet.type === "peer-pong") return;
    if (this.deletedMessages.has(packet.id)) return;
    if (
      packet.type === "folder-supported" ||
      packet.type === "folder-entry-ready" ||
      packet.type === "folder-entry-saved"
    ) {
      const transfer = this.outgoing.get(packet.id);
      if (!transfer?.message.folder || transfer.peerId !== link.peerId) return;
      if (packet.type === "folder-supported") transfer.folderSupported = true;
      else if (transfer.accepted && packet.index === transfer.folderIndex) {
        if (packet.type === "folder-entry-ready" && !transfer.entryEnded)
          transfer.entryReady = packet.index;
        if (packet.type === "folder-entry-saved" && transfer.entryEnded)
          transfer.entrySaved = packet.index;
      }
      transfer.wake?.();
      return;
    }
    if (packet.type === "file-accept" || packet.type === "file-progress") {
      const transfer = this.outgoing.get(packet.id);
      if (
        !transfer ||
        transfer.peerId !== link.peerId ||
        transfer.message.kind === "text"
      )
        return;
      if (packet.type === "file-accept") {
        transfer.accepted = true;
        transfer.streaming = packet.streaming === true;
      } else if (
        transfer.accepted &&
        packet.received > (transfer.receivedBytes || 0) &&
        packet.received <= (transfer.sentBytes || 0)
      )
        transfer.receivedBytes = packet.received;
      transfer.wake?.();
      return;
    }
    if (packet.type === "ack") {
      const outgoing = this.outgoing.get(packet.id);
      if (!outgoing || outgoing.peerId !== link.peerId) return;
      if (outgoing.message.kind !== "text" && !outgoing.finished) return;
      runtimeLog("info", "message", "对方已确认收到", {
        peerId: link.peerId,
        detail: packet.id,
      });
      clearTimeout(outgoing.timer);
      try {
        await this.recordMessage({ ...outgoing.message, status: "delivered" });
        if (this.outgoing.get(packet.id) === outgoing)
          this.outgoing.delete(packet.id);
        this.progress(packet.id, null);
      } catch (error) {
        await this.failOutgoing(packet.id, errorMessage(error));
        throw error;
      }
      return;
    }
    if (packet.type === "transfer-error") {
      const transfer = this.outgoing.get(packet.id);
      if (transfer?.peerId === link.peerId)
        await this.failOutgoing(packet.id, packet.message);
      if (this.incoming.get(packet.id)?.peerId === link.peerId)
        this.failIncoming(packet.id, packet.message);
      return;
    }
    if (
      packet.type === "folder-entry" ||
      packet.type === "folder-entry-end" ||
      packet.type === "folder-end"
    ) {
      const transfer = this.incoming.get(packet.id);
      if (!transfer?.folder || transfer.peerId !== link.peerId) return;
      if (transfer.message.status === "awaiting-acceptance") {
        this.rejectFile(packet.id, "尚未同意接收此文件");
        return;
      }
      this.refreshIncomingTimer(transfer);
      try {
        if (packet.type === "folder-entry") {
          const destination = await transfer.folder.begin(packet);
          if (this.incoming.get(packet.id) !== transfer) {
            await destination?.abort().catch(() => undefined);
            return;
          }
          transfer.destination = destination;
          this.sendControl(channel, {
            type: "folder-entry-ready",
            id: packet.id,
            index: packet.index,
          });
        } else if (packet.type === "folder-entry-end") {
          transfer.folder.checkEnd(packet.index);
          if (transfer.destination) {
            await this.flushIncoming(transfer);
            if (this.incoming.get(packet.id) !== transfer) return;
            await transfer.destination.close();
            transfer.destination = undefined;
          }
          if (this.incoming.get(packet.id) !== transfer) return;
          transfer.folder.finishEntry();
          this.sendControl(channel, {
            type: "file-progress",
            id: packet.id,
            received: transfer.received,
          });
          this.sendControl(channel, {
            type: "folder-entry-saved",
            id: packet.id,
            index: packet.index,
          });
          if (!transfer.message.size)
            this.progress(
              packet.id,
              Math.min(
                99,
                Math.floor(
                  (transfer.folder.completed /
                    Math.max(
                      transfer.message.folder!.fileCount +
                        transfer.message.folder!.directoryCount,
                      1,
                    )) *
                    100,
                ),
              ),
            );
        } else {
          if (
            !transfer.folder.complete() ||
            transfer.received !== transfer.message.size
          )
            throw new Error("文件夹接收不完整，请重新发送");
          await transfer.folder.destination?.close?.();
          if (this.incoming.get(packet.id) !== transfer) return;
          await this.recordMessage({
            ...transfer.message,
            status: "delivered",
          });
          if (this.incoming.get(packet.id) !== transfer) return;
          clearTimeout(transfer.timer);
          this.incoming.delete(packet.id);
          this.progress(packet.id, null);
          this.sendControl(channel, { type: "ack", id: packet.id });
        }
      } catch (error) {
        this.rejectFile(
          packet.id,
          error instanceof DOMException
            ? "文件夹无法保存，请检查保存权限和磁盘空间后重试"
            : errorMessage(error),
        );
      }
      return;
    }
    if (
      packet.type === "text" ||
      packet.type === "file-start" ||
      packet.type === "folder-start"
    ) {
      const received = await this.alreadyReceived(packet.id, link.peerId);
      if (
        this.links.get(link.peerId) !== link ||
        this.deletedMessages.has(packet.id) ||
        this.historyRevision !== historyRevision ||
        (this.peerHistoryRevisions.get(link.peerId) || 0) !== peerRevision
      )
        return;
      if (received) {
        this.sendControl(channel, { type: "ack", id: packet.id });
        return;
      }
      // Never allow a sender to overwrite another peer's messages or this device's outgoing IDs.
      const existing = this.knownMessages.get(packet.id);
      if (
        existing &&
        (existing.peerId !== link.peerId || existing.senderId !== link.peerId)
      )
        return;
    }
    if (packet.type === "text") {
      const message: Message = {
        id: packet.id,
        peerId: link.peerId,
        senderId: link.peerId,
        kind: "text",
        text: packet.text,
        createdAt: Math.min(
          packet.createdAt,
          Date.now() + TRANSFER_CONFIG.maxFutureTimestampMs,
        ),
        status: "delivered",
      };
      try {
        await this.recordMessage(message, true);
        this.sendControl(channel, { type: "ack", id: packet.id });
      } catch {
        this.sendControl(channel, {
          type: "transfer-error",
          id: packet.id,
          message: "对方暂时无法保存消息，请让对方检查浏览器空间",
        });
      }
      return;
    }
    if (packet.type === "file-start" || packet.type === "folder-start") {
      const folder = packet.type === "folder-start";
      const managed = !!(folder
        ? this.storage.createFolderDestination
        : this.storage.createFileDestination);
      const external = !managed && (folder || packet.size > MAX_FILE_SIZE);
      const autoAccept =
        !external &&
        this.snapshot.conversations.some(
          (conversation) =>
            conversation.peer.id === link.peerId &&
            conversation.autoAcceptFiles === true,
        );
      const reserved = [...this.incoming.values()].reduce(
        (sum, transfer) =>
          sum +
          (transfer.message.attachmentStorage
            ? TRANSFER_CONFIG.streamWindowBytes
            : transfer.message.size || 0),
        0,
      );
      if (
        this.movingStorage ||
        this.incoming.has(packet.id) ||
        this.incoming.size >= TRANSFER_CONFIG.maxIncomingFiles ||
        reserved +
          (external || managed
            ? TRANSFER_CONFIG.streamWindowBytes
            : packet.size) >
          TRANSFER_CONFIG.maxReservedBytes
      ) {
        this.sendControl(channel, {
          type: "transfer-error",
          id: packet.id,
          message: "接收任务过多，请稍后重试",
        });
        return;
      }
      const message: Message = {
        id: packet.id,
        peerId: link.peerId,
        senderId: link.peerId,
        kind:
          packet.size <= MAX_FILE_SIZE &&
          packet.type === "file-start" &&
          packet.kind === "image" &&
          imageTypes.test(packet.mimeType)
            ? "image"
            : "file",
        fileName: packet.fileName,
        mimeType: packet.type === "file-start" ? packet.mimeType : undefined,
        size: packet.size,
        createdAt: Math.min(
          packet.createdAt,
          Date.now() + TRANSFER_CONFIG.maxFutureTimestampMs,
        ),
        status: autoAccept && !managed ? "sending" : "awaiting-acceptance",
        ...(external
          ? { attachmentStorage: "external" as const }
          : managed
            ? { attachmentStorage: "managed" as const }
            : {}),
        ...(packet.type === "folder-start"
          ? {
              folder: {
                fileCount: packet.fileCount,
                directoryCount: packet.directoryCount,
              },
            }
          : {}),
      };
      const transfer: IncomingTransfer = {
        peerId: link.peerId,
        message,
        received: 0,
        sequence: 0,
        chunks: [],
        ...(packet.type === "folder-start"
          ? { folder: new FolderReceiver(packet) }
          : {}),
        timer: setTimeout(
          () =>
            this.rejectFile(
              packet.id,
              autoAccept
                ? "接收文件超时，请让对方重新发送"
                : "等待接收确认已超时，请重新发送",
            ),
          autoAccept
            ? TRANSFER_CONFIG.timeoutMs
            : TRANSFER_CONFIG.consentTimeoutMs,
        ),
      };
      this.incoming.set(packet.id, transfer);
      this.progress(packet.id, 0);
      try {
        await this.recordMessage(message, true);
        if (autoAccept && this.incoming.get(packet.id) === transfer) {
          if (managed) await this.acceptFile(packet.id);
          else
            this.sendControl(channel, { type: "file-accept", id: packet.id });
        }
        if (folder && this.incoming.get(packet.id) === transfer)
          this.sendControl(channel, {
            type: "folder-supported",
            id: packet.id,
          });
      } catch {
        this.failIncoming(
          packet.id,
          managed
            ? "文件无法保存，请检查磁盘空间后重试"
            : "浏览器空间不足，请先下载重要文件，再清理不需要的记录",
        );
        this.sendControl(channel, {
          type: "transfer-error",
          id: packet.id,
          message: "文件无法保存，请检查磁盘空间后重试",
        });
      }
      return;
    }
    if (packet.type === "file-end") {
      const transfer = this.incoming.get(packet.id);
      if (!transfer || transfer.peerId !== link.peerId) return;
      if (transfer.folder) {
        this.rejectFile(packet.id, "文件夹接收不完整，请重新发送");
        return;
      }
      if (transfer.message.status === "awaiting-acceptance") {
        this.rejectFile(packet.id, "尚未同意接收此文件");
        return;
      }
      if (transfer.received !== transfer.message.size) {
        this.failIncoming(packet.id, "文件接收不完整，未保存附件");
        this.sendControl(channel, {
          type: "transfer-error",
          id: packet.id,
          message: "文件接收不完整",
        });
        return;
      }
      clearTimeout(transfer.timer);
      transfer.timer = setTimeout(
        () => this.rejectFile(packet.id, "文件传输超时"),
        TRANSFER_CONFIG.timeoutMs,
      );
      try {
        if (transfer.destination) {
          await this.flushIncoming(transfer);
          if (this.incoming.get(packet.id) !== transfer) return;
          await transfer.destination.close();
          transfer.destination = undefined;
        } else {
          const blob = new Blob(transfer.chunks, {
            type: transfer.message.mimeType,
          });
          transfer.chunks = [];
          await this.write(async () => {
            if (this.incoming.get(packet.id) === transfer)
              await this.storage.saveAttachment(packet.id, blob);
          });
        }
        if (this.incoming.get(packet.id) !== transfer) return;
        await this.recordMessage({ ...transfer.message, status: "delivered" });
        if (this.incoming.get(packet.id) !== transfer) return;
        clearTimeout(transfer.timer);
        this.incoming.delete(packet.id);
        this.progress(packet.id, null);
        this.sendControl(channel, { type: "ack", id: packet.id });
      } catch {
        this.rejectFile(
          packet.id,
          transfer.message.attachmentStorage
            ? "文件无法保存，请检查磁盘空间后重试"
            : "对方暂时无法保存附件，请让对方检查浏览器空间",
        );
      }
    }
  }
  private failIncoming(id: string, reason: string) {
    const transfer = this.incoming.get(id);
    if (!transfer) return;
    clearTimeout(transfer.timer);
    this.abortDestination(transfer);
    transfer.chunks = [];
    this.incoming.delete(id);
    this.progress(id, null);
    void this.recordMessage({
      ...transfer.message,
      status: "failed",
      error: reason,
    }).catch((error) => this.showError(error));
  }
  private abortDestination(transfer: IncomingTransfer) {
    const destination = transfer.destination;
    transfer.destination = undefined;
    if (destination) void destination.abort().catch(() => undefined);
    const folder = transfer.folder?.destination;
    if (folder?.abort) void folder.abort().catch(() => undefined);
  }
  private async flushIncoming(transfer: IncomingTransfer) {
    if (!transfer.chunks.length) return;
    const blob = new Blob(transfer.chunks);
    transfer.chunks = [];
    transfer.bufferedBytes = 0;
    await transfer.destination!.write(blob);
  }
  private refreshIncomingTimer(transfer: IncomingTransfer) {
    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(
      () =>
        this.rejectFile(transfer.message.id, "接收文件超时，请让对方重新发送"),
      TRANSFER_CONFIG.timeoutMs,
    );
  }
  /** Accept into managed storage, or into an explicitly selected browser destination. */
  async acceptFile(id: string, destination?: FileDestination): Promise<void> {
    return this.acceptDestination(id, destination);
  }
  async acceptFolder(
    id: string,
    destination: FolderDestination,
  ): Promise<void> {
    return this.acceptDestination(id, undefined, destination);
  }
  private async acceptDestination(
    id: string,
    destination?: FileDestination,
    folderDestination?: FolderDestination,
  ): Promise<void> {
    const transfer = this.incoming.get(id);
    const channel = transfer && this.links.get(transfer.peerId)?.channel;
    const managed = transfer?.message.attachmentStorage === "managed";
    if (
      !transfer ||
      transfer.message.status !== "awaiting-acceptance" ||
      transfer.accepting ||
      (managed && (!!destination || !!folderDestination)) ||
      (!managed && !!transfer.folder !== !!folderDestination) ||
      (!managed &&
        !transfer.folder &&
        (transfer.message.attachmentStorage === "external") !==
          !!destination) ||
      channel?.readyState !== "open"
    ) {
      await destination?.abort().catch(() => undefined);
      await folderDestination?.abort?.().catch(() => undefined);
      throw new Error("文件传输已取消");
    }
    transfer.accepting = true;
    try {
      if (managed) {
        if (transfer.folder)
          folderDestination = await this.storage.createFolderDestination!(
            transfer.message,
          );
        else
          destination = await this.storage.createFileDestination!(
            transfer.message,
          );
      }
      if (this.incoming.get(id) !== transfer) {
        await destination?.abort().catch(() => undefined);
        await folderDestination?.abort?.().catch(() => undefined);
        return;
      }
      transfer.destination = destination;
      if (transfer.folder) transfer.folder.destination = folderDestination;
      const message: Message = { ...transfer.message, status: "sending" };
      await this.recordMessage(message);
      if (this.incoming.get(id) !== transfer) return;
      transfer.message = message;
      clearTimeout(transfer.timer);
      transfer.timer = setTimeout(
        () => this.rejectFile(id, "接收文件超时，请让对方重新发送"),
        TRANSFER_CONFIG.timeoutMs,
      );
      this.sendControl(channel, {
        type: "file-accept",
        id,
        ...(managed ? { streaming: true } : {}),
      });
    } catch (error) {
      this.rejectFile(id, "文件无法保存，请检查磁盘空间后重试");
      throw error;
    }
  }
  rejectFile(id: string, reason = "对方已拒绝接收此文件") {
    const transfer = this.incoming.get(id);
    if (!transfer) return;
    this.failIncoming(id, reason);
    this.notifyTransferError(transfer.peerId, id, reason);
  }
  async cancelTransfer(id: string) {
    if (this.incoming.has(id)) this.rejectFile(id, "文件传输已取消");
    const outgoing = this.outgoing.get(id);
    if (outgoing) {
      await this.failOutgoing(id, "文件传输已取消");
    }
  }
  getAttachment(id: string) {
    return this.storage.getAttachment(id);
  }
  deleteMessage(id: string): Promise<void> {
    return this.deleteMessages([id]);
  }
  async deleteMessages(ids: string[]): Promise<void> {
    const selected = new Set(ids);
    if (!selected.size) return;
    try {
      await this.write(async () => {
        // Do not cancel transfers or change visible state until the atomic deletion succeeds.
        await this.storage.deleteMessages([...selected]);
        const transfers = { ...this.snapshot.transfers };
        for (const id of selected) {
          this.deletedMessages.add(id);
          this.knownMessages.delete(id);
          const incoming = this.incoming.get(id);
          if (incoming) {
            clearTimeout(incoming.timer);
            this.abortDestination(incoming);
            this.notifyFileCancellation(id, incoming);
            incoming.chunks = [];
            this.incoming.delete(id);
          }
          const outgoing = this.outgoing.get(id);
          if (outgoing) {
            clearTimeout(outgoing.timer);
            this.notifyFileCancellation(id, outgoing);
            this.outgoing.delete(id);
            outgoing.wake?.();
          }
          delete transfers[id];
        }
        for (const [peerId, messages] of this.cache)
          this.cache.set(
            peerId,
            messages.filter((message) => !selected.has(message.id)),
          );
        this.patch({
          messages: this.snapshot.messages.filter(
            (message) => !selected.has(message.id),
          ),
          transfers,
        });
      });
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
  private cancelPeerTransfers(peerId: string) {
    for (const [controller, preparingPeer] of this.preparations)
      if (preparingPeer === peerId) controller.abort();
    for (const [id, transfer] of this.incoming)
      if (transfer.peerId === peerId) {
        clearTimeout(transfer.timer);
        this.abortDestination(transfer);
        this.notifyFileCancellation(id, transfer);
        transfer.chunks = [];
        this.incoming.delete(id);
        this.progress(id, null);
      }
    for (const [id, transfer] of this.outgoing)
      if (transfer.peerId === peerId) {
        clearTimeout(transfer.timer);
        this.notifyFileCancellation(id, transfer);
        this.outgoing.delete(id);
        transfer.wake?.();
        this.progress(id, null);
      }
  }
  private notifyFileCancellation(
    id: string,
    transfer: { peerId: string; message: Message },
  ) {
    if (transfer.message.kind !== "text")
      this.notifyTransferError(transfer.peerId, id, "文件传输已取消");
  }
  private notifyTransferError(peerId: string, id: string, reason: string) {
    const channel = this.links.get(peerId)?.channel;
    if (channel?.readyState !== "open") return;
    try {
      this.sendControl(channel, {
        type: "transfer-error",
        id,
        message: reason.slice(0, 250),
      });
    } catch {
      // A closing/full channel must not interrupt local cancellation or cleanup.
    }
  }
  async deleteConversation(peerId: string) {
    this.peerHistoryRevisions.set(
      peerId,
      (this.peerHistoryRevisions.get(peerId) || 0) + 1,
    );
    this.cancelPeerTransfers(peerId);
    try {
      await this.write(async () => {
        await this.storage.deleteConversation(peerId);
        this.cache.delete(peerId);
        for (const [id, message] of this.knownMessages)
          if (message.peerId === peerId) this.knownMessages.delete(id);
        this.patch({
          conversations: this.snapshot.conversations.filter(
            (c) => c.peer.id !== peerId,
          ),
          ...(this.snapshot.activePeerId === peerId
            ? { activePeerId: null, messages: [] }
            : {}),
        });
      });
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
  async clearHistory() {
    this.historyRevision++;
    for (const controller of this.preparations.keys()) controller.abort();
    for (const peerId of new Set(
      [...this.incoming.values(), ...this.outgoing.values()].map(
        (t) => t.peerId,
      ),
    ))
      this.cancelPeerTransfers(peerId);
    try {
      await this.write(async () => {
        await this.storage.clearHistory();
        this.cache.clear();
        this.knownMessages.clear();
        this.patch({
          conversations: [],
          messages: [],
          activePeerId: null,
          transfers: {},
        });
      });
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
}

export async function createChatEngine(
  storage?: StorageAdapter,
  network?: NetworkAdapters,
): Promise<ChatEngine> {
  const adapter = storage ?? (await createStorageAdapter());
  let profile = await adapter.getProfile();
  if (!profile || !isProfile(profile)) {
    profile = defaultProfile();
    await adapter.saveProfile(profile);
  }
  const clientType = isDesktop() ? "app" : "web";
  if (profile.clientType !== clientType) {
    profile = { ...profile, clientType };
    await adapter.saveProfile(profile);
  }
  const adapters = network ?? (await defaultNetwork());
  if (!adapters.discovery.supportsNumericIds && profile.numericId) {
    profile = { ...profile, numericId: undefined };
    await adapter.saveProfile(profile);
  }
  return new ChatEngine(
    adapter,
    profile,
    await adapter.getConversations(),
    adapters,
  );
}
