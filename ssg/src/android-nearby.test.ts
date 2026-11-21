import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { nearbyPermission } from "./android-nearby";
import { defaultNetwork } from "./core/network";
import { desktopNetwork } from "./core/network/desktop";
import { defaultSettings, readSettings } from "./core/network/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./core/network/desktop", () => ({ desktopNetwork: vi.fn(() => ({})) }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("starts nearby discovery by default when Android permits it and honors a saved opt-out", async () => {
  vi.stubEnv("VITE_ANDROID", "true");
  const settings = defaultSettings();
  expect(settings.discovery).toEqual({ signaling: true, mdns: true });
  vi.mocked(invoke).mockResolvedValue(true);
  await defaultNetwork(settings);
  expect(invoke).toHaveBeenCalledWith("request_nearby", { mode: "check" });
  expect(desktopNetwork).toHaveBeenLastCalledWith(undefined, settings, undefined);

  settings.discovery.mdns = false;
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(settings) });
  await defaultNetwork();
  expect(readSettings().discovery.mdns).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("starts online discovery while permission is pending without changing the user's preference", async () => {
  vi.stubEnv("VITE_ANDROID", "true");
  vi.mocked(invoke).mockResolvedValue(false);
  const settings = defaultSettings();
  expect((await defaultNetwork(settings)).needsNearbyPermission).toBe(true);
  expect(desktopNetwork).toHaveBeenCalledWith(undefined,
    { ...settings, discovery: { signaling: true, mdns: false } }, undefined);
  expect(settings.discovery.mdns).toBe(true);
});

it("shares an outstanding permission dialog and allows an explicit retry", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const automatic = nearbyPermission("automatic");
  expect(nearbyPermission("manual")).toBe(automatic);
  expect(await automatic).toBe(false);
  expect(await nearbyPermission("manual")).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(2);
});
