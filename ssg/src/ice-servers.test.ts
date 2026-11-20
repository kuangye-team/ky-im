import { afterEach, describe, expect, it, vi } from "vitest";
import { activeIceServers, DEFAULT_ICE_SERVER_URLS, iceServersFromEnv, parseIceServerAddresses, validateIceServers } from "./ice-servers";
import { defaultSettings, readSettings } from "./core/network/settings";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("ICE configuration", () => {
  it("uses the four defaults only when absent; trims, deduplicates and honors empty input", () => {
    expect(iceServersFromEnv(undefined).map((s) => s.urls)).toEqual(DEFAULT_ICE_SERVER_URLS);
    expect(iceServersFromEnv(" , STUN:one.test:3478,stun:one.test:3478,stun:two.test:19302, "))
      .toEqual([{ urls: "stun:one.test:3478" }, { urls: "stun:two.test:19302" }]);
    expect(iceServersFromEnv("")).toEqual([]);
    expect(parseIceServerAddresses("stun:one.test\nstuns:two.test，stun:[::1]:3478")).toHaveLength(3);
  });

  it("passes comma-separated build configuration into RTC defaults", async () => {
    vi.stubEnv("VITE_ICE_SERVERS", "stun:env-one.test:3478?u=alice&p=secret,stun:env-two.test:19302");
    vi.resetModules();
    const { CONNECTION_CONFIG } = await import("./config");
    expect(CONNECTION_CONFIG.rtc.iceServers).toEqual([
      { urls: "stun:env-one.test:3478", username: "alice", credential: "secret" }, { urls: "stun:env-two.test:19302" },
    ]);
  });

  it("extracts env credentials for every scheme, decodes them and preserves TURN transport", () => {
    for (const scheme of ["stun", "stuns", "turn", "turns"]) {
      const transport = scheme.startsWith("turn") ? "transport=TCP&" : "";
      expect(iceServersFromEnv(`${scheme.toUpperCase()}:HOST:3478?${transport}p=%20Pa%26ss%2B%2C%3F%23%3D%20&u=%E7%94%A8%E6%88%B7%40example.com`)).toEqual([{
        urls: `${scheme}:host:3478${transport ? "?transport=tcp" : ""}`,
        username: "用户@example.com", credential: " Pa&ss+,?#= ",
      }]);
    }
    expect(iceServersFromEnv("turn:host?u=alice&transport=udp&p=secret"))
      .toEqual([{ urls: "turn:host?transport=udp", username: "alice", credential: "secret" }]);
    expect(iceServersFromEnv("stun:host?u=&p=,stun:HOST?u=ignored&p=ignored"))
      .toEqual([{ urls: "stun:host", username: "", credential: "" }]);
    expect(iceServersFromEnv("stun:host?u=only,stuns:host?p=pass"))
      .toEqual([{ urls: "stun:host", username: "only" }, { urls: "stuns:host", credential: "pass" }]);
    expect(() => iceServersFromEnv("stun:host?u=alice&unknown=value")).toThrow();
    expect(() => iceServersFromEnv("stun:host?u=alice&transport=udp")).toThrow();
    expect(() => iceServersFromEnv(`stun:host?p=${"x".repeat(4097)}`)).toThrow("账号或密码");
  });

  it("persists STUN management fields and only passes enabled connection fields to WebRTC", () => {
    const servers = validateIceServers([
      { urls: "STUN:Host:3478", name: "  My helper  ", enabled: false, username: "alice", credential: " secret " },
      { urls: "stuns:backup:5349", name: "Backup", enabled: true, username: "bob", credential: "backup" },
      { urls: "stun:legacy" },
    ]);
    expect(servers[0]).toEqual({ urls: "stun:host:3478", name: "My helper", enabled: false, username: "alice", credential: " secret " });
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ ...defaultSettings(false), iceServers: servers }) });
    expect(readSettings(false).iceServers).toEqual(servers);
    expect(activeIceServers(readSettings(false).iceServers)).toEqual([
      { urls: "stuns:backup:5349", username: "bob", credential: "backup" }, { urls: "stun:legacy" },
    ]);
  });

  it("rejects invalid URI schemes, credentials in URLs, paths, ports and oversized lists", () => {
    for (const value of ["https://bad.test", "stun://bad.test", "stun:", "stun:host:0", "stun:host:65536",
      "stun:user:pass@host", "stun:host/path", "stun:host#hash", "stun:host?transport=udp", "turn:host?transport=sctp"])
      expect(() => iceServersFromEnv(value), value).toThrow();
    expect(() => iceServersFromEnv(Array.from({ length: 17 }, (_, i) => `stun:${i}.test`).join(","))).toThrow("16");
    expect(() => validateIceServers([{ urls: "stun:host" }, { urls: "stun:host" }])).toThrow("已经添加");
    expect(() => validateIceServers([{ urls: "turn:host", credential: 42 }])).toThrow("账号或密码");
  });

  it("keeps TURN credentials when editing addresses and normalizes blank credentials", () => {
    expect(parseIceServerAddresses("turns:relay.test:5349?transport=tcp", [
      { urls: "turns:relay.test:5349?transport=tcp", username: "user", credential: " secret " },
    ])).toEqual([{ urls: "turns:relay.test:5349?transport=tcp", username: "user", credential: " secret " }]);
    expect(iceServersFromEnv("turn:relay.test")).toEqual([{ urls: "turn:relay.test", username: "", credential: "" }]);
  });

});

it("validates TURN management fields without changing password whitespace", () => {
  const result = validateIceServers([{ urls: "TURNS:Relay.Test:5349?transport=tcp", name: "  My relay  ", enabled: false, username: "alice", credential: " secret " }]);
  expect(result).toEqual([{ urls: "turns:relay.test:5349?transport=tcp", name: "My relay", enabled: false, username: "alice", credential: " secret " }]);
  for (const invalid of [{ name: 1 }, { name: "x".repeat(81) }, { enabled: "false" }])
    expect(() => validateIceServers([{ urls: "turn:host", ...invalid }])).toThrow();
});
