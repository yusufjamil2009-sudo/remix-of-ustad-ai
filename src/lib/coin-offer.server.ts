/**
 * USTAD AI — GLOBAL COIN OFFER (server authority).
 *
 * EXTENDS the existing economy; it never replaces or duplicates anything:
 *   • time/calendar → reuses rank-spec IST Sunday→Sunday cycle + this module's
 *     pure spec (Chrono-driven "now").
 *   • coins          → existing `ustad_coin_ledger` / `applyCoins` / wallet.
 *   • notifications  → existing notifyGuest (reminders feed).
 *   • prices         → ALWAYS the authoritative server catalogue; the client
 *     never sends a price, a discount, a duration or a time window.
 *
 * The offer schedule is DETERMINISTIC per week (seeded from the cycle start) and
 * PERSISTED so it can be audited and notified about — one offer per cycle, a
 * guarantee enforced by the unique per-cycle row.
 *
 * Only the discounted amount is ever charged. All charge sites in the app route
 * their coin debit through `coinOfferPrice()`/`coinOfferCharge()` defined here,
 * so the discount applies to ANY USTAD-Coin purchase (Shop, tickets, passes,
 * tournament/event entries, unlocks) without per-site logic.
 */

import { db } from "./guest.server";
import { notifyGuest } from "./notification.server";
import { applyCoins } from "./wallet.server";
import { currentCycle, previousCycle, type RankCycle } from "./rank-spec";
import {
  discountAmount,
  generateWeeklyOffer,
  isOfferLive,
  isOfferUpcoming,
  offerFinalPrice,
  validDiscountPct,
  validDurationMinutes,
  type WeeklyOffer,
} from "./coin-offer-spec";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const sdb = () => db() as any;

/* ------------------------------------------------------------------ */
/* Persistence (one offer row per cycle)                               */
/* ------------------------------------------------------------------ */

/** Load the offer row for a cycle, creating+persisting the deterministic offer if absent. */
async function loadOrCreateOffer(cycle: RankCycle): Promise<Row> {
  const { data } = await sdb()
    .from("ustad_coin_offers")
    .select("*")
    .eq("cycle_start", cycle.start)
    .maybeSingle();
  if (data) return data as Row;

  const off = generateWeeklyOffer(cycle);
  const { data: created, error } = await sdb()
    .from("ustad_coin_offers")
    .insert({
      cycle_start: cycle.start,
      cycle_end: cycle.end,
      weekly_offer_id: off.weeklyOfferId,
      offer_day_offset: off.dayOffset,
      start_iso: off.startIso,
      end_iso: off.endIso,
      discount_pct: off.discountPct,
      duration_minutes: off.durationMinutes,
      status: "scheduled",
    })
    .select()
    .maybeSingle();
  if (error || !created) {
    // A concurrent writer already persisted this cycle's single offer.
    const again = await sdb()
      .from("ustad_coin_offers")
      .select("*")
      .eq("cycle_start", cycle.start)
      .maybeSingle();
    return (again?.data as Row) ?? null;
  }
  return created as Row;
}

function rowToWeeklyOffer(row: Row): WeeklyOffer {
  return {
    cycle: {
      start: String(row["cycle_start"]),
      end: String(row["cycle_end"]),
      startIso: "",
      endIso: "",
      id: `week:${row["cycle_start"]}`,
    },
    dayOffset: Number(row["offer_day_offset"] ?? 0),
    startIso: String(row["start_iso"]),
    endIso: String(row["end_iso"]),
    discountPct: Number(row["discount_pct"]),
    durationMinutes: Number(row["duration_minutes"]),
    weeklyOfferId: String(row["weekly_offer_id"]),
    enabled: row["enabled"] !== false && row["is_enabled"] !== false,
    applicable: row["applicable"] !== false && row["applies_to_all"] !== false,
    status: String(row["status"] ?? "scheduled").toLowerCase(),
  };
}

/** Current weekly offer (this Sunday→Sunday cycle), persisted once. */
export async function offerForCycle(cycle: RankCycle): Promise<WeeklyOffer> {
  const row = await loadOrCreateOffer(cycle);
  if (!row) throw new Error("Could not resolve the coin offer schedule.");
  return rowToWeeklyOffer(row);
}

/** The active offer right now, or null when none is live. */
export async function activeOffer(now: Date = new Date()): Promise<WeeklyOffer | null> {
  const off = await offerForCycle(currentCycle(now));
  // Only consider live if inside the window AND rules hold.
  if (!isOfferLive(off, now)) return null;
  return off;
}

/* ------------------------------------------------------------------ */
/* Pricing + charging (server authority)                               */
/* ------------------------------------------------------------------ */

export type OfferPrice = {
  offerActive: boolean;
  weeklyOfferId: string | null;
  discountPct: number;
  basePrice: number;
  discountAmount: number;
  finalPrice: number;
};

/** Real discounted price for any base coin price, or identity when no live offer. */
export async function coinOfferPrice(basePrice: number): Promise<OfferPrice> {
  const off = await activeOffer();
  return priceFromOffer(basePrice, off);
}

/** Apply one already-resolved offer without re-reading the database. */
export function priceFromOffer(basePrice: number, off: WeeklyOffer | null): OfferPrice {
  if (!off || !Number.isFinite(basePrice) || basePrice <= 0) {
    return {
      offerActive: false,
      weeklyOfferId: null,
      discountPct: 0,
      basePrice,
      discountAmount: 0,
      finalPrice: basePrice,
    };
  }
  const amt = discountAmount(basePrice, off.discountPct);
  return {
    offerActive: true,
    weeklyOfferId: off.weeklyOfferId,
    discountPct: off.discountPct,
    basePrice,
    discountAmount: amt,
    finalPrice: offerFinalPrice(basePrice, off.discountPct),
  };
}

/**
 * Route a coin debit through the offer: charges `finalPrice` (never `basePrice`)
 * when a live offer applies, else the base. This is the ONE place spend happens
 * for purchasable/entry/activation flows. Reuses applyCoins (existing ledger).
 */
export async function coinOfferCharge(input: {
  guestId: string;
  source: string;
  refId: string;
  basePrice: number;
  type?: string;
  note?: string;
  itemKind?: string;
  itemId?: string;
}): Promise<{
  charged: number;
  discounted: number;
  transactionId: string | null;
  applied: boolean;
}> {
  const price = await coinOfferPrice(input.basePrice);
  const charged = price.finalPrice;
  const res = await applyCoins({
    guestId: input.guestId,
    source: input.source,
    refId: input.refId,
    amount: -charged,
    type: input.type ?? "purchase",
    note: input.note ?? "",
  });
  // Record an offer-audit row when the discount actually applied.
  if (price.offerActive) {
    await recordOfferPurchase({
      weeklyOfferId: price.weeklyOfferId!,
      guestId: input.guestId,
      itemKind: input.itemKind ?? input.source,
      itemId: input.itemId ?? "",
      basePrice: input.basePrice,
      discountPct: price.discountPct,
      discountAmount: price.discountAmount,
      finalPrice: charged,
      source: input.source,
      refId: input.refId,
    }).catch(() => {});
  }
  return {
    charged,
    discounted: price.discountAmount,
    transactionId: res?.transactionId ?? null,
    applied: res?.applied ?? true,
  };
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export async function recordOfferPurchase(input: {
  weeklyOfferId: string;
  guestId: string;
  itemKind: string;
  itemId: string;
  basePrice: number;
  discountPct: number;
  discountAmount: number;
  finalPrice: number;
  source: string;
  refId: string;
}): Promise<void> {
  await sdb().from("ustad_coin_offer_purchases").insert({
    weekly_offer_id: input.weeklyOfferId,
    guest_id: input.guestId,
    item_kind: input.itemKind,
    item_id: input.itemId,
    base_price: input.basePrice,
    discount_pct: input.discountPct,
    discount_amount: input.discountAmount,
    final_price: input.finalPrice,
    source: input.source,
    ref_id: input.refId,
  });
}

/* ------------------------------------------------------------------ */
/* Notification hook (existing, per-guest system)                      */
/* ------------------------------------------------------------------ */

/**
 * Fire idempotent offer notifications to ONE guest when they surface the offer
 * (e.g. open the shop). Keyed on the weekly offer id so it never duplicates.
 * "live" and "coming soon" both supported; ended offers send nothing.
 */
export async function offerNotificationsForGuest(guestId: string): Promise<void> {
  const now = new Date();
  const off = await offerForCycle(currentCycle(now)).catch(() => null);
  if (!off) return;

  if (isOfferLive(off, now)) {
    await notifyGuest(
      guestId,
      "offer_live",
      `offer-live:${off.weeklyOfferId}`,
      { discountPct: off.discountPct },
      {
        referenceType: "ustad_coin_offer",
        referenceId: off.weeklyOfferId,
        metadata: {
          weeklyOfferId: off.weeklyOfferId,
          discountPct: off.discountPct,
          endIso: off.endIso,
          startIso: off.startIso,
        },
      },
    ).catch(() => null);
    return;
  }
  if (isOfferUpcoming(off, now)) {
    await notifyGuest(
      guestId,
      "offer_coming_soon",
      `offer-soon:${off.weeklyOfferId}`,
      { discountPct: off.discountPct },
      {
        referenceType: "ustad_coin_offer",
        referenceId: off.weeklyOfferId,
        metadata: {
          weeklyOfferId: off.weeklyOfferId,
          discountPct: off.discountPct,
          startIso: off.startIso,
          endIso: off.endIso,
        },
      },
    ).catch(() => null);
  }
}

export {
  previousCycle,
  currentCycle,
  isOfferLive,
  isOfferUpcoming,
  offerFinalPrice,
  discountAmount,
};
export type { RankCycle };
export type { WeeklyOffer };
