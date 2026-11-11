import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  closeContact,
  expectNoHorizontalOverflow,
  openContact,
  openPeer,
  setProfile,
} from "./helpers";

async function attachmentCount(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("send-chat");
      request.onsuccess = () => resolve(request.result);
    });
    const count = await new Promise<number>((resolve) => {
      const request = db
        .transaction("attachments")
        .objectStore("attachments")
        .count();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return count;
  });
}

test("默认确认接收，联系人开关持久保存且可关闭", async ({
  browser,
  baseURL,
}) => {
  const a = await browser.newContext({ locale: "zh-CN" });
  const b = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 980 },
  });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    await bob.addInitScript(() =>
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: undefined,
      }),
    );
    await alice.goto(baseURL!);
    await setProfile(alice, "文件分享者");
    await bob.goto(baseURL!);
    await setProfile(bob, "文件接收者");
    await openPeer(alice, "文件接收者");
    await openPeer(bob, "文件分享者");
    const contact = await openContact(bob);
    await expect(
      contact.getByRole("switch", { name: "自动接收文件" }),
    ).not.toBeChecked();
    await closeContact(bob);
    const send = (name: string) =>
      alice.getByLabel("选择文件", { exact: true }).setInputFiles({
        name,
        mimeType: "text/plain",
        buffer: Buffer.from("收到后才保存"),
      });
    const row = (name: string) =>
      bob.getByRole("log").locator(".message-row").filter({ hasText: name });
    await send("先问问我.txt");
    await expect(
      row("先问问我.txt").getByRole("button", { name: "接收", exact: true }),
    ).toBeEnabled();
    expect(await attachmentCount(bob)).toBe(0);
    await expect(alice.getByRole("log")).toContainText("等待对方确认");
    await bob.screenshot({
      path: test.info().outputPath("file-receive-confirmation.png"),
      fullPage: true,
      animations: "disabled",
    });
    await row("先问问我.txt")
      .getByRole("button", { name: "拒收", exact: true })
      .click();
    await expect(alice.getByRole("log")).toContainText("发送失败");
    await expect(row("先问问我.txt").getByRole("button", { name: "下载 先问问我.txt" })).toBeDisabled();
    await expect(row("先问问我.txt").getByRole("button", { name: "转发消息", exact: true })).toBeDisabled();
    expect(await attachmentCount(bob)).toBe(0);

    await send("手动接收.txt");
    await row("手动接收.txt")
      .getByRole("button", { name: "接收", exact: true })
      .click();
    const download = row("手动接收.txt").getByRole("button", {
      name: "下载 手动接收.txt",
    });
    await expect(download).toBeEnabled();
    const downloading = bob.waitForEvent("download");
    await download.click();
    expect(await readFile((await (await downloading).path())!, "utf8")).toBe(
      "收到后才保存",
    );

    const toggle = (await openContact(bob)).getByRole("switch", {
      name: "自动接收文件",
    });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await bob.screenshot({
      path: test.info().outputPath("contact-auto-receive-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    await bob.reload();
    await openPeer(bob, "文件分享者");
    await expect(
      (await openContact(bob)).getByRole("switch", { name: "自动接收文件" }),
    ).toBeChecked();
    await closeContact(bob);
    await send("自动接收.txt");
    await expect(
      row("自动接收.txt").getByRole("button", { name: "下载 自动接收.txt" }),
    ).toBeEnabled();
    await expect(
      row("自动接收.txt").getByRole("button", { name: "接收", exact: true }),
    ).toHaveCount(0);

    await bob.setViewportSize({ width: 390, height: 844 });
    const mobileContact = await openContact(bob);
    const mobileToggle = mobileContact.getByRole("switch", {
      name: "自动接收文件",
    });
    await expect(mobileToggle).toBeChecked();
    await mobileToggle.click();
    await expect(mobileToggle).not.toBeChecked();
    await expectNoHorizontalOverflow(bob);
    await bob.screenshot({
      path: test.info().outputPath("contact-auto-receive-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    await closeContact(bob);
    await send("关闭后确认.txt");
    await expect(
      row("关闭后确认.txt").getByRole("button", {
        name: "接收",
        exact: true,
      }),
    ).toBeVisible();
    await row("关闭后确认.txt")
      .getByRole("button", { name: "拒收", exact: true })
      .click();
    await bob.reload();
    await openPeer(bob, "文件分享者");
    await expect(
      (await openContact(bob)).getByRole("switch", { name: "自动接收文件" }),
    ).not.toBeChecked();
  } finally {
    await a.close();
    await b.close();
  }
});

test("关于弹窗源码可复制，记录说明为两行", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "关于本站", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "关于蜂鸟", exact: true });
  const source = await dialog
    .locator(".about-contact-list > div")
    .filter({ hasText: "源码" })
    .getByRole("link")
    .getAttribute("href");
  await dialog
    .getByRole("button", { name: "复制源码地址", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-copied", source!);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 980 });
    const lines = await dialog
      .locator(".help-content > div")
      .last()
      .locator("p")
      .evaluate(
        (element) =>
          element.getBoundingClientRect().height /
          parseFloat(getComputedStyle(element).lineHeight),
      );
    if (width === 1440) expect(lines).toBeCloseTo(2, 1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: test.info().outputPath(`about-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
});
