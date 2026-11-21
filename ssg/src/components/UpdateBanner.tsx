import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ChatEngine } from "../core";
import { beforeAppUpdate } from "../app-updates";
import { isDesktop } from "../core/network/settings";
import {
  applyAppUpdate,
  dismissAppUpdate,
  getAppUpdate,
  subscribeAppUpdate,
} from "../app-updates";
import "./UpdateBanner.css";

export function UpdateBanner({ engine, compact = false }: { engine: ChatEngine; compact?: boolean }) {
  const { t } = useTranslation();
  const update = useSyncExternalStore(subscribeAppUpdate, getAppUpdate);
  const banner = useRef<HTMLElement>(null);
  const visible = update.available && !update.dismissed;
  const busy = engine.hasPendingTransfers();
  const busyMessage = "内容传输中，请完成后再更新。";
  const error = update.error === busyMessage && !busy ? "" : update.error;
  const notice = busy ? busyMessage : error;
  useLayoutEffect(() => {
    const element = banner.current;
    const shell = element?.parentElement;
    if (!element || !shell) return;
    const measure = () =>
      shell.style.setProperty(
        "--update-banner-height",
        `${element.getBoundingClientRect().height + 12}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--update-banner-height");
    };
  }, [visible]);
  if (!visible) return null;
  const beforeReload = () => beforeAppUpdate(engine);
  return (
    <section ref={banner} className={compact ? "update-banner update-banner-compact" : "update-banner"} aria-label={t(isDesktop() ? "应用更新" : "网站更新")}>
      <span className="update-banner-icon" aria-hidden="true">
        <RefreshCw size={20} />
      </span>
      <div className="update-banner-copy" role="status" aria-atomic="true">
        <strong>{t(compact ? "有新版本" : "蜂鸟有新版本了")}</strong>
        {!compact && <p>{t(notice || (isDesktop() ? "更新完成后，蜂鸟将自动重启。" : "更新后即可使用，页面将重新加载。"))}</p>}
      </div>
      <div className="update-banner-actions">
        <button
          className="update-banner-later"
          aria-label={t("稍后")}
          title={t("稍后")}
          disabled={update.updating}
          onClick={dismissAppUpdate}
        >
          {compact ? <X size={18} aria-hidden="true" /> : t("稍后")}
        </button>
        <button
          className="primary-button"
          disabled={busy || update.updating}
          onClick={() => void applyAppUpdate(beforeReload)}
        >
          {update.updating && (
            <LoaderCircle
              size={15}
              className="update-banner-spinner"
              aria-hidden="true"
            />
          )}
          {t(update.updating ? "正在更新…" : isDesktop() ? "更新并重启" : "更新并刷新")}
        </button>
      </div>
      {compact && notice && <p className="update-banner-notice" role="status">{t(notice)}</p>}
    </section>
  );
}
