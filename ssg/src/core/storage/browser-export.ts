import type { Message } from "../types";
import { canSaveFolders, chooseFolderDestination, download } from "../../components/fileDownloads";
import { attachmentFile, folderEntries, storageError, type AttachmentRecord } from "./opfs";
import { STORAGE_CONFIG } from "../../config";

type TemporaryFile = {
  handle: FileSystemFileHandle;
  stream: FileSystemWritableFileStream;
  dispose(): Promise<void>;
};

export async function exportBrowserAttachment(
  message: Message,
  source: () => Promise<{ record: AttachmentRecord; directory: FileSystemDirectoryHandle }>,
  temporary: () => Promise<TemporaryFile>,
) {
  // Invoke the picker before awaiting metadata: the click's activation is required.
  const destination = message.folder && canSaveFolders()
    ? await chooseFolderDestination(message.fileName || "附件")
    : undefined;
  const { record, directory } = await source();
  if (!record.folder) return download(await attachmentFile(directory, record), message.fileName || record.name);
  const root = await directory.getDirectoryHandle(record.path);
  if (destination) {
    try {
      for await (const entry of folderEntries(root)) {
        if (entry.handle.kind === "directory") await destination.createDirectory(entry.path);
        else {
          const file = await (entry.handle as FileSystemFileHandle).getFile();
          const writer = await destination.createFile(entry.path, file.size);
          try {
            for (let offset = 0; offset < file.size; offset += STORAGE_CONFIG.chunkBytes)
              await writer.write(file.slice(offset, offset + STORAGE_CONFIG.chunkBytes));
            await writer.close();
          } catch (error) { await writer.abort().catch(() => {}); throw error; }
        }
      }
      await destination.close?.();
    } catch (error) { await destination.abort?.().catch(() => {}); throw error; }
    return;
  }
  // zip.js writes ZIP64 archives into OPFS, so export never buffers the whole folder.
  const { ZipWriter, BlobReader } = await import("@zip.js/zip.js");
  const temp = await temporary();
  const writer = new ZipWriter(temp.stream, { level: 0, bufferedWrite: false, dataDescriptor: true });
  try {
    await writer.add(`${record.name}/`, undefined, { directory: true });
    for await (const entry of folderEntries(root)) {
      const isDirectory = entry.handle.kind === "directory";
      await writer.add(`${record.name}/${entry.path}${isDirectory ? "/" : ""}`,
        isDirectory ? undefined : new BlobReader(await (entry.handle as FileSystemFileHandle).getFile()),
        { directory: isDirectory });
    }
    await writer.close();
    await download(await temp.handle.getFile(), `${record.name}.zip`);
    // Keep the disk-backed download valid until the browser has consumed its URL.
    setTimeout(() => { void temp.dispose().catch(() => {}); }, 60_000);
  } catch (error) {
    await writer.close().catch(() => {});
    await temp.dispose().catch(() => {});
    throw storageError(error);
  }
}
