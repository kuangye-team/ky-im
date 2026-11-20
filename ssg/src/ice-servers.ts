export type IceServer = {
  urls: string;
  username?: string;
  credential?: string;
  name?: string;
  enabled?: boolean;
};

export const DEFAULT_ICE_SERVER_URLS = [
  "stun:stun.miwifi.com:3478",
  "stun:stun.chat.bilibili.com:3478",
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
];
export const MAX_ICE_SERVERS = 16;
export const isTurnServer = (url: string) => /^turns?:/i.test(url);

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("辅助服务器地址不正确，请检查后重试");
  const match = /^(stun|stuns|turn|turns):([^\s/?#@]+)(\?transport=(udp|tcp))?$/i.exec(value.trim());
  if (!match || (match[3] && !/^turn/i.test(match[1])))
    throw new Error("辅助服务器地址需以 stun:、stuns:、turn: 或 turns: 开头");
  let address: URL;
  try {
    // Validate hostname, IPv4/IPv6 and port without relying on the opaque ICE URI parser.
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(match[2])) throw Error();
    address = new URL(`http://${match[2]}`);
    if (!address.hostname || address.port === "0") throw Error();
  } catch {
    throw new Error("辅助服务器地址不正确，请检查后重试");
  }
  // Preserve explicit ports (URL would remove :80).
  return `${match[1].toLowerCase()}:${match[2].toLowerCase()}${match[3]?.toLowerCase() ?? ""}`;
}

export function validateIceServers(value: unknown): IceServer[] {
  if (!Array.isArray(value) || value.length > MAX_ICE_SERVERS)
    throw new Error("辅助服务器最多可添加 16 个");
  const urls = new Set<string>();
  return value.map((entry) => {
    const url = normalizeUrl(entry?.urls);
    if (urls.has(url)) throw new Error("这个辅助服务器地址已经添加过了");
    urls.add(url);
    if ([entry.username, entry.credential].some((value) =>
      value !== undefined && (typeof value !== "string" || value.length > 4096),
    )) throw new Error("辅助服务器的账号或密码不正确");
    if (entry.name !== undefined && (typeof entry.name !== "string" || entry.name.length > 80))
      throw new Error("服务器名称最多 80 个字");
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
      throw new Error("服务器启用状态不正确");
    return {
      urls: url,
      ...(entry.username !== undefined || isTurnServer(url) ? { username: entry.username ?? "" } : {}),
      ...(entry.credential !== undefined || isTurnServer(url) ? { credential: entry.credential ?? "" } : {}),
      ...(entry.name !== undefined ? { name: entry.name.trim() } : {}),
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    };
  });
}

/** Only connection fields reach WebRTC; names and switches stay on this device. */
export function rtcIceServer(server: IceServer): RTCIceServer {
  return {
    urls: server.urls,
    ...(server.username !== undefined || isTurnServer(server.urls) ? { username: server.username ?? "" } : {}),
    ...(server.credential !== undefined || isTurnServer(server.urls) ? { credential: server.credential ?? "" } : {}),
  };
}

export function activeIceServers(servers: readonly IceServer[]): RTCIceServer[] {
  return servers.filter((server) => server.enabled !== false).map(rtcIceServer);
}

/** A blank value deliberately disables external servers; missing env uses defaults. */
export function iceServersFromEnv(value: string | undefined): IceServer[] {
  return parseIceServerAddresses(value ?? DEFAULT_ICE_SERVER_URLS.join(","));
}

export function parseIceServerAddresses(value: string, previous: IceServer[] = []): IceServer[] {
  const servers = new Map<string, IceServer>();
  for (const address of value.split(/[,，\r\n]+/).map((url) => url.trim()).filter(Boolean)) {
    const queryIndex = address.indexOf("?");
    const base = queryIndex < 0 ? address : address.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex < 0 ? "" : address.slice(queryIndex + 1));
    const username = params.get("u");
    const credential = params.get("p");
    params.delete("u");
    params.delete("p");
    const query = params.toString();
    // Credentials are separate WebRTC fields, never part of the displayed/used URL.
    const urls = normalizeUrl(username !== null || credential !== null ? `${base}${query ? `?${query}` : ""}` : address);
    if (!servers.has(urls)) servers.set(urls, {
      ...previous.find((server) => server.urls === urls),
      urls,
      ...(username !== null ? { username } : {}),
      ...(credential !== null ? { credential } : {}),
    });
  }
  return validateIceServers([...servers.values()]);
}
