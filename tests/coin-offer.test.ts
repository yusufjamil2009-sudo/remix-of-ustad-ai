import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFER_MIN_DISCOUNT_PCT,
  OFFER_MAX_DISCOUNT_PCT,
  OFFER_MIN_DURATION_MINUTES,
  OFFER_MAX_DURATION_MINUTES,
  discountAmount,
  offerFinalPrice,
  validDiscountPct,
  validDurationMinutes,
  validateSchedule,
  generateWeeklyOffer,
  isOfferLive,
  minuteLabel,
  offerForNow,
  isValidOffer,
} from "../src/lib/coin-offer-spec";
import { currentCycle, previousCycle } from "../src/lib/rank-spec";

test("discount and duration bounds are enforced", () => {
  assert.equal(OFFER_MIN_DISCOUNT_PCT, 10);
  assert.equal(OFFER_MAX_DISCOUNT_PCT, 70);
  assert.equal(OFFER_MIN_DURATION_MINUTES, 10);
  assert.equal(OFFER_MAX_DURATION_MINUTES, 180);
  assert.equal(validDiscountPct(50), true);
  assert.equal(validDiscountPct(9), false);
  assert.equal(validDiscountPct(71), false);
  assert.equal(validDurationMinutes(10), true);
  assert.equal(validDurationMinutes(180), true);
  assert.equal(validDurationMinutes(9), false);
  assert.equal(validDurationMinutes(181), false);
});

test("real discount math", () => {
  assert.equal(discountAmount(1000, 20), 200);
  assert.equal(offerFinalPrice(1000, 20), 800);
  // 50% OFF on 10,00,00,000 → deduct 5,00,00,000, pay 5,00,00,000.
  assert.equal(discountAmount(1000000000, 50), 500000000);
  assert.equal(offerFinalPrice(1000000000, 50), 500000000);
  // 30% OFF on 4,00,00,000 → 2,80,00,000.
  assert.equal(discountAmount(40000000, 30), 12000000);
  assert.equal(offerFinalPrice(40000000, 30), 28000000);
  // 40% OFF on 10,00,00,000 → 6,00,00,000.
  assert.equal(offerFinalPrice(100000000, 40), 60000000);
});

test("only a valid enabled offer can become active", () => {
  const live = offerForNow("2026-09-14T05:00:00.000Z");
  assert.equal(isValidOffer(live), true);
  assert.equal(isValidOffer({ ...live, enabled: false }), false);
  assert.equal(isValidOffer({ ...live, status: "expired" }), false);
  assert.equal(isValidOffer({ ...live, discountPct: 0 }), false);
  assert.equal(isValidOffer({ ...live, applicable: false }), false);
});

test("no fake original price inflation — discount always from the real base", () => {
  const base = 100000000;
  // Base 10 crore at 50% is billed exactly half — never the full amount.
  assert.equal(offerFinalPrice(base, 50), base - base * 0.5);
  // A 50% discount must never be billed at the (higher) undiscounted base.
  assert.equal(offerFinalPrice(base, 50) < base, true);
  // Raising the "base" to double then taking 50% merely returns the real base —
  // i.e. the catalogue base is never itself inflated to fake a discount.
  assert.equal(offerFinalPrice(base * 2, 50), base);
});

test("schedule validation rejects out-of-window or out-of-duration windows", () => {
  assert.equal(
    validateSchedule({ discountPct: 20, durationMinutes: 60, startMinute: 8 * 60 }).ok,
    true,
  );
  assert.equal(
    validateSchedule({ discountPct: 20, durationMinutes: 60, startMinute: 6 * 60 }).ok,
    false,
  );
  assert.equal(
    validateSchedule({ discountPct: 20, durationMinutes: 60, startMinute: 19 * 60 + 30 }).ok,
    false,
  );
  assert.equal(
    validateSchedule({ discountPct: 20, durationMinutes: 5, startMinute: 8 * 60 }).ok,
    false,
  );
  assert.equal(
    validateSchedule({ discountPct: 20, durationMinutes: 240, startMinute: 8 * 60 }).ok,
    false,
  );
  assert.equal(
    validateSchedule({ discountPct: 5, durationMinutes: 60, startMinute: 8 * 60 }).ok,
    false,
  );
});

test("a generated weekly offer always honours every global rule", () => {
  let cycle = currentCycle();
  for (let i = 0; i < 300; i++) {
    const off = generateWeeklyOffer(cycle);
    assert.ok(off.discountPct >= 10 && off.discountPct <= 70, `discount ${off.discountPct}`);
    assert.ok(
      off.durationMinutes >= 10 && off.durationMinutes <= 180,
      `dur ${off.durationMinutes}`,
    );
    const start = Date.parse(off.startIso);
    const end = Date.parse(off.endIso);
    assert.equal(end - start, off.durationMinutes * 60000, "duration matches window");
    assert.ok(off.weeklyOfferId.startsWith("offer:"));
    cycle = previousCycle(cycle);
  }
});

test("one offer per cycle; different weeks differ; same week stable", () => {
  const a = currentCycle();
  const b = previousCycle(a);
  const oa = generateWeeklyOffer(a);
  const ob = generateWeeklyOffer(b);
  assert.notEqual(oa.weeklyOfferId, ob.weeklyOfferId);
  assert.equal(generateWeeklyOffer(a).weeklyOfferId, oa.weeklyOfferId);
});

test("offer is live only inside its window", () => {
  const off = offerForNow();
  const start = Date.parse(off.startIso);
  assert.equal(isOfferLive(off, start - 1), false);
  assert.equal(isOfferLive(off, start), true);
  const mid = start + (off.durationMinutes / 2) * 60000;
  assert.equal(isOfferLive(off, mid), true);
  assert.equal(isOfferLive(off, Date.parse(off.endIso)), false);
});

test("minute label formats India clock labels", () => {
  assert.equal(minuteLabel(7 * 60), "07:00 AM");
  assert.equal(minuteLabel(20 * 60), "08:00 PM");
  assert.equal(minuteLabel(12 * 60), "12:00 PM");
  assert.equal(minuteLabel(14 * 60 + 5), "02:05 PM");
});

test("offerForNow uses the Sunday-to-Sunday IST rank cycle", () => {
  const off = offerForNow("2026-09-06T12:00:00Z"); // a Sunday UTC mid-day → next IST week
  assert.equal(off.cycle.start >= "2026-09-06", true);
});
