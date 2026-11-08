import { afterEach, beforeEach, expect, it, vi } from "vitest";
let saved: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  saved = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("restores separate conversations after a reload and removes sent drafts", async () => {
  let drafts = await import("./drafts");
  drafts.setChatDraft("alice", "你好 Alice");
  drafts.setChatDraft("bob", "hello Bob");
  vi.resetModules();
  drafts = await import("./drafts");
  expect(drafts.getChatDrafts()).toEqual({
    alice: "你好 Alice",
    bob: "hello Bob",
  });
  drafts.setChatDraft("alice", "");
  vi.resetModules();
  expect((await import("./drafts")).getChatDrafts()).toEqual({
    bob: "hello Bob",
  });
});

it("retains the in-memory draft and prevents updating when storage is full", async () => {
  const drafts = await import("./drafts");
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  drafts.setChatDraft("alice", "保留我");
  expect(drafts.getChatDrafts().alice).toBe("保留我");
  expect(drafts.saveChatDrafts()).toBe(false);
});
