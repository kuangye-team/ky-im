import { Copy, ChevronRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./Modal";

const maxCharacters = 200;
const maxLines = 6;
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;

function messageExcerpt(text: string) {
  // Capturing the separators keeps the original line endings in the excerpt.
  const lines = text.split(/(\r\n|[\r\n\u2028\u2029])/, maxLines * 2 - 1).join("");
  if (lines.length <= maxCharacters) return lines;
  if (!segmenter) return Array.from(lines).slice(0, maxCharacters).join("");
  let count = 0;
  for (const { index } of segmenter.segment(lines)) {
    if (count === maxCharacters) return lines.slice(0, index);
    count++;
  }
  return lines;
}

export function MessageText({ text, onCopy }: { text: string; onCopy: () => void }) {
  const { t } = useTranslation();
  const excerpt = useMemo(() => messageExcerpt(text), [text]);
  const [reading, setReading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLPreElement>(null);
  return <>
    <div className="text-bubble" dir="auto">
      {excerpt === text ? text : <>
        {excerpt}…
        <button type="button" className="read-message-button" aria-haspopup="dialog"
          ref={trigger} onClick={() => setReading(true)}>
          {t("查看全文")}<ChevronRight size={15} aria-hidden="true" />
        </button>
      </>}
    </div>
    {reading && <Modal open wide className="full-message-dialog" title={t("消息全文")} onClose={() => setReading(false)}
      headerActions={
        <button type="button" className="icon-button" aria-label={t("复制全文")} title={t("复制全文")} onClick={onCopy}>
          <Copy size={18} aria-hidden="true" />
        </button>
      }
      onOpenAutoFocus={() => body.current?.focus()} onCloseAutoFocus={() => trigger.current?.focus()}>
      <pre className="full-message-text" ref={body} tabIndex={0} role="region" aria-label={t("消息内容")} dir="auto">{text}</pre>
    </Modal>}
  </>;
}
