import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { IndexedDBStorageAdapter } from "../storage";
import { storageUsage } from "./usage";
import type { Message, StorageAdapter, StorageUsage } from "../types";
import { deleteDatabase } from "../../reset-cleanup";

it("reuses the completed web scan after a page reload and measures 60 seconds from the last manual scan", async () => {
  const now = vi.spyOn(Date, "now");
  let store = new IndexedDBStorageAdapter("usage-clock");
  let view = storageUsage(store);
  const estimate = vi.spyOn(navigator.storage, "estimate");
  try {
    now.mockReturnValue(0);
    expect(estimate).not.toHaveBeenCalled();
    await Promise.all([view.refresh(), view.refresh()]);
    expect(estimate).toHaveBeenCalledTimes(1);
    now.mockReturnValue(30_000);
    await Promise.all([view.refresh(true), view.refresh(true)]);
    expect(estimate).toHaveBeenCalledTimes(2);
    await store.close();
    store = new IndexedDBStorageAdapter("usage-clock");
    view = storageUsage(store);
    for (const time of [60_000, 89_999]) {
      now.mockReturnValue(time);
      await view.refresh();
      expect(view.snapshot().result?.completedAt).toBe(30_000);
      expect(estimate).toHaveBeenCalledTimes(2);
    }
    now.mockReturnValue(90_000);
    expect(estimate).toHaveBeenCalledTimes(2);
    estimate.mockRejectedValueOnce(new Error("disk unavailable"));
    await view.refresh();
    expect(view.snapshot()).toMatchObject({ error: true, loading: false, result: { completedAt: 30_000 } });
    await view.refresh(true);
    expect(view.snapshot()).toMatchObject({ error: false, result: { completedAt: 90_000 } });
    now.mockReturnValue(150_000);
    await view.refresh();
    expect(estimate).toHaveBeenCalledTimes(5);
  } finally {
    await store.close();
    await deleteDatabase("usage-clock");
    vi.restoreAllMocks();
  }
});

it("shares an outstanding scan across mounts and discards a result after a location or identity change", async () => {
  let finish!: (result: StorageUsage) => void;
  const scanUsage = vi.fn(() => new Promise<StorageUsage>((resolve) => { finish = resolve; }));
  const adapter = { scanUsage } as unknown as StorageAdapter;
  const view = storageUsage(adapter);
  const first = view.refresh();
  expect(storageUsage(adapter).refresh(true)).toBe(first);
  await Promise.resolve();
  expect(view.snapshot().loading).toBe(true);
  const late = finish;
  view.invalidate();
  const second = view.refresh();
  await Promise.resolve();
  finish({ completedAt: Date.now(), files: [], usage: 1 });
  await second;
  late({ completedAt: Date.now(), files: [], usage: 99 });
  await first;
  expect(view.snapshot().result?.usage).toBe(1);
  expect(scanUsage).toHaveBeenCalledTimes(2);
});

it("deletion immediately prunes the persisted file list without starting another scan", async () => {
  const storage = new IndexedDBStorageAdapter("usage-delete");
  const view = storageUsage(storage);
  const file = { id: "saved", peerId: "peer", senderId: "sender", kind: "file", createdAt: 1 } as Message;
  try {
    await storage.saveMessage(file);
    await storage.saveAttachment(file.id, new Blob(["abc"]));
    const scan = vi.spyOn(storage, "scanUsage");
    await view.refresh();
    expect(view.snapshot().result?.files).toHaveLength(1);
    await storage.deleteMessages([file.id]);
    view.remove(new Set([file.id]));
    expect(view.snapshot().result?.files).toEqual([]);
    await view.refresh();
    expect(view.snapshot().result?.files).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(1);
  } finally {
    await storage.close();
    await deleteDatabase("usage-delete");
  }
});
