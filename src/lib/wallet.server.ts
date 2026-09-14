/**
 * PART 7 — the ONE authoritative USTAD Coin wallet + shop server module.
 *
 * This EXTENDS the existing coin system. It does not replace or duplicate it:
 *   * `ustad_coin_ledger` (Part 1) remains the append-only record of every
 *     coin movement; every engine keeps writing to it,
 *   * `ustad_wallets` is a permanent aggregate updated inside the SAME database
 *     transaction as the ledger row, via the `ustad_coin_apply` SQL function,
 *   * guest identity is the EXISTING guest system (`guest.server.ts`).
 *
 * The browser has no authority here. It cannot set, add or remove coins, and
 * it cannot supply a price — prices are read from the server catalogue.
 */
import { requireGuest, db } from "./guest.server";
import { notifyGuest } from "./notification.server";
import { activeOffer, priceFromOffer, coinOfferPrice } from "./coin-offer.server";
import {
  formatCoins,
  isValidCoinAmount,
  itemIsSellable,
  sourceLabel,
  SHOP_CATEGORIES,
  type CoinTransactionView,
  type WalletView,
} from "./wallet-spec";

type Row = Record<string, unknown>;
// The Part 7 tables are newer than the generated Supabase types.
/* eslint-disable @typescript-eslint/no-explicit-any */
const sdb = () => db() as any;

/* ------------------------------------------------------------------ */
/* Wallet reads                                                        */
/* ------------------------------------------------------------------ */

/**
 * The authoritative balance, straight from the database. Creating the wallet
 * on first read is safe: `unique (guest_id)` guarantees one wallet per guest,
 * so concurrent first reads cannot produce a second wallet.
 */
export async function getWallet(guestId: string): Promise<WalletView> {
  const { data } = await sdb()
    .from("ustad_wallets")
    .select("guest_id,current_balance,lifetime_earned,lifetime_spent")
    .eq("guest_id", guestId)
    .maybeSingle();

  if (data) {
    const row = data as Row;
    return {
      guestId,
      balance: Number(row["current_balance"] ?? 0),
      lifetimeEarned: Number(row["lifetime_earned"] ?? 0),
      lifetimeSpent: Number(row["lifetime_spent"] ?? 0),
    };
  }

  // No wallet yet (a brand-new guest). Create it once, from the ledger if the
  // guest somehow already has history, so no existing coin is ever lost.
  const { data: ledger } = await sdb()
    .from("ustad_coin_ledger")
    .select("coins")
    .eq("guest_id", guestId)
    .eq("status", "completed");
  const rows = (ledger as Row[] | null) ?? [];
  const earned = rows.reduce((n, r) => n + Math.max(Number(r["coins"] ?? 0), 0), 0);
  const spent = rows.reduce((n, r) => n + Math.max(-Number(r["coins"] ?? 0), 0), 0);
  const balance = Math.max(earned - spent, 0);

  await sdb().from("ustad_wallets").upsert(
    {
      guest_id: guestId,
      current_balance: balance,
      lifetime_earned: earned,
      lifetime_spent: spent,
    },
    { onConflict: "guest_id", ignoreDuplicates: true },
  );

  return { guestId, balance, lifetimeEarned: earned, lifetimeSpent: spent };
}

/** Balance only — the hot path used by game engines. */
export async function balanceOf(guestId: string): Promise<number> {
  return (await getWallet(guestId)).balance;
}

/* ------------------------------------------------------------------ */
/* The single write path for coins                                     */
/* ------------------------------------------------------------------ */

export type ApplyResult = {
  transactionId: string;
  balanceBefore: number;
  balanceAfter: number;
  /** false when this exact (source, refId) had already been applied. */
  applied: boolean;
};

/**
 * Move coins. THE ONLY WAY coins ever change.
 *
 * `refId` makes the movement idempotent: replaying the same reward or the same
 * purchase returns the original transaction and moves nothing. A refresh, a
 * double click, a network retry and a duplicated request are therefore all
 * safe by construction.
 *
 * The ledger row and the wallet update happen inside ONE database transaction
 * (`ustad_coin_apply`), so a balance can never drift from its history and a
 * spend can never leave the wallet negative.
 */
export async function applyCoins(input: {
  guestId: string;
  source: string;
  refId: string;
  amount: number;
  type?: string;
  note?: string;
}): Promise<ApplyResult> {
  if (!isValidCoinAmount(input.amount)) {
    throw new Error("Invalid coin amount.");
  }
  const { data, error } = await sdb().rpc("ustad_coin_apply", {
    p_guest_id: input.guestId,
    p_source: input.source,
    p_ref_id: input.refId,
    p_amount: input.amount,
    p_type: input.type ?? "general",
    p_note: input.note ?? "",
  });
  if (error) {
    if (String(error.message ?? "").includes("INSUFFICIENT_COINS")) {
      throw new Error("You do not have enough USTAD Coins.");
    }
    throw new Error(error.message);
  }
  const row = (Array.isArray(data) ? data[0] : data) as Row;
  const result: ApplyResult = {
    transactionId: String(row["transaction_id"]),
    balanceBefore: Number(row["balance_before"] ?? 0),
    balanceAfter: Number(row["balance_after"] ?? 0),
    applied: row["applied"] === true,
  };

  /*
   * Part 9 (spec §12, §13): every real coin movement raises a notification.
   *
   * This sits at the single chokepoint every credit and debit already passes
   * through, so the amount can only ever be the one the ledger actually
   * recorded — it is never passed in from a caller or a client.
   *
   * `applied` is false for a replayed credit (the ledger is replay-safe), and
   * in that case no second notification is raised. The transaction id is also
   * the dedupe key, giving a second, independent duplicate guard.
   */
  if (result.applied) {
    const credit = input.amount > 0;
    // Shop spending gets its own richer "Item Unlocked" notification in
    // buyItem(), so it is not duplicated as a generic "Coins Spent".
    if (input.source !== "shop") {
      await notifyGuest(
        input.guestId,
        credit ? "coins_received" : "coins_spent",
        `coin:${result.transactionId}`,
        {
          amount: Math.abs(input.amount),
          source: coinSourceLabel(input.source, input.note),
          purpose: coinSourceLabel(input.source, input.note),
        },
        {
          referenceType: "ustad_coin_ledger",
          referenceId: result.transactionId,
          metadata: {
            source: input.source,
            amount: input.amount,
            balanceAfter: result.balanceAfter,
          },
        },
      );
    }
  }

  return result;
}

/** Human label for a ledger source, used as the notification's Source line. */
function coinSourceLabel(source: string, note?: string): string {
  const known: Record<string, string> = {
    crorepati: "Crorepati Reward",
    crorepati_entry: "Crorepati Entry",
    mega: "Mega Tournament",
    mega_pass: "Mega Pass",
    master_event: "Event Reward",
    trophy: "Trophy Reward",
    certificate: "Certificate",
    shop: "USTAD Shop",
    admin: "USTAD AI",
  };
  return known[source] ?? note ?? "USTAD AI";
}

/* ------------------------------------------------------------------ */
/* Coin history                                                        */
/* ------------------------------------------------------------------ */

export async function coinHistory(guestId: string, limit = 100): Promise<CoinTransactionView[]> {
  const { data } = await sdb()
    .from("ustad_coin_ledger")
    .select("id,coins,direction,tx_type,source,ref_id,note,balance_after,created_at,status")
    .eq("guest_id", guestId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));

  return ((data as Row[] | null) ?? []).map((r) => ({
    id: String(r["id"]),
    amount: Number(r["coins"] ?? 0),
    direction: Number(r["coins"] ?? 0) < 0 ? "SPEND" : "EARN",
    type: String(r["tx_type"] ?? "general"),
    source: String(r["source"] ?? ""),
    refId: String(r["ref_id"] ?? ""),
    note: sourceLabel(String(r["source"] ?? ""), String(r["note"] ?? "")),
    balanceAfter:
      r["balance_after"] === null || r["balance_after"] === undefined
        ? null
        : Number(r["balance_after"]),
    createdAt: String(r["created_at"]),
  }));
}

/* ------------------------------------------------------------------ */
/* Shop                                                                */
/* ------------------------------------------------------------------ */

export type ShopItemView = {
  itemId: string;
  name: string;
  category: string;
  price: number;
  basePrice: number;
  discountPct: number;
  offerActive: boolean;
  priceLabel: string;
  description: string;
  assetReference: string;
  availability: string;
  ownershipType: string;
  owned: boolean;
  affordable: boolean;
};

export type ShopView = {
  wallet: WalletView;
  balanceLabel: string;
  categories: Array<{ id: string; label: string; blurb: string; items: ShopItemView[] }>;
};

/** The catalogue with this guest's ownership and affordability applied. */
export async function getShop(token: unknown): Promise<ShopView> {
  const guestId = await requireGuest(token);
  const wallet = await getWallet(guestId);
  const liveOffer = await activeOffer().catch(() => null);

  const { data: itemData } = await sdb()
    .from("ustad_shop_items")
    .select("*")
    .eq("status", "active")
    .order("sort_order", { ascending: true });
  const items = ((itemData as Row[] | null) ?? []).filter((i) =>
    itemIsSellable({
      category: String(i["category"]),
      asset_reference: String(i["asset_reference"] ?? ""),
    }),
  );

  const { data: ownedData } = await sdb()
    .from("ustad_purchases")
    .select("item_id")
    .eq("guest_id", guestId)
    .eq("ownership_status", "owned");
  const owned = new Set(((ownedData as Row[] | null) ?? []).map((p) => String(p["item_id"])));

  const categories = SHOP_CATEGORIES.map((c) => ({
    id: c.id as string,
    label: c.label as string,
    blurb: c.blurb as string,
    items: items
      .filter((i) => String(i["category"]) === c.id)
      .map((i) => {
        const basePrice = Number(i["price_coins"] ?? 0);
        const offerPrice = priceFromOffer(basePrice, liveOffer);
        const price = offerPrice.finalPrice;
        return {
          itemId: String(i["item_id"]),
          name: String(i["name"]),
          category: String(i["category"]),
          price,
          priceLabel: formatCoins(price),
          basePrice,
          discountPct: offerPrice.discountPct,
          offerActive: offerPrice.offerActive,
          description: String(i["description"] ?? ""),
          assetReference: String(i["asset_reference"] ?? ""),
          availability: String(i["availability"] ?? "permanent"),
          ownershipType: String(i["ownership_type"] ?? "permanent"),
          owned: owned.has(String(i["item_id"])),
          affordable: wallet.balance >= price,
        };
      }),
  })).filter((c) => c.items.length > 0);

  return { wallet, balanceLabel: formatCoins(wallet.balance), categories };
}

export type PurchaseResult = {
  ok: boolean;
  purchaseId: string;
  itemId: string;
  itemName: string;
  pricePaid: number;
  alreadyOwned: boolean;
  wallet: WalletView;
  message: string;
};

/**
 * Buy one item.
 *
 * The price is read from the SERVER catalogue — a client-supplied price is
 * ignored entirely (the function does not even accept one). Deduction, the
 * purchase record and ownership all happen in one atomic SQL transaction, so
 * "coins deducted but no item" and "item granted but no coins deducted" are
 * both impossible; a failure rolls the whole thing back and the balance is
 * left untouched.
 *
 * Buying the same item twice never double-charges: the unique
 * (guest_id, item_id) constraint means the second call returns the original
 * purchase.
 */
export async function buyItem(input: { token: unknown; itemId: string }): Promise<PurchaseResult> {
  const guestId = await requireGuest(input.token);
  const itemId = String(input.itemId ?? "").slice(0, 120);

  const { data: itemRow } = await sdb()
    .from("ustad_shop_items")
    .select("*")
    .eq("item_id", itemId)
    .maybeSingle();
  const item = (itemRow as Row) ?? null;
  if (!item) throw new Error("That item does not exist.");
  if (String(item["status"]) !== "active") throw new Error("That item is not available right now.");
  if (!itemIsSellable({ category: String(item["category"]) })) {
    throw new Error("That item cannot be sold.");
  }

  // A live Global Coin Offer discounts the item — the server computes the real
  // discounted price from the catalogue base and hands it to the atomic RPC,
  // which is the only thing allowed to charge coins and grant ownership. The
  // client still never supplies a price (coinOfferPrice keeps its authority).
  const offerPrice = await coinOfferPrice(Number(item["price_coins"]));
  const rpcArgs: Record<string, unknown> = {
    p_guest_id: guestId,
    p_item_id: itemId,
  };
  if (offerPrice.offerActive) {
    rpcArgs["p_final_price"] = offerPrice.finalPrice;
    rpcArgs["p_offer_weekly_id"] = offerPrice.weeklyOfferId;
    rpcArgs["p_discount_pct"] = offerPrice.discountPct;
    rpcArgs["p_offer_base_price"] = offerPrice.basePrice;
  }
  const { data, error } = await sdb().rpc("ustad_shop_buy", rpcArgs);
  if (error) {
    const msg = String(error.message ?? "");
    if (msg.includes("INSUFFICIENT_COINS")) {
      const wallet = await getWallet(guestId);
      const short = offerPrice.finalPrice - wallet.balance;
      throw new Error(`Not enough USTAD Coins — you need ${formatCoins(short)} more.`);
    }
    throw new Error(msg);
  }

  const row = (Array.isArray(data) ? data[0] : data) as Row;
  const alreadyOwned = row["already_owned"] === true;
  const wallet = await getWallet(guestId);

  if (!alreadyOwned) {
    // Part 9: notify ONLY after the coin deduction and the ownership record
    // both succeeded — a failed purchase raises no success notification
    // (spec §15). The purchase id is the idempotency key, so a double-click
    // or a retried request cannot produce two notifications (spec §38).
    const purchaseId = String(row["purchase_id"]);
    const pricePaid = Number(row["price_paid"] ?? 0);
    const isMegaPass = /mega.*pass/i.test(String(item["name"])) || itemId === "mega_pass";

    await notifyGuest(
      guestId,
      isMegaPass ? "mega_pass" : "shop_purchase",
      `purchase:${purchaseId}`,
      { itemName: String(item["name"]), amount: pricePaid },
      {
        referenceType: "ustad_purchase",
        referenceId: purchaseId,
        metadata: { itemId, price: pricePaid, balanceAfter: wallet.balance },
      },
    );

    // A purchased item that grants a capability is also a feature unlock
    // (spec §16), reported from the real ownership record.
    if (String(item["category"]) === "feature_unlocks") {
      await notifyGuest(
        guestId,
        "feature_unlock",
        `feature:${purchaseId}`,
        { featureName: String(item["name"]) },
        {
          referenceType: "ustad_purchase",
          referenceId: purchaseId,
          metadata: { itemId },
        },
      );
    }
  }

  return {
    ok: true,
    purchaseId: String(row["purchase_id"]),
    itemId,
    itemName: String(item["name"]),
    pricePaid: Number(row["price_paid"] ?? 0),
    alreadyOwned,
    wallet,
    message: alreadyOwned
      ? "You already own this item — you were not charged again."
      : `${String(item["name"])} is yours.`,
  };
}

/** Everything this guest owns — their permanent inventory. */
export async function getInventory(token: unknown) {
  const guestId = await requireGuest(token);
  const { data } = await sdb()
    .from("ustad_purchases")
    .select("purchase_id,item_id,price_paid,purchased_at,ownership_status")
    .eq("guest_id", guestId)
    .eq("ownership_status", "owned")
    .order("purchased_at", { ascending: false });

  const purchases = (data as Row[] | null) ?? [];
  if (purchases.length === 0) return { items: [], totalSpent: 0 };

  const { data: itemData } = await sdb()
    .from("ustad_shop_items")
    .select("item_id,name,category,asset_reference")
    .in(
      "item_id",
      purchases.map((p) => String(p["item_id"])),
    );
  const byId = new Map(((itemData as Row[] | null) ?? []).map((i) => [String(i["item_id"]), i]));

  return {
    items: purchases.map((p) => {
      const item = byId.get(String(p["item_id"]));
      return {
        purchaseId: String(p["purchase_id"]),
        itemId: String(p["item_id"]),
        name: String(item?.["name"] ?? p["item_id"]),
        category: String(item?.["category"] ?? ""),
        assetReference: String(item?.["asset_reference"] ?? ""),
        pricePaid: Number(p["price_paid"] ?? 0),
        purchasedAt: String(p["purchased_at"]),
      };
    }),
    totalSpent: purchases.reduce((n, p) => n + Number(p["price_paid"] ?? 0), 0),
  };
}

/** Wallet + history for the Profile tab, in one call. */
export async function getWalletPanel(token: unknown) {
  const guestId = await requireGuest(token);
  const wallet = await getWallet(guestId);
  const history = await coinHistory(guestId, 100);
  const inventory = await getInventory(token);
  return {
    wallet,
    balanceLabel: formatCoins(wallet.balance),
    earnedLabel: formatCoins(wallet.lifetimeEarned),
    spentLabel: formatCoins(wallet.lifetimeSpent),
    history,
    ownedCount: inventory.items.length,
  };
}

/* ------------------------------------------------------------------ */
/* Shared helper                                                       */
/* ------------------------------------------------------------------ */

/** Reuses the EXISTING in-app notification system (reminders feed). */
async function notify(guestId: string, title: string, body: string, payload: Row) {
  try {
    await sdb().from("reminders").insert({
      guest_id: guestId,
      title,
      note: body,
      kind: "notification",
      due_at: new Date().toISOString(),
      payload,
    });
  } catch {
    /* best-effort: a notification failure must never fail a purchase */
  }
}

/* ------------------------------------------------------------------ */
/* AI context                                                          */
/* ------------------------------------------------------------------ */

/**
 * Authoritative wallet facts for USTAD AI (Part 7 §33).
 *
 * The assistant must answer coin questions from REAL records, never invent a
 * number. This returns the stored balance, lifetime totals, the fixed prices
 * that are configuration (not opinion), and what the guest actually owns.
 */
export async function walletContext(guestId: string): Promise<string> {
  try {
    const wallet = await getWallet(guestId);

    const { data: purchaseData } = await sdb()
      .from("ustad_purchases")
      .select("item_id,price_paid")
      .eq("guest_id", guestId)
      .eq("ownership_status", "owned");
    const purchases = (purchaseData as Row[] | null) ?? [];

    let ownedLine = "The user owns no shop items yet.";
    if (purchases.length > 0) {
      const { data: itemData } = await sdb()
        .from("ustad_shop_items")
        .select("item_id,name")
        .in(
          "item_id",
          purchases.map((p) => String(p["item_id"])),
        );
      const names = new Map(
        ((itemData as Row[] | null) ?? []).map((i) => [String(i["item_id"]), String(i["name"])]),
      );
      ownedLine = `The user owns ${purchases.length} shop item(s): ${purchases
        .map((p) => names.get(String(p["item_id"])) ?? String(p["item_id"]))
        .join(", ")}.`;
    }

    // Fixed, server-side prices so the assistant quotes them exactly.
    const { data: megaRow } = await sdb()
      .from("mega_events")
      .select("pass_cost")
      .limit(1)
      .maybeSingle();
    const megaPass = Number((megaRow as Row | null)?.["pass_cost"] ?? 0);
    const { data: topRung } = await sdb()
      .from("crorepati_rewards")
      .select("coins")
      .eq("question_number", 20)
      .limit(1)
      .maybeSingle();
    const q20 = Number((topRung as Row | null)?.["coins"] ?? 0);

    return [
      `USTAD Coin wallet (authoritative, from the database): current balance ${wallet.balance}`,
      `USTAD Coins, lifetime earned ${wallet.lifetimeEarned}, lifetime spent ${wallet.lifetimeSpent}.`,
      ownedLine,
      megaPass ? `The Mega Tournament weekly pass costs ${megaPass} USTAD Coins.` : "",
      q20 ? `Clearing all 20 Crorepati questions pays ${q20} USTAD Coins.` : "",
      `USTAD Coins are virtual in-app coins only — never real money, rupees or dollars.`,
      `Use these exact numbers when asked about coins, spending or purchases; never estimate or invent a balance.`,
    ]
      .filter(Boolean)
      .join(" ");
  } catch {
    return "";
  }
}
