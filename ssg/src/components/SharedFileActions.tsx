import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Download, Forward, MoreHorizontal, Trash2 } from "lucide-react";
import { useRef } from "react";
import "./SharedFileActions.css";

export function SharedFileActions({
  fileName,
  transferring,
  recordOnly = false,
  canForward = true,
  onDownload,
  onForward,
  onDelete,
}: {
  fileName: string;
  transferring: boolean;
  recordOnly?: boolean;
  canForward?: boolean;
  onDownload: () => void;
  onForward: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("components");
  const openingDialog = useRef(false);
  return (
    <div className="shared-file-actions">
      <button
        type="button"
        className="icon-button"
        aria-label={t("下载共享文件 {{name}}", { name: fileName })}
        title={
          recordOnly
            ? t("仅保留传输记录")
            : transferring
              ? t("传输完成后即可下载")
              : t("下载文件")
        }
        disabled={transferring || recordOnly}
        onClick={onDownload}
      >
        <Download size={15} />
      </button>
      <DropdownMenu.Root
        onOpenChange={(open) => {
          if (open) openingDialog.current = false;
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="icon-button shared-file-more"
            aria-label={t("更多文件操作 {{name}}", { name: fileName })}
            title={t("更多操作")}
          >
            <MoreHorizontal size={17} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="shared-file-menu"
            aria-label={t("文件操作")}
            align="end"
            sideOffset={7}
            collisionPadding={12}
            onCloseAutoFocus={(event) => {
              if (openingDialog.current) event.preventDefault();
            }}
          >
            <DropdownMenu.Label className="shared-file-menu-label">
              {t("文件操作")}
            </DropdownMenu.Label>
            <DropdownMenu.Item
              className="shared-file-menu-item"
              aria-label={t("转发")}
              disabled={transferring || recordOnly || !canForward}
              onSelect={() => {
                openingDialog.current = true;
                onForward();
              }}
            >
              <Forward size={16} />
              <span>
                <strong>{t("转发")}</strong>
                <small>
                  {recordOnly
                    ? t("仅保留传输记录")
                    : transferring
                      ? t("传输完成后即可转发")
                      : t("发送给在线朋友")}
                </small>
              </span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="shared-file-menu-separator" />
            <DropdownMenu.Item
              className="shared-file-menu-item shared-file-menu-danger"
              aria-label={t("删除")}
              onSelect={() => {
                openingDialog.current = true;
                onDelete();
              }}
            >
              <Trash2 size={16} />
              <span>
                <strong>{t("删除")}</strong>
                <small>{t("从本地聊天中移除")}</small>
              </span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
