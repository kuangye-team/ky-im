import { expect, test, type Page } from "@playwright/test";
import { capture, expectNoHorizontalOverflow } from "./helpers";

async function chooseLanguage(
  page: Page,
  option: "English" | "中文" | "System" | "系统",
) {
  await page
    .getByRole("button", { name: /^(Language|语言)$/, exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
}

const entryScript = /\/(?:src\/main\.tsx|assets\/index-[^/]+\.js)(?:\?.*)?$/;

test.describe("语言与首屏", () => {
  test.use({ locale: "en-US" });

  test("跟随系统、手动切换和刷新持久化", async ({ page }) => {
    await page.goto("/");
    const selector = page.getByRole("button", {
      name: "Language",
      exact: true,
    });
    await expect(selector).toHaveText("System");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle("Chats · Hummingbird");
    await expect(
      page.getByRole("button", { name: "Your profile", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#boot-loading")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await chooseLanguage(page, "中文");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(
      page.getByRole("button", { name: "个人资料", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "语言", exact: true }),
    ).toHaveText("中文");
    await expect(page).toHaveTitle("聊天消息 · 蜂鸟");
    await chooseLanguage(page, "English");
    await expect(
      page.getByRole("button", { name: "Your profile", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle("Chats · Hummingbird");
    await chooseLanguage(page, "System");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        value: "zh-TW",
      });
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        value: ["zh-TW"],
      });
      window.dispatchEvent(new Event("languagechange"));
    });
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(
      page.getByRole("button", { name: "语言", exact: true }),
    ).toHaveText("系统");
    await chooseLanguage(page, "English");
    await page.evaluate(() =>
      window.dispatchEvent(new Event("languagechange")),
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("移动端英文弹窗和导航不溢出", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Language", exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect
      .poll(() =>
        page
          .locator(".my-profile > strong")
          .evaluate((element) => getComputedStyle(element, "::before").content),
      )
      .toBe('"Me"');
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByLabel("Display name", { exact: false }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await chooseLanguage(page, "中文");
    await expectNoHorizontalOverflow(page);
  });

  test("语言菜单支持键盘选择、选中状态和移动端布局", async ({ page }) => {
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "Language", exact: true });
    await trigger.click();
    await expect(
      page.getByRole("menuitemradio", { name: "System", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await capture(page, "language-menu-desktop.png");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitemradio", { name: "中文", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "语言", exact: true }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "中文", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    const bounds = await page.getByRole("menu").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    await expectNoHorizontalOverflow(page);
    await capture(page, "language-menu-mobile.png");
    await page.keyboard.press("Escape");
  });

  test("昵称和介绍按当前语言生成，保存和取消保留正确资料", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    const name = page.locator("#profile-name");
    const bio = page.locator("#profile-bio");
    await expect(name).toHaveValue(/^[A-Za-z ]+ \d{2}$/);
    await expect(bio).toHaveValue(/^[A-Za-z]/);
    const initialName = await name.inputValue();
    const initialBio = await bio.inputValue();
    await page
      .getByRole("button", { name: "Generate an introduction", exact: true })
      .click();
    await expect(bio).not.toHaveValue(initialBio);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await chooseLanguage(page, "中文");
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    await expect(name).toHaveValue(initialName);
    await expect(bio).toHaveValue(initialBio);
    await page
      .getByRole("button", { name: "随机生成昵称", exact: true })
      .click();
    await page
      .getByRole("button", { name: "随机生成介绍", exact: true })
      .click();
    await expect(name).toHaveValue(/^[\u4e00-\u9fff]+ \d{2}$/);
    await expect(bio).toHaveValue(/^[\u4e00-\u9fff]/);
    const savedName = await name.inputValue();
    const savedBio = await bio.inputValue();
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoHorizontalOverflow(page);
    await capture(page, "profile-generator-mobile.png");
    await page.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.reload();
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    await expect(name).toHaveValue(savedName);
    await expect(bio).toHaveValue(savedBio);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await chooseLanguage(page, "English");
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Generate a nickname", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Generate an introduction", exact: true })
      .click();
    await expect(name).toHaveValue(/^[A-Za-z ]+ \d{2}$/);
    await expect(bio).toHaveValue(/^[A-Za-z]/);
    await name.fill("My own name");
    await bio.fill("My own introduction");
    await page
      .getByRole("button", { name: "Save profile", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await chooseLanguage(page, "中文");
    await page.getByRole("button", { name: "个人资料", exact: true }).click();
    await expect(name).toHaveValue("My own name");
    await expect(bio).toHaveValue("My own introduction");
  });

  test("首屏 loading 无需应用脚本和外部样式，并在初始化后移除", async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(entryScript, async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/", { waitUntil: "commit" });
    try {
      const loading = page.locator("#boot-loading");
      await expect(loading).toBeVisible();
      await expect(page.locator("#boot-reload")).toBeHidden();
      await expect(page.locator("#boot-message")).toHaveText(
        "Opening Hummingbird…",
      );
      await expect(loading.locator(".boot-orbit")).toHaveCSS(
        "animation-name",
        "boot-spin",
      );
      await expect(page.locator("#root")).toHaveAttribute("aria-busy", "true");
      await expect(page.locator("#root")).toHaveAttribute("inert", "");
      await expect(page.locator("#boot-brand")).toHaveText("Hummingbird");
      await expect(loading).toHaveCSS("background-image", /radial-gradient/);
      await capture(page, "loading-desktop.png");
      await page.setViewportSize({ width: 375, height: 812 });
      await expectNoHorizontalOverflow(page);
      await capture(page, "loading-mobile.png");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(loading.locator(".boot-orbit")).toHaveCSS(
        "animation-name",
        "none",
      );
    } finally {
      release();
    }
    await expect(page.locator("#boot-loading")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Your profile", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#root")).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  });

  test("记住的中文设置也用于脚本下载前的 loading", async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem("hummingbird.language", "zh-CN"),
    );
    await page.route(entryScript, (route) =>
      route.fulfill({ contentType: "application/javascript", body: "" }),
    );
    await page.goto("/");
    await expect(page.locator("#boot-message")).toHaveText("正在打开蜂鸟…");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  });

  test("入口下载失败显示可重试状态", async ({ page }) => {
    await page.route(entryScript, (route) => route.abort());
    await page.goto("/");
    await expect(page.locator("#boot-message")).toHaveText(
      "The page could not load. Check your connection and try again.",
    );
    await expect(
      page.getByRole("button", { name: "Reload", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".boot-orbit")).toBeHidden();
  });

  test("存储失败退出 loading 并显示英文恢复操作", async ({ page }) => {
    await page.addInitScript(() => {
      indexedDB.open = () => {
        throw new Error("Storage unavailable");
      };
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Unable to open Hummingbird" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reload", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#boot-loading")).toHaveCount(0);
  });

  test("localStorage 受限时仍能切换语言", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("Blocked", "SecurityError");
        },
      });
    });
    await page.goto("/");
    await chooseLanguage(page, "中文");
    await expect(
      page.getByRole("button", { name: "个人资料", exact: true }),
    ).toBeVisible();
  });
});
