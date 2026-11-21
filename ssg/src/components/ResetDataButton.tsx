import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { ChatEngine } from "../core";
import { resetAppData } from "../reset-app-data";
import { reloadApp } from "../reload";
import { translateError } from "../localizeError";
import { Modal } from "./Modal";

export function ResetDataButton({ engine, disabled, onBusy, row = false }: {
  engine: ChatEngine; disabled?: boolean; onBusy?: (busy: boolean) => void; row?: boolean;
}) {
  const { t } = useTranslation("components");
  const desktop = !!engine.storage.getStorageInfo;
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const resetInProgress = useRef(false);
  const resetCancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reset = async () => {
    if (resetInProgress.current) return;
    resetInProgress.current = true;
    setResetting(true);
    onBusy?.(true);
    setResetError("");
    try {
      await resetAppData(engine);
      await reloadApp();
    } catch (error) {
      setResetError(error instanceof Error ? error.message : "重置未完成，请重试");
      resetInProgress.current = false;
      setResetting(false);
      onBusy?.(false);
    }
  };
  return <>
    <button
      ref={trigger}
      className={row ? "phone-reset-data" : "danger-outline"}
      aria-haspopup="dialog"
      disabled={resetting || disabled || !engine.storage.resetData}
      onClick={() => { setResetError(""); setResetOpen(true); }}
    >
      <RotateCcw size={15} aria-hidden="true" />
      {t(row ? "重置数据" : "重置应用数据")}
      {row && <ChevronRight aria-hidden="true" />}
    </button>
      <Modal
        open={resetOpen}
        onClose={() => { if (!resetting) setResetOpen(false); }}
        onOpenAutoFocus={() => resetCancel.current?.focus()}
        onCloseAutoFocus={() => trigger.current?.focus()}
        title={t(row ? "重置数据？" : "重置应用数据？")}
        description={t(import.meta.env.VITE_ANDROID ? "这会清除本机的蜂鸟号、聊天记录和设置。存到自选文件夹的附件仍会保留。" : desktop
          ? "这会清除这台设备上新版和旧版蜂鸟的个人资料、蜂鸟号、聊天记录和设置，以及两版最后存储位置的文件和缓存，无法恢复。"
          : "这会清除此浏览器中本站新版和旧版蜂鸟的个人资料、蜂鸟号、聊天记录、文件和设置，无法恢复。")}
      >
        <p className="large-files-confirm-size">
          {t("重置后将重新打开应用并生成新的蜂鸟号。未完成的传输会中断，对方的数据不受影响。")}
        </p>
        {desktop && <p className="large-files-confirm-size">{t("重置后将使用默认存储位置。你另存的文件会保留。")}</p>}
        {resetError && <p className="large-files-error" role="alert">{t(translateError(resetError))}</p>}
        <div className="modal-actions">
          <button ref={resetCancel} className="secondary-button" disabled={resetting} onClick={() => setResetOpen(false)}>
            <X size={15} aria-hidden="true" />{t("取消")}
          </button>
          <button className="danger-button" disabled={resetting} onClick={() => void reset()}>
            {resetting ? <LoaderCircle size={15} className="history-spinner" aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}
            {t(resetting ? "正在重置…" : "确认重置")}
          </button>
        </div>
      </Modal>
  </>;
}
