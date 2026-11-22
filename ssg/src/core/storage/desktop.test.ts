import { describe, expect, it, vi } from "vitest";
import {
  DesktopStorageAdapter,
  createDesktopStorage,
  type StorageInvoke,
} from "./desktop";
import { newId } from "../protocol";
import { download } from "../../components/fileDownloads";
import { STORAGE_CONFIG } from "../../config";

const nativeInvoke = vi.hoisted(() =>
  vi.fn(async (_command: string, args: Record<string, unknown> | ArrayBuffer, _options?: { headers: Record<string, string> }): Promise<unknown> =>
    !(args instanceof ArrayBuffer) && (args.request as { op?: string })?.op === "info"
      ? { directory: "/data", usage: 0, cacheUsage: 0 }
      : null,
  ),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeInvoke }));

// Native filesystem behavior is covered by Rust tests; these verify the IPC contract and session initialization.
describe("desktop adapter", () => {
  it("shares concurrent initialization and resets stale native transfers only once", async () => {
    const [a, b] = await Promise.all([
      createDesktopStorage(),
      createDesktopStorage(),
    ]);
    expect(a).toBe(b);
    expect(nativeInvoke.mock.calls.map(([, args]) => ((args as Record<string, unknown>).request as { op: string }).op)).toEqual([
      "resetTransfers",
    ]);
  });
  it("uses the Android save folder only for received attachments and encodes binary IPC", async () => {
    const originalInvoke = nativeInvoke.getMockImplementation();
    vi.stubEnv("VITE_ANDROID", "true");
    try {
      const store = new DesktopStorageAdapter();
      nativeInvoke.mockClear();
      nativeInvoke.mockImplementation(async (command, args) =>
        command === "storage_request" && "request" in args && (args.request as {op: string}).op.startsWith("begin")
          ? "token" : null);
      const base = { id: newId(), fileName: "file", size: 2, kind: "file" as const,
        createdAt: 1, senderId: "peer", peerId: "peer", status: "sending" as const };
      const incoming = await store.createFileDestination({ ...base, attachmentStorage: "managed" });
      await incoming.write(new Blob([new Uint8Array([0, 255])]));
      await store.createFileDestination(base);
      expect(nativeInvoke.mock.calls.map(([command, args]) =>
        command === "storage_write" ? args : (args as { request: { op: string } }).request.op,
      )).toEqual(["beginReceived", { base64: "AP8=" }, "begin"]);
    } finally {
      if (originalInvoke) nativeInvoke.mockImplementation(originalInvoke);
      vi.unstubAllEnvs();
    }
  });

  it("uses the Android save picker for file exports and stops when it is cancelled", async () => {
    vi.stubEnv("VITE_ANDROID", "true");
    try {
      await createDesktopStorage();
      const blob = new Blob(["abc"]);
      nativeInvoke.mockClear();
      nativeInvoke.mockResolvedValueOnce("export-token");
      await download(blob, "history.json");
      expect(nativeInvoke.mock.calls).toEqual([
        ["android_export_writer", { id: expect.any(String), size: 3, name: "history.json" }],
        ["storage_write", { base64: "YWJj" }, { headers: { "x-storage-token": "export-token" } }],
        ["storage_request", { request: { op: "finish", token: "export-token" } }],
      ]);
      nativeInvoke.mockClear();
      nativeInvoke.mockResolvedValueOnce(null);
      await expect(download(blob, "history.json")).rejects.toMatchObject({ name: "AbortError" });
      expect(nativeInvoke).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds IPC writes and commits only after the last block", async () => {
    const requests: { op: string; [key: string]: unknown }[] = [];
    const invoke = (async (request) => {
      requests.push(request);
      return request.op === "begin" ? "token" : undefined;
    }) as StorageInvoke;
    const store = new DesktopStorageAdapter(invoke);
    const blob = new Blob([new Uint8Array(2 * STORAGE_CONFIG.chunkBytes + 17).fill(42)]);
    await store.saveAttachment(newId(), blob);
    expect(requests.map((r) => r.op)).toEqual([
      "begin",
      "write",
      "write",
      "write",
      "finish",
    ]);
    const chunks = requests
      .filter((r) => r.op === "write")
      .map((r) => new Uint8Array(r.data as ArrayBuffer));
    expect(chunks.map((c) => c.length)).toEqual([
      STORAGE_CONFIG.chunkBytes, STORAGE_CONFIG.chunkBytes, 17,
    ]);
    expect(chunks.map((c) => c.length).reduce((a, b) => a + b, 0)).toBe(
      blob.size,
    );
  });
  it("uses raw invoke bodies and responses for file bytes, with routing outside the body", async () => {
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 256);
    nativeInvoke.mockClear();
    nativeInvoke.mockImplementation(async (command, args) => {
      if (command === "storage_read") return bytes.buffer;
      if (command === "storage_write") return;
      const request = (args as { request: { op: string } }).request;
      if (request.op === "begin") return "test-token";
      if (request.op === "attachment") return { name: "raw.bin", size: bytes.length, mime: "", folder: false };
    });
    const store = new DesktopStorageAdapter();
    const id = newId();
    await store.saveAttachment(id, new Blob([bytes]));
    const source = await store.getAttachmentSource(id);
    expect(await source!.slice(0, bytes.length).arrayBuffer()).toEqual(bytes.buffer);
    expect(nativeInvoke).toHaveBeenCalledWith("storage_write", bytes.buffer, {
      headers: { "x-storage-token": "test-token" },
    });
    expect(nativeInvoke).toHaveBeenCalledWith("storage_read", { id, offset: 0, length: bytes.length });
    expect(nativeInvoke.mock.calls.filter(([command]) => command === "storage_request")
      .every(([, args]) => !("data" in ((args as { request: object }).request)))).toBe(true);
  });
  it("aborts cached bytes when a write fails and never commits", async () => {
    const ops: string[] = [];
    const invoke = (async (request) => {
      ops.push(request.op);
      if (request.op === "write") throw new Error("disk full");
      return "token";
    }) as StorageInvoke;
    await expect(
      new DesktopStorageAdapter(invoke).saveAttachment(
        newId(),
        new Blob(["x"]),
      ),
    ).rejects.toThrow("disk full");
    expect(ops).toEqual(["begin", "write", "abort"]);
  });
});
