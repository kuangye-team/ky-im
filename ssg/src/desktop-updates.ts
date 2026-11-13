import { runtimeLog } from "./runtime-logs";
import type { Update } from "@tauri-apps/plugin-updater";
import { downloadDesktopUpdate, type DownloadedUpdate } from "./desktop-update-download";

type State = {
  available: boolean; dismissed: boolean; updating: boolean; installed: boolean; error: string;
  currentVersion: string; versionError: boolean; version: string;
  checking: boolean; checked: boolean; checkError: string;
  phase: "idle" | "downloading" | "retrying" | "cancelling" | "installing" | "restarting";
  progress: number | null; downloadedBytes: number; totalBytes: number | null;
};
let state: State = {
  available: false, dismissed: false, updating: false, installed: false, error: "",
  currentVersion: "", versionError: false, version: "", checking: false, checked: false, checkError: "",
  phase: "idle", progress: null, downloadedBytes: 0, totalBytes: null,
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
let downloaded: DownloadedUpdate | null = null;
let activeDownload: AbortController | null = null;
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
    const previousDownload = downloaded;
    downloaded = null;
    patch({ available: !!update, version: update?.version || "", dismissed: false, error: "" });
    await previousDownload?.close().catch(() => {});
    await previous?.close().catch(() => {});
  } catch (error) {
    if (state.updating || state.installed) return;
    runtimeLog("warn", "app", "检查更新失败", { detail: String(error), raw: error });
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

function waitToRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function cancelAppUpdate() {
  if (!activeDownload || !["downloading", "retrying"].includes(state.phase)) return;
  patch({ phase: "cancelling" });
  activeDownload.abort();
}

async function downloadUpdate(update: Update, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    patch({ phase: "downloading", progress: null, downloadedBytes: 0, totalBytes: null });
    try {
      const result = await downloadDesktopUpdate(update, (event) => {
        if (signal.aborted) return;
        if (event.event === "Started") {
          const length = event.data.contentLength;
          const totalBytes = length && Number.isFinite(length) && length > 0 ? length : null;
          patch({ totalBytes, downloadedBytes: 0, progress: totalBytes ? 0 : null });
        } else if (event.event === "Progress") {
          const downloadedBytes = state.downloadedBytes + event.data.chunkLength;
          patch({ downloadedBytes, progress: state.totalBytes
            ? Math.min(99, Math.floor(downloadedBytes / state.totalBytes * 100)) : null });
        } else {
          patch({ progress: 100 });
        }
      }, signal);
      patch({ progress: 100 });
      return result;
    } catch (error) {
      signal.throwIfAborted();
      // Signature and permission errors need attention, not retries.
      if (!isRetryableUpdateError(error) || attempt >= 2) throw error;
      patch({ phase: "retrying" });
      await waitToRetry((attempt + 1) * 1_000, signal);
    }
  }
}

export async function applyAppUpdate(beforeRestart: () => string | null) {
  if (!pending || state.updating) return;
  const error = beforeRestart();
  if (error) { patch({ error }); return; }
  const controller = new AbortController();
  activeDownload = controller;
  patch({ updating: true, dismissed: false, error: "", phase: "downloading", progress: downloaded ? 100 : null });
  try {
    // Keep the download separate: a transfer may start while it is in flight.
    if (!downloaded && !state.installed) downloaded = await downloadUpdate(pending, controller.signal);
    controller.signal.throwIfAborted();
    const busy = beforeRestart();
    if (busy) { patch({ updating: false, phase: "idle", error: busy }); return; }
    if (!state.installed) {
      patch({ phase: "installing", progress: 100 });
      await downloaded!.install();
      patch({ installed: true });
      await downloaded!.close().catch(() => {});
      downloaded = null;
    }
    patch({ phase: "restarting", progress: 100 });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (error) {
    if (controller.signal.aborted) {
      await downloaded?.close().catch(() => {});
      downloaded = null;
      patch({ updating: false, phase: "idle", progress: null, downloadedBytes: 0, totalBytes: null, error: "" });
    } else {
      runtimeLog("error", "app", "应用更新未完成", { detail: String(error), raw: error });
      console.error("Desktop update failed", error);
      patch({ updating: false, phase: "idle", error: state.installed ? "更新已安装，请关闭并重新打开蜂鸟。" : "更新暂时未完成，请重试。" });
    }
  } finally {
    activeDownload = null;
  }
}
