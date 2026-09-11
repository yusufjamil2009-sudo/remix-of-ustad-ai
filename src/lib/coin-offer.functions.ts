/**
 * GLOBAL COIN OFFER — server function boundary (read-only + notify).
 *
 * The client may: read the CURRENT offer state (banner-safe public fields only)
 * and request the per-guest "live/coming soon" notification. It may NEVER
 * submit a discount, a price, a duration, a time window or an offer id — all of
 * those are derived server-side.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireGuest } from "./guest.server";
import { guestLocale } from "./notification.server";
import * as offer from "./coin-offer.server";

/**
 * Banner state for the current weekly cycle, owner-agnostic. When live it also
 * fires the idempotent per-guest "offer live" notification.
 */
export const coinOfferBannerFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => {
    const guestId = await requireGuest(d.token);
    const locale = await guestLocale(guestId);
    const now = new Date();
    const off = await offer.offerForCycle(offer.currentCycle(now)).catch(() => null);
    if (!off) return { available: false, reason: "no_offer", language: locale.language };

    const live = offer.isOfferLive(off, now);
    // The server decides WHICH notification fits this offer right now — live or
    // "coming soon" — and both are idempotent per guest per offer id.
    await offer.offerNotificationsForGuest(guestId).catch(() => {});

    return {
      available: true,
      live,
      upcoming: offer.isOfferUpcoming(off, now),
      weeklyOfferId: off.weeklyOfferId,
      discountPct: off.discountPct,
      startIso: off.startIso,
      endIso: off.endIso,
      cycle: { start: off.cycle.start, end: off.cycle.end },
      language: locale.language,
    };
  });
