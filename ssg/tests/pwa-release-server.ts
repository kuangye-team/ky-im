import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

export const test = base.extend<{
  releaseServer: Awaited<ReturnType<typeof startReleaseServer>>;
}>({
  releaseServer: async ({}, use) => {
    const server = await startReleaseServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },
  baseURL: async ({ releaseServer }, use) => {
    await use(releaseServer.origin);
  },
});

/** Serve real production assets, changing the HTML precache revision like a deployment. */
async function startReleaseServer() {
  const root = fileURLToPath(new URL("../dist/", import.meta.url));
  const originalHTML = await readFile(resolve(root, "index.html"), "utf8");
  const originalSW = await readFile(resolve(root, "sw.js"), "utf8");
  let release = 1;
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
  };
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, "http://localhost").pathname;
      if (pathname.startsWith("/api/")) {
        res.writeHead(503).end();
        return;
      }
      const file = extname(pathname) ? pathname.slice(1) : "index.html";
      const path = resolve(root, file);
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
        res.writeHead(403).end();
        return;
      }
      const html = originalHTML.replace(
        "<html",
        `<html data-release="${release}"`,
      );
      const revision = createHash("md5").update(html).digest("hex");
      const body =
        file === "index.html"
          ? html
          : file === "sw.js"
            ? originalSW.replace(
                /url:"index.html",revision:"[^"]+"/,
                `url:"index.html",revision:"${revision}"`,
              )
            : await readFile(path);
      res.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    deploy: () => {
      release += 1;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
