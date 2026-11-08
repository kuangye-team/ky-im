import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Languages, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGUAGE_CONFIG } from "../config";
import { setLanguagePreference, useLanguagePreference } from "../i18n";
import { isLanguagePreference } from "../i18n/language";

export function LanguageSelector() {
  const { t } = useTranslation();
  const selected = useLanguagePreference();
  const current = LANGUAGE_CONFIG.options.find(
    (option) => option.value === selected,
  )!;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="language-selector"
          aria-label={t("语言")}
          title={t("语言")}
        >
          <Languages size={16} aria-hidden="true" />
          <span>{t(current.label)}</span>
          <ChevronDown
            size={12}
            className="language-chevron"
            aria-hidden="true"
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="language-menu"
          align="end"
          sideOffset={10}
          collisionPadding={12}
        >
          <DropdownMenu.Label className="language-menu-heading">
            {t("语言")}
            <span>{t("选择界面语言")}</span>
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={selected}
            onValueChange={(value) => {
              if (isLanguagePreference(value)) setLanguagePreference(value);
            }}
          >
            {LANGUAGE_CONFIG.options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className="language-option"
                aria-label={t(option.label)}
              >
                <span className="language-option-icon" aria-hidden="true">
                  {option.value === "system" ? (
                    <Monitor size={17} />
                  ) : (
                    option.badge
                  )}
                </span>
                <span className="language-option-copy">
                  <strong>{t(option.label)}</strong>
                  <span>{t(option.description)}</span>
                </span>
                <DropdownMenu.ItemIndicator className="language-check">
                  <Check size={16} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
