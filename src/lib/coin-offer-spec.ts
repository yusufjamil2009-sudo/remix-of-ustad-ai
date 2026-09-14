/**
 * USTAD AI — GLOBAL COIN OFFER (pure, isomorphic specification).
 *
 * A single weekly "Global Coin Offer" that discounts EVERY eligible
 * Ustad-Coin purchase in the whole app (Shop items, tickets, passes,
 * tournament/event entries, unlocks — anything priced in USTAD Coins). It is
 * deliberately NOT a shop-only feature.
 *
 * Pure + isomorphic so the same rules drive the server (which is authoritative
 * and actually charges the discounted amount) and the read-only UI mirror.
 *
 * CONFIGURATION (non-negotiable, §37):
 *   • one offer day per calendar week  → day is RANDOM/variable week-to-week
 *   • active only between 07:00 and 20:00 (India time)
 *   • duration 10 minutes … 3 hours    → variable each week
 *   • discount  10% … 70%              → variable each week
 *   • the discounted price is what is actually deducted (no fake math)
 *
 * The week is a Sunday→Sunday India-time cycle, reusing the same canonical
 * boundaries the rank engine already uses (rank-spec.ts). We never invent a
 * second calendar.
 */

import { currentCycle, previousCycle, type RankCycle } from "./rank-spec";

/** Indian-format coin amount (2,00,00,000) reused from rank-spec. */
export { formatCoins } from "./rank-spec";

/* ------------------------------------------------------------------ */
/* Global rules (non-negotiable)                                       */
/* ------------------------------------------------------------------ */

export const OFFER_MIN_DISCOUNT_PCT = 10;
export const OFFER_MAX_DISCOUNT_PCT = 70;
export const OFFER_MIN_DURATION_MINUTES = 10;
export const OFFER_MAX_DURATION_MINUTES = 180; // 3 hours
/** Offer may not start before this India-time clock minute-of-day. */
export const OFFER_DAY_START = 7 * 60; // 07:00
/** Offer may not end after this India-time clock minute-of-day. */
export const OFFER_DAY_END = 20 * 60; // 20:00
/** One offer per cycle — never two. */
export const OFFER_PER_WEEK = 1;

export const IST_OFFSET_MS = 5.5 * 3_600_000;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Minutes-of-day in India time, 0..1439. */
export type OfferTime = { startMinute: number; endMinute: number };

export type WeeklyOffer = {
  /** Cycle this offer belongs to (Sunday→Sunday, India time). */
  cycle: RankCycle;
  /** The chosen offer day inside the cycle, as a Date-offset weekday (0=Sun…6=Sat). */
  dayOffset: number;
  /** Absolute active window (UTC ISO), derived from India time. */
  startIso: string;
  endIso: string;
  discountPct: number;
  durationMinutes: number;
  /** Stable unique weekly-offer id: `offer:<cycleStart>:<dayOffset>:<discount>:<dur>`. */
  weeklyOfferId: string;
  /** Persisted offers may be disabled without deleting their audit record. */
  enabled?: boolean;
  /** Global offers apply to every eligible coin-priced item by default. */
  applicable?: boolean;
  /** Persisted lifecycle status, when the database supplies one. */
  status?: string;
};

export type OfferEligibility = {
  eligible: boolean;
  reason?: string;
};

/* ------------------------------------------------------------------ */
/* Discount math                                                       */
/* ------------------------------------------------------------------ */

/** True when a discount percentage is within the allowed range. */
export function validDiscountPct(pct: number): boolean {
  return Number.isFinite(pct) && pct >= OFFER_MIN_DISCOUNT_PCT && pct <= OFFER_MAX_DISCOUNT_PCT;
}

/** Whole minutes between 10 and 180 inclusive. */
export function validDurationMinutes(m: number): boolean {
  return Number.isInteger(m) && m >= OFFER_MIN_DURATION_MINUTES && m <= OFFER_MAX_DURATION_MINUTES;
}

/** Round discount so final price is an integer (we only deal in whole coins). */
export function discountAmount(basePrice: number, discountPct: number): number {
  if (!Number.isFinite(basePrice) || basePrice <= 0) return 0;
  return Math.round((basePrice * discountPct) / 100);
}

/** Real discounted final price — this is what gets charged. */
export function offerFinalPrice(basePrice: number, discountPct: number): number {
  return Math.max(basePrice - discountAmount(basePrice, discountPct), 0);
}

/** Validate a whole schedule against every global rule. */
export function validateSchedule(input: {
  discountPct: number;
  durationMinutes: number;
  startMinute: number;
}): { ok: boolean; reason?: string } {
  if (!validDiscountPct(input.discountPct))
    return {
      ok: false,
      reason: `Discount must be ${OFFER_MIN_DISCOUNT_PCT}%–${OFFER_MAX_DISCOUNT_PCT}%.`,
    };
  if (!validDurationMinutes(input.durationMinutes))
    return {
      ok: false,
      reason: `Duration must be ${OFFER_MIN_DURATION_MINUTES}–${OFFER_MAX_DURATION_MINUTES} minutes.`,
    };
  if (input.startMinute < OFFER_DAY_START)
    return { ok: false, reason: "Offer cannot start before 07:00." };
  const endMinute = input.startMinute + input.durationMinutes;
  if (endMinute > OFFER_DAY_END) return { ok: false, reason: "Offer cannot end after 20:00." };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* India-time window helpers                                           */
/* ------------------------------------------------------------------ */

/** Minute-of-day in India time for an instant (0..1439). */
export function istMinuteOfDay(at: Date | number): number {
  const ms = new Date(at).getTime() + IST_OFFSET_MS;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** The India-time weekday (0=Sun…6=Sat) for an instant. */
export function istWeekday(at: Date | number): number {
  const d = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  return d.getUTCDay();
}

/**
 * Given a cycle and an offer day-offset inside it, an active window start minute
 * (India time, >=07:00) and a duration, return absolute UTC ISO boundaries.
 * The offer day is `cycle.start` + `dayOffset` days (in India time).
 */
export function offerWindowIso(
  cycle: RankCycle,
  dayOffset: number,
  startMinute: number,
  durationMinutes: number,
): { startIso: string; endIso: string } {
  const startLocal = new Date(Date.parse(`${cycle.start}T00:00:00Z`) + dayOffset * 86_400_000);
  const startAbs = startLocal.getTime() + startMinute * 60_000 - IST_OFFSET_MS;
  const endAbs = startAbs + durationMinutes * 60_000;
  return { startIso: new Date(startAbs).toISOString(), endIso: new Date(endAbs).toISOString() };
}

/* ------------------------------------------------------------------ */
/* Deterministic weekly generation                                    */
/* ------------------------------------------------------------------ */

/**
 * Small seeded PRNG (mulberry32) so the weekly schedule is reproducible from the
 * cycle start alone. This lets the same week always resolve to the SAME single
 * offer (one-per-week guarantee) while staying variable across weeks.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromCycle(cycle: RankCycle): number {
  // FNV-1a over the cycle start string.
  let h = 0x811c9dc5;
  for (const ch of cycle.start) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/**
 * Deterministically pick the single weekly offer parameters for a cycle:
 * a random weekday (Mon..Sun, never fixed), a random 10..70% discount, and a
 * random duration between 10 min and 3 hours that fits inside 07:00–20:00.
 */
export function generateWeeklyOffer(cycle: RankCycle): WeeklyOffer {
  const rand = seededRandom(seedFromCycle(cycle));
  // Offer day: any of the 7 days of the week (dayOffset 0..6 within cycle).
  const dayOffset = Math.floor(rand() * 7);
  const discountPct =
    OFFER_MIN_DISCOUNT_PCT +
    Math.floor(rand() * (OFFER_MAX_DISCOUNT_PCT - OFFER_MIN_DISCOUNT_PCT + 1));
  const durationMinutes =
    OFFER_MIN_DURATION_MINUTES +
    Math.floor(rand() * (OFFER_MAX_DURATION_MINUTES - OFFER_MIN_DURATION_MINUTES + 1));

  // A valid start minute so start>=07:00 and start+duration<=20:00.
  const latestStart = OFFER_DAY_END - durationMinutes;
  const startMinute = OFFER_DAY_START + Math.floor(rand() * (latestStart - OFFER_DAY_START + 1));

  const { startIso, endIso } = offerWindowIso(cycle, dayOffset, startMinute, durationMinutes);
  return {
    cycle,
    dayOffset,
    startIso,
    endIso,
    discountPct,
    durationMinutes,
    weeklyOfferId: `offer:${cycle.start}:${dayOffset}:${discountPct}:${durationMinutes}`,
  };
}

/** The offer belonging to the current cycle. */
export function offerForNow(now: Date | string | number = new Date()): WeeklyOffer {
  return generateWeeklyOffer(currentCycle(now));
}

/** The offer belonging to the previous (already-ended) cycle. */
export function offerForPreviousCycle(now: Date | string | number = new Date()): WeeklyOffer {
  return generateWeeklyOffer(previousCycle(currentCycle(now)));
}

/** Validate the persisted offer fields before any UI or purchase can use them. */
export function isValidOffer(offer: WeeklyOffer | null | undefined): boolean {
  if (!offer || offer.enabled === false || offer.applicable === false) return false;
  if (["disabled", "inactive", "cancelled", "expired"].includes(offer.status ?? "")) return false;
  if (!validDiscountPct(offer.discountPct) || !validDurationMinutes(offer.durationMinutes))
    return false;
  const start = Date.parse(offer.startIso);
  const end = Date.parse(offer.endIso);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start === offer.durationMinutes * 60_000
  );
}

/** True when an offer window is live for `at`. */
export function isOfferLive(offer: WeeklyOffer, at: Date | string | number = new Date()): boolean {
  if (!isValidOffer(offer)) return false;
  const t = new Date(at).getTime();
  return t >= Date.parse(offer.startIso) && t < Date.parse(offer.endIso);
}

/** True when `now` is strictly before this offer's window (a future offer). */
export function isOfferUpcoming(
  offer: WeeklyOffer,
  now: Date | string | number = new Date(),
): boolean {
  if (!isValidOffer(offer)) return false;
  return new Date(now).getTime() < Date.parse(offer.startIso);
}

/** Human Indian "hh:mm AM/PM" from a minute-of-day value (0..1439). */
export function minuteLabel(minute: number): string {
  const h24 = Math.floor(minute / 60);
  const m = minute % 60;
  const period = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
}
