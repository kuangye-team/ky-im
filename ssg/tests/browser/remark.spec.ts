import { expect, test } from "@playwright/test";
import {
  capture,
  closeContact,
  contactDetails,
  openContact,
  openPeer,
  setPeerRemark,
  setProfile,
} from "./helpers";

test("联系人备注可修改、搜索和清除，并在刷新、对方改名及离线后保留", async ({
  page,
  browser,
  baseURL,
}) => {
  const peerContext = await browser.newContext({ locale: "zh-CN" });
  const peer = await peerContext.newPage();
  const unique = Date.now().toString(36);
  const originalName = `备注对端-${unique}`;
  const updatedName = `对端新名字-${unique}`;
  const remark = `设计同事-${unique}`;
  const updatedRemark = `项目伙伴-${unique}`;
  const offlineRemark = `离线伙伴-${unique}`;
  const heading = page.locator(".chat-heading h2");
  const contact = contactDetails(page);
  const remarkInput = contact.getByRole("textbox", {
    name: "备注名称",
    exact: true,
  });
  const search = page.getByRole("textbox", {
    name: "搜索联系人",
    exact: true,
  });

  try {
    await page.goto("/");
    await setProfile(page, `备注测试-${unique}`);
    await peer.goto(baseURL!);
    await setProfile(peer, originalName);
    await openPeer(page, originalName);
    await openContact(page);

    await contact
      .getByRole("button", { name: "设置备注", exact: true })
      .click();
    await expect(remarkInput).toHaveValue("");
    await expect(remarkInput).toHaveAttribute("maxlength", "32");
    await remarkInput.fill(remark);
    await contact
      .getByRole("button", { name: "保存备注", exact: true })
      .click();
    await expect(remarkInput).toBeHidden();
    await expect(heading).toHaveText(remark);
    await expect(contact.locator(".contact-profile h2")).toHaveText(remark);
    await expect(
      contact.getByText(`原名：${originalName}`, { exact: true }),
    ).toBeVisible();
    await closeContact(page);
    await expect(
      page.getByRole("button", { name: `与 ${remark} 聊天`, exact: true }),
    ).toBeVisible();
    await openContact(page);

    await contact
      .getByRole("button", { name: "修改备注", exact: true })
      .click();
    await expect(remarkInput).toHaveValue(remark);
    await capture(page, "desktop-remark.png");
    await remarkInput.fill("取消的备注");
    await contact.getByRole("button", { name: "取消", exact: true }).click();
    await expect(remarkInput).toBeHidden();
    await expect(heading).toHaveText(remark);
    await setPeerRemark(contact, updatedRemark);
    await expect(heading).toHaveText(updatedRemark);
    await closeContact(page);

    for (const query of [updatedRemark, originalName]) {
      await search.fill(query);
      await expect(
        page.getByRole("button", {
          name: `与 ${updatedRemark} 聊天`,
          exact: true,
        }),
      ).toBeVisible();
    }
    await search.fill(`没有匹配-${unique}`);
    await expect(
      page.getByText("没有找到联系人", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();

    await page.getByRole("button", { name: "在线设备", exact: true }).click();
    const device = page.locator(".device-card").filter({
      has: page.getByRole("heading", { name: updatedRemark, exact: true }),
    });
    await expect(device).toBeVisible();
    await device.click();
    await expect(heading).toHaveText(updatedRemark);

    // A local alias must not change the other browser's own shared profile.
    await peer.getByRole("button", { name: "个人资料", exact: true }).click();
    await expect(peer.getByLabel("显示名称", { exact: false })).toHaveValue(
      originalName,
    );
    await peer.getByRole("button", { name: "取消", exact: true }).click();
    await page.reload();
    await openPeer(page, updatedRemark);
    await expect(heading).toHaveText(updatedRemark);
    await openContact(page);
    await expect(
      contact.getByText(`原名：${originalName}`, { exact: true }),
    ).toBeVisible();

    await setProfile(peer, updatedName);
    await expect(
      contact.getByText(`原名：${updatedName}`, { exact: true }),
    ).toBeVisible();
    await expect(heading).toHaveText(updatedRemark);
    await closeContact(page);
    await search.fill(updatedName);
    await expect(
      page.getByRole("button", {
        name: `与 ${updatedRemark} 聊天`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();

    await peerContext.close();
    await expect(page.locator(".chat-heading")).toContainText("离线");
    await openContact(page);
    await setPeerRemark(contact, offlineRemark);
    await expect(heading).toHaveText(offlineRemark);
    await page.reload();
    await openPeer(page, offlineRemark);
    await expect(heading).toHaveText(offlineRemark);
    await openContact(page);
    await expect(
      contact.getByText(`原名：${updatedName}`, { exact: true }),
    ).toBeVisible();

    await setPeerRemark(contact, "");
    await expect(heading).toHaveText(updatedName);
    await expect(contact.locator(".contact-profile h2")).toHaveText(
      updatedName,
    );
    await expect(
      contact.getByText(`原名：${updatedName}`, { exact: true }),
    ).toHaveCount(0);
    await expect(
      contact.getByRole("button", { name: "设置备注", exact: true }),
    ).toBeVisible();
    await page.reload();
    await openPeer(page, updatedName);
    await expect(heading).toHaveText(updatedName);
    await openContact(page);
    await expect(
      contact.getByRole("button", { name: "设置备注", exact: true }),
    ).toBeVisible();
  } finally {
    await peerContext.close();
  }
});
