import { expect, test, type Page } from "@playwright/test";
import { openPeer, setProfile, enableAutoAcceptFiles, expectNoHorizontalOverflow } from "./helpers";

async function connect(alice: Page, bob: Page, url: string) {
  await alice.goto(url); await setProfile(alice, "文件发送方");
  await bob.goto(url); await setProfile(bob, "文件接收方");
  await openPeer(alice, "文件接收方"); await openPeer(bob, "文件发送方");
}
async function generatedFile(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      for (const file of Array.from(input.files || [])) {
        if (file.name !== "257-MB.bin") continue;
        const size = 257 * 1024 ** 2 + 17;
        Object.defineProperty(file, "size", { value: size });
        Object.defineProperty(file, "slice", { value: (start = 0, end = size) => {
          const bytes = new Uint8Array(Math.min(end, size) - start);
          for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
          return new Blob([bytes]);
        } });
      }
    }, true);
  });
}
async function noPickers(page: Page) {
  await page.addInitScript(() => {
    for (const name of ["showSaveFilePicker", "showDirectoryPicker"])
      Object.defineProperty(window, name, { value: undefined, configurable: true });
  });
}
const send = (page: Page) => page.getByLabel("选择文件", { exact: true }).setInputFiles({
  name: "257-MB.bin", mimeType: "application/octet-stream", buffer: Buffer.from("generated in bounded slices"),
});

test("超过 256 MiB 仍可拒收，没有文件选择器也能确认接收", async ({ browser, baseURL }) => {
  const a = await browser.newContext({ locale: "zh-CN" }), b = await browser.newContext({ locale: "zh-CN" });
  try {
    const alice = await a.newPage(), bob = await b.newPage();
    await generatedFile(alice); await noPickers(bob); await connect(alice, bob, baseURL!);
    await send(alice);
    await expect(bob.getByRole("button", { name: "接收", exact: true })).toBeEnabled();
    await expect(alice.getByText("等待对方确认", { exact: true })).toBeVisible();
    await bob.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(bob);
    await bob.screenshot({ path: "../temp/screenshot/opfs-large-file-consent.png", fullPage: true });
    await bob.getByRole("button", { name: "拒收", exact: true }).click();
    await expect(alice.getByText("发送失败", { exact: true })).toBeVisible();
    expect(await bob.evaluate(async () => {
      const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
      const store = new IndexedDBStorageAdapter(); const files = await store.getFiles(); await store.close(); return files;
    })).toEqual([]);
  } finally { await a.close(); await b.close(); }
});

test("真实 257 MiB 文件自动流式保存到双方 OPFS，刷新后可读取和下载", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const a = await browser.newContext({ locale: "zh-CN" }), b = await browser.newContext({ locale: "zh-CN" });
  try {
    const alice = await a.newPage(), bob = await b.newPage();
    await generatedFile(alice); await noPickers(bob); await connect(alice, bob, baseURL!);
    await enableAutoAcceptFiles(bob); await send(alice);
    await expect(alice.getByText("已送达", { exact: true })).toBeVisible({ timeout: 180_000 });
    const id = (await bob.locator(".message-row").filter({ hasText: "257-MB.bin" }).getAttribute("data-message-id"))!;
    for (const page of [alice, bob]) {
      const stored = await page.evaluate(async (id) => {
        const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
        const store = new IndexedDBStorageAdapter();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("ky-im"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const record = await new Promise<unknown>((resolve) => {
          const request = db.transaction("attachments").objectStore("attachments").get(id); request.onsuccess = () => resolve(request.result);
        });
        const file = (await store.getAttachment(id))!;
        let valid = true;
        for (let offset = 0; offset < file.size; offset += 2 * 1024 ** 2) {
          const bytes = new Uint8Array(await file.slice(offset, offset + 2 * 1024 ** 2).arrayBuffer());
          for (let i = 0; i < bytes.length; i++) if (bytes[i] !== (offset + i) % 251) { valid = false; break; }
        }
        const pending = await new Promise<number>((resolve) => {
          const request = db.transaction("pendingAttachments").objectStore("pendingAttachments").count(); request.onsuccess = () => resolve(request.result);
        });
        db.close(); await store.close();
        return { size: file.size, valid, pending, metadataOnly: !(record instanceof Blob) && typeof (record as { path: string }).path === "string" };
      }, id);
      expect(stored).toEqual({ size: 257 * 1024 ** 2 + 17, valid: true, pending: 0, metadataOnly: true });
    }
    await bob.reload(); await openPeer(bob, "文件发送方");
    const button = bob.getByRole("button", { name: "下载 257-MB.bin", exact: true });
    await expect(button).toBeEnabled();
    const downloaded = bob.waitForEvent("download"); await button.click();
    const file = await downloaded; expect(file.suggestedFilename()).toBe("257-MB.bin"); expect(await file.failure()).toBeNull();
    await bob.screenshot({ path: "../temp/screenshot/opfs-large-file-saved.png", fullPage: true });
  } finally { await a.close(); await b.close(); }
});
