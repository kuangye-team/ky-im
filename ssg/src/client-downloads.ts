export type DesktopPlatform = "windows" | "macos";
export type ClientRelease = {
  version: string;
  downloads: Partial<Record<DesktopPlatform, string>>;
};

export function detectDesktopPlatform(device: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform: string };
}): DesktopPlatform | undefined {
  const platform = device.userAgentData?.platform || device.platform || "";
  // iPadOS can advertise itself as a Mac; mobile devices have no desktop client.
  if (/Android|iPhone|iPad|iPod/i.test(device.userAgent) ||
      (/Mac/i.test(platform) && (device.maxTouchPoints || 0) > 1)) return;
  if (/Win/i.test(platform) || /Windows/i.test(device.userAgent)) return "windows";
  if (/Mac/i.test(platform) || /Macintosh/i.test(device.userAgent)) return "macos";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function installerUrl(value: unknown, platform: DesktopPlatform): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return;
    // Existing release manifests contain the signed macOS updater archive.
    // The release pipeline publishes its matching DMG alongside it.
    if (platform === "macos") url.pathname = url.pathname.replace(/\.app\.tar\.gz$/, ".dmg");
    if (!(platform === "macos" ? /\.dmg$/i : /\.(exe|msi)$/i).test(url.pathname)) return;
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
  if (typeof manifest.version !== "string" || !manifest.version.trim() || !Object.keys(downloads).length)
    throw new Error("Invalid client release");
  return { version: manifest.version, downloads };
}

let pending: Promise<ClientRelease> | undefined;
export function clientManifestRequestUrl(): string {
  return import.meta.env.VITE_API_LATEST?.trim() || "/api/latest";
}

export function loadClientRelease(): Promise<ClientRelease> {
  // Share a successful request between repeated hover/focus events; failures can be retried.
  return pending ??= Promise.resolve().then(() => fetch(clientManifestRequestUrl(), {
    signal: AbortSignal.timeout(12_000),
    credentials: "omit",
    cache: "no-store",
  })).then(async (response) => {
    if (!response.ok) throw new Error("Client release unavailable");
    return parseClientRelease(await response.json());
  }).catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
}
