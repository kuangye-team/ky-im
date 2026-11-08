import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { copyText } from "./copyText";

export function ContactCopyButton({
  value,
  kind,
  onNotice,
}: {
  value: string;
  kind: "email" | "website" | "repository";
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const label =
    kind === "email"
      ? t("复制邮箱")
      : kind === "repository"
        ? t("复制源码地址")
        : t("复制主页网址");

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={copied ? t("已复制") : label}
      onClick={(event) => {
        void copyText(
          value,
          event.currentTarget.closest<HTMLElement>('[role="dialog"]'),
        ).then(
          () => {
            setCopied(true);
            onNotice(
              kind === "email"
                ? t("邮箱已复制")
                : kind === "repository"
                  ? t("源码地址已复制")
                  : t("主页网址已复制"),
            );
          },
          () => {
            setCopied(false);
            onNotice(
              kind === "email"
                ? t("暂时无法复制，请选中邮箱后手动复制")
                : t("请选中地址后手动复制"),
            );
          },
        );
      }}
    >
      {copied ? (
        <Check size={15} aria-hidden="true" />
      ) : (
        <Copy size={15} aria-hidden="true" />
      )}
    </button>
  );
}
