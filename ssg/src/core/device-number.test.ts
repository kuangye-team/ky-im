import { localRuntime } from "./capabilities";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatEngine } from "./engine";
import { generateNumericId, recentNumericIds } from "./device-number";
import { IndexedDBStorageAdapter } from "./storage";
import { DesktopStorageAdapter, type StorageInvoke } from "./storage/desktop";
import type { NetworkAdapters } from "./network/types";
import type { Profile } from "./types";
import { newId } from "./protocol";

const stores: IndexedDBStorageAdapter[] = [];
const savedProfile = (): Profile => ({
  id: newId(), numericId: "123456", name: "原来的资料", bio: "保留签名",
  avatar: "🌿", color: "#123abc", device: "Mac", clientType: "web", ...localRuntime(true),
});
const network = (): NetworkAdapters => ({
  discovery: {
    name: "offline", supportsNumericIds: true, usesBrowserNetworkStatus: false,
    open: vi.fn(() => { throw new Error("offline must not open discovery"); }),
  },
  transport: { name: "offline", create: () => { throw new Error("no connection"); } },
});

beforeEach(() => {
  const values = new Map([["hummingbird.availability", "offline"]]);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { onLine: false, userAgent: "Mac" });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("device-owned numbers", () => {
  it("takes the ten most recent distinct valid contact numbers without changing the chat order", () => {
    const profile = savedProfile();
    const conversations = Array.from({ length: 12 }, (_, index) => ({
      peer: { ...profile, id: newId(), numericId: String(200000 + index) },
      updatedAt: index,
      unread: 0,
    }));
    conversations.push(
      { peer: { ...profile, numericId: "200011" }, updatedAt: 30, unread: 0 },
      { peer: { ...profile, numericId: "123456" }, updatedAt: 29, unread: 0 },
      { peer: { ...profile, numericId: "012345" }, updatedAt: 28, unread: 0 },
    );
    const before = structuredClone(conversations);
    expect(recentNumericIds(conversations, "123456")).toEqual(
      Array.from({ length: 10 }, (_, index) => String(200011 - index)),
    );
    expect(conversations).toEqual(before);
    expect(recentNumericIds([{ peer: { ...profile, numericId: undefined }, updatedAt: 1, unread: 0 }])).toEqual([]);
  });
  it("allocates separate numbers before first connection and refreshes offline without changing the other device", async () => {
    const a = new IndexedDBStorageAdapter(`number-a-${newId()}`);
    const b = new IndexedDBStorageAdapter(`number-b-${newId()}`);
    stores.push(a, b);
    const adapters = network();
    const first = await createChatEngine(a, adapters);
    const second = await createChatEngine(b, adapters);
    first.start();
    second.start();
    try {
      const before = first.getSnapshot().profile;
      const other = second.getSnapshot().profile;
      expect(before.numericId).toMatch(/^[1-9][0-9]{5}$/);
      expect(other.numericId).toMatch(/^[1-9][0-9]{5}$/);
      expect(before.numericId).not.toBe(other.numericId);
      await first.refreshNumericId();
      expect(first.getSnapshot().profile.numericId).not.toBe(before.numericId);
      expect(first.getSnapshot().profile.id).toBe(before.id);
      expect(second.getSnapshot().profile).toEqual(other);
      const reopened = await createChatEngine(a, adapters);
      expect(reopened.getSnapshot().profile).toEqual(first.getSnapshot().profile);
      expect(adapters.discovery.open).not.toHaveBeenCalled();
    } finally {
      first.stop(); second.stop();
    }
  });

  it("persists app numbers offline across reloads", async () => {
    vi.stubEnv("VITE_DESKTOP", "true");
    let record: unknown = { ...savedProfile(), clientType: "desktop", ...localRuntime(true) };
    const old = record as Profile;
    const call: StorageInvoke = async <T>(request: { op: string; [key: string]: unknown }) => {
      if (request.op === "getProfile") return structuredClone(record) as T;
      if (request.op === "saveProfile") { record = structuredClone(request.value); return undefined as T; }
      if (request.op === "getConversations" || request.op === "getPeerProfiles") return [] as T;
      throw new Error(request.op);
    };
    const store = new DesktopStorageAdapter(call);
    const engine = await createChatEngine(store, network());
    const profile = engine.getSnapshot().profile;
    expect(profile.clientType).toBe("desktop");
    expect(profile.id).toBe(old.id);
    expect(profile.numericId).toBe(old.numericId);
    await engine.refreshNumericId();
    expect((await createChatEngine(store, network())).getSnapshot().profile).toEqual(engine.getSnapshot().profile);
    record = null;
    const fresh = await createChatEngine(store, network());
    expect(fresh.getSnapshot().profile.numericId).toMatch(/^[1-9][0-9]{5}$/);
    expect(fresh.getSnapshot().profile.clientType).toBe("desktop");
  });

  it("always changes the number even if the random draw repeats", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((values) => values!);
    expect(generateNumericId("100000")).toBe("100001");
  });
});
