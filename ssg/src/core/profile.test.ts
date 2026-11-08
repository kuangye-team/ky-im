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

const adapters: IndexedDBStorageAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

describe("localized generated profiles", () => {
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
      expect(profile.device).toBe(copy.browser);
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
