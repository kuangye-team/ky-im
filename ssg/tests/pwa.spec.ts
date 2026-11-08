import { expect, type Page } from "@playwright/test";
import { test } from "./pwa-release-server";
import { capture } from "./helpers";
import { THEME_CONFIG } from "../src/theme-config";

async function openApp(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "切换主题", exact: true }),
  ).toBeVisible();
}

test("生产清单、安装图标和浏览器安装检查有效", async ({ page }) => {
  await openApp(page);
  const session = await page.context().newCDPSession(page);
  const manifest = await session.send("Page.getAppManifest");
  expect(manifest.errors).toEqual([]);
  const data = JSON.parse(manifest.data!);
  expect(data).toMatchObject({
    id: "/",
    scope: "/",
    start_url: "/",
    display: "standalone",
  });
  expect(data.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", type: "image/png" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]),
  );
  for (const icon of data.icons) {
    const dimensions = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return `${img.naturalWidth}x${img.naturalHeight}`;
    }, icon.src);
    if (icon.sizes !== "any") expect(dimensions).toBe(icon.sizes);
  }
  const { installabilityErrors } = await session.send(
    "Page.getInstallabilityErrors",
  );
  // Playwright's isolated contexts are incognito and cannot actually install.
  expect(
    installabilityErrors.filter((error) => error.errorId !== "in-incognito"),
  ).toEqual([]);
});

test("四种 SVG 配色即时切换并在刷新后保留", async ({ page }) => {
  await openApp(page);
  for (const theme of THEME_CONFIG.options) {
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await page.getByRole("button", { name: theme.name, exact: true }).click();
    await page.getByRole("button", { name: "就用这个", exact: true }).click();
    const href = `/icons/${theme.id}/favicon.svg`;
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      "href",
      href,
    );
    const response = await page.request.get(href);
    expect(response.headers()["content-type"]).toContain("image/svg+xml");
    expect(await response.text()).toContain(
      `color="${theme.colors["--primary"]}"`,
    );
    await capture(page, `pwa-theme-${theme.id}.png`);
  }
  await page.reload();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/icons/night/favicon.svg",
  );
});

test("离线可重新打开应用和主题图标，信令接口不回退到页面", async ({
  page,
  context,
}) => {
  await openApp(page);
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() => undefined),
  );
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "切换主题", exact: true }),
  ).toBeVisible();
  const assets = await page.evaluate(async () => {
    const cached = await fetch("/icons/forest/favicon.svg");
    const cacheNames = await caches.keys();
    const urls = (
      await Promise.all(
        cacheNames.map(async (name) =>
          (await (await caches.open(name)).keys()).map(
            (request) => request.url,
          ),
        ),
      )
    ).flat();
    let apiAvailable = false;
    try {
      apiAvailable = (await fetch("/api/health")).ok;
    } catch {
      /* Network only. */
    }
    return { icon: await cached.text(), urls, apiAvailable };
  });
  expect(assets.icon).toContain('color="#287c67"');
  expect(assets.apiAvailable).toBe(false);
  expect(
    assets.urls.some((url) => new URL(url).pathname.startsWith("/api/")),
  ).toBe(false);
  await capture(page, "pwa-offline.png");
});
