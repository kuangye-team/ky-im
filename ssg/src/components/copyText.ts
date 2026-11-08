import { i18n } from "../i18n";
const t = (key: string) => i18n.t(key, { ns: "components" });

export async function copyText(
  text: string,
  fallbackContainer?: HTMLElement | null,
) {
  const focused = document.activeElement;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Local HTTP pages and denied clipboard permissions can still use a selection.
  }

  const container =
    fallbackContainer ||
    (focused instanceof HTMLElement
      ? focused.closest<HTMLElement>('[role="dialog"]')
      : null) ||
    document.body;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    fontSize: "16px",
  });
  container.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error(t("复制失败"));
  } finally {
    textarea.remove();
    if (focused instanceof HTMLElement && focused.isConnected)
      focused.focus({ preventScroll: true });
  }
}
