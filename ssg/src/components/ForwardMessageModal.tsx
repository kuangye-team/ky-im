import { isPeerOnline } from "../core/types";
import { deviceLabel } from "../core/profile";
import { translateError } from "../localizeError";
import { useTranslation } from "react-i18next";
import { useRef, useState, type CSSProperties } from "react";
import {
  Check,
  File,
  Forward,
  Image,
  LoaderCircle,
  Search,
  Users,
  X,
} from "lucide-react";
import type { ChatEngine, ChatSnapshot, Message } from "../core";
import { Modal } from "./Modal";
import "./ForwardMessageModal.css";

export function ForwardMessageModal({
  message,
  engine,
  snap,
  onClose,
  onNotice,
}: {
  message: Message;
  engine: ChatEngine;
  snap: ChatSnapshot;
  onClose: () => void;
  onNotice: (text: string) => void;
}) {
  const { t } = useTranslation("components");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const sendingRef = useRef(false);
  const onlineIds = new Set(snap.peers.map((peer) => peer.id));
  const contacts = [
    ...snap.peers,
    ...snap.conversations
      .filter(({ peer }) => !onlineIds.has(peer.id))
      .map(({ peer }) => peer),
  ]
    .filter((peer) => peer.id !== snap.profile.id)
    .map((peer) => ({
      ...peer,
      displayName:
        snap.conversations.find((chat) => chat.peer.id === peer.id)?.remark ||
        peer.name,
      online: isPeerOnline(snap, peer.id) && snap.availability === "online",
    }));
  const visibleContacts = contacts.filter((peer) =>
    `${peer.displayName} ${peer.name} ${deviceLabel(peer)} ${peer.numericId || ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selected = visibleContacts.find((peer) => peer.id === selectedId);
  const forward = async () => {
    if (!selected || snap.availability !== "online" || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      await engine.forwardMessage(message, selected.id);
      onNotice(t("已转发给 {{name}}", { name: selected.displayName }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "转发失败，请重试");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !sendingRef.current && onClose()}
      title={t("转发消息")}
      description={t("选择一位朋友，分享这条消息。")}
    >
      <div className="forward-preview">
        <span className="forward-preview-label">
          {message.kind === "text" ? (
            <Forward size={15} />
          ) : message.kind === "image" ? (
            <Image size={15} />
          ) : (
            <File size={15} />
          )}
          {message.kind === "text"
            ? t("文字消息")
            : message.kind === "image"
              ? t("图片")
              : t("文件")}
        </span>
        <p>
          {message.kind === "text"
            ? message.text
            : message.fileName || t("附件")}
        </p>
      </div>
      <div className="search-field forward-search">
        <Search size={16} />
        <input
          aria-label={t("搜索转发联系人")}
          placeholder={t("搜索昵称或备注")}
          value={query}
          disabled={sending}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedId("");
            setError("");
          }}
        />
      </div>
      <div className="forward-contacts" role="group" aria-label={t("转发给")}>
        {visibleContacts.map((peer) => (
          <button
            type="button"
            className="forward-contact"
            key={peer.id}
            aria-label={t("选择 {{name}}", { name: peer.displayName })}
            aria-pressed={selectedId === peer.id}
            disabled={snap.availability !== "online" || sending}
            onClick={() => {
              setSelectedId(peer.id);
              setError("");
            }}
          >
            <span
              className="avatar avatar-small"
              style={
                {
                  "--avatar-color": /^#[0-9a-f]{6}$/i.test(peer.color)
                    ? peer.color
                    : "#7266ed",
                } as CSSProperties
              }
            >
              <span>{peer.avatar || peer.name.slice(0, 1)}</span>
              <i className={peer.online ? "online" : ""} />
            </span>
            <span className="forward-contact-copy">
              <strong>{peer.displayName}</strong>
              <small>
                {peer.online ? deviceLabel(peer) : t("离线 · 可能接收不到消息")}
              </small>
            </span>
            <span className="forward-contact-check" aria-hidden="true">
              {selectedId === peer.id && <Check size={14} />}
            </span>
          </button>
        ))}
        {!visibleContacts.length && (
          <div className="forward-empty" role="status">
            <Users size={25} />
            <p>
              {query.trim()
                ? t("没有找到匹配的联系人")
                : t("还没有可转发的联系人")}
            </p>
          </div>
        )}
      </div>
      {selected && !selected.online && (
        <p className="forward-hint">
          {t("对方不在线，可能接收不到消息")}
        </p>
      )}
      {error && (
        <p className="message-delete-error" role="alert">
          {t(translateError(error))}
        </p>
      )}
      <div className="modal-actions">
        <button
          className="secondary-button"
          disabled={sending}
          onClick={onClose}
        >
          <X size={15} aria-hidden="true" />
          {t("取消")}
        </button>
        <button
          className="primary-button"
          disabled={!selected || snap.availability !== "online" || sending}
          onClick={() => void forward()}
        >
          {sending ? (
            <LoaderCircle size={15} className="spinning" />
          ) : (
            <Forward size={15} />
          )}
          {sending ? t("正在转发…") : t("确认转发")}
        </button>
      </div>
    </Modal>
  );
}
