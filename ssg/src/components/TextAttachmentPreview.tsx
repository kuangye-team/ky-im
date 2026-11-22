import { Check, ChevronLeft, ChevronRight, Code2, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_BUFFERED_FILE_BYTES, STORAGE_CONFIG } from "../config";
import type { StorageAdapter } from "../core/types";
import type { TextPreview } from "./attachmentActions";
import { copyText } from "./copyText";
import { Modal } from "./Modal";

function fileDecoder(bytes: Uint8Array, mime: string) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder();
  const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/i.exec(mime)?.[1];
  try { return new TextDecoder(charset); }
  catch { return new TextDecoder(); }
}

async function readPages(file: TextPreview, storage: StorageAdapter, signal: AbortSignal) {
  const source = storage.getAttachmentSource
    ? await storage.getAttachmentSource(file.id) : await storage.getAttachment(file.id);
  if (!source) throw new Error("附件尚未接收完成或已被清除");
  if (source.size > MAX_BUFFERED_FILE_BYTES) throw new Error("文件较大，请下载后查看");
  // Bound both native IPC reads and the amount of text laid out in a single page.
  const pageBytes = Math.min(256 * 1024, STORAGE_CONFIG.chunkBytes);
  const pages: string[] = [];
  let decoder: TextDecoder | undefined;
  for (let start = 0; start < source.size; start += pageBytes) {
    if (signal.aborted) return [];
    const end = Math.min(start + pageBytes, source.size);
    const bytes = new Uint8Array(await source.slice(start, end).arrayBuffer());
    if (bytes.length !== end - start) throw new Error("文件没有读取完整，请重试");
    decoder ??= fileDecoder(bytes, [file.mime, source.type].join(";"));
    const text = decoder.decode(bytes, { stream: end < source.size });
    if (text) pages.push(text);
  }
  return pages;
}

export function TextAttachmentPreview({ file, storage, close }: {
  file: TextPreview; storage: StorageAdapter; close: () => void;
}) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<string[]>();
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    const controller = new AbortController();
    void readPages(file, storage, controller.signal).then(result => {
      if (!controller.signal.aborted) setPages(result);
    }, reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取附件");
    });
    return () => controller.abort();
  }, [file, storage]);

  const copied = copyState === "copied";
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return <Modal open wide onClose={close} title={file.name || t("文件预览")}
    className="attachment-preview-dialog text-preview-dialog">
    <div className="text-preview-toolbar">
      <h3><Code2 size={16} aria-hidden="true" />{t("源代码")}</h3>
      <button type="button" className="secondary-button" disabled={!pages}
        onClick={event => {
          if (!pages) return;
          void copyText(pages.join(""), event.currentTarget.closest<HTMLElement>('[role="dialog"]')).then(
            () => setCopyState("copied"), () => setCopyState("failed"));
        }}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
        <span aria-live="polite">{t(copied ? "已复制" : "复制")}</span>
      </button>
    </div>
    {error ? <p role="alert">{t(error)}</p> : !pages ? <p role="status">{t("正在载入预览…")}</p> :
      pages.length === 0 ? <p role="status">{t("文件为空")}</p> :
      <pre key={page} className="text-preview-source" role="region" aria-label={t("源代码")} tabIndex={0}>
        <code>{pages[page]}</code>
      </pre>}
    {pages && pages.length > 1 && <div className="text-preview-pagination">
      <button type="button" className="icon-button" aria-label={t("上一页")} disabled={page === 0}
        onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button>
      <span aria-live="polite">{page + 1} / {pages.length}</span>
      <button type="button" className="icon-button" aria-label={t("下一页")} disabled={page + 1 === pages.length}
        onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button>
    </div>}
    {copyState === "failed" && <p role="alert">{t("复制失败，请选中文字后手动复制")}</p>}
  </Modal>;
}
