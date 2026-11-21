import {
  CONNECTION_CONFIG,
  TRANSFER_CONFIG
} from "../../config";
import { runtimeLog } from "../../runtime-logs";
import { CAP, commonCapabilities } from "../capabilities";
import { FolderReceiver } from "../folderReceiver";
import {
  type FolderProgress,
  type ReadFolder,
} from "../folders";
import {
  decodeChunk,
  MAX_BUFFERED_FILE_BYTES,
  MAX_CONTROL_BYTES,
  newId,
  parseControlPacket,
  type ControlPacket
} from "../protocol";
import { transferMetrics as metrics } from "../transferMetrics";
import type {
  AttachmentSource,
  FileDestination,
  FolderDestination,
  Message
} from "../types";
import { copySavedFile } from "../storage/copy";
import { TransferSender } from "./sender";
import { FileTrace, fileDiagnosticsEnabled } from "./diagnostics";
import { usesBulkFile } from "../network/libp2p/rtc-bulk";
import { errorMessage, imageTypes } from './io';
import type { IncomingTransfer, OutgoingTransfer } from './state';

import {
  type TransportChannel
} from "../network";

import type { FileProgress, FileTaskExecutor, TransferLink as PeerLink, TransferHost } from './types';
type Timer = ReturnType<typeof setTimeout>;

/** Owns transfer tasks; bulk payloads stay in the selected browser/native execution path. */
export class TransferService {
  private incoming = new Map<string, IncomingTransfer>();
  private outgoing = new Map<string, OutgoingTransfer>();
  private traces = new Map<string, FileTrace>();
  private receiptQueries = new Map<string, { peerId: string; timer: Timer; }>();
  private readonly sender: TransferSender;
  constructor(private readonly host: TransferHost) {
    this.sender = new TransferSender({
      host, outgoing: this.outgoing,
      sendControl: (channel, packet) => this.sendControl(channel, packet),
      waitForBuffer: channel => this.waitForBuffer(channel),
      waitForTransfer: (id, ready, timeout, reason, metric) => this.waitForTransfer(id, ready, timeout, reason, metric),
      progress: (id, value) => this.progress(id, value),
      failOutgoing: (id, reason) => this.failOutgoing(id, reason),
      armAck: id => this.armAck(id),
      resumeOutgoing: (transfer, deadline) => this.resumeOutgoing(transfer, deadline),
      handleData: (link, raw) => this.handleData(link, raw),
    });
  }

  hasPending() { return this.incoming.size > 0 || this.outgoing.size > 0 || this.sender.isPreparing(); }
  has(id: string) { return this.incoming.has(id) || this.outgoing.has(id); }
  peerIds() { return new Set([...this.incoming.values(), ...this.outgoing.values()].map(t => t.peerId)); }
  hasActive(peerId: string) { return [...this.incoming.values(), ...this.outgoing.values()].some(t => t.peerId === peerId); }
  hasInFlight(peerId: string, channel: TransportChannel) {
    return [...this.incoming.values()].some(t => t.peerId === peerId && t.channel === channel) ||
      [...this.outgoing.values()].some(t => t.peerId === peerId && t.channel === channel && !t.paused);
  }
  isBusy(peerId: string) { return this.hasActive(peerId) || this.sender.isPreparing(peerId); }
  abortPreparations() { this.sender.abortPreparations(); }
  stop() {
    for (const id of this.traces.keys()) this.endTrace(id, "stopped");
    this.abortPreparations();
    for (const query of this.receiptQueries.values()) clearTimeout(query.timer);
    this.receiptQueries.clear();
  }
  disconnected(peerId: string, reason: string, recover: boolean) {
    for (const [id, transfer] of this.incoming)
      if (transfer.peerId === peerId && !(recover && transfer.resumable &&
        transfer.message.status !== "awaiting-acceptance")) this.failIncoming(id, reason);
    for (const [id, transfer] of this.outgoing)
      if (transfer.peerId === peerId && !(recover && (transfer.resumable || !transfer.channel))) void this.failOutgoing(id, reason);
  }
  /** Called after history deletion commits, so cleanup cannot restore the record. */
  forget(id: string) {
    this.endTrace(id, "removed");
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
      outgoing.interrupt?.();
      outgoing.wake?.();
    }
  }
  handleProgress(link: PeerLink, event: FileProgress) {
    if (this.host.links.get(link.peerId) !== link) return;
    const incoming = this.incoming.get(event.id);
    const outgoing = this.outgoing.get(event.id);
    if (event.message) {
      if (incoming?.peerId === link.peerId) this.rejectFile(event.id, event.message);
      if (outgoing?.peerId === link.peerId) void this.failOutgoing(event.id, event.message);
      return;
    }
    if (incoming?.native && incoming.peerId === link.peerId && event.received !== undefined) {
      if (incoming.trace) {
        incoming.trace.writtenBytes = event.written;
        incoming.trace.destinationWriteMs = event.destinationWriteMs ?? 0;
      }
      if (incoming.channel === link.channel && event.received > (incoming.nativeBytes ?? 0))
        incoming.recoveryUntil = undefined;
      incoming.nativeBytes = Math.max(incoming.nativeBytes ?? 0, event.received);
      this.refreshIncomingTimer(incoming);
      this.progress(event.id, Math.min(99, Math.floor(incoming.nativeBytes / Math.max(incoming.message.size!, 1) * 100)));
    }
    if (outgoing?.peerId === link.peerId && event.sent !== undefined) {
      if (outgoing.trace) {
        outgoing.trace.confirmedBytes = event.confirmed;
        outgoing.trace.windowWaitMs = event.windowWaitMs ?? 0;
      }
      outgoing.sentBytes = Math.max(outgoing.sentBytes ?? 0, event.sent);
      this.progress(event.id, Math.min(99, Math.floor(outgoing.sentBytes / Math.max(outgoing.message.size!, 1) * 100)));
    }
    if (event.received !== undefined) this.host.receivedFromPeer(link);
  }

  /** Live payload bytes for display sampling; includes file and folder transfers. */
  getTransferredBytes(id: string): number {
    return this.incoming.get(id)?.nativeBytes ?? this.incoming.get(id)?.received ?? this.outgoing.get(id)?.sentBytes ?? 0;
  }

  isTransferRecovering(id: string): boolean {
    return !!this.outgoing.get(id)?.recovering || this.incoming.get(id)?.recoveryUntil !== undefined;
  }

  private beginTrace(task: IncomingTransfer | OutgoingTransfer) {
    if (this.traces.has(task.message.id) || task.message.folder || !fileDiagnosticsEnabled()) return;
    const local = this.host.snapshot.profile;
    const remote = this.host.peerProfile(task.peerId);
    runtimeLog("debug", "message", "开始记录文件传输性能", { peerId: task.peerId, raw: {
      transferId: task.message.id, direction: "chunks" in task ? "receive" : "send",
      connectionId: task.channel?.physicalConnectionId ?? task.channel?.connectionId,
      localClient: local.clientType, remoteClient: remote?.clientType,
      localVersion: local.version, remoteVersion: remote?.version,
      localRtcLimit: local.maxMessageSize, remoteRtcLimit: remote?.maxMessageSize,
      fileWindowBytes: TRANSFER_CONFIG.streamWindowBytes, fileBytes: task.message.size,
    } });
    task.trace = new FileTrace(task);
    this.traces.set(task.message.id, task.trace);
  }

  private endTrace(id: string, outcome: string) {
    this.traces.get(id)?.finish(outcome);
    this.traces.delete(id);
  }

  private progress(id: string, value: number | null) {
    if (value === null) this.endTrace(id, this.host.history.knownMessages.get(id)?.status === "delivered" ? "delivered" : "ended");
    if (value !== null && this.host.history.deletedMessages.has(id)) return;
    const transfers = { ...this.host.snapshot.transfers };
    if (value === null) delete transfers[id];
    else transfers[id] = value;
    this.host.patch({ transfers });
  }

  queryReceipt(link: PeerLink, id: string) {
    if (this.receiptQueries.has(id) || this.receiptQueries.size >= 160 || link.channel?.readyState !== "open") return;
    const timer = setTimeout(() => this.receiptQueries.delete(id), 5000);
    this.receiptQueries.set(id, { peerId: link.peerId, timer });
    try { this.sendControl(link.channel, { type: "receipt-query", id }); }
    catch { clearTimeout(timer); this.receiptQueries.delete(id); }
  }

  private armAck(id: string) {
    const outgoing = this.outgoing.get(id);
    if (outgoing)
      outgoing.timer = setTimeout(
        () => {
          const link = this.host.links.get(outgoing.peerId);
          if (link?.receipts && link.channel?.readyState === "open" && !outgoing.receiptPending) {
            outgoing.receiptPending = true;
            this.queryReceipt(link, id);
            outgoing.timer = setTimeout(() => void this.failOutgoing(id, "未收到对方的接收确认，请重新发送"), 5000);
          } else void this.failOutgoing(id, "未收到对方的接收确认，请重新发送");
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
    metric = "file.controlWait",
  ): Promise<void> {
    const transfer = this.outgoing.get(id);
    if (!transfer) return Promise.reject(new Error("文件传输已取消"));
    const held = () => (transfer.heldUntil ?? 0) > Date.now();
    const canProceed = () => ready(transfer) && (!held() || transfer.paused || transfer.acknowledged);
    if (canProceed()) return Promise.resolve();
    const trace = metric === "file.windowWait" ? transfer.trace : undefined;
    const started = trace ? performance.now() : 0;
    const pending = metrics.timed(metric, 0, () => new Promise<void>((resolve, reject) => {
      const expire = () => {
        if (held()) { timer = setTimeout(expire, timeout); return; }
        transfer.wake = undefined;
        reject(new Error(reason));
      };
      let timer = setTimeout(expire, timeout);
      let wasHeld = held();
      transfer.wake = () => {
        if (wasHeld && !held()) {
          clearTimeout(timer);
          timer = setTimeout(expire, timeout);
        }
        wasHeld = held();
        if (this.outgoing.get(id) === transfer && !canProceed()) return;
        clearTimeout(timer);
        transfer.wake = undefined;
        if (this.outgoing.get(id) === transfer || transfer.acknowledged) resolve();
        else reject(new Error(transfer.failureReason || "文件传输已取消"));
      };
    }));
    return trace ? pending.finally(() => trace.record("windowWait", performance.now() - started)) : pending;
  }

  private async failOutgoing(id: string, reason: string) {
    const transfer = this.outgoing.get(id);
    // A channel-close callback may already have queued the failure update.
    if (!transfer) {
      await this.host.history.writing;
      return;
    }
    runtimeLog("warn", "message", "内容未能送达", {
      peerId: transfer.peerId,
      detail: `${id}: ${reason}`,
    });
    this.outgoing.delete(id);
    transfer.native?.cancel(id);
    transfer.failureReason = reason;
    transfer.interrupt?.();
    transfer.wake?.();
    if (transfer.message.kind !== "text")
      this.notifyTransferError(transfer.peerId, id, reason);
    clearTimeout(transfer.timer);
    this.progress(id, null);
    await this.host.history.recordMessage({
      ...transfer.message,
      status: "failed",
      error: reason,
    }).catch((error) => this.host.showError(error));
  }

  forwardMessage(message: Message, targetPeerId: string) {
    return this.sender.forwardMessage(message, targetPeerId);
  }
  sendText(text: string, peerId?: string | null) {
    return this.sender.sendText(text, peerId);
  }
  sendFolder(read: ReadFolder, report: (progress: FolderProgress | null) => void, signal: AbortSignal, peerId?: string | null) {
    return this.sender.sendFolder(read, report, signal, peerId);
  }
  sendFiles(files: AttachmentSource[], peerId?: string | null) {
    return this.sender.sendFiles(files, peerId);
  }

  private async syncNativeReceive(transfer: IncomingTransfer, channel: TransportChannel, resume = false) {
    const state = await channel.fileTasks!.state(transfer.message.id, resume);
    const delta = state.received - transfer.received;
    if (delta < 0) throw new Error("文件进度无法确认，请重新发送");
    if (delta && transfer.folder) transfer.folder.receive(delta);
    transfer.received = state.received;
    transfer.nativeBytes = state.received;
    if (transfer.trace && state.written !== undefined) {
      transfer.trace.writtenBytes = state.written;
      transfer.trace.destinationWriteMs = state.destinationWriteMs ?? transfer.trace.destinationWriteMs;
    }
    transfer.sequence = state.sequence;
  }

  private async resumeOutgoing(transfer: OutgoingTransfer, deadline: number) {
    const { peerId, message } = transfer;
    while (Date.now() < deadline) {
      if (this.outgoing.get(message.id) !== transfer)
        throw new Error(transfer.failureReason || "文件传输已取消");
      let link = this.host.links.get(peerId);
      if (!link && this.host.snapshot.peers.some((p) => p.id === peerId) &&
        Date.now() >= this.host.retryAt(peerId))
        link = this.host.ensureLink(peerId, true, peerId !== this.host.snapshot.activePeerId);
      const channel = link?.channel;
      if (link && !link.recoveryPending && channel?.readyState === "open") {
        transfer.channel = channel;
        transfer.paused = false;
        transfer.resumeReply = undefined;
        transfer.resumeRequest = newId();
        try {
          this.sendControl(channel, { type: "file-resume", id: message.id, request: transfer.resumeRequest });
          await this.waitForTransfer(message.id, (t) => !!t.paused || !!t.resumeReply,
            Math.min(TRANSFER_CONFIG.timeoutMs, Math.max(1, deadline - Date.now())), "等待恢复已超时，请重新发送");
          const reply = this.outgoing.get(message.id)?.resumeReply;
          if (!transfer.paused && reply) {
            transfer.receivedBytes = reply.received;
            transfer.recovering = false;
            this.host.patch({});
            return { channel, reply };
          }
        } catch (error) {
          if (this.outgoing.get(message.id) !== transfer) throw error;
          if (this.host.links.get(peerId) === link) this.host.failLink(link, "正在重新连接", false);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECTION_CONFIG.pollIntervalMs));
    }
    throw new Error("等待恢复已超时，请重新发送");
  }

  /** A lost reply must not turn successfully retained bytes into a disk failure. */
  private replyTransfer(link: PeerLink, channel: TransportChannel, packet: ControlPacket) {
    if (this.host.links.get(link.peerId) !== link || link.channel !== channel || channel.readyState !== "open") return;
    try { this.sendControl(channel, packet); }
    catch { this.host.failLink(link, "连接已中断，正在继续传输", false); }
  }

  async handleData(link: PeerLink, raw: unknown) {
    if (this.host.links.get(link.peerId) !== link || !link.channel) return;
    const historyRevision = this.host.history.revision;
    const peerRevision = this.host.history.peerRevisions.get(link.peerId) || 0;
    const channel = link.channel;
    if (raw instanceof ArrayBuffer) {
      const chunk = decodeChunk(raw);
      if (!chunk) return;
      const transfer = this.incoming.get(chunk.id);
      if (!transfer || transfer.peerId !== link.peerId) return;
      if (transfer.resumable && transfer.channel !== channel) return;
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
      this.host.receivedFromPeer(link);
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
      transfer.recoveryUntil = undefined;
      transfer.chunks.push(chunk.data);
      transfer.bufferedBytes =
        (transfer.bufferedBytes || 0) + chunk.data.byteLength;
      this.refreshIncomingTimer(transfer);
      const quarterWindow = Math.floor(TRANSFER_CONFIG.streamWindowBytes / 4);
      const payloadBytes = chunk.data.byteLength;
      // Align progress reports to whole records near a quarter of the file window.
      const reportBytes = !transfer.folder && usesBulkFile(transfer.message.size!) && channel.bulkFilePayloadBytes === payloadBytes
        ? Math.max(1, Math.round(quarterWindow / payloadBytes)) * payloadBytes
        : Math.max(payloadBytes, quarterWindow);
      if (transfer.destination && transfer.bufferedBytes >= reportBytes) {
        try {
          await this.flushIncoming(transfer);
          if (this.incoming.get(chunk.id) !== transfer) return;
          this.replyTransfer(link, channel, {
            type: "file-progress",
            id: chunk.id,
            received: transfer.received,
          });
        } catch {
          this.rejectFile(chunk.id, "文件无法保存，请检查磁盘空间后重试");
          return;
        }
      }
      if (transfer.resumable && !transfer.destination &&
        transfer.received - (transfer.reportedBytes ?? 0) >= reportBytes) {
        transfer.reportedBytes = transfer.received;
        this.replyTransfer(link, channel, { type: "file-progress", id: chunk.id, received: transfer.received });
      }
      const percentage = Math.min(
        transfer.folder ? 99 : 100,
        Math.floor(
          (transfer.received / Math.max(transfer.message.size!, 1)) * 100,
        ),
      );
      if (this.host.snapshot.transfers[chunk.id] !== percentage)
        this.progress(chunk.id, percentage);
      return;
    }
    if (typeof raw !== "string") return;
    const packet = parseControlPacket(raw);
    if (!packet) return;
    if (packet.type === "file-hold") {
      const task = this.outgoing.get(packet.id);
      if (task?.accepted && task.peerId === link.peerId && task.channel === channel && !task.message.folder) {
        if (task.timer && task.finished && !task.resumable) {
          clearTimeout(task.timer);
          task.receiptPending = false;
          this.armAck(packet.id);
        }
        task.heldUntil = packet.active ? Date.now() + TRANSFER_CONFIG.timeoutMs : undefined;
        task.wake?.();
      }
      return;
    }
    if (packet.type === "file-resume") {
      // File-lane serialization also waits for a final save started on the old connection.
      const complete = !this.host.history.deletedMessages.has(packet.id) && await this.host.history.alreadyReceived(packet.id, link.peerId);
      if (this.host.links.get(link.peerId) !== link || link.channel !== channel) return;
      const transfer = this.incoming.get(packet.id);
      if (complete && !this.host.history.deletedMessages.has(packet.id)) {
        this.replyTransfer(link, channel, {
          type: "file-resumed", id: packet.id, request: packet.request,
          received: this.host.history.knownMessages.get(packet.id)?.size ?? 0, sequence: 0, complete: true
        });
      } else if (transfer?.peerId === link.peerId && transfer.resumable &&
        transfer.message.status !== "awaiting-acceptance" && !this.host.history.deletedMessages.has(packet.id)) {
        if (transfer.native) {
          try { await this.syncNativeReceive(transfer, channel, true); }
          catch { this.rejectFile(packet.id, "文件无法保存，请检查磁盘空间后重试"); return; }
        }
        // Buffered bytes are retained in this page; pending disk writes have settled before this handler.
        transfer.channel = channel;
        runtimeLog("info", "message", "继续接收附件", {peerId: link.peerId, raw: {
          transferId: packet.id, connectionId: channel.connectionId, requestId: packet.request,
          confirmedOffset: transfer.received, sequence: transfer.sequence, action: "resume" }});
        this.refreshIncomingTimer(transfer);
        this.replyTransfer(link, channel, {
          type: "file-resumed", id: packet.id, request: packet.request,
          received: transfer.received, sequence: transfer.sequence,
          ...(transfer.folder ? { folder: { index: transfer.folder.completed,
            ...(transfer.folder.current ? { offset: transfer.folder.current.received } : {}) } } : {})
        });
      } else this.replyTransfer(link, channel, {
        type: "transfer-error", id: packet.id,
        message: "文件已取消或无法继续接收，请重新发送"
      });
      return;
    }
    if (packet.type === "file-resumed") {
      const transfer = this.outgoing.get(packet.id);
      if (!transfer?.resumable || transfer.peerId !== link.peerId || transfer.channel !== channel ||
        packet.request !== transfer.resumeRequest || transfer.paused) return;
      if ((!packet.complete && !!packet.folder !== !!transfer.message.folder) || packet.received > (transfer.sentBytes ?? 0) || packet.sequence > packet.received ||
        (packet.complete && (!transfer.finished || packet.received !== transfer.message.size))) {
        await this.failOutgoing(packet.id, "文件进度无法确认，请重新发送");
        return;
      }
      transfer.resumeReply = packet;
      transfer.wake?.();
      return;
    }
    if (this.host.history.deletedMessages.has(packet.id)) return;
    if (
      packet.type === "folder-entry-ready" ||
      packet.type === "folder-entry-saved"
    ) {
      const transfer = this.outgoing.get(packet.id);
      if (!transfer?.message.folder || transfer.peerId !== link.peerId || (transfer.resumable && transfer.channel !== channel)) return;
      if (transfer.accepted && packet.index === transfer.folderIndex) {
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
        if (transfer.accepted) return;
        transfer.accepted = true;
        transfer.streaming = packet.streaming === true;
        transfer.resumable = transfer.resumeOffered === true;
        transfer.channel = channel;
        this.beginTrace(transfer);
      } else if (
        transfer.accepted &&
        packet.received > (transfer.receivedBytes || 0) &&
        packet.received <= (transfer.sentBytes || 0)
      )
        transfer.receivedBytes = packet.received;
      transfer.wake?.();
      return;
    }
    if (packet.type === "receipt-query") {
      const complete = await this.host.history.alreadyReceived(packet.id, link.peerId);
      const receiving = this.incoming.get(packet.id)?.peerId === link.peerId;
      if (this.host.links.get(link.peerId) === link && channel.readyState === "open")
        this.sendControl(channel, { type: "receipt", id: packet.id, status: complete ? "complete" : receiving ? "receiving" : "unknown" });
      return;
    }
    if (packet.type === "receipt") {
      const query = this.receiptQueries.get(packet.id);
      if (!query || query.peerId !== link.peerId) return;
      clearTimeout(query.timer);
      this.receiptQueries.delete(packet.id);
      const outgoing = this.outgoing.get(packet.id);
      if (packet.status === "unknown" && outgoing?.peerId === link.peerId &&
        outgoing.message.kind === "text" && !outgoing.receiptRetries) {
        outgoing.receiptRetries = 1;
        clearTimeout(outgoing.timer);
        this.sendControl(channel, { type: "text", id: packet.id, text: outgoing.message.text!, createdAt: outgoing.message.createdAt });
        this.armAck(packet.id);
      } else if (packet.status === "complete") {
        if (outgoing) await this.handleData(link, JSON.stringify({ type: "ack", id: packet.id }));
        else {
          const message = this.host.history.knownMessages.get(packet.id) ?? (this.host.history.cache.get(link.peerId) ?? []).find((m) => m.id === packet.id);
          if (message?.peerId === link.peerId && message.senderId === this.host.snapshot.profile.id && message.status === "failed")
            await this.host.history.recordMessage({ ...message, status: "delivered", error: undefined });
        }
      }
      return;
    }
    if (packet.type === "ack") {
      const outgoing = this.outgoing.get(packet.id);
      if (!outgoing || outgoing.peerId !== link.peerId) return;
      if (outgoing.message.kind !== "text" && !outgoing.finished) return;
      if (outgoing.trace?.fileEndAt !== undefined)
        outgoing.trace.finalAckMs = Math.round(performance.now() - outgoing.trace.fileEndAt);
      runtimeLog("info", "message", "对方已确认收到", {
        peerId: link.peerId,
        detail: packet.id,
        raw: {transferId: packet.id, connectionId: channel.connectionId, state: "delivered", acknowledgedBytes: outgoing.message.size},
      });
      clearTimeout(outgoing.timer);
      try {
        await this.host.history.recordMessage({ ...outgoing.message, status: "delivered" });
        if (this.outgoing.get(packet.id) === outgoing)
          this.outgoing.delete(packet.id);
        outgoing.acknowledged = true;
        outgoing.wake?.();
        this.progress(packet.id, null);
      } catch (error) {
        await this.failOutgoing(packet.id, errorMessage(error));
        throw error;
      }
      return;
    }
    if (packet.type === "transfer-error") {
      this.rememberCancellation(link, packet.id);
      channel.cancelTransfer?.(packet.id);
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
      if (!transfer?.folder || transfer.peerId !== link.peerId || (transfer.resumable && transfer.channel !== channel)) return;
      if (transfer.message.status === "awaiting-acceptance") {
        this.rejectFile(packet.id, "尚未同意接收此文件");
        return;
      }
      transfer.recoveryUntil = undefined;
      this.refreshIncomingTimer(transfer);
      try {
        if (packet.type === "folder-entry") {
          const destination = await transfer.folder.begin(packet);
          if (this.incoming.get(packet.id) !== transfer) {
            await destination?.abort().catch(() => undefined);
            return;
          }
          transfer.destination = destination;
          this.replyTransfer(link, channel, {
            type: "folder-entry-ready",
            id: packet.id,
            index: packet.index,
          });
        } else if (packet.type === "folder-entry-end") {
          if (transfer.native) await this.syncNativeReceive(transfer, channel);
          transfer.folder.checkEnd(packet.index);
          if (transfer.destination) {
            await this.flushIncoming(transfer);
            if (this.incoming.get(packet.id) !== transfer) return;
            await transfer.destination.close();
            transfer.destination = undefined;
          }
          if (this.incoming.get(packet.id) !== transfer) return;
          transfer.folder.finishEntry();
          this.replyTransfer(link, channel, {
            type: "file-progress",
            id: packet.id,
            received: transfer.received,
          });
          this.replyTransfer(link, channel, {
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
          await this.host.history.recordMessage({
            ...transfer.message,
            status: "delivered",
          });
          if (this.incoming.get(packet.id) !== transfer) return;
          clearTimeout(transfer.timer);
          this.incoming.delete(packet.id);
          void transfer.native?.release(packet.id);
          this.progress(packet.id, null);
          this.replyTransfer(link, channel, { type: "ack", id: packet.id });
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
      const received = await this.host.history.alreadyReceived(packet.id, link.peerId);
      if (
        this.host.links.get(link.peerId) !== link ||
        this.host.history.deletedMessages.has(packet.id) ||
        (packet.type !== "text" && link.cancelledTransfers?.has(packet.id)) ||
        this.host.history.revision !== historyRevision ||
        (this.host.history.peerRevisions.get(link.peerId) || 0) !== peerRevision
      )
        return;
      if (received) {
        this.sendControl(channel, { type: "ack", id: packet.id });
        return;
      }
      // Never allow a sender to overwrite another peer's messages or this device's outgoing IDs.
      const existing = this.host.history.knownMessages.get(packet.id);
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
        await this.host.history.recordMessage(message, true);
        this.sendControl(channel, { type: "ack", id: packet.id });
        if (import.meta.env.VITE_ANDROID) runtimeLog("debug", "message", "消息已保存并回复送达", {
          peerId: link.peerId, raw: { messageId: packet.id, connectionId: channel.connectionId },
        });
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
        ? this.host.storage.createFolderDestination
        : this.host.storage.createFileDestination);
      const external = !managed && (folder || packet.size > MAX_BUFFERED_FILE_BYTES);
      const autoAccept =
        !external &&
        this.host.snapshot.conversations.some(
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
        this.host.movingStorage ||
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
          packet.size <= MAX_BUFFERED_FILE_BYTES &&
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
        resumable: commonCapabilities(this.host.getRuntimeInfo(), link.profile).includes(folder ? CAP.folderResume : CAP.resume),
        channel,
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
        await this.host.history.recordMessage(message, true);
        if (autoAccept && this.incoming.get(packet.id) === transfer) {
          if (managed) await this.acceptFile(packet.id);
          else {
            this.beginTrace(transfer);
            this.sendControl(channel, {
              type: "file-accept", id: packet.id,
            });
          }
          this.refreshIncomingTimer(transfer);
        }
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
      if (transfer.resumable && transfer.channel !== channel) return;
      if (transfer.folder) {
        this.rejectFile(packet.id, "文件夹接收不完整，请重新发送");
        return;
      }
      if (transfer.message.status === "awaiting-acceptance") {
        this.rejectFile(packet.id, "尚未同意接收此文件");
        return;
      }
      if (transfer.native) {
        try { await this.syncNativeReceive(transfer, channel); }
        catch { this.rejectFile(packet.id, "文件无法保存，请检查磁盘空间后重试"); return; }
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
          await this.host.history.write(async () => {
            if (this.incoming.get(packet.id) === transfer)
              await this.host.storage.saveAttachment(packet.id, blob);
          });
        }
        if (this.incoming.get(packet.id) !== transfer) return;
        await this.host.history.recordMessage({ ...transfer.message, status: "delivered" });
        if (this.incoming.get(packet.id) !== transfer) return;
        clearTimeout(transfer.timer);
        this.incoming.delete(packet.id);
        void transfer.native?.release(packet.id);
        this.progress(packet.id, null);
        this.replyTransfer(link, channel, { type: "ack", id: packet.id });
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
    void this.host.history.recordMessage({
      ...transfer.message,
      status: "failed",
      error: reason,
    }).catch((error) => this.host.showError(error));
  }

  private abortDestination(transfer: IncomingTransfer) {
    if (transfer.native) { transfer.native.cancel(transfer.message.id); void transfer.native.release(transfer.message.id).catch(() => { }); }
    const destination = transfer.destination;
    transfer.destination = undefined;
    if (destination) void destination.abort().catch(() => undefined);
    if (transfer.migrating && transfer.migrating !== destination)
      void transfer.migrating.abort().catch(() => {});
    const folder = transfer.folder?.destination;
    if (folder?.abort) void folder.abort().catch(() => undefined);
  }

  private async flushIncoming(transfer: IncomingTransfer) {
    if (!transfer.chunks.length) return;
    const blob = new Blob(transfer.chunks);
    const started = transfer.trace && performance.now();
    const destination = transfer.destination!;
    transfer.chunks = [];
    transfer.bufferedBytes = 0;
    await metrics.timed("file.destinationWrite", blob.size, () => destination.write(blob));
    if (transfer.trace && started !== undefined) {
      transfer.trace.writtenBytes = transfer.received;
      transfer.trace.record("destinationWrite", performance.now() - started);
    }
  }

  private refreshIncomingTimer(transfer: IncomingTransfer) {
    clearTimeout(transfer.timer);
    if (transfer.migrating && transfer.recoveryUntil === undefined) return;
    transfer.timer = setTimeout(
      () => {
        if (!transfer.resumable || (transfer.recoveryUntil !== undefined && Date.now() >= transfer.recoveryUntil))
          this.rejectFile(transfer.message.id, "接收文件超时，请让对方重新发送");
        else {
          const link = this.host.links.get(transfer.peerId);
          if (link) this.host.failLink(link, "连接已中断，正在继续传输", false);
          else this.suspendTransfers(transfer.peerId);
        }
      },
      Math.min(TRANSFER_CONFIG.timeoutMs, transfer.recoveryUntil === undefined
        ? Infinity : Math.max(0, transfer.recoveryUntil - Date.now())),
    );
  }

  /** The picker has already returned. Recheck the actual state on the same lane as file-end. */
  async saveFileAs(message: Message, target: FileDestination) {
    const { id, peerId } = message;
    try {
      await this.host.withFileLane(peerId, id, async () => {
        if (message.folder || message.senderId !== peerId || this.host.history.deletedMessages.has(id))
          throw new Error("文件传输已取消");
        const task = this.incoming.get(id);
        if (!task) {
          const saved = this.host.history.knownMessages.get(id);
          if (saved?.status !== "delivered" || saved.peerId !== peerId || saved.attachmentStorage === "external")
            throw new Error("附件尚未接收完成或已被清除");
          const storage = this.host.storage;
          if (storage.exportAttachment) await storage.exportAttachment(saved, target);
          else await copySavedFile(storage, saved, target);
        } else if (task.peerId !== peerId || task.folder) {
          throw new Error("文件传输已取消");
        } else if (task.message.status === "awaiting-acceptance") {
          await this.acceptDestination(id, target, undefined, true);
        } else {
          await this.moveIncomingFile(task, target);
        }
      });
    } catch (error) {
      await target.abort().catch(() => {});
      throw error;
    }
  }

  private async moveIncomingFile(task: IncomingTransfer, target: FileDestination) {
    const { id } = task.message;
    if (task.message.attachmentStorage === "external") throw new Error("文件已保存到所选位置");
    const previous = task.destination;
    const hold = (active: boolean) => {
      const link = this.host.links.get(task.peerId);
      if (this.incoming.get(id) === task && link?.channel && task.channel === link.channel)
        this.replyTransfer(link, link.channel, { type: "file-hold", id, active });
    };
    if (task.recoveryUntil === undefined) clearTimeout(task.timer);
    task.migrating = target;
    hold(true);
    const heartbeat = setInterval(() => hold(true), TRANSFER_CONFIG.timeoutMs / 4);
    try {
      if (task.native) {
        if (!target.nativeToken) throw new Error("请重新选择保存位置");
        await task.native.retarget(id, target.nativeToken);
      } else {
        if (previous) {
          if (!previous.copyPrefixTo) throw new Error("无法迁移已接收的文件");
          await previous.copyPrefixTo(target);
        }
        // The last, unflushed window belongs to the original task until all copies succeed.
        for (const chunk of task.chunks) await target.write(new Blob([chunk]));
      }
      if (this.incoming.get(id) !== task) throw new Error("文件传输已取消");
      task.chunks = [];
      task.bufferedBytes = 0;
      task.destination = target;
      task.message = { ...task.message, attachmentStorage: "external" };
      try {
        await this.host.history.recordMessage(task.message);
      } catch (error) {
        this.rejectFile(id, "文件无法保存，请检查磁盘空间后重试");
        throw error;
      } finally {
        if (previous) await previous.abort().catch(error => this.host.showError(error));
      }
    } finally {
      const link = this.host.links.get(task.peerId);
      try {
        if (task.native && this.incoming.get(id) === task && link?.channel && task.channel === link.channel) {
          await this.syncNativeReceive(task, link.channel);
          this.replyTransfer(link, link.channel, { type: "file-progress", id, received: task.received });
        }
      } catch (error) {
        this.rejectFile(id, "文件无法保存，请检查磁盘空间后重试");
        throw error;
      } finally {
        clearInterval(heartbeat);
        task.migrating = undefined;
        hold(false);
      }
      if (this.incoming.get(id) === task && task.recoveryUntil === undefined) this.refreshIncomingTimer(task);
    }
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
    saveAs = false,
  ): Promise<void> {
    const transfer = this.incoming.get(id);
    const channel = transfer && this.host.links.get(transfer.peerId)?.channel;
    const managed = !saveAs && transfer?.message.attachmentStorage === "managed";
    if (
      !transfer ||
      transfer.message.status !== "awaiting-acceptance" ||
      transfer.accepting ||
      (managed && (!!destination || !!folderDestination)) ||
      (!managed && !!transfer.folder !== !!folderDestination) ||
      (!managed && !saveAs &&
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
          folderDestination = await this.host.storage.createFolderDestination!(
            transfer.message,
          );
        else
          destination = await this.host.storage.createFileDestination!(
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
      const token = folderDestination?.nativeToken ?? destination?.nativeToken;
      if (token && channel.fileTasks) {
        transfer.native = channel.fileTasks;
        await transfer.native.receive(id, token, transfer.message.size!);
        if (this.incoming.get(id) !== transfer) { await transfer.native.release(id); return; }
      }
      transfer.destination = destination;
      if (transfer.folder) transfer.folder.destination = folderDestination;
      const message: Message = { ...transfer.message, status: "sending", ...(saveAs ? { attachmentStorage: "external" } : {}) };
      await this.host.history.recordMessage(message);
      if (this.incoming.get(id) !== transfer) return;
      transfer.message = message;
      this.beginTrace(transfer);
      this.refreshIncomingTimer(transfer);
      this.sendControl(channel, {
        type: "file-accept",
        id,
        ...(managed || saveAs ? { streaming: true } : {}),
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

  suspendTransfers(peerId: string) {
    for (const transfer of this.incoming.values()) {
      if (transfer.peerId !== peerId || !transfer.resumable ||
        transfer.message.status === "awaiting-acceptance") continue;
      if (transfer.channel) runtimeLog("info", "message", "附件等待恢复", {peerId, raw: {
        transferId: transfer.message.id, connectionId: transfer.channel.connectionId, confirmedOffset: transfer.received,
        causeEventId: transfer.channel.causeEventId, action: "suspend" }});
      transfer.channel = undefined;
      transfer.recoveryUntil ??= Date.now() + TRANSFER_CONFIG.resumeTimeoutMs;
      clearTimeout(transfer.timer);
      transfer.timer = setTimeout(() => this.rejectFile(transfer.message.id,
        "等待恢复已超时，请重新发送"), Math.max(0, transfer.recoveryUntil - Date.now()));
    }
    for (const transfer of this.outgoing.values()) {
      if (transfer.peerId !== peerId || !transfer.resumable) continue;
      clearTimeout(transfer.timer);
      if (!transfer.paused) runtimeLog("info", "message", "附件等待恢复", {peerId, raw: {
        transferId: transfer.message.id, connectionId: transfer.channel?.connectionId,
        confirmedOffset: transfer.receivedBytes, causeEventId: transfer.channel?.causeEventId, action: "suspend" }});
      transfer.heldUntil = undefined;
      transfer.paused = true;
      transfer.recovering = true;
      transfer.wake?.();
    }
  }

  private sendControl(channel: TransportChannel, packet: ControlPacket) {
    if (channel.readyState !== "open") throw new Error("设备连接已断开");
    const raw = JSON.stringify(packet);
    if (new TextEncoder().encode(raw).byteLength > MAX_CONTROL_BYTES)
      throw new Error("消息过长，请减少内容后重试");
    if (packet.type === "file-end") {
      const trace = this.outgoing.get(packet.id)?.trace;
      if (trace) trace.fileEndAt = performance.now();
    }
    channel.send(raw);
  }

  private async waitForBuffer(channel: TransportChannel) {
    if (channel.readyState !== "open") throw new Error("设备连接已断开");
    if (channel.bufferedAmount <= CONNECTION_CONFIG.sendBufferHighBytes) return;
    await metrics.timed("file.bufferWait", 0, () => new Promise<void>((resolve, reject) => {
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
    }));
  }

  cancelPeerTransfers(peerId: string) {
    this.sender.abortPreparations(peerId);
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
        transfer.interrupt?.();
        transfer.wake?.();
        this.progress(id, null);
      }
  }

  private notifyFileCancellation(
    id: string,
    transfer: { peerId: string; message: Message; native?: FileTaskExecutor; },
  ) {
    transfer.native?.cancel(id);
    if (transfer.message.kind !== "text")
      this.notifyTransferError(transfer.peerId, id, "文件传输已取消");
  }

  private rememberCancellation(link: PeerLink, id: string) {
    const cancelled = link.cancelledTransfers ??= new Set();
    cancelled.add(id);
    // IDs are unique within a session. Bound tombstones even for an untrusted peer.
    if (cancelled.size > 2048) this.host.failLink(link, "传输已中断，请重新连接");
  }

  private notifyTransferError(peerId: string, id: string, reason: string) {
    const link = this.host.links.get(peerId);
    const channel = link?.channel;
    if (!link || channel?.readyState !== "open") return;
    this.rememberCancellation(link, id);
    channel.cancelTransfer?.(id);
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
}

/** UI-facing operations; transport sessions and task maps remain internal. */
export type TransferCommands = Pick<TransferService,
  "sendText" | "sendFiles" | "sendFolder" | "acceptFile" | "acceptFolder" |
  "saveFileAs" | "rejectFile" | "cancelTransfer" | "forwardMessage" | "getTransferredBytes" | "isTransferRecovering">;
