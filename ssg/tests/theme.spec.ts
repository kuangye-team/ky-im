import { expect, test } from "@playwright/test";
import { capture, expectNoHorizontalOverflow } from "./helpers";

test("四种主题即时应用、覆盖弹窗与页面，并在刷新后保留", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "切换主题", exact: true });
  await expect(page.locator(".sidebar-bottom")).toHaveCSS(
    "border-top-width",
    "0px",
  );
  const palettes = [
    {
      name: "晴空蓝",
      id: "sky",
      surface: "rgb(255, 255, 255)",
      primary: "rgb(75, 97, 238)",
    },
    {
      name: "松间绿",
      id: "forest",
      surface: "rgb(255, 255, 255)",
      primary: "rgb(40, 124, 103)",
    },
    {
      name: "落日杏",
      id: "sunset",
      surface: "rgb(255, 253, 250)",
      primary: "rgb(182, 93, 60)",
    },
    {
      name: "静夜紫",
      id: "night",
      surface: "rgb(34, 36, 49)",
      primary: "rgb(169, 154, 250)",
    },
  ];
  for (const palette of palettes) {
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "换一种心情" });
    await expect(dialog.locator(".theme-card")).toHaveCount(4);
    const option = dialog.getByRole("button", {
      name: palette.name,
      exact: true,
    });
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "true");
    await expect(
      dialog.locator('.theme-card[aria-pressed="true"]'),
    ).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      palette.id,
    );
    await expect(dialog).toHaveCSS("background-color", palette.surface);
    await expect(page.locator(".conversation-list")).toHaveCSS(
      "background-color",
      palette.surface,
    );
    await expect(dialog.getByRole("status")).toHaveText(
      `正在使用 ${palette.name}`,
    );
    await capture(page, `theme-picker-${palette.id}.png`);
    await dialog.getByRole("button", { name: "就用这个", exact: true }).click();
    await expect(trigger).toHaveText(palette.name);
    await expect(trigger).toBeFocused();
    await expect(page.locator(".main-nav .active")).toHaveCSS(
      "background-color",
      palette.primary,
    );
    await capture(page, `theme-${palette.id}-desktop.png`);
  }
  await page.reload();
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText("静夜紫");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.getByRole("button", { name: "存储管理", exact: true }).click();
  await expect(page.locator(".workspace")).toHaveCSS(
    "background-color",
    "rgb(34, 36, 49)",
  );
  await capture(page, "theme-night-storage.png");
  await page.getByRole("button", { name: "个人资料", exact: true }).click();
  await expect(page.locator(".form-input").first()).toHaveCSS(
    "background-color",
    "rgb(38, 40, 54)",
  );
  await capture(page, "theme-night-profile.png");
});

test("主题弹窗支持键盘、关闭后焦点恢复，以及中英文小屏布局", async ({
  page,
}) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "切换主题", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "松间绿", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator(".modal-overlay").click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();

  for (const language of ["zh-CN", "en"]) {
    if (language === "en") {
      await page.getByRole("button", { name: "语言", exact: true }).click();
      await page
        .getByRole("menuitemradio", { name: "English", exact: true })
        .click();
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator(".theme-trigger > span")).toBeVisible();
    await expect(page.locator(".theme-trigger")).toHaveText(
      language === "en" ? "Quiet Night" : "松间绿",
    );
    await expectNoHorizontalOverflow(page);
    await page
      .getByRole("button", {
        name: language === "en" ? "Change theme" : "切换主题",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".theme-card")).toHaveCount(4);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(812);
    await expectNoHorizontalOverflow(page);
    await capture(page, `theme-picker-mobile-${language}.png`);
    await page.setViewportSize({ width: 360, height: 640 });
    await expectNoHorizontalOverflow(page);
    await dialog
      .getByRole("button", {
        name: language === "en" ? "Quiet Night" : "静夜紫",
        exact: true,
      })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
    expect(
      await dialog.evaluate(
        (element) => element.scrollHeight <= element.clientHeight + 1,
      ),
    ).toBe(true);
    await capture(page, `theme-picker-small-${language}.png`);
    await page.keyboard.press("Escape");
  }
});

test("保存的主题在应用加载前生效，未知偏好和受限存储不阻止使用", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "切换主题", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => localStorage.setItem("hummingbird.theme", "night"));
  await page.route("**/src/main.tsx", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.reload();
  await expect(page.locator("#boot-loading")).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/icons/night/favicon.svg");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await expect(page.locator("#boot-loading")).toHaveCSS(
    "background-color",
    "rgb(34, 36, 49)",
  );
  await capture(page, "theme-night-loading.png");
  await page.unroute("**/src/main.tsx");
  await page.evaluate(() =>
    localStorage.setItem("hummingbird.theme", "unknown"),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "切换主题", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sky");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/icons/sky/favicon.svg");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.getByRole("button", { name: "落日杏", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sunset");
});
