import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Download, Forward, MoreHorizontal, Trash2 } from "lucide-react";
import { Fragment, useRef } from "react";
import type { PhoneAction } from "./PhoneActions";
import "./SharedFileActions.css";

type FileAction = PhoneAction & { description?: string; opensDialog?: boolean };

export function FileActionsMenu({ fileName, actions }: { fileName: string; actions: FileAction[] }) {
  const { t } = useTranslation("components");
  const openingDialog = useRef(false);
  if (!actions.length) return null;
  return (
    <DropdownMenu.Root onOpenChange={open => { if (open) openingDialog.current = false; }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="icon-button shared-file-more"
          aria-label={t("更多文件操作 {{name}}", { name: fileName })} title={t("更多操作")}>
          <MoreHorizontal size={17} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="shared-file-menu" aria-label={t("文件操作")}
          align="end" sideOffset={7} collisionPadding={12}
          onCloseAutoFocus={event => { if (openingDialog.current) event.preventDefault(); }}>
          <DropdownMenu.Label className="shared-file-menu-label">{t("文件操作")}</DropdownMenu.Label>
          {actions.map(({ label, Icon, description, run, disabled, danger, opensDialog }) => (
            <Fragment key={label}>
              {danger && <DropdownMenu.Separator className="shared-file-menu-separator" />}
              <DropdownMenu.Item className={`shared-file-menu-item${danger ? " shared-file-menu-danger" : ""}`}
                aria-label={label} disabled={disabled}
                onSelect={() => { openingDialog.current = !!opensDialog; run(); }}>
                <Icon size={16} />
                <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function SharedFileActions({
  fileName, transferring, recordOnly = false, canForward = true, actions, onDownload, onForward, onDelete,
}: {
  fileName: string;
  transferring: boolean;
  recordOnly?: boolean;
  canForward?: boolean;
  actions: FileAction[];
  onDownload: () => void;
  onForward: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className="shared-file-actions">
      <button type="button" className="icon-button"
        aria-label={t("下载共享文件 {{name}}", { name: fileName })}
        title={t(recordOnly ? "仅保留传输记录" : transferring ? "传输完成后即可下载" : "下载文件")}
        disabled={transferring || recordOnly} onClick={onDownload}>
        <Download size={15} />
      </button>
      <FileActionsMenu fileName={fileName} actions={[
        ...actions,
        { label: t("转发"), Icon: Forward, run: onForward, opensDialog: true,
          disabled: transferring || recordOnly || !canForward,
          description: t(recordOnly ? "仅保留传输记录" : transferring ? "传输完成后即可转发" : "发送给在线朋友") },
        { label: t("删除"), Icon: Trash2, run: onDelete, danger: true, opensDialog: true, description: t("从本地聊天中移除") },
      ]} />
    </div>
  );
}
