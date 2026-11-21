/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module "virtual:app-icons" {
  export const themeIcons: Record<import("./theme-config").ThemeId, {
    favicon: string;
    bird: string;
  }>;
  export const pngIcons: {
    app192: string;
    app512: string;
    appMaskable512: string;
    appleTouch: string;
  };
}

/** 构建时写入前端资源的公开配置。 */
interface ImportMetaEnv {
  /** Application release version, injected by Vite from RELEASE_VERSION. */
  readonly RELEASE_VERSION?: string;
  /** Comma-separated ICE URLs; absent uses built-ins, empty disables external servers. */
  readonly VITE_ICE_SERVERS?: string;
  /** List liveness interval in milliseconds, default 10000; range 1000–300000. */
  readonly VITE_PEER_CHECK_INTERVAL_MS?: string;
  /** Public Web app URL, also used as the desktop invitation fallback. */
  readonly VITE_WEB_URL?: string;
  /** Public download page, used by download and manual update links. */
  readonly VITE_CLIENT_DOWNLOAD_URL?: string;
  readonly VITE_ANDROID?: boolean;
  readonly VITE_DESKTOP?: boolean;
  readonly TAURI_ENV_PLATFORM?: string;
  readonly VITE_DESKTOP_UPDATER_ENABLED?: string;
  /** 自动发现命名空间，默认 local。 */
  readonly VITE_ROOM?: string;
  /** 完整 ws(s):// 信令地址；空值使用同源 /api/ws。 */
  readonly VITE_SIGNAL_URL?: string;
  /** 默认服务器访问密钥，与 VITE_SIGNAL_URL 配套，空地址时用于同源服务器。 */
  readonly VITE_API_AUTH?: string;
  readonly VITE_API_LATEST?: string;
  /** RTC 单条消息的产品上限，单位字节。 */
  readonly VITE_RTC_MAX_MESSAGE_SIZE?: string;
  readonly VITE_RTC_MAX_BUFFERED_AMOUNT?: string;
  readonly VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD?: string;
  readonly VITE_RTC_FILE_CHUNK_SIZE?: string;
  readonly VITE_P2P_ANNOUNCE_LOOPBACK?: string;
  readonly VITE_MACOS_SEND_ACTIVITY?: string;
  readonly VITE_WINDOWS_SEND_ACTIVITY?: string;
  /** 本地文件读取与存储分块大小，单位字节，默认 2 MiB。 */
  readonly VITE_STORAGE_CHUNK_SIZE?: string;
  /** Show file transfer speed; defaults to true, false hides it. */
  readonly VITE_SHOW_TRANSFER_SPEED?: string;
}
