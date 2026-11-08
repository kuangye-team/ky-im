import { expect, test } from "@playwright/test";
import { capture } from "./helpers";

type CopyProbe = Window & {
  __copiedNumbers: string[];
  __fallbackInDialog: boolean[];
};

for (const mode of ["clipboard", "unavailable", "denied"] as const) {
  test(`我的蜂鸟号可在资料与邀请朋友中复制（${mode}）`, async ({ page }) => {
    // Intercept both copy paths so tests never replace the user's clipboard.
    await page.addInitScript((copyMode) => {
      const state = window as CopyProbe;
      state.__copiedNumbers = [];
      state.__fallbackInDialog = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value:
          copyMode === "unavailable"
            ? undefined
            : {
                writeText: async (value: string) => {
                  if (copyMode === "denied") {
                    throw new DOMException(
                      "Clipboard permission denied",
                      "NotAllowedError",
                    );
                  }
                  state.__copiedNumbers.push(value);
                },
              },
      });
      document.execCommand = (command: string) => {
        if (command !== "copy") return false;
        const field = document.activeElement;
        if (!(field instanceof HTMLTextAreaElement)) return false;
        state.__copiedNumbers.push(field.value);
        state.__fallbackInDialog.push(!!field.closest('[role="dialog"]'));
        return true;
      };
    }, mode);
    await page.goto("/");
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    const profile = page.getByRole("dialog", {
      name: "让朋友认识你",
      exact: true,
    });
    await expect(profile.locator(".profile-identity")).toBeVisible();
    await capture(page, "desktop-profile-identity.png");
    const number = profile.getByLabel("我的蜂鸟号", { exact: true });
    await expect(number).toHaveText(/^[1-9][0-9]{5}$/);
    const expectedNumber = (await number.textContent())!;
    const profileCopy = profile.getByRole("button", {
      name: "复制我的蜂鸟号",
      exact: true,
    });
    await profileCopy.click();
    await expect
      .poll(() => page.evaluate(() => (window as CopyProbe).__copiedNumbers))
      .toEqual([expectedNumber]);
    await expect(profile).toBeVisible();
    await expect(profileCopy).toBeFocused();
    await expect(page.locator('.toast[role="status"]')).toContainText("已复制");
    await profile.getByRole("button", { name: "取消", exact: true }).click();

    await page.getByRole("button", { name: "在线设备", exact: true }).click();
    await page.getByRole("button", { name: "邀请朋友", exact: true }).click();
    const connect = page.getByRole("dialog", {
      name: "邀请朋友",
      exact: true,
    });
    await expect(connect.getByLabel("我的蜂鸟号", { exact: true })).toHaveText(
      expectedNumber,
    );
    const connectCopy = connect.getByRole("button", {
      name: "复制我的蜂鸟号",
      exact: true,
    });
    await connectCopy.click();
    await expect
      .poll(() => page.evaluate(() => (window as CopyProbe).__copiedNumbers))
      .toEqual([expectedNumber, expectedNumber]);
    await expect(connectCopy).toBeFocused();
    await expect(connect).toBeVisible();
    expect(
      await page.evaluate(() => (window as CopyProbe).__fallbackInDialog),
    ).toEqual(mode === "clipboard" ? [] : [true, true]);
    await connect
      .getByRole("button", { name: "复制邀请地址", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as CopyProbe).__copiedNumbers))
      .toEqual([expectedNumber, expectedNumber, new URL(page.url()).origin]);
    await expect(connect.getByLabel("访问地址", { exact: true })).toHaveValue(
      new URL(page.url()).origin,
    );
    expect(
      await page.evaluate(() => (window as CopyProbe).__fallbackInDialog),
    ).toEqual(mode === "clipboard" ? [] : [true, true, true]);
    if (mode === "clipboard") await capture(page, "desktop-copy-number.png");
  });
}
