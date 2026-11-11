import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  ["wss://im.ky.orb.local/api/ws", "https://im.ky.orb.local"],
  ["ws://im.ky.orb.local:8080/api/ws", "http://im.ky.orb.local:8080"],
  ["wss://user:password@im.ky.orb.local:8443/api/ws?key=secret#fragment", "https://im.ky.orb.local:8443"],
  ["ws://[::1]:8080/api/ws", "http://[::1]:8080"],
])("desktop invitations use the website origin of %s", async (signalUrl, expected) => {
  vi.stubEnv("VITE_DESKTOP", "true");
  vi.stubEnv("VITE_SIGNAL_URL", signalUrl);
  const { getInviteUrl } = await import("./invite-url");
  expect(getInviteUrl("http://localhost:1420")).toBe(expected);
  expect(getInviteUrl("tauri://localhost")).toBe(expected);
});

it.each([undefined, "", " ", "/api/ws", "not a URL", "file:///api/ws"])(
  "desktop invitations use the configured fallback for %s",
  async (signalUrl) => {
    vi.stubEnv("VITE_DESKTOP", "true");
    vi.stubEnv("VITE_SIGNAL_URL", signalUrl);
    const { getInviteUrl } = await import("./invite-url");
    const { INVITE_CONFIG } = await import("./config");
    expect(getInviteUrl("http://localhost:1420")).toBe(INVITE_CONFIG.fallbackUrl);
  },
);

it.each(["", "wss://separate-api.example/api/ws"])(
  "web invitations keep the website origin with signal URL %s",
  async (signalUrl) => {
    vi.stubEnv("VITE_DESKTOP", undefined);
    vi.stubEnv("VITE_SIGNAL_URL", signalUrl);
    const { getInviteUrl } = await import("./invite-url");
    expect(getInviteUrl("https://chat.example")).toBe("https://chat.example");
  },
);

it("uses the public Web environment setting for desktop invitation fallback", async () => {
  vi.stubEnv("VITE_DESKTOP", "true");
  vi.stubEnv("VITE_SIGNAL_URL", "");
  vi.stubEnv("VITE_WEB_URL", "https://chat.example/team/");
  const { getInviteUrl } = await import("./invite-url");
  expect(getInviteUrl("tauri://localhost")).toBe("https://chat.example/team/");
});
