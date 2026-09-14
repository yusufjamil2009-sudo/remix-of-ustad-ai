/**
 * 🔥 GLOBAL COIN OFFER banner (read-only mirror + navigation).
 *
 * The client only READS a banner-safe view of the current weekly offer via
 * `coinOfferBannerFn`. All schedule/discount decisions are server-side; the
 * server-fn also fires the idempotent per-guest "live" notification the first
 * time a live offer is surfaced.
 *
 * The ENTIRE banner is a real link to the EXISTING /shop route (no new shop
 * page). It is keyboard-accessible as a normal anchor, has no nested links or
 * buttons, and its copy follows the user's Settings language (returned by the
 * server-fn) rather than being hard-coded English.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Flame } from "lucide-react";
import { coinOfferBannerFn } from "@/lib/coin-offer.functions";
import { UI_TEXT, fillTokens, type Language } from "@/lib/notification-spec";

type BannerState = {
  available: boolean;
  live?: boolean;
  upcoming?: boolean;
  weeklyOfferId?: string;
  discountPct?: number;
  startIso?: string;
  endIso?: string;
  language?: Language;
};

const IST_TZ = "Asia/Kolkata";

function istClock(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-IN", {
      timeZone: IST_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

function istDay(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      timeZone: IST_TZ,
      weekday: "long",
      day: "numeric",
      month: "short",
    });
  } catch {
    return "";
  }
}

export function CoinOfferBanner({ token }: { token: string }) {
  const [state, setState] = useState<BannerState | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let boundaryTimer: number | undefined;
    const load = async () => {
      try {
        const res = await coinOfferBannerFn({ data: { token } });
        if (alive) {
          setState(res);
          window.clearTimeout(boundaryTimer);
          const boundary = res.live ? res.endIso : res.startIso;
          const ms = boundary ? Date.parse(boundary) - Date.now() + 100 : 60000;
          // Wake exactly at the start/end boundary while retaining a slow
          // recovery poll for clock/network failures.
          boundaryTimer = window.setTimeout(() => void load(), Math.max(1000, Math.min(ms, 60000)));
        }
      } catch {
        if (alive) setState(null);
      } finally {
        if (alive) setChecked(true);
      }
    };
    void load();
    return () => {
      alive = false;
      window.clearTimeout(boundaryTimer);
    };
  }, [token]);

  if (!checked || !state?.available || !state.live) return null;

  const pct = state.discountPct ?? 0;
  const language: Language = state.language ?? "english";
  const t = UI_TEXT[language];

  const liveBody = `${fillTokens(t.offerLiveBodyLead, { pct })} ${fillTokens(t.offerLiveBodyEnd, {
    time: istClock(state.endIso),
  })}`;
  const comingBody = `${fillTokens(t.offerComingBodyLead, { pct })} ${fillTokens(
    t.offerComingBodyBetween,
    { day: istDay(state.startIso), start: istClock(state.startIso), end: istClock(state.endIso) },
  )}`;

  return (
    <Link
      to="/shop"
      data-testid="coin-offer-banner"
      aria-label={
        state.live ? `${t.offerLiveTitle} — ${pct}% OFF` : `${t.offerComingTitle} — ${pct}% OFF`
      }
      className={`mb-6 flex flex-col gap-1 rounded-xl border px-4 py-3 no-underline transition-colors hover:border-border/80 sm:flex-row sm:items-center sm:justify-between ${
        state.live
          ? "border-amber-400/50 bg-gradient-to-r from-amber-500/15 via-orange-500/15 to-red-500/15 hover:bg-amber-500/20"
          : "border-border/60 bg-card/60 hover:bg-card"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-amber-500 to-red-600 text-white shadow"
          aria-hidden
        >
          <Flame className="size-5" />
        </span>
        <div>
          <p
            data-testid="coin-offer-title"
            data-live={state.live ? "1" : "0"}
            className={state.live ? "text-sm font-bold text-amber-600" : "text-sm font-bold"}
          >
            {/* An upcoming offer must NOT be headlined as LIVE. */}
            {state.live ? t.offerLiveTitle : t.offerComingTitle}
            <span className="font-semibold"> — {pct}% OFF</span>
          </p>
          <p className="text-xs text-muted-foreground">{state.live ? liveBody : comingBody}</p>
        </div>
      </div>
      <span className="mt-2 shrink-0 self-start rounded-full bg-foreground/5 px-3 py-1 text-[11px] font-semibold text-muted-foreground sm:mt-0 sm:self-center">
        {t.offerChip}
      </span>
    </Link>
  );
}
