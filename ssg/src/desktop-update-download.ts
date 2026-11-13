import { Channel, Resource, invoke } from "@tauri-apps/api/core";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export class DownloadedUpdate extends Resource {
  install() { return invoke<void>("install_update", { downloadRid: this.rid }); }
}

export async function downloadDesktopUpdate(
  update: Update,
  onEvent: (event: DownloadEvent) => void,
  signal: AbortSignal,
): Promise<DownloadedUpdate> {
  signal.throwIfAborted();
  const rid = await invoke<number>("prepare_update_download", { updateRid: update.rid });
  const download = new DownloadedUpdate(rid);
  let closing: Promise<void> | undefined;
  const close = () => { closing ??= download.close().catch(() => {}); };
  signal.addEventListener("abort", close, { once: true });
  try {
    // Cancellation may have happened while the native resource was being created.
    signal.throwIfAborted();
    const channel = new Channel<DownloadEvent>();
    channel.onmessage = (event) => { if (!signal.aborted) onEvent(event); };
    await invoke("download_update", { downloadRid: rid, onEvent: channel });
    signal.throwIfAborted();
    return download;
  } catch (error) {
    close();
    await closing;
    throw error;
  } finally {
    signal.removeEventListener("abort", close);
  }
}
