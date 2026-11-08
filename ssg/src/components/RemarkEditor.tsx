import { translateError } from "../localizeError";
import { useTranslation } from "react-i18next";
import { useId, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle, Pencil, X } from "lucide-react";
import { MAX_REMARK_LENGTH, type ChatEngine } from "../core";

export function RemarkEditor({
  peerId,
  remark,
  engine,
  onNotice,
}: {
  peerId: string;
  remark: string;
  engine: ChatEngine;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation("components");
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(remark);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeEditor = () => {
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await engine.updatePeerRemark(peerId, draft);
      closeEditor();
      onNotice(draft.trim() ? t("备注已保存") : t("备注已清除"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "备注保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contact-profile-field remark-section">
      {editing ? (
        <form className="remark-form" onSubmit={(event) => void submit(event)}>
          <label className="form-label" htmlFor={inputId}>
            {t("备注名称")}
            <span aria-hidden="true">
              {draft.length}/{MAX_REMARK_LENGTH}
            </span>
          </label>
          <input
            id={inputId}
            className="form-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_REMARK_LENGTH}
            placeholder={t("输入备注名称")}
            autoComplete="off"
            autoFocus
            disabled={busy}
            aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
            aria-invalid={!!error}
          />
          <p className="remark-hint" id={hintId}>
            {t("仅自己可见，保存在此浏览器。留空保存可清除备注。")}
          </p>
          {error && (
            <p className="remark-error danger-text" id={errorId} role="alert">
              {t(translateError(error))}
            </p>
          )}
          <div className="remark-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={closeEditor}
            >
              <X size={15} aria-hidden="true" />
              {t("取消")}
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? (
                <LoaderCircle
                  size={15}
                  className="spinning"
                  aria-hidden="true"
                />
              ) : (
                <Check size={15} aria-hidden="true" />
              )}
              {busy ? t("保存中…") : t("保存备注")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="contact-field-row">
            <span className="contact-field-label">{t("备注")}</span>
            <span className="contact-field-value">
              <span className="remark-value">{remark || t("未设置")}</span>
              <button
                ref={editButton}
                type="button"
                className="icon-button"
                aria-label={remark ? t("修改备注") : t("设置备注")}
                title={remark ? t("修改备注") : t("设置备注")}
                onClick={() => {
                  setDraft(remark);
                  setError("");
                  setEditing(true);
                }}
              >
                <Pencil size={14} />
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
