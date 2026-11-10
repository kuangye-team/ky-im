import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  FolderOpen,
  Info,
  LoaderCircle,
  MessageCircle,
  Trash2,
} from "lucide-react";
import type { ChatEngine } from "../core";
import type { ChatSnapshot } from "../core/types";
import { translateError } from "../localizeError";
import { download } from "./fileDownloads";
import "./StoragePage.css";

export function HistoryPage({
  engine,
  snap,
  onClear,
  onNotice,
}: {
  engine: ChatEngine;
  snap: ChatSnapshot;
  onClear: () => void;
  onNotice: (text: string) => void;
}) {
  const { t } = useTranslation("components");
  const [exporting, setExporting] = useState(false);
  const exportHistory = async () => {
    setExporting(true);
    try {
      const conversations = await engine.storage.getConversations();
      const records = await Promise.all(
        conversations.map(async (conversation) => ({
          ...conversation,
          messages: await engine.storage.getMessages(conversation.peer.id),
        })),
      );
      const exportedAt = new Date().toISOString();
      await download(
        new Blob(
          [JSON.stringify({ exportedAt, conversations: records }, null, 2)],
          {
            type: "application/json",
          },
        ),
        t("蜂鸟-聊天记录-{{date}}.json", { date: exportedAt.slice(0, 10) }),
      );
      onNotice(t("聊天记录已导出，附件请单独下载保存"));
    } catch (error) {
      onNotice(
        error instanceof Error
          ? translateError(error.message)
          : t("导出失败，请重试"),
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="full-page storage-page history-manager">
      <div className="page-heading">
        <h1>{t("聊天记录")}</h1>
        <p>{t("保存值得留下的聊天，随时导出或整理。")}</p>
      </div>
      <div className="history-summary">
        <MessageCircle size={22} />
        <span>{t("保存的聊天")}</span>
        <strong>
          {snap.conversations.length}
          <small> {t("个")}</small>
        </strong>
      </div>
      <div className="settings-block">
        <div>
          <FolderOpen size={23} />
          <span>
            <h3>{t("导出聊天记录")}</h3>
            <p>
              {t(
                "导出全部聊天的文字和文件信息；图片、文件原件请单独下载保存。",
              )}
            </p>
          </span>
        </div>
        <button
          className="secondary-button history-export-button"
          disabled={exporting || !snap.conversations.length}
          onClick={() => void exportHistory()}
        >
          {exporting ? (
            <LoaderCircle size={15} className="history-spinner" />
          ) : (
            <Download size={15} />
          )}
          {exporting ? t("正在导出…") : t("导出记录")}
        </button>
      </div>

      <div className="settings-block danger-zone">
        <div>
          <Trash2 size={22} />
          <span>
            <h3>{t("清空聊天记录")}</h3>
            <p>
              {t(
                engine.storage.getStorageInfo
                  ? "删除此设备的全部聊天、附件和联系人备注，保留你的个人资料。"
                  : "删除此浏览器的全部聊天、附件和联系人备注，保留你的个人资料。",
              )}
            </p>
          </span>
        </div>
        <button className="danger-outline" onClick={onClear}>
          <Trash2 size={15} aria-hidden="true" />
          {t("清空记录")}
        </button>
      </div>
      <p className="storage-footnote">
        <Info size={14} />
        {t(
          "换设备或换浏览器后，看不到这里的记录。重要的聊天记得导出，文件记得下载。",
        )}
      </p>
    </section>
  );
}
