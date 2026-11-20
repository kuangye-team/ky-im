import type { ChatEngine } from "./core";
import { stopDraftsForReset } from "./drafts";
import { stopLogsForReset } from "./runtime-logs";
import { CLOSE_OTHER_PAGES, deleteDatabase } from "./reset-cleanup";
import { resetBrowserAttachments } from "./core/storage/opfs";
import { storageUsage } from "./core/storage/usage";
import { STORAGE_CONFIG } from "./config";

export const RESET_LOCK = "ky-im:reset";
export const RESET_COMPLETE = "hummingbird.v2.reset-complete";
const draftKeys = ["hummingbird.chat-drafts", "hummingbird.v2.chat-drafts"];
const localKeys = [
  "hummingbird.theme", "hummingbird.language", "hummingbird.availability",
  "hummingbird.network.v1", "hummingbird.network", "hummingbird.file-performance",
  "hummingbird.runtime-logs", "hummingbird.v2.runtime-logs",
];

function stopLocalWriters() {
  stopDraftsForReset();
  stopLogsForReset();
}

function clearPreferences() {
  for (const key of draftKeys) sessionStorage.removeItem(key);
  for (const key of localKeys) localStorage.removeItem(key);
}

export async function preparePeerReset(engine: ChatEngine) {
  stopLocalWriters();
  await engine.prepareReset();
  for (const key of draftKeys) sessionStorage.removeItem(key);
  storageUsage(engine.storage).invalidate();
}

export async function resetAppData(engine: ChatEngine) {
  const desktop = !!engine.storage.getStorageInfo;
  const reset = async () => {
    stopLocalWriters();
    if (desktop) {
      await engine.resetData();
    } else {
      await engine.prepareReset();
      await deleteDatabase("send-chat");
      await engine.storage.close?.();
      await deleteDatabase(STORAGE_CONFIG.databaseName);
      await resetBrowserAttachments(STORAGE_CONFIG.databaseName);
      // The current precache is the installed application and must remain bootable offline.
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration && typeof caches !== "undefined")
        await caches.delete("workbox-precache-v2-" + registration.scope);
    }
    clearPreferences();
    if (!desktop) {
      storageUsage(engine.storage).invalidate();
      localStorage.setItem(RESET_COMPLETE, "1");
      localStorage.removeItem(RESET_COMPLETE);
    }
  };
  if (!desktop && navigator.locks) {
    await navigator.locks.request(RESET_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error(CLOSE_OTHER_PAGES);
      await reset();
    });
  } else await reset();
}
