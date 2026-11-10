import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  enableAutoAcceptFiles,
  expectNoHorizontalOverflow,
  openPeer,
  sendText,
  setProfile,
} from "../browser/helpers";
const screenshots = resolve(import.meta.dirname, "../../../temp/screenshot");
async function enableRelay(page: Page) {
  await page.goto("/settings");
  const relay = page.getByRole("checkbox", {
    name: "启用服务器 1 的中转",
    exact: true,
  });
  await expect(relay).toBeDisabled();
  await page.getByRole("button", { name: "测试服务器 1", exact: true }).click();
  await expect(
    page.getByText("连接成功 · 支持中转", { exact: true }),
  ).toBeVisible();
  await expect(relay).toBeEnabled();
  await relay.check();
  await expect(relay).toBeChecked();
  await expect(page.getByRole("status")).toHaveText("设置已生效。");
}

test("测试服务器能力并限制中转开关，地址变更后重新测试", async ({ page }) => {
  await enableRelay(page);
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "启用服务器 1 的中转", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("服务器名称", { exact: true }).fill("仅帮助连接");
  await dialog
    .getByLabel("服务器地址", { exact: true })
    .fill(
      `ws://127.0.0.1:${Number(process.env.PLAYWRIGHT_RELAY_DISABLED_PORT || Number(process.env.PLAYWRIGHT_API_PORT || 4311) + 2)}/api/ws`,
    );
  await dialog.getByLabel("启用", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: "测试服务器 2", exact: true }).click();
  await expect(
    page.getByText("连接成功 · 不支持中转", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "启用服务器 2 的中转", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: resolve(screenshots, "relay-settings-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.locator(".settings-server-list").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshots, "relay-settings-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "编辑服务器 2", exact: true }).click();
  await dialog
    .getByLabel("服务器地址", { exact: true })
    .fill("ws://127.0.0.1:9/api/ws");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText("连接成功 · 不支持中转", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "测试服务器 2", exact: true }).click();
  await expect(
    page.getByText("连接失败，请检查服务器地址或稍后重试", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "启用服务器 2 的中转", exact: true }),
  ).toBeDisabled();
});

test("直连无法建立时中转文字和文件，正常直连不走中转", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const aContext = await browser.newContext({ locale: "zh-CN", baseURL });
  const bContext = await browser.newContext({ locale: "zh-CN", baseURL });
  const a = await aContext.newPage(),
    b = await bContext.newPage();
  const frames: { type: string; data?: { kind: string; binary?: boolean; payload?: string } }[] = [];
  const errors: string[] = [];
  for (const page of [a, b]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        try {
          frames.push(JSON.parse(String(payload)));
        } catch {
          /* Native control frames. */
        }
      }),
    );
  }
  try {
    await enableRelay(a);
    await enableRelay(b);
    await a.goto("/");
    await b.goto("/");
    await setProfile(a, "中转发送端");
    await setProfile(b, "中转接收端");
    await openPeer(a, "中转接收端");
    await openPeer(b, "中转发送端");
    await sendText(a, "优先通过直连发送");
    await expect(
      b.getByText("优先通过直连发送", { exact: true }),
    ).toBeVisible();
    expect(frames.filter((frame) => frame.type === "relay")).toEqual([]);
    // With no TURN servers, relay-only ICE prevents a direct WebRTC channel.
    for (const context of [aContext, bContext])
      await context.addInitScript(() => {
        const Original = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
          constructor(config?: RTCConfiguration) {
            super({ ...config, iceServers: [], iceTransportPolicy: "relay" });
          }
        };
      });
    await a.reload();
    await b.reload();
    await openPeer(a, "中转接收端");
    await openPeer(b, "中转发送端");
    await sendText(a, "直连失败后的中转消息");
    await expect(
      b.getByText("直连失败后的中转消息", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await sendText(b, "中转回复");
    await expect(a.getByText("中转回复", { exact: true })).toBeVisible();
    await enableAutoAcceptFiles(b);
    const payload = Buffer.alloc(5 * 1024 * 1024 + 17);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await a
      .getByLabel("选择文件", { exact: true })
      .setInputFiles({
        name: "relay-content.bin",
        mimeType: "application/octet-stream",
        buffer: payload,
      });
    const file = b.getByRole("button", {
      name: "下载 relay-content.bin",
      exact: true,
    });
    await expect(file).toBeVisible();
    const downloadPromise = b.waitForEvent("download");
    await file.click();
    const download = await downloadPromise;
    expect(await readFile((await download.path())!)).toEqual(payload);
    const binary = frames.filter(
      (frame) => frame.type === "relay" && frame.data?.kind === "data" && frame.data.binary,
    );
    expect(binary.map((frame) => Buffer.from(frame.data!.payload!, "base64").length))
      .toEqual([...Array(40).fill(128 * 1024 + 44), 17 + 44]);
    expect(errors).toEqual([]);
    await b.screenshot({
      path: resolve(screenshots, "relay-transfer.png"),
      fullPage: true,
    });
  } finally {
    await aContext.close();
    await bContext.close();
  }
});
