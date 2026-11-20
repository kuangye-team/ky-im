import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AttachmentSource } from "../core/types";

export async function desktopSources(paths: string[]): Promise<{ files: AttachmentSource[]; directories: string[] }> {
  const entries = await invoke<{ path: string; name: string; size: number; type: string; directory: boolean }[]>("file_sources", { paths });
  return {
    directories: entries.filter(e => e.directory).map(e => e.path),
    files: entries.filter(e => !e.directory).map(e => ({
      name: e.name, size: e.size, type: e.type, nativeSource: { path: e.path },
      slice: () => ({ arrayBuffer: async () => { throw new Error("文件暂时无法读取，请重新选择"); } }),
    })),
  };
}
export async function chooseDesktopSources(images = false) {
  const paths = await open({ multiple: true, directory: false,
    ...(images ? { filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] }] } : {}),
  });
  return paths ? (await desktopSources(paths)).files : [];
}
