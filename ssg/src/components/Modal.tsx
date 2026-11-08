import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useId, type ReactNode } from "react";
export function Modal({
  open,
  onClose,
  onCloseAutoFocus,
  title,
  description,
  headerActions,
  children,
  wide = false,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  onCloseAutoFocus?: () => void;
  title: string;
  description?: string;
  headerActions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("components");
  const descriptionId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""} ${className}`}
          aria-describedby={description ? descriptionId : undefined}
          onCloseAutoFocus={
            onCloseAutoFocus
              ? (event) => {
                  event.preventDefault();
                  onCloseAutoFocus();
                }
              : undefined
          }
        >
          <div className={`modal-heading ${headerActions ? "detail-top" : ""}`}>
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description id={descriptionId}>
                  {description}
                </Dialog.Description>
              )}
            </div>
            <div className="modal-heading-actions">
              {headerActions}
              <Dialog.Close className="icon-button" aria-label={t("关闭")}>
                <X size={20} />
              </Dialog.Close>
            </div>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
