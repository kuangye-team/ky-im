import { expect, test } from "@playwright/test";
import { capture, expectNoHorizontalOverflow } from "./helpers";

test("状态菜单支持键盘切换、保存离线选择和从个人资料恢复在线", async ({
  page,
}) => {
  await page.goto("/");
  const trigger = page
    .locator(".topbar")
    .getByRole("button", { name: "我的状态", exact: true });
  await expect(trigger.locator(".availability-value")).toHaveText("在线");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const online = page.getByRole("menuitemradio", { name: "在线", exact: true });
  const offline = page.getByRole("menuitemradio", {
    name: "离线",
    exact: true,
  });
  await expect(online).toHaveAttribute("aria-checked", "true");
  await expect(online).toBeFocused();
  await capture(page, "desktop-status-dropdown.png");
  await page.keyboard.press("ArrowDown");
  await expect(offline).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger.locator(".availability-value")).toHaveText("离线");

  await page.reload();
  await expect(trigger).toHaveAttribute("data-availability", "offline");
  await expect(trigger.locator(".availability-value")).toHaveText("离线");
  await page.getByRole("button", { name: "个人资料", exact: true }).click();
  const profile = page.getByRole("dialog", {
    name: "让朋友认识你",
    exact: true,
  });
  const profileTrigger = profile.getByRole("button", {
    name: "我的状态",
    exact: true,
  });
  await profileTrigger.click();
  await expect(offline).toHaveAttribute("aria-checked", "true");
  await online.click();
  await expect(profile).toBeVisible();
  await expect(profileTrigger.locator(".availability-value")).toHaveText(
    "在线",
  );
  await profile.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(trigger.locator(".availability-value")).toHaveText("在线");
});

test("手机宽度下状态菜单完整显示，关闭菜单保留选择", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const trigger = page
    .locator(".topbar")
    .getByRole("button", { name: "我的状态", exact: true });
  await expect(trigger.locator(".availability-value")).toHaveText("在线");
  await trigger.click();
  const menu = page.getByRole("menu", { name: "我的状态", exact: true });
  await expect(menu).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await capture(page, "mobile-status-dropdown.png");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveAttribute("data-availability", "online");
  await expect(trigger).toBeFocused();
});
