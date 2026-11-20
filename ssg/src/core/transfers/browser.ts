import { usesBulkFile } from "../network/libp2p/rtc-bulk";
import { TRANSFER_CONFIG } from '../../config';
import type { TransportChannel } from '../network/types';
import { encodeChunk, MAX_BUFFERED_FILE_BYTES } from '../protocol';
import { transferMetrics as metrics } from '../transferMetrics';
import type { AttachmentSource, FileDestination } from '../types';
import type { TransferExecution } from "./execution";
import { errorMessage, readFileBlock, singleFileReadPlan } from './io';
import type { OutgoingTransfer } from './state';

class TransferConnectionError extends Error { }
/** Browser source reads, bounded writes and resume keep their existing scheduling. */
export class BrowserTransferBackend {
  constructor(private readonly context: TransferExecution) { }
  async send(file: AttachmentSource, transfer: OutgoingTransfer, channel: TransportChannel, external: boolean): Promise<boolean> {
    if (transfer.resumable) return this.sendResumableAttachment(file, transfer, channel, external);
    const { message } = transfer;
    const streaming = file.size > MAX_BUFFERED_FILE_BYTES;
    message.status = "sending";
    await this.context.host.history.recordMessage(message);
    const check = () => {
      if (!this.context.outgoing.has(message.id))
        throw new Error("文件传输已取消");
    };
    let destination: FileDestination | undefined;
    // OPFS and desktop storage copy each bounded block to disk while sending
    // the same block to the peer; no complete attachment is buffered in JS.
    const cached: ArrayBuffer[] = [];
    const { chunkBytes: chunkSize, readBytes } = singleFileReadPlan(channel, file.size);
    let sequence = 0;
    let reported = -1;
    try {
      check();
      if (this.context.host.storage.createFileDestination)
        destination = await this.context.host.storage.createFileDestination(message);
      check();
      for (
        let offset = 0;
        offset < file.size;
        offset += readBytes
      ) {
        check();
        const block = await readFileBlock(file, offset, readBytes);
        check();
        if (!external && !destination && !(file instanceof Blob))
          cached.push(block);
        // Only one storage block is in flight. A slow disk or receiver
        // applies backpressure before the next source read.
        const bytes = new Uint8Array(block);
        await Promise.all([
          destination?.write(new Blob([block])),
          (async () => {
            for (
              let start = 0;
              start < block.byteLength;
              start += chunkSize
            ) {
              check();
              await this.context.waitForBuffer(channel);
              if (streaming || this.context.outgoing.get(message.id)?.streaming)
                await this.context.waitForTransfer(
                  message.id,
                  (transfer) =>
                    offset + start <
                    (transfer.receivedBytes || 0) +
                    TRANSFER_CONFIG.streamWindowBytes,
                  TRANSFER_CONFIG.timeoutMs,
                  "文件传输超时",
                );
              check();
              const chunk = bytes.subarray(start, start + chunkSize);
              channel.send(encodeChunk(message.id, sequence++, chunk), usesBulkFile(file.size));
              this.context.outgoing.get(message.id)!.sentBytes =
                offset + start + chunk.byteLength;
              const percentage = Math.min(
                99,
                Math.floor(
                  ((offset + start + chunk.byteLength) / file.size) * 100,
                ),
              );
              if (percentage !== reported) {
                reported = percentage;
                this.context.progress(message.id, percentage);
              }
            }
          })(),
        ]);
      }
      check();
      if (destination) await destination.close();
      else if (!external)
        await this.context.host.history.write(async () => {
          check();
          await this.context.host.storage.saveAttachment(
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
      await this.context.failOutgoing(message.id, errorMessage(error));
      await destination?.abort().catch(() => undefined);
      throw error;
    }
    await this.context.waitForBuffer(channel);
    if (!this.context.outgoing.has(message.id)) return false;
    this.context.outgoing.get(message.id)!.finished = true;
    this.context.sendControl(channel, { type: "file-end", id: message.id });
    await this.context.host.history.recordMessage({ ...message, status: "sent" });
    if (this.context.outgoing.has(message.id)) this.context.progress(message.id, 100);
    this.context.armAck(message.id);
    return (
      this.context.outgoing.has(message.id) ||
      this.context.host.history.knownMessages.get(message.id)?.status === "delivered"
    );

  }
  private async sendResumableAttachment(
    file: AttachmentSource, transfer: OutgoingTransfer, initial: TransportChannel, external: boolean,
  ): Promise<boolean> {
    const { message, peerId } = transfer;
    const check = () => {
      if (this.context.outgoing.get(message.id) !== transfer)
        throw new Error(transfer.failureReason || "文件传输已取消");
    };
    let channel = initial;
    let offset = 0;
    let sequence = 0;
    let cachedBytes = 0;
    let saved = false;
    let recoveryUntil: number | undefined;
    let recoveryOffset = 0;
    let destination: FileDestination | undefined;
    const cached: ArrayBuffer[] = [];
    const interrupted = new Promise<void>((resolve) => { transfer.interrupt = resolve; });
    // Only failures in network operations trigger recovery; disk/source errors remain terminal.
    const network = async (action: () => void | Promise<void>) => {
      check();
      if (transfer.paused || transfer.channel !== channel || channel.readyState !== "open")
        throw new TransferConnectionError();
      try { await action(); }
      catch (error) { check(); throw new TransferConnectionError(errorMessage(error)); }
      check();
      if (transfer.paused || transfer.channel !== channel || channel.readyState !== "open")
        throw new TransferConnectionError();
    };
    try {
      message.status = "sending";
      await this.context.host.history.recordMessage(message);
      check();
      if (this.context.host.storage.createFileDestination)
        destination = await this.context.host.storage.createFileDestination(message);
      while (!transfer.acknowledged) {
        check();
        try {
          const { chunkBytes: chunkSize, readBytes } = singleFileReadPlan(channel, file.size, offset, sequence);
          while (offset < file.size) {
            await network(() => this.context.waitForBuffer(channel));
            const readStarted = transfer.trace && performance.now();
            const block = await metrics.timed("file.sourceRead", Math.min(readBytes, file.size - offset),
              () => readFileBlock(file, offset, readBytes));
            if (readStarted !== undefined) transfer.trace?.record("sourceRead", performance.now() - readStarted);
            check();
            const blockOffset = offset;
            const end = blockOffset + block.byteLength;
            const bytes = new Uint8Array(block);
            const save = (async () => {
              if (end <= cachedBytes) return;
              const skip = Math.max(0, cachedBytes - blockOffset);
              if (destination) {
                const tail = bytes.subarray(skip);
                const copyStarted = transfer.trace && performance.now();
                await metrics.timed("file.sourceCopyWrite", tail.byteLength, () => destination!.write(new Blob([tail])));
                if (copyStarted !== undefined) transfer.trace?.record("sourceCopy", performance.now() - copyStarted);
              } else if (!external && !(file instanceof Blob)) cached.push(skip ? block.slice(skip) : block);
              cachedBytes = end;
            })();
            try {
              await Promise.all([save, (async () => {
                for (let start = 0; start < block.byteLength; start += chunkSize) {
                  await network(async () => {
                    await this.context.waitForBuffer(channel);
                    await this.context.waitForTransfer(message.id, (t) => !!t.paused ||
                      offset < (t.receivedBytes ?? 0) + TRANSFER_CONFIG.streamWindowBytes,
                      TRANSFER_CONFIG.timeoutMs, "文件传输超时", "file.windowWait");
                  });
                  const chunk = bytes.subarray(start, start + chunkSize);
                  await network(() => {
                    channel.send(encodeChunk(message.id, sequence++, chunk), usesBulkFile(file.size));
                    offset += chunk.byteLength;
                    transfer.sentBytes = Math.max(transfer.sentBytes ?? 0, offset);
                  });
                  const percentage = Math.min(99, Math.floor(offset / Math.max(file.size, 1) * 100));
                  if (this.context.host.snapshot.transfers[message.id] !== percentage) this.context.progress(message.id, percentage);
                }
              })()]);
            } catch (error) {
              // A resumed prefix must not be appended twice to the sender's local copy.
              if (error instanceof TransferConnectionError) {
                await Promise.race([save, interrupted]);
                check();
              }
              throw error;
            }
          }
          if (!saved) {
            if (destination) await destination.close();
            else if (!external) await this.context.host.history.write(async () => {
              check();
              await this.context.host.storage.saveAttachment(message.id,
                file instanceof Blob ? file : new Blob(cached, { type: file.type }));
            });
            saved = true;
          }
          await network(() => this.context.waitForBuffer(channel));
          transfer.finished = true;
          await network(() => this.context.sendControl(channel, { type: "file-end", id: message.id }));
          await this.context.host.history.recordMessage({ ...message, status: "sent" });
          if (transfer.acknowledged) break;
          this.context.progress(message.id, 100);
          // A missing final receipt is resolved by the same resume handshake, without replaying the file.
          await network(() => this.context.waitForTransfer(message.id,
            (t) => !!t.paused || !!t.acknowledged,
            TRANSFER_CONFIG.timeoutMs * 2, "等待接收确认超时"));
        } catch (error) {
          if (transfer.acknowledged) break;
          check();
          if (!(error instanceof TransferConnectionError)) throw error;
          recoveryUntil ??= Date.now() + TRANSFER_CONFIG.resumeTimeoutMs;
          const old = this.context.host.links.get(peerId);
          if (old?.channel === channel) this.context.host.failLink(old, "连接已中断，正在继续传输", false);
          const resumed = await this.context.resumeOutgoing(transfer, recoveryUntil);
          channel = resumed.channel;
          offset = resumed.reply.received;
          sequence = resumed.reply.sequence;
          if (!resumed.reply.complete) {
            transfer.finished = false;
            await this.context.host.history.recordMessage({ ...message, status: "sending" });
          }
          if (offset > recoveryOffset) {
            recoveryOffset = offset;
            recoveryUntil = undefined;
          }
          if (resumed.reply.complete) {
            const link = this.context.host.links.get(peerId);
            if (link?.channel === channel)
              await this.context.handleData(link, JSON.stringify({ type: "ack", id: message.id }));
          }
        }
      }
      return true;
    } catch (error) {
      // Stop the concurrent network loop before waiting for destination cleanup.
      await this.context.failOutgoing(message.id, errorMessage(error));
      throw error;
    } finally {
      transfer.interrupt = undefined;
      if (!saved) await destination?.abort().catch(() => undefined);
    }
  }

}
