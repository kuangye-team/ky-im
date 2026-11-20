import { deviceLabel } from "../core/profile";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { ArrowRight, File, FolderOpen, Image as ImageIcon } from "lucide-react";
import type { ChatEngine } from "../core";
import { isPeerOnline } from "../core/types";
import type { Profile, Message, ChatSnapshot } from "../core/types";
import { RemarkEditor } from "./RemarkEditor";
import { SharedFileActions } from "./SharedFileActions";
import { readableSize, downloadAttachment } from "./fileDownloads";
import { Avatar, DeviceIcon, peerName } from "./Avatar";

export function ContactDetails({
  peer,
  remark,
  snap,
  engine,
  onConnectGroup,
  onNotice,
  onDelete,
  onForward,
}: {
  peer: Profile;
  remark: string;
  snap: ChatSnapshot;
  engine: ChatEngine;
  onConnectGroup: () => void;
  onDelete: (message: Message) => void;
  onForward: (message: Message) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="contact-profile">
        <Avatar
          peer={peer}
          size="avatar-xl"
          online={isPeerOnline(snap, peer.id)}
        />
        <h2>{peerName(peer, snap)}</h2>
        {remark && (
          <p>
            {t("原名：")}
            {peer.name}
          </p>
        )}
        <p>{peer.bio}</p>
        <span className="device-label">
          <DeviceIcon peer={peer} />
          {deviceLabel(peer)}
        </span>
        <div className="contact-profile-fields">
          <RemarkEditor
            key={peer.id}
            peerId={peer.id}
            remark={remark}
            engine={engine}
            onNotice={onNotice}
          />
          <AutoAcceptFiles
            key={`auto-accept-${peer.id}`}
            peerId={peer.id}
            enabled={snap.conversations.some(
              (conversation) =>
                conversation.peer.id === peer.id &&
                conversation.autoAcceptFiles === true,
            )}
            engine={engine}
            onNotice={onNotice}
          />
          <ContactNumber peer={peer} onConnect={onConnectGroup} />
        </div>
      </div>
      <SharedFiles
        messages={snap.messages}
        engine={engine}
        onNotice={onNotice}
        onDelete={onDelete}
        onForward={onForward}
      />
    </>
  );
}

function AutoAcceptFiles({
  peerId,
  enabled,
  engine,
  onNotice,
}: {
  peerId: string;
  enabled: boolean;
  engine: ChatEngine;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  return (
    <div className="contact-profile-field auto-accept-files">
      <div className="contact-field-row">
        <span>{t("自动接收文件")}</span>
        <button
          type="button"
          role="switch"
          aria-label={t("自动接收文件")}
          aria-checked={enabled}
          className="contact-switch"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await engine.updatePeerAutoAcceptFiles(peerId, !enabled);
            } catch {
              onNotice(t("设置未保存，请重试"));
            } finally {
              setSaving(false);
            }
          }}
        >
          <span />
        </button>
      </div>
    </div>
  );
}

function SharedFiles({
  messages,
  engine,
  onNotice,
  onDelete,
  onForward,
}: {
  messages: Message[];
  engine: ChatEngine;
  onNotice: (message: string) => void;
  onDelete: (message: Message) => void;
  onForward: (message: Message) => void;
}) {
  const { t } = useTranslation();
  const files = messages.filter((m) => m.kind !== "text");
  return (
    <div className="detail-section">
      <h3>
        {t("共享文件")}
        <span>{files.length.toString().padStart(2, "0")}</span>
      </h3>
      {files.length ? (
        files
          .slice(-3)
          .reverse()
          .map((file) => (
            <div className="shared-file" key={file.id}>
              {file.kind === "image" ? (
                <ImageIcon size={19} />
              ) : (
                <File size={19} />
              )}
              <span>
                <strong title={file.fileName}>{file.fileName}</strong>
                <small>
                  {readableSize(file.size)}
                  {file.attachmentStorage === "external"
                    ? ` · ${t("仅保留传输记录")}`
                    : ""}
                </small>
              </span>
              <SharedFileActions
                fileName={file.fileName || t("附件")}
                transferring={
                  file.status === "sending" ||
                  file.status === "awaiting-acceptance"
                }
                recordOnly={
                  file.attachmentStorage === "external" ||
                  (file.senderId !== engine.getSnapshot().profile.id &&
                    file.status === "failed")
                }
                canForward={!file.folder}
                onDownload={() => {
                  void downloadAttachment(engine.storage, file).catch((error) =>
                    onNotice(
                      error instanceof Error ? error.message : "无法读取附件",
                    ),
                  );
                }}
                onForward={() => onForward(file)}
                onDelete={() => onDelete(file)}
              />
            </div>
          ))
      ) : (
        <div className="shared-empty">
          <FolderOpen size={25} />
          <p>{t("分享的文件会出现在这里")}</p>
        </div>
      )}
    </div>
  );
}

function ContactNumber({
  peer,
  onConnect,
}: {
  peer: Profile;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="contact-profile-field contact-number">
      <div className="contact-field-row">
        <span className="contact-field-label">{t("蜂鸟号")}</span>
        <span className="contact-field-value">
          <b>{peer.numericId || t("暂无蜂鸟号")}</b>
          <button
            type="button"
            className="icon-button"
            aria-label={t("连接此分组")}
            title={t("连接此分组")}
            onClick={onConnect}
            disabled={!peer.numericId}
          >
            <ArrowRight size={15} />
          </button>
        </span>
      </div>
    </div>
  );
}
