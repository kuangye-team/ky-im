import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import {
  openPeer,
  enableAutoAcceptFiles,
  setProfile,
} from "./helpers";

async function connect(alice: Page, bob: Page, url: string) {
  await alice.goto(url);
  await setProfile(alice, "文件夹发送方");
  await bob.goto(url);
  await setProfile(bob, "文件夹接收方");
  await openPeer(alice, "文件夹接收方");
  await openPeer(bob, "文件夹发送方");
}
async function source(page: Page, count: number) {
  await page.evaluate(async (count) => {
    const folder = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("资料集", { create: true });
    await folder.getDirectoryHandle("空目录", { create: true });
    const nested = await folder.getDirectoryHandle("子目录", { create: true });
    for (let index = 0; index < count; index++) {
      const parent = index === count - 1 ? nested : folder;
      const name = index === count - 1 ? "0.txt" : `${index}.txt`;
      const writer = await (
        await parent.getFileHandle(name, { create: true })
      ).createWritable();
      await writer.write(
        index === 0 && count > 256
          ? new Uint8Array(2 * 1024 * 1024 + 17).fill(91)
          : index === 1
            ? ""
            : `文件 ${index} 的内容`,
      );
      await writer.close();
    }
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => folder,
    });
  }, count);
}
async function receiveIntoDisk(page: Page, occupied = false) {
  await page.evaluate(async (occupied) => {
    const destination = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("saved", { create: true });
    if (occupied) {
      const existing = await destination.getDirectoryHandle("资料集", {
        create: true,
      });
      const writer = await (
        await existing.getFileHandle("keep.txt", { create: true })
      ).createWritable();
      await writer.write("keep existing");
      await writer.close();
    }
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => destination,
    });
  }, occupied);
}
async function attachmentCount(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ky-im");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = db
        .transaction("attachments")
        .objectStore("attachments")
        .count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  });
}
for (const automatic of [false, true]) {
  test(`文件夹流式保留空目录，刷新后可导出 ZIP（自动接收：${automatic}）`, async ({ browser, baseURL }) => {
    const a = await browser.newContext({ locale: "zh-CN" }), b = await browser.newContext({ locale: "zh-CN" });
    try {
      const alice = await a.newPage(), bob = await b.newPage();
      await bob.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }));
      await connect(alice, bob, baseURL!);
      if (automatic) await enableAutoAcceptFiles(bob);
      await source(alice, 3);
      await alice.getByRole("button", { name: "发送文件夹", exact: true }).click();
      const message = bob.locator(".message-row").filter({ hasText: "资料集" });
      if (!automatic) {
        await expect(message.getByRole("button", { name: "接收", exact: true })).toBeEnabled();
        expect(await attachmentCount(bob)).toBe(0);
        await message.getByRole("button", { name: "接收", exact: true }).click();
      }
      await expect(alice.getByText("已送达", { exact: true })).toBeVisible();
      expect(await attachmentCount(bob)).toBe(1);
      expect(await attachmentCount(alice)).toBe(1);
      await bob.reload(); await openPeer(bob, "文件夹发送方");
      const downloaded = bob.waitForEvent("download");
      await bob.getByRole("button", { name: "下载 资料集", exact: true }).click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe("资料集.zip");
      const archive = new ZipReader(new BlobReader(new Blob([await readFile((await download.path())!)])));
      const entries = await archive.getEntries();
      expect(entries.map(e => e.filename).sort()).toEqual([
        "资料集/", "资料集/空目录/", "资料集/子目录/", "资料集/子目录/0.txt", "资料集/0.txt", "资料集/1.txt",
      ].sort());
      const text = entries.find(e => e.filename === "资料集/子目录/0.txt")!;
      expect(await text.getData!(new TextWriter())).toBe("文件 2 的内容");
      expect(entries.find(e => e.filename === "资料集/1.txt")!.uncompressedSize).toBe(0);
      await archive.close();
      await bob.screenshot({ path: `../temp/screenshot/opfs-folder-${automatic}.png`, fullPage: true });
    } finally { await a.close(); await b.close(); }
  });
}

test("257 个文件保存在 OPFS，目录导出避开同名内容，删除记录保留导出副本", async ({ browser, baseURL }) => {
  const a = await browser.newContext({ locale: "zh-CN" }), b = await browser.newContext({ locale: "zh-CN" });
  try {
    const alice = await a.newPage(), bob = await b.newPage();
    await connect(alice, bob, baseURL!); await source(alice, 257); await receiveIntoDisk(bob, true);
    await alice.getByRole("button", { name: "发送文件夹", exact: true }).click();
    await bob.getByRole("button", { name: "接收", exact: true }).click();
    await expect(alice.getByText("已送达", { exact: true })).toBeVisible({ timeout: 45_000 });
    const row = bob.locator(".message-row").filter({ hasText: "资料集" });
    const id = (await row.getAttribute("data-message-id"))!;
    await row.getByRole("button", { name: "下载 资料集", exact: true }).click();
    const exported = async () => bob.evaluate(async () => {
      try {
        const saved = await (await navigator.storage.getDirectory()).getDirectoryHandle("saved");
        const root = await saved.getDirectoryHandle("资料集 (2)");
        const nested = await root.getDirectoryHandle("子目录");
        return { nested: await (await nested.getFileHandle("0.txt")).getFile().then(f => f.text()),
          empty: (await root.getDirectoryHandle("空目录")).kind,
          original: await (await (await saved.getDirectoryHandle("资料集")).getFileHandle("keep.txt")).getFile().then(f => f.text()) };
      } catch { return null; }
    });
    await expect.poll(exported).toEqual({ nested: "文件 256 的内容", empty: "directory", original: "keep existing" });
    await bob.evaluate(async (id) => {
      const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
      const storage = new IndexedDBStorageAdapter(); await storage.deleteMessages([id]); await storage.close();
    }, id);
    expect(await attachmentCount(bob)).toBe(0);
    expect(await exported()).toMatchObject({ nested: "文件 256 的内容", original: "keep existing" });
    await bob.reload(); await openPeer(bob, "文件夹发送方");
    await expect(bob.locator(`[data-message-id="${id}"]`)).toHaveCount(0);
  } finally { await a.close(); await b.close(); }
});

test("拖入文件夹和兼容选择入口都能发送", async ({ browser, baseURL }) => {
  const temporary = test.info().outputPath("folder-picker");
  const folder = resolve(temporary, "普通资料");
  await mkdir(resolve(folder, "子目录"), { recursive: true });
  await writeFile(resolve(folder, "子目录/说明.txt"), "folder input fallback");
  const a = await browser.newContext({ locale: "zh-CN" });
  const b = await browser.newContext({ locale: "zh-CN" });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    await connect(alice, bob, baseURL!);
    await enableAutoAcceptFiles(bob);
    await alice.evaluate(() =>
      Object.defineProperty(window, "showDirectoryPicker", {
        value: undefined,
        configurable: true,
      }),
    );
    const chooser = alice.waitForEvent("filechooser");
    await alice
      .getByRole("button", { name: "发送文件夹", exact: true })
      .click();
    await (await chooser).setFiles(folder);
    await expect(
      bob.getByRole("button", { name: "下载 普通资料", exact: true }),
    ).toBeEnabled();
    const draggedFolder = resolve(temporary, "拖拽资料");
    await mkdir(resolve(draggedFolder, "空文件夹"), { recursive: true });
    await writeFile(resolve(draggedFolder, "拖入.txt"), "drop content");
    const session = await a.newCDPSession(alice);
    const bounds = (await alice.locator(".chat-panel").boundingBox())!;
    for (const type of ["dragEnter", "dragOver", "drop"] as const)
      await session.send("Input.dispatchDragEvent", {
        type,
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
        data: { items: [], files: [draggedFolder], dragOperationsMask: 1 },
      });
    await session.detach();
    const button = bob.getByRole("button", {
      name: "下载 拖拽资料",
      exact: true,
    });
    await expect(button).toBeEnabled();
    await bob.evaluate(() => Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }));
    const downloaded = bob.waitForEvent("download");
    await button.click();
    const archive = new ZipReader(
      new BlobReader(
        new Blob([await readFile((await (await downloaded).path())!)]),
      ),
    );
    expect(
      (await archive.getEntries()).map((entry) => entry.filename),
    ).toContain("拖拽资料/空文件夹/");
    await archive.close();
  } finally {
    await a.close();
    await b.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
