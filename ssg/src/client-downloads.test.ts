import { afterEach, expect, it, vi } from "vitest";
import { clientManifestRequestUrl, detectDesktopPlatform, parseClientRelease } from "./client-downloads";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it.each([
  [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" }, "windows"],
  [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 }, "macos"],
  [{ userAgent: "Mozilla/5.0", userAgentData: { platform: "Windows" } }, "windows"],
  [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel", maxTouchPoints: 5 }, undefined],
  [{ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS)", platform: "iPhone" }, undefined],
  [{ userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux" }, undefined],
  [{ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" }, undefined],
])("recognizes desktop devices without recommending macOS to iPads: %j", (device, expected) => {
  expect(detectDesktopPlatform(device)).toBe(expected);
});

const manifest = {
  version: "1.2.3",
  platforms: {
    "darwin-aarch64": { url: "https://example.com/ky-im-macos-universal.app.tar.gz" },
    "darwin-x86_64": { url: "https://example.com/ky-im-macos-universal.app.tar.gz" },
    "windows-x86_64": { url: "https://example.com/ky-im-windows-x64-setup.exe" },
  },
};

it("offers installable files instead of the macOS updater archive", () => {
  expect(parseClientRelease(manifest)).toEqual({ version: "1.2.3", downloads: {
    macos: "https://example.com/ky-im-macos-universal.dmg",
    windows: "https://example.com/ky-im-windows-x64-setup.exe",
  } });
  expect(parseClientRelease({ ...manifest, downloads: { macos: "https://cdn.example.com/mac.dmg" } }).downloads.macos)
    .toBe("https://cdn.example.com/mac.dmg");
});

it.each([undefined, "", "  "])("defaults to same-origin /api/latest when unset: %j", (value) => {
  vi.stubEnv("VITE_API_LATEST", value);
  vi.stubEnv("VITE_SIGNAL_URL", "wss://signal.example/api/ws");
  expect(clientManifestRequestUrl()).toBe("/api/latest");
});

it.each(["https://cdn.example.com/releases/latest.json?channel=stable", "/releases/latest.json"])(
  "loads the configured manifest independently of signaling: %s", async (url) => {
    vi.stubEnv("VITE_API_LATEST", `  ${url}  `);
    vi.stubEnv("VITE_SIGNAL_URL", "invalid signaling URL");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => manifest });
    vi.stubGlobal("fetch", fetchMock);
    const { loadClientRelease } = await import("./client-downloads");
    await expect(loadClientRelease()).resolves.toMatchObject({ version: "1.2.3" });
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: "omit", cache: "no-store" }));
  },
);

it.each([null, {}, { version: "1.2.3", platforms: { "windows-x86_64": { url: "javascript:alert(1)" } } },
  { version: "1.2.3", downloads: { macos: "https://user:password@example.com/app.dmg" } },
  { version: "1.2.3", downloads: { windows: "http://example.com/app.exe" } },
])("rejects unusable or unsafe release manifests: %j", (value) => {
  expect(() => parseClientRelease(value)).toThrow("Invalid client release");
});

it("shares successful requests and retries after a failed request", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, json: async () => manifest });
  vi.stubGlobal("fetch", fetchMock);
  const { loadClientRelease } = await import("./client-downloads");
  await expect(loadClientRelease()).rejects.toThrow();
  const one = loadClientRelease();
  expect(loadClientRelease()).toBe(one);
  await expect(one).resolves.toMatchObject({ version: "1.2.3" });
  await loadClientRelease();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
