import { expect, test, type Page } from "@playwright/test";
import {
  capture,
  openPeer,
  setProfile,
  expectNoHorizontalOverflow,
} from "./helpers";

async function connect(alice: Page, bob: Page, baseURL: string) {
  await alice.goto(baseURL);
  await setProfile(alice, "文件发送方");
  await bob.goto(baseURL);
  await setProfile(bob, "文件接收方");
  await openPeer(alice, "文件接收方");
  await openPeer(bob, "文件发送方");
}

test("超过 256 MB 先确认，可拒收；不支持的浏览器禁用接收", async ({
  browser,
  baseURL,
}) => {
  const a = await browser.newContext({ locale: "zh-CN" });
  const b = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
  });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    // Metadata-only >256 MiB fixture: rejection must never read its payload.
    await alice.addInitScript(() => {
      document.addEventListener(
        "change",
        (event) => {
          const input = event.target as HTMLInputElement;
          for (const file of Array.from(input.files || []))
            if (file.name === "旅行影像合集.zip")
              Object.defineProperty(file, "size", {
                value: 256 * 1024 ** 2 + 1,
              });
        },
        true,
      );
    });
    await connect(alice, bob, baseURL!);
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "旅行影像合集.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("not read before consent"),
    });
    await expect(
      bob.getByRole("button", { name: "接收并保存", exact: true }),
    ).toBeVisible();
    await expect(
      alice.getByText("等待对方确认", { exact: true }),
    ).toBeVisible();
    const request = bob
      .locator(".message-row")
      .filter({ hasText: "旅行影像合集.zip" });
    await expect(request.getByText("256.0 MB", { exact: true })).toBeVisible();
    await expect(request.getByRole("button", { name: /下载/ })).toHaveCount(0);
    const dismiss = bob.getByRole("button", { name: "关闭提示", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    await capture(bob, "large-file-confirmation.png");
    await capture(alice, "large-file-sender.png");
    await bob.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(bob);
    await capture(bob, "large-file-confirmation-mobile.png");
    await bob.getByRole("button", { name: "拒收", exact: true }).click();
    await expect(alice.getByText("发送失败", { exact: true })).toBeVisible();
    await expect(bob.getByText("接收失败", { exact: true })).toBeVisible();
    await capture(alice, "large-file-failed-sender.png");
    await capture(bob, "large-file-failed-receiver.png");
    await bob.evaluate(() =>
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      }),
    );
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "旅行影像合集.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("also not read"),
    });
    await expect(
      bob.getByRole("button", { name: "接收并保存", exact: true }),
    ).toBeDisabled();
    await expect(
      bob.getByText(
        "当前浏览器不支持接收超大文件，请使用电脑上的 Chrome 或 Edge 打开安全连接后重试",
        { exact: true },
      ),
    ).toBeHidden();
    await bob.getByRole("button", { name: "拒收", exact: true }).click();
  } finally {
    await a.close();
    await b.close();
  }
});

test("确认后通过真实直连流式写入，刷新仅保留记录；普通附件仍可下载", async ({
  browser,
  baseURL,
}) => {
  const a = await browser.newContext({ locale: "zh-CN" });
  const b = await browser.newContext({ locale: "zh-CN" });
  try {
    // Lower only the browser-storage boundary to exercise the full browser
    // lifecycle quickly. Production's exact 256 MiB boundary is covered above.
    for (const context of [a, b])
      await context.route("**/src/config.ts", async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /MAX_FILE_SIZE = [^;]+/,
          "MAX_FILE_SIZE = 1048576",
        );
        expect(body).toContain("MAX_FILE_SIZE = 1048576");
        await route.fulfill({ response, body });
      });
    const alice = await a.newPage();
    const bob = await b.newPage();
    // Replace just the OS picker with a real browser writable file, so write,
    // close and byte verification still use FileSystemWritableFileStream.
    await bob.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => {
          const directory = await navigator.storage.getDirectory();
          return directory.getFileHandle("received-test.bin", { create: true });
        },
      });
    });
    await connect(alice, bob, baseURL!);
    const data = Buffer.alloc(2 * 1024 * 1024 + 17);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "streamed.bin",
      mimeType: "application/octet-stream",
      buffer: data,
    });
    await bob.getByRole("button", { name: "接收并保存", exact: true }).click();
    await expect(alice.getByText("已送达", { exact: true })).toBeVisible();
    const received = await bob.evaluate(async () => {
      const directory = await navigator.storage.getDirectory();
      const file = await (
        await directory.getFileHandle("received-test.bin")
      ).getFile();
      return Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        ),
      );
    });
    expect(received).toEqual(
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))),
    );
    for (const page of [alice, bob]) {
      const records = await page.evaluate(async () => {
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
      expect(records).toBe(0);
    }
    await bob.reload();
    await openPeer(bob, "文件发送方");
    await expect(
      bob.locator(".message-row").getByText("streamed.bin", { exact: true }),
    ).toBeVisible();
    await expect(
      bob
        .locator(".message-row")
        .getByRole("button", { name: "转发消息", exact: true }),
    ).toBeDisabled();
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "small.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("still downloadable"),
    });
    const small = bob.locator(".message-row").filter({ hasText: "small.txt" });
    await small.getByRole("button", { name: "接收", exact: true }).click();
    await expect(
      small.getByRole("button", { name: "下载 small.txt", exact: true }),
    ).toBeEnabled();
    const download = bob.waitForEvent("download");
    await small
      .getByRole("button", { name: "下载 small.txt", exact: true })
      .click();
    expect((await download).suggestedFilename()).toBe("small.txt");
  } finally {
    await a.close();
    await b.close();
  }
});
