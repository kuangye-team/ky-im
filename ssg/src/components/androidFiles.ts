import { invoke } from "@tauri-apps/api/core";
import type { AndroidDocument, AttachmentSource } from "../core/types";
import type { FolderProgress, FolderSelection } from "../core/folders";
import { createFolderCollector } from "./folderSelection";

interface Entry {
  uri: AndroidDocument;
  name: string;
  size: number;
  type: string;
  directory?: boolean;
}

function file(entry: Entry): AttachmentSource {
  return {
    name: entry.name, type: entry.type, size: entry.size,
    nativeSource: { document: entry.uri, size: entry.size },
    slice: (start, end) => ({
      arrayBuffer: () => invoke<ArrayBuffer>("android_read", {
        uri: entry.uri, offset: start, length: Math.max(0, Math.min(end, entry.size) - start),
      }),
    }),
  };
}

export async function chooseFiles(images: boolean) {
  return (await invoke<Entry[]>("android_pick_files", { images })).map(file);
}

export async function chooseFolder(signal: AbortSignal, report: (progress: FolderProgress) => void): Promise<FolderSelection> {
  const root = await invoke<Entry | null>("android_pick_folder");
  if (!root) throw new DOMException("Cancelled", "AbortError");
  const result = createFolderCollector(signal, report);
  const visited = new Set([root.uri.uri]);
  async function visit(uri: AndroidDocument, prefix: string) {
    for (let offset = 0; ; offset += 128) {
      signal.throwIfAborted();
      const entries = await invoke<Entry[]>("android_children", { uri, offset });
      for (const entry of entries) {
        if (entry.name.includes("/")) throw new Error("文件夹目录无法读取，请检查后重试");
        const path = prefix + entry.name;
        if (entry.directory) {
          if (visited.has(entry.uri.uri)) throw new Error("文件夹中有重复目录，请重新选择");
          visited.add(entry.uri.uri);
          result.add({ kind: "directory", path });
          await visit(entry.uri, path + "/");
        } else result.add({ kind: "file", path, file: file(entry) });
      }
      if (entries.length < 128) return;
    }
  }
  await visit(root.uri, "");
  return { name: root.name, entries: result.entries };
}
