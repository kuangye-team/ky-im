import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal } from "./Modal";
import type { CompatibilityReason } from "../core/capabilities";
const messages: Record<CompatibilityReason, string> = {
  "local-update": "请更新应用后重试连接。",
  "peer-update": "请让对方更新应用后重试。",
  "server-update": "当前服务器可能需要更新，请联系管理员。",
  "peer-unsupported": "对方可能使用了修改版应用，暂时无法与您连接。",
  "server-unsupported": "这个服务器可能不支持当前应用，请检查地址或联系管理员。",
  "no-transport": "双方没有共同可用的连接方式，请检查连接设置或更新应用。",
};
export function useCompatibilityHelp() {
  const [details, setDetails] = useState<CompatibilityReason[]>();
  const { t } = useTranslation("components");
  return {
    button: (reasons?: CompatibilityReason[]) => reasons?.length ? (
      <button type="button" className="icon-button" aria-label={t("查看连接失败原因")} onClick={() => setDetails(reasons)}><CircleHelp size={18} /></button>
    ) : null,
    dialog: details && (
      <Modal open onClose={() => setDetails(undefined)} title={t("暂时无法连接")} description={t("可能的原因与解决办法")}>
        <ul>{[...new Set(details)].map(reason => <li key={reason}>{t(messages[reason])}</li>)}</ul>
      </Modal>
    ),
  };
}

export function CompatibilityHelp({ reasons }: { reasons?: CompatibilityReason[] }) {
  const help = useCompatibilityHelp();
  return <>{help.button(reasons)}{help.dialog}</>;
}
