import { MAX_REMARK_LENGTH } from "../config";
import { runtimeLog } from "../runtime-logs";
import type { TransferService } from "./transfers/service";
import type { ChatSnapshot, Conversation, Message, Profile, StorageAdapter } from "./types";

interface HistoryHost {
  readonly snapshot: ChatSnapshot;
  readonly resettingData: boolean;
  readonly transfers: Pick<TransferService, "has" | "forget" | "cancelPeerTransfers" | "abortPreparations" | "peerIds">;
  patch(values: Partial<ChatSnapshot>): void;
  peerProfile(peerId: string): Profile | undefined;
  showError(error: unknown): void;
}

export class ChatHistory {
  private visiblePeer: string | null | undefined;
  private readonly previews = new Map<string, Promise<Message | undefined>>();

  getPreview(peerId: string) {
    const cached = this.cache.get(peerId);
    if (cached) return Promise.resolve(cached.at(-1));
    let preview = this.previews.get(peerId);
    if (!preview) {
      preview = this.storage.getLatestMessage?.(peerId) ?? this.storage.getMessages(peerId).then(rows => rows.at(-1));
      this.previews.set(peerId, preview);
      preview.catch(() => this.previews.delete(peerId));
    }
    return preview;
  }

  private isReading(peerId: string) {
    return (this.visiblePeer === undefined ? this.host.snapshot.activePeerId : this.visiblePeer) === peerId;
  }

  async setVisiblePeer(peerId: string | null) {
    this.visiblePeer = peerId;
    if (!peerId) return;
    await this.write(async () => {
      const existing = this.host.snapshot.conversations.find(c => c.peer.id === peerId);
      if (!existing?.unread || !this.isReading(peerId)) return;
      const next = { ...existing, unread: 0 };
      await this.storage.saveConversation(next);
      this.host.patch({ conversations: this.host.snapshot.conversations.map(c => c === existing ? next : c) });
    });
  }

  readonly cache = new Map<string, Message[]>();
  readonly knownMessages = new Map<string, Message>();
  // Keep local tombstones for this session so delayed RTC packets cannot restore deletions.
  readonly deletedMessages = new Set<string>();
  revision = 0;
  readonly peerRevisions = new Map<string, number>();
  writing: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StorageAdapter, private readonly host: HistoryHost) {}

  write<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.writing.then(() => {
      if (this.host.resettingData) throw new Error("应用数据正在重置，请稍候");
      return action();
    });
    this.writing = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  async refreshPeer(peer: Profile) {
    await this.write(async () => {
      const conversation = this.host.snapshot.conversations.find(
        (c) => c.peer.id === peer.id,
      );
      if (!conversation || (conversation.peer.revision ?? 0) > (peer.revision ?? 0)) return;
      const next = { ...conversation, peer };
      await this.storage.saveConversation(next);
      this.host.patch({
        conversations: this.host.snapshot.conversations.map((c) =>
          c.peer.id === peer.id ? next : c,
        ),
      });
    });
  }
  async openConversation(peer: Profile) {
    this.host.patch({
      activePeerId: peer.id,
      messages: this.cache.get(peer.id) || [],
    });
    try {
      await this.write(async () => {
        const previous = this.host.snapshot.conversations.find(
          (c) => c.peer.id === peer.id,
        );
        const conversation = {
          ...previous,
          peer,
          updatedAt: previous?.updatedAt || Date.now(),
          unread: this.isReading(peer.id) ? 0 : previous?.unread || 0,
        };
        await this.storage.saveConversation(conversation);
        const messages = await this.storage.getMessages(peer.id);
        // Interrupted transmissions do not remain permanently stuck after a reload.
        for (const message of messages) {
          if (
            (message.status === "sending" ||
              message.status === "sent" ||
              message.status === "awaiting-acceptance") &&
            !this.host.transfers.has(message.id)
          ) {
            message.status = "failed";
            message.error = "上次传输已中断，请重新发送";
            await this.storage.saveMessage(message);
          }
          this.knownMessages.set(message.id, message);
        }
        this.cache.set(peer.id, messages);
        const conversations = [
          ...this.host.snapshot.conversations.filter((c) => c.peer.id !== peer.id),
          conversation,
        ].sort((a, b) => b.updatedAt - a.updatedAt);
        this.host.patch({
          conversations,
          ...(this.host.snapshot.activePeerId === peer.id ? { messages } : {}),
        });
      });
    } catch (error) {
      this.host.showError(error);
      throw error;
    }
  }
  async updatePeerRemark(peerId: string, remark: string) {
    const value = typeof remark === "string" ? remark.trim() : undefined;
    if (value === undefined || value.length > MAX_REMARK_LENGTH) {
      const error = new Error(value === undefined
        ? "请输入有效的备注名称"
        : `备注名称不能超过 ${MAX_REMARK_LENGTH} 字`);
      this.host.showError(error);
      throw error;
    }
    await this.updateConversation(peerId, conversation => {
      if (value) conversation.remark = value;
      else delete conversation.remark;
    });
  }

  async updatePeerAutoAcceptFiles(peerId: string, enabled: boolean) {
    await this.updateConversation(peerId, conversation => {
      conversation.autoAcceptFiles = enabled === true;
    });
  }

  private async updateConversation(peerId: string, update: (conversation: Conversation) => void) {
    try {
      await this.write(async () => {
        const peer = this.host.peerProfile(peerId);
        if (!peer) throw new Error("未找到聊天对象，请刷新后重试");
        const previous = this.host.snapshot.conversations.find(c => c.peer.id === peerId);
        const conversation = previous ? { ...previous, peer } : { peer, updatedAt: Date.now(), unread: 0 };
        update(conversation);
        await this.storage.saveConversation(conversation);
        this.host.patch({
          conversations: previous
            ? this.host.snapshot.conversations.map(c => c.peer.id === peerId ? conversation : c)
            : [...this.host.snapshot.conversations, conversation].sort((a, b) => b.updatedAt - a.updatedAt),
        });
      });
    } catch (error) {
      this.host.showError(error);
      throw error;
    }
  }

  async recordMessage(message: Message, incoming = false) {
    return this.write(async () => {
      if (this.deletedMessages.has(message.id)) return;
      if (
        this.knownMessages.get(message.id)?.status === "delivered" &&
        message.status !== "delivered"
      )
        return;
      const peer = this.host.peerProfile(message.peerId);
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
      const delivered = message.status === "delivered" && this.knownMessages.get(message.id)?.status !== "delivered";
      this.knownMessages.set(message.id, message);
      const previous = this.host.snapshot.conversations.find(
        (c) => c.peer.id === peer.id,
      );
      const conversation: Conversation = {
        ...previous,
        peer,
        ...(delivered && { lastDeliveredAt: Date.now() }),
        updatedAt: Math.max(previous?.updatedAt || 0, message.createdAt),
        unread:
          (previous?.unread || 0) +
          (incoming && !this.isReading(peer.id) ? 1 : 0),
      };
      await this.storage.saveConversation(conversation);
      const messages =
        this.cache.get(peer.id) ?? (await this.storage.getMessages(peer.id));
      const nextMessages = [
        ...messages.filter((m) => m.id !== message.id),
        message,
      ].sort((a, b) => a.createdAt - b.createdAt);
      this.cache.set(peer.id, nextMessages);
      this.host.patch({
        conversations: [
          ...this.host.snapshot.conversations.filter((c) => c.peer.id !== peer.id),
          conversation,
        ].sort((a, b) => b.updatedAt - a.updatedAt),
        ...(this.host.snapshot.activePeerId === peer.id
          ? { messages: nextMessages }
          : {}),
      });
    });
  }

  async alreadyReceived(id: string, peerId: string): Promise<boolean> {
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
  async deleteMessages(ids: string[]): Promise<void> {
    const selected = new Set(ids);
    if (!selected.size) return;
    try {
      await this.write(async () => {
        // Do not cancel transfers or change visible state until the atomic deletion succeeds.
        await this.storage.deleteMessages([...selected]);
        this.previews.clear();
        const transfers = { ...this.host.snapshot.transfers };
        for (const id of selected) {
          this.deletedMessages.add(id);
          this.knownMessages.delete(id);
          this.host.transfers.forget(id);
          delete transfers[id];
        }
        for (const [peerId, messages] of this.cache)
          this.cache.set(
            peerId,
            messages.filter((message) => !selected.has(message.id)),
          );
        this.host.patch({
          messages: this.host.snapshot.messages.filter(
            (message) => !selected.has(message.id),
          ),
          transfers,
        });
      });
    } catch (error) {
      this.host.showError(error);
      throw error;
    }
  }
  async deleteConversation(peerId: string) {
    this.peerRevisions.set(
      peerId,
      (this.peerRevisions.get(peerId) || 0) + 1,
    );
    this.host.transfers.cancelPeerTransfers(peerId);
    try {
      await this.write(async () => {
        await this.storage.deleteConversation(peerId);
        this.previews.delete(peerId);
        this.cache.delete(peerId);
        for (const [id, message] of this.knownMessages)
          if (message.peerId === peerId) this.knownMessages.delete(id);
        this.host.patch({
          conversations: this.host.snapshot.conversations.filter(
            (c) => c.peer.id !== peerId,
          ),
          ...(this.host.snapshot.activePeerId === peerId
            ? { activePeerId: null, messages: [] }
            : {}),
        });
      });
    } catch (error) {
      this.host.showError(error);
      throw error;
    }
  }
  async clearHistory() {
    this.revision++;
    this.host.transfers.abortPreparations();
    for (const peerId of this.host.transfers.peerIds())
      this.host.transfers.cancelPeerTransfers(peerId);
    try {
      await this.write(async () => {
        await this.storage.clearHistory();
        this.clearSnapshot();
      });
    } catch (error) {
      this.host.showError(error);
      throw error;
    }
  }

  clearSnapshot() {
    this.previews.clear();
    this.cache.clear();
    this.knownMessages.clear();
    this.host.patch({ conversations: [], messages: [], activePeerId: null, transfers: {} });
  }
}
