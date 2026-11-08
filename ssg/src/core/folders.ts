import {
  CHUNK_SIZE,
  FOLDER_CONFIG,
  MAX_FILE_SIZE,
  MAX_TRANSFER_SIZE,
} from "../config";

export type FolderEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; file: File };
export type FolderSelection = { name: string; entries: FolderEntry[] };
export type FolderProgress = {
  phase: "scanning" | "compressing";
  fileCount: number;
  size: number;
};
export type ReadFolder = (
  signal: AbortSignal,
  report: (progress: FolderProgress) => void,
) => Promise<FolderSelection>;

export function validPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > FOLDER_CONFIG.maxPathLength
  )
    return false;
  const parts = path.split("/");
  return (
    parts.length <= FOLDER_CONFIG.maxDepth &&
    parts.every(
      (part) =>
        !!part &&
        part !== "." &&
        part !== ".." &&
        part.length <= 255 &&
        !/[\\\x00-\x1f\x7f]/.test(part),
    )
  );
}
export function validFolderName(name: unknown): name is string {
  return validPath(name) && !name.includes("/");
}

/** Checks every path before compression or sending; directories precede their children. */
export function inspectFolder(folder: FolderSelection) {
  if (!validFolderName(folder.name))
    throw new Error("文件夹名称无法使用，请重命名后重试");
  let size = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let metadataBytes = 0;
  let chunks = 0;
  const paths = new Set<string>();
  const directories = new Set<string>([""]);
  for (const entry of folder.entries) {
    if (
      !validPath(entry.path) ||
      paths.has(entry.path) ||
      !directories.has(entry.path.split("/").slice(0, -1).join("/"))
    )
      throw new Error("文件夹目录无法读取，请检查后重试");
    paths.add(entry.path);
    metadataBytes += new TextEncoder().encode(entry.path).byteLength;
    if (
      paths.size > FOLDER_CONFIG.maxEntries ||
      metadataBytes > FOLDER_CONFIG.maxMetadataBytes
    )
      throw new Error("文件夹内容过多，请分成几次发送");
    if (entry.kind === "directory") {
      directories.add(entry.path);
      directoryCount++;
    } else {
      if (!Number.isSafeInteger(entry.file.size) || entry.file.size < 0)
        throw new Error("文件无法读取，请重新选择");
      size += entry.file.size;
      chunks += Math.ceil(entry.file.size / CHUNK_SIZE);
      fileCount++;
      if (
        !Number.isSafeInteger(size) ||
        size > MAX_TRANSFER_SIZE ||
        chunks > 2 ** 32
      )
        throw new Error("文件夹过大，请分成几次发送");
    }
  }
  return {
    size,
    fileCount,
    directoryCount,
    compress:
      size <= MAX_FILE_SIZE && fileCount <= FOLDER_CONFIG.maxCompressedFiles,
  };
}

export async function compressFolder(
  folder: FolderSelection,
  signal: AbortSignal,
): Promise<File> {
  const { BlobReader, BlobWriter, ZipWriter } = await import("@zip.js/zip.js");
  signal.throwIfAborted();
  const writer = new ZipWriter(new BlobWriter("application/zip"), { level: 1 });
  try {
    await writer.add(`${folder.name}/`, undefined, { directory: true, signal });
    for (const entry of folder.entries) {
      signal.throwIfAborted();
      await writer.add(
        `${folder.name}/${entry.path}${entry.kind === "directory" ? "/" : ""}`,
        entry.kind === "file" ? new BlobReader(entry.file) : undefined,
        { directory: entry.kind === "directory", signal },
      );
    }
    const blob = await writer.close();
    signal.throwIfAborted();
    return new File([blob], `${folder.name.slice(0, 251)}.zip`, {
      type: "application/zip",
    });
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}
