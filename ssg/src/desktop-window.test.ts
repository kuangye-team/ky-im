import { afterEach, expect, it, vi } from "vitest";
import { syncDesktopTheme } from "./desktop-window";
import { THEME_CONFIG } from "./theme-config";

const native = vi.hoisted(() => ({
  setTheme: vi.fn().mockResolvedValue(undefined),
  setBackgroundColor: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("keeps the native caption and background on the last rapidly selected theme", async () => {
  vi.stubEnv("VITE_DESKTOP", "true");
  const calls: string[] = [];
  let release!: () => void;
  native.setTheme.mockImplementationOnce(() => new Promise<void>((resolve) => {
    calls.push("first-theme");
    release = resolve;
  }));
  native.setTheme.mockImplementation(async () => { calls.push("theme"); });
  native.setBackgroundColor.mockImplementation(async () => { calls.push("background"); });
  native.invoke.mockImplementation(async () => { calls.push("caption"); });
  const updates = THEME_CONFIG.options.map(syncDesktopTheme);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(calls).toEqual(["first-theme"]);
  release();
  await Promise.all(updates);
  expect(calls).toEqual([
    "first-theme", "background", "caption",
    "theme", "background", "caption",
    "theme", "background", "caption",
    "theme", "background", "caption",
  ]);
  expect(native.invoke.mock.calls).toEqual(THEME_CONFIG.options.map((theme) => [
    "set_title_bar_color", { color: theme.colors["--header-start"] },
  ]));
  expect(native.setTheme).toHaveBeenLastCalledWith("dark");
  expect(native.setBackgroundColor).toHaveBeenLastCalledWith("#292542");
});

it("continues syncing themes after a native caption update fails", async () => {
  vi.stubEnv("VITE_DESKTOP", "true");
  const error = new Error("Caption colors unavailable");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  native.invoke.mockRejectedValueOnce(error);
  await syncDesktopTheme(THEME_CONFIG.options[0]);
  await syncDesktopTheme(THEME_CONFIG.options[1]);
  expect(log).toHaveBeenCalledWith("Could not update the window theme", error);
  expect(native.invoke).toHaveBeenLastCalledWith("set_title_bar_color", { color: "#246957" });
});

it("leaves browser themes independent of native window APIs", async () => {
  vi.stubEnv("VITE_DESKTOP", undefined);
  await syncDesktopTheme(THEME_CONFIG.options[0]);
  expect(native.setTheme).not.toHaveBeenCalled();
  expect(native.setBackgroundColor).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
});
