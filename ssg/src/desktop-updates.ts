import type { Update } from "@tauri-apps/plugin-updater";

type State = {
  available: boolean; dismissed: boolean; updating: boolean; installed: boolean; error: string;
  currentVersion: string; versionError: boolean; version: string;
  checking: boolean; checked: boolean; checkError: string;
};
let state: State = {
  available: false, dismissed: false, updating: false, installed: false, error: "",
  currentVersion: "", versionError: false, version: "", checking: false, checked: false, checkError: "",
};
export const desktopUpdaterEnabled = import.meta.env.VITE_DESKTOP_UPDATER_ENABLED === "true";
const listeners = new Set<() => void>();
export const getAppUpdate = () => state;
export function subscribeAppUpdate(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function patch(values: Partial<State>) {
  state = { ...state, ...values };
  listeners.forEach((listener) => listener());
}

let started = false;
let lastCheck = 0;
let pending: Update | null = null;
let downloaded = false;
let versionRequest: Promise<void> | null = null;

export function loadDesktopVersion() {
  if (state.currentVersion) return Promise.resolve();
  if (versionRequest) return versionRequest;
  patch({ versionError: false });
  versionRequest = import("@tauri-apps/api/app")
    .then(({ getVersion }) => getVersion())
    .then((currentVersion) => { patch({ currentVersion }); })
    .catch(() => { patch({ versionError: true }); })
    .finally(() => { versionRequest = null; });
  return versionRequest;
}

export function showDesktopUpdate() {
  if (state.available) patch({ dismissed: false });
}

function isRetryableUpdateError(error: unknown) {
  // Native errors arrive as strings. Failed check responses omit the HTTP status.
  const message = error instanceof Error ? error.message : String(error);
  return message === "Could not fetch a valid release JSON from the remote" ||
    /^(?:error sending request for url\b|error decoding response body\b|request or response body error\b|`?Download request failed with status: (?:408|429|5\d{2})\b)/.test(message);
}

export async function checkDesktopUpdate({ manual = false } = {}) {
  if (!desktopUpdaterEnabled || state.checking || state.updating || state.installed) return;
  patch({ checking: true, checkError: "" });
  lastCheck = Date.now();
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    let update: Update | null;
    for (let attempt = 0; ; attempt++) {
      // Installation can start while a background check is waiting to retry.
      if (state.updating || state.installed) return;
      try {
        update = await check({ timeout: 15_000 });
        break;
      } catch (error) {
        if (!isRetryableUpdateError(error) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1_000));
      }
    }
    // A background request may finish after the user has started installing.
    if (state.updating || state.installed) { await update?.close(); return; }
    patch({ checked: true });
    if (update && pending?.version === update.version) {
      if (manual) showDesktopUpdate();
      await update.close().catch(() => {});
      return;
    }
    const previous = pending;
    pending = update;
    downloaded = false;
    patch({ available: !!update, version: update?.version || "", dismissed: false, error: "" });
    await previous?.close().catch(() => {});
  } catch (error) {
    if (state.updating || state.installed) return;
    console.error("Desktop update check failed", error);
    // Expose failures in About without interrupting sharing with a new banner.
    patch({ checkError: "暂时无法检查更新，请稍后重试。" });
  } finally {
    patch({ checking: false });
  }
}

export function startAppUpdates() {
  if (started || !desktopUpdaterEnabled) return;
  started = true;
  const check = () => {
    if (document.visibilityState === "visible" && navigator.onLine && Date.now() - lastCheck >= 60_000)
      void checkDesktopUpdate();
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  window.addEventListener("online", check);
  window.setInterval(check, 30 * 60_000);
  check();
}

export function dismissAppUpdate() {
  if (!state.updating) patch({ dismissed: true, error: "" });
}

async function downloadUpdate(update: Update) {
  for (let attempt = 0; ; attempt++) {
    try {
      await update.download();
      return;
    } catch (error) {
      // Signature, permissions and installation errors need attention, not retries.
      if (!isRetryableUpdateError(error) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1_000));
    }
  }
}

export async function applyAppUpdate(beforeRestart: () => string | null) {
  if (!pending || state.updating) return;
  const error = beforeRestart();
  if (error) { patch({ error }); return; }
  patch({ updating: true, error: "" });
  try {
    // Keep the download separate: a transfer may start while it is in flight.
    if (!downloaded && !state.installed) { await downloadUpdate(pending); downloaded = true; }
    const busy = beforeRestart();
    if (busy) { patch({ updating: false, error: busy }); return; }
    if (!state.installed) { await pending.install(); patch({ installed: true }); }
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (error) {
    console.error("Desktop update failed", error);
    patch({ updating: false, error: state.installed ? "更新已安装，请关闭并重新打开蜂鸟。" : "更新暂时未完成，请重试。" });
  }
}
