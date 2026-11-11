import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { Plugin } from "vite";
import { THEME_CONFIG } from "../src/theme-config";

const sourceUrl = new URL("../src/assets/favicon.svg", import.meta.url);
export const brandSvg = readFileSync(sourceUrl, "utf8").trim();
const svgDataUrl = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`;
const themeIcons = Object.fromEntries(
  THEME_CONFIG.options.map((theme) => {
    const svg = brandSvg.replace(
      /color="[^"]+"/,
      `color="${theme.colors["--primary"]}"`,
    );
    return [theme.id, {
      favicon: svgDataUrl(svg),
      bird: svgDataUrl(svg.replace(/\s*<rect[^>]+\/>/, "")),
    }];
  }),
);

/** One editable SVG supplies inline artwork and installation icons, without asset requests. */
export function appIcons(): Plugin {
  const moduleId = "virtual:app-icons";
  const resolvedId = `\0${moduleId}`;
  const png = async (svg: string, size: number) => {
    const buffer = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
    return `data:image/png;base64,${buffer.toString("base64")}`;
  };
  // The OS supplies its own corner shape; keep the bird inside the safe circle.
  const maskable = brandSvg
    .replace('rx="15"', 'rx="0"')
    .replace(
      '<g id="bird">',
      '<g id="bird" transform="translate(4.8 4.8) scale(.8)">',
    );
  const ready = Promise.all([
    png(brandSvg, 192),
    png(brandSvg, 512),
    png(maskable, 512),
    png(maskable, 180),
  ]).then(([app192, app512, appMaskable512, appleTouch]) => ({
    app192, app512, appMaskable512, appleTouch,
  }));

  return {
    name: "hummingbird-app-icons",
    resolveId(id) {
      if (id === moduleId) return resolvedId;
    },
    async load(id) {
      if (id !== resolvedId) return;
      return `export const themeIcons = ${JSON.stringify(themeIcons)};
export const pngIcons = ${JSON.stringify(await ready)};`;
    },
    transformIndexHtml: {
      order: "pre",
      // Keep the saved theme's favicon available even while the entry JS is downloading.
      handler: (html) => html
        .replace("__FAVICON__", () => themeIcons[THEME_CONFIG.defaultTheme].favicon)
        .replace("__THEME_ICONS__", () => JSON.stringify(themeIcons)),
    },
  };
}
