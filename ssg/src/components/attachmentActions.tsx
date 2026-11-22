import { createContext, useContext, useId, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, ChevronUp, ExternalLink, Eye, Play } from "lucide-react";
import mime from "mime";
import type { Message, StorageAdapter } from "../core/types";
import type { PhoneAction } from "./PhoneActions";
import MediaPlayer from "./MediaPlayer";

export type ImagePreview = { kind: "image"; id: string; name: string; mime: string; blob?: Blob };
export type TextPreview = { kind: "text"; id: string; name: string; mime: string };
export type FilePreview = ImagePreview | TextPreview | { kind: "media"; playerId: string };
export type AttachmentToOpen = Pick<Message, "id" | "fileName">;
export const AttachmentActionsContext = createContext<{
  preview: FilePreview | null; setPreview: (file: FilePreview | null) => void;
  requestOpen: (file: AttachmentToOpen) => void;
}>({ preview: null, setPreview: () => {}, requestOpen: () => {} });

type MenuAction = PhoneAction & { opensDialog?: boolean };
type FileActionProps = { message: Message; storage: StorageAdapter; onNotice: (message: string) => void };
type FileActions = { preview?: MenuAction; openActions: MenuAction[]; player?: ReactNode };

function isTextType(type: string | null | undefined) {
  return !!type && (type.startsWith("text/") || /^application\/(?:[\w.-]+\+)?(?:json|xml)$/.test(type) ||
    ["application/javascript", "application/ecmascript", "application/x-javascript", "application/yaml",
      "application/toml", "application/sql", "application/x-sh"].includes(type));
}

// Source and configuration files often arrive without a specific MIME type.
const textFileName = /\.(?:cjs|mjs|jsx|tsx?|mts|cts|vue|svelte|py|rb|php|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|bash|zsh|ps1|bat|cmd|log|ini|conf|cfg|toml|ya?ml|jsonc|jsonl|lock|env|gitignore|editorconfig)$/i;
const plainFileName = /^(?:readme|license|licence|changelog|makefile|dockerfile|\.env(?:\.[\w-]+)?)$/i;

export function useFileActions({ message, storage, onNotice }: FileActionProps, image?: Blob): FileActions {
  const { preview, setPreview, requestOpen } = useContext(AttachmentActionsContext);
  const { t } = useTranslation();
  const playerId = useId();
  if (message.kind === "text" || message.folder || message.attachmentStorage === "external" ||
      (!image && message.status !== "delivered" && message.status !== "sent")) return { openActions: [] };

  const chooseApp = () => {
    void storage.openAttachment?.(message.id, true).catch(error =>
      onNotice(error instanceof Error ? error.message : String(error)));
  };
  const openActions = storage.openAttachment ? [
    { label: t("打开"), Icon: ExternalLink, opensDialog: true, run: () => requestOpen(message) },
    { label: t("打开方式"), Icon: AppWindow, run: chooseApp },
  ] : [];
  const name = message.fileName || "";
  if (message.kind === "image") {
    return { openActions, preview: {
      label: t("预览"), Icon: Eye, opensDialog: true,
      run: () => setPreview({ kind: "image", id: message.id, name, mime: message.mimeType || "", blob: image }),
    } };
  }
  const declared = message.mimeType?.split(";")[0].trim().toLowerCase();
  const inferred = mime.getType(name);
  const isMedia = (type?: string | null) => type?.startsWith("audio/") || type?.startsWith("video/");
  if (!isMedia(declared) && (isTextType(declared) || isTextType(inferred) || textFileName.test(name) || plainFileName.test(name))) {
    return { openActions, preview: {
      label: t("查看"), Icon: Eye, opensDialog: true,
      run: () => setPreview({ kind: "text", id: message.id, name, mime: message.mimeType || "" }),
    } };
  }
  const type = [declared, inferred].find(isMedia);
  if (!type) return { openActions };
  if (preview?.kind === "media" && preview.playerId === playerId) {
    return {
      openActions,
      preview: { label: t("收起播放器"), Icon: ChevronUp, run: () => setPreview(null) },
      player: <MediaPlayer kind={type.startsWith("audio/") ? "audio" : "video"}
        id={message.id} name={name} mime={type} storage={storage} />,
    };
  }
  return { openActions, preview: {
    label: t("播放"), Icon: Play,
    // Mount and start the chosen player within the original click, including on WebKit.
    run: () => flushSync(() => setPreview({ kind: "media", playerId })),
  } };
}

export function FileMenuActions({ children, ...props }: FileActionProps & {
  children: (actions: MenuAction[]) => ReactNode;
}) {
  const { preview, openActions, player } = useFileActions(props);
  return <>{children(preview ? [preview, ...openActions] : openActions)}{player}</>;
}
