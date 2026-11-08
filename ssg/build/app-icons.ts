import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { Plugin } from "vite";
import { THEME_CONFIG } from "../src/theme-config";

const sourceUrl = new URL("../public/favicon.svg", import.meta.url);
export const brandSvg = readFileSync(sourceUrl, "utf8");

/** One editable SVG supplies the favicon, page artwork and installation icons. */
export function appIcons(): Plugin {
  const assets = new Map<string, string | Buffer>();
  const ready = (async () => {
    for (const theme of THEME_CONFIG.options) {
      const svg = brandSvg.replace(
        /color="[^"]+"/,
        `color="${theme.colors["--primary"]}"`,
      );
      assets.set(`icons/${theme.id}/favicon.svg`, svg);
      assets.set(
        `icons/${theme.id}/bird.svg`,
        svg.replace(/\s*<rect[^>]+\/>/, ""),
      );
    }
    for (const size of [192, 512]) {
      assets.set(
        `icons/app-${size}.png`,
        await sharp(Buffer.from(brandSvg)).resize(size, size).png().toBuffer(),
      );
    }
    // The OS supplies its own corner shape; keep the bird inside the safe circle.
    const maskable = brandSvg
      .replace('rx="15"', 'rx="0"')
      .replace(
        '<g id="bird">',
        '<g id="bird" transform="translate(4.8 4.8) scale(.8)">',
      );
    assets.set(
      "icons/app-maskable-512.png",
      await sharp(Buffer.from(maskable)).resize(512, 512).png().toBuffer(),
    );
    assets.set(
      "icons/apple-touch-icon.png",
      await sharp(Buffer.from(maskable)).resize(180, 180).png().toBuffer(),
    );
  })();
  return {
    name: "hummingbird-app-icons",
    async buildStart() {
      await ready;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        await ready;
        const path = req.url?.split("?")[0].slice(1) || "";
        const asset = assets.get(path);
        if (!asset) return next();
        res.setHeader(
          "Content-Type",
          path.endsWith(".svg") ? "image/svg+xml" : "image/png",
        );
        res.end(asset);
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}
