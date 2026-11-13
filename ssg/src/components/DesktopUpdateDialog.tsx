import { useRef, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cancelAppUpdate, getAppUpdate, subscribeAppUpdate } from "../desktop-updates";
import "./DesktopUpdateDialog.css";

export function DesktopUpdateDialog() {
  const { t } = useTranslation();
  const update = useSyncExternalStore(subscribeAppUpdate, getAppUpdate);
  const previousFocus = useRef<HTMLElement | null>(null);
  const canCancel = update.phase === "downloading" || update.phase === "retrying";
  const status = update.phase === "installing" ? "正在安装更新…"
    : update.phase === "restarting" ? "正在重启蜂鸟…"
    : update.phase === "retrying" ? "连接中断，正在重试…"
    : update.phase === "cancelling" ? "正在取消…" : "正在下载更新…";
  const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <Dialog.Root open={update.updating} onOpenChange={(open) => { if (!open && canCancel) cancelAppUpdate(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay desktop-update-overlay" />
        <Dialog.Content className="modal desktop-update-dialog"
          onOpenAutoFocus={() => { previousFocus.current = document.activeElement as HTMLElement | null; }}
          onCloseAutoFocus={(event) => { event.preventDefault(); previousFocus.current?.focus(); }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => { if (!canCancel) event.preventDefault(); }}>
          <div className="desktop-update-heading">
            <span className="desktop-update-icon" aria-hidden="true"><Download size={24} /></span>
            <div>
              <Dialog.Title>{t("正在更新蜂鸟")}</Dialog.Title>
              <Dialog.Description>{t("可更新至 {{version}}", { version: `v${update.version}` })}</Dialog.Description>
            </div>
          </div>
          <div className="desktop-update-status" role="status">
            <span><LoaderCircle size={16} className="desktop-update-spinner" aria-hidden="true" />{t(status)}</span>
            {update.progress !== null && <strong>{update.progress}%</strong>}
          </div>
          <div className="desktop-update-progress" role="progressbar" aria-label={t("更新下载进度")}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={update.progress ?? undefined}
            aria-valuetext={update.progress === null ? t(status) : `${update.progress}%`}>
            <div className={update.progress === null ? "is-indeterminate" : ""}
              style={update.progress === null ? undefined : { width: `${update.progress}%` }} />
          </div>
          <p className="desktop-update-detail">
            {canCancel && update.downloadedBytes > 0
              ? `${size(update.downloadedBytes)}${update.totalBytes ? ` / ${size(update.totalBytes)}` : ""}`
              : t("更新完成后，蜂鸟将自动重启。")}
          </p>
          <div className="desktop-update-footer">
            <p>{t(canCancel || update.phase === "cancelling" ? "取消后可以继续使用，稍后再更新。" : "安装即将完成，请稍候。")}</p>
            <button className="secondary-button" disabled={!canCancel} onClick={cancelAppUpdate}>
              {t(update.phase === "cancelling" ? "正在取消…" : "取消更新")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
