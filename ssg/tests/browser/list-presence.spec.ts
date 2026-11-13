import { expect, test } from "@playwright/test";
import { openPeer, sendText, setProfile } from "./helpers";

test("旧客户端无需 pong 也能聊天，首次静默重协商仍保持在线", async ({ browser, baseURL }) => {
  const aContext = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 980 } });
  const bContext = await browser.newContext({ locale: "zh-CN" });
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  const errors: string[] = [];
  a.on("pageerror", (error) => errors.push(error.message));
  b.on("pageerror", (error) => errors.push(error.message));
  await a.addInitScript(() => {
    const state = window as unknown as { connections: number };
    state.connections = 0;
    const Original = RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        super(config);
        state.connections++;
      }
    };
  });
  await b.addInitScript(() => {
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data: string | ArrayBuffer | ArrayBufferView | Blob) {
      if (typeof data === "string" && ["peer-ping", "peer-pong"].includes(JSON.parse(data).type)) return;
      return send.call(this, data as ArrayBuffer);
    };
  });
  try {
    await a.goto(baseURL!);
    await setProfile(a, "兼容测试 Mac");
    await b.goto(baseURL!);
    await setProfile(b, "旧版 Windows");
    const row = a.getByRole("button", { name: "与 旧版 Windows 聊天", exact: true });
    await expect(row.locator("time")).toHaveText("在线");
    // One missed cycle rebuilds the channel without crossing the three-cycle threshold.
    await expect.poll(() => a.evaluate(() => (window as unknown as { connections: number }).connections), { timeout: 35_000 }).toBeGreaterThan(1);
    await expect(row.locator("time")).toHaveText("在线");
    await expect(a.locator(".chat-heading")).toHaveCount(0);
    await openPeer(a, "旧版 Windows");
    await openPeer(b, "兼容测试 Mac");
    await sendText(a, "旧版没有 pong 也能收到");
    await expect(b.getByRole("log")).toContainText("旧版没有 pong 也能收到");
    await expect(a.getByRole("log").getByText("已送达", { exact: true })).toBeVisible();
    await sendText(b, "旧版回复");
    await expect(a.getByRole("log")).toContainText("旧版回复");
    await a.screenshot({ path: "../temp/screenshot/im-legacy-chat.png", animations: "disabled" });
    expect(errors).toEqual([]);
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

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
    await expect(a.locator(".composer-presence-hint")).toHaveText("对方不在线，可能接收不到消息");
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
    await openPeer(a, "离线联系人");
    await expect(a.getByRole("log")).toContainText("仍然尝试发送");
  } finally {
    await aContext.close();
    await bContext.close();
  }
});
