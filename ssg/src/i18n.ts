import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { useSyncExternalStore } from "react";
import { appEnglish } from "./i18n/en";
import { bootstrapEnglish } from "./i18n/bootstrap";
import { errorEnglish } from "./i18n/errors";
import { legalEnglish } from "./i18n/legal";
import { componentEnglish } from "./components/translations";

import { LANGUAGE_CONFIG, type LanguagePreference } from "./config";
import { readLanguagePreference, resolveLanguage } from "./i18n/language";
export { resolveLanguage } from "./i18n/language";
export type { LanguagePreference } from "./config";

const listeners = new Set<() => void>();
let preference = readLanguagePreference();

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: {
    en: {
      translation: {
        ...appEnglish,
        ...bootstrapEnglish,
        ...errorEnglish,
        ...legalEnglish,
      },
      components: componentEnglish,
    },
    "zh-CN": { translation: {}, components: {} },
  },
  lng: resolveLanguage(preference),
  fallbackLng: "zh-CN",
  supportedLngs: [...LANGUAGE_CONFIG.supported],
  load: "currentOnly",
  defaultNS: "translation",
  keySeparator: false,
  nsSeparator: false,
  // The original Chinese copy is the key and also the Chinese fallback.
  interpolation: { escapeValue: false },
  initAsync: false,
  react: { useSuspense: false },
});

function updateDocumentLanguage() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = i18n.language;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute(
      "content",
      i18n.t(
        "蜂鸟，轻快连接，自在分享。无需注册，与身边的人聊天、分享照片和文件。",
      ),
    );
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();

export const getLanguagePreference = () => preference;
export function setLanguagePreference(selected: LanguagePreference) {
  preference = selected;
  try {
    localStorage.setItem(LANGUAGE_CONFIG.storageKey, selected);
  } catch {
    // Language switching also works when browser storage is unavailable.
  }
  void i18n.changeLanguage(resolveLanguage(selected));
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useLanguagePreference() {
  return useSyncExternalStore(
    subscribe,
    getLanguagePreference,
    () => LANGUAGE_CONFIG.defaultPreference,
  );
}
if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => {
    if (preference === "system")
      void i18n.changeLanguage(resolveLanguage(preference));
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== LANGUAGE_CONFIG.storageKey && event.key !== null) return;
    preference = readLanguagePreference();
    void i18n.changeLanguage(resolveLanguage(preference));
    listeners.forEach((listener) => listener());
  });
}
