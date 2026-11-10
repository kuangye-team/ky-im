import { SIGNALING_CONFIG } from "../../config";

export type SignalServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authorization?: string;
  relay?: boolean;
  relaySupported?: boolean;
};
export type NetworkSettings = {
  servers: SignalServer[];
  discovery: { signaling: boolean; mdns: boolean };
  transport: { tcp: boolean; webrtc: boolean };
};
export const NETWORK_SETTINGS_KEY = "hummingbird.network.v1";
export const DEFAULT_SERVER_ID = "default";
export const isDesktop = () => Boolean(import.meta.env.VITE_DESKTOP);

export function defaultSettings(desktop = isDesktop()): NetworkSettings {
  const localServer =
    desktop &&
    import.meta.env.DEV &&
    typeof location !== "undefined" &&
    location.host
      ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`
      : "ws://127.0.0.1:8080/api/ws";
  return {
    servers: [
      {
        id: DEFAULT_SERVER_ID,
        name: "",
        url: SIGNALING_CONFIG.url || (desktop ? localServer : ""),
        authorization: SIGNALING_CONFIG.authorization || undefined,
        enabled: true,
      },
    ],
    discovery: { signaling: true, mdns: desktop },
    transport: { tcp: desktop, webrtc: true },
  };
}

export function validateSettings(
  value: NetworkSettings,
  desktop = isDesktop(),
): NetworkSettings {
  if (
    !value ||
    !Array.isArray(value.servers) ||
    value.servers.length > 16 ||
    !value.discovery ||
    !value.transport ||
    [
      value.discovery.signaling,
      value.discovery.mdns,
      value.transport.tcp,
      value.transport.webrtc,
    ].some((flag) => typeof flag !== "boolean")
  )
    throw new Error("配置格式不正确，请重新设置");
  if (!value.discovery.signaling && !value.discovery.mdns)
    throw new Error("请至少选择一种查找设备的方式");
  if (!value.transport.tcp && !value.transport.webrtc)
    throw new Error("请至少选择一种传输方式");
  if (
    !desktop &&
    (value.discovery.mdns ||
      value.transport.tcp ||
      !value.discovery.signaling ||
      !value.transport.webrtc)
  )
    throw new Error("网页版使用在线查找和兼容传输，其他方式请使用客户端");
  const builtIn = defaultSettings(desktop).servers[0];
  const defaults = value.servers.filter(
    (server) => server?.id === DEFAULT_SERVER_ID,
  );
  if (
    defaults.length !== 1 ||
    defaults[0].name !== builtIn.name ||
    defaults[0].url !== builtIn.url
  )
    throw new Error("默认服务器不能修改或删除");
  const ids = new Set<string>();
  const addresses = new Set<string>();
  const servers = value.servers.map((server) => {
    if (
      !server ||
      typeof server.id !== "string" ||
      !server.id ||
      ids.has(server.id) ||
      typeof server.name !== "string" ||
      server.name.length > 80 ||
      typeof server.url !== "string" ||
      server.url.length > 2048 ||
      typeof server.enabled !== "boolean" ||
      (server.relay !== undefined && typeof server.relay !== "boolean") ||
      (server.relaySupported !== undefined &&
        typeof server.relaySupported !== "boolean")
    )
      throw new Error("服务器信息不完整，请检查名称和地址");
    if (
      server.authorization !== undefined &&
      (typeof server.authorization !== "string" ||
        server.authorization.length > 4096 ||
        !/^[\x20-\x7e]*$/.test(server.authorization))
    )
      throw new Error("访问密钥格式不正确，请重新填写");
    ids.add(server.id);
    if (server.relay && server.relaySupported !== true)
      throw new Error("请先测试服务器，确认支持中转后再开启");
    let url = server.url.trim();
    if (!url && desktop) throw new Error("客户端需要填写完整的服务器地址");
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("请输入完整的 ws:// 或 wss:// 服务器地址");
      }
      if (
        !["ws:", "wss:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new Error("请输入完整的 ws:// 或 wss:// 服务器地址");
      if (
        !desktop &&
        typeof location !== "undefined" &&
        location.protocol === "https:" &&
        parsed.protocol !== "wss:"
      )
        throw new Error("当前网页需要使用 wss:// 安全地址");
      url = parsed.href;
    }
    const address =
      url ||
      SIGNALING_CONFIG.url ||
      (typeof location !== "undefined" && location.host
        ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`
        : "");
    const key = address ? new URL(address).href : "";
    if (addresses.has(key)) throw new Error("这个服务器地址已经添加过了");
    addresses.add(key);
    return {
      ...server,
      name: server.name.trim(),
      authorization: server.authorization?.trim(),
      url: server.id === DEFAULT_SERVER_ID ? builtIn.url : url,
    };
  });
  if (value.discovery.signaling && !servers.some((server) => server.enabled))
    throw new Error("使用在线查找时，请至少启用一个服务器");
  return {
    servers,
    discovery: { ...value.discovery },
    transport: { ...value.transport },
  };
}

export function readSettings(desktop = isDesktop()): NetworkSettings {
  try {
    const raw = localStorage.getItem(NETWORK_SETTINGS_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as NetworkSettings;
      if (Array.isArray(stored?.servers)) {
        // Older versions allowed editing/removing the built-in entry. Restore its
        // build-time address on load while retaining the user's enabled choice.
        const previous = stored.servers.find(
          (server) => server?.id === DEFAULT_SERVER_ID,
        );
        const builtIn = defaultSettings(desktop).servers[0];
        stored.servers = [
          {
            ...builtIn,
            enabled:
              typeof previous?.enabled === "boolean"
                ? previous.enabled
                : builtIn.enabled,
            ...(previous?.url === builtIn.url
              ? {
                  authorization: previous.authorization ?? builtIn.authorization,
                  relay: previous.relay,
                  relaySupported: previous.relaySupported,
                }
              : {}),
          },
          ...stored.servers.filter(
            (server) => server?.id !== DEFAULT_SERVER_ID,
          ),
        ];
      }
      return validateSettings(stored, desktop);
    }
  } catch {
    /* Invalid or unavailable storage uses working defaults. */
  }
  return defaultSettings(desktop);
}

export function saveSettings(value: NetworkSettings): NetworkSettings {
  const settings = validateSettings(value);
  try {
    localStorage.setItem(NETWORK_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    throw new Error("设置未保存，请重试");
  }
  return settings;
}
