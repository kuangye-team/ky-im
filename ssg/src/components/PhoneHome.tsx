import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ArrowRight, ChevronRight, CircleHelp, FileText, HardDrive, Hash, Info, MessageCircle, Plus, Radio, ScrollText, Search, Settings, ShieldCheck, UserRound, Users } from "lucide-react";
import type { ChatEngine } from "../core";
import { isPeerOnline, type ChatSnapshot, type Conversation, type Profile } from "../core/types";
import { deviceLabel } from "../core/profile";
import { storageUsage } from "../core/storage/usage";
import { getChatDrafts, subscribeChatDrafts } from "../drafts";
import { Avatar, peerName } from "./Avatar";
import { OwnNumber } from "./OwnNumber";
import { ThemeSelector } from "./ThemeSelector";
import { LanguageSelector } from "./LanguageSelector";
import { ClientAccess } from "./ClientAccess";
import { ResetDataButton } from "./ResetDataButton";
import { MyStatus } from "./MyStatus";
import { messageTime } from "./messageTime";
import { readableSize } from "./fileDownloads";

type PageProps = { engine: ChatEngine; snap: ChatSnapshot };
const destinations = [
  { path: "/", label: "消息", Icon: MessageCircle },
  { path: "/nearby", label: "设备", Icon: Users },
  { path: "/me", label: "我的", Icon: UserRound },
];

export function PhoneTabs({ path, unread }: { path: string; unread: number }) {
  const { t } = useTranslation();
  return <nav className="phone-tabs" aria-label={t("主导航")}>
    {destinations.map(({ path: to, label, Icon }) =>
      <Link key={to} to={to} replace aria-current={path === to ? "page" : undefined}>
        <span><Icon size={22} />{to === "/" && unread > 0 && <b aria-label={t("{{count}} 条未读", { count: unread })}>{unread > 99 ? "99+" : unread}</b>}</span>
        {t(label)}
      </Link>)}
  </nav>;
}

function ConnectionNotice({ engine, snap }: PageProps) {
  const { t } = useTranslation();
  if (snap.status === "connected") return null;
  const offline = snap.availability === "offline";
  return <div className="phone-status" role="status"><Radio size={17} />
    <span>{t(offline ? "你当前离线" : snap.status === "connecting" ? "正在连接…" : "连接已断开")}</span>
    {snap.status !== "connecting" && <button onClick={() => offline ? engine.setAvailability("online") : engine.reconnect()}>{t(offline ? "恢复在线" : "重新连接")}</button>}
  </div>;
}

function RecentRow({ conversation, engine, snap, draft, open }: PageProps & {
  conversation: Conversation; draft?: string; open: (p: Profile) => void;
}) {
  const { t } = useTranslation();
  const peer = snap.peers.find(p => p.id === conversation.peer.id) ?? conversation.peer;
  const online = isPeerOnline(snap, peer.id);
  const presenceId = useId();
  const [preview, setPreview] = useState("");
  useEffect(() => {
    let current = true;
    void engine.getConversationPreview(peer.id).then(message => {
      if (!current) return;
      setPreview(message?.text || message?.fileName || (message ? t(message.kind === "image" ? "图片" : "文件") : ""));
    }).catch(() => { if (current) setPreview(""); });
    return () => { current = false; };
  }, [engine, peer.id, conversation.updatedAt, snap.messages, t]);
  return <button className="phone-peer" onClick={() => open(peer)} aria-label={t("与 {{value}} 聊天", { value: peerName(peer, snap) })} aria-describedby={presenceId}>
    <Avatar peer={peer} online={online} /><span className="phone-peer-copy">
      <span className="phone-peer-name"><strong>{peerName(peer, snap)}</strong><small id={presenceId}>{t(online ? "在线" : "离线", { ns: "components" })}</small></span>
      <small>{draft ? <><em>{t("草稿")}</em> {draft}</> : preview || deviceLabel(peer)}</small></span>
    <span className="phone-peer-end"><time>{messageTime(conversation.updatedAt)}</time>{conversation.unread > 0 && <b>{conversation.unread}</b>}</span>
  </button>;
}

function InviteHeader({ title, onInvite, onNotice }: { title: string; onInvite: () => void; onNotice: (s: string) => void }) {
  const { t } = useTranslation();
  return <header className="phone-head">
    <h1>{title}</h1>
    <div className="phone-head-actions">
      <ClientAccess iconOnly onNotice={onNotice} />
      <button className="phone-accent-icon" aria-label={t("邀请朋友")} title={t("邀请朋友")} aria-haspopup="dialog" onClick={onInvite}>
        <Plus size={24} aria-hidden="true" />
      </button>
    </div>
  </header>;
}

export function PhoneMessages({ engine, snap, open, filter, setFilter, onInvite, onNotice }: PageProps & {
  open: (p: Profile) => void; filter: string; setFilter: (s: string) => void; onInvite: () => void; onNotice: (s: string) => void;
}) {
  const { t } = useTranslation();
  const drafts = useSyncExternalStore(subscribeChatDrafts, getChatDrafts);
  const query = filter.trim().toLowerCase();
  const conversations = snap.conversations.filter(({ peer, remark }) =>
    [peer.name, remark, peer.numericId, deviceLabel(peer)].some(s => s?.toLowerCase().includes(query)));
  return <section className="phone-page">
    <InviteHeader title={t("消息")} onInvite={onInvite} onNotice={onNotice} />
    <ConnectionNotice engine={engine} snap={snap} />
    {snap.conversations.length > 0 && <label className="phone-search"><Search size={18} /><input type="search" value={filter} placeholder={t("搜索联系人")} aria-label={t("搜索联系人")} onChange={e => setFilter(e.target.value)} /></label>}
    {conversations.map(c => <RecentRow key={c.peer.id} conversation={c} engine={engine} snap={snap} draft={drafts[c.peer.id]} open={open} />)}
    {!conversations.length && <div className="phone-empty">
      <span className="phone-empty-mark">{query ? <Search /> : <i className="hummingbird-logo" />}</span>
      <h2>{t(query ? "没有找到联系人" : "还没有聊天")}</h2>
      <p>{t(query ? "试试备注、名字或设备名称" : "找到另一台设备，就能聊天和传文件。")}</p>
      {!query && <Link className="phone-primary" to="/nearby">{t("找设备")}<ArrowRight size={17} /></Link>}
    </div>}
  </section>;
}

export function PhoneDevices({ engine, snap, open, invite, onNotice }: PageProps & {
  open: (p: Profile) => void; invite: (number: boolean) => void; onNotice: (s: string) => void;
}) {
  const { t } = useTranslation();
  const peers = snap.peers.filter(peer => isPeerOnline(snap, peer.id));
  return <section className="phone-page">
    <InviteHeader title={t("设备")} onInvite={() => invite(false)} onNotice={onNotice} />
    <ConnectionNotice engine={engine} snap={snap} />
    {engine.supportsNumericIds && <button className="phone-number-action" onClick={() => invite(true)}>
      <span><Hash size={22} /></span><strong>{t("输入蜂鸟号")}</strong><ChevronRight size={18} /></button>}
    <h2 className="phone-group-title">{t("在线设备")} <small>{peers.length}</small></h2>
    {peers.map(peer => <button className="phone-peer" key={peer.id} onClick={() => open(peer)} aria-label={t("与 {{value}} 聊天", { value: peerName(peer, snap) })}>
      <Avatar peer={peer} online /><span className="phone-peer-copy"><strong>{peerName(peer, snap)}</strong><small>{deviceLabel(peer)} · {t(snap.peerStates[peer.id] === "connected" ? "在线" : "已发现")}</small></span><ChevronRight size={17} />
    </button>)}
    {!peers.length && <div className="phone-empty"><span className="phone-empty-mark"><Radio /></span><h2>{t("还没有发现设备")}</h2><p>{t("在另一台设备上打开蜂鸟。")}</p></div>}
  </section>;
}

export function PhoneMe({ engine, snap, about, notice }: PageProps & {
  about: () => void; notice: (s: string) => void;
}) {
  const { t } = useTranslation();
  const usage = storageUsage(engine.storage);
  const { result } = useSyncExternalStore(usage.subscribe, usage.snapshot);
  useEffect(() => { void usage.refresh(); }, [usage]);
  return <section className="phone-page phone-me" aria-label={t("我的")}>
    <div className="phone-identity">
      <Link className="phone-profile" to="/profile" state={{ parent: "/me" }} aria-label={t("个人资料")}><Avatar peer={snap.profile} size="avatar-xl" />
        <span><strong>{snap.profile.name}</strong><small>{deviceLabel(snap.profile)}</small></span><ChevronRight size={18} /></Link>
      {engine.supportsNumericIds && <OwnNumber compact numericId={snap.profile.numericId} onNotice={notice} />}
      <MyStatus engine={engine} snap={snap} compact />
    </div>
    <h2 className="phone-group-title">{t("偏好")}</h2>
    <div className="phone-group"><ThemeSelector row /><LanguageSelector row /></div>
    <h2 className="phone-group-title">{t("数据与连接")}</h2>
    <div className="phone-group">
      <Link to="/history" state={{ parent: "/me" }}><FileText />{t("聊天记录")}<ChevronRight /></Link>
      <Link to="/storage" state={{ parent: "/me" }}><HardDrive />{t("存储空间")}<small>{result?.usage != null ? readableSize(result.usage) : ""}</small><ChevronRight /></Link>
      <Link to="/settings" state={{ parent: "/me" }}><Settings />{t("连接设置")}<ChevronRight /></Link>
      <Link to="/logs" state={{ parent: "/me" }}><ScrollText />{t("运行日志")}<ChevronRight /></Link>
      <ResetDataButton engine={engine} row />
    </div>
    <h2 className="phone-group-title">{t("关于与帮助")}</h2>
    <div className="phone-group">
      <button onClick={about}><Info />{t("关于蜂鸟")}<ChevronRight /></button>
      <Link to="/privacy" state={{ parent: "/me" }}><ShieldCheck />{t("隐私协议")}<ChevronRight /></Link>
      <Link to="/licenses" state={{ parent: "/me" }}><CircleHelp />{t("开源许可")}<ChevronRight /></Link>
    </div>
  </section>;
}
