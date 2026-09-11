import test from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_ITEM_EFFECTS,
  MAX_SINGLE_TRANSACTION,
  SHOP_CATEGORIES,
  evaluatePurchase,
  formatCoins,
  formatCoinsShort,
  isValidCoinAmount,
  itemIsSellable,
  sourceLabel,
} from "../src/lib/wallet-spec";

test("coins are formatted in Indian digit grouping and always labelled USTAD Coins", () => {
  assert.equal(formatCoins(245000), "2,45,000 USTAD Coins");
  assert.equal(formatCoins(100000000), "10,00,00,000 USTAD Coins");
  assert.equal(formatCoinsShort(245000), "2,45,000");
});

test("coin labels never imply real money", () => {
  for (const n of [0, 1, 25000, 40000000, 100000000]) {
    const s = formatCoins(n);
    assert.ok(!/₹|\$|INR|USD|rupee|dollar/i.test(s), `"${s}" must not imply real currency`);
  }
});

test("a purchase is allowed only with enough coins, an active item and no prior ownership", () => {
  assert.equal(
    evaluatePurchase({ balance: 100000, price: 25000, alreadyOwned: false, itemActive: true })
      .allowed,
    true,
  );
  assert.equal(
    evaluatePurchase({ balance: 24999, price: 25000, alreadyOwned: false, itemActive: true })
      .allowed,
    false,
  );
  assert.equal(
    evaluatePurchase({ balance: 25000, price: 25000, alreadyOwned: false, itemActive: true })
      .allowed,
    true,
  );
  assert.equal(
    evaluatePurchase({ balance: 999999, price: 25000, alreadyOwned: true, itemActive: true })
      .allowed,
    false,
  );
  assert.equal(
    evaluatePurchase({ balance: 999999, price: 25000, alreadyOwned: false, itemActive: false })
      .allowed,
    false,
  );
});

test("the shortfall message states exactly how many more coins are needed", () => {
  const r = evaluatePurchase({
    balance: 10000,
    price: 25000,
    alreadyOwned: false,
    itemActive: true,
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /15,000 USTAD Coins/);
});

test("a non-positive or non-finite price can never be purchased", () => {
  for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      evaluatePurchase({ balance: 1e12, price, alreadyOwned: false, itemActive: true }).allowed,
      false,
      `price ${price} must be rejected`,
    );
  }
});

test("coin amounts reject the classic tampering shapes", () => {
  assert.equal(isValidCoinAmount(10000), true);
  assert.equal(isValidCoinAmount(-25000), true);
  assert.equal(isValidCoinAmount(0), false, "zero is not a transaction");
  assert.equal(isValidCoinAmount(1.5), false, "fractional coins do not exist");
  assert.equal(isValidCoinAmount(Number.NaN), false);
  assert.equal(isValidCoinAmount(Number.POSITIVE_INFINITY), false);
  assert.equal(
    isValidCoinAmount(MAX_SINGLE_TRANSACTION + 1),
    false,
    "absurd magnitudes are rejected",
  );
  assert.equal(isValidCoinAmount("10000" as unknown), false, "a string is not an amount");
  assert.equal(isValidCoinAmount(null as unknown), false);
});

test("only presentation and customization categories are sellable", () => {
  for (const c of SHOP_CATEGORIES) {
    assert.equal(itemIsSellable({ category: c.id }), true, `${c.id} should be sellable`);
  }
  assert.equal(itemIsSellable({ category: "answers" }), false);
  assert.equal(itemIsSellable({ category: "trophies" }), false);
});

test("nothing that would break tournament fairness can be sold", () => {
  for (const effect of FORBIDDEN_ITEM_EFFECTS) {
    assert.equal(
      itemIsSellable({ category: "badges", grants_effect: effect }),
      false,
      `an item granting "${effect}" must never be sellable`,
    );
  }
  assert.equal(itemIsSellable({ category: "badges", grants_effect: "cosmetic_only" }), true);
});

test("coin history labels fall back to a readable source name", () => {
  assert.equal(sourceLabel("mega_pass", ""), "Mega Tournament pass");
  assert.equal(sourceLabel("crorepati", ""), "Kon Banega Crorepati");
  assert.equal(sourceLabel("shop", ""), "USTAD Shop");
  assert.equal(sourceLabel("crorepati", "Q20 win"), "Q20 win", "an explicit note wins");
});
