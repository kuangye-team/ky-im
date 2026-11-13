import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  openPeer,
  sendText,
  setProfile,
} from "./helpers";

test("通道打开后可以聊天，两个入口支持筛选、导出和保留日志", async ({
  browser,
  baseURL,
}) => {
  const aContext = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 980 },
  });
  const bContext = await browser.newContext({ locale: "zh-CN" });
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  const errors: string[] = [];
  a.on("pageerror", (error) => errors.push(error.message));
  try {
    await a.goto(baseURL!);
    await setProfile(a, "日志测试 Mac");
    await b.goto(baseURL!);
    await setProfile(b, "日志测试 Windows");
    await openPeer(a, "日志测试 Windows");
    await expect(
      a.getByText("在线 · 可以聊天了", { exact: true }),
    ).toBeVisible();
    await openPeer(b, "日志测试 Mac");
    await expect(
      b.getByText("在线 · 可以聊天了", { exact: true }),
    ).toBeVisible();
    const content = "不应出现在日志里的聊天正文";
    await sendText(a, content);
    await expect(b.getByRole("log").getByText(content)).toBeVisible();
    await expect(
      a.getByRole("log").getByText("已送达", { exact: true }),
    ).toBeVisible();
    await a.getByRole("button", { name: "查看连接日志", exact: true }).click();
    const dialog = a.getByRole("dialog", { name: "运行日志", exact: true });
    await expect(
      dialog.getByRole("button", { name: "与 日志测试 Windows 的连接" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      dialog.getByText("通道已打开", { exact: true }),
    ).toBeVisible();
    await expect(dialog).not.toContainText(content);
    const source = dialog.locator(".log-source").first();
    await expect(source).not.toHaveAttribute("open");
    await source.locator("summary").click();
    await expect(source).toHaveAttribute("open", "");
    await expect(source.locator("pre")).toContainText('"source"');
    await expect(source.locator("pre")).toContainText('"event"');
    await a.screenshot({
      path: "../temp/screenshot/runtime-source-log.png",
      animations: "disabled",
    });
    await source.locator("summary").click();
    await a.screenshot({
      path: "../temp/screenshot/chat-connection-logs.png",
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "类别", exact: true }).click();
    await a
      .getByRole("menuitemradio", { name: "存活检查", exact: true })
      .click();
    await expect(
      dialog.getByText("对方已响应", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      dialog.getByText("通道已打开", { exact: true }),
    ).toHaveCount(0);
    const downloaded = a.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "导出筛选结果", exact: true })
      .click();
    const download = await downloaded;
    const exported = JSON.parse(
      await readFile((await download.path())!, "utf8"),
    );
    expect(exported.length).toBeGreaterThan(0);
    expect(
      exported.every(
        (entry: { category: string }) => entry.category === "heartbeat",
      ),
    ).toBe(true);
    expect(JSON.stringify(exported)).not.toContain(content);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await a.getByRole("button", { name: "系统配置", exact: true }).click();
    await a.getByRole("button", { name: "运行日志", exact: true }).click();
    await expect(
      dialog.getByText("应用已启动", { exact: true }).first(),
    ).toBeVisible();
    await dialog
      .getByRole("textbox", { name: "搜索运行日志" })
      .fill("没有这样的日志");
    await expect(dialog.getByText("暂无符合条件的日志")).toBeVisible();
    await dialog.getByRole("textbox", { name: "搜索运行日志" }).fill("");
    await dialog.getByRole("button", { name: "级别", exact: true }).click();
    await a.getByRole("menuitemradio", { name: "一般", exact: true }).click();
    await dialog.getByRole("button", { name: "时间", exact: true }).click();
    await a
      .getByRole("menuitemradio", { name: "最近 10 分钟", exact: true })
      .click();
    await a.screenshot({
      path: "../temp/screenshot/settings-runtime-logs.png",
      animations: "disabled",
    });
    await a.reload();
    await a.getByRole("button", { name: "运行日志", exact: true }).click();
    await dialog
      .getByRole("textbox", { name: "搜索运行日志" })
      .fill("对方已确认收到");
    await expect(
      dialog.getByText("对方已确认收到", { exact: true }),
    ).toBeVisible();
    await a.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(a);
    await a.screenshot({
      path: "../temp/screenshot/runtime-logs-mobile.png",
      animations: "disabled",
    });
    await dialog
      .getByRole("button", { name: "清空运行日志", exact: true })
      .click();
    await dialog.getByRole("button", { name: "确认清空", exact: true }).click();
    await expect(dialog.getByText("暂无符合条件的日志")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("连续三个周期未确认存活后离线，无 pong 也能通过消息确认恢复", async ({
  browser,
  baseURL,
}) => {
  const aContext = await browser.newContext({ locale: "zh-CN" });
  const bContext = await browser.newContext({ locale: "zh-CN" });
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  await b.addInitScript(() => {
    (window as unknown as { dropPong: boolean }).dropPong = true;
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (
      data: string | ArrayBuffer | ArrayBufferView | Blob,
    ) {
      if (
        (window as unknown as { dropPong?: boolean }).dropPong &&
        typeof data === "string" &&
        ["peer-ping", "peer-pong"].includes(JSON.parse(data).type)
      )
        return;
      return send.call(this, data as ArrayBuffer);
    };
  });
  try {
    await a.goto(baseURL!);
    await setProfile(a, "恢复测试 Mac");
    await b.goto(baseURL!);
    await setProfile(b, "恢复测试 Windows");
    await openPeer(a, "恢复测试 Windows");
    await expect(
      a.getByText("在线 · 可以聊天了", { exact: true }),
    ).toBeVisible();
    // Assert completed cycles, rather than the transient reconnect label.
    await expect.poll(() => a.evaluate(() =>
      JSON.parse(localStorage.getItem("hummingbird.runtime-logs") || "[]")
        .filter((entry: { message: string }) => entry.message === "暂未收到对方响应")
        .map((entry: { raw: string }) => JSON.parse(entry.raw).diagnostic.missedCycles),
    ), { timeout: 40_000 }).toEqual([1, 2, 3]);
    await expect(a.locator(".composer-presence-hint")).toHaveText(
      "对方不在线，可能接收不到消息",
      { timeout: 30_000 },
    );
    const contact = a.getByRole("button", { name: "与 恢复测试 Windows 聊天", exact: true });
    await expect(contact.locator(".avatar > i")).not.toHaveClass("online");
    await a.screenshot({
      path: "../temp/screenshot/connection-three-cycles-offline.png",
      animations: "disabled",
    });
    // Continue suppressing ping/pong: a real delivery acknowledgement must restore presence.
    await openPeer(b, "恢复测试 Mac");
    await sendText(a, "离线提示下继续发送");
    await expect(
      b.getByRole("log").getByText("离线提示下继续发送", { exact: true }),
    ).toBeVisible();
    await expect(
      a.getByRole("log").getByText("已送达", { exact: true }),
    ).toBeVisible();
    await expect(a.getByText("在线 · 可以聊天了", { exact: true })).toBeVisible();
    await expect(contact.locator(".avatar > i")).toHaveClass("online");
    await expect(a.locator(".composer-presence-hint")).toHaveCount(0);
    await a.screenshot({
      path: "../temp/screenshot/connection-message-confirmed-online.png",
      animations: "disabled",
    });
  } finally {
    for (const [name, page] of [["sender", a], ["receiver", b]] as const)
      await test.info().attach(`${name}-runtime.json`, {
        body: await page.evaluate(() => localStorage.getItem("hummingbird.runtime-logs") || "[]"),
        contentType: "application/json",
      });
    await aContext.close();
    await bContext.close();
  }
});
