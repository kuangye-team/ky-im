import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { THEME_CONFIG, readThemePreference } from "../theme-config";
import { Modal } from "./Modal";
import { syncDesktopTheme } from "../desktop-window";
import { themeIcons } from "virtual:app-icons";

export function ThemeSelector() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(readThemePreference);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = THEME_CONFIG.options.find((theme) => theme.id === selected)!;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = current.id;
    syncDesktopTheme(current);
    root.style.colorScheme = current.scheme;
    for (const [name, value] of Object.entries(current.colors)) {
      root.style.setProperty(name, value);
    }
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", current.colors["--header-start"]);
    document
      .querySelector('link[rel="icon"]')
      ?.setAttribute("href", themeIcons[current.id].favicon);
    root.style.setProperty("--brand-bird", `url("${themeIcons[current.id].bird}")`);
    try {
      localStorage.setItem(THEME_CONFIG.storageKey, current.id);
    } catch {
      // The current session can still change themes when storage is unavailable.
    }
  }, [current]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="theme-trigger"
        aria-label={t("切换主题")}
        aria-description={t("正在使用 {{theme}}", { theme: t(current.name) })}
        title={t("切换主题")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Palette size={16} aria-hidden="true" />
        <span>{t(current.name)}</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        onCloseAutoFocus={() => trigger.current?.focus()}
        title={t("换一种心情")}
        description={t("选一套喜欢的配色，让每次相遇都有好心情。")}
        className="theme-modal"
      >
        <div className="theme-grid" role="group" aria-label={t("选择主题")}>
          {THEME_CONFIG.options.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className="theme-card"
              aria-label={t(theme.name)}
              aria-pressed={selected === theme.id}
              onClick={() => setSelected(theme.id)}
            >
              <span
                className="theme-preview"
                data-theme={theme.id}
                style={theme.colors as CSSProperties}
                aria-hidden="true"
              >
                <span className="theme-preview-bar">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="theme-preview-body">
                  <span className="theme-preview-nav">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="theme-preview-chat">
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
              </span>
              <span className="theme-card-copy">
                <span>
                  <strong>{t(theme.name)}</strong>
                  <small>{t(theme.description)}</small>
                </span>
                <span className="theme-card-check" aria-hidden="true">
                  {selected === theme.id && (
                    <Check size={13} strokeWidth={2.5} />
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="theme-modal-footer">
          <span className="theme-current" role="status">
            <Check size={15} aria-hidden="true" />
            {t("正在使用 {{theme}}", { theme: t(current.name) })}
          </span>
          <button
            type="button"
            className="primary-button"
            onClick={() => setOpen(false)}
          >
            <Check size={16} aria-hidden="true" />
            {t("就用这个")}
          </button>
        </div>
      </Modal>
    </>
  );
}
