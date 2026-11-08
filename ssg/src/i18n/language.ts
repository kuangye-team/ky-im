import {
  LANGUAGE_CONFIG,
  type AppLanguage,
  type LanguagePreference,
} from "../config";

export function isLanguagePreference(
  value: unknown,
): value is LanguagePreference {
  return LANGUAGE_CONFIG.options.some((option) => option.value === value);
}

export function readLanguagePreference(): LanguagePreference {
  try {
    const saved = localStorage.getItem(LANGUAGE_CONFIG.storageKey);
    return isLanguagePreference(saved)
      ? saved
      : LANGUAGE_CONFIG.defaultPreference;
  } catch {
    return LANGUAGE_CONFIG.defaultPreference;
  }
}

export function resolveLanguage(
  selected: LanguagePreference,
  systemLanguage = typeof navigator === "undefined"
    ? LANGUAGE_CONFIG.fallback
    : navigator.languages?.[0] ||
      navigator.language ||
      LANGUAGE_CONFIG.fallback,
): AppLanguage {
  return selected === "system"
    ? /^zh\b/i.test(systemLanguage)
      ? "zh-CN"
      : LANGUAGE_CONFIG.fallback
    : selected;
}
