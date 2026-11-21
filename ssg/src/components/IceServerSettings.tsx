import { useEffect, useId, useRef, useState } from "react";
import { Activity, Check, ChevronDown, Eye, EyeOff, Globe, LoaderCircle, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CONNECTION_CONFIG } from "../config";
import { isTurnServer, MAX_ICE_SERVERS, validateIceServers, type IceServer } from "../ice-servers";
import { probeIceServers, type IceProbeResult } from "../core/network/iceProbe";
import { translateError } from "../localizeError";
import { Modal } from "./Modal";
import { ServerAddress } from "./ServerAddress";

type Editor = { original: string | null; server: IceServer };

export type IceServerSettingsProps = {
  phone: boolean;
  servers: IceServer[];
  busy: boolean;
  error: string;
  onApply: (servers: IceServer[]) => Promise<boolean>;
  onClearError: () => void;
  onNotice: (message: string) => void;
};

export function IceServerSettings({ kind = "stun", phone, servers, busy, error, onApply, onClearError, onNotice }: IceServerSettingsProps & { kind?: "stun" | "turn" }) {
  const { t } = useTranslation(["translation", "components"], { nsMode: "fallback" });
  const headingId = useId();
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const passwordId = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorError, setEditorError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string[]>([]);
  const [first, setFirst] = useState<string>();
  const [results, setResults] = useState<Record<string, IceProbeResult>>({});
  const applying = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const saved = JSON.stringify(servers);
  const relay = kind === "turn";
  const heading = t(relay ? "中转服务器（TURN）" : "辅助服务器（STUN）");
  const description = relay
    ? "添加已有的中转服务器，帮助无法直连的设备传送内容。地址、账号和密码只保存在这台设备上。"
    : "帮助不同网络的设备建立连接。同时尝试多个地址，自动使用可用线路。";
  const entries = servers.filter((server) => isTurnServer(server.urls) === relay);
  const locked = busy || saving || testing.length > 0;
  const adding = editor?.original === null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    controller.current?.abort();
    setTesting([]);
    setResults({});
    setFirst(undefined);
  }, [saved]);
  useEffect(() => {
    const invalidate = () => {
      controller.current?.abort();
      setTesting([]);
      setResults({});
      setFirst(undefined);
    };
    window.addEventListener("online", invalidate);
    window.addEventListener("offline", invalidate);
    return () => {
      window.removeEventListener("online", invalidate);
      window.removeEventListener("offline", invalidate);
    };
  }, []);

  const openEditor = (server: IceServer | null, button: HTMLButtonElement) => {
    trigger.current = button;
    onClearError();
    setEditorError("");
    setShowPassword(false);
    setEditor({ original: server?.urls ?? null, server: server
      ? { ...server, enabled: server.enabled !== false }
      : { name: "", urls: "", username: "", credential: "", enabled: true } });
  };
  const update = (patch: Partial<IceServer>) => {
    setEditor((current) => current && { ...current, server: { ...current.server, ...patch } });
    setEditorError("");
    onClearError();
  };
  const apply = async (next: IceServer[]) => {
    if (applying.current || locked) return false;
    applying.current = true;
    setSaving(true);
    try { return await onApply(validateIceServers(next)); }
    catch (error) {
      if (mounted.current) setEditorError(error instanceof Error ? error.message : "设置未保存，请重试");
      return false;
    } finally {
      applying.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const save = async () => {
    if (!editor || locked || applying.current) return;
    setEditorError("");
    onClearError();
    try {
      const address = editor.server.urls.trim();
      if (!(relay ? /^turns?:/i : /^stuns?:/i).test(address))
        throw Error(relay ? "中转服务器地址需以 turn: 或 turns: 开头" : "辅助服务器地址需以 stun: 或 stuns: 开头");
      const [server] = validateIceServers([editor.server]);
      const next = adding ? [...servers, server]
        : servers.map((entry) => entry.urls === editor.original ? server : entry);
      if (await apply(next) && mounted.current) setEditor(null);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "设置未保存，请重试");
    }
  };
  const runTest = async (selected: IceServer[]) => {
    if (locked || applying.current || !selected.length) return;
    onClearError();
    setEditorError("");
    setFirst(undefined);
    setResults((previous) => Object.fromEntries(Object.entries(previous).filter(([url]) => !selected.some((server) => server.urls === url))));
    const current = new AbortController();
    controller.current = current;
    setTesting(selected.map((server) => server.urls));
    const probe = probeIceServers(selected, {
      signal: current.signal,
      onResult: (result) => {
        if (mounted.current && !current.signal.aborted && controller.current === current)
          setResults((previous) => ({ ...previous, [result.url]: result }));
      },
    });
    void probe.first.then((winner) => {
      if (mounted.current && !current.signal.aborted && controller.current === current && selected.length > 1)
        setFirst(winner?.url);
    });
    await probe.completed;
    if (!mounted.current || current.signal.aborted || controller.current !== current) return;
    setTesting([]);
    controller.current = null;
  };
  const status = (server: IceServer) => {
    const result = results[server.urls];
    if (testing.includes(server.urls) && !result) return t("正在测试…");
    if (result?.state === "available") return t(first === server.urls ? "率先响应 · {{ms}} 毫秒" : "可用 · {{ms}} 毫秒", { ms: result.elapsedMs });
    if (result?.state === "unavailable") return t("暂不可用，请检查地址和账号密码");
    return server.enabled === false ? t("已停用") : phone ? "" : t("尚未测试");
  };
  const message = editorError || error;

  return (
    <section className="settings-card settings-server-card settings-ice-card" aria-labelledby={headingId}>
      <div className="settings-server-heading">
        <h2>
          {phone ? (
            <button className="settings-disclosure" type="button" aria-expanded={expanded} aria-controls={panelId}
              onClick={() => setExpanded(!expanded)}>
              <span id={headingId}>{heading}</span>
              <small>{entries.length ? t("{{count}} 个已启用", { count: entries.filter(server => server.enabled !== false).length }) : t("未添加")}</small>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          ) : <><Globe size={19} aria-hidden="true" /><span id={headingId}>{heading}</span></>}
        </h2>
        <div className="settings-ice-tools" hidden={phone && !expanded}>
          {testing.length > 0 && <button type="button" className="secondary-button" onClick={() => {
            controller.current?.abort();
            setTesting([]);
          }}>{t("取消测试")}</button>}
          {!relay && <>
            <button type="button" className="secondary-button" disabled={locked || !entries.length}
              onClick={() => void runTest(entries)}><Activity size={16} aria-hidden="true" />{t("测试全部")}</button>
            <button type="button" className="secondary-button" disabled={locked} onClick={() => {
              onClearError(); setEditorError("");
              void apply([...CONNECTION_CONFIG.rtc.iceServers.filter((server) => !isTurnServer(server.urls)), ...servers.filter((server) => isTurnServer(server.urls))]);
            }}><RotateCcw size={16} aria-hidden="true" />{t("恢复默认")}</button>
          </>}
          <button type="button" className="secondary-button" aria-label={t("添加服务器")} disabled={locked || servers.length >= MAX_ICE_SERVERS}
            onClick={(event) => openEditor(null, event.currentTarget)}>
            <Plus size={16} aria-hidden="true" />{t(phone ? "添加" : "添加服务器")}
          </button>
        </div>
      </div>
      <div id={panelId} hidden={phone && !expanded} className="settings-ice-panel">
        {!phone && <p>{t(description)}</p>}
        {entries.length ? <>
          <div className="settings-server-columns" aria-hidden="true">
            <span>{t("服务器名称")}</span><span>{t("服务器地址")}</span><span>{t("操作")}</span>
          </div>
          <ul className="settings-server-list" aria-label={t(relay ? "中转服务器列表" : "辅助服务器列表")}>
            {entries.map((server, index) => <li className="settings-server" key={server.urls}>
              <div className="settings-server-name">
                <strong>{server.name || t("未命名服务器")}</strong>
                <small aria-live="polite" className={results[server.urls]?.state === "unavailable" ? "settings-test-error" : ""}>{status(server)}</small>
              </div>
              <ServerAddress address={server.urls} onNotice={onNotice} />
              <div className="settings-server-actions">
                <label>
                  <input type="checkbox" checked={server.enabled !== false} disabled={locked}
                    aria-label={t(relay ? "启用中转服务器 {{index}}" : "启用辅助服务器 {{index}}", { index: index + 1 })}
                    onChange={(event) => {
                      onClearError(); setEditorError("");
                      void apply(servers.map((entry) => entry.urls === server.urls ? { ...entry, enabled: event.target.checked } : entry));
                    }} />
                  {t("启用")}
                </label>
                <button type="button" className="icon-button" disabled={locked}
                  aria-label={t(relay ? "测试中转服务器 {{index}}" : "测试辅助服务器 {{index}}", { index: index + 1 })} title={t("测试")}
                  onClick={() => void runTest([server])}>
                  {testing.includes(server.urls) && !results[server.urls] ? <LoaderCircle size={17} className="spinning" aria-hidden="true" /> : <Activity size={17} aria-hidden="true" />}
                </button>
                <button type="button" className="icon-button" disabled={locked}
                  aria-label={t(relay ? "编辑中转服务器 {{index}}" : "编辑辅助服务器 {{index}}", { index: index + 1 })} title={t("编辑服务器")}
                  onClick={(event) => openEditor(server, event.currentTarget)}><Pencil size={17} aria-hidden="true" /></button>
                <button type="button" className="icon-button" disabled={locked}
                  aria-label={t(relay ? "删除中转服务器 {{index}}" : "删除辅助服务器 {{index}}", { index: index + 1 })} title={t("删除服务器")}
                  onClick={() => {
                    onClearError(); setEditorError("");
                    void apply(servers.filter((entry) => entry.urls !== server.urls));
                  }}><Trash2 size={17} aria-hidden="true" /></button>
              </div>
            </li>)}
          </ul>
        </> : !phone && <p className="settings-ice-empty">{t(relay ? "还没有中转服务器" : "还没有辅助服务器")}</p>}
        {!editor && message && <p className="settings-error" role="alert">{translateError(message)}</p>}
        {(!phone || servers.length >= MAX_ICE_SERVERS) && <p className="settings-hint">{t("直连辅助和中转服务器合计最多 16 个。停用后保留配置，不参与连接。")}</p>}
      </div>
      {editor && <Modal open title={t(adding ? "添加服务器" : relay ? "编辑中转服务器" : "编辑辅助服务器")}
        onClose={() => !applying.current && setEditor(null)}
        onCloseAutoFocus={() => trigger.current?.focus()} className="settings-server-modal">
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset className="settings-server-fields" disabled={busy || saving}>
            <label>{t("服务器名称")}
              <input className="form-input" autoFocus maxLength={80} value={editor.server.name ?? ""}
                placeholder={t("未命名服务器")} onChange={(event) => update({ name: event.target.value })} />
            </label>
            <label>{t("服务器地址")}
              <input className="form-input" maxLength={2048} value={editor.server.urls}
                autoComplete="off" autoCapitalize="none" spellCheck={false}
                placeholder={relay ? "turns:turn.example.com:5349?transport=tcp" : "stun:stun.example.com:3478"}
                onChange={(event) => update({ urls: event.target.value })} />
            </label>
            <label>{t("账号（如需要）")}
              <input className="form-input" maxLength={4096} value={editor.server.username ?? ""}
                autoComplete="off" autoCapitalize="none" spellCheck={false}
                onChange={(event) => update({ username: event.target.value })} />
            </label>
            <div className="settings-server-key-field">
              <label htmlFor={passwordId}>{t("密码（如需要）")}</label>
              <div className="settings-server-key-input">
                <input id={passwordId} className="form-input" type={showPassword ? "text" : "password"}
                  maxLength={4096} value={editor.server.credential ?? ""} autoComplete="off" autoCapitalize="none" spellCheck={false}
                  onChange={(event) => update({ credential: event.target.value })} />
                <button type="button" className="icon-button" aria-label={t(showPassword ? "隐藏密码" : "显示密码")}
                  onClick={() => setShowPassword((visible) => !visible)}>
                  {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                </button>
              </div>
            </div>
            {!phone && <p className="settings-hint">{t("填写服务提供方给你的完整地址、账号和密码。")}</p>}
          </fieldset>
          {message && <p className="settings-error" role="alert">{translateError(message)}</p>}
          <div className="modal-actions">
            <label className="settings-server-enabled"><input type="checkbox" checked={editor.server.enabled !== false}
              disabled={busy || saving} onChange={(event) => update({ enabled: event.target.checked })} />{t("启用")}</label>
            <button type="button" className="secondary-button" disabled={saving} onClick={() => setEditor(null)}>{t("取消")}</button>
            <button type="submit" className="primary-button" disabled={busy || saving} aria-busy={saving}>
              {saving ? <LoaderCircle size={16} className="spinning" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
              {t(adding ? "添加" : "保存")}
            </button>
          </div>
        </form>
      </Modal>}
    </section>
  );
}
