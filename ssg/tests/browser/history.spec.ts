import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  capture,
  expectNoHorizontalOverflow,
  openPeer,
  sendText,
  setProfile,
} from "./helpers";

test("单条消息可取消或确认删除，删除附件后刷新仍生效且对方保留记录", async ({
  page,
  browser,
  baseURL,
}) => {
  const otherContext = await browser.newContext({ locale: "zh-CN" });
  const other = await otherContext.newPage();
  try {
    await page.goto("/");
    await setProfile(page, "删除测试接收端");
    await other.goto(baseURL!);
    await setProfile(other, "删除测试发送端");
    await openPeer(page, "删除测试发送端");
    await openPeer(other, "删除测试接收端");
    await sendText(other, "这条消息保留");
    await sendText(other, "这条消息删除");
    const textRow = page
      .locator(".message-row")
      .filter({ hasText: "这条消息删除" });
    await textRow
      .getByRole("button", { name: "删除消息", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "删除这条消息？",
      exact: true,
    });
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(textRow).toBeVisible();
    await textRow
      .getByRole("button", { name: "删除消息", exact: true })
      .click();
    await confirmation
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await expect(textRow).toHaveCount(0);
    await expect(other.getByRole("log")).toContainText("这条消息删除");

    await other.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "删除附件.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("附件内容"),
    });
    const fileRow = page
      .locator(".message-row")
      .filter({ hasText: "删除附件.txt" });
    await fileRow.getByRole("button", { name: "接收", exact: true }).click();
    await expect(
      fileRow.getByRole("button", { name: "下载 删除附件.txt", exact: true }),
    ).toBeEnabled();
    const id = await fileRow.getAttribute("data-message-id");
    await page.setViewportSize({ width: 390, height: 844 });
    await fileRow.getByRole("button", { name: "消息操作", exact: true }).click();
    await page.getByRole("dialog")
      .getByRole("button", { name: "删除消息", exact: true })
      .click();
    await expectNoHorizontalOverflow(page);
    await capture(page, "mobile-delete-message.png");
    await confirmation
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await expect(fileRow).toHaveCount(0);
    expect(await storedKeys(page, "attachments")).not.toContain(id);
    await expect(other.getByRole("log")).toContainText("删除附件.txt");
    await page.reload();
    await expect(page.getByRole("log")).toContainText("这条消息保留");
    await expect(page.getByRole("log")).not.toContainText("这条消息删除");
    await expect(page.getByRole("log")).not.toContainText("删除附件.txt");
  } finally {
    await otherContext.close();
  }
});

async function storedKeys(page: Page, store: "messages" | "attachments") {
  return page.evaluate(async (storeName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ky-im");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = db
          .transaction(storeName)
          .objectStore(storeName)
          .getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, store);
}

test("聊天记录与存储管理独立，文件下载、多选及大文件清理在桌面和手机可用", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "个人资料", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/蜂鸟/);
  await expect(
    page.getByRole("link", { name: "蜂鸟首页", exact: true }),
  ).toBeVisible();
  const logo = page.locator(".brand-mark .hummingbird-logo");
  await expect(logo).toBeVisible();
  const fixture = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ky-im");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const peer = {
      id: crypto.randomUUID(),
      name: "历史文件朋友",
      avatar: "🌿",
      color: "#7266ed",
      bio: "",
      device: "浏览器",
      clientType: "web" as const,
    };
    const files = [
      { id: crypto.randomUUID(), name: "大文件甲.zip", size: 10 * 1024 * 1024 },
      { id: crypto.randomUUID(), name: "大文件乙.zip", size: 11 * 1024 * 1024 },
      { id: crypto.randomUUID(), name: "大文件丙.zip", size: 12 * 1024 * 1024 },
      { id: crypto.randomUUID(), name: "大文件丁.zip", size: 13 * 1024 * 1024 },
      { id: crypto.randomUUID(), name: "保留小文件.txt", size: 12 },
    ];
    try {
      const tx = db.transaction(
        ["conversations", "messages", "attachments"],
        "readwrite",
      );
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      tx.objectStore("conversations").put({
        peer,
        remark: "文件朋友备注",
        updatedAt: Date.now(),
        unread: 0,
      });
      for (const file of files) {
        tx.objectStore("messages").put({
          id: file.id,
          peerId: peer.id,
          senderId: peer.id,
          kind: "file",
          fileName: file.name,
          size: file.size,
          createdAt: Date.now(),
          status: "delivered",
        });

      }
      await done;
      const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
      const storage = new IndexedDBStorageAdapter();
      for (const file of files) await storage.saveAttachment(file.id, new Blob([new Uint8Array(file.size)]));
      await storage.close();
      return files;
    } finally {
      db.close();
    }
  });
  await page.reload();
  await page.getByRole("button", { name: "聊天记录", exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(
    page.getByRole("heading", { name: "聊天记录", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".large-files-section")).toHaveCount(0);
  await expect(page.getByText("大文件数", { exact: true })).toHaveCount(0);
  await expect(page.locator(".main-nav > button")).toHaveText([
    "聊天消息",
    "在线设备0",
    "聊天记录",
    "存储管理",
    "系统配置",
  ]);
  const exportButton = page.getByRole("button", { name: "导出记录", exact: true });
  const clearButton = page.getByRole("button", { name: "清空记录", exact: true });
  await expect(exportButton).toHaveText("导出记录");
  await expect(clearButton).toHaveText("清空记录");
  await capture(page, "desktop-history.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  for (const button of [exportButton, clearButton]) {
    await expect(button).toHaveText("");
    await expect(button.locator("svg")).toBeVisible();
  }
  await capture(page, "mobile-history.png");
  await page.setViewportSize({ width: 1440, height: 980 });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^蜂鸟-聊天记录/);
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.conversations[0].remark).toBe("文件朋友备注");
  expect(exported.conversations[0].messages).toHaveLength(5);

  await page.getByRole("button", { name: "存储管理", exact: true }).click();
  await expect(page).toHaveURL(/\/storage$/);
  await expect(
    page.getByRole("heading", { name: "存储管理", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出记录", exact: true }),
  ).toHaveCount(0);
  const filters = page.getByRole("group", { name: "文件筛选" });
  const largeFiles = filters.getByRole("button", { name: /^大文件/ });
  const allFiles = filters.getByRole("button", { name: /^全部文件/ });
  await expect(largeFiles).toHaveAccessibleName("大文件 4");
  await expect(allFiles).toHaveAccessibleName("全部文件 5");
  await expect(page.getByRole("heading", { name: /聊天文件/ })).toContainText("46.0 MB");
  await expect(page.getByText("保留小文件.txt", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "文件列表", exact: true })
      .locator("li")
      .first(),
  ).toContainText("大文件丁.zip");
  await capture(page, "desktop-storage.png");
  await page
    .getByRole("checkbox", { name: "选择 保留小文件.txt", exact: true })
    .check();
  await page.getByRole("button", { name: /^大文件/ }).click();
  await expect(page.getByText("保留小文件.txt", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "删除所选", exact: true }),
  ).toBeDisabled();
  await capture(page, "desktop-storage-large-files.png");
  const fileDownloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 大文件甲.zip", exact: true })
    .click();
  const fileDownload = await fileDownloadPromise;
  expect(fileDownload.suggestedFilename()).toBe(fixture[0].name);
  expect(await readFile((await fileDownload.path())!)).toEqual(
    Buffer.alloc(fixture[0].size),
  );
  expect(await storedKeys(page, "attachments")).toHaveLength(5);

  await page
    .getByRole("button", { name: "删除 大文件甲.zip", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(largeFiles).toHaveAccessibleName("大文件 4");
  await page
    .getByRole("button", { name: "删除 大文件甲.zip", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(largeFiles).toHaveAccessibleName("大文件 3");
  await expect(page.getByText("大文件甲.zip", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "存储空间", exact: true }),
  ).toBeVisible();
  const selectFiles = page.getByRole("button", { name: "选择文件", exact: true });
  await page.setViewportSize({ width: 320, height: 640 });
  const filterBox = (await filters.boundingBox())!;
  const selectBox = (await selectFiles.boundingBox())!;
  expect(selectBox.x).toBeGreaterThanOrEqual(filterBox.x + filterBox.width);
  expect(Math.abs(selectBox.y + selectBox.height / 2 - filterBox.y - filterBox.height / 2)).toBeLessThan(2);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "mobile-storage.png");
  const persistedDownloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 大文件乙.zip", exact: true })
    .click();
  const persistedDownload = await persistedDownloadPromise;
  expect(persistedDownload.suggestedFilename()).toBe(fixture[1].name);
  expect(await readFile((await persistedDownload.path())!)).toEqual(
    Buffer.alloc(fixture[1].size),
  );
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: /^大文件/ }).click();
  await capture(page, "mobile-storage-large-files.png");
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page.getByRole("checkbox", { name: "全选大文件", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "选择 大文件丁.zip", exact: true })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: "全选大文件", exact: true }),
  ).toHaveJSProperty("indeterminate", true);
  await expect(page.getByText("已选 2 个 · 23.0 MB")).toBeVisible();
  await capture(page, "mobile-storage-selection.png");
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(largeFiles).toHaveAccessibleName("大文件 1");
  expect(await storedKeys(page, "attachments")).toEqual(
    expect.arrayContaining([fixture[3].id, fixture[4].id]),
  );
  expect(await storedKeys(page, "attachments")).toHaveLength(2);
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page.getByRole("checkbox", { name: "全选大文件", exact: true }).check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(largeFiles).toHaveAccessibleName("大文件 0");
  expect(await storedKeys(page, "attachments")).toEqual([fixture[4].id]);
  expect(await storedKeys(page, "messages")).toEqual([fixture[4].id]);
  await expect(page.getByText("还没有大文件", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回我的" }).click();
  await page.getByRole("link", { name: "消息", exact: true }).click();
  await page.reload();
  await openPeer(page, "文件朋友备注");
  await expect(page.getByRole("log")).toContainText("保留小文件.txt");
  await expect(page.getByRole("log")).not.toContainText("大文件");
  await page.getByRole("button", { name: "返回列表" }).click();
  await page.getByRole("link", { name: "我的", exact: true }).click();
  await page.getByRole("link", { name: /存储空间/ }).click();
  const smallDownloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 保留小文件.txt", exact: true })
    .click();
  expect(await readFile((await (await smallDownloadPromise).path())!)).toEqual(
    Buffer.alloc(12),
  );
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page.getByRole("checkbox", { name: "全选文件", exact: true }).check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "删除 1 个文件？",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(
    page.getByText("还没有保存的文件", { exact: true }),
  ).toBeVisible();
  await expect(allFiles).toHaveAccessibleName("全部文件 0");
  expect(await storedKeys(page, "attachments")).toEqual([]);
  expect(await storedKeys(page, "messages")).toEqual([]);
  await page.reload();
  await expect(
    page.getByText("还没有保存的文件", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("空存储支持英文、手机布局、独立地址和前进后退", async ({ page }) => {
  await page.addInitScript(() => {
    const estimate = navigator.storage.estimate.bind(navigator.storage);
    let fail = true;
    Object.defineProperty(navigator.storage, "estimate", {
      value: () => {
        if (fail) { fail = false; return Promise.reject(new Error("unavailable")); }
        return estimate();
      },
    });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/storage");
  await expect(page.getByText("暂不可用", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "暂时无法读取存储用量，请重试。" })).toBeVisible();
  await page.getByRole("button", { name: "刷新存储用量" }).click();
  await expect(
    page.getByText("还没有保存的文件", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回我的" }).click();
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "English", exact: true })
    .click();
  await page.getByRole("link", { name: /Storage space/ }).click();
  await expect(
    page.getByRole("heading", { name: "Storage space", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No saved files yet", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Large files/ }).click();
  await expect(
    page.getByText("No large files yet", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select files", exact: true }),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await capture(page, "mobile-storage-english.png");
  await page.getByRole("button", { name: "Back to Me" }).click();
  await page.getByRole("link", { name: "Chat history", exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(
    page.getByRole("heading", { name: "Chat history", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export history", exact: true }),
  ).toBeDisabled();
  await page.goBack();
  await expect(
    page.getByRole("region", { name: "Me", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Chat history", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Chat history", exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("存储用量只在进入或手动刷新时扫描，普通重载沿用上次结果", async ({ page }) => {
  await page.addInitScript(() => {
    const estimate = navigator.storage.estimate.bind(navigator.storage);
    navigator.storage.estimate = () => {
      sessionStorage.setItem("test-scans", String(Number(sessionStorage.getItem("test-scans")) + 1));
      return estimate();
    };
  });
  const start = new Date("2026-01-01T00:00:00Z").getTime();
  const clock = (seconds: number) => page.clock.setFixedTime(new Date(start + seconds * 1000));
  const count = () => page.evaluate(() => Number(sessionStorage.getItem("test-scans")));
  const visit = () => page.getByRole("button", { name: "存储管理", exact: true }).click();
  const leave = () => page.getByRole("button", { name: "聊天记录", exact: true }).click();
  const refresh = page.getByRole("button", { name: "刷新存储用量" });
  await clock(0);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "个人资料", exact: true })).toBeVisible();
  expect(await count()).toBe(0);
  await visit();
  await expect(page.getByText("还没有保存的文件", { exact: true })).toBeVisible();
  expect(await count()).toBe(1);
  await clock(30);
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect.poll(count).toBe(2);
  await expect(refresh).toBeEnabled();
  await clock(89);
  await leave();
  await visit();
  await page.reload();
  await expect(page.getByText("还没有保存的文件", { exact: true })).toBeVisible();
  expect(await count()).toBe(2);
  await clock(90);
  await page.getByRole("button", { name: /^大文件/ }).click();
  expect(await count()).toBe(2);
  await leave();
  await visit();
  await expect.poll(count).toBe(3);
});
