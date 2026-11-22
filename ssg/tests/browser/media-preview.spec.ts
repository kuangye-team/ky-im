import { readFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";
import { capture, closeContact, expectNoHorizontalOverflow, openContact, openPeer } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell, .phone-shell")).toBeVisible();
  const samples = await Promise.all(["preview.ogg", "preview.webm"].map(async name =>
    (await readFile(new URL("./fixtures/" + name, import.meta.url))).toString("base64")));
  await page.evaluate(async ([audio, video]) => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    const store = new IndexedDBStorageAdapter();
    const peer = { ...await store.getProfile(), id: crypto.randomUUID(), name: "影音测试" };
    const now = Date.now();
    await store.saveConversation({ peer, updatedAt: now, unread: 0 });

    await store.saveConversation({ peer: { ...peer, id: crypto.randomUUID(), name: "另一个聊天" }, updatedAt: now - 1, unread: 0 });
    const bytes = (encoded: string) => Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const files = [
      new File([bytes(audio)], "午后.OGG", { type: "application/octet-stream" }),
      new File([bytes(video)], "色彩样片.webm", { type: "video/webm" }),
      new File(["invalid"], "损坏.mp4", { type: "video/mp4" }),
    ];
    for (const [index, file] of files.entries()) {
      const id = crypto.randomUUID();
      await store.saveAttachment(id, file);
      await store.saveMessage({ id, peerId: peer.id, senderId: peer.id, kind: "file", fileName: file.name,
        mimeType: file.type, size: file.size, status: "delivered", createdAt: now + index + 1 });
    }
    for (const extra of [{ fileName: "等待接收.wav", status: "awaiting-acceptance" },
                         { fileName: "已另存.mp4", status: "delivered", attachmentStorage: "external" }]) {
      await store.saveMessage({ ...extra, id: crypto.randomUUID(), peerId: peer.id, senderId: peer.id, kind: "file", createdAt: now });
    }
    await store.close();
  }, samples);
  await page.reload();
  await openPeer(page, "影音测试");
});

async function expectPlaying(media: Locator) {
  await expect.poll(() => media.evaluate((el: HTMLMediaElement) => !el.paused && el.currentTime > 0)).toBe(true);
}

test("音视频点一次在消息内播放，切换聊天时关闭播放器和画中画", async ({ page, isMobile }) => {
  const log = page.getByRole("log");
  await log.getByRole("button", { name: "播放 午后.OGG" }).click();
  const audio = log.locator("audio");
  await expectPlaying(audio);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await log.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(audio).toHaveJSProperty("paused", true);
  await capture(page, "inline-audio.png");
  await log.getByRole("button", { name: "播放", exact: true }).click();
  await expectPlaying(audio);
  const oldAudio = await audio.elementHandle();
  const audioUrl = await audio.getAttribute("src");

  await log.getByRole("button", { name: "播放 色彩样片.webm" }).click();
  const video = log.locator("video");
  await expectPlaying(video);
  expect(await oldAudio!.evaluate(el => (el as HTMLMediaElement).paused)).toBe(true);
  expect(await page.evaluate(url => fetch(url!).then(() => false, () => true), audioUrl)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(video).toHaveJSProperty("playsInline", true);
  await expectNoHorizontalOverflow(page);
  await capture(page, "inline-video.png");
  const oldVideo = await video.elementHandle();
  const videoUrl = await video.getAttribute("src");

  if (!isMobile) {
    await video.hover();
    await log.getByRole("button", { name: "画中画", exact: true }).click();
    await expect.poll(() => video.evaluate(el => document.pictureInPictureElement === el)).toBe(true);
  } else {
    await page.getByRole("button", { name: "返回列表" }).click();
  }
  await openPeer(page, "另一个聊天");
  await expect(log.locator("audio, video")).toHaveCount(0);
  expect(await oldVideo!.evaluate(el => (el as HTMLMediaElement).paused && !el.hasAttribute("src"))).toBe(true);
  expect(await page.evaluate(url => fetch(url!).then(() => false, () => true), videoUrl)).toBe(true);
  await expect.poll(() => page.evaluate(() => !!document.pictureInPictureElement)).toBe(false);

  if (isMobile) await page.getByRole("button", { name: "返回列表" }).click();
  await openPeer(page, "影音测试");
  await expect(log.locator("audio, video")).toHaveCount(0);
  await log.getByRole("button", { name: "播放 损坏.mp4" }).click();
  await expect(log.getByRole("alert")).toHaveText("此设备无法播放这个文件");
  await log.getByRole("button", { name: "收起播放器" }).click();
  await expect(log.getByRole("alert")).toHaveCount(0);
  await expect(log.getByRole("button", { name: /播放 (等待接收|已另存)/ })).toHaveCount(0);
  await expect(log.getByRole("button", { name: /^(打开|打开方式)$/ })).toHaveCount(0);
});

test("共享文件和存储管理里的播放操作会在对应文件下开始播放", async ({ page, isMobile }) => {
  const shared = await openContact(page);
  await shared.getByRole("button", { name: "更多文件操作 午后.OGG" }).click();
  await page.getByRole("menuitem", { name: "播放", exact: true }).click();
  await expectPlaying(shared.locator(".shared-file").filter({ hasText: "午后.OGG" }).locator("audio"));
  await capture(page, "inline-shared-audio.png");
  await closeContact(page);
  if (isMobile) {
    await page.getByRole("button", { name: "返回列表" }).click();
    await page.getByRole("link", { name: "我的", exact: true }).click();
    await page.getByRole("link", { name: /存储空间/ }).click();
  } else {
    await page.getByRole("button", { name: "存储管理", exact: true }).click();
  }
  const row = page.getByRole("listitem").filter({ hasText: "色彩样片.webm" });
  await row.getByRole("button", { name: "更多文件操作 色彩样片.webm" }).click();
  await page.getByRole("menuitem", { name: "播放", exact: true }).click();
  await expectPlaying(row.locator("video"));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await row.getByRole("button", { name: "更多文件操作 色彩样片.webm" }).click();
  await page.getByRole("menuitem", { name: "收起播放器" }).click();
  await expect(row.locator("video")).toHaveCount(0);
});
