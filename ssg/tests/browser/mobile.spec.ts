import { devices, expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  capture,
  expectInviteQrMatchesAddress,
  expectNoHorizontalOverflow,
  expectPeerNumberCopy,
  openPeer,
  sendText,
  setPeerRemark,
  setProfile,
} from "./helpers";

test("手机资料页、聊天操作、设备列表和聊天输入均可使用且不横向溢出", async ({
  page,
  browser,
  baseURL,
}) => {
  const peerContext = await browser.newContext({ ...devices["Desktop Chrome"], locale: "zh-CN", isMobile: false, hasTouch: false });
  const peer = await peerContext.newPage();
  const name = `手机对端-${Date.now().toString(36)}`;
  try {
    await page.goto("/");
    await expectNoHorizontalOverflow(page);
    await expect(page.locator(".phone-tabs a")).toHaveCount(3);
    const inviteButton = page.getByRole("button", { name: "邀请朋友", exact: true });
    const clientButton = page.getByRole("button", { name: "打开客户端", exact: true });
    await expect(clientButton).toHaveText("");
    const iconBackground = await inviteButton.evaluate(button => getComputedStyle(button).backgroundColor);
    await expect(clientButton).toHaveCSS("background-color", iconBackground);
    expect(iconBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect((await clientButton.boundingBox())!.x).toBeLessThan((await inviteButton.boundingBox())!.x);
    await expect(inviteButton).toHaveText("");
    await inviteButton.click();
    const invite = page.getByRole("dialog", {
      name: "邀请朋友",
      exact: true,
    });
    await expect(invite.getByLabel("我的蜂鸟号", { exact: true })).toHaveText(
      /^[1-9][0-9]{5}$/,
    );
    await expectInviteQrMatchesAddress(invite);
    const numberBox = (await invite.getByLabel("我的蜂鸟号", { exact: true }).boundingBox())!;
    const copyBox = (await invite.getByRole("button", { name: "复制我的蜂鸟号" }).boundingBox())!;
    expect(copyBox.x).toBeGreaterThanOrEqual(numberBox.x + numberBox.width);
    expect(Math.abs(copyBox.y + copyBox.height / 2 - numberBox.y - numberBox.height / 2)).toBeLessThan(1);
    await capture(page, "mobile-invite.png");
    await page.goBack();
    await expect(invite).toBeHidden();
    await expect(page.getByRole("heading", { name: "消息", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "设备", exact: true }).click();
    await inviteButton.click();
    await expect(invite).toBeVisible();
    await page.goBack();
    await expect(invite).toBeHidden();
    await page.getByRole("button", { name: "输入蜂鸟号" }).click();
    const number = page.getByRole("dialog", { name: "输入蜂鸟号" });
    await expect(number).toBeVisible();
    const geometry = await number.evaluate(el => {
      const box = el.getBoundingClientRect();
      const viewport = window.visualViewport!;
      return { inset: box.left, offset: Math.abs(box.top + box.height / 2 - viewport.offsetTop - viewport.height / 2) };
    });
    expect(geometry.inset).toBeGreaterThanOrEqual(15);
    expect(geometry.offset).toBeLessThan(1);
    await capture(page, "mobile-enter-number.png");
    await number.getByLabel("朋友的蜂鸟号", { exact: true }).fill("12345");
    await expect(
      number.getByRole("button", { name: "连接", exact: true }),
    ).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    await number.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("link", { name: "我的", exact: true }).click();
    await expect(clientButton).toHaveCount(0);
    await page.getByRole("link", { name: "个人资料", exact: true }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const profile = page.locator(".profile-page");
    await page.getByLabel("显示名称", { exact: false }).fill("手机测试设备");
    await page.getByLabel("个性签名", { exact: false }).fill("移动端检查");
    await expect(profile.locator(".profile-identity")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const footer = profile.locator(".modal-actions");
    await expect(footer.getByRole("button", { name: "取消", exact: true }).locator("svg")).toBeVisible();
    await expect(footer.getByRole("button", { name: "保存", exact: true }).locator("svg")).toBeVisible();
    const cancelBounds = (await footer.getByRole("button", { name: "取消" }).boundingBox())!;
    const saveBounds = (await footer.getByRole("button", { name: "保存", exact: true }).boundingBox())!;
    expect(Math.abs(cancelBounds.width - saveBounds.width)).toBeLessThan(1);
    expect(cancelBounds.y).toBe(saveBounds.y);
    await expect(footer).toHaveCSS("border-top-width", "0px");
    await footer.scrollIntoViewIfNeeded();
    await capture(page, "mobile-profile-identity.png");
    await profile
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(profile).toBeHidden();
    await page.getByRole("link", { name: "设备", exact: true }).click();
    await peer.goto(baseURL!);
    await setProfile(peer, name);
    await expect(
      page.getByRole("button", { name: `与 ${name} 聊天`, exact: true }),
    ).toBeVisible();
    await capture(page, "mobile-list.png");
    await page.getByRole("link", { name: "消息", exact: true }).click();
    const discovered = page.getByRole("button", { name: `与 ${name} 聊天`, exact: true });
    await expect(discovered).toBeVisible();
    await expect(discovered.locator("time")).toHaveCount(0);
    await capture(page, "mobile-messages-discovery.png");
    await openPeer(page, name);
    await expectNoHorizontalOverflow(page);
    await openPeer(peer, "手机测试设备");
    await sendText(page, "手机端文字发送成功");
    await expect(
      peer.getByText("手机端文字发送成功", { exact: true }).last(),
    ).toBeVisible();
    await sendText(peer, "手机端文字接收成功");
    await expect(
      page.getByText("手机端文字接收成功", { exact: true }).last(),
    ).toBeVisible();
    const composer = await page
      .getByRole("textbox", { name: "消息内容", exact: true })
      .boundingBox();
    expect(composer).not.toBeNull();
    expect(composer!.x).toBeGreaterThanOrEqual(0);
    expect(composer!.x + composer!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    await expectNoHorizontalOverflow(page);
    await capture(page, "mobile-chat.png");
    const more = page.getByRole("button", { name: "聊天操作", exact: true });
    await more.click();
    const actions = page.getByRole("dialog", { name: "聊天操作" });
    await setPeerRemark(actions, "手机上的朋友");
    const autoAccept = actions.getByRole("switch", { name: "自动接收文件" });
    await autoAccept.click();
    await expect(autoAccept).toBeChecked();
    await actions.getByRole("button", { name: "修改备注", exact: true }).click();
    await capture(page, "mobile-remark.png");
    await actions.getByRole("button", { name: "取消", exact: true }).click();
    const remark = "MobileRemark".padEnd(32, "x");
    await setPeerRemark(actions, remark);
    await expect(actions.locator(".phone-sheet-actions button > svg.lucide-chevron-right:last-child")).toHaveCount(5);
    await capture(page, "mobile-chat-actions.png");
    await expectPeerNumberCopy(page, actions);
    await actions.getByRole("button", { name: "查看聊天文件" }).click();
    await expect(page).toHaveURL(/\/files\?chat=/);
    await page.reload();
    await expect(page.locator(".phone-backbar h1")).toHaveText("聊天文件");
    await expect(page.locator(".chat-files-page")).toContainText("分享的文件会出现在这里");
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.getByRole("button", { name: "查看联系人资料", exact: true }).click();
    await expect(page.locator(".contact-profile h2")).toHaveText(remark);
    await expect(page.getByText(`原名：${name}`, { exact: true })).toBeVisible();
    await capture(page, "mobile-contact.png");
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await more.click();
    const downloadPromise = page.waitForEvent("download");
    await actions.getByRole("button", { name: "导出文字记录" }).click();
    const exported = await downloadPromise;
    const data = JSON.parse(await readFile((await exported.path())!, "utf8"));
    expect(
      data.messages.map((message: { text?: string }) => message.text),
    ).toEqual(
      expect.arrayContaining(["手机端文字发送成功", "手机端文字接收成功"]),
    );
    await expect(page.locator(".chat-heading h2")).toHaveText(remark);
    await expectNoHorizontalOverflow(page);
    await more.click();
    await actions.getByRole("button", { name: "查看连接日志" }).click();
    await expect(page).toHaveURL(/\/logs\?chat=/);
    await page.reload();
    await expect(page.getByRole("button", { name: /与 .* 的连接/ })).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await more.click();
    await expect(autoAccept).toBeChecked();
    await autoAccept.click();
    await actions.getByRole("button", { name: "删除聊天记录" }).click();
    const remove = page.getByRole("dialog", { name: "删除这段聊天记录？" });
    await remove.getByRole("button", { name: "取消" }).click();
    await expect(remove).toBeHidden();
    await expect(page.locator(".chat-heading h2")).toHaveText(remark);
    await expect(page.getByRole("log")).toContainText("手机端文字发送成功");
    await page.getByRole("button", { name: "返回列表", exact: true }).click();
    await expect(
      page.getByRole("button", { name: `与 ${remark} 聊天`, exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "消息", exact: true }).click();
    await sendText(peer, "离开会话后的新消息");
    const row = page.getByRole("button", { name: `与 ${remark} 聊天`, exact: true });
    await expect(row).toHaveAccessibleDescription("在线");
    await expect(row.getByText("在线", { exact: true })).toBeVisible();
    await expect(row).toContainText("离开会话后的新消息");
    await expect(row.locator(".phone-peer-end b")).toHaveText("1");
    await row.click();
    await expect(page.locator(".phone-tabs")).toHaveCount(0);
    const box = page.getByRole("textbox", { name: "消息内容" });
    await box.fill("第一行");
    await box.press("Enter");
    await box.pressSequentially("second");
    await expect(box).toHaveValue("第一行\nsecond");
    await page.goBack();
    await expect(row).toContainText("草稿");
    await expect(row.locator(".phone-peer-end b")).toHaveCount(0);
    await row.click();
    await page.reload();
    await expect(box).toHaveValue("第一行\nsecond");
    await page.getByRole("button", { name: "添加内容" }).click();
    await expect(page.getByRole("button", { name: "发送文件", exact: true })).toBeVisible();
    await page.goBack();
    await expect(box).toBeVisible();
    await page.getByLabel("选择文件", { exact: true }).setInputFiles({ name: "手机附件.txt", mimeType: "text/plain", buffer: Buffer.from("mobile") });
    await peer.getByRole("button", { name: "接收", exact: true }).click();
    await expect(page.locator(".message-row").filter({ hasText: "手机附件.txt" })).toContainText("已送达");
    await more.click();
    await actions.getByRole("button", { name: "查看聊天文件" }).click();
    await expect(page.locator(".chat-files-page")).toContainText("手机附件.txt");
    await capture(page, "mobile-chat-files.png");
    await page.goBack();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "返回列表" }).click();
    await peer.getByRole("button", { name: "我的状态", exact: true }).click();
    await peer.getByRole("menuitemradio", { name: "离线", exact: true }).click();
    await expect(row).toHaveAccessibleDescription("离线");
    await expect(row.getByText("离线", { exact: true })).toBeVisible();
    await capture(page, "mobile-messages-presence.png");
    await row.click();
    await more.click();
    await actions.getByRole("button", { name: "删除聊天记录" }).click();
    await remove.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByRole("heading", { name: "消息", exact: true })).toBeVisible();
    await expect(row).toHaveCount(0);

  } finally {
    await peerContext.close();
  }
});

test("我的各二级页面使用居中标题和图标返回键", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/me");
  await expect(page.locator(".phone-head")).toHaveCount(0);
  const logs = page.getByRole("link", { name: "运行日志", exact: true });
  await expect(logs.locator("+ button")).toHaveAccessibleName("重置数据");
  await capture(page, "mobile-me.png");
  await logs.click();
  await expect(page).toHaveURL(/\/logs$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "搜索运行日志" })).toBeVisible();
  await page.getByRole("button", { name: "类别", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "设备连接", exact: true }).click();
  await expect(page.getByRole("button", { name: "类别", exact: true })).toHaveText("设备连接");
  await page.getByRole("button", { name: "日志选项" }).click();
  await page.getByRole("menuitem", { name: "清空运行日志" }).click();
  await expect(page.getByRole("alert")).toContainText("清空本机保留的全部运行日志");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await capture(page, "mobile-logs-page.png");
  await page.goBack();
  for (const title of ["个人资料", "聊天记录", "存储空间", "连接设置", "运行日志", "隐私协议", "开源许可"]) {
    await page.getByRole("link", { name: new RegExp("^" + title) }).click();
    const back = page.getByRole("button", { name: "返回我的" });
    const heading = page.locator(".phone-backbar").getByRole("heading", { name: title });
    await expect(back).toHaveText("");
    await expect(heading).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const box = (await heading.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 160)).toBeLessThan(1);
    expect((await back.boundingBox())!.x).toBeLessThan(box.x);
    await back.click();
    await expect(page).toHaveURL(/\/me$/);
  }
});

test("提示文字上方的滚轮仍能滚动我的页面", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/me");
  await page.getByRole("link", { name: "个人资料", exact: true }).click();
  await page.getByRole("button", { name: "保存" }).click();
  const text = page.locator(".toast > span");
  await expect(text).toHaveText("个人资料已更新");
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 250);
  await expect.poll(() => page.locator(".phone-workspace").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "关闭提示" }).click();
  await expect(text).toHaveCount(0);
});

test("iPad 窄分屏保留桌面导航，Android 平板和展开的折叠屏按窗口宽度切换", async ({ browser, baseURL }) => {
  for (const [device, options] of [
    ["ipad", devices["iPad (gen 7)"]],
    ["tablet", { userAgent: "Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit/537.36 Chrome/140 Safari/537.36", isMobile: true }],
    ["fold", { userAgent: "Mozilla/5.0 (Linux; Android 15; Fold) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36", isMobile: true }],
  ] as const) {
    const context = await browser.newContext({ ...options, hasTouch: true, locale: "zh-CN" });
    try {
      const page = await context.newPage();
      await page.goto(baseURL!);
      for (const width of [320, 680, 681, 900, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const phone = device !== "ipad" && width <= 680;
        await expect(page.locator("html")).toHaveAttribute("data-layout", phone ? "phone" : "desktop");
        await expect(page.locator(".phone-tabs a")).toHaveCount(phone ? 3 : 0);
        await expectNoHorizontalOverflow(page);
      }
      if (device === "ipad") {
        await page.getByRole("button", { name: "主导航" }).click();
        await page.getByRole("button", { name: "系统配置" }).click();
        await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
      }
    } finally { await context.close(); }
  }
});
