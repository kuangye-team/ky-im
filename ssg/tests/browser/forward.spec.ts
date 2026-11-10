import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  capture,
  expectNoHorizontalOverflow,
  openPeer,
  enableAutoAcceptFiles,
  sendText,
  setProfile,
} from "./helpers";

async function forwardMessage(page: Page, content: string, recipient: string) {
  await page
    .locator(".message-row")
    .filter({ hasText: content })
    .getByRole("button", { name: "转发消息", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
  await expect(dialog).toContainText(content);
  await expect(
    dialog.getByRole("button", { name: "确认转发", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "搜索转发联系人", exact: true })
    .fill(recipient);
  await dialog
    .getByRole("button", { name: `选择 ${recipient}`, exact: true })
    .click();
  await expectNoHorizontalOverflow(page);
  await capture(
    page,
    page.viewportSize()!.width < 600
      ? "mobile-forward.png"
      : "desktop-forward.png",
  );
  await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("历史文字、图片和文件可转发给第三人，保留原会话且不经过信令传输", async ({
  page,
  browser,
  baseURL,
}) => {
  const senderContext = await browser.newContext({ locale: "zh-CN" });
  const recipientContext = await browser.newContext({
    locale: "zh-CN",
    acceptDownloads: true,
  });
  const sender = await senderContext.newPage();
  const recipient = await recipientContext.newPage();
  const sockets: string[] = [];
  const errors: string[] = [];
  for (const client of [page, sender, recipient]) {
    client.on("pageerror", (error) => errors.push(error.message));
    client.on("websocket", (socket) => {
      if (socket.url().includes("/api/ws")) {
        socket.on("framesent", (frame) => sockets.push(String(frame.payload)));
      }
    });
  }
  const unique = Date.now().toString(36);
  const sourceName = `原消息朋友-${unique}`;
  const relayName = `转发朋友-${unique}`;
  const targetName = `接收朋友-${unique}`;
  const text = `来自历史的文字内容-${unique}`;
  const ownText = `自己发送的消息-${unique}`;
  const fileName = `转发文件-${unique}.txt`;
  const file = Buffer.from(`文件原始字节-${unique}\n`.repeat(5000));
  const imageName = `转发图片-${unique}.png`;
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    await page.goto("/");
    await setProfile(page, relayName);
    await sender.goto(baseURL!);
    await setProfile(sender, sourceName);
    await recipient.goto(baseURL!);
    await setProfile(recipient, targetName);
    await openPeer(page, sourceName);
    await openPeer(sender, relayName);
    await enableAutoAcceptFiles(page);
    await sendText(sender, text);
    await expect(page.getByRole("log")).toContainText(text);
    await sendText(page, ownText);
    await expect(sender.getByRole("log")).toContainText(ownText);
    await sender
      .getByLabel("选择文件", { exact: true })
      .setInputFiles({ name: fileName, mimeType: "text/plain", buffer: file });
    await expect(
      page.getByRole("button", { name: `下载 ${fileName}`, exact: true }),
    ).toBeEnabled();
    await sender
      .getByLabel("选择图片", { exact: true })
      .setInputFiles({ name: imageName, mimeType: "image/png", buffer: image });
    await expect(
      page.getByRole("img", { name: imageName, exact: true }),
    ).toHaveJSProperty("naturalWidth", 1);
    const sourceIds = await page
      .locator(".message-row")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-message-id")),
      );

    // The original sender can go offline; forwarding uses persisted local history.
    await senderContext.close();
    await page.reload();
    await openPeer(page, sourceName);
    await forwardMessage(page, text, targetName);
    await openPeer(recipient, relayName);
    await enableAutoAcceptFiles(recipient);
    await expect(recipient.getByRole("log")).toContainText(text);
    await expect(page.locator(".chat-heading h2")).toHaveText(sourceName);
    await expect(page.getByRole("log")).toContainText(ownText);

    // Cancellation and offline destinations do not send anything.
    await page
      .locator(".message-row")
      .filter({ hasText: ownText })
      .getByRole("button", { name: "转发消息", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
    await expect(
      dialog.getByRole("button", { name: `选择 ${sourceName}`, exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole("button", { name: `选择 ${targetName}`, exact: true })
      .click();
    await dialog
      .getByRole("textbox", { name: "搜索转发联系人", exact: true })
      .fill("没有这个联系人");
    await expect(dialog).toContainText("没有找到匹配的联系人");
    await expect(
      dialog.getByRole("button", { name: "确认转发", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(recipient.getByRole("log")).not.toContainText(ownText);
    await forwardMessage(page, ownText, targetName);
    await expect(recipient.getByRole("log")).toContainText(ownText);

    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, contents] of [
      [fileName, file],
      [imageName, image],
    ] as const) {
      await forwardMessage(page, name, targetName);
      const button = recipient.getByRole("button", {
        name: `下载 ${name}`,
        exact: true,
      });
      await expect(button).toBeEnabled();
      const downloading = recipient.waitForEvent("download");
      await button.click();
      const downloaded = await downloading;
      expect(downloaded.suggestedFilename()).toBe(name);
      expect(await readFile((await downloaded.path())!)).toEqual(contents);
    }
    await expect(
      recipient.getByRole("img", { name: imageName, exact: true }),
    ).toHaveJSProperty("naturalWidth", 1);
    const forwardedIds = await recipient
      .locator(".message-row")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-message-id")),
      );
    expect(forwardedIds).toHaveLength(4);
    expect(forwardedIds.every((id) => !sourceIds.includes(id))).toBe(true);
    expect(
      await page
        .locator(".message-row")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-message-id")),
        ),
    ).toEqual(sourceIds);
    await recipient.reload();
    await openPeer(recipient, relayName);
    await expect(recipient.getByRole("log")).toContainText(text);
    await expect(
      recipient.getByRole("img", { name: imageName, exact: true }),
    ).toHaveJSProperty("naturalWidth", 1);
    for (const content of [text, ownText, fileName, imageName]) {
      expect(sockets.some((frame) => frame.includes(content))).toBe(false);
    }
    expect(errors).toEqual([]);
  } finally {
    await senderContext.close();
    await recipientContext.close();
  }
});
