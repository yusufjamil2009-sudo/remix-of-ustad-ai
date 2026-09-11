/**
 * The ONE place that decides which language the identity UI speaks.
 *
 * The existing `Settings → Language` value is the single source of truth (the
 * identity system must not introduce a second language system). Because the
 * Welcome screen can appear before a session exists, we fall back to the last
 * language this device actually used, read from the SAME settings mirror the
 * settings store already writes — never from a new preference store.
 */
import { useSettings } from "./settings-store";
import { DEFAULT_IDENTITY_LANGUAGE, type Language } from "./identity-spec";

const LANGS: readonly Language[] = ["english", "hindi", "hinglish"];

function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/** Last language persisted by the settings store for any guest on this device. */
export function lastKnownLanguage(): Language {
  if (typeof window === "undefined") return DEFAULT_IDENTITY_LANGUAGE;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith("ustad.settings.")) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { language?: unknown };
      if (isLanguage(parsed?.language)) return parsed.language;
    }
  } catch {
    /* unreadable mirror → default */
  }
  return DEFAULT_IDENTITY_LANGUAGE;
}

/** The identity UI language: server setting first, device mirror second. */
export function useIdentityLanguage(): Language {
  const { settings } = useSettings();
  if (isLanguage(settings?.language)) return settings.language;
  return lastKnownLanguage();
}
