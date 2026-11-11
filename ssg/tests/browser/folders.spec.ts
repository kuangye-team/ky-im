import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import {
  capture,
  expectNoHorizontalOverflow,
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
      const request = indexedDB.open("send-chat");
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
  test(`小文件夹保留目录和同名文件（自动接收：${automatic}）`, async ({
    browser,
    baseURL,
  }) => {
    const a = await browser.newContext({ locale: "zh-CN" });
    const b = await browser.newContext({ locale: "zh-CN" });
    try {
      const alice = await a.newPage();
      const bob = await b.newPage();
      await connect(alice, bob, baseURL!);
      if (automatic) await enableAutoAcceptFiles(bob);
      await source(alice, 3);
      await alice
        .getByRole("button", { name: "发送文件夹", exact: true })
        .click();
      const message = bob
        .locator(".message-row")
        .filter({ hasText: "资料集.zip" });
      if (!automatic) {
        await expect(
          message.getByRole("button", { name: "接收", exact: true }),
        ).toBeVisible();
        expect(await attachmentCount(bob)).toBe(0);
        await message
          .getByRole("button", { name: "接收", exact: true })
          .click();
      }
      await expect(
        message.getByRole("button", { name: "下载 资料集.zip", exact: true }),
      ).toBeEnabled();
      const downloadPromise = bob.waitForEvent("download");
      await message
        .getByRole("button", { name: "下载 资料集.zip", exact: true })
        .click();
      const download = await downloadPromise;
      const zip = new ZipReader(
        new BlobReader(new Blob([await readFile((await download.path())!)])),
      );
      const entries = await zip.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual(
        expect.arrayContaining([
          "资料集/",
          "资料集/空目录/",
          "资料集/0.txt",
          "资料集/子目录/0.txt",
          "资料集/1.txt",
        ]),
      );
      const content = entries.find(
        (entry) => entry.filename === "资料集/子目录/0.txt",
      )!;
      if (content.directory) throw new Error("Expected a file");
      expect(await content.getData(new TextWriter())).toBe("文件 2 的内容");
      await zip.close();
      expect(await attachmentCount(alice)).toBe(1);
      expect(await attachmentCount(bob)).toBe(1);
      await capture(bob, "folder-zip.png");
    } finally {
      await a.close();
      await b.close();
    }
  });
}

test("257 个小文件直接保存，保留结构、避免覆盖，双方只留记录", async ({
  browser,
  baseURL,
}) => {
  const a = await browser.newContext({ locale: "zh-CN" });
  const b = await browser.newContext({ locale: "zh-CN" });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    await connect(alice, bob, baseURL!);
    await source(alice, 257);
    await receiveIntoDisk(bob, true);
    await alice
      .getByRole("button", { name: "发送文件夹", exact: true })
      .click();
    const request = bob.locator(".message-row").filter({ hasText: "资料集" });
    await expect(request.getByText(/257 个文件/)).toBeVisible();
    await expect(
      bob.getByRole("button", { name: "接收并保存", exact: true }),
    ).toBeEnabled();
    expect(await attachmentCount(alice)).toBe(0);
    expect(await attachmentCount(bob)).toBe(0);
    await capture(bob, "folder-direct-confirmation.png");
    await bob.getByRole("button", { name: "接收并保存", exact: true }).click();
    await expect(alice.getByText("已送达", { exact: true })).toBeVisible();
    const result = await bob.evaluate(async () => {
      const saved = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("saved");
      const original = await saved.getDirectoryHandle("资料集");
      const folder = await saved.getDirectoryHandle("资料集 (2)");
      const texts: string[] = [];
      for (let index = 0; index < 257; index++) {
        const parent =
          index === 256 ? await folder.getDirectoryHandle("子目录") : folder;
        const file = await (
          await parent.getFileHandle(index === 256 ? "0.txt" : `${index}.txt`)
        ).getFile();
        if (index === 0) {
          const data = new Uint8Array(await file.arrayBuffer());
          texts.push(
            data.length === 2 * 1024 * 1024 + 17 &&
              data.every((byte) => byte === 91)
              ? "verified large file"
              : "corrupt",
          );
        } else texts.push(await file.text());
      }
      return {
        texts,
        empty: (await folder.getDirectoryHandle("空目录")).kind,
        original: await (
          await (await original.getFileHandle("keep.txt")).getFile()
        ).text(),
      };
    });
    expect(result.texts).toEqual(
      Array.from({ length: 257 }, (_, index) =>
        index === 0
          ? "verified large file"
          : index === 1
            ? ""
            : `文件 ${index} 的内容`,
      ),
    );
    expect(result.empty).toBe("directory");
    expect(result.original).toBe("keep existing");
    expect(await attachmentCount(alice)).toBe(0);
    expect(await attachmentCount(bob)).toBe(0);
    await bob.reload();
    await openPeer(bob, "文件夹发送方");
    await expect(
      bob.locator(".message-row").getByText("资料集", { exact: true }),
    ).toBeVisible();
    await expect(
      bob
        .locator(".message-row")
        .getByRole("button", { name: "转发消息", exact: true }),
    ).toBeDisabled();
    await capture(bob, "folder-direct-complete.png");
    await bob.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(bob);
    await capture(bob, "folder-direct-mobile.png");
  } finally {
    await a.close();
    await b.close();
  }
});

test("文件夹超过 256 MB 时不读取内容，支持拒收、取消和能力检测", async ({
  browser,
  baseURL,
}) => {
  const a = await browser.newContext({ locale: "zh-CN" });
  const b = await browser.newContext({ locale: "zh-CN" });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    await connect(alice, bob, baseURL!);
    await alice.evaluate(() => {
      const file = new File(["must not read"], "large.bin");
      Object.defineProperty(file, "size", { value: 256 * 1024 ** 2 + 1 });
      file.slice = () => {
        throw new Error("Read before acceptance");
      };
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => ({
          name: "大文件夹",
          async *values() {
            yield {
              name: "large.bin",
              kind: "file",
              getFile: async () => file,
            };
          },
        }),
      });
    });
    await bob.evaluate(() =>
      Object.defineProperty(window, "showDirectoryPicker", {
        value: undefined,
        configurable: true,
      }),
    );
    await alice
      .getByRole("button", { name: "发送文件夹", exact: true })
      .click();
    await expect(
      bob.getByRole("button", { name: "接收并保存", exact: true }),
    ).toBeDisabled();
    await expect(
      bob.getByText(
        "当前浏览器不支持保存文件夹，请使用电脑上的 Chrome 或 Edge 打开安全连接后重试",
        { exact: true },
      ),
    ).toBeHidden();
    await bob.getByRole("button", { name: "拒收", exact: true }).click();
    await expect(alice.getByText("发送失败", { exact: true })).toBeVisible();
    await alice
      .getByRole("button", { name: "发送文件夹", exact: true })
      .click();
    await alice.getByRole("button", { name: "取消传输", exact: true }).click();
    await expect(alice.getByText("发送失败", { exact: true })).toHaveCount(2);
    await expect(bob.getByText("接收失败", { exact: true })).toHaveCount(2);
    expect(await attachmentCount(alice)).toBe(0);
    expect(await attachmentCount(bob)).toBe(0);
  } finally {
    await a.close();
    await b.close();
  }
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
      bob.getByRole("button", { name: "下载 普通资料.zip", exact: true }),
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
      name: "下载 拖拽资料.zip",
      exact: true,
    });
    await expect(button).toBeEnabled();
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
