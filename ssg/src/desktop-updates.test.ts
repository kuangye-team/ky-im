import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn(), getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

const makeUpdate = (version = "1.1.0") => ({ version, download: vi.fn().mockResolvedValue(undefined),
  install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) });

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.stubEnv("VITE_DESKTOP_UPDATER_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("desktop updates", () => {
  it("reads the installed version independently of updates and retries version failures", async () => {
    const app = await import("./desktop-updates");
    mocks.getVersion.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue("2.3.4");
    await app.loadDesktopVersion();
    expect(app.getAppUpdate().versionError).toBe(true);
    await Promise.all([app.loadDesktopVersion(), app.loadDesktopVersion()]);
    expect(app.getAppUpdate()).toMatchObject({ currentVersion: "2.3.4", versionError: false });
    await app.loadDesktopVersion();
    expect(mocks.getVersion).toHaveBeenCalledTimes(2);
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("keeps version information available when online updates are disabled", async () => {
    vi.stubEnv("VITE_DESKTOP_UPDATER_ENABLED", "false");
    const app = await import("./desktop-updates");
    mocks.getVersion.mockResolvedValue("1.0.0");
    await app.loadDesktopVersion();
    await app.checkDesktopUpdate({ manual: true });
    expect(app.getAppUpdate()).toMatchObject({ currentVersion: "1.0.0", checking: false, checked: false });
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("publishes check progress, ignores duplicate requests, and reports no update only after success", async () => {
    const app = await import("./desktop-updates");
    let finish!: (value: null) => void;
    mocks.check.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const checking = app.checkDesktopUpdate({ manual: true });
    expect(app.getAppUpdate()).toMatchObject({ checking: true, checked: false });
    await app.checkDesktopUpdate({ manual: true });
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish(null); await checking;
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(app.getAppUpdate()).toMatchObject({ checking: false, checked: true, available: false, checkError: "" });
  });
  it.each([false, true])("automatically retries failed checks while keeping one request active (manual=%s)", async (manual) => {
    vi.useFakeTimers();
    const update = makeUpdate();
    mocks.check
      .mockRejectedValueOnce("error sending request for url (https://cdn.example.com/latest.json)")
      .mockRejectedValueOnce(new Error("request or response body error"))
      .mockResolvedValueOnce(update);
    const app = await import("./desktop-updates");
    const checking = app.checkDesktopUpdate({ manual });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(app.getAppUpdate()).toMatchObject({ checking: true, checked: false, checkError: "" });
    await app.checkDesktopUpdate({ manual: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(app.getAppUpdate().checkError).toBe("");
    await vi.advanceTimersByTimeAsync(1); await checking;
    expect(mocks.check.mock.calls).toEqual(Array(3).fill([{ timeout: 15_000 }]));
    expect(app.getAppUpdate()).toMatchObject({ checking: false, checked: true, checkError: "", version: "1.1.0", available: true });
    expect(update.download).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it("preserves the known update after all check retries fail and allows checking again", async () => {
    vi.useFakeTimers();
    const update = makeUpdate(); mocks.check.mockResolvedValueOnce(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    const error = "error sending request for url (https://cdn.example.com/latest.json)";
    mocks.check.mockRejectedValue(error);
    const checking = app.checkDesktopUpdate({ manual: true });
    await vi.dynamicImportSettled();
    await vi.runAllTimersAsync(); await checking;
    expect(mocks.check).toHaveBeenCalledTimes(4);
    expect(app.getAppUpdate()).toMatchObject({ checking: false, available: true, version: "1.1.0",
      checkError: "暂时无法检查更新，请稍后重试。" });
    expect(console.error).toHaveBeenCalledWith("Desktop update check failed", error);
    expect(update.close).not.toHaveBeenCalled();
    mocks.check.mockResolvedValueOnce(null);
    await app.checkDesktopUpdate({ manual: true });
    expect(mocks.check).toHaveBeenCalledTimes(5);
    expect(app.getAppUpdate()).toMatchObject({ checking: false, checked: true, checkError: "", available: false });
    expect(update.close).toHaveBeenCalledOnce();
  });
  it.each([
    "Could not fetch a valid release JSON from the remote",
    "error decoding response body",
  ])("retries failed check responses: %s", async (error) => {
    vi.useFakeTimers();
    mocks.check.mockRejectedValueOnce(error).mockResolvedValueOnce(null);
    const app = await import("./desktop-updates");
    const checking = app.checkDesktopUpdate();
    await vi.dynamicImportSettled();
    await vi.runAllTimersAsync(); await checking;
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(app.getAppUpdate()).toMatchObject({ checking: false, checked: true, available: false, checkError: "" });
  });
  it("reports update configuration errors without retrying", async () => {
    mocks.check.mockRejectedValue("Updater does not have any endpoints set.");
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate({ manual: true });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(app.getAppUpdate()).toMatchObject({ checking: false, checked: false, available: false,
      checkError: "暂时无法检查更新，请稍后重试。" });
  });
  it("stops pending check retries when installation starts", async () => {
    vi.useFakeTimers();
    const update = makeUpdate(); mocks.check.mockResolvedValueOnce(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    mocks.check.mockRejectedValue("error sending request for url (https://cdn.example.com/latest.json)");
    const checking = app.checkDesktopUpdate();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    let finishDownload!: () => void;
    update.download.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
    const installing = app.applyAppUpdate(() => null);
    await vi.runAllTimersAsync(); await checking;
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(app.getAppUpdate()).toMatchObject({ checking: false, updating: true, available: true, version: "1.1.0", checkError: "" });
    expect(update.close).not.toHaveBeenCalled();
    finishDownload(); await installing;
    expect(update.install).toHaveBeenCalledOnce();
  });
  it("shows a deferred update again after a manual check, without downloading it", async () => {
    const app = await import("./desktop-updates");
    const first = makeUpdate(); mocks.check.mockResolvedValueOnce(first);
    await app.checkDesktopUpdate(); app.dismissAppUpdate();
    const duplicate = makeUpdate(); mocks.check.mockResolvedValueOnce(duplicate);
    await app.checkDesktopUpdate({ manual: true });
    expect(app.getAppUpdate()).toMatchObject({ version: "1.1.0", available: true, dismissed: false });
    expect(duplicate.close).toHaveBeenCalledOnce();
    expect(first.download).not.toHaveBeenCalled();
    app.dismissAppUpdate(); app.showDesktopUpdate();
    expect(app.getAppUpdate().dismissed).toBe(false);
  });
  it("keeps known versions on check failures and clears withdrawn updates on a successful check", async () => {
    const app = await import("./desktop-updates");
    mocks.check.mockRejectedValueOnce(new Error("offline"));
    await app.checkDesktopUpdate({ manual: true });
    expect(app.getAppUpdate()).toMatchObject({ checked: false, checking: false, available: false });
    expect(app.getAppUpdate().checkError).not.toBe("");
    const first = makeUpdate(); mocks.check.mockResolvedValueOnce(first);
    await app.checkDesktopUpdate({ manual: true });
    expect(app.getAppUpdate().checkError).toBe("");
    mocks.check.mockRejectedValueOnce(new Error("offline"));
    await app.checkDesktopUpdate({ manual: true });
    expect(app.getAppUpdate()).toMatchObject({ available: true, version: "1.1.0" });
    expect(first.close).not.toHaveBeenCalled();
    mocks.check.mockResolvedValueOnce(null);
    await app.checkDesktopUpdate({ manual: true });
    expect(app.getAppUpdate()).toMatchObject({ checked: true, checkError: "", available: false, version: "" });
    expect(first.close).toHaveBeenCalledOnce();
    await app.applyAppUpdate(() => null);
    expect(first.install).not.toHaveBeenCalled();
  });
  it("checks silently, waits for consent, and installs before relaunch", async () => {
    const update = makeUpdate(); mocks.check.mockResolvedValue(update);
    const app = await import("./desktop-updates");
    await app.checkDesktopUpdate();
    expect(app.getAppUpdate().available).toBe(true);
    expect(update.download).not.toHaveBeenCalled();
    app.dismissAppUpdate();
    expect(app.getAppUpdate().dismissed).toBe(true);
    await app.applyAppUpdate(() => null);
    expect(update.download).toHaveBeenCalledOnce(); expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(update.install.mock.invocationCallOrder[0]).toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
  });
  it("blocks a busy app both before download and immediately before install", async () => {
    const update = makeUpdate(); mocks.check.mockResolvedValue(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    await app.applyAppUpdate(() => "busy");
    expect(update.download).not.toHaveBeenCalled();
    await app.applyAppUpdate(vi.fn().mockReturnValueOnce(null).mockReturnValue("busy"));
    expect(update.download).toHaveBeenCalledOnce(); expect(update.install).not.toHaveBeenCalled();
    expect(app.getAppUpdate().updating).toBe(false);
    await app.applyAppUpdate(() => null);
    expect(update.download).toHaveBeenCalledOnce(); expect(update.install).toHaveBeenCalledOnce();
  });
  it("retries failed downloads and never restarts after failed installation", async () => {
    const update = makeUpdate(); mocks.check.mockResolvedValue(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    update.download.mockRejectedValueOnce(new Error("network"));
    await app.applyAppUpdate(() => null);
    expect(app.getAppUpdate().error).not.toBe(""); expect(update.install).not.toHaveBeenCalled();
    update.install.mockRejectedValueOnce(new Error("signature"));
    await app.applyAppUpdate(() => null);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await app.applyAppUpdate(() => null);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
  it("recovers from native connection failures without another click", async () => {
    vi.useFakeTimers();
    const update = makeUpdate(); mocks.check.mockResolvedValue(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    update.download
      .mockRejectedValueOnce("error sending request for url (https://cdn.example.com/update.tar.gz)")
      .mockRejectedValueOnce(new Error("request or response body error"));
    const installing = app.applyAppUpdate(() => null);
    await vi.advanceTimersByTimeAsync(999);
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(app.getAppUpdate()).toMatchObject({ updating: true, error: "" });
    await app.applyAppUpdate(() => null);
    await app.checkDesktopUpdate();
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(update.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await installing;
    expect(update.download).toHaveBeenCalledTimes(3);
    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
  it("stops after three failed download attempts and allows a manual retry", async () => {
    vi.useFakeTimers();
    const update = makeUpdate(); mocks.check.mockResolvedValue(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    const error = "error sending request for url (https://cdn.example.com/update.tar.gz)";
    update.download.mockRejectedValue(error);
    const installing = app.applyAppUpdate(() => null);
    await vi.runAllTimersAsync(); await installing;
    expect(update.download).toHaveBeenCalledTimes(3);
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(app.getAppUpdate()).toMatchObject({ updating: false, installed: false, error: "更新暂时未完成，请重试。" });
    expect(console.error).toHaveBeenCalledWith("Desktop update failed", error);
    update.download.mockResolvedValue(undefined);
    await app.applyAppUpdate(() => null);
    expect(update.download).toHaveBeenCalledTimes(4);
    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
  it.each([
    "error decoding response body",
    "`Download request failed with status: 408 Request Timeout`",
    "`Download request failed with status: 429 Too Many Requests`",
    "`Download request failed with status: 503 Service Unavailable`",
  ])("retries temporary download errors: %s", async (error) => {
    vi.useFakeTimers();
    const update = makeUpdate(); mocks.check.mockResolvedValue(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    update.download.mockRejectedValueOnce(error);
    const installing = app.applyAppUpdate(() => null);
    await vi.runAllTimersAsync(); await installing;
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(update.install).toHaveBeenCalledOnce();
  });
  it.each([
    "Signature verification failed",
    "`Download request failed with status: 403 Forbidden`",
    "`Download request failed with status: 404 Not Found`",
    "Permission denied",
  ])("does not retry or install after a permanent download error: %s", async (error) => {
    const update = makeUpdate(); mocks.check.mockResolvedValue(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    update.download.mockRejectedValue(error);
    await app.applyAppUpdate(() => null);
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(app.getAppUpdate().updating).toBe(false);
  });
  it("checks for active transfers again after retrying the download", async () => {
    vi.useFakeTimers();
    const update = makeUpdate(); mocks.check.mockResolvedValue(update);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate();
    update.download.mockRejectedValueOnce("error sending request for url (https://cdn.example.com/update.tar.gz)");
    const beforeRestart = vi.fn().mockReturnValueOnce(null).mockReturnValue("busy");
    const installing = app.applyAppUpdate(beforeRestart);
    await vi.runAllTimersAsync(); await installing;
    expect(app.getAppUpdate()).toMatchObject({ updating: false, error: "busy" });
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await app.applyAppUpdate(() => null);
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(update.install).toHaveBeenCalledOnce();
  });
  it("keeps dismissed versions dismissed and releases duplicate native resources", async () => {
    const first = makeUpdate(); mocks.check.mockResolvedValueOnce(first);
    const app = await import("./desktop-updates"); await app.checkDesktopUpdate(); app.dismissAppUpdate();
    const duplicate = makeUpdate(); mocks.check.mockResolvedValueOnce(duplicate); await app.checkDesktopUpdate();
    expect(duplicate.close).toHaveBeenCalledOnce(); expect(app.getAppUpdate().dismissed).toBe(true);
    mocks.check.mockResolvedValueOnce(makeUpdate("1.2.0")); await app.checkDesktopUpdate();
    expect(first.close).toHaveBeenCalledOnce(); expect(app.getAppUpdate().dismissed).toBe(false);
  });
  it("handles offline checks and prevents overlapping installation", async () => {
    const app = await import("./desktop-updates"); mocks.check.mockRejectedValueOnce(new Error("offline"));
    await app.checkDesktopUpdate(); expect(app.getAppUpdate().available).toBe(false);
    const update = makeUpdate(); mocks.check.mockResolvedValue(update); await app.checkDesktopUpdate();
    let finish!: () => void;
    update.download.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const installing = app.applyAppUpdate(() => null);
    await app.applyAppUpdate(() => null); await app.checkDesktopUpdate();
    finish(); await installing;
    expect(update.download).toHaveBeenCalledOnce(); expect(update.install).toHaveBeenCalledOnce();
  });
  it("does not replace an update when an earlier background check finishes during download", async () => {
    const app = await import("./desktop-updates");
    const first = makeUpdate(); mocks.check.mockResolvedValueOnce(first); await app.checkDesktopUpdate();
    let finishCheck!: (value: ReturnType<typeof makeUpdate>) => void;
    mocks.check.mockImplementationOnce(() => new Promise((resolve) => { finishCheck = resolve; }));
    const checking = app.checkDesktopUpdate();
    await vi.waitFor(() => expect(finishCheck).toBeDefined());
    let finishDownload!: () => void;
    first.download.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
    const installing = app.applyAppUpdate(() => null);
    const second = makeUpdate("1.2.0"); finishCheck(second); await checking;
    finishDownload(); await installing;
    expect(first.close).not.toHaveBeenCalled(); expect(first.install).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce(); expect(second.install).not.toHaveBeenCalled();
  });
});
