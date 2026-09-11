/**
 * REAL browser / system notification delivery — an ADDITIONAL channel on top of
 * the existing USTAD AI notification + reminder systems.
 *
 * Nothing here creates, stores or replaces a notification: the existing
 * server-side notification pipeline stays the single source of truth. This
 * module only mirrors an already-created notification to the operating system
 * when the user has explicitly allowed it.
 *
 * Rules honoured here:
 *  - The REAL `Notification.requestPermission()` is used. Permission is never
 *    faked, assumed or bypassed.
 *  - Delivery is de-duplicated per guest by notification id, so one event can
 *    never fire two or more system notifications.
 *  - Every failure is silent for the app: in-app notifications and reminders
 *    keep working exactly as before.
 */

export type BrowserPermission = "unsupported" | "default" | "granted" | "denied";

export type BrowserNotifyStatus =
  | "ok"
  | "unsupported"
  | "needs-top-level" // cross-origin preview iframe: browsers refuse the prompt
  | "denied";

const PREF_PREFIX = "ustad.browser-notify.enabled.";
const SENT_PREFIX = "ustad.browser-notify.sent.";
const SENT_CAP = 300;

/* ------------------------------------------------------------------ */
/* capability                                                          */
/* ------------------------------------------------------------------ */

export function browserNotifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function inCrossOriginFrame(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

export function browserPermission(): BrowserPermission {
  if (!browserNotifySupported()) return "unsupported";
  return window.Notification.permission as BrowserPermission;
}

/** Ask the REAL browser for permission. Never simulated. */
export async function requestBrowserPermission(): Promise<BrowserNotifyStatus> {
  if (!browserNotifySupported()) return "unsupported";
  if (window.Notification.permission === "granted") return "ok";
  if (window.Notification.permission === "denied") return "denied";
  if (inCrossOriginFrame()) return "needs-top-level";
  try {
    const result = await window.Notification.requestPermission();
    if (result === "granted") return "ok";
    return result === "denied" ? "denied" : "needs-top-level";
  } catch {
    return "needs-top-level";
  }
}

/* ------------------------------------------------------------------ */
/* per-guest preference (survives refresh / reopen)                     */
/* ------------------------------------------------------------------ */

export function getBrowserNotifyEnabled(guestId: string): boolean {
  if (typeof window === "undefined" || !guestId) return false;
  try {
    return window.localStorage.getItem(PREF_PREFIX + guestId) === "1";
  } catch {
    return false;
  }
}

export function setBrowserNotifyEnabled(guestId: string, on: boolean): void {
  if (typeof window === "undefined" || !guestId) return;
  try {
    window.localStorage.setItem(PREF_PREFIX + guestId, on ? "1" : "0");
  } catch {
    /* storage disabled — the toggle simply won't persist */
  }
}

/* ------------------------------------------------------------------ */
/* de-duplication: one notification → at most one system notification   */
/* ------------------------------------------------------------------ */

function sentIds(guestId: string): string[] {
  if (typeof window === "undefined" || !guestId) return [];
  try {
    const raw = window.localStorage.getItem(SENT_PREFIX + guestId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Returns true the FIRST time an id is seen; false on every later call. */
export function claimDelivery(guestId: string, id: string): boolean {
  if (typeof window === "undefined" || !guestId || !id) return false;
  const list = sentIds(guestId);
  if (list.includes(id)) return false;
  list.push(id);
  try {
    window.localStorage.setItem(
      SENT_PREFIX + guestId,
      JSON.stringify(list.slice(-SENT_CAP)),
    );
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Seed the de-dup store without delivering anything. Used the first time a
 * guest enables browser notifications so the whole existing backlog does not
 * arrive at once.
 */
export function seedDelivered(guestId: string, ids: string[]): void {
  if (typeof window === "undefined" || !guestId) return;
  const merged = [...sentIds(guestId), ...ids.map(String)];
  try {
    window.localStorage.setItem(
      SENT_PREFIX + guestId,
      JSON.stringify(Array.from(new Set(merged)).slice(-SENT_CAP)),
    );
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* delivery                                                            */
/* ------------------------------------------------------------------ */

export type BrowserNotifyPayload = {
  /** Stable tag: identical tags collapse instead of stacking duplicates. */
  tag: string;
  title: string;
  body?: string;
  /** In-app path opened when the system notification is clicked. */
  path?: string;
};

/**
 * Show a real system notification. Prefers the service worker (required by
 * Chrome on Android and the only path that survives a backgrounded tab), and
 * falls back to the page-level Notification constructor.
 */
export async function showBrowserNotification(p: BrowserNotifyPayload): Promise<boolean> {
  if (!browserNotifySupported() || window.Notification.permission !== "granted") return false;
  const options: NotificationOptions = {
    body: p.body ?? "",
    tag: p.tag,
    icon: "/icons/ustad-192.png",
    badge: "/icons/ustad-192.png",
    data: { path: p.path ?? "/", tag: p.tag },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) {
      await reg.showNotification(p.title, options);
      return true;
    }
  } catch {
    /* fall through to the page-level notification */
  }
  try {
    const n = new window.Notification(p.title, options);
    n.onclick = () => {
      try {
        window.focus();
        if (p.path) window.location.assign(p.path);
      } catch {
        /* ignore */
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* copy (follows the existing Settings language)                       */
/* ------------------------------------------------------------------ */

export type BnLanguage = "english" | "hindi" | "hinglish";

export const BN_TEXT: Record<BnLanguage, Record<string, string>> = {
  english: {
    label: "Browser Notification",
    on: "ON",
    off: "OFF",
    denied: "Blocked in this browser. Allow notifications in site settings.",
    unsupported: "This browser does not support notifications.",
    topLevel: "Open USTAD AI in its own tab to allow notifications.",
  },
  hinglish: {
    label: "Browser Notification",
    on: "ON",
    off: "OFF",
    denied: "Browser ne block kiya hai. Site settings me allow karein.",
    unsupported: "Is browser me notification support nahi hai.",
    topLevel: "Allow karne ke liye USTAD AI ko apne tab me kholein.",
  },
  hindi: {
    label: "ब्राउज़र सूचना",
    on: "चालू",
    off: "बंद",
    denied: "ब्राउज़र ने रोक दिया है। साइट सेटिंग्स में अनुमति दें।",
    unsupported: "इस ब्राउज़र में सूचना समर्थित नहीं है।",
    topLevel: "अनुमति देने के लिए USTAD AI को अलग टैब में खोलें।",
  },
};
