import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Download, Search, Trash2 } from "lucide-react";
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
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="log-filter" aria-label={label}>
        <span>
          {label} · {options.find(([key]) => key === value)?.[1]}
        </span>
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
export function RuntimeLogs({
  peer,
  onClose,
}: {
  peer?: Profile;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const entries = useSyncExternalStore(subscribeRuntimeLogs, getRuntimeLogs);
  const [level, setLevel] = useState("all");
  const [category, setCategory] = useState("all");
  const [period, setPeriod] = useState("all");
  const [scope, setScope] = useState(peer ? "peer" : "all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
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
  const all: [string, string] = ["all", t("全部")];
  return (
    <Modal
      open
      wide
      title={t("运行日志")}
      onClose={onClose}
      className="runtime-logs"
      description={t(
        "仅保存在本机，保留最近 7 天、最多 2000 条。不记录聊天正文和文件内容。",
      )}
    >
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
          className="secondary-button"
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
          {t("导出筛选结果")}
        </button>
        <button
          className="icon-button"
          aria-label={t("清空运行日志")}
          title={t("清空运行日志")}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 size={17} />
        </button>
      </div>
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
                  {new Date(entry.time).toLocaleString()}
                </time>
                <span className="log-level">{t(levels[entry.level])}</span>
                <span>{t(categories[entry.category])}</span>
              </div>
              <p>{t(entry.message)}</p>
              <details className="log-source">
                <summary>{t("源日志")}</summary>
                <pre>{entry.raw || JSON.stringify(entry, null, 2)}</pre>
              </details>
              {entry.peerId && (
                <small>
                  {peer && entry.peerId === peer.id ? peer.name : t("设备")} ·{" "}
                  {entry.peerId}
                </small>
              )}
            </article>
          ))
        )}
      </div>
      <footer className="log-footer">
        <span>{t("{{count}} 条日志", { count: filtered.length })}</span>
        <div>
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
        </div>
      </footer>
    </Modal>
  );
}
