import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  capture,
  closeContact,
  expectNoHorizontalOverflow,
  openContact,
  openPeer,
  enableAutoAcceptFiles,
  setProfile,
} from "./helpers";

async function seedSharedFile(page: Page) {
  const unique = crypto.randomUUID().slice(0, 8);
  const fixture = {
    owner: `共享文件转发端-${unique}`,
    peer: `历史文件朋友-${unique}`,
    name: `共享文件-${unique}.txt`,
    type: "text/plain",
    retainedText: `保留的另一条消息-${unique}`,
    contents: `保存在本地的文件内容-${unique}\n第二行 🌿\n`,
  };
  await page.goto("/");
  await setProfile(page, fixture.owner);
  await page.evaluate(async (file) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("send-chat", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const peer = {
      id: crypto.randomUUID(),
      name: file.peer,
      avatar: "🌿",
      color: "#7266ed",
      bio: "",
      device: "浏览器",
      clientType: "web" as const,
    };
    const id = crypto.randomUUID();
    const blob = new Blob([file.contents], { type: file.type });
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
        updatedAt: Date.now(),
        unread: 0,
      });
      tx.objectStore("messages").put({
        id,
        peerId: peer.id,
        senderId: peer.id,
        kind: "file",
        fileName: file.name,
        mimeType: file.type,
        size: blob.size,
        createdAt: Date.now(),
        status: "delivered",
      });
      tx.objectStore("messages").put({
        id: crypto.randomUUID(),
        peerId: peer.id,
        senderId: peer.id,
        kind: "text",
        text: file.retainedText,
        createdAt: Date.now() + 1,
        status: "delivered",
      });
      tx.objectStore("attachments").put(blob, id);
      await done;
    } finally {
      db.close();
    }
  }, fixture);
  await page.reload();
  await openPeer(page, fixture.peer);
  return fixture;
}

test("共享文件仅下载按钮触发下载，更多菜单支持键盘和实际转发", async ({
  page,
  browser,
  baseURL,
}) => {
  const downloads: string[] = [];
  const frames: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  page.on("websocket", (socket) => {
    if (socket.url().includes("/api/ws")) {
      socket.on("framesent", (frame) => frames.push(String(frame.payload)));
    }
  });
  const fixture = await seedSharedFile(page);
  const contact = await openContact(page);
  const row = contact.locator(".shared-file").filter({ hasText: fixture.name });
  await row.getByText(fixture.name, { exact: true }).click();
  const more = row.getByRole("button", {
    name: `更多文件操作 ${fixture.name}`,
    exact: true,
  });
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", {
    name: `更多文件操作 ${fixture.name}`,
    exact: true,
  });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "转发", exact: true }),
  ).toBeFocused();
  await expect(
    menu.getByRole("menuitem", { name: "删除", exact: true }),
  ).toBeVisible();
  await capture(page, "desktop-shared-file-menu.png");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  expect(downloads).toEqual([]);

  const downloading = page.waitForEvent("download");
  await row
    .getByRole("button", {
      name: `下载共享文件 ${fixture.name}`,
      exact: true,
    })
    .click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe(fixture.name);
  expect(await readFile((await downloaded.path())!, "utf8")).toBe(
    fixture.contents,
  );
  expect(downloads).toEqual([fixture.name]);

  const recipientContext = await browser.newContext({
    locale: "zh-CN",
    acceptDownloads: true,
  });
  try {
    const recipient = await recipientContext.newPage();
    const recipientName = `共享文件接收端-${crypto.randomUUID().slice(0, 8)}`;
    await recipient.goto(baseURL!);
    await setProfile(recipient, recipientName);
    await openPeer(recipient, fixture.owner);
    await enableAutoAcceptFiles(recipient);

    // On mobile, the same dropdown must open forwarding over the contact dialog.
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileContact = await openContact(page);
    await mobileContact
      .getByRole("button", {
        name: `更多文件操作 ${fixture.name}`,
        exact: true,
      })
      .click();
    await expect(menu).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await capture(page, "mobile-shared-file-menu.png");
    await menu.getByRole("menuitem", { name: "转发", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(fixture.name);
    await dialog
      .getByRole("button", { name: `选择 ${recipientName}`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
    await expect(dialog).toBeHidden();
    const received = recipient.getByRole("log").getByRole("button", {
      name: `下载 ${fixture.name}`,
      exact: true,
    });
    await expect(received).toBeEnabled();
    const receiving = recipient.waitForEvent("download");
    await received.click();
    expect(await readFile((await (await receiving).path())!, "utf8")).toBe(
      fixture.contents,
    );
    await expect(page.locator(".chat-heading h2")).toHaveText(fixture.peer);
    expect(downloads).toEqual([fixture.name]);
    expect(
      frames.some(
        (frame) =>
          frame.includes(fixture.name) || frame.includes(fixture.contents),
      ),
    ).toBe(false);
  } finally {
    await recipientContext.close();
  }
});

test("共享文件删除可取消，手机确认后清除附件并保留其他消息", async ({
  page,
}) => {
  const fixture = await seedSharedFile(page);
  const downloads: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  const message = page
    .locator(".message-row")
    .filter({ hasText: fixture.name });
  const openDelete = async () => {
    const contact = await openContact(page);
    await contact
      .getByRole("button", {
        name: `更多文件操作 ${fixture.name}`,
        exact: true,
      })
      .click();
    const menu = page.getByRole("menu", {
      name: `更多文件操作 ${fixture.name}`,
      exact: true,
    });
    await menu.getByRole("menuitem", { name: "删除", exact: true }).click();
    await expect(menu).toBeHidden();
  };
  await openDelete();
  const dialog = page.getByRole("dialog", {
    name: "删除这条消息？",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(fixture.name);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(message).toBeVisible();
  const contact = await openContact(page);
  await expect(
    contact.locator(".shared-file").filter({ hasText: fixture.name }),
  ).toBeVisible();
  await expect(
    contact.getByRole("button", {
      name: `下载共享文件 ${fixture.name}`,
      exact: true,
    }),
  ).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await openDelete();
  await expect(dialog).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog).toBeHidden();
  await closeContact(page);
  await expect(message).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText(fixture.retainedText);
  const attachmentCount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("send-chat", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = db
          .transaction("attachments")
          .objectStore("attachments")
          .count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
  expect(attachmentCount).toBe(0);
  await page.reload();
  await openPeer(page, fixture.peer);
  await expect(page.getByRole("log")).toContainText(fixture.retainedText);
  await expect(message).toHaveCount(0);
  const restoredContact = await openContact(page);
  await expect(restoredContact.locator(".shared-file")).toHaveCount(0);
  expect(downloads).toEqual([]);
});
