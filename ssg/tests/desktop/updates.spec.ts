import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

async function act(page: Page, action: "progress" | "completeDownload" | "completeInstall" | "fail" | "language", args: unknown[] = []) {
  await page.evaluate(async ({ action, args }) => {
    // @ts-expect-error Vite serves the test harness directly.
    const harness = await import("/tests/desktop/updates-harness.tsx");
    await harness[action](...args);
  }, { action, args });
}
async function calls(page: Page) {
  return page.evaluate(async () => {
    // @ts-expect-error Vite serves the test harness directly.
    return (await import("/tests/desktop/updates-harness.tsx")).calls as string[];
  });
}
test.beforeEach(async ({ page }) => { await page.goto("/tests/desktop/updates.html"); });

test("下载展示百分比与蒙层，取消后恢复操作且可重试", async ({ page }) => {
  await page.getByRole("button", { name: "更新并重启", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "正在更新蜂鸟" });
  await act(page, "progress", [100 * 1024 * 1024, 37 * 1024 * 1024]);
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
  await expect(dialog).toContainText("37%");
  await expect(dialog).toContainText("37.0 MB / 100.0 MB");
  await expect(page.locator(".desktop-update-overlay")).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: resolve("../temp/screenshot/desktop-update-progress.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "取消更新" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("textbox", { name: "消息内容" }).fill("取消后继续使用");
  expect(await calls(page)).not.toContain("install_update");
  expect(await calls(page)).not.toContain("plugin:process|restart");
  expect(await calls(page)).toContain("plugin:resources|close");
  await page.getByRole("button", { name: "更新并重启", exact: true }).click();
  await act(page, "completeDownload");
  await expect(dialog).toContainText("正在安装更新…");
  await expect(dialog).toContainText("100%");
  await expect(dialog.getByRole("button", { name: "取消更新" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await act(page, "completeInstall");
  await expect(dialog).toContainText("正在重启蜂鸟…");
  await expect.poll(() => calls(page)).toContain("plugin:process|restart");
});

test("从关于窗口更新可取消并返回原窗口，未知大小与英文布局正常", async ({ page }) => {
  await page.getByRole("button", { name: "稍后", exact: true }).click();
  await page.getByRole("button", { name: "关于蜂鸟", exact: true }).click();
  await page.getByRole("dialog", { name: "关于蜂鸟" }).getByRole("button", { name: "更新并重启" }).click();
  await act(page, "progress", [null, 5242880]);
  const dialog = page.getByRole("dialog", { name: "正在更新蜂鸟" });
  await expect(dialog).toContainText("5.0 MB");
  await expect(dialog.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  await page.setViewportSize({ width: 800, height: 600 });
  await act(page, "language", ["en"]);
  const english = page.getByRole("dialog", { name: "Updating Hummingbird" });
  await expect(english).toBeVisible();
  await expect(english).toHaveCSS("z-index", "91");
  await expect(page.locator(".desktop-update-overlay")).toHaveCSS("z-index", "90");
  await page.screenshot({ path: resolve("../temp/screenshot/desktop-update-about-english.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(english).toBeHidden();
  const about = page.getByRole("dialog", { name: "关于蜂鸟" });
  await expect(about).toBeVisible();
  await expect(about.getByRole("button", { name: "Update and restart" })).toBeFocused();
  await about.getByRole("button", { name: "Update and restart" }).click();
  await act(page, "fail");
  await expect(english).toBeHidden();
  await expect(about.getByRole("alert")).toBeVisible();
});
