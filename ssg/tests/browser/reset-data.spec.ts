import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, setProfile } from "./helpers";

test("重置可取消，确认后清除身份、附件、草稿及设置，并适配中英文和窄屏", async ({ page }) => {
  await page.goto("/");
  await setProfile(page, "重置前的名称");
  const original = await page.evaluate(async () => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    const store = new IndexedDBStorageAdapter();
    const profile = (await store.getProfile())!;
    const peer = { ...profile, id: crypto.randomUUID(), name: "重置前的联系人" };
    const id = crypto.randomUUID();
    await store.saveConversation({ peer, remark: "备注", unread: 0, updatedAt: Date.now() });
    await store.saveMessage({ id, peerId: peer.id, senderId: profile.id, kind: "file", fileName: "待清理.txt", size: 4, createdAt: Date.now(), status: "sent" });
    await store.saveAttachment(id, new Blob(["test"]));
    await store.close();
    localStorage.setItem("hummingbird.availability", "offline");
    localStorage.setItem("unrelated-value", "keep");
    sessionStorage.setItem("hummingbird.v2.chat-drafts", JSON.stringify({ [peer.id]: "未发送的草稿" }));
    return profile;
  });
  await page.reload();
  await page.getByRole("button", { name: "存储管理", exact: true }).click();
  await expect(page.getByText("待清理.txt", { exact: true })).toBeVisible();
  const reset = page.getByRole("button", { name: "重置应用数据", exact: true });
  const clear = page.getByRole("button", { name: "清理全部大文件", exact: true });
  expect((await reset.boundingBox())!.x).toBeLessThan((await clear.boundingBox())!.x);
  await page.screenshot({ path: "../temp/screenshot/storage-reset-desktop.png", fullPage: true, animations: "disabled" });
  await reset.click();
  const modal = page.getByRole("dialog", { name: "重置应用数据？", exact: true });
  await expect(modal).toContainText("无法恢复");
  await expect(modal.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(modal).toBeHidden();
  await expect(page.getByText("待清理.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await expect(page.getByRole("button", { name: /Reset.*data/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to Me" }).click();
  const phoneReset = page.getByRole("button", { name: "Reset data", exact: true });
  await phoneReset.click();
  const englishModal = page.getByRole("dialog", { name: "Reset data?", exact: true });
  await expect(englishModal).toContainText("permanently delete");
  await englishModal.getByRole("button", { name: "Cancel" }).click();
  await expect(englishModal).toBeHidden();
  await expect(phoneReset).toBeFocused();
  await phoneReset.click();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "../temp/screenshot/storage-reset-mobile-english.png", fullPage: true, animations: "disabled" });
  const prompts: string[] = [];
  page.on("dialog", async (dialog) => { prompts.push(dialog.type()); await dialog.dismiss(); });
  await Promise.all([
    page.waitForEvent("load"),
    englishModal.getByRole("button", { name: "Reset", exact: true }).click(),
  ]);
  await expect(page.getByRole("region", { name: "我的", exact: true })).toBeVisible();
  const saved = await page.evaluate(async () => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    const store = new IndexedDBStorageAdapter();
    const result = {
      profile: await store.getProfile(), conversations: await store.getConversations(), files: await store.getFiles(),
      language: localStorage.getItem("hummingbird.language"), availability: localStorage.getItem("hummingbird.availability"),
      drafts: sessionStorage.getItem("hummingbird.v2.chat-drafts"), unrelated: localStorage.getItem("unrelated-value"),
    };
    await store.close();
    return result;
  });
  expect(saved.profile?.id).not.toBe(original.id);
  expect(saved.profile?.numericId).not.toBe(original.numericId);
  expect(saved.profile?.name).not.toBe(original.name);
  expect(saved.conversations).toEqual([]);
  expect(saved.files).toEqual([]);
  expect(saved.language).toBeNull();
  expect(saved.availability).toBeNull();
  expect(saved.drafts).toBeNull();
  expect(saved.unrelated).toBe("keep");
  expect(prompts).toEqual([]);
});


test("旧页面占用时提示重试，成功后其他新版页面的草稿也被清除", async ({ page, context }) => {
  await page.goto("/");
  await setProfile(page, "重置前");
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("button", { name: "个人资料", exact: true })).toBeVisible();
  await other.evaluate(async () => {
    const drafts = await import("/src/drafts.ts");
    drafts.setChatDraft("peer", "新版草稿");
    sessionStorage.setItem("hummingbird.chat-drafts", "旧版草稿");
    sessionStorage.setItem("unrelated", "keep");
  });
  const legacy = await context.newPage();
  await legacy.goto("/tests/browser/desktop-storage.html");
  await legacy.evaluate(() => new Promise<void>((resolve) => {
    const request = indexedDB.open("send-chat", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("settings").put("旧资料", "profile"); };
    request.onsuccess = () => { Object.assign(window, { heldDB: request.result }); resolve(); };
  }));
  await page.getByRole("button", { name: "存储管理", exact: true }).click();
  await page.getByRole("button", { name: "重置应用数据", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("button", { name: "确认重置" }).click();
  await expect(modal.getByRole("alert")).toContainText("请关闭其他蜂鸟页面后重试");
  await legacy.close();
  await Promise.all([
    page.waitForEvent("load"), other.waitForEvent("load"),
    modal.getByRole("button", { name: "确认重置" }).click(),
  ]);
  await expect(other.getByRole("button", { name: "个人资料", exact: true })).toBeVisible();
  const retained = await other.evaluate(async () => ({
    old: sessionStorage.getItem("hummingbird.chat-drafts"),
    current: sessionStorage.getItem("hummingbird.v2.chat-drafts"),
    unrelated: sessionStorage.getItem("unrelated"),
    databases: (await indexedDB.databases()).map((db) => db.name),
  }));
  expect(retained).toEqual({ old: null, current: null, unrelated: "keep", databases: ["ky-im"] });
});
