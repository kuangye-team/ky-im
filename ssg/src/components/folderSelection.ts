import { FOLDER_CONFIG } from "../config";
import {
  validPath,
  type FolderEntry,
  type FolderProgress,
  type FolderSelection,
} from "../core/folders";

export type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
};
type DirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
};

function collector(
  signal: AbortSignal,
  report: (progress: FolderProgress) => void,
) {
  const entries: FolderEntry[] = [];
  let fileCount = 0;
  let size = 0;
  let metadataBytes = 0;
  let lastReport = 0;
  return {
    entries,
    add(entry: FolderEntry) {
      signal.throwIfAborted();
      if (!validPath(entry.path))
        throw new Error("文件夹目录无法读取，请检查后重试");
      metadataBytes += new TextEncoder().encode(entry.path).byteLength;
      if (
        entries.length >= FOLDER_CONFIG.maxEntries ||
        metadataBytes > FOLDER_CONFIG.maxMetadataBytes
      )
        throw new Error("文件夹内容过多，请分成几次发送");
      entries.push(entry);
      if (entry.kind === "file") {
        fileCount++;
        size += entry.file.size;
      }
      if (performance.now() - lastReport > 80 || entries.length === 1) {
        lastReport = performance.now();
        report({ phase: "scanning", fileCount, size });
      }
    },
  };
}

export async function readDirectory(
  handle: FileSystemDirectoryHandle,
  signal: AbortSignal,
  report: (progress: FolderProgress) => void,
): Promise<FolderSelection> {
  const result = collector(signal, report);
  async function visit(directory: FileSystemDirectoryHandle, parent: string) {
    for await (const child of (directory as DirectoryHandle).values()) {
      signal.throwIfAborted();
      const path = parent + child.name;
      if (child.kind === "directory") {
        result.add({ kind: "directory", path });
        await visit(child as FileSystemDirectoryHandle, path + "/");
      } else
        result.add({
          kind: "file",
          path,
          file: await (child as FileSystemFileHandle).getFile(),
        });
    }
  }
  await visit(handle, "");
  return { name: handle.name, entries: result.entries };
}

/** Capture entries synchronously in the drop handler; read every directory batch. */
export async function readDroppedDirectory(
  root: FileSystemDirectoryEntry,
  signal: AbortSignal,
  report: (progress: FolderProgress) => void,
): Promise<FolderSelection> {
  const result = collector(signal, report);
  async function visit(directory: FileSystemDirectoryEntry, parent: string) {
    const reader = directory.createReader();
    for (;;) {
      signal.throwIfAborted();
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (!batch.length) break;
      for (const child of batch) {
        signal.throwIfAborted();
        const path = parent + child.name;
        if (child.isDirectory) {
          result.add({ kind: "directory", path });
          await visit(child as FileSystemDirectoryEntry, path + "/");
        } else {
          const file = await new Promise<File>((resolve, reject) =>
            (child as FileSystemFileEntry).file(resolve, reject),
          );
          result.add({ kind: "file", path, file });
        }
      }
    }
  }
  await visit(root, "");
  return { name: root.name, entries: result.entries };
}

/** The input fallback exposes file paths only; its UI explains the empty-directory limitation. */
export async function readDirectoryFiles(
  files: File[],
  signal: AbortSignal,
  report: (progress: FolderProgress) => void,
): Promise<FolderSelection> {
  if (!files.length) throw new Error("没有读取到文件，请尝试拖入文件夹");
  const name = files[0].webkitRelativePath.split("/")[0];
  const result = collector(signal, report);
  const directories = new Set<string>();
  for (const file of files) {
    if (result.entries.length % 128 === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
    const parts = file.webkitRelativePath.split("/");
    if (parts.shift() !== name) throw new Error("请一次选择一个文件夹");
    const path = parts.join("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join("/");
      if (!directories.has(directory)) {
        result.add({ kind: "directory", path: directory });
        directories.add(directory);
      }
    }
    result.add({ kind: "file", path, file });
  }
  return { name, entries: result.entries };
}
