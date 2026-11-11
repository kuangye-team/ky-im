import { open as choose } from "@tauri-apps/plugin-dialog";
import { open, readDir, stat, SeekMode } from "@tauri-apps/plugin-fs";
import { basename, join } from "@tauri-apps/api/path";
import { createFolderCollector } from "./folderSelection";
import type { FolderProgress, FolderSelection } from "../core/folders";

/** Native selection also discovers empty directories, which webkitdirectory omits. */
export async function readDesktopFolder(
  signal: AbortSignal,
  report: (progress: FolderProgress) => void,
): Promise<FolderSelection> {
  const root = await choose({
    directory: true,
    multiple: false,
    recursive: true,
  });
  if (!root) throw new DOMException("Cancelled", "AbortError");
  const result = createFolderCollector(signal, report);
  // One shared read-ahead block bounds memory even for folders with many files.
  let cached:
    | { path: string; offset: number; bytes: Uint8Array<ArrayBuffer> }
    | undefined;
  async function read(path: string, start: number, end: number, size: number) {
    signal.throwIfAborted();
    end = Math.min(end, size);
    if (
      !cached ||
      cached.path !== path ||
      start < cached.offset ||
      end > cached.offset + cached.bytes.length
    ) {
      const handle = await open(path, { read: true });
      try {
        await handle.seek(start, SeekMode.Start);
        const bytes = new Uint8Array(Math.min(256 * 1024, size - start));
        let received = 0;
        while (received < bytes.length) {
          signal.throwIfAborted();
          const count = await handle.read(bytes.subarray(received));
          if (!count) throw new Error("文件无法读取，请重新选择");
          received += count;
        }
        cached = { path, offset: start, bytes };
      } finally {
        await handle.close();
      }
    }
    return cached.bytes.slice(start - cached.offset, end - cached.offset)
      .buffer;
  }
  async function visit(directory: string, prefix: string) {
    for (const child of await readDir(directory)) {
      signal.throwIfAborted();
      // Links may leave the selected directory or create recursive cycles.
      if (child.isSymlink) throw new Error("文件夹包含符号链接，请移除后重试");
      const path = prefix + child.name;
      const absolute = await join(directory, child.name);
      if (child.isDirectory) {
        result.add({ kind: "directory", path });
        await visit(absolute, path + "/");
      } else if (child.isFile) {
        const info = await stat(absolute);
        result.add({
          kind: "file",
          path,
          file: {
            name: child.name,
            type: "",
            size: info.size,
            slice: (start, end) => ({
              arrayBuffer: () => read(absolute, start, end, info.size),
            }),
          },
        });
      }
    }
  }
  await visit(root, "");
  return { name: await basename(root), entries: result.entries };
}
