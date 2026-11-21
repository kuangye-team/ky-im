import { expect, test } from "@playwright/test";
import { openPeer, sendText, setProfile } from "./helpers";

test("离线联系人可以继续输入和发送，并保留失败记录", async ({ browser, baseURL }) => {
  const aContext = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 980 } });
  const bContext = await browser.newContext({ locale: "zh-CN" });
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  try {
    await a.goto(baseURL!);
    await setProfile(a, "离线发送方");
    await b.goto(baseURL!);
    await setProfile(b, "离线联系人");
    await openPeer(a, "离线联系人");
    await sendText(a, "离线前的消息");
    await expect(a.getByRole("log").getByText("已送达", { exact: true })).toBeVisible();
    await bContext.close();
    // Closing a browser can leave its RTC connection alive until the liveness deadline.
    await expect(a.locator(".composer-presence-hint")).toHaveText("对方不在线，可能接收不到消息", { timeout: 45_000 });
    await expect(a.getByText("对方不在线，可能接收不到消息", { exact: true })).toHaveCount(1);
    await expect(a.getByRole("textbox", { name: "消息内容", exact: true })).toHaveAttribute("placeholder", "分享点什么，让对话发生…");
    await a.screenshot({ path: "../temp/screenshot/im-offline-single-hint.png", animations: "disabled" });
    await expect(a.getByRole("textbox", { name: "消息内容", exact: true })).toBeEnabled();
    for (const name of ["发送图片", "发送文件", "发送文件夹"])
      await expect(a.getByRole("button", { name, exact: true })).toBeEnabled();
    await a.getByRole("textbox", { name: "消息内容", exact: true }).fill("仍然尝试发送");
    await expect(a.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await a.screenshot({ path: "../temp/screenshot/im-offline-send-desktop.png", animations: "disabled" });
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: "../temp/screenshot/im-offline-send-mobile.png", animations: "disabled" });
    await a.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(a.getByRole("log")).toContainText("仍然尝试发送");
    await expect(a.locator(".message-row").filter({ hasText: "仍然尝试发送" })).toContainText("发送失败");
    await a.reload();
    await expect(a.locator(".chat-heading h2")).toHaveText("离线联系人");
    await expect(a.getByRole("log")).toContainText("仍然尝试发送");
  } finally {
    await aContext.close();
    await bContext.close();
  }
});
