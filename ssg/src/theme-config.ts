/** Shared by the first-paint script and the theme picker. */
export const THEME_CONFIG = {
  storageKey: "hummingbird.theme",
  defaultTheme: "sky",
  options: [
    {
      id: "sky",
      name: "晴空蓝",
      description: "清透蓝白，轻快如初",
      scheme: "light",
      colors: {
        "--primary": "#4b61ee",
        "--primary-hover": "#3d50d5",
        "--primary-end": "#7185f5",
        "--header-start": "#4565ed",
        "--header-end": "#4f6ff1",
        "--page": "#f5f8ff",
        "--surface": "#ffffff",
        "--surface-soft": "#f8f9fd",
        "--surface-muted": "#f0f2f8",
        "--text": "#2f334b",
        "--text-secondary": "#646d86",
        "--muted": "#7b849b",
        "--line": "#e9edf5",
        "--border": "#dce2ee",
      },
    },
    {
      id: "forest",
      name: "松间绿",
      description: "一抹松绿，放慢片刻",
      scheme: "light",
      colors: {
        "--primary": "#287c67",
        "--primary-hover": "#206653",
        "--primary-end": "#49a48b",
        "--header-start": "#246957",
        "--header-end": "#388774",
        "--page": "#f1f6f2",
        "--surface": "#ffffff",
        "--surface-soft": "#f7faf7",
        "--surface-muted": "#edf3ed",
        "--text": "#2e4138",
        "--text-secondary": "#5d7568",
        "--muted": "#74897b",
        "--line": "#e3ece4",
        "--border": "#d3e0d6",
      },
    },
    {
      id: "sunset",
      name: "落日杏",
      description: "杏色暖光，温柔相伴",
      scheme: "light",
      colors: {
        "--primary": "#b65d3c",
        "--primary-hover": "#9e4a2c",
        "--primary-end": "#d58b60",
        "--header-start": "#aa553b",
        "--header-end": "#c77b53",
        "--page": "#fbf5ee",
        "--surface": "#fffdfa",
        "--surface-soft": "#fcf8f2",
        "--surface-muted": "#f4ece2",
        "--text": "#49372f",
        "--text-secondary": "#816858",
        "--muted": "#957b69",
        "--line": "#f0e6db",
        "--border": "#e5d7c7",
      },
    },
    {
      id: "night",
      name: "静夜紫",
      description: "深夜微光，安静自在",
      scheme: "dark",
      colors: {
        "--primary": "#a99afa",
        "--primary-hover": "#bcaeff",
        "--primary-end": "#b8a8ff",
        "--header-start": "#292542",
        "--header-end": "#37304f",
        "--page": "#171923",
        "--surface": "#222431",
        "--surface-soft": "#262836",
        "--surface-muted": "#2e3040",
        "--text": "#eeedf6",
        "--text-secondary": "#b8b7cd",
        "--muted": "#9c9db5",
        "--line": "#343646",
        "--border": "#45465b",
      },
    },
  ],
} as const;

export type ThemeId = (typeof THEME_CONFIG.options)[number]["id"];

export function isThemeId(value: unknown): value is ThemeId {
  return THEME_CONFIG.options.some((theme) => theme.id === value);
}

export function readThemePreference(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_CONFIG.storageKey);
    return isThemeId(saved) ? saved : THEME_CONFIG.defaultTheme;
  } catch {
    return THEME_CONFIG.defaultTheme;
  }
}
