import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, LoaderCircle, Wifi, WifiOff } from "lucide-react";
import { useId } from "react";
import type { ChatEngine } from "../core";
import type { ChatSnapshot } from "../core/types";
import "./MyStatus.css";

export function MyStatus({
  snap,
  engine,
  compact = false,
}: {
  snap: ChatSnapshot;
  engine: ChatEngine;
  compact?: boolean;
}) {
  const { t } = useTranslation("components");
  const descriptionId = useId();
  const online = snap.status === "connected";
  const connecting = snap.status === "connecting";
  const label = online
    ? t("在线")
    : connecting
      ? t("离线 · 连接中")
      : snap.availability === "online"
        ? t("离线 · 待连接")
        : t("离线");

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`availability-trigger ${compact ? "availability-compact" : ""}`}
          data-connection={snap.status}
          data-availability={snap.availability}
          aria-label={t("我的状态")}
          title={t("我的状态：{{status}}", { status: label })}
        >
          <span className="availability-signal" aria-hidden="true">
            {connecting ? (
              <LoaderCircle size={14} className="availability-spinner" />
            ) : online ? (
              <Wifi size={14} />
            ) : (
              <WifiOff size={14} />
            )}
          </span>
          {compact && (
            <span className="availability-label">{t("我的状态")}</span>
          )}
          <span className="availability-value">{label}</span>
          <ChevronDown size={12} className="availability-chevron" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="availability-menu"
          align={compact ? "start" : "end"}
          sideOffset={8}
          collisionPadding={12}
        >
          <DropdownMenu.Label className="availability-menu-heading">
            {t("我的状态")}
            <span>{t("选择你的连接状态")}</span>
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={snap.availability}
            onValueChange={(value) => {
              if (
                (value === "online" || value === "offline") &&
                value !== snap.availability
              ) {
                engine.setAvailability(value);
              }
            }}
          >
            <DropdownMenu.RadioItem
              value="online"
              className="availability-option"
              aria-label={t("在线")}
              aria-describedby={`${descriptionId}-online`}
            >
              <span className="availability-option-icon availability-option-online">
                <Wifi size={18} />
              </span>
              <span className="availability-option-copy">
                <strong>{t("在线")}</strong>
                <span id={`${descriptionId}-online`}>
                  {t("允许朋友发现并与你连接")}
                </span>
              </span>
              <DropdownMenu.ItemIndicator className="availability-check">
                <Check size={16} />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem
              value="offline"
              className="availability-option"
              aria-label={t("离线")}
              aria-describedby={`${descriptionId}-offline`}
            >
              <span className="availability-option-icon availability-option-offline">
                <WifiOff size={18} />
              </span>
              <span className="availability-option-copy">
                <strong>{t("离线")}</strong>
                <span id={`${descriptionId}-offline`}>
                  {t("暂停连接，保留本地聊天记录")}
                </span>
              </span>
              <DropdownMenu.ItemIndicator className="availability-check">
                <Check size={16} />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
