import { pngIcons, themeIcons } from "virtual:app-icons";
import { THEME_CONFIG } from "./theme-config";

/** Installation metadata and PNGs travel with the entry bundle, including offline. */
export function initializeAppIcons() {
  if (import.meta.env.VITE_DESKTOP) return;

  const appleTouchIcon = document.createElement("link");
  appleTouchIcon.rel = "apple-touch-icon";
  appleTouchIcon.href = pngIcons.appleTouch;
  document.head.append(appleTouchIcon);

  // A data URL has no base path: resolve these against the site, including on deep links.
  const rootUrl = new URL("/", window.location.href).href;
  const manifest = {
    id: rootUrl,
    name: "蜂鸟 · Hummingbird",
    short_name: "蜂鸟",
    description: "轻快连接，自在分享。与身边的人聊天、分享照片和文件。",
    lang: "zh-CN",
    start_url: rootUrl,
    scope: rootUrl,
    display: "standalone",
    theme_color: THEME_CONFIG.options[0].colors["--header-start"],
    background_color: THEME_CONFIG.options[0].colors["--page"],
    icons: [
      {
        src: themeIcons[THEME_CONFIG.defaultTheme].favicon,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      { src: pngIcons.app192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: pngIcons.app512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: pngIcons.appMaskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = `data:application/manifest+json,${encodeURIComponent(JSON.stringify(manifest))}`;
  document.head.append(link);
}
