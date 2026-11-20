import { COMPOSER_MAX_LENGTH } from "../config";
import { useTranslation } from "react-i18next";
import { messageDay } from "./messageTime";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  FolderOpen,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  Paperclip,
  Search,
  ScrollText,
  Send,
  ShieldCheck,
  Smile,
  X,
} from "lucide-react";
import type { ChatEngine } from "../core";
import { isPeerOnline } from "../core/types";
import type { Profile, Message, ChatSnapshot } from "../core/types";
import { RuntimeLogs } from "./RuntimeLogs";
import {
  readDirectory,
  readDirectoryFiles,
  readDroppedDirectory,
  type DirectoryPickerWindow,
} from "./folderSelection";
import type { FolderProgress, ReadFolder } from "../core/folders";
import { readableSize } from "./fileDownloads";
import { getChatDrafts, setChatDraft, subscribeChatDrafts } from "../drafts";
import { Avatar, peerName } from "./Avatar";
import { MessageBubble } from "./MessageBubble";

export function ChatPanel({
  engine,
  snap,
  peer,
  onBack,
  onDetails,
  onNotice,
  onImage,
  onDelete,
  onForward,
}: {
  engine: ChatEngine;
  snap: ChatSnapshot;
  peer: Profile;
  onBack: () => void;
  onDetails: () => void;
  onNotice: (value: string) => void;
  onImage: (image: { url: string; name: string }) => void;
  onDelete: (message: Message) => void;
  onForward: (message: Message) => void;
}) {
  const { t } = useTranslation();
  const drafts = useSyncExternalStore(subscribeChatDrafts, getChatDrafts);
  const draft = drafts[peer.id] || "";
  const setDraft = (text: string) => setChatDraft(peer.id, text);
  const [emoji, setEmoji] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState<FolderProgress | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const previousMessages = useRef({ peerId: peer.id, count: 0 });
  const online = isPeerOnline(snap, peer.id);
  const canSend = snap.availability === "online";
  useEffect(() => {
    setPreparing(null);
    return () => {
      preparation.current?.abort();
      preparation.current = null;
    };
  }, [peer.id]);
  const messages = snap.messages.filter(
    (m) =>
      m.peerId === peer.id &&
      (!search ||
        `${m.text || ""} ${m.fileName || ""}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  useEffect(() => {
    if (
      previousMessages.current.peerId !== peer.id ||
      snap.messages.length > previousMessages.current.count
    ) {
      endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    previousMessages.current = { peerId: peer.id, count: snap.messages.length };
  }, [snap.messages.length, peer.id]);
  useEffect(() => {
    setSearch(null);
    setEmoji(false);
  }, [peer.id]);
  const send = async () => {
    if (!draft.trim() || !canSend) return;
    const content = draft;
    setDraft("");
    try {
      await engine.transfers.sendText(content);
    } catch (error) {
      setChatDraft(peer.id, getChatDrafts()[peer.id] || content);
      onNotice(error instanceof Error ? error.message : "消息发送失败");
    }
    textRef.current?.focus();
  };
  const sendFiles = (files: import("../core/types").AttachmentSource[]) => {
    if (!canSend) {
      onNotice("你已离线，请先上线再发送");
      return;
    }
    void engine.transfers
      .sendFiles(files, peer.id)
      .catch((error) =>
        onNotice(error instanceof Error ? error.message : "文件发送失败"),
      );
  };
  const sendFolder = async (read: ReadFolder) => {
    if (!canSend) {
      onNotice("你已离线，请先上线再发送");
      return false;
    }
    if (preparation.current) {
      onNotice("正在准备文件夹，请稍候");
      return false;
    }
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing({ phase: "scanning", fileCount: 0, size: 0 });
    try {
      return await engine.transfers.sendFolder(
        read,
        (progress) => {
          if (preparation.current !== controller) return;
          setPreparing(progress);
          if (!progress) preparation.current = null;
        },
        controller.signal,
        peer.id,
      );
    } catch (error) {
      if (
        !controller.signal.aborted &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        onNotice(
          error instanceof Error ? error.message : "文件夹发送失败，请重试",
        );
      return false;
    } finally {
      if (preparation.current === controller) {
        preparation.current = null;
        setPreparing(null);
      }
    }
  };
  const chooseFiles = (images = false) => {
    if (!import.meta.env.VITE_DESKTOP) { (images ? imageRef : fileRef).current?.click(); return; }
    void import("./desktopSources").then(m => m.chooseDesktopSources(images)).then(sendFiles)
      .catch(() => onNotice("文件无法读取，请重新选择"));
  };
  const chooseFolder = () => {
    if (import.meta.env.VITE_DESKTOP) {
      void sendFolder(async (signal, report) =>
        (await import("./desktopFolderSelection")).readDesktopFolder(
          signal,
          report,
        ),
      );
      return;
    }
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (picker) {
      // Call the picker during the click, then keep the destination peer fixed while it is open.
      const selected = picker.call(window, { mode: "read" });
      void sendFolder(async (signal, report) =>
        readDirectory(await selected, signal, report),
      );
    } else {
      onNotice("当前选择方式不包含空文件夹；如需保留空文件夹，请拖入文件夹");
      folderRef.current?.click();
    }
  };
  useEffect(() => {
    if (!import.meta.env.VITE_DESKTOP) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      unlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (disposed) return;
        if (event.payload.type === "enter" || event.payload.type === "over") setDragging(true);
        else setDragging(false);
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        void (async () => {
          const { desktopSources } = await import("./desktopSources");
          const { files, directories } = await desktopSources(paths);
          if (disposed) return;
          sendFiles(files);
          const { readDesktopFolder } = await import("./desktopFolderSelection");
          for (const root of directories) {
            if (disposed || !(await sendFolder((signal, report) => readDesktopFolder(signal, report, root)))) break;
          }
        })().catch(() => onNotice("文件无法读取，请重新选择"));
      });
      if (disposed) unlisten();
    }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [peer.id, canSend]);
  return (
    <section
      className={`chat-panel ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const entries = Array.from(e.dataTransfer.items).map((item) => ({
          entry: item.webkitGetAsEntry?.(),
          file: item.getAsFile(),
        }));
        const folders = entries.filter((item) => item.entry?.isDirectory);
        if (folders.length) {
          sendFiles(
            entries
              .filter((item) => !item.entry?.isDirectory)
              .flatMap((item) => (item.file ? [item.file] : [])),
          );
          void (async () => {
            for (const item of folders)
              if (
                !(await sendFolder((signal, report) =>
                  readDroppedDirectory(
                    item.entry as FileSystemDirectoryEntry,
                    signal,
                    report,
                  ),
                ))
              )
                break;
          })();
        } else if (e.dataTransfer.files.length)
          sendFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="chat-heading">
        <button
          className="icon-button mobile-back"
          aria-label={t("返回列表")}
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>
        <Avatar peer={peer} size="avatar-small" />
        <div>
          <h2 title={peer.name}>{peerName(peer, snap)}</h2>
          <span>
            <span className={`status-dot ${online && snap.peerStates[peer.id] === "connected" ? "" : "offline"}`} />
            {online
              ? snap.peerStates[peer.id] === "connected"
                ? t("在线 · 可以聊天了")
                : t("正在连接…")
              : snap.peers.some((p) => p.id === peer.id)
                ? t("离线 · 正在尝试重新连接")
                : t("离线 · 仍可尝试发送")}
          </span>
        </div>
        <div className="chat-heading-actions">
          <button className="icon-button" aria-label={t("查看连接日志")} title={t("查看连接日志")} onClick={() => setShowLogs(true)}><ScrollText size={19} /></button>
          <button
            className={`icon-button ${search !== null ? "tinted" : ""}`}
            aria-label={t("搜索聊天记录")}
            onClick={() => setSearch(search === null ? "" : null)}
          >
            <Search size={19} />
          </button>
          <button
            className="icon-button"
            aria-label={t("查看联系人资料")}
            onClick={onDetails}
          >
            <Info size={19} />
          </button>
        </div>
      </div>
      {showLogs && <RuntimeLogs key={peer.id} peer={peer} onClose={() => setShowLogs(false)} />}
      {search !== null && (
        <div className="message-search search-field">
          <Search size={16} />
          <input
            autoFocus
            aria-label={t("搜索聊天内容")}
            placeholder={t("搜索这段聊天中的文字或文件")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span>{t("{{count}} 条", { count: messages.length })}</span>
          <button
            className="icon-button"
            aria-label={t("关闭聊天搜索")}
            onClick={() => setSearch(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="messages" role="log" aria-label={t("聊天消息记录")}>
        <div className="conversation-start">
          <ShieldCheck size={13} />
          {t(
            engine.storage.getStorageInfo
              ? "点对点传输，记录保存在此设备"
              : "私密高速传输，记录保存在此浏览器",
          )}
        </div>
        {messages.length === 0 && (
          <div className="chat-empty">
            <span>👋</span>
            <h3>
              {search
                ? t("没有找到相关消息")
                : t("和 {{value}} 打个招呼吧", { value: peerName(peer, snap) })}
            </h3>
            <p>
              {search
                ? t("换个关键词，再试一次。")
                : t("从一句「你好」开始，分享身边的小美好。")}
            </p>
          </div>
        )}
        {messages.map((message, i) => (
          <div key={message.id}>
            {(i === 0 ||
              messageDay(messages[i - 1].createdAt) !== messageDay(message.createdAt)) && (
              <div className="day-divider">
                <span>{messageDay(message.createdAt)}</span>
              </div>
            )}
            <MessageBubble
              message={message}
              mine={message.senderId === snap.profile.id}
              peer={message.senderId === snap.profile.id ? snap.profile : peer}
              engine={engine}
              progress={snap.transfers[message.id]}
              recovering={engine.transfers.isTransferRecovering(message.id)}
              onNotice={onNotice}
              onImage={onImage}
              onForward={() => onForward(message)}
              onDelete={() => onDelete(message)}
            />
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="composer">
        {!online && (
          <p className="composer-presence-hint" role="status">
            {t("对方不在线，可能接收不到消息")}
          </p>
        )}
        <div className="composer-tools">
          <div>
            <button
              className={`icon-button ${emoji ? "tinted" : ""}`}
              aria-label={t("选择表情")}
              onClick={() => setEmoji(!emoji)}
              disabled={!canSend}
            >
              <Smile size={20} />
            </button>
            <button
              className="icon-button"
              aria-label={t("发送图片")}
              onClick={() => chooseFiles(true)}
              disabled={!canSend}
            >
              <ImageIcon size={20} />
            </button>
            <button
              className="icon-button"
              aria-label={t("发送文件")}
              onClick={() => chooseFiles()}
              disabled={!canSend}
            >
              <Paperclip size={20} />
            </button>
            <button
              className="icon-button"
              aria-label={t("发送文件夹")}
              title={t("文件夹将保留目录结构并直接传输到对方设备")}
              onClick={chooseFolder}
              disabled={!canSend || !!preparing}
            >
              <FolderOpen size={20} />
            </button>
          </div>
          <span>
            <ShieldCheck size={12} />
            {t("私密高速传输")}
          </span>
        </div>
        {preparing && (
          <div className="folder-preparation" role="status">
            <LoaderCircle size={16} className="spinning" />
            <span>
              <strong>
                {t(
                  preparing.phase === "scanning"
                    ? "正在统计文件夹…"
                    : "正在打包文件夹…",
                )}
              </strong>
              <small>
                {t("{{count}} 个文件", { count: preparing.fileCount })} ·{" "}
                {readableSize(preparing.size)}
              </small>
            </span>
            <button
              className="icon-button"
              aria-label={t("取消准备")}
              onClick={() => preparation.current?.abort()}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {emoji && (
          <div className="emoji-picker">
            {[
              "👋",
              "😊",
              "👍",
              "❤️",
              "🎉",
              "✨",
              "☕",
              "🤝",
              "😂",
              "🙏",
              "🌈",
              "✅",
            ].map((e) => (
              <button
                key={e}
                onClick={() => {
                  setDraft(draft + e);
                  setEmoji(false);
                  textRef.current?.focus();
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
        <input
          ref={imageRef}
          className="hidden-input"
          type="file"
          accept="image/*"
          multiple
          aria-label={t("选择图片")}
          onChange={(e) => {
            sendFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <input
          ref={fileRef}
          className="hidden-input"
          type="file"
          multiple
          aria-label={t("选择文件")}
          onChange={(e) => {
            sendFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <input
          ref={(element) => {
            folderRef.current = element;
            element?.setAttribute("webkitdirectory", "");
          }}
          className="hidden-input"
          type="file"
          multiple
          aria-label={t("选择文件夹")}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = "";
            if (files.length)
              void sendFolder((signal, report) =>
                readDirectoryFiles(files, signal, report),
              );
          }}
        />
        <textarea
          ref={textRef}
          aria-label={t("消息内容")}
          placeholder={t("分享点什么，让对话发生…")}
          value={draft}
          disabled={!canSend}
          maxLength={COMPOSER_MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              sendFiles(files);
            }
          }}
        />
        <div className="composer-bottom">
          <span>{t("Enter 发送 · Shift + Enter 换行")}</span>
          <button
            className="send-button"
            aria-label={t("发送消息")}
            disabled={!draft.trim() || !canSend}
            onClick={() => void send()}
          >
            {t("发送")}
            <Send size={15} />
          </button>
        </div>
      </div>
      {dragging && (
        <div className="drop-overlay">
          <FolderOpen size={44} />
          <h2>{t("松手，即刻分享")}</h2>
          <p>{t("文件需对方确认，除非对方已为你开启自动接收")}</p>
        </div>
      )}
    </section>
  );
}
