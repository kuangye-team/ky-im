import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

async function requestClose(page: Page) {
  await page.evaluate(async () => {
    const mock = await import("./tests/desktop/close-window-mocks.ts");
    await mock.requestClose();
  });
}

function actions(page: Page) {
  return page.evaluate(async () => (await import("./tests/desktop/close-window-mocks.ts")).actions);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.addInitScript(() => {
    localStorage.setItem("hummingbird.theme", "forest");
    localStorage.setItem("hummingbird.language", "zh-CN");
  });
  // Install Tauri's mock before the desktop entry mounts its real window listener.
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: 'import "/tests/desktop/close-window-mocks.ts";\n' + await response.text() });
  });
});

test("关闭请求可取消、重复打开和隐藏，操作失败后可重试", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" });
    Object.defineProperty(navigator, "userAgentData", { value: { platform: "macOS" } });
  });
  await page.goto("/");
  const theme = page.getByRole("button", { name: "切换主题", exact: true });
  await theme.focus();
  await requestClose(page);
  await requestClose(page);
  const dialog = page.getByRole("dialog", { name: "关闭窗口？" });
  await expect(dialog).toHaveCount(1);
  const hide = dialog.getByRole("button", { name: /^隐藏窗口/ });
  await expect(hide).toBeFocused();
  await expect(hide).toContainText("再次打开蜂鸟");
  await page.screenshot({ path: resolve("../temp/screenshot/desktop-close-macos-preview.png"), animations: "disabled" });
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  await page.mouse.click(12, 12);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(theme).toBeFocused();
  await theme.click();
  await requestClose(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("dialog", { name: "换一种心情" })).toBeVisible();
  expect(await actions(page)).toEqual([]);
  await requestClose(page);
  await page.evaluate(async () => (await import("./tests/desktop/close-window-mocks.ts")).failNextHide());
  await hide.click();
  await expect(dialog.getByRole("alert")).toContainText("暂时无法隐藏窗口");
  await hide.click();
  await expect(dialog).toBeHidden();
  await requestClose(page);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(await actions(page)).toEqual(["plugin:window|hide", "plugin:window|hide"]);
});

test("Windows 显示通知区域提示，只有确认退出才结束应用", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "Win32" });
    Object.defineProperty(navigator, "userAgentData", { value: { platform: "Windows" } });
  });
  await page.goto("/");
  await expect(page.locator("#boot-loading")).toBeHidden();
  await requestClose(page);
  const chinese = page.getByRole("dialog", { name: "关闭窗口？" });
  await expect(chinese).toContainText("任务栏通知区域");
  await page.screenshot({ path: resolve("../temp/screenshot/desktop-close-windows-preview.png"), animations: "disabled" });
  await page.evaluate(async () => (await import("./src/i18n.ts")).setLanguagePreference("en"));
  await page.setViewportSize({ width: 800, height: 600 });
  const dialog = page.getByRole("dialog", { name: "Close this window?" });
  await expect(dialog).toContainText("in the system tray");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await actions(page)).toEqual([]);
  await requestClose(page);
  await dialog.getByRole("button", { name: /^Quit app/ }).click();
  await expect(dialog).toBeHidden();
  expect(await actions(page)).toEqual(["plugin:process|exit"]);
});
