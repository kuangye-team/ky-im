import { deviceLabel } from "./core/profile";
import { ClientAccess } from "./components/ClientAccess";
import { handleExternalLinkClick } from "./external-links";
import { DesktopVersion } from "./components/DesktopVersion";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { i18n } from "./i18n";
import { LanguageSelector } from "./components/LanguageSelector";
import { ThemeSelector } from "./components/ThemeSelector";
import { useCompatibilityHelp } from "./components/CompatibilityHelp";
import { translateError } from "./localizeError";
import "./i18n.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  FileText,
  HardDrive,
  Info,
  LoaderCircle,
  MessageCircle,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  Wifi,
  X,
} from "lucide-react";
import type { ChatEngine } from "./core";
import { isPeerOnline } from "./core/types";
import type { Profile, Message } from "./core/types";
import { Modal } from "./components/Modal";
import { RefreshGuard } from "./components/RefreshGuard";
import { ContactActions } from "./components/ContactActions";
import { ContactCopyButton } from "./components/ContactCopyButton";
import { siteInfo } from "./site-info";
import { HistoryPage } from "./components/HistoryPage";
import { SystemSettings } from "./components/SystemSettings";
import { StoragePage } from "./components/StoragePage";
import { ForwardMessageModal } from "./components/ForwardMessageModal";
import { MyStatus } from "./components/MyStatus";
import { download as saveBlob } from "./components/fileDownloads";
import { LegalLinks, LicensesPage, PrivacyPage } from "./components/Legal";
import { UpdateBanner } from "./components/UpdateBanner";
import { DesktopUpdateDialog } from "./components/DesktopUpdateDialog";
import { isDesktop } from "./core/network/settings";
import { Avatar, DeviceIcon, peerName } from "./components/Avatar";
import { messageTime } from "./components/messageTime";
import { ContactDetails } from "./components/ContactDetails";
import { Welcome } from "./components/Welcome";
import { ChatPanel } from "./components/ChatPanel";
import { InviteModal } from "./components/InviteModal";
import { ProfileModal } from "./components/ProfileModal";

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
  const [toast, setToast] = useState<{ message: string; source: "notice" | "error" } | null>(null);
  const compatibilityHelp = useCompatibilityHelp();
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
  const notify = (message: string) => setToast({ message, source: "notice" });
  useEffect(() => {
    if (snap.error) setToast({ message: snap.error, source: "error" });
    else setToast(current => current?.source === "error" ? null : current);
  }, [snap.error]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
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
      <RefreshGuard engine={engine} />
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
              {t("蜂鸟号")} {snap.profile.numericId || "—"}
            </span>
            <span>{snap.profile.bio || t("给今天的自己打个招呼")}</span>
            <span className="my-device">
              <DeviceIcon peer={snap.profile} />
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
                                ? messageTime(conversation.updatedAt)
                                : t(online ? snap.peerStates[peer.id] === "connected" ? "在线" : "已发现" : "离线")}
                            </time>
                          </div>
                          <p>
                            {online ? peer.bio || t("在附近，打个招呼吧") : t("离线") }
                          </p>
                          <span>
                            <DeviceIcon peer={peer} size={12} />
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
                        {t(isPeerOnline(snap, peer.id) ? snap.peerStates[peer.id] === "connected" ? "在线" : "已发现" : "离线")}
                      </span>
                      <Avatar peer={peer} size="avatar-xl" />
                      <h2 title={peer.name}>{peerName(peer, snap)}</h2>
                      <p>{peer.bio || t("很高兴见到你")}</p>
                      <span>
                        <DeviceIcon peer={peer} />
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
      {toast && (
        <div className="toast" role="status">
          <Info size={18} />
          <span>{translateError(toast.message)}</span>
          {toast.message === snap.error && compatibilityHelp.button(snap.compatibilityReasons)}
          {snap.status === "disconnected" &&
            snap.availability !== "offline" &&
            toast.source === "error" && (
              <button onClick={() => engine.reconnect()}>
                <RefreshCw size={14} aria-hidden="true" />
                {t("重新连接")}
              </button>
            )}
          <button
            className="icon-button"
            aria-label={t("关闭提示")}
            onClick={() => {
              setToast(null);
              engine.dismissError();
            }}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {compatibilityHelp.dialog}
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
