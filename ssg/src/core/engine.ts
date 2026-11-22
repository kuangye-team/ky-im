import { isNative } from "../platform";
import { storageUsage } from "./storage/usage";
import { fitsProfileResponse } from "./profile-wire";
import { localMessageSize } from "./network/libp2p/rtc-limits";
import { PeerConnections } from "./peer-connections";
import { ChatHistory } from "./history";
import { DeviceDiscovery } from "./discovery";
import {
  PROFILE_AVATARS,
  PROFILE_COLORS,
  SIGNALING_CONFIG,
  STORAGE_CONFIG
} from "../config";
import { readLanguagePreference, resolveLanguage } from "../i18n/language";
import { detectDevice, nativeClientType, nativeTargetDevice } from "../device-platform";
import { runtimeLog, setLogRuntime } from "../runtime-logs";
import { CompatibilityError, localRuntime, type RuntimeInfo } from "./capabilities";
import { generateNumericId } from "./device-number";
import { identityFor } from "./network/libp2p/identity";
import { errorMessage } from "./transfers/io";
import {
  readSettings,
  saveSettings,
  validateSettings,
  type NetworkSettings,
} from "./network/settings";
import {
  generateProfileBio,
  generateProfileName,
  randomChoice,
} from "./profile";
import {
  isNumericId,
  isProfile,
  newId,
} from "./protocol";
import { createStorageAdapter } from "./storage";
import { TransferService, type TransferCommands } from "./transfers/service";
import type {
  Availability,
  ChatSnapshot,
  Conversation,
  Profile,
  StorageAdapter
} from "./types";

import {
  browserNetwork,
  defaultNetwork,
  type NetworkAdapters,
} from "./network";

export { MAX_REMARK_LENGTH } from "../config";
export { MAX_BUFFERED_FILE_BYTES } from "./protocol";
function savedAvailability(): Availability {
  try {
    return localStorage.getItem(STORAGE_CONFIG.availabilityKey) === "offline"
      ? "offline"
      : "online";
  } catch {
    return "online";
  }
}

function defaultProfile(platform: Pick<Profile, "device" | "clientType">): Profile {
  const language = resolveLanguage(readLanguagePreference());
  return {
    id: newId(),
    numericId: generateNumericId(),
    name: generateProfileName(language),
    bio: generateProfileBio(language),
    avatar: randomChoice(PROFILE_AVATARS),
    color: randomChoice(PROFILE_COLORS),
    ...platform,
    ...localRuntime(),
  };
}

/** Discovery, transport, and storage are independent; payloads only use the transport. */
export class ChatEngine {
  private readonly transferService: TransferService;
  get transfers(): TransferCommands { return this.transferService; }
  readonly storage: StorageAdapter;
  private readonly discovery: DeviceDiscovery;
  queryPeerRuntime(peerId: string) {
    return this.discovery.queryPeerRuntime(peerId);
  }
  private movingStorage = false;
  private snapshot: ChatSnapshot;
  private readonly cachedProfiles = new Map<string, Profile>();
  private listeners = new Set<() => void>();
  private readonly connections: PeerConnections;
  private readonly history: ChatHistory;
  private resettingData = false;
  private running = false;
  private numberRefresh?: Promise<void>;
  private readonly networkChangeListeners = new Set<() => void>();
  private browserConnection?: EventTarget;
  private networkChangeTimer?: ReturnType<typeof setTimeout>;
  private readonly onNetworkChange = () => {
    if (!this.running || this.networkChangeTimer !== undefined) return;
    this.networkChangeTimer = setTimeout(() => {
      this.networkChangeTimer = undefined;
      if (this.network.discovery.usesBrowserNetworkStatus && navigator.onLine === false) return;
      this.discovery.recheckNetwork();
      this.connections.checkPeers(true);
      for (const listener of this.networkChangeListeners) listener();
    }, SIGNALING_CONFIG.networkChangeDelayMs);
  };
  private readonly onVisible = () => {
    if (document.visibilityState === "visible") {
      this.discovery.checkHeartbeat(true);
      this.connections.checkPeers(true);
    }
  };
  private readonly onOffline = () => {
    if (this.network.discovery.usesBrowserNetworkStatus) this.disconnect(true);
  };

  constructor(
    storage: StorageAdapter,
    profile: Profile,
    conversations: Conversation[],
    private network: NetworkAdapters = browserNetwork(),
    cachedProfiles: Profile[] = [],
  ) {
    // A saved chat can carry a newly resolved number for the same profile revision.
    for (const peer of [...cachedProfiles, ...conversations.map(c => c.peer)]) {
      if (isProfile(peer) && peer.revision && peer.revision >= (this.cachedProfiles.get(peer.id)?.revision ?? 0)) {
        this.cachedProfiles.set(peer.id, peer);
      }
    }
    this.storage = storage;
    this.snapshot = {
      profile: { ...profile, revision: profile.revision ?? 1, ...this.getRuntimeInfo() },
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
    setLogRuntime(this.snapshot.profile);
    const engine = this;
    const actions = {
      patch: (values: Partial<ChatSnapshot>) => this.patch(values),
      peerProfile: (id: string) => this.peerProfile(id),
      showError: (error: unknown) => this.showError(error),
      getRuntimeInfo: () => this.getRuntimeInfo(),
    };
    this.history = new ChatHistory(storage, {
      ...actions,
      get snapshot() { return engine.snapshot; },
      get resettingData() { return engine.resettingData; },
      get transfers() { return engine.transferService; },
    });
    this.discovery = new DeviceDiscovery({
      ...actions,
      get snapshot() { return engine.snapshot; },
      get adapter() { return engine.network.discovery; },
      get running() { return engine.running; },
      isDiscovered: id => this.connections.isDiscovered(id),
      peerJoined: id => this.connections.peerJoined(id),
      updatePeers: (peers, removed, replaceAll) => this.connections.updatePeers(peers, removed, replaceAll),
      refreshPeer: (peer, remember) => {
        let profile = this.cachedProfiles.get(peer.id) ?? peer;
        if (remember && profile.numericId !== peer.numericId) {
          profile = { ...profile, numericId: peer.numericId };
          this.cachedProfiles.set(peer.id, profile);
        }
        return this.history.refreshPeer(profile, remember);
      },
      ensureLink: id => this.connections.ensureLink(id),
      networkChanged: this.onNetworkChange,
      stop: () => this.stop(),
    });
    this.connections = new PeerConnections({
      ...actions,
      get transport() { return engine.network.transport; },
      get snapshot() { return engine.snapshot; },
      get running() { return engine.running; },
      get transfers() { return engine.transferService; },
      history: this.history,
      discovery: this.discovery,
    });
    this.transferService = new TransferService({
      ...actions,
      storage,
      history: this.history,
      get snapshot() { return engine.snapshot; },
      get movingStorage() { return engine.movingStorage; },
      links: this.connections.links,
      withFileLane: (peer, id, action) => this.connections.withFileLane(peer, id, action),
      readyChannel: peer => this.connections.readyChannel(peer),
      ensureLink: (peer, initiate, background) => this.connections.ensureLink(peer, initiate, background),
      failLink: (link, reason, offline) => {
        const current = this.connections.links.get(link.peerId);
        if (current === link) this.connections.failLink(current, reason, offline);
      },
      receivedFromPeer: link => {
        const current = this.connections.links.get(link.peerId);
        if (current === link) this.connections.receivedFromPeer(current);
      },
      retryAt: peer => this.connections.retryAt(peer),
    });
    this.bindIncoming();
  }

  private bindIncoming() {
    this.network.transport.cachedProfile = id => this.cachedProfiles.get(id);
    this.network.transport.publish?.(this.snapshot.profile);
    this.network.transport.onProfile = profile => {
      if (!this.running || !this.peerProfile(profile.id)) return;
      const previous = this.peerProfile(profile.id);
      if ((previous?.revision ?? 0) >= (profile.revision ?? 0)) return;
      this.cachedProfiles.set(profile.id, profile);
      void this.history.write(async () => this.storage.savePeerProfile?.(profile)).catch(error => this.showError(error));
      this.connections.updatePeers([profile]);
      void this.history.refreshPeer(profile);
    };
    this.network.transport.onConnectRequest = peerId => {
      if (this.running && this.connections.isDiscovered(peerId)) this.connections.ensureLink(peerId);
    };
    this.network.transport.onIncoming = peerId => {
      if (
        this.running &&
        this.snapshot.peers.some((peer) => peer.id === peerId)
      )
        return !!this.connections.ensureLink(peerId, false, peerId !== this.snapshot.activePeerId);
      return false;
    };
  }
  /** Public runtime query; returns a copy so callers cannot change advertised capabilities. */
  getRuntimeInfo(): RuntimeInfo {
    const info = this.network.runtime ?? localRuntime();
    return { version: info.version, capabilities: [...info.capabilities] };
  }
  get needsNearbyPermission() {
    return this.network.needsNearbyPermission === true;
  }
  get networkSettings() {
    return readSettings();
  }
  async configureNetwork(value: NetworkSettings) {
    const settings = validateSettings(value);
    if (this.hasPendingTransfers())
      throw new Error("还有内容正在传输，请完成后再修改设置");
    const network = await defaultNetwork(settings, identityFor(this.storage));
    if (this.hasPendingTransfers())
      throw new Error("还有内容正在传输，请完成后再修改设置");
    saveSettings(settings);
    const online = this.snapshot.availability === "online";
    this.stop();
    this.network = network;
    await this.history.write(async () => {
      const runtime = this.getRuntimeInfo();
      const old = this.snapshot.profile;
      if (old.version === runtime.version && JSON.stringify(old.capabilities) === JSON.stringify(runtime.capabilities)) return;
      const profile = { ...old, ...runtime, revision: (old.revision ?? 0) + 1 };
      await this.storage.saveProfile(profile);
      this.patch({ profile });
    });
    this.bindIncoming();
    this.patch({
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
    this.movingStorage || this.transferService.hasPending();
  async moveStorage(directory: string) {
    if (!this.storage.moveStorage) throw new Error("当前存储不支持修改目录");
    if (this.hasPendingTransfers())
      throw new Error("请等待文件传输完成后再修改存储目录");
    this.movingStorage = true;
    this.patch({});
    try {
      const moved = await this.storage.moveStorage(directory);
      storageUsage(this.storage).invalidate();
      return moved;
    } finally {
      this.movingStorage = false;
      this.patch({});
    }
  }
  subscribeNetworkChange(listener: () => void) {
    this.networkChangeListeners.add(listener);
    return () => { this.networkChangeListeners.delete(listener); };
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(values: Partial<ChatSnapshot>) {
    if ("error" in values && !("compatibilityReasons" in values)) values.compatibilityReasons = undefined;
    this.snapshot = { ...this.snapshot, ...values };
    for (const listener of this.listeners) listener();
    if (values.conversations || values.profile || values.status === "connected")
      this.discovery.queueDiscovery();
  }
  private showError(error: unknown) {
    if (this.resettingData) return;
    runtimeLog("error", "app", "操作未完成", {
      detail: errorMessage(error),
      raw: error,
    });
    this.patch({ error: errorMessage(error), compatibilityReasons: error instanceof CompatibilityError ? error.reasons : undefined });
  }
  dismissError() {
    this.patch({ error: null, compatibilityReasons: undefined });
  }
  private peerProfile(peerId: string) {
    return (
      this.cachedProfiles.get(peerId) ??
      this.snapshot.peers.find((p) => p.id === peerId) ??
      this.snapshot.conversations.find((c) => c.peer.id === peerId)?.peer
    );
  }

  start() {
    if (this.resettingData || this.running || this.snapshot.availability === "offline") return;
    this.running = true;
    runtimeLog("info", "app", "开始连接", {
      detail: `${this.network.discovery.name} / ${this.network.transport.name}`,
    });
    this.network.transport.publish?.(this.snapshot.profile);
    this.connections.start();
    this.browserConnection = (navigator as Navigator & { connection?: EventTarget }).connection;
    this.browserConnection?.addEventListener("change", this.onNetworkChange);
    window.addEventListener("online", this.onNetworkChange);
    window.addEventListener("offline", this.onOffline);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.onVisible);
    this.discovery.connect();
  }
  stop() {
    this.running = false;
    this.transferService.stop();
    this.connections.stop();
    clearTimeout(this.networkChangeTimer);
    this.networkChangeTimer = undefined;
    this.browserConnection?.removeEventListener("change", this.onNetworkChange);
    this.browserConnection = undefined;
    window.removeEventListener("online", this.onNetworkChange);
    window.removeEventListener("offline", this.onOffline);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.onVisible);
    this.disconnect();
    return this.network.transport.stop?.().catch(() => {});
  }
  private disconnect(preserveConnections = false) {
    this.discovery.disconnect();
    this.connections.disconnect(preserveConnections);
    this.patch({ status: "disconnected" });
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
    this.discovery.resetBackoff();
    this.patch({ error: null, compatibilityReasons: undefined });
    this.start();
  }
  async refreshNumericId(): Promise<void> {
    if (this.numberRefresh) throw new Error("正在刷新蜂鸟号，请稍候");
    const operation = this.history.write(async () => {
      const profile = {
        ...this.snapshot.profile,
        numericId: generateNumericId(this.snapshot.profile.numericId),
        revision: (this.snapshot.profile.revision ?? 0) + 1,
      };
      await this.storage.saveProfile(profile);
      this.patch({ profile });
      this.network.transport.publish?.(profile);
      this.discovery.updateDirectory(true);
    });
    this.numberRefresh = operation;
    try {
      await operation;
    } finally {
      if (this.numberRefresh === operation) this.numberRefresh = undefined;
    }
  }
  connectByNumericId(numericId: string) {
    return this.discovery.connectByNumericId(numericId);
  }
  getConversationPreview(peerId: string) {
    return this.history.getPreview(peerId);
  }
  setVisibleConversation(peerId: string | null) {
    void this.history.setVisiblePeer(peerId).catch(error => this.showError(error));
  }
  async selectPeer(peer: Profile) {
    this.connections.focus(peer);
    await this.history.openConversation(peer);
  }
  updatePeerRemark(peerId: string, remark: string) {
    return this.history.updatePeerRemark(peerId, remark);
  }
  updatePeerAutoAcceptFiles(peerId: string, enabled: boolean) {
    return this.history.updatePeerAutoAcceptFiles(peerId, enabled);
  }
  async updateProfile(patch: Partial<Profile>) {
    try {
      await this.history.write(async () => {
        const profile = {
          ...this.snapshot.profile,
          ...patch,
          version: this.snapshot.profile.version,
          capabilities: this.snapshot.profile.capabilities,
          clientType: this.snapshot.profile.clientType,
          device: this.snapshot.profile.device,
          id: this.snapshot.profile.id,
          numericId: this.snapshot.profile.numericId,
        };
        profile.name = profile.name.trim();
        if (!isProfile(profile))
          throw new Error(
            "昵称需为 1–48 字，简介不超过 160 字，请检查个人资料",
          );
        if (profile.extend && !fitsProfileResponse(profile))
          throw new Error("个人资料过大，请缩短附加信息");
        if (
          (Object.keys(profile) as (keyof Profile)[]).every(
            (key) => profile[key] === this.snapshot.profile[key],
          )
        )
          return;
        profile.revision = (this.snapshot.profile.revision ?? 0) + 1;
        await this.storage.saveProfile(profile);
        this.patch({ profile });
        this.network.transport.publish?.(profile);
        this.discovery.updateDirectory(false);
      });
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
  getTransferredBytes(...args: Parameters<TransferCommands["getTransferredBytes"]>) {
    return this.transferService.getTransferredBytes(...args);
  }
  isTransferRecovering(...args: Parameters<TransferCommands["isTransferRecovering"]>) {
    return this.transferService.isTransferRecovering(...args);
  }
  forwardMessage(...args: Parameters<TransferCommands["forwardMessage"]>) {
    return this.transferService.forwardMessage(...args);
  }
  sendText(...args: Parameters<TransferCommands["sendText"]>) {
    return this.transferService.sendText(...args);
  }
  sendFolder(...args: Parameters<TransferCommands["sendFolder"]>) {
    return this.transferService.sendFolder(...args);
  }
  sendFiles(...args: Parameters<TransferCommands["sendFiles"]>) {
    return this.transferService.sendFiles(...args);
  }
  acceptFile(...args: Parameters<TransferCommands["acceptFile"]>) {
    return this.transferService.acceptFile(...args);
  }
  acceptFolder(...args: Parameters<TransferCommands["acceptFolder"]>) {
    return this.transferService.acceptFolder(...args);
  }
  rejectFile(...args: Parameters<TransferCommands["rejectFile"]>) {
    return this.transferService.rejectFile(...args);
  }
  cancelTransfer(...args: Parameters<TransferCommands["cancelTransfer"]>) {
    return this.transferService.cancelTransfer(...args);
  }
  getAttachment(id: string) {
    return this.storage.getAttachment(id);
  }
  deleteMessage(id: string): Promise<void> {
    return this.deleteMessages([id]);
  }
  async deleteMessages(ids: string[]) {
    await this.history.deleteMessages(ids);
    storageUsage(this.storage).remove(new Set(ids));
  }
  deleteConversation(peerId: string) {
    return this.history.deleteConversation(peerId);
  }
  async prepareReset() {
    this.resettingData = true;
    this.history.revision++;
    for (const peerId of this.transferService.peerIds())
      this.transferService.cancelPeerTransfers(peerId);
    await this.stop();
    await this.history.writing;
  }

  async resetData() {
    await this.prepareReset();
    await this.storage.resetData?.();
    storageUsage(this.storage).invalidate();
    this.cachedProfiles.clear();
    this.history.clearSnapshot();
  }

  clearHistory() {
    return this.history.clearHistory();
  }
}

export async function createChatEngine(
  storage?: StorageAdapter,
  network?: NetworkAdapters,
): Promise<ChatEngine> {
  const adapter = storage ?? (await createStorageAdapter());
  const identity = !network ? identityFor(adapter) : undefined;
  let profile = await adapter.getProfile();
  const adapters = network ?? (await defaultNetwork(undefined, identity));
  const desktop = isNative();
  const runtime = adapters.runtime ?? localRuntime(desktop);
  const maxMessageSize = await localMessageSize(desktop);
  const saved = profile && isProfile(profile) ? profile : undefined;
  const target = desktop ? nativeTargetDevice(import.meta.env.TAURI_ENV_PLATFORM) : undefined;
  const detected = detectDevice(globalThis.navigator);
  const device = detected === "Harmony" ? detected : target ?? detected ?? saved?.device;
  const clientType = desktop ? nativeClientType(target ?? device) : "web";
  const base = saved ?? defaultProfile({ device, clientType });
  const id = identity ? (await identity).id : base.id;
  const previousRevision = base.revision ?? (base as Profile & {profileRevision?: number}).profileRevision ?? 0;
  const numericId = isNumericId(base.numericId) ? base.numericId : generateNumericId();
  const changed = base.version !== runtime.version || JSON.stringify(base.capabilities) !== JSON.stringify(runtime.capabilities)
    || base.clientType !== clientType || base.device !== device || base.numericId !== numericId || base.maxMessageSize !== maxMessageSize;
  profile = { ...base, id, ...runtime, numericId, maxMessageSize, clientType, device,
    revision: !saved || base.id !== id ? 1 : Math.max(1, previousRevision + Number(changed)) };
  if (maxMessageSize === undefined) delete profile.maxMessageSize;
  const conversations = await adapter.getConversations();
  // Older conversation records have no delivery timestamp. Opening a chat alone
  // updated their updatedAt, so derive their initial rank from delivered messages.
  for (const conversation of conversations) {
    if (conversation.lastDeliveredAt === undefined) {
      const history = await adapter.getMessages(conversation.peer.id);
      const deliveredAt = history.reduce((latest, message) =>
        message.status === "delivered" ? Math.max(latest, message.createdAt) : latest, 0);
      if (deliveredAt) conversation.lastDeliveredAt = deliveredAt;
    }
  }
  const engine = new ChatEngine(
    adapter,
    profile,
    conversations,
    adapters,
    await adapter.getPeerProfiles?.(),
  );
  await adapter.saveProfile(engine.getSnapshot().profile);
  return engine;
}
