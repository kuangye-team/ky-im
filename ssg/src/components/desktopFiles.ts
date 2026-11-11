import { save, open as choose } from "@tauri-apps/plugin-dialog";
import { open, mkdir, exists, type FileHandle } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { validFolderName, validPath } from "../core/folders";
import type { FileDestination, FolderDestination } from "../core/types";

function destination(file: FileHandle): FileDestination {
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await file.close();
    }
  };
  return {
    async write(blob) {
      if (closed) throw new Error("文件已关闭");
      // Keep each IPC write bounded even when exporting a large saved attachment.
      for (let offset = 0; offset < blob.size; offset += 64 * 1024) {
        const bytes = new Uint8Array(
          await blob.slice(offset, offset + 64 * 1024).arrayBuffer(),
        );
        if ((await file.write(bytes)) !== bytes.byteLength)
          throw new Error("文件未能完整保存");
      }
    },
    close,
    abort: close,
  };
}

export async function chooseDesktopFile(
  name: string,
): Promise<FileDestination> {
  const path = await save({ defaultPath: name.replace(/[/\\]/g, "_") });
  if (!path) throw new DOMException("Cancelled", "AbortError");
  return destination(
    await open(path, { write: true, create: true, truncate: true }),
  );
}

export async function chooseDesktopFolder(
  name: string,
): Promise<FolderDestination> {
  if (!validFolderName(name))
    throw new Error("文件夹名称无法使用，请重命名后重试");
  const parent = await choose({
    directory: true,
    multiple: false,
    recursive: true,
  });
  if (!parent) throw new DOMException("Cancelled", "AbortError");
  let root = "";
  for (let i = 0; i < 1000; i++) {
    const candidate = await join(
      parent,
      i ? `${name.slice(0, 240)} (${i + 1})` : name,
    );
    if (!(await exists(candidate))) {
      await mkdir(candidate);
      root = candidate;
      break;
    }
  }
  if (!root) throw new Error("同名文件夹过多，请选择其他保存位置");
  const directories = new Set([""]);
  async function target(path: string) {
    if (!validPath(path)) throw new Error("文件夹目录无法读取，请检查后重试");
    const parts = path.split("/");
    if (!directories.has(parts.slice(0, -1).join("/")))
      throw new Error("文件夹目录无法读取，请检查后重试");
    return join(root, ...parts);
  }
  return {
    async createDirectory(path) {
      await mkdir(await target(path));
      directories.add(path);
    },
    async createFile(path) {
      return destination(
        await open(await target(path), { write: true, createNew: true }),
      );
    },
  };
}
