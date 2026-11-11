import type { MouseEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { handleExternalLinkClick, openExternalUrl } from "./external-links";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function click(href: string, button = 0, download = false) {
  vi.stubGlobal("window", { location: { origin: "http://tauri.localhost" } });
  const anchor = Object.assign(new URL(href), { hasAttribute: () => download });
  return { target: { closest: () => anchor }, button, preventDefault: vi.fn() } as unknown as MouseEvent<HTMLElement>;
}

it.each(["https://im.kuangye.team/", "https://www.kuangye.team/", "https://github.com/kuangye-team/ky-im", "mailto:contact@kuangye.team"])(
  "desktop links use the system opener for %s", async (url) => {
    vi.stubEnv("VITE_DESKTOP", "true");
    const event = click(url);
    handleExternalLinkClick(event, vi.fn());
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(url));
    expect(event.preventDefault).toHaveBeenCalled();
  },
);

it("handles middle clicks and reports opener failures without navigating the app", async () => {
  vi.stubEnv("VITE_DESKTOP", "true");
  openUrl.mockRejectedValueOnce(new Error("No email app"));
  const onError = vi.fn();
  const event = click("mailto:contact@kuangye.team", 1);
  handleExternalLinkClick(event, onError);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(event.preventDefault).toHaveBeenCalled();
});

it("preserves browser links, internal routes and file downloads", () => {
  const browserEvent = click("https://example.com");
  vi.stubEnv("VITE_DESKTOP", undefined);
  handleExternalLinkClick(browserEvent, vi.fn());
  expect(browserEvent.preventDefault).not.toHaveBeenCalled();
  vi.stubEnv("VITE_DESKTOP", "true");
  for (const event of [click("http://tauri.localhost/#/privacy"), click("blob:http://tauri.localhost/123", 0, true)]) {
    handleExternalLinkClick(event, vi.fn());
    expect(event.preventDefault).not.toHaveBeenCalled();
  }
  expect(openUrl).not.toHaveBeenCalled();
});

it("does not pass arbitrary protocols to the system opener", async () => {
  await expect(openExternalUrl("file:///etc/passwd")).rejects.toThrow();
  expect(openUrl).not.toHaveBeenCalled();
});
