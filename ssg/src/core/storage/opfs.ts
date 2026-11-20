import { STORAGE_CONFIG } from "../../config";
import { validPath } from "../folders";
import type { FileDestination, FolderDestination } from "../types";

export type AttachmentRecord = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  folder: boolean;
};

export type DirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
};

export const OPFS_DIRECTORY = "ky-im-files";

export function storageError(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? new Error("浏览器可用空间不足，请清理文件后重试") : error;
}

export async function openWritable(handle: FileSystemFileHandle) {
  if (typeof handle.createWritable !== "function")
    throw new Error("当前浏览器无法保存文件，请更新浏览器并使用安全连接后重试");
  try { return await handle.createWritable(); }
  catch (error) { throw storageError(error); }
}

/** Keep unfinished writes alive across adapters/tabs; a crashed tab releases its locks. */
export async function holdAttachmentLock(name: string): Promise<() => void> {
  if (!navigator.locks) return () => {};
  let release!: () => void;
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  void navigator.locks.request(name, async () => {
    const done = new Promise<void>((resolve) => { release = resolve; });
    acquired();
    await done;
  }).catch(failed);
  await ready;
  return release;
}

export async function removeEntry(directory: FileSystemDirectoryHandle, name: string) {
  try { await directory.removeEntry(name, { recursive: true }); }
  catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
}

/** Only this namespace belongs to chat; never clear other origin-private files. */
export async function attachmentDirectory(databaseName: string) {
  if (!navigator.storage?.getDirectory)
    throw new Error("当前浏览器无法保存文件，请更新浏览器并使用安全连接后重试");
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
  return app.getDirectoryHandle(encodeURIComponent(databaseName), { create: true });
}

export async function resetBrowserAttachments(databaseName: string) {
  const root = await navigator.storage.getDirectory();
  try {
    const app = await root.getDirectoryHandle(OPFS_DIRECTORY);
    await removeEntry(app, encodeURIComponent(databaseName));
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

export async function attachmentFile(directory: FileSystemDirectoryHandle, record: AttachmentRecord) {
  const root = await directory.getDirectoryHandle(record.path);
  const file = await (await root.getFileHandle("file")).getFile();
  // File wraps a disk-backed Blob without reading its contents into JavaScript memory.
  return new File([file], record.name, { type: record.mimeType, lastModified: file.lastModified });
}

/** All writes are bounded, including callers passing a large disk-backed File. */
export function fileWriter(
  initialStream: FileSystemWritableFileStream,
  size: number,
  done: () => Promise<void>,
  abort: () => Promise<void>,
  handle?: FileSystemFileHandle,
): FileDestination {
  let stream: FileSystemWritableFileStream | undefined = initialStream;
  let written = 0;
  let closed = false;
  let cancelled = false;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (action: () => Promise<void>) => {
    const next = queue.then(action).catch((error) => { throw storageError(error); });
    queue = next.catch(() => {});
    return next;
  };
  return {
    write: (blob) => enqueue(async () => {
      if (closed || cancelled) throw new Error("文件传输已取消");
      if (written + blob.size > size) throw new Error("文件大小发生变化，请重新发送");
      for (let offset = 0; offset < blob.size; offset += STORAGE_CONFIG.chunkBytes) {
        if (cancelled) throw new Error("文件传输已取消");
        if (!stream) {
          stream = await handle!.createWritable({ keepExistingData: true });
          await stream.seek(written);
        }
        await stream.write(blob.slice(offset, offset + STORAGE_CONFIG.chunkBytes));
      }
      written += blob.size;
    }),
    copyPrefixTo: handle && ((target) => enqueue(async () => {
      if (closed || cancelled) throw new Error("文件传输已取消");
      if (written === 0) return;
      // OPFS exposes the staged bytes only after close. Reopen at the same offset on rollback.
      await stream?.close();
      stream = undefined;
      const file = await handle.getFile();
      if (file.size !== written) throw new Error("文件没有读取完整，请重试");
      for (let at = 0; at < written; at += STORAGE_CONFIG.chunkBytes) {
        if (cancelled) throw new Error("文件传输已取消");
        await target.write(file.slice(at, at + STORAGE_CONFIG.chunkBytes));
      }
    })),
    close: () => enqueue(async () => {
      if (cancelled) throw new Error("文件传输已取消");
      if (closed) return;
      if (written !== size) throw new Error("文件尚未接收完整，请重新发送");
      await stream?.close();
      closed = true;
      await done();
    }),
    abort: () => {
      cancelled = true;
      return enqueue(async () => {
        if (!closed) await stream?.abort().catch(() => {});
        closed = true;
        await abort();
      });
    },
  };
}

export function folderWriter(
  root: FileSystemDirectoryHandle,
  size: number,
  done: () => Promise<void>,
  abort: () => Promise<void>,
): FolderDestination {
  const directories = new Map<string, FileSystemDirectoryHandle>([["", root]]);
  const paths = new Set<string>();
  const open = new Set<FileDestination>();
  let written = 0;
  let closed = false;
  let cancelled = false;
  function target(path: string) {
    if (closed || cancelled) throw new Error("文件传输已取消");
    if (!validPath(path) || paths.has(path)) throw new Error("文件夹目录无法读取，请检查后重试");
    const parts = path.split("/");
    const name = parts.pop()!;
    const directory = directories.get(parts.join("/"));
    if (!directory) throw new Error("文件夹目录无法读取，请检查后重试");
    paths.add(path);
    return { directory, name };
  }
  return {
    async createDirectory(path) {
      const { directory, name } = target(path);
      directories.set(path, await directory.getDirectoryHandle(name, { create: true }));
    },
    async createFile(path, length = 0) {
      const { directory, name } = target(path);
      if (!Number.isSafeInteger(length) || length < 0 || written + length > size)
        throw new Error("文件大小发生变化，请重新发送");
      const stream = await openWritable(await directory.getFileHandle(name, { create: true }));
      if (cancelled) { await stream.abort(); throw new Error("文件传输已取消"); }
      const writer = fileWriter(stream, length, async () => {
        written += length;
        open.delete(writer);
      }, async () => {});
      open.add(writer);
      return writer;
    },
    async close() {
      if (cancelled) throw new Error("文件传输已取消");
      if (closed) return;
      if (open.size || written !== size) throw new Error("文件夹尚未接收完整，请重新发送");
      await done();
      closed = true;
    },
    async abort() {
      cancelled = true;
      await Promise.all([...open].map((writer) => writer.abort()));
      open.clear();
      await abort();
    },
  };
}

export async function* folderEntries(root: FileSystemDirectoryHandle, parent = ""): AsyncGenerator<{
  path: string; handle: FileSystemHandle;
}> {
  for await (const handle of (root as DirectoryHandle).values()) {
    const path = parent + handle.name;
    yield { path, handle };
    if (handle.kind === "directory") yield* folderEntries(handle as FileSystemDirectoryHandle, path + "/");
  }
}
