import { afterEach, expect, it, vi } from "vitest";
import { checkAndroidUpdate } from "./android-updates";
import { CLIENT_CONFIG } from "./config";

const apk = "https://cdn.example.com/ky-im-android-arm.apk";
function release(version: string, android?: string) {
  return { ok: true, json: async () => ({ version, downloads: { android, windows: "https://example.com/app.exe" } }) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("fetches a fresh manifest from the public site for every manual check", async () => {
  vi.stubEnv("VITE_ANDROID", "true");
  vi.stubEnv("VITE_API_LATEST", "/api/latest");
  const fetch = vi.fn().mockResolvedValueOnce(release("1.9.9", apk)).mockResolvedValueOnce(release("v1.10.0", apk));
  vi.stubGlobal("fetch", fetch);
  await expect(checkAndroidUpdate("1.9.9")).resolves.toEqual({ status: "current" });
  await expect(checkAndroidUpdate("1.9.9")).resolves.toEqual({ status: "available", version: "1.10.0", url: apk });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith(new URL("/api/latest", CLIENT_CONFIG.webUrl).href,
    expect.objectContaining({ credentials: "omit", cache: "no-store" }));
});

it("uses an explicit manifest URL and never offers a downgrade", async () => {
  vi.stubEnv("VITE_ANDROID", "true");
  const url = "https://releases.example.com/stable.json";
  vi.stubEnv("VITE_API_LATEST", url);
  const fetch = vi.fn().mockResolvedValue(release("2.0.9", apk));
  vi.stubGlobal("fetch", fetch);
  await expect(checkAndroidUpdate("2.0.10")).resolves.toEqual({ status: "current" });
  expect(fetch).toHaveBeenCalledWith(url, expect.anything());
});

it.each([undefined, "https://example.com/desktop.exe", "http://example.com/app.apk"])(
  "does not offer a desktop-only release or unusable APK: %j", async (android) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(release("2.0.0", android)));
    await expect(checkAndroidUpdate("1.0.0")).resolves.toEqual({ status: "unpublished" });
  },
);

it("allows retry after a network error or invalid version", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(release("invalid", apk)).mockResolvedValueOnce(release("1.0.1", apk)));
  await expect(checkAndroidUpdate("1.0.0")).rejects.toThrow("offline");
  await expect(checkAndroidUpdate("1.0.0")).rejects.toThrow("Invalid Android version");
  await expect(checkAndroidUpdate("1.0.0")).resolves.toMatchObject({ status: "available" });
});
