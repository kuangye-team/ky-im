import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { type Channel, type InvokeArgs } from "@tauri-apps/api/core";
import { Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { downloadDesktopUpdate } from "./desktop-update-download";

const update = new Update({ rid: 1, version: "1.1.0", currentVersion: "1.0.0", rawJson: {} });
beforeEach(() => { vi.stubGlobal("window", { crypto }); });
afterEach(() => { vi.unstubAllGlobals(); });

it("closes a resource created after cancellation without starting its download", async () => {
  let prepare!: (rid: number) => void;
  const handler = vi.fn((command: string) => command === "prepare_update_download"
    ? new Promise<number>((resolve) => { prepare = resolve; }) : undefined);
  mockIPC(handler);
  const controller = new AbortController();
  const downloading = downloadDesktopUpdate(update, vi.fn(), controller.signal);
  controller.abort(); prepare(10);
  await expect(downloading).rejects.toMatchObject({ name: "AbortError" });
  expect(handler.mock.calls.map(([command]) => command)).toEqual(["prepare_update_download", "plugin:resources|close"]);
});

it("closes an in-flight download once and suppresses late progress", async () => {
  let channel!: Channel<DownloadEvent>;
  let rejectDownload!: (reason: string) => void;
  const handler = vi.fn((command: string, args?: InvokeArgs) => {
    if (command === "prepare_update_download") return 10;
    if (command === "download_update") {
      channel = (args as Record<string, unknown>).onEvent as Channel<DownloadEvent>;
      return new Promise((_, reject) => { rejectDownload = reject; });
    }
    if (command === "plugin:resources|close") rejectDownload("Update cancelled");
  });
  mockIPC(handler);
  const controller = new AbortController(); const report = vi.fn();
  const downloading = downloadDesktopUpdate(update, report, controller.signal);
  await vi.waitFor(() => expect(channel).toBeDefined());
  channel.onmessage({ event: "Started", data: { contentLength: 100 } });
  controller.abort();
  channel.onmessage({ event: "Progress", data: { chunkLength: 10 } });
  await expect(downloading).rejects.toBe("Update cancelled");
  expect(report).toHaveBeenCalledOnce();
  expect(handler.mock.calls.filter(([command]) => command === "plugin:resources|close")).toHaveLength(1);
});

it("releases failed downloads and retains a verified download until installation", async () => {
  let fails = true;
  const handler = vi.fn((command: string) => {
    if (command === "prepare_update_download") return 10;
    if (command === "download_update" && fails) throw "Signature verification failed";
  });
  mockIPC(handler);
  await expect(downloadDesktopUpdate(update, vi.fn(), new AbortController().signal)).rejects.toBe("Signature verification failed");
  expect(handler.mock.calls.at(-1)?.[0]).toBe("plugin:resources|close");
  fails = false; handler.mockClear();
  const download = await downloadDesktopUpdate(update, vi.fn(), new AbortController().signal);
  expect(handler.mock.calls.map(([command]) => command)).toEqual(["prepare_update_download", "download_update"]);
  await download.install(); await download.close();
  expect(handler.mock.calls.map(([command]) => command)).toEqual(["prepare_update_download", "download_update", "install_update", "plugin:resources|close"]);
});
