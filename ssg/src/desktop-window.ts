import { isDesktop } from "./core/network/settings";
import type { THEME_CONFIG } from "./theme-config";

type Theme = (typeof THEME_CONFIG.options)[number];
let pending = Promise.resolve();

/** Keep native title-bar updates in order when themes are switched quickly. */
export function syncDesktopTheme(theme: Theme) {
  if (!isDesktop()) return;
  pending = pending.then(async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.setTheme(theme.scheme);
    await window.setBackgroundColor(theme.colors["--header-start"]);
  }).catch((error) => console.error("Could not update the window theme", error));
}
