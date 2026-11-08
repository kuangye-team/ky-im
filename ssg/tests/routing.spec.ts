import { expect, test } from "@playwright/test";
import { capture } from "./helpers";

test("路径支持直接打开和刷新", async ({ page }) => {
  for (const [path, heading, pageName] of [
    ["/", "消息", "聊天消息"],
    ["/nearby", "在线的朋友", "在线设备"],
    ["/history", "聊天记录", "聊天记录"],
    ["/storage", "存储管理", "存储管理"],
    ["/licenses", "开源许可", "开源许可"],
    ["/privacy", "隐私协议", "隐私协议"],
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: new RegExp(`^${heading}`) }))
      .toBeVisible();
    await expect(page).toHaveTitle(`${pageName} · 蜂鸟`);
    await page.reload();
    await expect(page.getByRole("heading", { name: new RegExp(`^${heading}`) }))
      .toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    expect(new URL(page.url()).hash).toBe("");
    await expect(page).toHaveTitle(`${pageName} · 蜂鸟`);
  }
});

test("站内链接保留当前页面会话，支持前进后退与返回聊天", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".conversation-list")).toBeVisible();
  // This marker disappears if a link reloads the document and reconnects chat.
  await page.evaluate(() => {
    document.documentElement.dataset.navigationProbe = "active";
  });
  await page.getByRole("link", { name: "隐私协议", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page).toHaveTitle("隐私协议 · 蜂鸟");
  await expect(page.getByRole("heading", { name: "隐私协议", exact: true }))
    .toBeFocused();
  await capture(page, "privacy-clean-path.png");
  await page.getByRole("link", { name: "前往聊天记录", exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page).toHaveTitle("聊天记录 · 蜂鸟");
  await page.goBack();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page).toHaveTitle("隐私协议 · 蜂鸟");
  await page.goForward();
  await expect(page.getByRole("heading", { name: "聊天记录", exact: true }))
    .toBeVisible();
  await expect(page).toHaveTitle("聊天记录 · 蜂鸟");
  await page.getByRole("link", { name: "开源许可", exact: true }).click();
  await expect(page).toHaveURL(/\/licenses$/);
  await expect(page.locator(".license-card").first()).toBeVisible();
  await page.locator(".legal-endnote").click();
  await expect(page).toHaveURL(/\/privacy$/);
  await page.locator(".legal-endnote").click();
  await expect(page).toHaveURL(/\/licenses$/);
  await page.getByRole("link", { name: "返回聊天", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".conversation-list")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-navigation-probe", "active");
});
