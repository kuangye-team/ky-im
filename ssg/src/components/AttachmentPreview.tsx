import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StorageAdapter } from "../core/types";
import type { ImagePreview } from "./attachmentActions";
import { Modal } from "./Modal";

export function AttachmentPreview({ file, storage, close }: {
  file: ImagePreview; storage: StorageAdapter; close: () => void;
}) {
  const { t } = useTranslation();
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    async function load() {
      const blob = file.blob || await storage.getAttachment(file.id);
      if (!active) return;
      if (!blob) throw new Error("附件尚未接收完成或已被清除");
      url = URL.createObjectURL(file.mime && blob.type !== file.mime ? blob.slice(0, blob.size, file.mime) : blob);
      setSrc(url);
    }
    void load().catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "无法读取附件");
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, storage]);
  const loading = <p role="status">{t("正在载入预览…")}</p>;
  return <Modal open onClose={close} title={file.name || t("文件预览")} wide className="attachment-preview-dialog">
    {error ? <p role="alert">{t(error)}</p> : !src ? loading :
      <img className="lightbox-image" src={src} alt={file.name} onError={() => setError("无法预览这个文件")} />}
  </Modal>;
}
