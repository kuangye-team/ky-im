import { expect, test as base, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expectNoHorizontalOverflow, openPeer, setProfile } from "./helpers";

const filename = "刷新保护.txt";
const contents = "取消刷新后，文件仍能完整传输。";
const test = base.extend<{ peers: { sender: Page; receiver: Page } }>({
  peers: async ({ browser, baseURL }, use) => {
    const a = await browser.newContext({ locale: "zh-CN", baseURL });
    const b = await browser.newContext({ locale: "zh-CN", baseURL });
    try {
      const sender = await a.newPage();
      const receiver = await b.newPage();
      await sender.goto("/");
      await setProfile(sender, "刷新发送方");
      await receiver.goto("/");
      await setProfile(receiver, "刷新接收方");
      await openPeer(sender, "刷新接收方");
      await openPeer(receiver, "刷新发送方");
      await sender.getByLabel("选择文件", { exact: true }).setInputFiles({
        name: filename,
        mimeType: "text/plain",
        buffer: Buffer.from(contents),
      });
      await expect(sender.getByRole("log")).toContainText("等待对方确认");
      await expect(receiver.getByRole("button", { name: "接收", exact: true })).toBeVisible();
      await use({ sender, receiver });
    } finally {
      await a.close();
      await b.close();
    }
  },
});

function confirmation(page: Page) {
  return page.getByRole("dialog", { name: "确认刷新页面？", exact: true });
}

test("发送和接收期间均拦截刷新，默认取消且取消后文件仍可完整传输", async ({ peers: { sender, receiver } }) => {
  // Exercise the browser toolbar path while the file is waiting for consent.
  for (const page of [sender, receiver]) {
    await page.evaluate(() => { document.documentElement.dataset.refreshMarker = "retained"; });
    const session = await page.context().newCDPSession(page);
    const prompt = page.waitForEvent("dialog");
    // Page.reload() waits for a navigation even when the user cancels it.
    const reloading = session.send("Page.reload");
    const dialog = await prompt;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
    await reloading;
    await session.detach();
    await expect(page.locator("html")).toHaveAttribute("data-refresh-marker", "retained");
  }

  // Pause the real file read so keyboard protection is also checked after acceptance.
  await sender.evaluate(() => {
    const state = { pending: [] as (() => void)[], released: false };
    (window as any).refreshReadGate = state;
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () {
      if (!state.released) await new Promise<void>((resolve) => state.pending.push(resolve));
      return read.call(this);
    };
  });
  await receiver.getByRole("button", { name: "接收", exact: true }).click();
  await expect.poll(() => sender.evaluate(() => (window as any).refreshReadGate.pending.length)).toBeGreaterThan(0);

  // Pending transfers in a different view still need protection.
  await sender.getByRole("button", { name: "系统配置", exact: true }).click();
  for (const shortcut of ["F5", "Control+r", "Meta+r", "Shift+F5", "Control+Shift+r", "Meta+Shift+r", "Control+F5"]) {
    await sender.keyboard.press(shortcut);
    const modal = confirmation(sender);
    await expect(modal).toContainText("刷新后，未完成的传输将会中断，需要重新发起。是否确认刷新？");
    await expect(modal.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await sender.keyboard.press("Enter");
    await expect(modal).toBeHidden();
    await expect(sender.locator("html")).toHaveAttribute("data-refresh-marker", "retained");
  }

  await receiver.keyboard.press("F5");
  await expect(confirmation(receiver).getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await receiver.screenshot({ path: "../temp/screenshot/refresh-confirm-desktop.png", fullPage: true, animations: "disabled" });
  await receiver.keyboard.press("F5");
  await expect(confirmation(receiver)).toHaveCount(1);
  await receiver.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(receiver);
  await receiver.screenshot({ path: "../temp/screenshot/refresh-confirm-mobile.png", fullPage: true, animations: "disabled" });
  await receiver.keyboard.press("Escape");
  await expect(confirmation(receiver)).toBeHidden();

  await sender.evaluate(() => {
    const state = (window as any).refreshReadGate;
    state.released = true;
    for (const release of state.pending.splice(0)) release();
  });
  const download = receiver.getByRole("button", { name: `下载 ${filename}`, exact: true });
  await expect(download).toBeEnabled();
  const downloading = receiver.waitForEvent("download");
  await download.click();
  expect(await readFile((await (await downloading).path())!, "utf8")).toBe(contents);

  // Completing transfers removes protection on both ends, without blocking reload.
  for (const page of [sender, receiver]) {
    await expect.poll(() => page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(false);
    const unexpectedPrompts: string[] = [];
    page.on("dialog", async (dialog) => { unexpectedPrompts.push(dialog.type()); await dialog.dismiss(); });
    await page.reload();
    expect(unexpectedPrompts).toEqual([]);
    await expect(page.locator("html")).not.toHaveAttribute("data-refresh-marker");
  }
});

test("明确确认后只刷新一次，中断记录可见且支持英文", async ({ peers: { sender } }) => {
  await sender.getByRole("button", { name: "语言", exact: true }).click();
  await sender.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await sender.keyboard.press("F5");
  const modal = sender.getByRole("dialog", { name: "Reload this page?", exact: true });
  await expect(modal).toContainText("Reloading will interrupt unfinished transfers. You will need to start them again.");
  await expect(modal.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  const prompts: string[] = [];
  sender.on("dialog", async (dialog) => { prompts.push(dialog.type()); await dialog.dismiss(); });
  await Promise.all([
    sender.waitForEvent("load"),
    modal.getByRole("button", { name: "Reload", exact: true }).click(),
  ]);
  expect(prompts).toEqual([]);
  await sender.getByRole("button", { name: "Chat with 刷新接收方", exact: true }).click();
  await expect(sender.getByRole("log")).toContainText("Failed to send");
});

test("浏览器确认刷新会中断待接收的传输", async ({ peers: { receiver } }) => {
  const prompt = receiver.waitForEvent("dialog");
  const reloading = receiver.reload();
  const dialog = await prompt;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
  await reloading;
  await openPeer(receiver, "刷新发送方");
  await expect(receiver.getByRole("log")).toContainText("接收失败");
  await expect(receiver.getByRole("button", { name: "接收", exact: true })).toHaveCount(0);
});

test("原生 Reload 请求也经过确认，取消保留传输；重置会中断传输并清除本机记录", async ({ peers: { sender, receiver } }) => {
  await sender.evaluate(() => window.dispatchEvent(new Event("hummingbird:reload-request")));
  const modal = confirmation(sender);
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  await expect(sender.getByRole("log")).toContainText("等待对方确认");
  await sender.getByRole("button", { name: "存储管理", exact: true }).click();
  await sender.getByRole("button", { name: "重置应用数据", exact: true }).click();
  const reset = sender.getByRole("dialog", { name: "重置应用数据？", exact: true });
  const prompts: string[] = [];
  sender.on("dialog", async (dialog) => { prompts.push(dialog.type()); await dialog.dismiss(); });
  await Promise.all([sender.waitForEvent("load"), reset.getByRole("button", { name: "确认重置", exact: true }).click()]);
  await expect(sender.getByRole("heading", { name: "存储管理", exact: true })).toBeVisible();
  expect(prompts).toEqual([]);
  await expect(receiver.getByRole("log")).toContainText(filename);
  await expect(receiver.getByRole("button", { name: "接收", exact: true })).toHaveCount(0);
});
