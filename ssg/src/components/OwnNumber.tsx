import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { copyText } from "./copyText";
import { translateError } from "../localizeError";
import "./OwnNumber.css";

export function OwnNumber({
  numericId,
  compact = false,
  onNotice,
  connected,
  onRefresh,
}: {
  numericId?: string;
  compact?: boolean;
  onNotice: (message: string) => void;
  connected: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("components");
  const button = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshPending = useRef(false);

  useEffect(() => setCopied(false), [numericId]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (!numericId || copying) return;
    setCopying(true);
    try {
      await copyText(
        numericId,
        button.current?.closest<HTMLElement>('[role="dialog"]'),
      );
      setCopied(true);
      onNotice(t("蜂鸟号已复制"));
    } catch {
      setCopied(false);
      onNotice(t("暂时无法复制，请选中蜂鸟号后手动复制"));
    } finally {
      setCopying(false);
    }
  };
  const refresh = async () => {
    if (!connected || refreshPending.current) return;
    refreshPending.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
      onNotice(t("蜂鸟号已刷新"));
    } catch (error) {
      onNotice(
        translateError(
          error instanceof Error ? error.message : "刷新蜂鸟号失败，请稍后重试",
        ),
      );
    } finally {
      refreshPending.current = false;
      setRefreshing(false);
    }
  };

  return (
    <div className={compact ? "own-number-compact" : "own-number"}>
      <span>{t("我的蜂鸟号")}</span>
      <span className="own-number-value">
        <output
          aria-label={t("我的蜂鸟号")}
          className={numericId ? undefined : "own-number-placeholder"}
        >
          {numericId || t("上线后显示")}
        </output>
        <button
          ref={button}
          type="button"
          className="icon-button copy-number-button"
          aria-label={t("复制我的蜂鸟号")}
          title={copied ? t("已复制") : t("复制蜂鸟号")}
          disabled={!numericId || refreshing}
          aria-busy={copying}
          onClick={() => void copy()}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <button
          type="button"
          className="icon-button refresh-number-button"
          aria-label={t("刷新我的蜂鸟号")}
          title={connected ? t("换一个新的蜂鸟号") : t("上线后可刷新蜂鸟号")}
          disabled={!connected || refreshing}
          aria-busy={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw
            size={16}
            className={refreshing ? "spinning" : undefined}
          />
        </button>
      </span>
    </div>
  );
}
