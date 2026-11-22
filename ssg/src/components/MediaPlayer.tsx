import { Audio, AudioPlayer, AudioSkin } from "@videojs/react/audio";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import { createTranslator, getI18nTranslations, I18nContext } from "@videojs/react/i18n";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StorageAdapter } from "../core/types";
import "@videojs/react/audio/skin.css";
import "@videojs/react/video/skin.css";
import "@videojs/react/i18n/locales/zh-CN/register";
import "./MediaPlayer.css";

function closePictureInPicture(video: HTMLVideoElement & {
  webkitPresentationMode?: string; webkitSetPresentationMode?: (mode: "inline") => void;
}) {
  if (document.pictureInPictureElement === video) {
    void document.exitPictureInPicture().catch(() => {});
  } else if (video.webkitPresentationMode === "picture-in-picture") {
    try { video.webkitSetPresentationMode?.("inline"); }
    catch { /* WebKit can finish dismissing the window during removal. */ }
  }
}

export default function MediaPlayer({ kind, id, name, mime, storage }: {
  kind: "audio" | "video"; id: string; name: string; mime: string;
  storage: StorageAdapter;
}) {
  const { t, i18n } = useTranslation();
  const [error, setError] = useState("");
  const playerRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const attachMedia = useCallback((media: HTMLMediaElement | null) => { mediaRef.current = media; }, []);
  const locale = i18n.language;
  const language = useMemo(() => ({
    locale, localeFromProp: true, translator: createTranslator(getI18nTranslations(locale), locale),
  }), [locale]);

  useLayoutEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    playerRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    let active = true;
    let objectUrl: string | undefined;
    async function load(element: HTMLMediaElement) {
      let src = storage.mediaPreviewUrl?.(id);
      if (!src) {
        // Claim the tap for this element before the asynchronous file read.
        // Assigning its source can abort this first play request.
        void element.play().catch(() => {});
        const blob = await storage.getAttachment(id);
        if (!active) return;
        if (!blob) throw new Error("附件尚未接收完成或已被清除");
        objectUrl = URL.createObjectURL(blob.type === mime ? blob : blob.slice(0, blob.size, mime));
        src = objectUrl;
      }
      element.src = src;
      try {
        await element.play();
      } catch (reason) {
        // A pause, a source change, or a browser playback preference leaves the controls usable.
        if (!(reason instanceof DOMException && ["AbortError", "NotAllowedError"].includes(reason.name)))
          throw new Error("此设备无法播放这个文件");
      }
    }
    void load(media).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "无法读取附件");
    });
    return () => {
      active = false;
      media.pause();
      if (media instanceof HTMLVideoElement) closePictureInPicture(media);
      media.removeAttribute("src");
      media.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, mime, storage, error]);

  const props = {
    ref: attachMedia, "aria-label": name, preload: "metadata",
    onError: () => setError("此设备无法播放这个文件"),
  } as const;
  return <div ref={playerRef} className="inline-media">
    {error ? <p role="alert">{t(error)}</p> : <I18nContext.Provider value={language}>
      {kind === "audio" ? (
        <AudioPlayer><AudioSkin><Audio {...props} /></AudioSkin></AudioPlayer>
      ) : (
        <VideoPlayer><VideoSkin><Video {...props} playsInline /></VideoSkin></VideoPlayer>
      )}
    </I18nContext.Provider>}
  </div>;
}
