import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

export function AndroidBackground({ phone }: { phone: boolean }) {
  const { t } = useTranslation("components");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const read = () => {
      if (!document.hidden) void invoke<boolean>("android_background").then(setEnabled).catch(() => {});
    };
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);
  async function change(value: boolean) {
    setBusy(true);
    setNotice("");
    try {
      const active = await invoke<boolean>("android_background", { enabled: value });
      setEnabled(active);
      if (value && !active) setNotice("请允许蜂鸟显示连接通知。");
    } catch { setNotice("设置未保存，请重试"); }
    finally { setBusy(false); }
  }
  return <fieldset className="settings-card settings-background" disabled={busy}>
    {!phone && <legend>{t("后台聊天")}</legend>}
    <label className="settings-choice">
      <input type="checkbox" checked={enabled} onChange={event => void change(event.target.checked)} />
      <span><strong>{t(phone ? "后台保持连接" : "切换应用时保持连接")}</strong>
        {!phone && <small>{t("连接好友后显示通知，可从通知中停止。")}</small>}
      </span>
    </label>
    {notice && <p role="status">{t(notice)}</p>}
  </fieldset>;
}
