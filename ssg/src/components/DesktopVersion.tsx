import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { ChatEngine } from "../core";
import { isDesktop } from "../core/network/settings";
import { beforeAppUpdate } from "../app-updates";
import { siteInfo } from "../site-info";
import {
  applyAppUpdate, checkDesktopUpdate, desktopUpdaterEnabled,
  getAppUpdate, loadDesktopVersion, subscribeAppUpdate,
} from "../desktop-updates";
import "./DesktopVersion.css";

export function DesktopVersion({ engine }: { engine: ChatEngine }) {
  return isDesktop() ? <Version engine={engine} /> : null;
}

function Version({ engine }: { engine: ChatEngine }) {
  const { t } = useTranslation();
  const update = useSyncExternalStore(subscribeAppUpdate, getAppUpdate);
  // Transfer state also changes while the About dialog is open.
  useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  useEffect(() => { void loadDesktopVersion(); }, []);
  const busy = engine.hasPendingTransfers();
  const status = !desktopUpdaterEnabled ? "此版本暂不支持在线更新"
    : update.installed ? "更新已安装，请关闭并重新打开蜂鸟。"
    : update.updating ? "正在更新…"
    : update.checking ? "正在检查更新…"
    : update.checkError || (update.available ? "有新版本可更新" : update.checked ? "已是最新版本" : "尚未检查更新");
  const releases = `${siteInfo.repository}/releases/latest`;
  const error = update.error === "内容传输中，请完成后再更新。" && !busy ? "" : update.error;
  const openReleases = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(releases);
    } catch {
      // Keep a user-visible error in the version panel; never navigate the WebView.
      setLinkError(t("链接暂时无法打开，请稍后重试。"));
    }
  };
  const [linkError, setLinkError] = useState("");
  return (
    <section className="about-version" aria-label={t("应用版本")}>
      <div className="about-version-info" role="status" aria-atomic="true">
        <span className="about-current-version">{t("当前版本")}
          <strong>{update.currentVersion ? `v${update.currentVersion}` : t(update.versionError ? "暂时无法读取版本" : "读取中…")}</strong>
        </span>
        <span className={`about-update-status${update.available ? " has-update" : ""}`}>{t(status)}</span>
        {update.available && <span>{t("可更新至 {{version}}", { version: `v${update.version}` })}</span>}
      </div>
      <div className="about-version-actions">
        <button className="secondary-button"
          disabled={!desktopUpdaterEnabled || update.checking || update.updating || update.installed}
          onClick={() => { void loadDesktopVersion(); void checkDesktopUpdate({ manual: true }); }}>
          {update.checking ? <LoaderCircle size={16} className="update-banner-spinner" /> : <RefreshCw size={16} />}
          {t(update.checking ? "正在检查更新…" : "检查更新")}
        </button>
        {(update.available || !desktopUpdaterEnabled) && <button className="secondary-button"
          onClick={() => { setLinkError(""); void openReleases(); }}>
          {t("前往更新")}<ArrowUpRight size={16} />
        </button>}
        {update.available && <button className="primary-button"
          disabled={busy || update.updating || update.checking}
          onClick={() => void applyAppUpdate(() => beforeAppUpdate(engine))}>
          <RefreshCw size={16} />{t(update.updating ? "正在更新…" : "更新并重启")}
        </button>}
      </div>
      {(error || linkError || (busy && update.available)) && <p className="about-version-error" role="alert">
        {t(error || linkError || "内容传输中，请完成后再更新。")}
      </p>}
    </section>
  );
}
