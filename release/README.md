# ky-im release archive

English | [简体中文](README.zh.md)

Download `ky-im-<version>.tar.gz` from GitHub Releases and extract it into a writable directory. The archive includes the website and signaling service; native startup requires no Node.js, Rust, or Docker. A matching `.sha256` file is provided for download verification.

## Contents

```text
docker/
  compose.yml
  .env.example
release/
  README.md
  README.zh.md
  start_win.bat
  start_linux.sh
  start_mac.sh
  .env.example
  dist/
  bin/
    server_darwin_amd64
    server_darwin_arm64
    server_linux_amd64
    server_linux_arm64
    server_windows_amd64.exe
LICENSE
```

## Run on your host

Run the command for your platform from the extracted directory, or double-click `release/start_win.bat` on Windows:

| Platform | Command | Architectures |
| --- | --- | --- |
| Windows | `.\release\start_win.bat` | x64 / amd64 |
| Linux | `sh release/start_linux.sh` | x64 / amd64, ARM64 |
| macOS | `sh release/start_mac.sh` | Intel, Apple Silicon |

Linux and macOS launchers detect the architecture automatically. Open <http://localhost:8080>; press Ctrl+C to stop. Other devices can use `http://HOST_IP:8080` if the firewall allows it. For public hosting, use a reverse proxy with HTTPS and WebSocket forwarding for `/api/ws`.

The first launch copies `release/.env.example` to `release/.env`; existing configuration is preserved. Edit this file and restart to apply changes. It is independent of the source repository's `.env.json` and requires no `npm run init`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `BIND_ADDR` | `0.0.0.0:8080` | Listening address and port |
| `STATIC_DIR` | `./dist` | Frontend directory, relative to `release/` |
| `CORS_ORIGINS` | Empty | Same-origin browser access by default; separate allowed origins with commas |
| `TRUST_PROXY_HEADERS` | `false` | Enable only behind a trusted reverse proxy |
| `MAX_CONNECTIONS` | `4096` | Maximum connections, range 2–4096 |
| `MAX_ROOMS` | `256` | Maximum discovery groups, range 1–256 |
| `MAX_PEERS_PER_ROOM` | `128` | Maximum devices per group, range 2–512 |

Use literal `KEY=value` lines without quotes, `export`, or inline comments. Comments start with `#` on their own line; values may contain spaces. File settings override process environment variables. The bundled frontend uses `VITE_ROOM=local` and same-origin signaling; changing `VITE_*` requires rebuilding it from source.

To update, stop the service, extract the new archive into a new directory, copy your old `release/.env` into it, and start the new version.

## Run with Docker

From the extracted directory:

```sh
cd docker
cp .env.example .env
docker compose pull
docker compose up -d
```

On Windows, use `copy .env.example .env`. Preserve any existing `.env`. Set `IMAGE_NAME` for the image repository, `IMAGE_TAG` for the version, and `SERVER_PORT` for the host port. The archive defaults to its release's image tag; wait for the separate Docker publishing workflow to succeed before using it. Run `docker compose down` to stop.

## Package from source

Pushing a `v<major>.<minor>.<patch>` tag triggers GitHub Actions to build the frontend, license notices, and five native binaries, verify the launchers, and publish the archive and checksum. The optional `DOCKERHUB_IMAGE` secret selects the Docker repository, defaulting to `kyteam/ky-im`.

For local packaging, place all five compiled binaries in `release/bin/` and the built frontend, including `licenses/`, in `release/dist/`. Run from the repository root:

```sh
node scripts/package-release.mjs v0.2.20
```

This creates `artifacts/ky-im-0.2.20.tar.gz` and `.tar.gz.sha256`, excluding local `release/.env` and `docker/.env` files. Run `node scripts/test-release.mjs` to verify your platform's binary, launcher, configuration loading, and web service.
