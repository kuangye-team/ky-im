import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each([undefined, "", "262144", "4194304", "16777216"])(
  "loads bounded storage blocks from env: %s", async (value) => {
    vi.resetModules();
    vi.stubEnv("VITE_STORAGE_CHUNK_SIZE", value);
    const { STORAGE_CONFIG, CHUNK_SIZE } = await import("./config");
    expect(STORAGE_CONFIG.chunkBytes).toBe(value ? Number(value) : 2 * 1024 * 1024);
    expect(CHUNK_SIZE).toBe(128 * 1024);
  },
);

it.each(["0", "-1", "NaN", "Infinity", "1.5", "16385", "33554432"])(
  "rejects unsafe or unaligned storage blocks: %s", async (value) => {
    vi.resetModules();
    vi.stubEnv("VITE_STORAGE_CHUNK_SIZE", value);
    await expect(import("./config")).rejects.toThrow("VITE_STORAGE_CHUNK_SIZE");
  },
);
