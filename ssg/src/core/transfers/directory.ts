import { TRANSFER_CONFIG } from "../../config";
import type { FolderEntry } from "../folders";
import type { TransportChannel } from "../network/types";
import { encodeChunk, type ControlPacket } from "../protocol";
import type { AttachmentSource, FileDestination, FolderDestination } from "../types";
import type { TransferExecution } from "./execution";
import { errorMessage, fileChunkSize } from "./io";
import type { OutgoingTransfer } from "./state";
import type { FileTaskExecutor } from "./types";

class ConnectionLost extends Error {
  constructor(message = "文件传输中断") { super(message); }
}

/** Each committed receiver entry advances the cursor, including zero-length entries. */
export async function sendDirectoryEntries(context: TransferExecution, task: OutgoingTransfer,
  initial: TransportChannel, entries: FolderEntry[], local: FolderDestination | undefined,
  check: () => void, finishLocal: () => Promise<void>) {
  const { message, peerId } = task;
  const id = message.id;
  let channel = initial;
  let index = 0, base = 0, offset = 0, sequence = 0;
  let opened = false, localFinished = false;
  let writer: FileDestination | undefined, native: FileTaskExecutor | undefined;
  let cached = 0, deadline: number | undefined;
  let confirmedIndex = -1, confirmedBytes = -1;
  const network = async (action: () => void | Promise<void>) => {
    check();
    if (task.paused || channel.readyState !== "open") throw new ConnectionLost();
    try { await action(); } catch (error) { check(); throw new ConnectionLost(errorMessage(error)); }
    if (!task.acknowledged && (task.paused || channel.readyState !== "open")) throw new ConnectionLost();
  };
  const control = (packet: ControlPacket) => network(() => context.sendControl(channel, packet));
  const wait = (ready: () => boolean) => network(() => context.waitForTransfer(id,
    () => !!task.paused || ready(), TRANSFER_CONFIG.timeoutMs, "文件传输超时"));
  const sendFile = async (file: AttachmentSource) => {
    const size = file.size;
    if (channel.fileTasks) {
      if (!native) {
        native = task.native = channel.fileTasks;
        await native.sender(id, file);
      }
      try {
        const result = await native.send(id, offset, sequence, base);
        sequence = result.sequence;
        offset = size;
        task.sentBytes = result.sent;
      } catch (error) {
        if (!errorMessage(error).startsWith("network:")) throw error;
        const state = await native.state(id);
        task.sentBytes = Math.max(task.sentBytes ?? 0, state.sent ?? 0);
        throw new ConnectionLost(errorMessage(error));
      }
    } else {
      const chunkSize = fileChunkSize(channel);
      while (offset < size) {
        await network(() => context.waitForBuffer(channel));
        await wait(() => base + offset < (task.receivedBytes ?? 0) + TRANSFER_CONFIG.streamWindowBytes);
        const end = Math.min(offset + chunkSize, size);
        const bytes = await file.slice(offset, end).arrayBuffer();
        if (bytes.byteLength !== end - offset) throw new Error("文件已发生变化，请重新选择文件夹");
        if (writer && end > cached) {
          await writer.write(new Blob([bytes.slice(Math.max(0, cached - offset))]));
          cached = end;
        }
        await network(() => {
          task.sentBytes = Math.max(task.sentBytes ?? 0, base + end);
          channel.send(encodeChunk(id, sequence++, bytes));
        });
        offset = end;
        const progress = Math.min(99, Math.floor((base + offset) / message.size! * 100));
        if (context.host.snapshot.transfers[id] !== progress) context.progress(id, progress);
      }
    }
  };
  const advance = async (size: number) => {
    await writer?.close();
    writer = undefined;
    if (native) { await native.release(id); native = undefined; }
    index++;
    base += size;
    offset = cached = 0;
    opened = false;
    task.folderIndex = undefined;
  };
  try {
    while (!task.acknowledged) {
      check();
      const entry = entries[index];
      const size = entry?.kind === "file" ? entry.file.size : 0;
      try {
        if (!entry) {
          if (!localFinished) { await finishLocal(); localFinished = true; }
          task.finished = true;
          await control({ type: "folder-end", id });
          if (task.acknowledged) return;
          await context.host.history.recordMessage({ ...message, status: "sent" });
          if (!task.resumable) { context.armAck(id); return; }
          await wait(() => !!task.acknowledged);
          continue;
        }
        if (task.folderIndex !== index) {
          task.folderIndex = index;
          task.entryEnded = false;
          if (entry.kind === "directory") await local?.createDirectory(entry.path);
          else writer = await local?.createFile(entry.path, size);
        }
        if (!opened) {
          await network(() => context.waitForBuffer(channel));
          await control({ type: "folder-entry", id, index, path: entry.path, kind: entry.kind, size });
          await wait(() => task.entryReady === index);
          opened = true;
        }
        if (entry.kind === "file" && offset < size) await sendFile(entry.file);
        task.entryEnded = true;
        await control({ type: "folder-entry-end", id, index });
        await wait(() => task.entrySaved === index);
        await advance(size);
        if (!message.size) context.progress(id, Math.min(99, Math.floor(index / entries.length * 100)));
      } catch (error) {
        if (task.acknowledged) return;
        check();
        if (!(error instanceof ConnectionLost) || !task.resumable) throw error;
        deadline ??= Date.now() + TRANSFER_CONFIG.resumeTimeoutMs;
        const link = context.host.links.get(peerId);
        if (link?.channel === channel) context.host.failLink(link, "连接已中断，正在继续传输", false);
        const recovered = await context.resumeOutgoing(task, deadline);
        channel = recovered.channel;
        const { reply } = recovered;
        if (reply.complete) {
          const live = context.host.links.get(peerId);
          if (live) await context.handleData(live, JSON.stringify({ type: "ack", id }));
          return;
        }
        const cursor = reply.folder;
        if (!cursor || cursor.index < index || cursor.index > entries.length ||
          cursor.index > index + 1 || (!entry && cursor.offset !== undefined) || (cursor.offset ?? 0) > size)
          throw new Error("文件进度无法确认，请重新发送");
        if (cursor.index === index + 1) {
          if (!task.entryEnded || cursor.offset !== undefined || reply.received !== base + size)
            throw new Error("文件进度无法确认，请重新发送");
          await advance(size);
        } else {
          if (reply.received !== base + (cursor.offset ?? 0)) throw new Error("文件进度无法确认，请重新发送");
          opened = cursor.offset !== undefined;
          offset = cursor.offset ?? 0;
          task.entryReady = task.entrySaved = undefined;
          task.entryEnded = false;
        }
        sequence = reply.sequence;
        if (cursor.index > confirmedIndex || reply.received > confirmedBytes) deadline = undefined;
        confirmedIndex = cursor.index;
        confirmedBytes = reply.received;
      }
    }
  } finally {
    if (native) await native.release(id).catch(() => {});
    await writer?.abort().catch(() => {});
  }
}
