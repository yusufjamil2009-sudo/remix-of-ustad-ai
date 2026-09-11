/**
 * Guest-scoped settings store — the single source of truth for preferences.
 *
 * Root cause this fixes: panels used component-local state seeded from a session
 * object that was still `null` on first render, so defaults ("english",
 * data_saver = off) overwrote the persisted values and never re-hydrated. Now
 * persisted value → state, never the reverse, with an offline mirror per guest id
 * so a slow/failed round trip can't silently reset a preference.
 */
import { useCallback, useEffect, useState } from "react";
import { saveSettingsFn, saveProfileFn } from "./ustad-api";
import { ensureGuest, getSnapshot, patchSession } from "./ustad-client";

export type Language = "english" | "hindi" | "hinglish";

export type UstadSettings = {
  language: Language;
  data_saver: boolean;
  auto_speak: boolean;
  web_search: boolean;
  timezone: string;
};

export const DEFAULT_SETTINGS: UstadSettings = {
  language: "english",
  data_saver: false,
  auto_speak: false,
  web_search: true,
  timezone: "",
};

const mirrorKey = (guestId: string) => `ustad.settings.${guestId}`;

function readMirror(guestId: string): Partial<UstadSettings> {
  if (typeof window === "undefined" || !guestId) return {};
  try {
    return JSON.parse(
      window.localStorage.getItem(mirrorKey(guestId)) ?? "{}",
    ) as Partial<UstadSettings>;
  } catch {
    return {};
  }
}

function writeMirror(guestId: string, s: UstadSettings) {
  if (typeof window === "undefined" || !guestId) return;
  window.localStorage.setItem(mirrorKey(guestId), JSON.stringify(s));
}

function normalize(
  row: Record<string, unknown> | null | undefined,
  mirror: Partial<UstadSettings>,
): UstadSettings {
  const lang = (row?.["language"] ?? mirror.language ?? DEFAULT_SETTINGS.language) as Language;
  return {
    language: ["english", "hindi", "hinglish"].includes(lang) ? lang : "english",
    data_saver: Boolean(row?.["data_saver"] ?? mirror.data_saver ?? DEFAULT_SETTINGS.data_saver),
    auto_speak: Boolean(row?.["auto_speak"] ?? mirror.auto_speak ?? DEFAULT_SETTINGS.auto_speak),
    web_search: (row?.["web_search"] ?? mirror.web_search ?? true) !== false,
    timezone: String(row?.["timezone"] ?? mirror.timezone ?? "") || guessTz(),
  };
}

function guessTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}
/** Guests whose timezone was already pushed to the server in this tab. */
const tzSaved = new Set<string>();

/** Guest-scoped settings with optimistic update + durable persistence. */
export function useSettings() {

  const [settings, setSettings] = useState<UstadSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void ensureGuest()
      .then((s) => {
        if (!alive) return;
        const next = normalize(s.settings, readMirror(s.guestId));
        setSettings(next);
        if (!s.guestId) return; // no identity yet (Welcome screen): nothing to persist
        writeMirror(s.guestId, next);
        // make sure the detected timezone is stored server-side once per guest
        if (!s.settings?.["timezone"] && next.timezone && !tzSaved.has(s.guestId)) {
          tzSaved.add(s.guestId);
          void saveSettingsFn({
            data: { token: s.token, patch: { timezone: next.timezone } },
          }).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);


  const update = useCallback(async (patch: Partial<UstadSettings>) => {
    const guestId = getSnapshot().session?.guestId ?? "";
    let optimistic: UstadSettings | null = null;
    setSettings((prev) => {
      optimistic = { ...(prev ?? DEFAULT_SETTINGS), ...patch };
      if (guestId) writeMirror(guestId, optimistic);
      return optimistic;
    });
    setSaving(true);
    try {
      const row = (await saveSettingsFn({ data: { token: "", patch } })) as Record<string, unknown>;
      const confirmed = normalize(row, optimistic ?? {});
      setSettings(confirmed);
      if (guestId) writeMirror(guestId, confirmed);
      patchSession({ settings: row });
      return confirmed;
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, ready: settings !== null, saving, update };
}

/** Profile persistence (name/age/education/interests/language). */
export async function saveProfilePatch(patch: Record<string, unknown>) {
  const row = (await saveProfileFn({ data: { token: "", patch } })) as Record<string, unknown>;
  patchSession({ profile: row });
  return row;
}
