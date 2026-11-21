import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, PanelTopClose } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { detectDevice, nativeTargetDevice } from "../device-platform";
import { runtimeLog } from "../runtime-logs";
import { Modal } from "./Modal";
import "./DesktopCloseDialog.css";

export function DesktopCloseDialog() {
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hideButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const platform = nativeTargetDevice(import.meta.env.TAURI_ENV_PLATFORM) ?? detectDevice(navigator);

  useEffect(() => {
    const listen = async () => getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      setOpen(true);
    });
    const subscription = listen().catch((error) => {
      runtimeLog("error", "app", "关闭窗口提醒暂时不可用", { raw: error });
    });
    return () => { void subscription.then((unlisten) => unlisten?.()); };
  }, []);

  function dismiss() {
    setOpen(false);
    setError("");
  }

  async function choose(action: "hide" | "quit") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (action === "hide") await getCurrentWindow().hide();
      else await exit(0);
      dismiss();
    } catch (cause) {
      const message = action === "hide" ? "暂时无法隐藏窗口，请重试。" : "暂时无法退出应用，请重试。";
      setError(message);
      runtimeLog("error", "app", message, { raw: cause });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) dismiss(); }} dismissOnOutsideClick={false}
      title={t("关闭窗口？")} className="desktop-close-dialog" overlayClassName="desktop-close-overlay"
      onOpenAutoFocus={() => {
        previousFocus.current = document.activeElement as HTMLElement | null;
        hideButton.current?.focus();
      }}
      onCloseAutoFocus={() => previousFocus.current?.focus()}>
      <button className="close-choice close-choice-hide" ref={hideButton} disabled={busy}
        onClick={() => void choose("hide")}>
        <PanelTopClose aria-hidden="true" size={20} />
        <span><strong>{t("隐藏窗口")}</strong><small>{t(platform === "Win"
          ? "后台继续传输。点击任务栏通知区域的蜂鸟图标即可返回。"
          : "后台继续传输。再次打开蜂鸟即可返回。")}</small></span>
      </button>
      <button className="close-choice" disabled={busy} onClick={() => void choose("quit")}>
        <LogOut aria-hidden="true" size={20} />
        <span><strong>{t("退出应用")}</strong><small>{t("退出后，未完成的传输会中断。")}</small></span>
      </button>
      {error && <p className="large-files-error" role="alert">{t(error)}</p>}
    </Modal>
  );
}
