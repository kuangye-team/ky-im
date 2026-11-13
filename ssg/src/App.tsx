import { deviceLabel } from "./core/profile";
import { getInviteUrl } from "./invite-url";
import { ClientAccess } from "./components/ClientAccess";
import { handleExternalLinkClick } from "./external-links";
import { DesktopVersion } from "./components/DesktopVersion";
import {
  PROFILE_AVATARS as EMOJI,
  PROFILE_COLORS as COLORS,
  PROFILE_NAME_MAX_LENGTH,
  PROFILE_BIO_MAX_LENGTH,
  COMPOSER_MAX_LENGTH,
  FOLDER_CONFIG,
} from "./config";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { i18n, resolveLanguage } from "./i18n";
import { generateProfileName, generateProfileBio } from "./core/profile";
import { LanguageSelector } from "./components/LanguageSelector";
import { ThemeSelector } from "./components/ThemeSelector";
import { translateError } from "./localizeError";
import "./i18n.css";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Copy,
  File,
  FileText,
  FolderOpen,
  Forward,
  HardDrive,
  Image as ImageIcon,
  Info,
  Laptop,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Plus,
  Radio,
  RefreshCw,
  Search,
  ScrollText,
  Settings,
  Send,
  ShieldCheck,
  Shuffle,
  Smartphone,
  Smile,
  Sparkles,
  Trash2,
  Users,
  Wifi,
  X,
} from "lucide-react";
import { MAX_FILE_SIZE, type ChatEngine } from "./core";
import { isPeerOnline } from "./core/types";
import type { Profile, Message, ChatSnapshot } from "./core/types";
import { Modal } from "./components/Modal";
import { RemarkEditor } from "./components/RemarkEditor";
import { ContactActions } from "./components/ContactActions";
import { OwnNumber } from "./components/OwnNumber";
import { ContactCopyButton } from "./components/ContactCopyButton";
import { copyText } from "./components/copyText";
import { siteInfo } from "./site-info";
import { HistoryPage } from "./components/HistoryPage";
import { RuntimeLogs } from "./components/RuntimeLogs";
import { SystemSettings } from "./components/SystemSettings";
import { StoragePage } from "./components/StoragePage";
import { ForwardMessageModal } from "./components/ForwardMessageModal";
import { MyStatus } from "./components/MyStatus";
import { SharedFileActions } from "./components/SharedFileActions";
import {
  readDirectory,
  readDirectoryFiles,
  readDroppedDirectory,
  type DirectoryPickerWindow,
} from "./components/folderSelection";
import type { FolderProgress, ReadFolder } from "./core/folders";
import {
  canSaveLargeFiles,
  canSaveFolders,
  chooseFileDestination,
  chooseFolderDestination,
  readableSize,
  downloadAttachment,
  download as saveBlob,
} from "./components/fileDownloads";
import { LegalLinks, LicensesPage, PrivacyPage } from "./components/Legal";
import { UpdateBanner } from "./components/UpdateBanner";
import { DesktopUpdateDialog } from "./components/DesktopUpdateDialog";
import { isDesktop } from "./core/network/settings";
import { getChatDrafts, setChatDraft, subscribeChatDrafts } from "./drafts";

type View =
  | "chat"
  | "nearby"
  | "history"
  | "storage"
  | "settings"
  | "licenses"
  | "privacy";
const pageNames: Record<View, string> = {
  chat: "聊天消息",
  nearby: "在线设备",
  history: "聊天记录",
  storage: "存储管理",
  settings: "系统配置",
  licenses: "开源许可",
  privacy: "隐私协议",
};
function currentView(pathname: string): View {
  const path = pathname.replace(/^\/|\/$/g, "");
  return path === "nearby" ||
    path === "history" ||
    path === "storage" ||
    path === "settings" ||
    path === "licenses" ||
    path === "privacy"
    ? path
    : "chat";
}
const time = (n: number) =>
  new Date(n).toLocaleTimeString(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  });
const day = (n: number) =>
  new Date(n).toLocaleDateString(i18n.language, {
    month: "long",
    day: "numeric",
  });
const validColor = (color: string) =>
  /^#[0-9a-f]{6}$/i.test(color) ? color : "#7266ed";
function Avatar({
  peer,
  size = "",
  online,
}: {
  peer: Profile;
  size?: string;
  online?: boolean;
}) {
  return (
    <span
      className={`avatar ${size}`}
      style={{ "--avatar-color": validColor(peer.color) } as CSSProperties}
    >
      <span>{peer.avatar || peer.name.slice(0, 1)}</span>
      {online !== undefined && <i className={online ? "online" : ""} />}
    </span>
  );
}
function DeviceIcon({ device, size = 16 }: { device: string; size?: number }) {
  return /phone|android|ios|手机/i.test(device) ? (
    <Smartphone size={size} />
  ) : (
    <Laptop size={size} />
  );
}
function peerName(peer: Profile, snap: ChatSnapshot) {
  return (
    snap.conversations.find((c) => c.peer.id === peer.id)?.remark || peer.name
  );
}

export function App({ engine }: { engine: ChatEngine }) {
  const { t } = useTranslation();
  const snap = useSyncExternalStore(
    (callback) => engine.subscribe(callback),
    () => engine.getSnapshot(),
  );
  const location = useLocation();
  const navigate = useNavigate();
  const view = currentView(location.pathname);
  const setView = (next: View) => {
    const path = next === "chat" ? "/" : `/${next}`;
    if (location.pathname !== path) void navigate(path);
  };
  const [filter, setFilter] = useState("");
  const [listTab, setListTab] = useState<"recent" | "online">("recent");
  const [modal, setModal] = useState<
    "profile" | "invite" | "help" | "clear" | "delete" | "contact" | null
  >(null);
  const [connectionPeer, setConnectionPeer] = useState<Profile | null>(null);
  const [details, setDetails] = useState(true);
  const [mobileChat, setMobileChat] = useState(false);
  const [notice, setNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [forwardTarget, setForwardTarget] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<{
    url: string;
    name: string;
  } | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setModal(null);
  }, [location.key]);
  useEffect(() => {
    workspaceRef.current?.scrollTo(0, 0);
    if (view === "licenses" || view === "privacy")
      workspaceRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [view]);
  const activePeer =
    snap.peers.find((p) => p.id === snap.activePeerId) ||
    snap.conversations.find((c) => c.peer.id === snap.activePeerId)?.peer;
  const activeRemark =
    snap.conversations.find((c) => c.peer.id === snap.activePeerId)?.remark ||
    "";
  const notify = (message: string) => setNotice(message);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const run = (promise: Promise<unknown>) => {
    void promise.catch((error) =>
      notify(error instanceof Error ? error.message : "操作未完成，请重试"),
    );
  };
  const deleteMessage = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await engine.deleteMessage(deleteTarget.id);
      setDeleteTarget(null);
      notify(
        engine.storage.getStorageInfo
          ? "消息已从此设备删除"
          : "消息已从此浏览器删除",
      );
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "删除失败，请重试",
      );
    } finally {
      setDeleting(false);
    }
  };
  useEffect(() => {
    setDeleteTarget(null);
    setDeleteError("");
    setForwardTarget(null);
  }, [snap.activePeerId]);
  const requestDelete = (message: Message) => {
    setDeleteError("");
    setDeleteTarget(message);
  };
  const selectPeer = (peer: Profile) => {
    run(engine.selectPeer(peer));
    setView("chat");
    setMobileChat(true);
  };
  const openConnection = (peer: Profile | null = null) => {
    setConnectionPeer(peer);
    setModal("invite");
  };
  const onlinePeers = snap.peers.filter((peer) => isPeerOnline(snap, peer.id));
  const peers =
    listTab === "online"
      ? onlinePeers
      : [
          ...snap.conversations.map(
            (c) => snap.peers.find((p) => p.id === c.peer.id) || c.peer,
          ),
          ...snap.peers.filter(
            (p) => !snap.conversations.some((c) => c.peer.id === p.id),
          ),
        ];
  const visiblePeers = peers.filter((p) =>
    `${peerName(p, snap)} ${p.name} ${p.bio} ${deviceLabel(p)} ${p.numericId || ""}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const connected = snap.status === "connected";
  const unread = snap.conversations.reduce((sum, c) => sum + c.unread, 0);
  useEffect(() => {
    document.title = `${t(pageNames[view])} · ${t("蜂鸟")}`;
  }, [t, view]);
  return (
    <div className="app-shell"
      onClickCapture={(event) => handleExternalLinkClick(event, () => notify("链接暂时无法打开，请稍后重试。"))}
      onAuxClickCapture={(event) => handleExternalLinkClick(event, () => notify("链接暂时无法打开，请稍后重试。"))}>
      <header className="topbar">
        <Link className="brand" to="/" aria-label={t("蜂鸟首页")}>
          <span className="brand-mark">
            <span className="hummingbird-logo" aria-hidden="true" />
          </span>
          <span>{t("蜂鸟")}</span>
        </Link>
        <div className="top-tagline">{t("轻快连接，自在分享。")}</div>
        <div className="top-actions">
          <ThemeSelector />
          <LanguageSelector />
          <MyStatus snap={snap} engine={engine} />
          <ClientAccess onNotice={notify} />
          <button
            className="icon-button about-trigger"
            aria-label={t("关于本站")}
            title={t("关于本站")}
            aria-haspopup="dialog"
            onClick={() => setModal("help")}
          >
            <CircleHelp size={21} aria-hidden="true" />
          </button>
        </div>
      </header>
      <UpdateBanner engine={engine} />
      {isDesktop() && <DesktopUpdateDialog />}
      <div className="app-layout">
        <aside className="sidebar">
          <button
            className="my-profile"
            onClick={() => setModal("profile")}
            aria-label={t("个人资料")}
          >
            <div className="profile-ring">
              <Avatar peer={snap.profile} size="avatar-xl" online={connected} />
            </div>
            <strong data-label={t("我的")}>{snap.profile.name}</strong>
            <span className="profile-number">
              {engine.supportsNumericIds ? (
                <>
                  {t("蜂鸟号")} {snap.profile.numericId || t("上线后显示")}
                </>
              ) : (
                t("局域网直连")
              )}
            </span>
            <span>{snap.profile.bio || t("给今天的自己打个招呼")}</span>
            <span className="my-device">
              <DeviceIcon device={snap.profile.device} />
              {deviceLabel(snap.profile)}
              <ChevronDown size={12} />
            </span>
          </button>
          <nav className="main-nav" aria-label={t("主导航")}>
            <button
              className={view === "chat" ? "active" : ""}
              aria-label={t("聊天消息")}
              onClick={() => {
                setView("chat");
                setMobileChat(false);
              }}
            >
              <MessageCircle size={20} />
              <span>{t("聊天消息")}</span>
              {unread > 0 && <b>{unread}</b>}
              <i />
            </button>
            <button
              className={view === "nearby" ? "active" : ""}
              onClick={() => setView("nearby")}
              aria-label={t("在线设备")}
            >
              <Users size={20} />
              <span>{t("在线设备")}</span>
              <small>{onlinePeers.length}</small>
              <i />
            </button>
            <button
              className={view === "history" ? "active" : ""}
              aria-label={t("聊天记录")}
              onClick={() => setView("history")}
            >
              <FileText size={20} />
              <span>{t("聊天记录")}</span>
              <i />
            </button>
            <button
              className={view === "storage" ? "active" : ""}
              aria-label={t("存储管理")}
              onClick={() => setView("storage")}
            >
              <HardDrive size={20} />
              <span>{t("存储管理")}</span>
              <i />
            </button>
            <button
              className={view === "settings" ? "active" : ""}
              aria-label={t("系统配置")}
              onClick={() => setView("settings")}
            >
              <Settings size={20} />
              <span>{t("系统配置")}</span>
              <i />
            </button>
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <span className="little-spark">
                <Sparkles size={16} aria-hidden="true" />
              </span>
              <strong>{t("近在咫尺，自在分享")}</strong>
              <p>
                {t("无需注册，没有复杂步骤。")}
                <br />
                {t("打开蜂鸟，让分享轻盈一点。")}
              </p>
              <LegalLinks current={view} className="sidebar-legal-links" />
            </div>
          </div>
        </aside>
        <main
          ref={workspaceRef}
          className={`workspace ${view !== "chat" ? "workspace-full" : ""} ${mobileChat ? "mobile-chat" : ""}`}
        >
          {view === "chat" ? (
            <>
              <section className="conversation-list">
                <div className="list-heading">
                  <h1>
                    {t("消息")}
                    <span>{peers.length.toString().padStart(2, "0")}</span>
                  </h1>
                  <button
                    className="icon-button new-chat"
                    aria-label={t("邀请朋友")}
                    aria-haspopup="dialog"
                    onClick={() => openConnection()}
                  >
                    <Plus size={19} />
                  </button>
                </div>
                <div className="search-field">
                  <Search size={16} />
                  <input
                    placeholder={t("搜索联系人")}
                    aria-label={t("搜索联系人")}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  {filter && (
                    <button
                      className="icon-button"
                      aria-label={t("清除搜索")}
                      onClick={() => setFilter("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="list-tabs">
                  <button
                    className={listTab === "recent" ? "active" : ""}
                    onClick={() => setListTab("recent")}
                    aria-label={t("最近聊天")}
                  >
                    <MessageCircle size={14} aria-hidden="true" />
                    {t("最近聊天")}
                  </button>
                  <button
                    className={listTab === "online" ? "active" : ""}
                    onClick={() => setListTab("online")}
                  >
                    <Users size={14} aria-hidden="true" />
                    {t("在线")}
                    <span>{onlinePeers.length}</span>
                  </button>
                </div>
                <div className="peer-list">
                  {visiblePeers.map((peer) => {
                    const conversation = snap.conversations.find(
                      (c) => c.peer.id === peer.id,
                    );
                    const online = isPeerOnline(snap, peer.id);
                    return (
                      <button
                        key={peer.id}
                        className={`peer-row ${snap.activePeerId === peer.id ? "selected" : ""}`}
                        onClick={() => selectPeer(peer)}
                        aria-label={t("与 {{value}} 聊天", {
                          value: peerName(peer, snap),
                        })}
                      >
                        <Avatar peer={peer} online={online} />
                        <div className="peer-copy">
                          <div>
                            <strong title={peer.name}>
                              {peerName(peer, snap)}
                            </strong>
                            <time>
                              {conversation
                                ? time(conversation.updatedAt)
                                : t(online ? "在线" : "离线")}
                            </time>
                          </div>
                          <p>
                            {online ? peer.bio || t("在附近，打个招呼吧") : t("离线") }
                          </p>
                          <span>
                            <DeviceIcon device={peer.device} size={12} />
                            {deviceLabel(peer)}
                          </span>
                        </div>
                        {!!conversation?.unread && (
                          <b className="unread">{conversation.unread}</b>
                        )}
                      </button>
                    );
                  })}
                  {visiblePeers.length === 0 && (
                    <div className="list-empty">
                      <span>
                        <Users size={25} />
                      </span>
                      <strong>
                        {filter ? t("没有找到联系人") : t("等待一位新朋友")}
                      </strong>
                      <p>
                        {filter
                          ? t("试试备注、名字或设备名称")
                          : t(
                              "连接同一个 Wi-Fi，打开蜂鸟\n在线的朋友会出现在这里",
                            )}
                      </p>
                      {!filter && (
                        <button onClick={() => openConnection()}>
                          {t("邀请朋友加入")}
                          <ArrowRight size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="list-footer">
                  <span className="list-footer-note">
                    <ShieldCheck size={14} aria-hidden="true" />
                    {t("你的数据非常重要")}
                  </span>
                  <LegalLinks className="list-legal-links" />
                  <button
                    className="list-about-trigger"
                    aria-haspopup="dialog"
                    onClick={() => setModal("help")}
                  >
                    <CircleHelp size={14} aria-hidden="true" />
                    {t("关于本站")}
                  </button>
                </div>
              </section>
              {activePeer ? (
                <ChatPanel
                  engine={engine}
                  snap={snap}
                  peer={activePeer}
                  onBack={() => setMobileChat(false)}
                  onDetails={() => {
                    if (window.innerWidth <= 1250) setModal("contact");
                    else setDetails((visible) => !visible);
                  }}
                  onNotice={notify}
                  onImage={setLightbox}
                  onDelete={requestDelete}
                  onForward={setForwardTarget}
                />
              ) : (
                <Welcome
                  count={onlinePeers.length}
                  connected={connected}
                  onInvite={() => openConnection()}
                  onNearby={() => setView("nearby")}
                />
              )}
              {activePeer && details && (
                <aside className="detail-panel" aria-label={t("联系人资料")}>
                  <div className="detail-top">
                    <span>{t("联系人资料")}</span>
                    <ContactActions
                      onExport={() =>
                        run(exportConversation(engine, activePeer))
                      }
                      onDelete={() => setModal("delete")}
                    />
                  </div>
                  <ContactDetails
                    peer={activePeer}
                    remark={activeRemark}
                    snap={snap}
                    engine={engine}
                    onConnectGroup={() => openConnection(activePeer)}
                    onDelete={requestDelete}
                    onForward={setForwardTarget}
                    onNotice={notify}
                  />
                </aside>
              )}
            </>
          ) : view === "nearby" ? (
            <section className="full-page">
              <div className="page-heading">
                <div>
                  <h1>
                    {t("在线的朋友")}
                    <span className="count-badge">{onlinePeers.length}</span>
                  </h1>
                  <button
                    className="primary-button"
                    onClick={() => openConnection()}
                  >
                    <Plus size={16} />
                    {t("邀请朋友")}
                  </button>
                </div>
                <p>
                  {t(
                    engine.supportsNumericIds
                      ? "同一网络自动发现；找不到朋友时，可以通过蜂鸟号连接。"
                      : "连接同一个网络并打开蜂鸟客户端，设备会自动出现。",
                  )}
                </p>
              </div>
              <div className="nearby-status">
                <span className={`status-dot ${connected ? "" : "offline"}`} />
                {connected
                  ? t("正在寻找打开蜂鸟的朋友")
                  : snap.status === "connecting"
                    ? t("正在连接，请稍候…")
                    : t("你当前离线，上线后可发现朋友")}
                <Radio size={18} />
              </div>
              {snap.peers.length ? (
                <div className="device-grid">
                  {snap.peers.map((peer) => (
                    <button
                      key={peer.id}
                      className="device-card"
                      onClick={() => selectPeer(peer)}
                    >
                      <span
                        className={`device-card-online ${!isPeerOnline(snap, peer.id) ? "connection-failed" : ""}`}
                      >
                        {t(isPeerOnline(snap, peer.id) ? "在线" : "离线")}
                      </span>
                      <Avatar peer={peer} size="avatar-xl" />
                      <h2 title={peer.name}>{peerName(peer, snap)}</h2>
                      <p>{peer.bio || t("很高兴见到你")}</p>
                      <span>
                        <DeviceIcon device={peer.device} />
                        {deviceLabel(peer)}
                      </span>
                      <div>
                        {t("开始聊天")}
                        <ArrowRight size={16} />
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <Welcome
                  count={0}
                  connected={connected}
                  onInvite={() => openConnection()}
                  onNearby={() => setModal("help")}
                  compact
                />
              )}
            </section>
          ) : view === "history" ? (
            <HistoryPage
              engine={engine}
              snap={snap}
              onClear={() => setModal("clear")}
              onNotice={notify}
            />
          ) : view === "storage" ? (
            <StoragePage engine={engine} snap={snap} onNotice={notify} />
          ) : view === "settings" ? (
            <SystemSettings engine={engine} onNotice={notify} />
          ) : view === "licenses" ? (
            <LicensesPage onNotice={notify} />
          ) : (
            <PrivacyPage onNotice={notify} />
          )}
        </main>
      </div>
      {(snap.error || notice) && (
        <div className="toast" role="status">
          <Info size={18} />
          <span>{translateError(notice || snap.error || "")}</span>
          {snap.status === "disconnected" &&
            snap.availability !== "offline" &&
            !notice && (
              <button onClick={() => engine.reconnect()}>
                <RefreshCw size={14} aria-hidden="true" />
                {t("重新连接")}
              </button>
            )}
          <button
            className="icon-button"
            aria-label={t("关闭提示")}
            onClick={() => {
              setNotice("");
              engine.dismissError();
            }}
          >
            <X size={17} />
          </button>
        </div>
      )}
      <ProfileModal
        open={modal === "profile"}
        onClose={() => setModal(null)}
        profile={snap.profile}
        snap={snap}
        engine={engine}
        onNotice={notify}
      />
      <InviteModal
        open={modal === "invite"}
        onClose={() => setModal(null)}
        profile={snap.profile}
        connected={connected}
        previousPeer={connectionPeer}
        engine={engine}
        onNotice={notify}
        onConnected={() => {
          setModal(null);
          setFilter("");
          setListTab("online");
          setView("nearby");
          setMobileChat(false);
          notify("已找到分组，正在连接在线设备");
        }}
      />
      <Modal
        open={modal === "contact"}
        onClose={() => setModal(null)}
        title={t("联系人资料")}
        description={t("查看对方资料，管理你们的聊天记录。")}
        headerActions={
          activePeer && (
            <ContactActions
              onExport={() => run(exportConversation(engine, activePeer))}
              onDelete={() => setModal("delete")}
            />
          )
        }
      >
        {activePeer && (
          <ContactDetails
            peer={activePeer}
            remark={activeRemark}
            snap={snap}
            engine={engine}
            onConnectGroup={() => openConnection(activePeer)}
            onDelete={requestDelete}
            onForward={setForwardTarget}
            onNotice={notify}
          />
        )}
      </Modal>
      <Modal
        open={modal === "help"}
        onClose={() => setModal(null)}
        title={t("关于蜂鸟")}
        description={t("轻快连接，自在分享。")}
        className="about-modal"
      >
        <DesktopVersion engine={engine} />
        <div className="about-layout">
          <div className="help-content">
            <div>
              <Wifi />
              <h3>{t("连接同一个网络")}</h3>
              <p>
                {t(
                  engine.supportsNumericIds
                    ? "让两台设备连接同一个 Wi-Fi，或同一个有线网络，再打开本网站即可。"
                    : "连接同一个网络并打开蜂鸟客户端，设备会自动出现。",
                )}
              </p>
            </div>
            <div>
              <MessageCircle />
              <h3>{t("找到彼此，开始聊天")}</h3>
              <p>
                {t(
                  engine.supportsNumericIds
                    ? "找不到朋友时，可通过“邀请朋友”输入蜂鸟号。聊天和传文件时，双方需保持在线。文件默认需确认接收，可在联系人资料中开启自动接收。"
                    : "聊天和传文件时，请保持双方客户端在线。文件默认需确认接收。",
                )}
              </p>
            </div>
            <div>
              <ShieldCheck />
              <h3>
                {t(engine.supportsNumericIds ? "优先直接传输" : "局域网直连")}
              </h3>
              <p>
                {t(
                  engine.supportsNumericIds
                    ? "消息和文件优先在设备之间直传。双方开启同一服务器的中转后，直连失败时才会由服务器转送，服务器不保存聊天内容。"
                    : "消息和文件直接在设备之间传输，无需中心服务器。请在可信的局域网中使用。",
                )}
              </p>
            </div>
            <div>
              <HardDrive />
              <h3>{t("记录，留在自己手里")}</h3>
              <p>
                {t(
                  engine.storage.getStorageInfo
                    ? "聊天记录和附件保存在此设备的数据目录，不会自动同步。重要文件记得备份。"
                    : "聊天记录和普通附件保存在当前浏览器，不会自动同步。清理浏览器可能丢失记录，重要文件记得下载保存。",
                )}
              </p>
            </div>
          </div>
          <section
            className="about-contact"
            aria-labelledby="about-contact-title"
          >
            <h3 id="about-contact-title">{t("联系我们")}</h3>
            <p>
              {t(
                "如果有任何想法、建议、合作或纠纷，欢迎通过以下方式与我们取得联系。",
              )}
            </p>
            <dl className="about-contact-list">
              <div>
                <dt>{t("主页")}</dt>
                <dd className="about-contact-value">
                  <a
                    href={siteInfo.website}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span>
                      {siteInfo.website
                        .replace(/^https?:\/\//, "")
                        .replace(/\/$/, "")}
                    </span>
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </a>
                  <ContactCopyButton
                    value={siteInfo.website}
                    kind="website"
                    onNotice={notify}
                  />
                </dd>
              </div>
              <div>
                <dt>{t("源码")}</dt>
                <dd className="about-contact-value">
                  <a
                    href={siteInfo.repository}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span>
                      {siteInfo.repository
                        .replace(/^https?:\/\//, "")
                        .replace(/\/$/, "")}
                    </span>
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </a>
                  <ContactCopyButton
                    value={siteInfo.repository}
                    kind="repository"
                    onNotice={notify}
                  />
                </dd>
              </div>
              <div>
                <dt>{t("邮箱")}</dt>
                <dd className="about-contact-value">
                  <a href={`mailto:${siteInfo.email}`}>
                    <span>{siteInfo.email}</span>
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </a>
                  <ContactCopyButton
                    value={siteInfo.email}
                    kind="email"
                    onNotice={notify}
                  />
                </dd>
              </div>
            </dl>
          </section>
        </div>
        <button
          className="primary-button full-button"
          onClick={() => setModal(null)}
        >
          <ArrowRight size={16} aria-hidden="true" />
          {t("开始使用")}
        </button>
      </Modal>
      <Modal
        open={modal === "clear" || modal === "delete"}
        onClose={() => setModal(null)}
        title={
          modal === "clear" ? t("清空本地聊天记录？") : t("删除这段聊天记录？")
        }
        description={t(
          engine.storage.getStorageInfo
            ? "这会删除此设备中的消息、附件和对应联系人的备注，无法恢复。对方的记录不受影响。"
            : "这会删除此浏览器中的消息、附件和对应联系人的备注，无法恢复。对方的记录不受影响。",
        )}
      >
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => setModal(null)}>
            <X size={15} aria-hidden="true" />
            {t("取消")}
          </button>
          <button
            className="danger-button"
            onClick={() => {
              const operation =
                modal === "clear"
                  ? engine.clearHistory()
                  : activePeer
                    ? engine.deleteConversation(activePeer.id)
                    : Promise.resolve();
              run(
                operation.then(() => {
                  setModal(null);
                  notify("聊天记录已删除");
                }),
              );
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
            {t("确认删除")}
          </button>
        </div>
      </Modal>
      <Modal
        open={!!lightbox}
        onClose={() => setLightbox(null)}
        title={lightbox?.name || t("图片预览")}
        wide
      >
        {lightbox && (
          <img
            className="lightbox-image"
            src={lightbox.url}
            alt={lightbox.name}
          />
        )}
      </Modal>
      {forwardTarget && (
        <ForwardMessageModal
          message={forwardTarget}
          engine={engine}
          snap={snap}
          onClose={() => setForwardTarget(null)}
          onNotice={notify}
        />
      )}
      <Modal
        open={deleteTarget !== null}
        onClose={() => !deleting && setDeleteTarget(null)}
        title={t("删除这条消息？")}
        description={t(
          engine.storage.getStorageInfo
            ? "这会删除此设备中的这条消息和对应附件，无法恢复。对方的记录不受影响。"
            : "这会删除此浏览器中的这条消息和对应附件，无法恢复。对方的记录不受影响。",
        )}
      >
        <div className="message-delete-preview">
          {deleteTarget?.kind === "text"
            ? deleteTarget.text
            : deleteTarget?.fileName || t("附件")}
        </div>
        {deleteError && (
          <p className="message-delete-error" role="alert">
            {translateError(deleteError)}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="secondary-button"
            disabled={deleting}
            onClick={() => setDeleteTarget(null)}
          >
            <X size={15} aria-hidden="true" />
            {t("取消")}
          </button>
          <button
            className="danger-button"
            disabled={deleting}
            onClick={() => void deleteMessage()}
          >
            {deleting ? (
              <LoaderCircle size={15} className="spinning" aria-hidden="true" />
            ) : (
              <Trash2 size={15} aria-hidden="true" />
            )}
            {deleting ? t("删除中…") : t("确认删除")}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function ContactDetails({
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
          <DeviceIcon device={peer.device} />
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
          {engine.supportsNumericIds && (
            <ContactNumber peer={peer} onConnect={onConnectGroup} />
          )}
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

function Welcome({
  count,
  connected,
  onInvite,
  onNearby,
  compact = false,
}: {
  count: number;
  connected: boolean;
  onInvite: () => void;
  onNearby: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className={`welcome ${compact ? "welcome-compact" : ""}`}>
      <div className="welcome-top">
        <span>
          <span className={`status-dot ${connected ? "" : "offline"}`} />
          {connected ? t("发现身边的美好") : t("等待网络连接")}
        </span>
      </div>
      <div className="welcome-main">
        <div className="connection-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <span className="art-dot dot-one" />
          <span className="art-dot dot-two" />
          <div className="art-peer art-peer-left">
            <span>🌿</span>
            <i />
          </div>
          <div className="art-peer art-peer-right">
            <span>🪐</span>
            <i />
          </div>
          <div className="art-bubble art-bubble-top">
            <span />
            {t("嗨，朋友！")}
          </div>
          <div className="art-bubble art-bubble-bottom">
            <FileText size={16} />
            <span>{t("分享一点好东西")}</span>
            <CheckCheck size={13} />
          </div>
          <div className="art-center">
            <span className="hummingbird-logo" />
            <span className="art-spark">✦</span>
          </div>
        </div>
        <h1>
          『<span>{t("让分享，轻快抵达")}</span>』
        </h1>
        <p>
          {t("连接同一个 Wi-Fi，打开蜂鸟。")}
          <br />
          {t("聊聊天，传照片，把好东西分享给身边的人。")}
        </p>
        <div className="welcome-buttons">
          <button className="primary-button" onClick={onInvite}>
            <Plus size={17} />
            {t("邀请朋友加入")}
          </button>
          <button className="text-button" onClick={onNearby}>
            {compact ? t("使用帮助") : t("查看在线设备")}
            <ArrowRight size={15} />
          </button>
        </div>
        <div className="online-caption">
          <span className={`status-dot ${connected ? "" : "offline"}`} />
          {count
            ? t("{{count}} 位朋友在线，挑一位打个招呼吧", { count: count })
            : t("等朋友上线，让分享即刻发生")}
        </div>
      </div>
      <div className="welcome-features">
        <span>
          <Radio size={17} />
          {t("无需登录注册")}
        </span>
        <span>
          <ShieldCheck size={17} />
          {t("私密高速传输")}
        </span>
        <span>
          <HardDrive size={17} />
          {t("数据保存在本地")}
        </span>
      </div>
    </section>
  );
}

function ChatPanel({
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
      await engine.sendText(content);
    } catch (error) {
      setChatDraft(peer.id, getChatDrafts()[peer.id] || content);
      onNotice(error instanceof Error ? error.message : "消息发送失败");
    }
    textRef.current?.focus();
  };
  const sendFiles = (files: File[]) => {
    if (!canSend) {
      onNotice("你已离线，请先上线再发送");
      return;
    }
    void engine
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
      return await engine.sendFolder(
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
  const chooseFolder = () => {
    if (import.meta.env.VITE_DESKTOP) {
      void sendFolder(async (signal, report) =>
        (await import("./components/desktopFolderSelection")).readDesktopFolder(
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
              day(messages[i - 1].createdAt) !== day(message.createdAt)) && (
              <div className="day-divider">
                <span>{day(message.createdAt)}</span>
              </div>
            )}
            <MessageBubble
              message={message}
              mine={message.senderId === snap.profile.id}
              peer={message.senderId === snap.profile.id ? snap.profile : peer}
              engine={engine}
              progress={snap.transfers[message.id]}
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
              onClick={() => imageRef.current?.click()}
              disabled={!canSend}
            >
              <ImageIcon size={20} />
            </button>
            <button
              className="icon-button"
              aria-label={t("发送文件")}
              onClick={() => fileRef.current?.click()}
              disabled={!canSend}
            >
              <Paperclip size={20} />
            </button>
            <button
              className="icon-button"
              aria-label={t("发送文件夹")}
              title={t(
                engine.storage.createFolderDestination
                  ? "文件夹将保留目录结构并直接传输到对方设备"
                  : "不超过 {{limit}} MB 且不超过 {{count}} 个文件的文件夹将打包发送，其他文件夹直接保存到对方设备",
                {
                  limit: MAX_FILE_SIZE / 1024 ** 2,
                  count: FOLDER_CONFIG.maxCompressedFiles,
                },
              )}
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
          placeholder={
            online
              ? t("分享点什么，让对话发生…")
              : t("对方不在线，可能接收不到消息")
          }
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

function MessageBubble({
  message,
  mine,
  peer,
  engine,
  progress,
  onNotice,
  onImage,
  onDelete,
  onForward,
}: {
  message: Message;
  mine: boolean;
  peer: Profile;
  engine: ChatEngine;
  progress?: number;
  onNotice: (text: string) => void;
  onImage: (image: { url: string; name: string }) => void;
  onDelete: () => void;
  onForward: () => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [choosing, setChoosing] = useState(false);
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
        await engine.acceptFile(message.id);
      } else if (message.folder) {
        const destination = await chooseFolderDestination(
          message.fileName || t("文件夹"),
        );
        await engine.acceptFolder(message.id, destination);
      } else if (external) {
        const destination = await chooseFileDestination(
          message.fileName || t("附件"),
        );
        await engine.acceptFile(message.id, destination);
      } else {
        await engine.acceptFile(message.id);
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
  useEffect(() => {
    if (message.kind !== "image") return;
    let alive = true;
    let objectUrl = "";
    void engine
      .getAttachment(message.id)
      .then((blob) => {
        if (blob && alive) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [engine, message.id, message.kind, message.status]);
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
      data-message-id={message.id}
    >
      <Avatar peer={peer} size="avatar-small" />
      <div className="message-content">
        {message.kind === "text" ? (
          <div className="text-bubble">{message.text}</div>
        ) : (
          <div
            className={`attachment-bubble ${message.kind === "image" ? "image-bubble" : ""}`}
          >
            {message.kind === "image" && url ? (
              <button
                className="image-preview"
                aria-label={t("预览 {{value}}", { value: message.fileName })}
                onClick={() =>
                  onImage({ url, name: message.fileName || t("图片") })
                }
              >
                <img
                  src={url}
                  alt={message.fileName || t("收到的图片")}
                  loading="lazy"
                />
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
            {time(message.createdAt)}
          </time>
          {mine && (
            <span
              className={message.status === "failed" ? "danger-text" : ""}
              title={message.error ? translateError(message.error) : undefined}
            >
              {awaiting ? (
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
                {message.status === "sending" ? t("接收中") : t("接收失败")}
              </span>
            )}
          {message.kind !== "text" &&
            progress !== undefined &&
            (mine || !awaiting) && (
              <button
                className="message-delete-button"
                aria-label={t("取消传输")}
                onClick={() => void engine.cancelTransfer(message.id)}
              >
                <X size={12} />
                {t("取消传输")}
              </button>
            )}
          {awaiting && !mine && (
            <>
              <button
                className="message-forward-button"
                disabled={choosing || !canSave}
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
                onClick={() => engine.rejectFile(message.id)}
              >
                <X size={12} />
                {t("拒收")}
              </button>
            </>
          )}
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
          </button>
        </div>
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

function InviteModal({
  open,
  onClose,
  profile,
  connected,
  previousPeer,
  engine,
  onNotice,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  profile: Profile;
  connected: boolean;
  previousPeer: Profile | null;
  engine: ChatEngine;
  onNotice: (message: string) => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const [numericId, setNumericId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null);
  const url = getInviteUrl(location.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  useEffect(() => {
    if (!open) return;
    setNumericId(previousPeer?.numericId || "");
    setError("");
    setCopied(false);
  }, [open, previousPeer]);
  const copyAddress = async () => {
    try {
      await copyText(
        url,
        copyButton.current?.closest<HTMLElement>('[role="dialog"]'),
      );
      setCopied(true);
      onNotice("邀请地址已复制");
    } catch {
      onNotice("请选中地址后手动复制");
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!/^[1-9][0-9]{5}$/.test(numericId)) {
      setError("请输入 6 位蜂鸟号，第一位不能是 0");
      return;
    }
    if (!connected) {
      setError("请先切换为在线，连接后再查找设备");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await engine.connectByNumericId(numericId);
      onConnected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接未成功，请重试");
    } finally {
      setBusy(false);
    }
  };
  if (!engine.supportsNumericIds)
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={t("邀请朋友")}
        description={t("局域网直连")}
      >
        <p>{t("连接同一个网络并打开蜂鸟客户端，设备会自动出现。")}</p>
        <p>{t("请允许蜂鸟访问本地网络，并在防火墙中允许连接。")}</p>
      </Modal>
    );
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={t("邀请朋友")}
      description={t("分享网址和蜂鸟号，找到彼此的在线设备。")}
    >
      <OwnNumber
        numericId={profile.numericId}
        onNotice={onNotice}
        connected={connected}
        onRefresh={() => engine.refreshNumericId()}
      />
      <label className="form-label" htmlFor="invite-address">
        {t("访问地址")}
      </label>
      <div className="copy-field">
        <input
          id="invite-address"
          value={url}
          readOnly
          onFocus={(event) => event.target.select()}
        />
        <button
          ref={copyButton}
          className="primary-button"
          type="button"
          onClick={() => void copyAddress()}
          aria-label={t("复制邀请地址")}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? t("已复制") : t("复制")}
        </button>
      </div>
      {local && (
        <p className="invite-local-note">
          {t("当前地址只能在这台设备打开，请使用朋友也能访问的蜂鸟网址。")}
        </p>
      )}
      <div className="invite-divider">
        <span>{t("找不到朋友的设备？")}</span>
      </div>
      <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
        <label className="form-label" htmlFor="connect-number">
          {t("朋友的蜂鸟号")}
        </label>
        <div className="copy-field">
          <input
            id="connect-number"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("输入 6 位蜂鸟号")}
            value={numericId}
            maxLength={6}
            disabled={busy}
            aria-invalid={!!error}
            aria-describedby={error ? "connect-error" : undefined}
            onChange={(event) => {
              setNumericId(event.target.value.replace(/\D/g, "").slice(0, 6));
              setError("");
            }}
          />
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !connected || numericId.length !== 6}
          >
            {busy ? (
              <LoaderCircle size={16} className="spinning" />
            ) : (
              <ArrowRight size={16} />
            )}
            {busy ? t("正在查找…") : t("连接")}
          </button>
        </div>
        {error && (
          <p className="connect-error" id="connect-error" role="alert">
            {translateError(error)}
          </p>
        )}
      </form>
    </Modal>
  );
}

function ProfileModal({
  open,
  onClose,
  profile,
  snap,
  engine,
  onNotice,
}: {
  open: boolean;
  onClose: () => void;
  profile: Profile;
  snap: ChatSnapshot;
  engine: ChatEngine;
  onNotice: (s: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(profile.name);
  const [bio, setBio] = useState(profile.bio);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [color, setColor] = useState(profile.color);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(profile.name);
      setBio(profile.bio);
      setAvatar(profile.avatar);
      setColor(profile.color);
    }
  }, [open, profile.name, profile.bio, profile.avatar, profile.color]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await engine.updateProfile({
        name: name.trim(),
        bio: bio.trim(),
        avatar,
        color,
      });
      onClose();
      onNotice("个人资料已更新");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("让朋友认识你")}
      description={t("设置一个喜欢的头像和名字，在线设备都能看到。")}
      className="profile-modal"
    >
      <form onSubmit={(e) => void submit(e)}>
        <div className="profile-editor">
          <div className="profile-appearance">
            <div className="profile-identity">
              <Avatar
                peer={{ ...profile, name, avatar, color }}
                size="avatar-xl"
                online={snap.status === "connected"}
              />
              <div className="profile-identity-copy">
                <strong>{name.trim() || t("你的名字")}</strong>
                <MyStatus snap={snap} engine={engine} compact />
              </div>
            </div>
            {engine.supportsNumericIds && (
              <OwnNumber
                numericId={profile.numericId}
                compact
                onNotice={onNotice}
                connected={snap.status === "connected"}
                onRefresh={() => engine.refreshNumericId()}
              />
            )}
            <p className="profile-status-hint">
              {snap.availability === "offline"
                ? t("主动离线后停止发现和连接，本地聊天记录仍保留。")
                : snap.status === "connected"
                  ? t("你已在线，朋友可以发现并连接这台设备。")
                  : t("当前离线，网络可用后可重新连接。")}
            </p>
            <label className="form-label">{t("选择头像")}</label>
            <div className="avatar-options">
              {EMOJI.map((value) => (
                <button
                  type="button"
                  aria-label={t("头像 {{value}}", { value: value })}
                  aria-pressed={avatar === value}
                  className={avatar === value ? "selected" : ""}
                  key={value}
                  onClick={() => setAvatar(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="color-options">
              {COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  style={{ background: value }}
                  className={color === value ? "selected" : ""}
                  aria-label={t("头像颜色 {{value}}", { value: value })}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                >
                  {color === value && <Check size={14} />}
                </button>
              ))}
            </div>
          </div>
          <div className="profile-details">
            <div className="profile-field-heading">
              <label className="form-label" htmlFor="profile-name">
                {t("显示名称")}
                <span>
                  {name.length}/{PROFILE_NAME_MAX_LENGTH}
                </span>
              </label>
              <button
                type="button"
                className="profile-generate"
                aria-label={t("随机生成昵称")}
                disabled={busy}
                onClick={() =>
                  setName(
                    generateProfileName(
                      resolveLanguage("system", i18n.language),
                      name,
                    ),
                  )
                }
              >
                <Shuffle size={13} aria-hidden="true" />
                {t("随机生成")}
              </button>
            </div>
            <input
              id="profile-name"
              className="form-input"
              value={name}
              maxLength={PROFILE_NAME_MAX_LENGTH}
              required
              onChange={(e) => setName(e.target.value)}
              placeholder={t("怎么称呼你？")}
            />
            <div className="profile-field-heading">
              <label className="form-label" htmlFor="profile-bio">
                {t("个性签名")}
                <span>{t("选填")}</span>
              </label>
              <button
                type="button"
                className="profile-generate"
                aria-label={t("随机生成介绍")}
                disabled={busy}
                onClick={() =>
                  setBio(
                    generateProfileBio(
                      resolveLanguage("system", i18n.language),
                      bio,
                    ),
                  )
                }
              >
                <Shuffle size={13} aria-hidden="true" />
                {t("随机生成")}
              </button>
            </div>
            <textarea
              id="profile-bio"
              className="form-input"
              value={bio}
              maxLength={PROFILE_BIO_MAX_LENGTH}
              onChange={(e) => setBio(e.target.value)}
              placeholder={t("分享一点此刻的心情")}
            />
          </div>
        </div>
        <div className="modal-actions">
          <p className="profile-privacy-hint">
            {t("请勿填写不想分享的信息。")}
          </p>
          <button className="secondary-button" type="button" onClick={onClose}>
            <X size={15} aria-hidden="true" />
            {t("取消")}
          </button>
          <button
            className="primary-button"
            disabled={busy || !name.trim()}
            type="submit"
          >
            {busy ? t("保存中…") : t("保存资料")}
            <Check size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

async function exportConversation(engine: ChatEngine, peer: Profile) {
  const messages = await engine.storage.getMessages(peer.id);
  const remark = engine
    .getSnapshot()
    .conversations.find(
      (conversation) => conversation.peer.id === peer.id,
    )?.remark;
  await saveBlob(
    new Blob(
      [
        JSON.stringify(
          { exportedAt: new Date().toISOString(), peer, remark, messages },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
    i18n.t("蜂鸟-{{value}}-聊天记录.json", { value: remark || peer.name }),
  );
}
