import { TRANSFER_CONFIG } from '../../config';
import type { TransportChannel } from '../network/types';
import type { AttachmentSource, FileDestination } from '../types';
import type { TransferExecution } from "./execution";
import { errorMessage } from './io';
import type { OutgoingTransfer } from './state';

/** Commands only: the native executor owns file bytes and its prefetch/window loops. */
export class NativeTransferBackend {
  constructor(private readonly context: TransferExecution) { }
  async send(file: AttachmentSource, transfer: OutgoingTransfer, initial: TransportChannel) {
    const { message, peerId } = transfer;
    const native = transfer.native = initial.fileTasks!;
    let destination: FileDestination | undefined;
    let saved = false, channel = initial, offset = 0, sequence = 0;
    let deadline: number | undefined;
    const check = () => {
      if (this.context.outgoing.get(message.id) !== transfer && !transfer.acknowledged)
        throw new Error(transfer.failureReason || "文件传输已取消");
    };
    try {
      message.status = "sending";
      await this.context.host.history.recordMessage(message);
      destination = await this.context.host.storage.createFileDestination!(message);
      check();
      if (!destination.nativeToken) throw new Error("文件暂时无法保存，请重试");
      await native.sender(message.id, file, destination.nativeToken);
      check();
      while (!transfer.acknowledged) {
        check();
        try {
          const result = await native.send(message.id, offset, sequence, 0, true);
          transfer.sentBytes = result.sent;
          offset = file.size; sequence = result.sequence;
          check();
          if (!saved) { await destination.close(); saved = true; }
          if (transfer.paused || channel.readyState !== "open") throw new Error("network:closed");
          transfer.finished = true;
          this.context.sendControl(channel, { type: "file-end", id: message.id });
          await this.context.host.history.recordMessage({ ...message, status: "sent" });
          if (!transfer.resumable) { this.context.armAck(message.id); return true; }
          await this.context.waitForTransfer(message.id, t => !!t.paused || !!t.acknowledged,
            TRANSFER_CONFIG.timeoutMs * 2, "network:receipt");
          if (!transfer.acknowledged) throw new Error("network:closed");
        } catch (error) {
          if (transfer.acknowledged) break;
          check();
          if (!transfer.resumable || !errorMessage(error).startsWith("network:")) throw error;
          const state = await native.state(message.id);
          transfer.sentBytes = Math.max(transfer.sentBytes ?? 0, state.sent ?? 0);
          deadline ??= Date.now() + TRANSFER_CONFIG.resumeTimeoutMs;
          const old = this.context.host.links.get(peerId);
          if (old?.channel === channel) this.context.host.failLink(old, "连接已中断，正在继续传输", false);
          const resumed = await this.context.resumeOutgoing(transfer, deadline);
          channel = resumed.channel;
          if (resumed.reply.received > offset) deadline = undefined;
          offset = resumed.reply.received; sequence = resumed.reply.sequence;
          if (resumed.reply.complete) {
            const link = this.context.host.links.get(peerId);
            if (link) await this.context.handleData(link, JSON.stringify({ type: "ack", id: message.id }));
          } else transfer.finished = false;
        }
      }
      return true;
    } finally {
      await native.release(message.id).catch(() => { });
      if (!saved) await destination?.abort().catch(() => { });
    }
  }

}
