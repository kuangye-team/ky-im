import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  readSettings,
  saveSettings,
  validateSettings,
} from "./settings";

afterEach(() => vi.unstubAllGlobals());
describe("network settings", () => {
  it("persists per-server authorization including the default and rejects invalid headers", () => {
    const settings = defaultSettings(false);
    settings.servers[0].authorization = "Bearer secret";
    settings.servers.push({
      id: "custom",
      name: "Private",
      url: "wss://private.test/api/ws",
      enabled: true,
      authorization: "Bearer other",
    });
    const stored = validateSettings(settings, false);
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(stored) });
    expect(readSettings(false).servers.map((s) => s.authorization)).toEqual([
      "Bearer secret",
      "Bearer other",
    ]);
    for (const authorization of [
      "key\nInjected: header",
      "中文",
      "x".repeat(4097),
      123,
    ]) {
      settings.servers[0].authorization = authorization as string;
      expect(() => validateSettings(settings, false)).toThrow(
        "访问密钥格式不正确",
      );
    }
  });
  it("requires a successful capability test before enabling relay and retains per-server consent", () => {
    const settings = defaultSettings(false);
    expect(settings.servers[0].relay).not.toBe(true);
    for (const relaySupported of [undefined, false]) {
      expect(() =>
        validateSettings(
          {
            ...settings,
            servers: [{ ...settings.servers[0], relay: true, relaySupported }],
          },
          false,
        ),
      ).toThrow("请先测试服务器");
    }
    const next = {
      ...settings,
      servers: [{ ...settings.servers[0], relay: true, relaySupported: true }],
    };
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(next) });
    expect(readSettings(false).servers[0]).toMatchObject({
      relay: true,
      relaySupported: true,
    });
  });
  it("accepts all nine desktop discovery/transport combinations", () => {
    for (const [signaling, mdns] of [
      [true, false],
      [false, true],
      [true, true],
    ])
      for (const [tcp, webrtc] of [
        [true, false],
        [false, true],
        [true, true],
      ])
        expect(
          validateSettings(
            {
              ...defaultSettings(true),
              discovery: { signaling, mdns },
              transport: { tcp, webrtc },
            },
            true,
          ),
        ).toBeTruthy();
  });
  it("requires a discovery method, a transport, and an enabled server when using signaling", () => {
    const settings = defaultSettings(true);
    expect(() =>
      validateSettings(
        { ...settings, discovery: { signaling: false, mdns: false } },
        true,
      ),
    ).toThrow("至少选择");
    expect(() =>
      validateSettings(
        { ...settings, transport: { tcp: false, webrtc: false } },
        true,
      ),
    ).toThrow("至少选择");
    expect(() =>
      validateSettings(
        { ...settings, servers: [{ ...settings.servers[0], enabled: false }] },
        true,
      ),
    ).toThrow("至少启用");
    expect(
      validateSettings(
        {
          ...settings,
          servers: [{ ...settings.servers[0], enabled: false }],
          discovery: { signaling: false, mdns: true },
        },
        true,
      ),
    ).toBeTruthy();
    expect(() => validateSettings(settings, false)).toThrow("网页版");
  });
  it("validates server addresses, duplicate entries, and secure browser origins", () => {
    const settings = defaultSettings(false);
    for (const url of [
      "https://example.com",
      "not an address",
      "ws://user:pass@example.com",
      "ws://example.com/#token",
    ])
      expect(() =>
        validateSettings(
          {
            ...settings,
            servers: [
              settings.servers[0],
              { ...settings.servers[0], id: "custom", url },
            ],
          },
          false,
        ),
      ).toThrow("完整");
    expect(() =>
      validateSettings(
        {
          ...settings,
          servers: [settings.servers[0], { ...settings.servers[0], id: "two" }],
        },
        false,
      ),
    ).toThrow("已经添加");
    vi.stubGlobal("location", { protocol: "https:" });
    expect(() =>
      validateSettings(
        {
          ...settings,
          servers: [
            settings.servers[0],
            { ...settings.servers[0], id: "custom", url: "ws://example.com" },
          ],
        },
        false,
      ),
    ).toThrow("安全地址");
  });
  it("rejects adding the same-origin default server again by its full address", () => {
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173" });
    const settings = defaultSettings(false);
    expect(() =>
      validateSettings(
        {
          ...settings,
          servers: [
            settings.servers[0],
            {
              ...settings.servers[0],
              id: "duplicate",
              url: "ws://localhost:5173/api/ws",
            },
          ],
        },
        false,
      ),
    ).toThrow("已经添加");
  });
  it("protects the default server even when bypassing the settings UI", () => {
    const settings = defaultSettings(false);
    for (const servers of [
      [],
      [{ ...settings.servers[0], name: "changed" }],
      [{ ...settings.servers[0], url: "wss://evil.example/api/ws" }],
      [settings.servers[0], settings.servers[0]],
    ]) {
      expect(() => validateSettings({ ...settings, servers }, false)).toThrow(
        "默认服务器不能修改或删除",
      );
    }
    const custom = {
      id: "custom",
      name: "Custom",
      url: "wss://example.com/api/ws",
      enabled: true,
    };
    expect(
      validateSettings(
        {
          ...settings,
          servers: [{ ...settings.servers[0], enabled: false }, custom],
        },
        false,
      ).servers[0].enabled,
    ).toBe(false);
  });
  it("restores a previously edited or removed default without losing custom servers", () => {
    const settings = defaultSettings(false);
    const custom = {
      id: "custom",
      name: "Custom",
      url: "wss://example.com/api/ws",
      enabled: true,
    };
    for (const servers of [
      [custom],
      [
        {
          ...settings.servers[0],
          name: "edited",
          url: "wss://old.example/api/ws",
          enabled: false,
        },
        custom,
      ],
    ]) {
      vi.stubGlobal("localStorage", {
        getItem: () => JSON.stringify({ ...settings, servers }),
      });
      const restored = readSettings(false);
      expect(restored.servers).toEqual([
        { ...settings.servers[0], enabled: servers.length === 1 },
        custom,
      ]);
      expect(validateSettings(restored, false)).toEqual(restored);
    }
  });
  it("recovers from corrupt stored data and never reports a failed write as saved", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "bad json",
      setItem: () => {
        throw Error("quota");
      },
    });
    expect(readSettings(false)).toEqual(defaultSettings(false));
    expect(() => saveSettings(defaultSettings(false))).toThrow("设置未保存");
  });
});
