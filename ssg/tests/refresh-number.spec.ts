import { expect, test } from "@playwright/test";
import {
  capture,
  expectNoHorizontalOverflow,
  openPeer,
  sendText,
  setProfile,
} from "./helpers";

test("刷新蜂鸟号同步同组设备、保留未保存资料和聊天，重新打开后仍使用新号", async ({
  browser,
  page,
}) => {
  const otherContext = await browser.newContext({ locale: "zh-CN" });
  const other = await otherContext.newPage();
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/");
    await other.goto("/");
    await setProfile(page, "换号测试甲");
    await setProfile(other, "换号测试乙");
    await openPeer(page, "换号测试乙");
    await sendText(page, "换号前的聊天记录");
    await expect(
      page.locator(".text-bubble").filter({ hasText: "换号前的聊天记录" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    await other.getByRole("button", { name: "个人资料", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "让朋友认识你",
      exact: true,
    });
    const number = dialog.getByLabel("我的蜂鸟号", { exact: true });
    const previous = (await number.textContent())!;
    await expect(other.getByLabel("我的蜂鸟号", { exact: true })).toHaveText(
      previous,
    );
    await dialog.locator("#profile-name").fill("尚未保存的新昵称");
    await dialog.locator("#profile-bio").fill("换号不能清空这段草稿");
    await dialog.getByRole("button", { name: "头像 🐼", exact: true }).click();
    await dialog
      .getByRole("button", { name: "刷新我的蜂鸟号", exact: true })
      .click();
    await expect(number).not.toHaveText(previous);
    await expect(number).toHaveText(/^[1-9][0-9]{5}$/);
    const refreshed = (await number.textContent())!;
    await expect(other.getByLabel("我的蜂鸟号", { exact: true })).toHaveText(
      refreshed,
    );
    await expect(dialog.locator("#profile-name")).toHaveValue(
      "尚未保存的新昵称",
    );
    await expect(dialog.locator("#profile-bio")).toHaveValue(
      "换号不能清空这段草稿",
    );
    await expect(
      dialog.getByRole("button", { name: "头像 🐼", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    ).toBe(true);
    await capture(page, "profile-wide-refresh.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await capture(page, "profile-mobile-refresh.png");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await other.getByRole("button", { name: "取消", exact: true }).click();
    await page.setViewportSize({ width: 1366, height: 768 });
    await sendText(page, "换号后继续聊天");
    await openPeer(other, "换号测试甲");
    await expect(
      other.getByText("换号前的聊天记录", { exact: true }),
    ).toBeVisible();
    await expect(
      other.getByText("换号后继续聊天", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "在线设备", exact: true }).click();
    await page.getByRole("button", { name: "邀请朋友", exact: true }).click();
    const invite = page.getByRole("dialog", { name: "邀请朋友", exact: true });
    await expect(invite.getByLabel("我的蜂鸟号", { exact: true })).toHaveText(
      refreshed,
    );
    await invite
      .getByRole("button", { name: "刷新我的蜂鸟号", exact: true })
      .click();
    await expect(
      invite.getByLabel("我的蜂鸟号", { exact: true }),
    ).not.toHaveText(refreshed);
  } finally {
    await otherContext.close();
  }
});
