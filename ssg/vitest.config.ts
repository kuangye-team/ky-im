import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({ define: { "import.meta.env.VITE_API_AUTH": JSON.stringify(""), "import.meta.env.VITE_SIGNAL_URL": JSON.stringify("") }, cacheDir: fileURLToPath(new URL("../temp/cache/vitest", import.meta.url)), test: { setupFiles: ["src/core/storage/test-opfs.ts"], include: ["src/**/*.test.ts", "build/**/*.test.ts"] } });
