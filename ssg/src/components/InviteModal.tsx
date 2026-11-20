import { getInviteUrl } from "../invite-url";
import { useTranslation } from "react-i18next";
import { translateError } from "../localizeError";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, Copy, LoaderCircle } from "lucide-react";
import type { ChatEngine } from "../core";
import type { Profile } from "../core/types";
import { Modal } from "./Modal";
import { OwnNumber } from "./OwnNumber";
import { copyText } from "./copyText";

export function InviteModal({
  open,
  onClose,
  profile,
  connected,
  previousPeer,
  engine,
  onNotice,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  profile: Profile;
  connected: boolean;
  previousPeer: Profile | null;
  engine: ChatEngine;
  onNotice: (message: string) => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const [numericId, setNumericId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const url = getInviteUrl(location.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  useEffect(() => {
    if (!open) return;
    setNumericId(previousPeer?.numericId || "");
    setError("");
    setCopied(false);
  }, [open, previousPeer]);
  const copyAddress = async () => {
    try {
      await copyText(
        url,
        copyButton.current?.closest<HTMLElement>('[role="dialog"]'),
      );
      setCopied(true);
      onNotice("邀请地址已复制");
    } catch {
      onNotice("请选中地址后手动复制");
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!/^[1-9][0-9]{5}$/.test(numericId)) {
      setError("请输入 6 位蜂鸟号，第一位不能是 0");
      return;
    }
    if (!connected) {
      setError("请先切换为在线，连接后再查找设备");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await engine.connectByNumericId(numericId);
      onConnected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接未成功，请重试");
    } finally {
      setBusy(false);
    }
  };
  if (!engine.supportsNumericIds)
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={t("邀请朋友")}
        description={t("局域网直连")}
      >
        <p>{t("连接同一个网络并打开蜂鸟客户端，设备会自动出现。")}</p>
        <p>{t("请允许蜂鸟访问本地网络，并在防火墙中允许连接。")}</p>
      </Modal>
    );
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={t("邀请朋友")}
      description={t("分享网址和蜂鸟号，找到彼此的在线设备。")}
    >
      <OwnNumber
        numericId={profile.numericId}
        onNotice={onNotice}
        onRefresh={() => engine.refreshNumericId()}
      />
      <label className="form-label" htmlFor="invite-address">
        {t("访问地址")}
      </label>
      <div className="copy-field">
        <input
          id="invite-address"
          value={url}
          readOnly
          onFocus={(event) => event.target.select()}
        />
        <button
          ref={copyButton}
          className="primary-button"
          type="button"
          onClick={() => void copyAddress()}
          aria-label={t("复制邀请地址")}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? t("已复制") : t("复制")}
        </button>
      </div>
      {local && (
        <p className="invite-local-note">
          {t("当前地址只能在这台设备打开，请使用朋友也能访问的蜂鸟网址。")}
        </p>
      )}
      <div className="invite-divider">
        <span>{t("找不到朋友的设备？")}</span>
      </div>
      <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
        <label className="form-label" htmlFor="connect-number">
          {t("朋友的蜂鸟号")}
        </label>
        <div className="copy-field">
          <input
            id="connect-number"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("输入 6 位蜂鸟号")}
            value={numericId}
            maxLength={6}
            disabled={busy}
            aria-invalid={!!error}
            aria-describedby={error ? "connect-error" : undefined}
            onChange={(event) => {
              setNumericId(event.target.value.replace(/\D/g, "").slice(0, 6));
              setError("");
            }}
          />
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !connected || numericId.length !== 6}
          >
            {busy ? (
              <LoaderCircle size={16} className="spinning" />
            ) : (
              <ArrowRight size={16} />
            )}
            {busy ? t("正在查找…") : t("连接")}
          </button>
        </div>
        {error && (
          <p className="connect-error" id="connect-error" role="alert">
            {translateError(error)}
          </p>
        )}
      </form>
    </Modal>
  );
}
