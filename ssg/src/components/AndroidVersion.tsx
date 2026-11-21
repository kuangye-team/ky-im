import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { checkAndroidUpdate, type AndroidUpdate } from "../android-updates";
import { openExternalUrl } from "../external-links";
import "./DesktopVersion.css";

type CheckState = AndroidUpdate | { status: "idle" | "checking" | "error" };

export function AndroidVersion() {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState<string | null>();
  const [update, setUpdate] = useState<CheckState>({ status: "idle" });
  const [linkFailed, setLinkFailed] = useState(false);
  useEffect(() => {
    void getVersion().then(setInstalled, () => setInstalled(null));
  }, []);

  async function check() {
    setLinkFailed(false);
    setUpdate({ status: "checking" });
    try {
      const version = installed ?? await getVersion();
      setInstalled(version);
      setUpdate(await checkAndroidUpdate(version));
    } catch {
      setUpdate({ status: "error" });
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
      <button className="secondary-button" disabled={installed === undefined || checking} onClick={check}>
        {checking ? <LoaderCircle size={16} className="update-banner-spinner" /> : <RefreshCw size={16} />}
        {t(checking ? "正在检查更新…" : "检查更新")}
      </button>
      {update.status === "available" && <button className="primary-button" onClick={() => {
        setLinkFailed(false);
        void openExternalUrl(update.url).catch(() => setLinkFailed(true));
      }}>
        <Download size={16} />{t("下载新版本")}
      </button>}
    </div>
    {linkFailed && <p className="about-version-error" role="alert">{t("链接暂时无法打开，请稍后重试。")}</p>}
  </section>;
}
