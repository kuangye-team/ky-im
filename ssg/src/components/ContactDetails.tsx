import { deviceLabel } from "../core/profile";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { File, FolderOpen, Image as ImageIcon } from "lucide-react";
import type { ChatEngine } from "../core";
import { isPeerOnline } from "../core/types";
import type { Profile, Message, ChatSnapshot } from "../core/types";
import { RemarkEditor } from "./RemarkEditor";
import { CopyNumberButton } from "./OwnNumber";
import { FileMenuActions } from "./attachmentActions";
import { SharedFileActions } from "./SharedFileActions";
import { readableSize, downloadAttachment } from "./fileDownloads";
import { Avatar, DeviceIcon, peerName } from "./Avatar";

export function ContactDetails({
  allFiles = false,
  peer,
  snap,
  engine,
  showFields = true,
  onNotice,
  onDelete,
  onForward,
}: {
  allFiles?: boolean;
  peer: Profile;
  snap: ChatSnapshot;
  engine: ChatEngine;
  showFields?: boolean;
  onDelete: (message: Message) => void;
  onForward: (message: Message) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const remark = snap.conversations.find(c => c.peer.id === peer.id)?.remark;
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
        {showFields && <ContactFields key={peer.id} peer={peer} snap={snap} engine={engine} onNotice={onNotice} />}
      </div>
      <SharedFiles
        allFiles={allFiles}
        messages={snap.activePeerId === peer.id ? snap.messages : []}
        engine={engine}
        onNotice={onNotice}
        onDelete={onDelete}
        onForward={onForward}
      />
    </>
  );
}

export function ContactFields({ peer, snap, engine, onNotice }: {
  peer: Profile; snap: ChatSnapshot; engine: ChatEngine; onNotice: (message: string) => void;
}) {
  const conversation = snap.conversations.find(c => c.peer.id === peer.id);
  return <div className="contact-profile-fields">
    <RemarkEditor peerId={peer.id} remark={conversation?.remark || ""} engine={engine} onNotice={onNotice} />
    <AutoAcceptFiles peerId={peer.id} enabled={conversation?.autoAcceptFiles === true} engine={engine} onNotice={onNotice} />
    <ContactNumber peer={peer} onNotice={onNotice} />
  </div>;
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

export function SharedFiles({
  allFiles,
  heading,
  messages,
  engine,
  onNotice,
  onDelete,
  onForward,
}: {
  allFiles: boolean;
  heading?: string;
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
        {heading || t("共享文件")}
        <span>{files.length.toString().padStart(2, "0")}</span>
      </h3>
      {files.length ? (
        files
          .slice(allFiles ? 0 : -3)
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
              <FileMenuActions message={file} storage={engine.storage} onNotice={onNotice}>{actions => (
                <SharedFileActions
                  actions={actions}
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
              )}</FileMenuActions>
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
  onNotice,
}: {
  peer: Profile;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="contact-profile-field contact-number">
      <div className="contact-field-row">
        <span className="contact-field-label">{t("蜂鸟号")}</span>
        <span className="contact-field-value">
          <b>{peer.numericId || t("暂无蜂鸟号")}</b>
          <CopyNumberButton key={peer.numericId} numericId={peer.numericId} onNotice={onNotice} />
        </span>
      </div>
    </div>
  );
}
