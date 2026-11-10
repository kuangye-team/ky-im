import type {
  FileDestination,
  FolderDestination,
  StorageAdapter,
  Message,
} from "../core/types";
import { validFolderName, validPath } from "../core/folders";
import type { DirectoryPickerWindow } from "./folderSelection";

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<FileSystemFileHandle>;
};

export function canSaveLargeFiles() {
  return (
    import.meta.env.VITE_DESKTOP ||
    typeof (window as SavePickerWindow).showSaveFilePicker === "function"
  );
}

export function canSaveFolders() {
  return (
    import.meta.env.VITE_DESKTOP ||
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function"
  );
}

async function exists(directory: FileSystemDirectoryHandle, name: string) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TypeMismatchError")
      return true;
    if (error instanceof DOMException && error.name === "NotFoundError")
      return false;
    throw error;
  }
}

/** A fresh root keeps existing files intact; duplicate/case-colliding entries fail safely. */
export async function chooseFolderDestination(
  name: string,
): Promise<FolderDestination> {
  if (import.meta.env.VITE_DESKTOP)
    return (await import("./desktopFiles")).chooseDesktopFolder(name);
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker)
    throw new Error(
      "当前浏览器不支持保存文件夹，请使用电脑上的 Chrome 或 Edge 打开安全连接后重试",
    );
  if (!validFolderName(name))
    throw new Error("文件夹名称无法使用，请重命名后重试");
  const parent = await picker.call(window, { mode: "readwrite" });
  let root: FileSystemDirectoryHandle | undefined;
  for (let i = 0; i < 1000; i++) {
    const candidate = i ? `${name.slice(0, 240)} (${i + 1})` : name;
    if (!(await exists(parent, candidate))) {
      root = await parent.getDirectoryHandle(candidate, { create: true });
      break;
    }
  }
  if (!root) throw new Error("同名文件夹过多，请选择其他保存位置");
  const directories = new Map<string, FileSystemDirectoryHandle>([["", root]]);
  async function target(path: string) {
    if (!validPath(path)) throw new Error("文件夹目录无法读取，请检查后重试");
    const parts = path.split("/");
    const name = parts.pop()!;
    const directory = directories.get(parts.join("/"));
    if (!directory) throw new Error("文件夹目录无法读取，请检查后重试");
    if (await exists(directory, name))
      throw new Error("文件夹中存在重名内容，已停止接收以避免覆盖");
    return { directory, name };
  }
  return {
    async createDirectory(path) {
      const { directory, name } = await target(path);
      directories.set(
        path,
        await directory.getDirectoryHandle(name, { create: true }),
      );
    },
    async createFile(path) {
      const { directory, name } = await target(path);
      const file = await directory.getFileHandle(name, { create: true });
      return file.createWritable();
    },
  };
}

/** Invoke directly from a click, before any await, to preserve user activation. */
export async function chooseFileDestination(
  fileName: string,
): Promise<FileDestination> {
  if (import.meta.env.VITE_DESKTOP)
    return (await import("./desktopFiles")).chooseDesktopFile(fileName);
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker)
    throw new Error(
      "当前浏览器不支持接收超大文件，请使用电脑上的 Chrome 或 Edge 打开安全连接后重试",
    );
  const handle = await picker.call(window, { suggestedName: fileName });
  return handle.createWritable();
}

export function readableSize(size = 0) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

/** Desktop exports stay on disk, including files too large to materialize as a Blob. */
export async function downloadAttachment(
  storage: StorageAdapter,
  message: Message,
) {
  if (storage.exportAttachment) return storage.exportAttachment(message);
  const blob = await storage.getAttachment(message.id);
  if (!blob) throw new Error("附件尚未接收完成或已被清除");
  return download(blob, message.fileName || "attachment");
}

export async function download(blob: Blob, fileName: string) {
  if (import.meta.env.VITE_DESKTOP) {
    const file = await chooseFileDestination(fileName);
    try {
      await file.write(blob);
      await file.close();
    } catch (error) {
      await file.abort().catch(() => {});
      throw error;
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
