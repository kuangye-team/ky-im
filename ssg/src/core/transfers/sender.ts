import { MAX_TRANSFER_SIZE, TRANSFER_CONFIG } from "../../config";
import { runtimeLog } from "../../runtime-logs";
import { CAP, commonCapabilities, CompatibilityError, requireCapabilities } from "../capabilities";
import { compressFolder, inspectFolder, type FolderProgress, type FolderSelection, type ReadFolder } from "../folders";
import { MAX_BUFFERED_FILE_BYTES, MAX_TEXT_BYTES, newId } from "../protocol";
import type { AttachmentSource, FolderDestination, Message } from "../types";
import { BrowserTransferBackend } from "./browser";
import type { TransferExecution } from "./execution";
import { errorMessage, imageTypes } from "./io";
import { sendDirectoryEntries } from "./directory";
import { NativeTransferBackend } from "./native";
import type { OutgoingTransfer } from "./state";

export class TransferSender {
  private readonly preparations = new Map<AbortController, string>();
  private readonly browser: BrowserTransferBackend;
  private readonly native: NativeTransferBackend;

  constructor(private readonly context: TransferExecution & { outgoing: Map<string, OutgoingTransfer> }) {
    this.browser = new BrowserTransferBackend(context);
    this.native = new NativeTransferBackend(context);
  }

  private get host() { return this.context.host; }

  isPreparing(peerId?: string) {
    return peerId === undefined ? this.preparations.size > 0 : [...this.preparations.values()].includes(peerId);
  }

  abortPreparations(peerId?: string) {
    for (const [controller, preparingPeer] of this.preparations)
      if (peerId === undefined || preparingPeer === peerId) controller.abort();
  }

  /** Forward a local record to another peer without switching the currently open chat. */
  async forwardMessage(message: Message, targetPeerId: string): Promise<void> {
    try {
      const { source, attachment } = await this.host.history.write(async () => {
        const source = (await this.host.storage.getMessages(message.peerId)).find(
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
        const attachment = this.host.storage.getAttachmentSource
          ? await this.host.storage.getAttachmentSource(source.id)
          : await this.host.storage.getAttachment(source.id);
        if (!attachment || attachment.size !== source.size)
          throw new Error("附件尚未接收完成或已被清除，无法转发");
        return { source, attachment };
      });
      if (this.host.snapshot.availability !== "online")
        throw new Error("请先上线，再转发消息");
      if (
        targetPeerId === this.host.snapshot.profile.id ||
        !this.host.peerProfile(targetPeerId)
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
              nativeSource: attachment!.nativeSource,
              slice: (start, end) => attachment!.slice(start, end),
            };
        sent = await this.sendAttachments([file], targetPeerId, source.kind);
      }
      if (!sent) throw new Error("转发未完成，传输已中断，请重试");
    } catch (error) {
      this.host.showError(error);
      throw error;
    }
  }

  async sendText(
    text: string,
    peerId = this.host.snapshot.activePeerId,
  ): Promise<boolean> {
    const value = text.trim();
    if (!peerId || !value) return false;
    if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) {
      const error = new Error("消息太长了，请分成几条发送");
      this.host.showError(error);
      throw error;
    }
    // readyChannel rebuilds only this peer; other conversations stay connected.
    const message: Message = {
      id: newId(),
      peerId,
      senderId: this.host.snapshot.profile.id,
      kind: "text",
      text: value,
      createdAt: Date.now(),
      status: "sending",
    };
    runtimeLog("info", "message", "准备发送文字", {
      peerId,
      detail: message.id,
    });
    this.context.outgoing.set(message.id, { peerId, message });
    try {
      await this.host.history.recordMessage(message);
      const { channel } = await this.host.readyChannel(peerId);
      const outgoing = this.context.outgoing.get(message.id);
      if (!outgoing) return false;
      outgoing.channel = channel;
      this.context.sendControl(channel, {
        type: "text",
        id: message.id,
        text: value,
        createdAt: message.createdAt,
      });
      await this.host.history.recordMessage({ ...message, status: "sent" });
      this.context.armAck(message.id);
      return (
        this.context.outgoing.has(message.id) ||
        this.host.history.knownMessages.get(message.id)?.status === "delivered"
      );
    } catch (error) {
      await this.context.failOutgoing(message.id, errorMessage(error));
      if (this.host.history.deletedMessages.has(message.id)) return false;
      this.host.showError(error);
      throw error;
    }
  }

  async sendFolder(
    read: ReadFolder,
    report: (progress: FolderProgress | null) => void,
    signal: AbortSignal,
    peerId = this.host.snapshot.activePeerId,
  ): Promise<boolean> {
    if (!peerId) return false;
    if (this.host.movingStorage) throw new Error("正在迁移存储，请稍后重试");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.preparations.set(controller, peerId);
    this.host.patch({});
    try {
      controller.signal.throwIfAborted();
      const folder = await read(controller.signal, report);
      controller.signal.throwIfAborted();
      const stats = inspectFolder(folder);
      let archive: File | undefined;
      if (stats.compress && !this.host.storage.createFolderDestination) {
        report({ phase: "compressing", ...stats });
        archive = await compressFolder(folder, controller.signal);
      }
      controller.signal.throwIfAborted();
      report(null);
      // Starting the transfer immediately registers its outgoing record.
      return await (archive
        ? this.sendFiles([archive], peerId)
        : this.sendDirectory(folder, stats, peerId));
    } catch (error) {
      if (error instanceof CompatibilityError) this.host.showError(error);
      throw error;
    } finally {
      this.preparations.delete(controller);
      signal.removeEventListener("abort", abort);
      this.host.patch({});
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
      senderId: this.host.snapshot.profile.id,
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
    this.context.outgoing.set(message.id, outgoing);
    let localFolder: FolderDestination | undefined;
    let saved = false;
    try {
      await this.host.history.recordMessage(message);
      if (!this.context.outgoing.has(message.id)) return false;
      this.context.progress(message.id, 0);
      const { channel, link } = await this.host.readyChannel(peerId);
      const check = () => {
        if (this.context.outgoing.get(message.id) !== outgoing)
          throw new Error(outgoing.failureReason || "文件传输已取消");
      };
      check();
      requireCapabilities(this.host.getRuntimeInfo(), link.profile, [CAP.folder]);
      outgoing.channel = channel;
      outgoing.resumeOffered = commonCapabilities(this.host.getRuntimeInfo(), link.profile).includes(CAP.folderResume);
      this.context.sendControl(channel, {
        type: "folder-start",
        id: message.id,
        fileName: folder.name,
        size: stats.size,
        fileCount: stats.fileCount,
        directoryCount: stats.directoryCount,
        createdAt: message.createdAt,
      });
      await this.context.waitForTransfer(
        message.id,
        (t) => !!t.accepted,
        TRANSFER_CONFIG.consentTimeoutMs,
        "对方未确认接收，请重新发送",
      );
      if (!channel.fileTasks && this.host.storage.createFolderDestination) {
        localFolder = await this.host.storage.createFolderDestination(message);
        check();
        message.attachmentStorage = "managed";
      }
      message.status = "sending";
      await this.host.history.recordMessage(message);
      await sendDirectoryEntries(this.context, outgoing, channel, folder.entries, localFolder, check, async () => {
        await localFolder?.close?.();
        saved = true;
      });
      return (
        this.context.outgoing.has(message.id) ||
        this.host.history.knownMessages.get(message.id)?.status === "delivered"
      );
    } catch (error) {
      if (!saved) {
        await localFolder?.abort?.().catch(() => { });
      }
      await this.context.failOutgoing(message.id, errorMessage(error));
      if (this.host.history.deletedMessages.has(message.id)) return false;
      throw error;
    }
  }

  async sendFiles(
    files: AttachmentSource[],
    peerId = this.host.snapshot.activePeerId,
  ): Promise<boolean> {
    return this.sendAttachments(files, peerId);
  }

  private async sendAttachments(
    files: AttachmentSource[],
    peerId: string | null,
    kind?: "image" | "file",
  ): Promise<boolean> {
    if (!peerId || files.length === 0) return false;
    if (this.host.movingStorage) throw new Error("正在迁移存储，请稍后重试");
    const tooLarge = files.find(
      (file) =>
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_TRANSFER_SIZE,
    );
    if (tooLarge) {
      const error = new Error("文件过大，无法传输，请拆分后发送");
      this.host.showError(error);
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
    const historyRevision = this.host.history.revision;
    const peerRevision = this.host.history.peerRevisions.get(peerId) || 0;
    const streaming = file.size > MAX_BUFFERED_FILE_BYTES;
    const external = streaming && !this.host.storage.createFileDestination;
    const message: Message = {
      id: newId(),
      peerId,
      senderId: this.host.snapshot.profile.id,
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
        : this.host.storage.createFileDestination
          ? { attachmentStorage: "managed" as const }
          : {}),
    };
    runtimeLog("info", "message", "准备发送附件", {
      peerId,
      detail: message.id,
    });
    this.context.outgoing.set(message.id, { peerId, message });
    this.context.progress(message.id, 0);
    try {
      await this.host.history.recordMessage(message);
      if (!this.context.outgoing.has(message.id)) return false;
      this.context.progress(message.id, 0);
      const { channel, link } = await this.host.readyChannel(peerId);
      if (!this.context.outgoing.has(message.id)) return false;
      requireCapabilities(this.host.getRuntimeInfo(), link.profile, [CAP.file]);
      const resumable = commonCapabilities(this.host.getRuntimeInfo(), link.profile).includes(CAP.resume);
      this.context.outgoing.get(message.id)!.channel = channel;
      this.context.outgoing.get(message.id)!.resumeOffered = resumable;
      this.context.sendControl(channel, {
        type: "file-start",
        id: message.id,
        kind: message.kind as "image" | "file",
        fileName: message.fileName!,
        mimeType: message.mimeType!,
        size: file.size,
        createdAt: message.createdAt,
      });
      await this.context.waitForTransfer(
        message.id,
        (transfer) => !!transfer.accepted,
        TRANSFER_CONFIG.consentTimeoutMs,
        "对方未确认接收，请确认双方已更新并重新发送",
      );
      const outgoing = this.context.outgoing.get(message.id);
      if (!outgoing) return false;
      return await (channel.fileTasks ? this.native : this.browser).send(file, outgoing, channel, external);
    } catch (error) {
      await this.context.failOutgoing(message.id, errorMessage(error));
      if (
        this.host.history.deletedMessages.has(message.id) ||
        this.host.history.revision !== historyRevision ||
        (this.host.history.peerRevisions.get(peerId) || 0) !== peerRevision
      )
        return false;
      this.host.showError(error);
      throw error;
    }
  }
}
