import { expect, test } from "@playwright/test";
import { capture, closeContact, expectNoHorizontalOverflow, openContact, openPeer } from "./helpers";

const html = [
  "<!doctype html>",
  '<html lang="zh-CN">',
  "  <head>",
  '    <meta charset="utf-8">',
  "    <title>周末读书会</title>",
  "  </head>",
  "  <body>",
  "    <h1>周末读书会</h1>",
  '    <img src="./book-cover.png" alt="本周书目">',
  "    <p>周六下午三点，图书馆见。</p>",
  "  </body>",
  "</html>",
  "",
].join("\r\n");
const markdown = "# 周末读书会\n\n- 带上一本喜欢的书\n";
const javascript = 'const greeting = "你好 🌿";\n';

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell, .phone-shell")).toBeVisible();
  await page.evaluate(async ({ html, markdown, javascript }) => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    const store = new IndexedDBStorageAdapter();
    const peer = { ...await store.getProfile(), id: crypto.randomUUID(), name: "读书小组" };
    const now = Date.now();
    await store.saveConversation({ peer, updatedAt: now, unread: 0 });
    const files = [
      new File([new Uint8Array([0xff, 0xfe, 0x66, 0x4e, 0x55, 0x53])], "书目", { type: "text/plain" }),
      new File([], "空白.txt"),
      new File(["a".repeat(256 * 1024 - 1), "🌿 末行\n"], "记录.log"),
      new File([javascript], "问候.JS", { type: "application/octet-stream" }),
      new File([markdown], "书单.MD"),
      new File([html], "邀请函.HTML", { type: "text/html;charset=utf-8" }),
    ];
    for (const [i, file] of files.entries()) {
      const id = crypto.randomUUID();
      await store.saveAttachment(id, file);
      await store.saveMessage({ id, peerId: peer.id, senderId: peer.id, kind: "file", fileName: file.name,
        mimeType: file.type, size: file.size, createdAt: now + i, status: "delivered" });
    }
    for (const record of [
      { fileName: "缺失.txt", status: "delivered" }, { fileName: "待接收.txt", status: "awaiting-acceptance" },
      { fileName: "另存.txt", status: "delivered", attachmentStorage: "external" },
      { fileName: "文档.txt", status: "delivered", folder: { fileCount: 2, directoryCount: 0 } },
      { fileName: "照片集.zip", status: "delivered" },
    ]) {
      await store.saveMessage({ ...record, id: crypto.randomUUID(), peerId: peer.id, senderId: peer.id,
        kind: "file", createdAt: now - 1 });
    }
    await store.close();
  }, { html, markdown, javascript });
  await page.reload();
  await openPeer(page, "读书小组");
});

test("在聊天中查看和复制原文，HTML 和 Markdown 只显示文字", async ({ page }) => {
  const log = page.getByRole("log");
  const requests: string[] = [];
  await page.route("**/book-cover.png", route => { requests.push(route.request().url()); return route.abort(); });
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async (value: string) => { (window as any).copiedText = value; } },
  }));
  const dialog = page.getByRole("dialog");
  for (const [name, source] of [["邀请函.HTML", html], ["书单.MD", markdown], ["问候.JS", javascript], ["书目", "书单"]]) {
    await log.getByRole("button", { name: "查看 " + name }).click();
    await expect(dialog).toHaveAccessibleName(name);
    const code = dialog.getByRole("region", { name: "源代码" });
    await expect(code).toBeVisible();
    expect(await code.textContent()).toBe(source);
    await expect(dialog.locator("iframe, img, script, a")).toHaveCount(0);
    if (name === "邀请函.HTML") {
      await expectNoHorizontalOverflow(page);
      await capture(page, "text-source.png");
    }
    await dialog.getByRole("button", { name: "复制", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "已复制" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).copiedText)).toBe(source);
    await dialog.getByRole("button", { name: "关闭" }).click();
  }
  await log.getByRole("button", { name: "查看 记录.log" }).click();
  const next = dialog.getByRole("button", { name: "下一页" });
  await next.click();
  while (await next.isEnabled()) await next.click();
  expect(await dialog.getByRole("region").textContent()).toBe("🌿 末行\n");
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedText)).toBe("a".repeat(256 * 1024 - 1) + "🌿 末行\n");
  await page.keyboard.press("Escape");
  await log.getByRole("button", { name: "查看 空白.txt" }).click();
  await expect(dialog.getByRole("status")).toHaveText("文件为空");
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedText)).toBe("");
  await page.keyboard.press("Escape");
  await log.getByRole("button", { name: "查看 缺失.txt" }).click();
  await expect(dialog.getByRole("alert")).toContainText("已被清除");
  await expect(dialog.getByRole("button", { name: "复制" })).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(log.getByRole("button", { name: /^查看 (待接收|另存|文档|照片集)/ })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("从共享文件和存储管理打开文本附件", async ({ page, isMobile }) => {
  const shared = await openContact(page);
  await shared.getByRole("button", { name: "更多文件操作 书单.MD" }).click();
  await page.getByRole("menuitem", { name: "查看", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "书单.MD" });
  await expect(dialog.getByRole("region")).toHaveText(markdown);
  await dialog.getByRole("button", { name: "关闭" }).click();
  await closeContact(page);
  if (isMobile) {
    await page.getByRole("button", { name: "返回列表" }).click();
    await page.getByRole("link", { name: "我的", exact: true }).click();
    await page.getByRole("link", { name: /存储空间/ }).click();
  } else {
    await page.getByRole("button", { name: "存储管理", exact: true }).click();
  }
  await page.getByRole("button", { name: "更多文件操作 书单.MD" }).click();
  await page.getByRole("menuitem", { name: "查看", exact: true }).click();
  await expect(dialog.getByRole("region")).toHaveText(markdown);
});
