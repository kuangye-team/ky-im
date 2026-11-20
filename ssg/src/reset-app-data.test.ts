import "fake-indexeddb/auto";
import { openDB } from "idb";
import { afterEach, expect, it, vi } from "vitest";
import { IndexedDBStorageAdapter } from "./core/storage";
import { identityFor } from "./core/network/libp2p/identity";
import { resetAppData } from "./reset-app-data";
import { CLOSE_OTHER_PAGES, deleteDatabase } from "./reset-cleanup";
import type { ChatEngine } from "./core";
const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("persists the device key in ky-im", async () => {
  const store = new IndexedDBStorageAdapter();
  const a = await identityFor(store), b = await identityFor(store);
  expect(a.id).toBe(b.id);
  expect(a.id).toMatch(/^12D3KooW/);
  await store.close();
  await deleteDatabase("ky-im");
});

it("deletes both generations, removes the scoped legacy precache and keeps unrelated data", async () => {
  const local = memory(), session = memory();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  local.setItem("hummingbird.theme", "old");
  local.setItem("hummingbird.other", "keep");
  for (const key of ["hummingbird.chat-drafts", "hummingbird.v2.chat-drafts"]) session.setItem(key, "draft");
  const legacy = await openDB("send-chat", 1);
  legacy.close();
  const other = await openDB("unrelated", 1);
  other.close();
  const storage = new IndexedDBStorageAdapter();
  const remove = vi.fn();
  vi.stubGlobal("caches", { delete: remove });
  vi.stubGlobal("navigator", { storage: navigator.storage, serviceWorker: { getRegistration: async () => ({ scope: "https://im.example/chat/" }) } });
  await resetAppData({ prepareReset: vi.fn(), storage } as unknown as ChatEngine);
  expect((await indexedDB.databases()).map(d => d.name)).toEqual(["unrelated"]);
  expect(remove.mock.calls).toEqual([["workbox-precache-v2-https://im.example/chat/"]]);
  expect(local.getItem("hummingbird.theme")).toBeNull();
  expect(local.getItem("hummingbird.other")).toBe("keep");
  expect(session.getItem("hummingbird.chat-drafts")).toBeNull();
  expect(session.getItem("hummingbird.v2.chat-drafts")).toBeNull();
  await deleteDatabase("unrelated");
});

it("reports a blocked database and waits for actual deletion on retry", async () => {
  const db = await openDB("send-chat", 1);
  await expect(deleteDatabase("send-chat")).rejects.toThrow(CLOSE_OTHER_PAGES);
  db.close();
  await deleteDatabase("send-chat");
  expect((await indexedDB.databases()).map(d => d.name)).not.toContain("send-chat");
});

it("propagates desktop cleanup failure before clearing shared preferences", async () => {
  const local = memory();
  vi.stubGlobal("localStorage", local);
  local.setItem("hummingbird.theme", "old");
  const engine = { storage: { getStorageInfo: vi.fn() }, resetData: async () => { throw new Error("disk unavailable"); } };
  await expect(resetAppData(engine as unknown as ChatEngine)).rejects.toThrow("disk unavailable");
  expect(local.getItem("hummingbird.theme")).toBe("old");
});
