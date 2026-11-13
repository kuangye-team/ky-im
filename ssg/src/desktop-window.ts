import { runtimeLog } from "./runtime-logs";
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
    // Windows 11 paints its native caption separately from the window background.
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_title_bar_color", { color: theme.colors["--header-start"] });
  }).catch((error) => {
    runtimeLog("error", "app", "窗口外观未能更新", { detail: String(error), raw: error });
    console.error("Could not update the window theme", error);
  });
  return pending;
}
