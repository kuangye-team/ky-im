import { detectDevice, type DeviceHints } from "./device-platform";
import { CLIENT_CONFIG } from "./config";

export type DesktopPlatform = "windows" | "macos";
export type ClientPlatform = DesktopPlatform | "android";
export type ClientRelease = {
  version: string;
  downloads: Partial<Record<ClientPlatform, string>>;
};

export function detectDesktopPlatform(device: DeviceHints): DesktopPlatform | undefined {
  const platform = detectDevice(device);
  if (platform === "Win") return "windows";
  if (platform === "Mac") return "macos";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function installerUrl(value: unknown, platform: ClientPlatform): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return;
    // Existing release manifests contain the signed macOS updater archive.
    // The release pipeline publishes its matching DMG alongside it.
    if (platform === "macos") url.pathname = url.pathname.replace(/\.app\.tar\.gz$/, ".dmg");
    const extension = { macos: /\.dmg$/i, windows: /\.(exe|msi)$/i, android: /\.apk$/i }[platform];
    if (!extension.test(url.pathname)) return;
    return url.href;
  } catch { return; }
}

export function parseClientRelease(value: unknown): ClientRelease {
  const manifest = record(value);
  const platforms = record(manifest.platforms);
  const installers = record(manifest.downloads);
  const downloads: ClientRelease["downloads"] = {};
  for (const platform of ["windows", "macos"] as const) {
    const entry = record(platforms[platform === "windows" ? "windows-x86_64" : "darwin-aarch64"]);
    const url = installerUrl(installers[platform], platform) || installerUrl(entry.url, platform);
    if (url) downloads[platform] = url;
  }
  const apk = installerUrl(installers.android, "android");
  if (apk) downloads.android = apk;
  if (typeof manifest.version !== "string" || !manifest.version.trim() || !Object.keys(downloads).length)
    throw new Error("Invalid client release");
  return { version: manifest.version, downloads };
}

export function clientManifestRequestUrl(): string {
  const endpoint = import.meta.env.VITE_API_LATEST?.trim() || "/api/latest";
  // The Android WebView serves bundled assets, while the public site serves /api/latest.
  return import.meta.env.VITE_ANDROID ? new URL(endpoint, CLIENT_CONFIG.webUrl).href : endpoint;
}

export async function fetchClientRelease(): Promise<ClientRelease> {
  const response = await fetch(clientManifestRequestUrl(), {
    signal: AbortSignal.timeout(12_000),
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Client release unavailable");
  return parseClientRelease(await response.json());
}

let pending: Promise<ClientRelease> | undefined;
export function loadClientRelease(): Promise<ClientRelease> {
  // Share a successful request between repeated hover/focus events; failures can be retried.
  return pending ??= fetchClientRelease().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
}
