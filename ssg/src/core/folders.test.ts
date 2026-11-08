import { describe, expect, it, vi } from "vitest";
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import { FOLDER_CONFIG, MAX_FILE_SIZE } from "../config";
import {
  compressFolder,
  inspectFolder,
  validPath,
  type FolderEntry,
} from "./folders";
import {
  readDroppedDirectory,
  readDirectoryFiles,
} from "../components/folderSelection";
import { parseControlPacket, newId } from "./protocol";

describe("folder selection and packing", () => {
  const fakeFile = (size: number) =>
    Object.defineProperty(new File([], "large.bin"), "size", { value: size });
  it("compresses exactly 256 MiB / 256 files, but bypasses compression above either limit", () => {
    const entries: FolderEntry[] = Array.from({ length: 256 }, (_, i) => ({
      kind: "file",
      path: `${i}.bin`,
      file: fakeFile(i ? 0 : MAX_FILE_SIZE),
    }));
    expect(inspectFolder({ name: "资料", entries })).toMatchObject({
      size: MAX_FILE_SIZE,
      fileCount: 256,
      compress: true,
    });
    expect(
      inspectFolder({
        name: "资料",
        entries: [
          ...entries,
          { kind: "file", path: "extra", file: fakeFile(0) },
        ],
      }).compress,
    ).toBe(false);
    expect(
      inspectFolder({
        name: "资料",
        entries: [
          {
            kind: "file",
            path: "large.bin",
            file: fakeFile(MAX_FILE_SIZE + 1),
          },
        ],
      }).compress,
    ).toBe(false);
  });
  it("preserves nested names, empty files and empty directories in the ZIP", async () => {
    const file = new File(["hello folder"], "同名.txt");
    const archive = await compressFolder(
      {
        name: "旅行",
        entries: [
          { kind: "directory", path: "空目录" },
          { kind: "directory", path: "照片" },
          { kind: "file", path: "照片/同名.txt", file },
          { kind: "file", path: "同名.txt", file: new File([], "同名.txt") },
        ],
      },
      new AbortController().signal,
    );
    const reader = new ZipReader(new BlobReader(archive));
    const entries = await reader.getEntries();
    expect(entries.map((entry) => entry.filename)).toEqual([
      "旅行/",
      "旅行/空目录/",
      "旅行/照片/",
      "旅行/照片/同名.txt",
      "旅行/同名.txt",
    ]);
    const content = entries.find(
      (entry) => entry.filename === "旅行/照片/同名.txt",
    )!;
    if (content.directory) throw new Error("Expected file");
    expect(await content.getData(new TextWriter())).toBe("hello folder");
    await reader.close();
    expect(archive.name).toBe("旅行.zip");
  });
  it("honors cancellation before reading file contents", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      compressFolder({ name: "取消", entries: [] }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("reads every drag-and-drop batch, including entries beyond the browser's first 100", async () => {
    const files = Array.from({ length: 257 }, (_, index) => ({
      name: `${index}.txt`,
      isDirectory: false,
      file: (resolve: (value: File) => void) =>
        resolve(new File([`${index}`], `${index}.txt`)),
    }));
    const batches = [
      files.slice(0, 100),
      files.slice(100, 200),
      files.slice(200),
      [],
    ];
    const readEntries = vi.fn((resolve: (entries: unknown[]) => void) =>
      resolve(batches.shift()!),
    );
    const root = {
      name: "拖入",
      createReader: () => ({ readEntries }),
    } as unknown as FileSystemDirectoryEntry;
    const folder = await readDroppedDirectory(
      root,
      new AbortController().signal,
      () => {},
    );
    expect(inspectFolder(folder)).toMatchObject({
      fileCount: 257,
      compress: false,
    });
    expect(readEntries).toHaveBeenCalledTimes(4);
  });
  it("reconstructs nested paths from the folder input without flattening duplicate basenames", async () => {
    const files = ["资料/一/相同.txt", "资料/二/相同.txt"].map((path) =>
      Object.defineProperty(
        new File([path], "相同.txt"),
        "webkitRelativePath",
        { value: path },
      ),
    );
    const folder = await readDirectoryFiles(
      files,
      new AbortController().signal,
      () => {},
    );
    expect(folder.entries.map((entry) => entry.path)).toEqual([
      "一",
      "一/相同.txt",
      "二",
      "二/相同.txt",
    ]);
    expect(inspectFolder(folder).fileCount).toBe(2);
  });
  it.each([
    "../escape",
    "/absolute",
    "a/../b",
    "a\\b",
    "a//b",
    "a/./b",
    "a\0b",
    "a/",
    "x/".repeat(FOLDER_CONFIG.maxDepth) + "file",
  ])("rejects unsafe path %j", (path) => {
    expect(validPath(path)).toBe(false);
    expect(
      parseControlPacket(
        JSON.stringify({
          type: "folder-entry",
          id: newId(),
          index: 0,
          path,
          kind: "file",
          size: 1,
        }),
      ),
    ).toBeNull();
  });
  it("rejects duplicate paths, missing parents and an inconsistent offer", () => {
    const entry = { kind: "directory" as const, path: "same" };
    expect(() =>
      inspectFolder({ name: "资料", entries: [entry, entry] }),
    ).toThrow();
    expect(() =>
      inspectFolder({
        name: "资料",
        entries: [{ kind: "file", path: "missing/file", file: fakeFile(1) }],
      }),
    ).toThrow();
    expect(
      parseControlPacket(
        JSON.stringify({
          type: "folder-start",
          id: newId(),
          fileName: "资料",
          size: 1,
          fileCount: 0,
          directoryCount: 1,
          createdAt: Date.now(),
        }),
      ),
    ).toBeNull();
  });
});
