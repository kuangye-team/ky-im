import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([false, true])("uses the build key only for the default server (desktop=%s)", async (desktop) => {
  vi.resetModules();
  vi.stubEnv("VITE_API_AUTH", "  build-key  ");
  vi.stubEnv("VITE_SIGNAL_URL", "wss://default.test/api/ws");
  const { defaultSettings, readSettings } = await import("./settings");
  vi.stubGlobal("localStorage", { getItem: () => null });
  const settings = defaultSettings(desktop);
  expect(readSettings(desktop).servers[0]).toMatchObject({
    url: "wss://default.test/api/ws",
    authorization: "build-key",
  });
  settings.servers.push({ id: "custom", name: "Custom", url: "wss://custom.test/api/ws", enabled: true });
  for (const override of [undefined, "manual-key", ""]) {
    settings.servers[0].authorization = override;
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(settings) });
    expect(readSettings(desktop).servers.map((server) => server.authorization))
      .toEqual([override ?? "build-key", undefined]);
  }
  settings.servers[0].url = "wss://previous.test/api/ws";
  settings.servers[0].authorization = "previous-key";
  expect(readSettings(desktop).servers[0]).toMatchObject({
    url: "wss://default.test/api/ws",
    authorization: "build-key",
  });
});

it("also applies the build key to the same-origin default server", async () => {
  vi.resetModules();
  vi.stubEnv("VITE_API_AUTH", "same-origin-key");
  vi.stubEnv("VITE_SIGNAL_URL", "");
  const { defaultSettings } = await import("./settings");
  expect(defaultSettings(false).servers[0]).toMatchObject({
    url: "",
    authorization: "same-origin-key",
  });
});
