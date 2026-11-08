import { afterEach, describe, expect, it } from "vitest";
import { i18n, resolveLanguage } from "./i18n";
import { translateError } from "./localizeError";

const originalLanguage = i18n.language;
afterEach(async () => {
  await i18n.changeLanguage(originalLanguage);
});

describe("interface language", () => {
  it("uses Chinese for Chinese system variants and English for unsupported languages", () => {
    expect(resolveLanguage("system", "zh-TW")).toBe("zh-CN");
    expect(resolveLanguage("system", "zh-Hant-HK")).toBe("zh-CN");
    expect(resolveLanguage("system", "en-GB")).toBe("en");
    expect(resolveLanguage("system", "fr-FR")).toBe("en");
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
  });

  it("interpolates Chinese fallback keys and chooses English plurals without changing names", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("与 {{value}} 聊天", { value: "小林 & Alex" })).toBe(
      "与 小林 & Alex 聊天",
    );
    await i18n.changeLanguage("en");
    expect(i18n.t("与 {{value}} 聊天", { value: "小林 & Alex" })).toBe(
      "Chat with 小林 & Alex",
    );
    expect(i18n.t("{{count}} 条", { count: 1 })).toBe("1 result");
    expect(i18n.t("{{count}} 条", { count: 2 })).toBe("2 results");
    expect(i18n.t("关闭", { ns: "components" })).toBe("Close");
  });

  it("localizes stored errors while preserving user filenames and dynamic limits", async () => {
    const filename = "预算 & notes.txt";
    const error = `“${filename}”超过 12.5 MB，请选择较小的文件`;
    await i18n.changeLanguage("en");
    const translated = translateError(error);
    expect(translated).toContain(filename);
    expect(translated).toContain("12.5 MB");
    expect(translated).not.toContain("超过");
    await i18n.changeLanguage("zh-CN");
    expect(translateError(error)).toBe(error);
  });
});
