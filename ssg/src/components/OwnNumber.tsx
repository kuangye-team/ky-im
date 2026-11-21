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
  onRefresh,
}: {
  numericId?: string;
  compact?: boolean;
  onNotice: (message: string) => void;
  onRefresh?: () => Promise<void>;
}) {
  const { t } = useTranslation("components");
  const [refreshing, setRefreshing] = useState(false);
  const refreshPending = useRef(false);
  const refresh = async () => {
    if (!onRefresh || refreshPending.current) return;
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
          {numericId || "—"}
        </output>
        <CopyNumberButton key={numericId} numericId={numericId} disabled={refreshing} label={t("复制我的蜂鸟号")} onNotice={onNotice} />
        {onRefresh && <button
          type="button"
          className="icon-button refresh-number-button"
          aria-label={t("刷新我的蜂鸟号")}
          title={t("换一个新的蜂鸟号")}
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw
            size={16}
            className={refreshing ? "spinning" : undefined}
          />
        </button>}
      </span>
    </div>
  );
}

export function CopyNumberButton({ numericId, label, disabled, onNotice }: {
  numericId?: string; label?: string; disabled?: boolean; onNotice: (message: string) => void;
}) {
  const { t } = useTranslation("components");
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return <button type="button" className="icon-button copy-number-button"
    aria-label={label ?? t("复制蜂鸟号")} title={t(copied ? "已复制" : "复制蜂鸟号")}
    disabled={!numericId || disabled} aria-busy={copying}
    onClick={async event => {
      if (!numericId || copying) return;
      setCopying(true);
      try {
        await copyText(numericId, event.currentTarget.closest<HTMLElement>('[role="dialog"]'));
        setCopied(true);
        onNotice(t("蜂鸟号已复制"));
      } catch {
        setCopied(false);
        onNotice(t("暂时无法复制，请选中蜂鸟号后手动复制"));
      } finally {
        setCopying(false);
      }
    }}>
    {copied ? <Check size={16} /> : <Copy size={16} />}
  </button>;
}
