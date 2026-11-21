import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Modal } from "./Modal";

export type PhoneAction = { label: string; Icon: LucideIcon; run: () => void; disabled?: boolean; danger?: boolean };
export function PhoneActions({ title, actions, close, children, showChevrons = false }: {
  title: string;
  actions: PhoneAction[];
  close: () => void;
  children?: ReactNode;
  showChevrons?: boolean;
}) {
  return <Modal open onClose={close} title={title} className="phone-sheet">
    {children}
    <div className="phone-sheet-actions">{actions.map(({ label, Icon, run, disabled, danger }) =>
      <button key={label} disabled={disabled} className={danger ? "danger-text" : undefined} onClick={() => { close(); run(); }}>
        <Icon size={20} aria-hidden="true" />{label}
        {showChevrons && <ChevronRight className="chat-action-chevron" size={18} aria-hidden="true" />}
      </button>)}</div>
  </Modal>;
}
