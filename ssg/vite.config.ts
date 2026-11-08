import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { LANGUAGE_CONFIG, LOADING_CONFIG } from "./src/config";
import { THEME_CONFIG } from "./src/theme-config";
import { minify } from "html-minifier-terser";
import { VitePWA } from "vite-plugin-pwa";
import { appIcons, brandSvg } from "./build/app-icons";

export default defineConfig(({ mode }) => {
  // 始终读取 ssg/.env*；进程变量优先。空前缀仅供构建配置读取，
  // 浏览器端仍只会获得 Vite 默认公开的 VITE_* 变量。
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, "");
  const port = Number(env.WEB_PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("WEB_PORT 必须是 1–65535 之间的整数");

  return {
    root,
    plugins: [
      react(),
      appIcons(),
      VitePWA({
        // The app prompts before activating an update or reloading an open window.
        registerType: "prompt",
        injectRegister: "auto",
        manifest: {
          id: "/",
          name: "蜂鸟 · Hummingbird",
          short_name: "蜂鸟",
          description: "轻快连接，自在分享。与身边的人聊天、分享照片和文件。",
          lang: "zh-CN",
          start_url: "/",
          scope: "/",
          display: "standalone",
          theme_color: THEME_CONFIG.options[0].colors["--header-start"],
          background_color: THEME_CONFIG.options[0].colors["--page"],
          icons: [
            {
              src: "/favicon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
            {
              src: "/icons/app-192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/app-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/app-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Control first-time visits too, while updated workers still wait for consent.
          clientsClaim: true,
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          navigateFallbackDenylist: [/^\/api(?:\/|$)/],
          // Only the application shell is cached; signaling stays on the network.
          runtimeCaching: [],
        },
      }),
      {
        name: "inline-loading-config",
        transformIndexHtml: {
          order: "pre",
          handler: (html) =>
            html
              .replace("__BOOT_BIRD__", () => brandSvg)
              .replace("__THEME_CONFIG__", () =>
                JSON.stringify(THEME_CONFIG).replace(/</g, "\\u003c"),
              )
              .replace(
                "/* __BOOT_THEME__ */",
                Object.entries(LOADING_CONFIG.theme)
                  .map(([name, value]) => `--boot-${name}: ${value};`)
                  .join("\n"),
              )
              .replace("__BOOT_CONFIG__", () =>
                JSON.stringify({
                  language: LANGUAGE_CONFIG,
                  copy: LOADING_CONFIG.copy,
                }).replace(/</g, "\\u003c"),
              ),
        },
      },
      {
        name: "minify-production-html",
        apply: "build",
        transformIndexHtml: {
          order: "post",
          // 在 Vite 完成资源链接替换后，压缩 HTML 和首屏内嵌 CSS/JS。
          handler: (html) => {
            // CSS 异步下载，避免阻塞内嵌 loading 的首次绘制。
            // index.html 会等样式与应用都就绪再移除遮罩，避免无样式闪屏。
            const nonBlockingHtml = html.replace(
              /<link\b[^>]*\brel="stylesheet"[^>]*>/g,
              (tag) =>
                tag.replace(
                  "<link",
                  '<link media="print" data-app-style onload="this.media=\'all\'" onerror="this.dataset.failed=\'true\'"',
                ),
            );
            return minify(nonBlockingHtml, {
              collapseWhitespace: true,
              removeComments: true,
              minifyCSS: true,
              minifyJS: true,
            });
          },
        },
      },
    ],
    server: {
      // 开发服务器：监听局域网，端口占用时直接报错，避免悄悄切换来源。
      port,
      strictPort: true,
      host: "0.0.0.0",
      proxy: {
        "/api": {
          // 仅开发代理使用；生产信令地址由 VITE_SIGNAL_URL 决定。
          target: env.API_HOST || "http://127.0.0.1:8080",
          ws: true,
        },
      },
    },
    // 静态产物可由 Rust 服务、反向代理或 Cloudflare Workers Static Assets 托管。
    build: { outDir: "dist" },
  };
});
