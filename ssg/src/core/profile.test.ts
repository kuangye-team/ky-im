import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_BIO_MAX_LENGTH,
  PROFILE_NAME_MAX_LENGTH,
  PROFILE_GENERATION_CONFIG,
} from "../config";
import { generateProfileBio, generateProfileName } from "./profile";
import { createChatEngine } from "./engine";
import { IndexedDBStorageAdapter } from "./storage";
import { isProfile } from "./protocol";
import { discoverySummary, discoveryView, fullProfile, publicProfile } from "./profile-wire";
import { rtcMessageLimit } from "./network/libp2p/rtc-limits";

const adapters: IndexedDBStorageAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

describe("localized generated profiles", () => {
  it.each([
    ["Android", { userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux armv8l" }],
    ["IOS", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }],
    ["IOS", { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }],
    ["Linux", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }],
    ["Win", { userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32" }],
    ["Mac", { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel" }],
    ["Harmony", { userAgent: "Mozilla/5.0 (Linux; Android 12; HarmonyOS)", platform: "Linux" }],
    ["Harmony", { userAgent: "Mozilla/5.0 (OpenHarmony)" }],
    ["Harmony", { userAgent: "Mozilla/5.0", userAgentData: { platform: "OHOS" } }],
  ] as const)("publishes %s through the device field", async (device, hints) => {
    vi.stubGlobal("navigator", hints);
    const adapter = new IndexedDBStorageAdapter(`device-${crypto.randomUUID()}`);
    adapters.push(adapter);
    const profile = (await createChatEngine(adapter)).getSnapshot().profile;
    expect(publicProfile(profile).runtime).toMatchObject({ device, clientType: "web" });
    expect(await adapter.getProfile()).toEqual(profile);
  });

  it.each([
    ["ios", "IOS", "mobile"], ["android", "Android", "mobile"], ["ohos", "Harmony", "mobile"],
    ["windows", "Win", "desktop"], ["darwin", "Mac", "desktop"], ["linux", "Linux", "desktop"],
  ] as const)("publishes the native %s client in full profiles and discovery", async (target, device, clientType) => {
    vi.stubEnv("VITE_DESKTOP", "true");
    vi.stubEnv("TAURI_ENV_PLATFORM", target);
    vi.stubGlobal("navigator", { userAgent: "" });
    const adapter = new IndexedDBStorageAdapter(`native-${crypto.randomUUID()}`);
    adapters.push(adapter);
    const profile = (await createChatEngine(adapter)).getSnapshot().profile;
    expect(fullProfile(publicProfile(profile))).toMatchObject({ clientType, device });
    expect(discoveryView(discoverySummary(profile, false))?.clientType).toBe(clientType);
  });

  it("refreshes an iPad previously saved as a Mac and publishes one new revision", async () => {
    vi.stubGlobal("navigator", { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 0 });
    const adapter = new IndexedDBStorageAdapter(`device-refresh-${crypto.randomUUID()}`);
    adapters.push(adapter);
    const first = (await createChatEngine(adapter)).getSnapshot().profile;
    expect(first.device).toBe("Mac");
    vi.stubGlobal("navigator", { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 });
    const refreshed = (await createChatEngine(adapter)).getSnapshot().profile;
    expect(refreshed).toEqual({ ...first, device: "IOS", revision: first.revision! + 1 });
    vi.stubGlobal("navigator", { userAgent: "" });
    expect((await createChatEngine(adapter)).getSnapshot().profile).toEqual(refreshed);
  });

  it.each([false, true])("persists the current web/desktop runtime (%s)", async (desktop) => {
    vi.stubEnv("VITE_DESKTOP", desktop ? "true" : "");
    const adapter = new IndexedDBStorageAdapter(`client-type-${crypto.randomUUID()}`);
    adapters.push(adapter);
    const first = (await createChatEngine(adapter)).getSnapshot().profile;
    expect(first.clientType).toBe(desktop ? "desktop" : "web");
    // Runtime metadata is refreshed when the same profile is opened in another client.
    vi.stubEnv("VITE_DESKTOP", desktop ? "" : "true");
    const reopened = (await createChatEngine(adapter)).getSnapshot().profile;
    expect({...reopened, maxMessageSize: reopened.maxMessageSize}).toMatchObject({ ...first, revision: first.revision! + 1, maxMessageSize: desktop ? undefined : rtcMessageLimit, capabilities: expect.any(Array), clientType: desktop ? "web" : "desktop" });
    expect(reopened.capabilities).toContain(desktop ? "client.web.v1" : "client.app.v1");
    expect(await adapter.getProfile()).toEqual(reopened);
  });
  it("keeps the last exchangeable revision when extension data exceeds a peer frame", async () => {
    const storage = new IndexedDBStorageAdapter("profile-extensions-" + crypto.randomUUID());
    adapters.push(storage);
    const engine = await createChatEngine(storage);
    const extend = { details: { count: 3, tags: ["蜂鸟"], ready: true } };
    await engine.updateProfile({ extend });
    const saved = await storage.getProfile();
    expect(saved?.extend).toEqual(extend);
    await expect(engine.updateProfile({ extend: { text: "鸟".repeat(12000) } })).rejects.toThrow("个人资料过大");
    expect(await storage.getProfile()).toEqual(saved);
    expect(engine.getSnapshot().profile.revision).toBe(saved!.revision);
  });

  it.each(["en", "zh-CN"] as const)(
    "offers every configured introduction in %s and avoids the current one",
    (language) => {
      const random = vi.spyOn(crypto, "getRandomValues");
      const bios = PROFILE_GENERATION_CONFIG.copy[language].bios;
      const generated = new Set<string>();
      for (let index = 0; index < bios.length; index++) {
        random.mockReturnValue(new Uint32Array([index]));
        const bio = generateProfileBio(language);
        generated.add(bio);
        expect(bio.length).toBeLessThanOrEqual(PROFILE_BIO_MAX_LENGTH);
        expect(generateProfileBio(language, bio)).not.toBe(bio);
        const name = generateProfileName(language);
        expect(name.length).toBeLessThanOrEqual(PROFILE_NAME_MAX_LENGTH);
        expect(name).toMatch(/ \d{2}$/);
        expect(generateProfileName(language, name)).not.toBe(name);
      }
      expect(generated.size).toBe(bios.length);
    },
  );

  it.each([
    ["system", "zh-TW", "zh-CN"],
    ["system", "fr-FR", "en"],
    ["en", "zh-CN", "en"],
    ["zh-CN", "en-US", "zh-CN"],
  ] as const)(
    "creates and persists a %s / %s profile in %s",
    async (preference, system, expected) => {
      vi.stubGlobal("localStorage", { getItem: () => preference });
      vi.stubGlobal("navigator", {
        languages: [system],
        language: system,
        userAgent: "",
      });
      const adapter = new IndexedDBStorageAdapter(
        `profile-test-${crypto.randomUUID()}`,
      );
      adapters.push(adapter);
      const engine = await createChatEngine(adapter);
      const profile = engine.getSnapshot().profile;
      const copy = PROFILE_GENERATION_CONFIG.copy[expected];
      expect(
        copy.names.some((name) => profile.name.startsWith(`${name} `)),
      ).toBe(true);
      expect(copy.bios).toContain(profile.bio);
      expect(profile.device).toBeUndefined();
      expect(isProfile(profile)).toBe(true);
      expect(await adapter.getProfile()).toEqual(profile);
      vi.stubGlobal("localStorage", {
        getItem: () => (expected === "en" ? "zh-CN" : "en"),
      });
      expect((await createChatEngine(adapter)).getSnapshot().profile).toEqual(
        profile,
      );
      await engine.updateProfile({
        name: "My own name",
        bio: "My own introduction",
      });
      expect(
        (await createChatEngine(adapter)).getSnapshot().profile,
      ).toMatchObject({ name: "My own name", bio: "My own introduction" });
    },
  );
});
