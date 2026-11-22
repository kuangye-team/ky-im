import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Download, ExternalLink, LoaderCircle, PackageOpen, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { checkAndroidUpdate, type AndroidUpdate } from "../android-updates";
import { openExternalUrl } from "../external-links";
import "./DesktopVersion.css";

type CheckState = AndroidUpdate | { status: "idle" | "checking" | "error" };

export function AndroidVersion() {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState<string | null>();
  const [update, setUpdate] = useState<CheckState>({ status: "idle" });
  const [download, setDownload] = useState<"idle" | "downloading" | "ready">("idle");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void getVersion().then(setInstalled, () => setInstalled(null));
  }, []);

  async function check() {
    setDownload("idle");
    setNotice("");
    setUpdate({ status: "checking" });
    try {
      const version = installed ?? await getVersion();
      setInstalled(version);
      setUpdate(await checkAndroidUpdate(version));
    } catch {
      setUpdate({ status: "error" });
    }
  }

  async function downloadApk() {
    if (update.status !== "available") return;
    setDownload("downloading");
    setNotice("");
    try {
      await invoke("plugin:apk-update|download", { version: update.version, url: update.url });
      setDownload("ready");
    } catch (error) {
      setDownload("idle");
      setNotice((error as { code?: string } | null)?.code === "INVALID_APK"
        ? "这个安装包与当前应用或更新版本不匹配，请重新检查更新。"
        : "更新包未能下载，请重试或用浏览器下载。");
    }
  }

  async function chooseInstaller() {
    if (update.status !== "available") return;
    setNotice("");
    try {
      await invoke("plugin:apk-update|choose_installer", { version: update.version });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "CACHE_MISS") {
        setDownload("idle");
        setNotice("更新包已清理，请重新下载。");
      } else {
        setNotice("暂时无法打开安装器，请重试或用浏览器下载。");
      }
    }
  }

  const checking = update.status === "checking";
  return <section className="about-version" aria-label={t("应用版本")}>
    <div className="about-version-info" role="status" aria-atomic="true">
      <span className="about-current-version">{t("当前版本")}
        <strong>{installed ? `v${installed}` : t(installed === null ? "暂时无法读取版本" : "读取中…")}</strong>
      </span>
      {update.status === "available" && <span className="about-update-status has-update">
        {t("可更新至 {{version}}", { version: `v${update.version}` })}
      </span>}
      {update.status === "current" && <span>{t("已是最新版本")}</span>}
      {update.status === "unpublished" && <span>{t("本次发布未提供 Android 安装包。")}</span>}
      {update.status === "error" && <span>{t("暂时无法检查更新，请稍后重试。")}</span>}
    </div>
    <div className="about-version-actions">
      <button className="secondary-button" disabled={installed === undefined || checking || download === "downloading"} onClick={check}>
        {checking ? <LoaderCircle size={16} className="update-banner-spinner" /> : <RefreshCw size={16} />}
        {t(checking ? "正在检查更新…" : "检查更新")}
      </button>
      {update.status === "available" && <>
        <button className="primary-button" disabled={download === "downloading"}
          onClick={download === "ready" ? chooseInstaller : downloadApk}>
          {download === "downloading" ? <LoaderCircle size={16} className="update-banner-spinner" /> : download === "ready" ? <PackageOpen size={16} /> : <Download size={16} />}
          {t(download === "ready" ? "选择安装器" : download === "downloading" ? "正在下载更新…" : "在应用内下载")}
        </button>
        <button className="secondary-button" onClick={() => {
          setNotice("");
          void openExternalUrl(update.url).catch(() => setNotice("链接暂时无法打开，请稍后重试。"));
        }}><ExternalLink size={16} />{t("用浏览器下载")}</button>
      </>}
    </div>
    {download === "ready" && <p className="about-version-error" role="status">{t("更新包已下载。你可以选择安装器继续，也可以稍后安装。")}</p>}
    {notice && <p className="about-version-error" role="alert">{t(notice)}</p>}
  </section>;
}
