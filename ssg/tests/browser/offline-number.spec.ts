import { expect, test } from "@playwright/test";

for (const offline of [true, false]) {
  test(`首次打开即有蜂鸟号，离线刷新和重新打开后保留（${offline ? "主动离线" : "服务器不可用"}）`, async ({ page }) => {
    await page.routeWebSocket("**/api/ws", (socket) => socket.close());
    if (offline)
      await page.addInitScript(() => localStorage.setItem("hummingbird.availability", "offline"));
    await page.goto("/");
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "让朋友认识你", exact: true });
    const number = dialog.getByLabel("我的蜂鸟号", { exact: true });
    await expect(number).toHaveText(/^[1-9][0-9]{5}$/);
    const original = await number.textContent();
    await expect(dialog.getByRole("button", { name: "复制我的蜂鸟号", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "刷新我的蜂鸟号", exact: true }).click();
    await expect(number).not.toHaveText(original!);
    const refreshed = await number.textContent();
    await page.screenshot({ path: `../temp/screenshot/device-number-${offline ? "offline" : "no-server"}.png`, animations: "disabled" });
    await page.reload();
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    await expect(page.getByLabel("我的蜂鸟号", { exact: true })).toHaveText(refreshed!);
  });
}
