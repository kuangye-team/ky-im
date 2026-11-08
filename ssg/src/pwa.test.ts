import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

const register = vi.hoisted(() => vi.fn());
vi.mock("virtual:pwa-register", () => ({ registerSW: register }));
let options: RegisterSWOptions;
let registration: ServiceWorkerRegistration;
let updater: typeof import("./pwa");
let activate: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  reload = vi.fn();
  activate = vi.fn().mockResolvedValue(undefined);
  registration = Object.assign(new EventTarget(), {
    waiting: {},
    installing: null,
    update: vi.fn().mockResolvedValue(undefined),
  }) as unknown as ServiceWorkerRegistration;
  vi.stubGlobal("navigator", {
    onLine: true,
    serviceWorker: Object.assign(new EventTarget(), { controller: {} }),
  });
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { location: { reload }, setInterval }),
  );
  register.mockImplementation((callbacks: RegisterSWOptions) => {
    options = callbacks;
    return activate;
  });
  updater = await import("./pwa");
  updater.startAppUpdates();
  options.onRegisteredSW?.("/sw.js", registration);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not reload until this tab approves, even when another tab activates the worker", async () => {
  expect(updater.getAppUpdate().available).toBe(true);
  options.onNeedReload?.();
  expect(reload).not.toHaveBeenCalled();
  Object.assign(registration, { waiting: null });
  await updater.applyAppUpdate(() => null);
  expect(reload).toHaveBeenCalledTimes(1);
});

it("keeps a dismissed release quiet and announces a later release", () => {
  updater.dismissAppUpdate();
  options.onNeedRefresh?.();
  expect(updater.getAppUpdate().dismissed).toBe(true);
  Object.assign(registration, { waiting: {} });
  options.onNeedRefresh?.();
  expect(updater.getAppUpdate().dismissed).toBe(false);
});

it("handles native controller changes when Workbox considers a rapid deployment external", async () => {
  await updater.applyAppUpdate(() => null);
  Object.assign(navigator.serviceWorker, { controller: {} });
  navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
  expect(reload).toHaveBeenCalledTimes(1);
});

it("blocks activation while sharing or draft saving needs attention", async () => {
  await updater.applyAppUpdate(() => "still sharing");
  expect(activate).not.toHaveBeenCalled();
  expect(updater.getAppUpdate().error).toBe("still sharing");
});

it("rechecks safety after activation and requires a new click if a transfer started", async () => {
  let busy = false;
  await updater.applyAppUpdate(() => (busy ? "still sharing" : null));
  expect(activate).toHaveBeenCalledTimes(1);
  busy = true;
  Object.assign(registration, { waiting: null });
  options.onNeedReload?.();
  expect(reload).not.toHaveBeenCalled();
  busy = false;
  options.onNeedReload?.();
  expect(reload).not.toHaveBeenCalled();
  await updater.applyAppUpdate(() => null);
  expect(reload).toHaveBeenCalledTimes(1);
});

it("allows retry after a failed or timed out activation without a late surprise reload", async () => {
  activate.mockRejectedValueOnce(new Error("unavailable"));
  await updater.applyAppUpdate(() => null);
  expect(updater.getAppUpdate().updating).toBe(false);
  await updater.applyAppUpdate(() => null);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(updater.getAppUpdate().updating).toBe(false);
  options.onNeedReload?.();
  expect(reload).not.toHaveBeenCalled();
});

it("checks periodically and on returning online, skipping hidden or offline pages", async () => {
  await Promise.resolve();
  const check = vi.mocked(registration.update);
  check.mockClear();
  Object.assign(navigator, { onLine: false });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(check).not.toHaveBeenCalled();
  Object.assign(navigator, { onLine: true });
  window.dispatchEvent(new Event("online"));
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(1);
  Object.assign(document, { visibilityState: "hidden" });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(check).toHaveBeenCalledTimes(1);
  Object.assign(document, { visibilityState: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(2);
});
