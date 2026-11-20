import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, X } from "lucide-react";
import type { ChatEngine } from "../core";
import { Modal } from "./Modal";
import { isReloadApproved, reloadApp, RELOAD_REQUEST_EVENT, setNativeReloadGuard } from "../reload";
import { runtimeLog } from "../runtime-logs";

export function RefreshGuard({ engine }: { engine: ChatEngine }) {
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [reloading, setReloading] = useState(false);
  const reloadInProgress = useRef(false);
  const dialogOpen = useRef(open);
  dialogOpen.current = open;

  const reload = useCallback(async () => {
    if (reloadInProgress.current) return;
    reloadInProgress.current = true;
    setReloading(true);
    setError("");
    try {
      await reloadApp();
    } catch {
      reloadInProgress.current = false;
      setReloading(false);
      setError("暂时无法刷新，请重试");
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      // Read the engine at the moment of leaving, including other conversations
      // and transfers still being prepared or waiting for the recipient.
      if (isReloadApproved() || !engine.hasPendingTransfers()) return;
      event.preventDefault();
      // Toolbar refresh / tab closing only support the browser's own wording.
      event.returnValue = "";
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const refresh = !event.altKey && (
        event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")
      );
      if (!refresh || (!dialogOpen.current && !engine.hasPendingTransfers())) return;
      event.preventDefault();
      if (!event.repeat) setOpen(true);
    };
    const requestReload = () => {
      if (engine.hasPendingTransfers()) setOpen(true);
      else void reload();
    };
    const guardError = (error: unknown) => runtimeLog("error", "app", "刷新保护暂时不可用", { raw: error });
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(RELOAD_REQUEST_EVENT, requestReload);
    void setNativeReloadGuard(true).catch(guardError);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(RELOAD_REQUEST_EVENT, requestReload);
      void setNativeReloadGuard(false).catch(guardError);
    };
  }, [engine, reload]);

  return (
    <Modal
      open={open}
      onClose={() => { if (!reloading) setOpen(false); }}
      onOpenAutoFocus={() => cancelButton.current?.focus()}
      title={t("确认刷新页面？")}
      description={t("刷新后，未完成的传输将会中断，需要重新发起。是否确认刷新？")}
    >
      {error && <p className="large-files-error" role="alert">{t(error)}</p>}
      <div className="modal-actions">
        <button
          ref={cancelButton}
          className="secondary-button"
          disabled={reloading}
          onClick={() => setOpen(false)}
        >
          <X size={15} aria-hidden="true" />
          {t("取消")}
        </button>
        <button
          className="danger-button"
          disabled={reloading}
          onClick={() => void reload()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {t("确认刷新")}
        </button>
      </div>
    </Modal>
  );
}
