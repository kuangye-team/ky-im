# Configuration reference

English | [简体中文](option.zh.md) · [Project overview](../README.md)

## Choose the configuration file

For a source checkout, copy `.env.json.example` to `.env.json` once. Edit the section for your deployment and run `npm run init` from the repository root. Initialization applies your overrides to the templates and regenerates the files below. Keep persistent changes in the JSON file or its source templates. [Combined example](../.env.json.example)

| Deployment | Section in `.env.json` | Generated files and when they apply |
| --- | --- | --- |
| Local development | `local.api`, `local.ssg` | `api/.env.local`, `ssg/.env.local` for the API and Vite dev server |
| Native server and production website | `production.api`, `production.ssg` | `api/.env.production` for the native build and preview, `ssg/.env.production` for the web build |
| Docker built from source | `compose.root`, `compose.api`, `compose.ssg` | Root `.env` combines the host port and registry with frontend build arguments. `api/.env.compose` configures the running server. Initialization also writes `ssg/.env.compose`. |
| Desktop | `desktop.app`, `desktop.ssg` | `app/.env` configures packaging, `ssg/.env.desktop` configures the frontend. Desktop commands refresh these files and process environment values take precedence. |
| Cloudflare | `wrangler.api`, `wrangler.ssg` | `api/wrangler.jsonc` supplies Worker runtime variables. The frontend build reads `vars` from `ssg/wrangler.jsonc` in Cloudflare mode. |

For a **prebuilt Docker image**, copy `docker/.env.example` to `docker/.env` and reapply changes with `docker compose up -d` from `docker/`. For an **extracted server package**, the startup script creates `release/.env` on first launch. Use literal `KEY=value` lines without quotes, `export`, or inline comments, then restart the service. Both files are maintained independently of `npm run init`. [Docker template](../docker/.env.example) · [Server package template](../release/.env.example)

## Signaling service

The native service reads these settings at startup. The table gives values from the distributed examples where they differ by deployment. [API template](../api/.env.example)

| Option | Value and effect |
| --- | --- |
| `BIND_ADDR` | Native HTTP and WebSocket listener. The local and production source examples use `127.0.0.1:8080`. Containers and server packages use `0.0.0.0:8080`. |
| `STATIC_DIR` | Website assets, relative to the service's working directory or an absolute path. The source example uses `../ssg/dist` when started from `api/`, Docker uses `/app/static`, and the server package uses `./dist`. |
| `CORS_ORIGINS` | Comma-separated exact origins, without paths or trailing slashes. For separate hosting, add the website origin (e.g. `https://chat.example.com`). The templates include the desktop WebView origins. |
| `API_AUTH` | Optional full authorization value, such as `Bearer your-key`. Empty allows access without a key. The combined example contains a demonstration key. Replace or clear it before deployment. With a key set, clients authenticate in the first WebSocket message and requests to `/api/health/details` require the header. The website and `/api/health` remain public. |
| `TRUST_PROXY_HEADERS` | Enables source-IP discovery grouping behind a reverse proxy. Source examples set it to `true`. Prebuilt Docker and server package templates use `false`. Enable only behind a controlled proxy that restricts direct access and strips or replaces forwarded IP headers, including `Forwarded`. Workers use the IP supplied by Cloudflare. |
| `RELAY_ENABLED` | Defaults to `false`. Enabling it allows two peers to opt in to an encrypted relay on the same server. |
| `MAX_CONNECTIONS` | Native connection limit, including sockets awaiting registration. Range 2–4096. Source and server package examples use 4096. On Workers this is a global health warning threshold. |
| `MAX_ROOMS` | Native discovery group limit. Range 1–256. Source and server package examples use 256. On Workers this is a global health warning threshold. |
| `MAX_PEERS_PER_ROOM` | Device limit for each discovery room and number group. Default 128, native range 2–512. Workers admit at most 128 per group. |
| `LATEST_JSON_URL` | Upstream desktop release manifest served at `/api/latest`. Defaults to the project's `releases/latest/download/latest.json` on GitHub. |

For a public native deployment, serve HTTPS and forward `/api` to the service, including WebSocket upgrades on `/api/ws`. For example, if the website is at `https://chat.example.com` and the API at `https://signal.example.com`, set the client's `VITE_SIGNAL_URL` to `wss://signal.example.com/api/ws` and include `https://chat.example.com` in the API's `CORS_ORIGINS`.

## Web and desktop clients

The frontend embeds `VITE_*` values during the build. Rebuild the website, image, or desktop installer to distribute new defaults. A preset access key or TURN password is readable by anyone with the built client, including values supplied through a CI secret. Users can override server and ICE settings on their device. [Frontend template](../ssg/.env.example)

| Option | Value and effect |
| --- | --- |
| `VITE_SIGNAL_URL` | Default signaling WebSocket URL. Empty uses same-origin `/api/ws` on the web and `ws://127.0.0.1:8080/api/ws` in a packaged desktop app. The production, desktop, and Worker sections of the combined example specify a hosted URL. |
| `VITE_API_AUTH` | Preset key for the default server, including same-origin signaling. Use the full `API_AUTH` value to supply the key with the client, or leave it empty and configure access on each device. |
| `VITE_ROOM` | Discovery namespace. Defaults to `local`. Use 1–64 ASCII letters, digits, underscores, or hyphens. Automatic discovery groups devices by namespace and observed source IP. Access control is configured separately. |
| `VITE_ICE_SERVERS` | Comma-separated STUN/TURN URLs. When unset, uses STUN servers from Xiaomi, Bilibili, Cloudflare, and Google. An explicitly empty string disables external ICE servers. For credentials use e.g. `turn:turn.example.com:3478?u=user&p=password`, with special characters URL-encoded. |
| `VITE_API_LATEST` | Release manifest endpoint. Defaults to `/api/latest`. A full URL on another origin requires that origin to allow the request. |
| `VITE_WEB_URL` | Public web app and fallback invitation URL. Defaults to `https://im.kuangye.team/`. |
| `VITE_CLIENT_DOWNLOAD_URL` | Desktop download page. Defaults to this repository's latest GitHub release. |
| `VITE_P2P_ANNOUNCE_LOOPBACK` | Defaults to `false`. For same-machine tests, set it to `true` under `desktop.ssg` in `.env.json` and restart desktop development or rebuild the app. The desktop uses interface netmasks to filter IPv4 subnet and broadcast addresses and keeps valid hosts ending in `.0`. |
| `VITE_PEER_CHECK_INTERVAL_MS` | Interval for checking devices in the list. Default 10000 ms, range 1000–300000 ms. |
| `VITE_SHOW_TRANSFER_SPEED` | Defaults to `true`. Set to `false` to hide the transfer speed. |
| `WEB_PORT`, `API_HOST` | Vite development port and proxy target for `/api`. Defaults are `5173` and `http://127.0.0.1:8080`. The desktop development port is fixed at `1420`. |

### File and WebRTC tuning

All sizes below are in bytes. Local disk reads, file payloads, and WebRTC messages are different units of work. [File transfer architecture](arch.md#file-transfers-and-data-ownership)

| Option | Default | Meaning |
| --- | ---: | --- |
| `VITE_RTC_MAX_MESSAGE_SIZE` | 65536 | Cap for one WebRTC message, range 1–131072. Each send also respects both peers' limits and the negotiated SCTP limit. |
| `VITE_RTC_MAX_BUFFERED_AMOUNT` | 1048576 | High-water mark for the WebRTC send queue. Allow space for at least one maximum-size message. |
| `VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD` | 262144 | Low-water mark that wakes waiting senders as the queue drains. |
| `VITE_RTC_FILE_CHUNK_SIZE` | 262144 | Payload per large-file block on the unordered WebRTC channel, range 1–1048576. |
| `VITE_MACOS_SEND_ACTIVITY` | `true` | macOS marks active sends of files over 2 MiB as user-initiated work and allows idle sleep. Set to `false` in `desktop.ssg` to disable. |
| `VITE_WINDOWS_SEND_ACTIVITY` | `true` | Windows requests HighQoS during active sends of files over 2 MiB and allows idle sleep. Set to `false` in `desktop.ssg` to disable. |
| `VITE_STORAGE_CHUNK_SIZE` | 2097152 | Local file I/O block size. Choose a multiple of 131072 between 131072 and 16777216 inclusive. |

## Build and Docker options

| Option | Where to set it | Meaning |
| --- | --- | --- |
| `RELEASE_VERSION` | Build environment, or the build's API, frontend, or desktop section | Application release embedded in the web app, desktop app, and API. Local builds default to `0.1.0`. Source Docker builds use `compose.ssg.RELEASE_VERSION` for both build stages. Set it in the Rust build environment when compiling the Worker API. |
| `SERVER_PORT` | `compose.root` or `docker/.env` | Host port mapped to container port 8080. Defaults to 8080. |
| `NPM_REGISTRY` | `compose.root` | npm registry used to build the image. Defaults to `https://registry.npmjs.org/`. |
| `IMAGE_NAME`, `IMAGE_TAG` | `docker/.env` | Prebuilt image repository and tag. The repository template uses `kyteam/ky-im:latest`. Packaged templates pin the release tag. |

The prebuilt image serves the frontend and signaling at the same origin. To distribute different frontend defaults, set `compose.ssg`, generate the notices with `npm run prepare`, and rebuild with `npm run compose`. When testing locally with OrbStack, run `npm run init` and `docker --context orbstack compose up -d --build` from the repository root. [Source Compose file](../compose.yml) · [Image Compose file](../docker/compose.yml)

## Cloudflare Workers

Set Worker names and domain routes in the Wrangler templates. In `.env.json`, set `wrangler.api.CORS_ORIGINS` to include the frontend origin and `wrangler.ssg.VITE_SIGNAL_URL` to the API's public WebSocket URL. When the frontend and API have separate domains, point `wrangler.ssg.VITE_API_LATEST` at the API's full manifest URL or route `/api/latest` there. For a Wrangler-managed secret, remove `API_AUTH` from `wrangler.api` and configure that secret on the API Worker. [API template](../api/wrangler.jsonc.example) · [Website template](../ssg/wrangler.jsonc.example)

After source setup, install the Worker build tools and log in. The deploy command generates both configurations, builds the web assets, and deploys the API and website.

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
(cd api && npx wrangler login)
npm run deploy
```

Use `npm run deploy:api` or `npm run deploy:ssg` to deploy separately. Redeploy the website after changing frontend defaults. The API exposes a global snapshot at `/api/health/details` and live room counts at `/api/health/details?room=<name>@<ip>`.

## Desktop packaging

Set packaging values in `desktop.app` or in the build process environment. Keep private keys and passwords outside version control. Frontend defaults for the installer belong in `desktop.ssg`. [Desktop template](../app/.env.example)

| Option | Purpose |
| --- | --- |
| `TAURI_UPDATER_URL` | Required HTTPS update manifest URL. The template points to the project's GitHub release manifest. |
| `TAURI_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` | Required updater verification key and matching signing key. Supply the public key contents and keep the private key in a secure file or build secret. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for an encrypted updater signing key. |
| `RELEASE_NOTES`, `TAURI_RELEASE_BASE_URL` | Update manifest notes and optional HTTPS directory containing the signed downloads. |
| `GITHUB_REPOSITORY` | Repository used to construct release download URLs when no base URL is specified. |
| `CARGO_TARGET_DIR` | Cargo output directory. Desktop builds default to `temp/cache/cargo` relative to the repository root. |
| `APPLE_SIGNING_IDENTITY` | macOS code-signing identity. OS signing and updater signing use separate keys. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple account, app-specific password, and team for macOS notarization. |

For a universal macOS installer, run `rustup target add aarch64-apple-darwin x86_64-apple-darwin` first. On macOS or Windows, run `npm run desktop:build` to write installers, signed update artifacts, checksums, and the update manifest to `app/dist/`.

For GitHub Actions desktop releases, use the repository's **Settings → Secrets and variables → Actions**. The workflow passes repository settings into the build, independently of your local files. [Release workflow](../.github/workflows/release.yml)

| Actions source | Desktop frontend options |
| --- | --- |
| Secret first, then Variable | `VITE_SIGNAL_URL`, `VITE_API_AUTH`, `VITE_ROOM`, `VITE_ICE_SERVERS`, `VITE_API_LATEST`, `VITE_STORAGE_CHUNK_SIZE` |
| Variable | `VITE_WEB_URL`, `VITE_CLIENT_DOWNLOAD_URL`, `VITE_RTC_MAX_MESSAGE_SIZE`, `VITE_RTC_MAX_BUFFERED_AMOUNT`, `VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD`, `VITE_RTC_FILE_CHUNK_SIZE`, `VITE_MACOS_SEND_ACTIVITY`, `VITE_WINDOWS_SEND_ACTIVITY`, `VITE_SHOW_TRANSFER_SPEED` |

With no repository overrides, Actions uses an empty signaling URL and preset key, the `local` namespace, and the ICE and transfer defaults listed above. Store the updater signing key and its password in Actions Secrets.
