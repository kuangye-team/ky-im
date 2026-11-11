import { expect, type Page } from "@playwright/test";
import { test } from "./release-server";
import { capture } from "../browser/helpers";
import { THEME_CONFIG } from "../../src/theme-config";

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
  expect(manifest.url).toMatch(/^data:application\/manifest\+json,/);
  const data = JSON.parse(manifest.data!);
  expect(data).toMatchObject({
    id: new URL("/", page.url()).href,
    scope: new URL("/", page.url()).href,
    start_url: new URL("/", page.url()).href,
    display: "standalone",
  });
  expect(data.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", type: "image/png" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]),
  );
  const appleTouch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  for (const icon of [...data.icons, { src: appleTouch, sizes: "180x180", type: "image/png" }]) {
    expect(icon.src).toMatch(icon.type === "image/png" ? /^data:image\/png;base64,/ : /^data:image\/svg\+xml,/);
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
    const icons = await readThemeIcons(page);
    expect(icons.favicon).toContain(`color="${theme.colors["--primary"]}"`);
    expect(icons.bird).toContain(`color="${theme.colors["--primary"]}"`);
    expect(icons.bird).not.toContain("<rect");
    await capture(page, `pwa-theme-${theme.id}.png`);
  }
  await page.reload();
  expect((await readThemeIcons(page)).favicon).toContain('color="#a99afa"');
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
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.getByRole("button", { name: "松间绿", exact: true }).click();
  await page.getByRole("button", { name: "就用这个", exact: true }).click();
  expect((await readThemeIcons(page)).favicon).toContain('color="#287c67"');
  const assets = await page.evaluate(async () => {
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
    return { urls, apiAvailable };
  });
  expect(assets.apiAvailable).toBe(false);
  expect(assets.urls.some((url) => /\/(?:icons\/|favicon\.svg|manifest\.webmanifest)/.test(new URL(url).pathname))).toBe(false);
  expect(
    assets.urls.some((url) => new URL(url).pathname.startsWith("/api/")),
  ).toBe(false);
  await capture(page, "pwa-offline.png");
});

async function readThemeIcons(page: Page) {
  return page.evaluate(async () => {
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href;
    const bird = document.documentElement.style.getPropertyValue("--brand-bird").slice(5, -2);
    const result: Record<string, string> = {};
    for (const [key, src] of Object.entries({ favicon, bird })) {
      if (!src.startsWith("data:image/svg+xml,")) throw new Error(`External ${key}: ${src}`);
      const image = new Image();
      image.src = src;
      await image.decode();
      result[key] = decodeURIComponent(src.slice(src.indexOf(",") + 1));
    }
    return result;
  });
}

test("首次加载和 PWA 预缓存不再请求独立图标，深链接保留安装根路径", async ({ page, context }) => {
  const requests: string[] = [];
  context.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(new URL(request.url()).pathname);
  });
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.goto("/history");
  await expect(page.getByRole("button", { name: "切换主题", exact: true })).toBeVisible();
  const session = await context.newCDPSession(page);
  const manifest = await session.send("Page.getAppManifest");
  expect(manifest.errors).toEqual([]);
  expect(JSON.parse(manifest.data!).start_url).toBe(new URL("/", page.url()).href);
  expect(requests.filter((path) => /\/(?:icons\/|favicon\.svg|manifest\.webmanifest)/.test(path))).toEqual([]);
});
