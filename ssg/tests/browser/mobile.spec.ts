import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  capture,
  expectNoHorizontalOverflow,
  openPeer,
  sendText,
  selectContactAction,
  setPeerRemark,
  setProfile,
} from "./helpers";

test("手机上资料弹窗、设备列表和聊天输入均可使用且不横向溢出", async ({
  page,
  browser,
  baseURL,
}) => {
  const peerContext = await browser.newContext({ locale: "zh-CN" });
  const peer = await peerContext.newPage();
  const name = `手机对端-${Date.now().toString(36)}`;
  try {
    await page.goto("/");
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "在线设备", exact: true }).click();
    await page.getByRole("button", { name: "邀请朋友", exact: true }).click();
    const invite = page.getByRole("dialog", {
      name: "邀请朋友",
      exact: true,
    });
    await expect(invite.getByLabel("我的蜂鸟号", { exact: true })).toHaveText(
      /^[1-9][0-9]{5}$/,
    );
    await invite.getByLabel("朋友的蜂鸟号", { exact: true }).fill("12345");
    await expect(
      invite.getByRole("button", { name: "连接", exact: true }),
    ).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    await capture(page, "mobile-invite.png");
    await invite.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "聊天消息", exact: true }).click();
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    const profile = page.getByRole("dialog", {
      name: "让朋友认识你",
      exact: true,
    });
    await page.getByLabel("显示名称", { exact: false }).fill("手机测试设备");
    await page.getByLabel("个性签名", { exact: false }).fill("移动端检查");
    await expect(profile.locator(".profile-identity")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, "mobile-profile-identity.png");
    await profile
      .getByRole("button", { name: "保存资料", exact: true })
      .click();
    await expect(profile).toBeHidden();
    await peer.goto(baseURL!);
    await setProfile(peer, name);
    await expect(
      page.getByRole("button", { name: `与 ${name} 聊天`, exact: true }),
    ).toBeVisible();
    await capture(page, "mobile-list.png");
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
    await page
      .getByRole("button", { name: "查看联系人资料", exact: true })
      .click();
    const contact = page.getByRole("dialog", {
      name: "联系人资料",
      exact: true,
    });
    await expect(contact).toBeVisible();
    await setPeerRemark(contact, "手机上的朋友");
    await expect(contact.locator(".contact-profile h2")).toHaveText(
      "手机上的朋友",
    );
    await expect(
      contact.getByText(`原名：${name}`, { exact: true }),
    ).toBeVisible();
    await contact
      .getByRole("button", { name: "修改备注", exact: true })
      .click();
    await capture(page, "mobile-remark.png");
    await contact.getByRole("button", { name: "取消", exact: true }).click();
    const remark = "MobileRemark".padEnd(32, "x");
    await setPeerRemark(contact, remark);
    await expect(contact.locator(".contact-profile h2")).toHaveText(remark);
    await expectNoHorizontalOverflow(page);
    const downloadPromise = page.waitForEvent("download");
    await selectContactAction(page, "导出文字记录");
    const exported = await downloadPromise;
    const data = JSON.parse(await readFile((await exported.path())!, "utf8"));
    expect(
      data.messages.map((message: { text?: string }) => message.text),
    ).toEqual(
      expect.arrayContaining(["手机端文字发送成功", "手机端文字接收成功"]),
    );
    await capture(page, "mobile-contact.png");
    await contact.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator(".chat-heading h2")).toHaveText(remark);
    await expectNoHorizontalOverflow(page);
    await page
      .getByRole("button", { name: "查看联系人资料", exact: true })
      .click();
    const peerNumber = (await contact
      .locator(".contact-number b")
      .textContent())!;
    await contact
      .getByRole("button", { name: "连接此分组", exact: true })
      .click();
    const editNumber = page.getByRole("dialog", {
      name: "邀请朋友",
      exact: true,
    });
    await expect(
      editNumber.getByLabel("朋友的蜂鸟号", { exact: true }),
    ).toHaveValue(peerNumber);
    await expectNoHorizontalOverflow(page);
    await editNumber
      .getByRole("button", { name: "连接", exact: true })
      .click();
    await expect(editNumber).toBeHidden();
    await expect(page.locator(".device-grid")).toBeVisible();
    await expect(
      page.locator(".device-card").filter({ hasText: remark }),
    ).toBeVisible();
    await page.locator(".device-card").filter({ hasText: remark }).click();
    await expect(page.locator(".chat-heading h2")).toHaveText(remark);
    await expect(page.getByRole("log")).toContainText("手机端文字发送成功");
    await page.getByRole("button", { name: "返回列表", exact: true }).click();
    await expect(
      page.getByRole("button", { name: `与 ${remark} 聊天`, exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    await peerContext.close();
  }
});
