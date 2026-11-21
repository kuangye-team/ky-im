import { isNative } from "./platform";

export const RELOAD_REQUEST_EVENT = "hummingbird:reload-request";
let approved = false;
export const isReloadApproved = () => approved;

/** The native command approves exactly one navigation through the WebView guard. */
export async function reloadApp() {
  approved = true;
  try {
    if (isNative()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reload_app");
    } else {
      window.location.reload();
    }
  } catch (error) {
    approved = false;
    throw error;
  }
}

export async function setNativeReloadGuard(ready: boolean) {
  if (!isNative()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_reload_guard", { ready });
}
