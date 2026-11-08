import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Download, MoreHorizontal, Trash2 } from "lucide-react";
import { useRef } from "react";

export function ContactActions({
  onExport,
  onDelete,
}: {
  onExport: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("components");
  const openingConfirmation = useRef(false);
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) openingConfirmation.current = false;
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="icon-button"
          aria-label={t("聊天操作")}
          title={t("聊天操作")}
        >
          <MoreHorizontal size={20} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="contact-menu"
          aria-label={t("聊天操作")}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            if (openingConfirmation.current) event.preventDefault();
          }}
        >
          <DropdownMenu.Item className="contact-menu-item" onSelect={onExport}>
            <Download size={16} />
            {t("导出文字记录")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="contact-menu-separator" />
          <DropdownMenu.Item
            className="contact-menu-item contact-menu-danger"
            onSelect={() => {
              openingConfirmation.current = true;
              onDelete();
            }}
          >
            <Trash2 size={16} />
            {t("删除聊天记录")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
