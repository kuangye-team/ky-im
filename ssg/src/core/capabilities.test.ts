import { describe, expect, it } from "vitest";
import { CAP, CompatibilityError, commonCapabilities, configuredRuntime, isRuntimeInfo, localRuntime, availableTransports, requireCapabilities, requirePeer, requireServer } from "./capabilities";

describe("runtime capability policies", () => {
  it("uses a stable catalog and accepts bounded unknown future capabilities", () => {
    expect(new Set(Object.values(CAP)).size).toBe(Object.keys(CAP).length);
    for (const capability of Object.values(CAP)) expect(capability).toMatch(/\.v1$/);
    expect(isRuntimeInfo({ version: "2.3.0-beta.1", capabilities: ["vendor.feature.v7"] })).toBe(true);
    for (const capabilities of [[CAP.chat, CAP.chat], ["file"], ["FILE.v1"], ["file.v0"], Array(65).fill(CAP.chat)])
      expect(isRuntimeInfo({ version: "1.0.0", capabilities })).toBe(false);
    expect(isRuntimeInfo({ version: "", capabilities: [] })).toBe(false);
  });
  it("does not infer protocol support from release version or client label", () => {
    const peer = { version: "999.0.0", capabilities: [CAP.query, CAP.chat, CAP.webrtc] };
    expect(requirePeer(localRuntime(true), peer)).toEqual([CAP.webrtc]);
    expect(() => requirePeer(localRuntime(), { ...peer, capabilities: [CAP.query] })).toThrow(CompatibilityError);
  });
  it("reports the common transport set without a priority policy", () => {
    const peer = { version: "0.1.0", capabilities: [CAP.relay, CAP.webrtc, CAP.tcp] };
    expect(new Set(availableTransports(localRuntime(true), peer))).toEqual(new Set([CAP.tcp, CAP.webrtc, CAP.relay]));
    expect(new Set(availableTransports(localRuntime(false), peer))).toEqual(new Set([CAP.webrtc, CAP.relay]));
  });
  it("uses WebTransport only between a listening desktop and a dialing browser", () => {
    const runtime = (role: string) => ({version: "1", capabilities: [role, CAP.query, CAP.chat, CAP.webtransport]});
    const desktop = runtime(CAP.app), web = runtime(CAP.web);
    expect(requirePeer(web, desktop)).toEqual([CAP.webtransport]);
    expect(requirePeer(desktop, web)).toEqual([CAP.webtransport]);
    expect(availableTransports(web, web)).toEqual([]);
    expect(availableTransports(desktop, desktop)).toEqual([]);
    expect(configuredRuntime(true, {transport: {tcp: false, webrtc: true}, servers: []}).capabilities)
      .not.toContain(CAP.webtransport);
  });
  it("separates minimum requirements from optional resume", () => {
    const peer = { ...localRuntime(), capabilities: [CAP.query, CAP.chat, CAP.file, CAP.webrtc] };
    expect(() => requireCapabilities(localRuntime(), peer, [CAP.file])).not.toThrow();
    expect(commonCapabilities(localRuntime(), peer)).not.toContain(CAP.resume);
    expect(() => requireCapabilities(localRuntime(), peer, [CAP.folder])).toThrow(CompatibilityError);
  });
  it("distinguishes local, remote and server requirements", () => {
    try { requireCapabilities({ version: "0.1.0", capabilities: [] }, localRuntime(), [CAP.chat]); }
    catch (error) { expect((error as CompatibilityError).reasons).toEqual(["local-update"]); }
    try { requireServer({ version: "2.0.0", capabilities: [CAP.query] }); }
    catch (error) { expect((error as CompatibilityError).reasons).toEqual(["server-update", "server-unsupported"]); }
    expect(() => requireServer({ relay: true, relayVersion: 2 })).toThrow(CompatibilityError);
  });
  it("advertises enabled transport methods and preserves optional feature support", () => {
    const info = configuredRuntime(true, { transport: { tcp: false, webrtc: true }, servers: [] });
    expect(info.capabilities).not.toContain(CAP.tcp);
    expect(info.capabilities).not.toContain(CAP.relay);
    expect(info.capabilities).toContain(CAP.resume);
    expect(info.capabilities).toContain(CAP.webrtc);
  });
});
