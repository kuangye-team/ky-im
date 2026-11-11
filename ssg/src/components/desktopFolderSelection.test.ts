import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  readDir: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => "/selected"),
}));
vi.mock("@tauri-apps/api/path", () => ({
  basename: async () => "selected",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ ...mocks, SeekMode: { Start: 0 } }));
import { readDesktopFolder } from "./desktopFolderSelection";

describe("native folder selection", () => {
  it("scans more than 256 files and empty directories without reading payloads, then reads bounded blocks", async () => {
    const close = vi.fn(async () => {});
    const read = vi.fn(async (bytes: Uint8Array) => {
      bytes.fill(42);
      return bytes.length;
    });
    mocks.open.mockResolvedValue({ seek: vi.fn(), read, close });
    mocks.stat.mockResolvedValue({ size: 300_000 });
    mocks.readDir.mockImplementation(async (path: string) =>
      path === "/selected"
        ? [
            { name: "empty", isDirectory: true },
            ...Array.from({ length: 257 }, (_, index) => ({
              name: `${index}.txt`,
              isFile: true,
            })),
          ]
        : [],
    );
    const folder = await readDesktopFolder(
      new AbortController().signal,
      vi.fn(),
    );
    expect(folder.entries).toHaveLength(258);
    expect(folder.entries[0]).toEqual({ kind: "directory", path: "empty" });
    expect(mocks.open).not.toHaveBeenCalled();
    const entry = folder.entries[1];
    if (entry.kind !== "file") throw new Error("Expected a file");
    expect((await entry.file.slice(0, 16_384).arrayBuffer()).byteLength).toBe(
      16_384,
    );
    await entry.file.slice(16_384, 32_768).arrayBuffer();
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][0].length).toBe(256 * 1024);
    expect(close).toHaveBeenCalledOnce();
  });
  it("rejects links instead of following them outside the selected tree", async () => {
    mocks.readDir.mockResolvedValue([{ name: "link", isSymlink: true }]);
    await expect(
      readDesktopFolder(new AbortController().signal, vi.fn()),
    ).rejects.toThrow("符号链接");
  });
});
