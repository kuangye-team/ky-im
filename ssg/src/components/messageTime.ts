import { i18n } from "../i18n";

export const messageTime = (n: number) =>
  new Date(n).toLocaleTimeString(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  });

export const messageDay = (n: number) =>
  new Date(n).toLocaleDateString(i18n.language, {
    month: "long",
    day: "numeric",
  });
