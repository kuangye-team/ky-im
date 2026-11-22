import { useFileActions } from "./attachmentActions";
import { PhoneActions } from "./PhoneActions";
import { MessageText } from "./MessageText";
import { copyText } from "./copyText";
import { TRANSFER_CONFIG } from "../config";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { translateError } from "../localizeError";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  CheckCheck,
  Copy,
  FileText,
  FolderOpen,
  Forward,
  LoaderCircle,
  MoreHorizontal,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type { ChatEngine } from "../core";
import type { Profile, Message } from "../core/types";
import { TransferSpeed } from "./TransferSpeed";
import {
  canSaveLargeFiles,
  canSaveFolders,
  chooseFileDestination,
  chooseIncomingFileDestination,
  chooseFolderDestination,
  readableSize,
  downloadAttachment,
} from "./fileDownloads";
import { Avatar } from "./Avatar";
import { messageTime } from "./messageTime";

export function MessageBubble({
  phone = false,
  message,
  mine,
  peer,
  engine,
  progress,
  recovering,
  onNotice,
  onDelete,
  onForward,
}: {
  phone?: boolean;
  message: Message;
  mine: boolean;
  peer: Profile;
  engine: ChatEngine;
  progress?: number;
  recovering?: boolean;
  onNotice: (text: string) => void;
  onDelete: () => void;
  onForward: () => void;
}) {
  const { t } = useTranslation();
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  const cancelHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => cancelHold, []);
  const [actions, setActions] = useState(false);
  const [image, setImage] = useState<{ url: string; blob: Blob }>();
  const { preview, openActions, player } = useFileActions({ message, storage: engine.storage, onNotice }, image?.blob);
  const copyMessage = () => {
    void copyText(message.text ?? "").then(
      () => onNotice(t("已复制")), () => onNotice(t("复制失败，请选中文字后手动复制")),
    );
  };
  const messageActions = message.kind === "text"
    ? [{ label: t("复制"), Icon: Copy, run: copyMessage }]
    : openActions;
  const [choosing, setChoosing] = useState(false);
  const [savePhase, setSavePhase] = useState<"choosing" | "saving" | null>(null);
  const savingAs = savePhase !== null;
  const awaiting = message.status === "awaiting-acceptance";
  const external = message.attachmentStorage === "external";
  const missingAttachment =
    !mine && message.kind !== "text" && message.status === "failed";
  const canSave =
    !external || (message.folder ? canSaveFolders() : canSaveLargeFiles());
  const acceptFile = async () => {
    if (choosing) return;
    setChoosing(true);
    try {
      if (message.attachmentStorage === "managed") {
        await engine.transfers.acceptFile(message.id);
      } else if (message.folder) {
        const destination = await chooseFolderDestination(
          message.fileName || t("文件夹"),
        );
        await engine.transfers.acceptFolder(message.id, destination);
      } else if (external) {
        const destination = await chooseFileDestination(
          message.fileName || t("附件"),
        );
        await engine.transfers.acceptFile(message.id, destination);
      } else {
        await engine.transfers.acceptFile(message.id);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        onNotice(
          error instanceof Error
            ? error.message
            : "文件无法保存，请检查磁盘空间后重试",
        );
    } finally {
      setChoosing(false);
    }
  };
  const saveAs = async () => {
    if (choosing || savingAs) return;
    setSavePhase("choosing");
    try {
      const target = await chooseIncomingFileDestination(engine.storage, message);
      setSavePhase("saving");
      await engine.transfers.saveFileAs(message, target);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        onNotice(error instanceof Error ? error.message : "文件无法保存，请检查磁盘空间后重试");
    } finally {
      setSavePhase(null);
    }
  };
  useEffect(() => {
    if (message.kind !== "image" || external) return;
    setImage(undefined);
    let alive = true;
    let objectUrl = "";
    void engine
      .getAttachment(message.id)
      .then((blob) => {
        if (blob && alive) {
          objectUrl = URL.createObjectURL(blob);
          setImage({ url: objectUrl, blob });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [engine, message.id, message.kind, message.status, external]);
  const download = async () => {
    try {
      await downloadAttachment(engine.storage, message);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "下载失败");
    }
  };
  return (
    <div
      className={`message-row ${mine ? "mine" : ""}`}
      onPointerDown={phone ? event => {
        if (event.pointerType !== "touch" || !event.currentTarget.contains(event.target as Node) ||
            (event.target as Element).closest("button, .inline-media")) return;
        cancelHold();
        hold.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => {
          setActions(true);
        }, 550) };
      } : undefined}
      onPointerMove={phone ? event => {
        if (hold.current && Math.hypot(event.clientX - hold.current.x, event.clientY - hold.current.y) > 10) cancelHold();
      } : undefined}
      onPointerUp={phone ? cancelHold : undefined}
      onPointerCancel={phone ? cancelHold : undefined}
      onContextMenu={phone ? event => {
        if (!event.currentTarget.contains(event.target as Node) || (event.target as Element).closest(".inline-media")) return;
        event.preventDefault(); setActions(true);
      } : undefined}
      data-message-id={message.id}
    >
      <Avatar peer={peer} size="avatar-small" />
      <div className="message-content">
        {message.kind === "text" ? (
          <MessageText text={message.text ?? ""} onCopy={copyMessage} />
        ) : (
          <div
            className={`attachment-bubble ${message.kind === "image" ? "image-bubble" : ""}`}
          >
            {message.kind === "image" && image ? (
              <button
                className="image-preview"
                aria-label={t("预览 {{value}}", { value: message.fileName })}
                disabled={!preview}
                onClick={preview?.run}
              >
                <img
                  src={image.url}
                  alt={message.fileName || t("收到的图片")}
                  loading="lazy"
                />
              </button>
            ) : preview && message.kind !== "image" ? (
              <button className="file-icon media-preview-button"
                aria-label={player ? preview.label : t(preview.opensDialog ? "查看 {{value}}" : "播放 {{value}}", { value: message.fileName })}
                title={preview.label} aria-haspopup={preview.opensDialog ? "dialog" : undefined}
                aria-expanded={preview.opensDialog ? undefined : !!player} onClick={preview.run}>
                <preview.Icon size={23} aria-hidden="true" />
              </button>
            ) : (
              <span className="file-icon">
                {message.folder ? (
                  <FolderOpen size={25} />
                ) : (
                  <FileText size={25} />
                )}
              </span>
            )}
            <div className="attachment-meta">
              <strong>{message.fileName}</strong>
              <span>
                {readableSize(message.size)}
                {message.folder &&
                  ` · ${t("{{count}} 个文件", { count: message.folder.fileCount })}`}
                {progress !== undefined && message.status === "sending"
                  ? ` · ${Math.round(progress)}%`
                  : ""}
                {TRANSFER_CONFIG.showSpeed && !recovering && message.status === "sending" &&
                  progress !== undefined && (
                    <TransferSpeed engine={engine} messageId={message.id} />
                  )}
              </span>
            </div>
            {!external && (
              <button
                className="icon-button"
                aria-label={t("下载 {{value}}", { value: message.fileName })}
                disabled={
                  message.status === "sending" || awaiting || missingAttachment
                }
                onClick={() => void download()}
              >
                <ArrowDownToLine size={18} />
              </button>
            )}
            {player}
            {message.status === "sending" && progress !== undefined && (
              <div className="transfer-progress">
                <i style={{ width: `${Math.min(100, progress)}%` }} />
              </div>
            )}
          </div>
        )}
        <div className="message-meta">
          <time
            title={new Date(message.createdAt).toLocaleString(i18n.language)}
          >
            {messageTime(message.createdAt)}
          </time>
          {mine && (
            <span
              className={message.status === "failed" ? "danger-text" : ""}
              title={message.error ? translateError(message.error) : undefined}
            >
              {recovering ? (
                t("等待重新连接")
              ) : awaiting ? (
                t("等待对方确认")
              ) : message.status === "sending" ? (
                <>
                  <LoaderCircle size={11} className="spinning" />
                  {t("发送中")}
                </>
              ) : message.status === "delivered" ? (
                <>
                  <CheckCheck size={13} />
                  {t("已送达")}
                </>
              ) : message.status === "failed" ? (
                <>{t("发送失败")}</>
              ) : (
                <>
                  <Check size={12} />
                  {t("已发送")}
                </>
              )}
            </span>
          )}
          {!mine &&
            message.kind !== "text" &&
            (message.status === "sending" || message.status === "failed") && (
              <span
                className={message.status === "failed" ? "danger-text" : ""}
                title={
                  message.error ? translateError(message.error) : undefined
                }
              >
                {recovering ? t("等待重新连接") : message.status === "sending" ? t("接收中") : t("接收失败")}
              </span>
            )}
          {message.kind !== "text" &&
            progress !== undefined &&
            (mine || !awaiting) && (
              <button
                className="message-delete-button"
                onClick={() => void engine.transfers.cancelTransfer(message.id)}
              >
                <X size={12} aria-hidden="true" />
                {t("取消")}
              </button>
            )}
          {!mine && !message.folder && !external && message.kind !== "text" &&
            (awaiting || message.status === "sending") &&
            (engine.storage.createExternalFileDestination || canSaveLargeFiles()) && (
              <button className="message-forward-button" disabled={choosing || savingAs}
                onClick={() => void saveAs()}>
                {savingAs ? (
                  <LoaderCircle size={12} className="spinning" aria-hidden="true" />
                ) : (
                  <Save size={12} aria-hidden="true" />
                )}
                {t(savePhase === "saving" ? "正在更改保存位置…" : "另存为")}
              </button>
            )}
          {!mine && external && message.status === "delivered" && <span>{t("已保存到所选位置")}</span>}
          {awaiting && !mine && (
            <>
              <button
                className="message-forward-button"
                disabled={choosing || savingAs || !canSave}
                onClick={() => void acceptFile()}
              >
                {choosing ? (
                  <LoaderCircle size={12} className="spinning" />
                ) : (
                  <ArrowDownToLine size={12} />
                )}
                {t(
                  choosing
                    ? external
                      ? "正在选择保存位置…"
                      : "正在接收…"
                    : external
                      ? "接收并保存"
                      : "接收",
                )}
              </button>
              <button
                className="message-delete-button"
                onClick={() => engine.transfers.rejectFile(message.id)}
              >
                <X size={12} />
                {t("拒收")}
              </button>
            </>
          )}
          {phone ? <button className="phone-message-more" aria-label={t("消息操作")} onClick={() => setActions(true)}><MoreHorizontal size={18} /></button> : <>
          {messageActions.map(({ label, Icon, run }) => (
            <button key={label} className="message-forward-button" onClick={run}><Icon size={12} />{label}</button>
          ))}
          <button
            className="message-forward-button"
            aria-label={t("转发消息")}
            title={
              message.status === "sending"
                ? t("传输完成后即可转发")
                : t("转发给朋友")
            }
            disabled={
              message.status === "sending" ||
              awaiting ||
              external ||
              !!message.folder ||
              missingAttachment
            }
            onClick={onForward}
          >
            <Forward size={12} />
            {t("转发")}
          </button>
          <button
            className="message-delete-button"
            aria-label={t("删除消息")}
            title={t(
              engine.storage.getStorageInfo
                ? "从此设备删除消息"
                : "从此浏览器删除消息",
            )}
            onClick={onDelete}
          >
            <Trash2 size={12} />
            {t("删除")}
          </button></>}
          {phone && actions && <PhoneActions title={t("消息操作")} close={() => setActions(false)} actions={[
            ...(preview?.opensDialog && message.kind === "file" ? [preview] : []),
            ...messageActions,
            { label: t("转发消息"), Icon: Forward, run: onForward, disabled: message.status === "sending" || awaiting || external || !!message.folder || missingAttachment },
            { label: t("删除消息"), Icon: Trash2, run: onDelete, danger: true },
          ]} />}
        </div>
      </div>
    </div>
  );
}
