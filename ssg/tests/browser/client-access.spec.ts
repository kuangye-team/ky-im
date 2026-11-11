import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

const manifest = {
  version: "1.2.3",
  platforms: {
    "darwin-aarch64": { url: "https://example.com/ky-im-macos-universal.app.tar.gz" },
    "windows-x86_64": { url: "https://example.com/ky-im-windows-x64-setup.exe" },
  },
};

test("客户端入口按系统推荐下载，悬浮区可进入，键盘与关闭行为正常", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "Win32" });
    Object.defineProperty(navigator, "userAgentData", { value: { platform: "Windows" } });
  });
  let requests = 0;
  await page.route("**/api/latest", (route) => { requests++; return route.fulfill({ json: manifest }); });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "打开客户端", exact: true });
  const panel = page.getByRole("dialog", { name: "下载蜂鸟客户端" });
  await expect(trigger).toBeVisible();
  expect(requests).toBe(0);
  await trigger.hover();
  await expect(panel.getByText("v1.2.3")).toBeVisible();
  const windows = panel.getByRole("link", { name: /Windows 10/ });
  await expect(windows).toHaveClass(/recommended/);
  await expect(windows.locator("small")).toHaveText("Windows 10 / 11");
  await expect(panel.getByRole("link", { name: "查看所有下载" })).toHaveAttribute("href", "https://github.com/kuangye-team/ky-im/releases/latest");
  await expect(windows).toHaveAttribute("href", /setup\.exe$/);
  await expect(panel.getByRole("link", { name: /macOS/ })).toHaveAttribute("href", /universal\.dmg$/);
  await windows.hover();
  await page.waitForTimeout(250);
  await expect(panel).toBeVisible();
  await page.screenshot({ path: "../temp/screenshot/client-access-windows.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await trigger.focus();
  await expect(panel).toBeVisible();
  await trigger.press("ArrowDown");
  await expect(windows).toBeFocused();
  await page.getByRole("button", { name: "关于本站", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("dialog", { name: "关于蜂鸟" })).toBeVisible();
  expect(requests).toBe(1);
});

test("下载失败可重试，手机可点击查看下载且不会横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "iPhone" });
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" });
  });
  let requests = 0;
  await page.route("**/api/latest", (route) => ++requests === 1 ? route.fulfill({ status: 503 }) : route.fulfill({ json: manifest }));
  await page.goto("/");
  await page.getByRole("button", { name: "打开客户端", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "下载蜂鸟客户端" });
  await expect(panel.getByRole("alert")).toContainText("下载地址暂时无法获取");
  await panel.getByRole("button", { name: "重试", exact: true }).click();
  await expect(panel.getByText("v1.2.3")).toBeVisible();
  await expect(panel.getByText("适合此设备")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "../temp/screenshot/client-access-mobile.png", fullPage: true });
});
