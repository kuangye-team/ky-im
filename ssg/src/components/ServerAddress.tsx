import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { copyText } from "./copyText";

export function ServerAddress({
  address,
  onNotice,
}: {
  address: string;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [address]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="settings-server-address">
      <span title={address}>{address}</span>
      <button
        type="button"
        className={`icon-button${copied ? " copied" : ""}`}
        aria-label={t("复制服务器地址")}
        title={t(copied ? "已复制" : "复制服务器地址")}
        onClick={() => {
          void copyText(address).then(
            () => {
              setCopied(true);
              onNotice(t("服务器地址已复制"));
            },
            () => {
              setCopied(false);
              onNotice(t("请选中地址后手动复制"));
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
    </div>
  );
}
