import { expect, type Page } from "@playwright/test";
import { test } from "./release-server";
import { capture, expectNoHorizontalOverflow } from "../browser/helpers";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() =>
    localStorage.setItem("hummingbird.availability", "offline"),
  );
});

async function openApp(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "个人资料", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() => undefined),
  );
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await expect(page.getByRole("region", { name: "网站更新" })).toBeHidden();
}
async function checkUpdate(page: Page) {
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect(page.getByRole("region", { name: "网站更新" })).toBeVisible();
}
test("真实新版就绪后显示顶部提示，点击后刷新到新版，草稿仍在", async ({
  page,
  releaseServer: server,
}) => {
  await openApp(page);
  await page.evaluate(async () => {
    // An existing conversation and draft, as they would be before a deployment.
    sessionStorage.setItem(
      "hummingbird.chat-drafts",
      JSON.stringify({ "pwa-peer": "这段文字更新后继续写" }),
    );
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("send-chat");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("conversations", "readwrite");
      tx.objectStore("conversations").put({
        peer: {
          id: "pwa-peer",
          name: "小林",
          bio: "",
          avatar: "🌿",
          color: "#287c67",
          device: "Mac",
          clientType: "web" as const,
        },
        unread: 0,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await page.getByRole("button", { name: "与 小林 聊天", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue(
    "这段文字更新后继续写",
  );
  server.deploy();
  await checkUpdate(page);
  await expect(page.locator("html")).toHaveAttribute("data-release", "1");
  await capture(page, "update-banner-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await expect(
    page.getByRole("button", { name: "更新并刷新" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("textbox", { name: "消息内容" }),
  ).toBeInViewport();
  await capture(page, "update-banner-mobile.png");
  await page.setViewportSize({ width: 360, height: 640 });
  await expectNoHorizontalOverflow(page);
  await expect(
    page.getByRole("button", { name: "更新并刷新" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("textbox", { name: "消息内容" }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.getByRole("button", { name: "静夜紫", exact: true }).click();
  await page.getByRole("button", { name: "就用这个", exact: true }).click();
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await expect(page.getByRole("region", { name: "App update" })).toContainText(
    "A new version of Hummingbird is ready",
  );
  await expectNoHorizontalOverflow(page);
  await expect(
    page.getByRole("button", { name: "Update and reload", exact: true }),
  ).toBeInViewport();
  await capture(page, "update-banner-small-english-night.png");
  await page.getByRole("button", { name: "Language", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "中文", exact: true })
    .click();
  await page.getByRole("button", { name: "更新并刷新" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-release", "2");
  await expect(page.getByRole("region", { name: "网站更新" })).toBeHidden();
  await page.getByRole("button", { name: "与 小林 聊天", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toHaveValue(
    "这段文字更新后继续写",
  );
});

test("稍后不刷新，同一版本不重复提示，下一版本再次提示", async ({ page, releaseServer: server }) => {
  await openApp(page);
  server.deploy();
  await checkUpdate(page);
  await page.getByRole("button", { name: "稍后", exact: true }).click();
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect(page.getByRole("region", { name: "网站更新" })).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-release", "1");
  server.deploy();
  await checkUpdate(page);
  await page.getByRole("button", { name: "更新并刷新" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-release", "3");
});

test("一个标签页更新不会刷新其他标签页，其他页可自行更新", async ({
  page,
  context,
  releaseServer: server,
}) => {
  await openApp(page);
  const other = await context.newPage();
  await openApp(other);
  server.deploy();
  await checkUpdate(page);
  await expect(other.getByRole("region", { name: "网站更新" })).toBeVisible();
  await page.getByRole("button", { name: "更新并刷新" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-release", "2");
  await expect(other.locator("html")).toHaveAttribute("data-release", "1");
  await other.getByRole("button", { name: "更新并刷新" }).click();
  await expect(other.locator("html")).toHaveAttribute("data-release", "2");
});
