import { PROFILE_GENERATION_CONFIG, type AppLanguage } from "../config";
import { readLanguagePreference, resolveLanguage } from "../i18n/language";

function randomIndex(length: number) {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % length;
}

export function randomChoice<T>(values: readonly T[]): T {
  return values[randomIndex(values.length)]!;
}

export function generateProfileName(
  language: AppLanguage = resolveLanguage(readLanguagePreference()),
  current = "",
) {
  const config = PROFILE_GENERATION_CONFIG;
  const names = config.copy[language].names;
  // Repeated clicks always offer another name, even if the random draw repeats.
  const alternatives = names.filter((name) => !current.startsWith(`${name} `));
  const name = randomChoice(alternatives.length ? alternatives : names);
  const suffix = String(randomIndex(config.suffixRange)).padStart(
    config.suffixDigits,
    "0",
  );
  return `${name} ${suffix}`;
}

export function generateProfileBio(
  language: AppLanguage = resolveLanguage(readLanguagePreference()),
  current = "",
) {
  const bios = PROFILE_GENERATION_CONFIG.copy[language].bios;
  const alternatives = bios.filter((bio) => bio !== current);
  return randomChoice(alternatives.length ? alternatives : bios);
}
