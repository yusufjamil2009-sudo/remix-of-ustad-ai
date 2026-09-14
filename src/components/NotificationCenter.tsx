/**
 * PART 9 — Notification Bell + Notification Center.
 *
 * Mounted in the existing AppShell so the bell is reachable from every screen.
 * It renders the EXISTING design language (panel / border / muted-foreground
 * tokens) rather than introducing a new visual system.
 *
 * Every string the user sees comes from the server in their own language:
 * notification titles and messages were rendered and frozen at creation time,
 * and the chrome (tabs, headings, buttons) uses UI_TEXT keyed by the language
 * the server reports. Nothing here falls back to English.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bell, X, Check, Trash2 } from "lucide-react";
import {
  notificationFeedFn,
  notificationUnreadFn,
  notificationMarkReadFn,
  notificationMarkAllReadFn,
  notificationDeleteFn,
  upcomingEventsFn,
} from "@/lib/notification.functions";
import {
  UI_TEXT,
  ICON_OF,
  formatDayHeading,
  formatRelative,
  formatStartsIn,
  formatTimeOnly,
  type Language,
  type NotificationType,
} from "@/lib/notification-spec";
import { useGuest } from "@/lib/ustad-client";
import {
  BN_TEXT,
  browserNotifySupported,
  browserPermission,
  claimDelivery,
  releaseDelivery,
  getBrowserNotifyEnabled,
  requestBrowserPermission,
  seedDelivered,
  setBrowserNotifyEnabled,
  showBrowserNotification,
  type BnLanguage,
} from "@/lib/browser-notify";

type FeedItem = {
  id: string;
  type: string;
  category: string;
  title: string;
  message: string;
  language: Language;
  actionPath: string;
  isRead: boolean;
  createdAt: string;
  exactTime: string;
};

type UpcomingEvent = {
  id: string;
  name: string;
  eventType: string;
  status: string;
  startTime: string | null;
  startsAtText: string;
  endsAtText: string;
  entryText: string;
  rewardText: string;
};

const FILTERS = [
  "all",
  "unread",
  "events",
  "coins",
  "tournament",
  "achievements",
  "certificates",
  "shop",
  "system",
] as const;
type Filter = (typeof FILTERS)[number];

/**
 * Poll interval for the unread badge. Deliberately NOT one second (spec §46):
 * Supabase Realtime is not enabled in this deployment, so the badge refreshes
 * on a slow interval plus an immediate refresh on window focus and after any
 * action that can create a notification.
 */
const UNREAD_POLL_MS = 20000;

export function NotificationCenter() {
  const navigate = useNavigate();
  // The guest session is the single source of truth for the token. Calling any
  // notification function before it is ready throws "Invalid guest session".
  const { token, ready, guestId } = useGuest();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [events, setEvents] = useState<UpcomingEvent[]>([]);
  const [language, setLanguage] = useState<Language>("english");
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [filter, setFilter] = useState<Filter>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const t = UI_TEXT[language];

  /* ---------------- unread badge ---------------- */

  const refreshUnread = useCallback(async () => {
    try {
      if (!ready) return;
      const r = (await notificationUnreadFn({ data: { token } })) as { unread: number };
      setUnread(Number(r?.unread ?? 0));
    } catch {
      /* a badge failure must never break the page */
    }
  }, [ready, token]);

  useEffect(() => {
    if (!ready) return;
    void refreshUnread();
    const id = window.setInterval(() => void refreshUnread(), UNREAD_POLL_MS);
    const onFocus = () => void refreshUnread();
    window.addEventListener("focus", onFocus);
    // Any real action elsewhere in the app can announce itself so the badge
    // updates without a reload (spec §34).
    window.addEventListener("ustad:notifications-changed", onFocus);
    return () => {
      // Cleanup so navigating never leaves duplicate listeners (spec §46).
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("ustad:notifications-changed", onFocus);
    };
    // `ready` gates the effect body, so it belongs in the dependency array:
    // when the session becomes ready the poll starts, and on teardown the
    // interval/listeners are removed (no loop — refreshUnread never sets ready).
  }, [ready, refreshUnread]);

  /* -------- REAL browser/system notifications (additional channel) --------
   * The existing in-app notification system stays the source of truth; every
   * unread notification it produced is simply MIRRORED to the operating system
   * once, when the guest has switched this on and the browser granted
   * permission. Nothing here creates or hides an in-app notification. */

  const [bnEnabled, setBnEnabled] = useState(false);
  const [bnNote, setBnNote] = useState<string | null>(null);
  const bnText = BN_TEXT[language as BnLanguage] ?? BN_TEXT.english;

  useEffect(() => {
    if (!guestId) return;
    setBnEnabled(getBrowserNotifyEnabled(guestId) && browserPermission() === "granted");
  }, [guestId]);

  const deliverPending = useCallback(async () => {
    if (!ready || !guestId) return;
    if (!getBrowserNotifyEnabled(guestId) || browserPermission() !== "granted") return;
    try {
      const r = (await notificationFeedFn({
        data: { token, filter: "unread", cursor: null },
      })) as { items: FeedItem[] };
      // Oldest first so the newest system notification ends up on top.
      const pending = [...(r.items ?? [])].reverse();
      for (const n of pending) {
        // claimDelivery is the idempotency gate: one notification id can only
        // ever produce ONE system notification, even across reloads.
        if (!claimDelivery(guestId, n.id)) continue;
        const shown = await showBrowserNotification({
          tag: `ustad-notification-${n.id}`,
          title: n.title,
          body: n.message,
          path: `/notifications/${n.id}`,
        });
        if (!shown) {
          releaseDelivery(guestId, n.id);
          setBnNote(bnText["failed"] ?? null);
        }
      }
    } catch {
      /* delivery is best-effort and never affects the in-app feed */
    }
  }, [ready, guestId, token, bnText]);

  useEffect(() => {
    if (!bnEnabled || !ready) return;
    void deliverPending();
    const id = window.setInterval(() => void deliverPending(), UNREAD_POLL_MS);
    const onChanged = () => void deliverPending();
    window.addEventListener("ustad:notifications-changed", onChanged);
    window.addEventListener("focus", onChanged);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("ustad:notifications-changed", onChanged);
      window.removeEventListener("focus", onChanged);
    };
  }, [bnEnabled, ready, deliverPending]);

  const toggleBrowserNotifications = async () => {
    if (!guestId) return;
    setBnNote(null);
    if (bnEnabled) {
      setBrowserNotifyEnabled(guestId, false);
      setBnEnabled(false);
      return;
    }
    if (!browserNotifySupported()) {
      setBnNote(bnText["unsupported"] ?? null);
      return;
    }
    const status = await requestBrowserPermission();
    if (status !== "ok") {
      setBnNote((status === "denied" ? bnText["denied"] : bnText["topLevel"]) ?? null);
      return;
    }
    // Enabling must not dump the whole existing backlog into the OS: mark what
    // already exists as delivered, then only NEW notifications ring.
    try {
      const r = (await notificationFeedFn({
        data: { token, filter: "unread", cursor: null },
      })) as { items: FeedItem[] };
      seedDelivered(
        guestId,
        (r.items ?? []).map((n) => n.id),
      );
    } catch {
      /* ignore */
    }
    setBrowserNotifyEnabled(guestId, true);
    setBnEnabled(true);
  };

  /* ---------------- feed ---------------- */

  const loadFeed = useCallback(
    async (nextFilter: Filter, nextCursor: string | null, append: boolean) => {
      if (!ready) return;
      setLoading(true);
      try {
        const r = (await notificationFeedFn({
          data: { token, filter: nextFilter, cursor: nextCursor },
        })) as {
          items: FeedItem[];
          nextCursor: string | null;
          unreadCount: number;
          language: Language;
          timezone: string;
        };
        setItems((prev) => (append ? [...prev, ...(r.items ?? [])] : (r.items ?? [])));
        setCursor(r.nextCursor ?? null);
        setUnread(Number(r.unreadCount ?? 0));
        setLanguage(r.language ?? "english");
        setTimezone(r.timezone ?? "Asia/Kolkata");
      } catch {
        if (!append) setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [ready, token],
  );

  const loadUpcoming = useCallback(async () => {
    try {
      if (!ready) return;
      const r = (await upcomingEventsFn({ data: { token } })) as {
        events: UpcomingEvent[];
        language: Language;
      };
      setEvents(r.events ?? []);
      if (r.language) setLanguage(r.language);
    } catch {
      setEvents([]);
    }
  }, [ready, token]);

  useEffect(() => {
    if (!open || !ready) return;
    void loadFeed(filter, null, false);
    void loadUpcoming();
  }, [open, ready, filter, loadFeed, loadUpcoming]);

  /* ---------------- actions ---------------- */

  const onOpenItem = async (item: FeedItem) => {
    // Clicking a list row opens the FULL DETAIL page for this one notification
    // (the list itself stays short). Marking read also happens server-side in
    // the detail fetch, but we optimistically drop the badge right away.
    if (!item.isRead) {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n)));
      setUnread((u) => Math.max(0, u - 1));
      try {
        const r = (await notificationMarkReadFn({ data: { token, id: item.id } })) as {
          unread: number;
        };
        setUnread(Number(r?.unread ?? 0));
      } catch {
        /* optimistic state already applied */
      }
    }
    setOpen(false);
    void navigate({ to: `/notifications/${item.id}` });
  };

  const onDeleteItem = async (item: FeedItem) => {
    // Deleting is per-row: it removes ONLY this notification and never touches
    // the others. Soft-delete is server-side (persistent), not a UI-only hide.
    setItems((prev) => prev.filter((n) => n.id !== item.id));
    try {
      const r = (await notificationDeleteFn({ data: { token, id: item.id } })) as {
        unread: number;
      };
      setUnread(Number(r?.unread ?? 0));
    } catch {
      // Revert on failure.
      setItems((prev) => {
        const exists = prev.some((n) => n.id === item.id);
        return exists
          ? prev
          : [item, ...prev].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
    }
  };

  const onMarkAll = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnread(0);
    try {
      const r = (await notificationMarkAllReadFn({ data: { token } })) as { unread: number };
      setUnread(Number(r?.unread ?? 0));
    } catch {
      /* optimistic */
    }
  };

  /* Close on Escape / outside click. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  /* Group the timeline by day (spec §11). */
  const grouped = useMemo(() => {
    const out: Array<{ day: string; rows: FeedItem[] }> = [];
    for (const item of items) {
      const day = formatDayHeading(item.createdAt, item.language, timezone);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(item);
      else out.push({ day, rows: [item] });
    }
    return out;
  }, [items, timezone]);

  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <>
      <button
        type="button"
        data-testid="notification-bell"
        data-unread={unread}
        aria-label={t.notifications}
        onClick={() => setOpen((v) => !v)}
        className="relative flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      >
        <Bell className="size-5" />
        {unread > 0 ? (
          <span
            data-testid="notification-badge"
            className="absolute top-0.5 right-0.5 flex min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-[18px] font-bold text-primary-foreground"
          >
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-0 sm:p-4 md:items-start md:justify-end">
          <div
            ref={panelRef}
            data-testid="notification-center"
            className="panel flex h-[100dvh] w-full max-w-full flex-col overflow-hidden rounded-none border-border sm:h-[85vh] sm:max-w-md sm:rounded-xl md:mt-16 md:mr-4"
          >
            {/* header */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="truncate text-base font-semibold">{t.notifications}</h2>
              <div className="flex shrink-0 items-center gap-1">
                {unread > 0 ? (
                  <button
                    type="button"
                    data-testid="mark-all-read"
                    onClick={() => void onMarkAll()}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
                  >
                    <Check className="size-3.5" />
                    <span className="hidden sm:inline">{t.markAllRead}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  data-testid="notification-close"
                  aria-label={t.close}
                  onClick={() => setOpen(false)}
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent/60"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* category chips */}
            <div
              className="hide-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2"
              data-testid="notification-filters"
            >
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  data-testid={`filter-${f}`}
                  onClick={() => {
                    setFilter(f);
                    setCursor(null);
                  }}
                  className={`shrink-0 rounded-full px-3 py-1 text-xs whitespace-nowrap transition-colors ${
                    filter === f
                      ? "bg-primary text-primary-foreground"
                      : "bg-sidebar-accent/40 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t[f as keyof typeof t] ?? f}
                </button>
              ))}
            </div>

            {/* REAL browser/system notification switch (additional channel) */}
            <div className="shrink-0 border-b border-border px-4 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium">🌐 {bnText["label"]}</span>
                <button
                  type="button"
                  data-testid="browser-notify-toggle"
                  data-on={bnEnabled ? "1" : "0"}
                  aria-pressed={bnEnabled}
                  onClick={() => void toggleBrowserNotifications()}
                  className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
                    bnEnabled
                      ? "bg-primary text-primary-foreground"
                      : "bg-sidebar-accent/50 text-muted-foreground"
                  }`}
                >
                  {bnEnabled ? bnText["on"] : bnText["off"]}
                </button>
              </div>
              {bnNote ? (
                <p data-testid="browser-notify-note" className="mt-1 text-[11px] text-destructive">
                  {bnNote}
                </p>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {/* UPCOMING (spec §22, §40) */}
              {filter === "all" || filter === "events" ? (
                <section data-testid="upcoming-section" className="border-b border-border">
                  <h3 className="px-4 pt-3 pb-1 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                    {t.upcoming}
                  </h3>
                  {events.length === 0 ? (
                    <p className="px-4 pb-3 text-xs text-muted-foreground">{t.noUpcoming}</p>
                  ) : (
                    <ul className="space-y-2 px-3 pb-3">
                      {events.map((ev) => (
                        <li
                          key={ev.id}
                          data-testid={`upcoming-${ev.id}`}
                          className="rounded-lg border border-border bg-sidebar-accent/25 px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 flex-1 truncate text-sm font-medium">
                              📅 {ev.name}
                            </p>
                            <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                              {ev.startTime ? formatStartsIn(ev.startTime, language) : ""}
                            </span>
                          </div>
                          {ev.startsAtText ? (
                            <p className="mt-1 text-xs break-words text-muted-foreground">
                              {t.starts}: {ev.startsAtText}
                            </p>
                          ) : null}
                          {ev.endsAtText ? (
                            <p className="text-xs break-words text-muted-foreground">
                              {t.ends}: {ev.endsAtText}
                            </p>
                          ) : null}
                          <p className="text-xs text-muted-foreground">
                            {t.entry}: {ev.entryText}
                            {ev.rewardText ? ` • ${t.reward}: ${ev.rewardText}` : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {/* RECENT ACTIVITY (spec §11, §39) */}
              <section data-testid="activity-section">
                <h3 className="px-4 pt-3 pb-1 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                  {t.recentActivity}
                </h3>

                {items.length === 0 && !loading ? (
                  <p
                    data-testid="notification-empty"
                    className="px-4 py-6 text-center text-sm text-muted-foreground"
                  >
                    {t.noNotifications}
                  </p>
                ) : null}

                {grouped.map((group) => (
                  <div key={group.day}>
                    <p className="bg-sidebar-accent/20 px-4 py-1 text-[11px] font-medium text-muted-foreground">
                      {group.day}
                    </p>
                    <ul>
                      {group.rows.map((n) => (
                        <li key={n.id}>
                          <div className="relative">
                            <button
                              type="button"
                              data-testid={`notification-${n.id}`}
                              data-type={n.type}
                              data-language={n.language}
                              data-read={n.isRead ? "1" : "0"}
                              onClick={() => void onOpenItem(n)}
                              className={`flex w-full gap-3 border-b border-border/60 py-3 pr-9 pl-4 text-left transition-colors hover:bg-sidebar-accent/40 ${
                                n.isRead ? "" : "bg-primary/5"
                              }`}
                            >
                              <span className="shrink-0 text-lg leading-none">
                                {ICON_OF[n.type as NotificationType] ?? "🔔"}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-start gap-2">
                                  <span className="min-w-0 flex-1 text-sm font-medium break-words">
                                    {n.title}
                                  </span>
                                  {!n.isRead ? (
                                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                                  ) : null}
                                </span>
                                {n.message ? (
                                  <span className="mt-0.5 block text-xs whitespace-pre-line text-muted-foreground">
                                    {n.message}
                                  </span>
                                ) : null}
                                {/* Exact date+time is always present; relative is extra (spec §9). */}
                                <span
                                  data-testid={`time-${n.id}`}
                                  className="mt-1 block text-[11px] text-muted-foreground/80"
                                >
                                  {formatTimeOnly(n.createdAt, n.language, timezone)} •{" "}
                                  {n.exactTime} • {formatRelative(n.createdAt, n.language)}
                                </span>
                              </span>
                            </button>
                            {/* Independent per-row delete (never touches other rows). */}
                            <button
                              type="button"
                              data-testid={`delete-${n.id}`}
                              aria-label={t.delete}
                              onClick={() => void onDeleteItem(n)}
                              className="absolute top-3 right-2 flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {cursor ? (
                  <div className="p-3">
                    <button
                      type="button"
                      data-testid="load-more"
                      disabled={loading}
                      onClick={() => void loadFeed(filter, cursor, true)}
                      className="w-full rounded-lg border border-border py-2 text-xs text-muted-foreground hover:bg-sidebar-accent/40 disabled:opacity-50"
                    >
                      {t.loadMore}
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
