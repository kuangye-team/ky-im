import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Download, MoreHorizontal, Search, Trash2 } from "lucide-react";
import {
  clearRuntimeLogs,
  getRuntimeLogs,
  subscribeRuntimeLogs,
  type LogCategory,
  type LogLevel,
} from "../runtime-logs";
import type { Profile } from "../core/types";
import { Modal } from "./Modal";
import { download } from "./fileDownloads";
import { fileDiagnosticsEnabled, setFileDiagnostics } from "../core/transfers/diagnostics";
import "./RuntimeLogs.css";

const levels: Record<LogLevel, string> = {
  error: "错误",
  warn: "提醒",
  info: "一般",
  debug: "详细",
};
const categories: Record<LogCategory, string> = {
  app: "应用运行",
  discovery: "设备查找",
  connection: "设备连接",
  heartbeat: "存活检查",
  message: "内容收发",
};
function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  const selected = options.find(([key]) => key === value)?.[1];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="log-filter" aria-label={label} aria-description={selected} data-active={value !== "all"}>
        <span>{value === "all" ? label : selected}</span>
        <ChevronDown size={14} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="log-filter-menu"
          sideOffset={6}
          collisionPadding={12}
        >
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {options.map(([key, text]) => (
              <DropdownMenu.RadioItem
                className="log-filter-option"
                value={key}
                key={key}
              >
                <span>{text}</span>
                <DropdownMenu.ItemIndicator>
                  <Check size={15} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
const logDescription = "仅保存在本机，保留最近 7 天、最多 2000 条。不记录聊天正文和文件内容。";

export function RuntimeLogs({ peer, onClose }: { peer?: Profile; onClose: () => void }) {
  const { t } = useTranslation();
  return <Modal open wide title={t("运行日志")} onClose={onClose} className="runtime-logs" description={t(logDescription)}>
    <LogContents peer={peer} />
  </Modal>;
}

export function RuntimeLogsPage({ peer }: { peer?: Profile }) {
  return <section className="full-page logs-page">
    <LogContents peer={peer} standalone />
  </section>;
}

function LogContents({ peer, standalone = false }: { peer?: Profile; standalone?: boolean }) {
  const { t, i18n } = useTranslation();
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(i18n.language, {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }), [i18n.language]);
  const entries = useSyncExternalStore(subscribeRuntimeLogs, getRuntimeLogs);
  const [level, setLevel] = useState("all");
  const [category, setCategory] = useState("all");
  const [period, setPeriod] = useState("all");
  const [scope, setScope] = useState(peer ? "peer" : "all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [fileDiagnostics, setDiagnostics] = useState(fileDiagnosticsEnabled);
  const [confirmClear, setConfirmClear] = useState(false);
  const filtered = useMemo(() => {
    const since = period === "all" ? 0 : Date.now() - Number(period);
    const search = query.trim().toLocaleLowerCase();
    return entries
      .filter(
        (entry) =>
          (level === "all" || entry.level === level) &&
          (category === "all" || entry.category === category) &&
          entry.time >= since &&
          (scope === "all" || entry.peerId === peer?.id) &&
          (!search ||
            `${t(entry.message)} ${entry.message} ${entry.detail || ""} ${entry.peerId || ""} ${entry.source || ""} ${entry.raw || ""}`
              .toLocaleLowerCase()
              .includes(search)),
      )
      .reverse();
  }, [entries, level, category, period, scope, peer?.id, query, t]);
  const pages = Math.max(1, Math.ceil(filtered.length / 100));
  const current = Math.min(page, pages - 1);
  const filter = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(0);
  };
  const changeDiagnostics = (enabled: boolean) => {
    try {
      setFileDiagnostics(enabled);
      setDiagnostics(enabled);
      setError("");
    } catch { setError(t("无法保存设置")); }
  };
  const all: [string, string] = ["all", t("全部")];
  return (
    <>
      {peer && (
        <div className="log-scope" aria-label={t("查看范围")}>
          <button
            aria-pressed={scope === "peer"}
            onClick={() => filter(setScope)("peer")}
          >
            {t("与 {{name}} 的连接", { name: peer.name })}
          </button>
          <button
            aria-pressed={scope === "all"}
            onClick={() => filter(setScope)("all")}
          >
            {t("全部运行日志")}
          </button>
        </div>
      )}
      <div className="log-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label={t("搜索运行日志")}
            placeholder={t("搜索运行日志")}
            value={query}
            onChange={(event) => filter(setQuery)(event.target.value)}
          />
        </label>
        <button
          className={standalone ? "icon-button" : "secondary-button"}
          aria-label={t("导出筛选结果")}
          title={t("导出筛选结果")}
          onClick={async () => {
            setError("");
            try {
              await download(
                new Blob([JSON.stringify(filtered, null, 2)], {
                  type: "application/json",
                }),
                `hummingbird-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
              );
            } catch {
              setError(t("日志未能导出，请重试"));
            }
          }}
        >
          <Download size={16} />
          {!standalone && t("导出筛选结果")}
        </button>
        {standalone ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="icon-button" aria-label={t("日志选项")} title={t("日志选项")}>
              <MoreHorizontal size={18} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="log-filter-menu log-options-menu" align="end" sideOffset={6} collisionPadding={12}>
                <DropdownMenu.CheckboxItem className="log-filter-option" checked={fileDiagnostics} onCheckedChange={changeDiagnostics}>
                  {t("记录后续文件传输的性能")}
                  <DropdownMenu.ItemIndicator><Check size={15} /></DropdownMenu.ItemIndicator>
                </DropdownMenu.CheckboxItem>
                <DropdownMenu.Item className="log-filter-option" onSelect={() => setConfirmClear(true)}>
                  {t("清空运行日志")}<Trash2 size={15} />
                </DropdownMenu.Item>
                <DropdownMenu.Label className="log-retention">{t(logDescription)}</DropdownMenu.Label>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : <button
          className="icon-button"
          aria-label={t("清空运行日志")}
          title={t("清空运行日志")}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 size={17} />
        </button>}
      </div>
      <div className="log-filters">
        <Filter
          label={t("级别")}
          value={level}
          onChange={filter(setLevel)}
          options={[
            all,
            ...Object.entries(levels).map(([key, text]): [string, string] => [
              key,
              t(text),
            ]),
          ]}
        />
        <Filter
          label={t("类别")}
          value={category}
          onChange={filter(setCategory)}
          options={[
            all,
            ...Object.entries(categories).map(
              ([key, text]): [string, string] => [key, t(text)],
            ),
          ]}
        />
        <Filter
          label={t("时间")}
          value={period}
          onChange={filter(setPeriod)}
          options={[
            all,
            ["600000", t("最近 10 分钟")],
            ["3600000", t("最近 1 小时")],
            ["86400000", t("最近 24 小时")],
          ]}
        />
      </div>
      {!standalone && <label>
        <input type="checkbox" checked={fileDiagnostics} onChange={event => changeDiagnostics(event.target.checked)} />
        {" "}{t("记录后续文件传输的性能")}
      </label>}
      {confirmClear && (
        <div className="log-clear" role="alert">
          <span>{t("清空本机保留的全部运行日志？")}</span>
          <button
            className="secondary-button"
            onClick={() => {
              clearRuntimeLogs();
              setConfirmClear(false);
            }}
          >
            {t("确认清空")}
          </button>
          <button
            className="secondary-button"
            onClick={() => setConfirmClear(false)}
          >
            {t("取消")}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <div
        className="log-entries"
        role="region"
        aria-label={t("日志列表")}
        tabIndex={0}
      >
        {filtered.length === 0 ? (
          <p className="log-empty">{t("暂无符合条件的日志")}</p>
        ) : (
          filtered.slice(current * 100, (current + 1) * 100).map((entry) => (
            <article className={`log-entry log-${entry.level}`} key={entry.id}>
              <div className="log-entry-meta">
                <time dateTime={new Date(entry.time).toISOString()}>
                  {timeFormat.format(entry.time)}
                </time>
                <span className="log-level">{t(levels[entry.level])}</span>
                <span>{t(categories[entry.category])}</span>
              </div>
              <p>{t(entry.message)}</p>
              <details className="log-source">
                <summary>{t("源日志")}</summary>
                <pre>{entry.raw || JSON.stringify(entry, null, 2)}</pre>
                {entry.peerId && <small>{peer && entry.peerId === peer.id ? peer.name : t("设备")} · {entry.peerId}</small>}
              </details>
            </article>
          ))
        )}
      </div>
      <footer className="log-footer">
        <span>{t("{{count}} 条日志", { count: filtered.length })}</span>
        {(!standalone || pages > 1) && <div>
          <button
            className="secondary-button"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            {t("上一页")}
          </button>
          <span>
            {current + 1} / {pages}
          </span>
          <button
            className="secondary-button"
            disabled={current + 1 >= pages}
            onClick={() => setPage(current + 1)}
          >
            {t("下一页")}
          </button>
        </div>}
      </footer>
    </>
  );
}
