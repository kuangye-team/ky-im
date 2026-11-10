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
  readonly VITE_DESKTOP?: boolean;
  readonly VITE_DESKTOP_UPDATER_ENABLED?: string;
  /** 自动发现命名空间，默认 local。 */
  readonly VITE_ROOM?: string;
  /** 完整 ws(s):// 信令地址；空值使用同源 /api/ws。 */
  readonly VITE_SIGNAL_URL?: string;
  /** 默认服务器访问密钥，与 VITE_SIGNAL_URL 配套，空地址时用于同源服务器。 */
  readonly VITE_API_AUTH?: string;
  /** 本地文件读取与存储分块大小，单位字节，默认 2 MiB。 */
  readonly VITE_STORAGE_CHUNK_SIZE?: string;
}
