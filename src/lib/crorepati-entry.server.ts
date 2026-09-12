/**
 * KON BANEGA CROREPATI — entry, free-attempt & recovery engine (Part 3).
 *
 * Reuses, never rebuilds:
 *   • identity      → `guest.server.ts` (requireGuest + service-role db)
 *   • coins         → the Part 1 `ustad_coin_ledger` (no second wallet)
 *   • events        → the Part 1 `crorepati_events` row + new occurrences
 *   • notifications → the existing `reminders` feed
 *   • profile       → the existing profile page reads `entryProfileStats()`
 *   • gameplay      → untouched; Part 1 still owns questions/timers/rewards
 *
 * Part 3 answers exactly one question: WHO may start a game, and with which
 * entry. Everything is decided here; the browser never holds the balance.
 *
 * USTAD Coins are virtual in-app currency: no real money, no payment provider.
 */
import { requireGuest, db } from "./guest.server";
import { notifyGuest } from "./notification.server";
import { applyCoins, balanceOf } from "./wallet.server";
import { coinOfferPrice, recordOfferPurchase } from "./coin-offer.server";
import {
  clampFreeEntries,
  evaluateEligibility,
  isMissedOccurrence,
  occurrencesBetween,
  recoveredBalance,
  shouldRecover,
  type EntryConfig,
  type EntryStateView,
  type EntryType,
} from "./crorepati-entry-spec";
import { CROREPATI_EVENT_CODE } from "./crorepati-spec";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sdb = () => db() as any;
type Row = Record<string, any>;

/* ------------------------------------------------------------------ */
/* Event + configuration (Part 1 row, additive columns)                */
/* ------------------------------------------------------------------ */

async function getEventRow(): Promise<Row> {
  const client = sdb();
  const { data } = await client
    .from("crorepati_events")
    .select("*")
    .eq("code", CROREPATI_EVENT_CODE)
    .maybeSingle();
  if (data) return data;
  const { data: created, error } = await client
    .from("crorepati_events")
    .insert({ code: CROREPATI_EVENT_CODE, title: "Kon Banega Crorepati" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return created;
}

function configOf(event: Row): EntryConfig {
  return {
    eventId: String(event["id"]),
    freeEntriesGrant: Number(event["free_entries_grant"] ?? 3),
    maxFreeEntries: Number(event["max_free_entries"] ?? 3),
    missedThreshold: Number(event["missed_threshold"] ?? 10),
    scheduleWeekdays: (event["schedule_weekdays"] as number[]) ?? [0, 2, 5],
    timezone: String(event["entry_timezone"] ?? "Asia/Kolkata"),
    paidEntryEnabled: Boolean(event["paid_entry_enabled"] ?? true),
    paidEntryCoinCost: Number(event["paid_entry_coin_cost"] ?? 100000),
  };
}

/* ------------------------------------------------------------------ */
/* Shared Part 1 coin ledger                                           */
/* ------------------------------------------------------------------ */

/**
 * The authoritative balance. Part 7 routes this through the ONE wallet module
 * so every engine reads the same permanent, database-backed number.
 */
async function coinBalance(guestId: string): Promise<number> {
  return balanceOf(guestId);
}

/**
 * Idempotent through the Part 7 wallet: a double charge is impossible because
 * (guest_id, source, ref_id) identifies the movement, and the deduction and
 * the permanent balance update happen in one database transaction.
 */
async function ledger(guestId: string, refId: string, coins: number, note: string) {
  if (!coins) return;
  await applyCoins({
    guestId,
    source: "crorepati_entry",
    refId,
    amount: coins,
    type: "crorepati_entry",
    note,
  });
}

/** Reuses the EXISTING in-app notification feed. */
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
    /* best effort — a notification failure never blocks a game */
  }
}

/* ------------------------------------------------------------------ */
/* Event occurrences (opening ≠ attempt)                               */
/* ------------------------------------------------------------------ */

/**
 * Materialise the scheduled occurrences of the configured window into the
 * database. The entry engine itself never hard-codes Sun/Tue/Fri; it just
 * reads `schedule_weekdays` from the existing event configuration.
 */
async function syncOccurrences(event: Row): Promise<void> {
  const cfg = configOf(event);
  const now = Date.now();
  const planned = occurrencesBetween({
    // A generous look-back so a long-absent guest's missed streak is complete.
    fromMs: now - 120 * 86_400_000,
    toMs: now + 7 * 86_400_000,
    weekdays: cfg.scheduleWeekdays,
    openHour: Number(event["open_hour"] ?? 6),
    openMinute: Number(event["open_minute"] ?? 0),
    windowMinutes: Number(event["window_minutes"] ?? 960),
    timezone: cfg.timezone,
  });
  if (!planned.length) return;

  await sdb()
    .from("crorepati_event_occurrences")
    .upsert(
      planned.map((o) => ({
        event_id: event["id"],
        opened_at: o.openedAt,
        closed_at: o.closedAt,
        status:
          Date.parse(o.closedAt) <= now
            ? "closed"
            : Date.parse(o.openedAt) <= now
              ? "open"
              : "scheduled",
      })),
      { onConflict: "event_id,opened_at", ignoreDuplicates: true },
    );

  // Keep statuses current without ever touching a cancelled occurrence.
  await sdb()
    .from("crorepati_event_occurrences")
    .update({ status: "closed" })
    .eq("event_id", event["id"])
    .lte("closed_at", new Date(now).toISOString())
    .in("status", ["scheduled", "open"]);
  await sdb()
    .from("crorepati_event_occurrences")
    .update({ status: "open" })
    .eq("event_id", event["id"])
    .lte("opened_at", new Date(now).toISOString())
    .gt("closed_at", new Date(now).toISOString())
    .eq("status", "scheduled");
}

/** The occurrence that is open right now, if any. */
async function currentOccurrence(event: Row): Promise<Row | null> {
  const now = new Date().toISOString();
  const { data } = await sdb()
    .from("crorepati_event_occurrences")
    .select("*")
    .eq("event_id", event["id"])
    .lte("opened_at", now)
    .gt("closed_at", now)
    .neq("status", "cancelled")
    .order("opened_at", { ascending: false })
    .limit(1);
  return (data ?? [])[0] ?? null;
}

async function nextOccurrence(event: Row): Promise<Row | null> {
  const now = new Date().toISOString();
  const { data } = await sdb()
    .from("crorepati_event_occurrences")
    .select("*")
    .eq("event_id", event["id"])
    .gt("opened_at", now)
    .neq("status", "cancelled")
    .order("opened_at", { ascending: true })
    .limit(1);
  return (data ?? [])[0] ?? null;
}

/** Wording shown everywhere the one-play-per-event-day rule applies. */
const ALREADY_PLAYED_REASON =
  "You have already played today's Kon Banega Crorepati. Every event day allows exactly one game — come back on the next event day.";

/** Has this guest already used up an attempt in this occurrence? */
async function hasPlayedOccurrence(guestId: string, occurrenceId: string): Promise<boolean> {
  const { data } = await sdb()
    .from("crorepati_entries")
    .select("id")
    .eq("guest_id", guestId)
    .eq("occurrence_id", occurrenceId)
    .eq("status", "consumed")
    .limit(1);
  return Boolean((data ?? []).length);
}

/* ------------------------------------------------------------------ */
/* Entry state                                                         */
/* ------------------------------------------------------------------ */

async function ensureState(guestId: string, event: Row): Promise<Row> {
  const client = sdb();
  const { data } = await client
    .from("crorepati_entry_state")
    .select("*")
    .eq("guest_id", guestId)
    .maybeSingle();
  if (data) return data;

  const cfg = configOf(event);
  // First contact: grant the 3 free entries exactly once.
  const { data: created, error } = await client
    .from("crorepati_entry_state")
    .insert({
      guest_id: guestId,
      event_id: event["id"],
      free_entries: clampFreeEntries(cfg.freeEntriesGrant, cfg.maxFreeEntries),
    })
    .select()
    .single();
  if (error) {
    const { data: again } = await client
      .from("crorepati_entry_state")
      .select("*")
      .eq("guest_id", guestId)
      .maybeSingle();
    if (again) return again;
    throw new Error(error.message);
  }
  return created;
}

/**
 * Register the guest against every occurrence they were eligible for, then
 * fold every CLOSED, unplayed occurrence into the missed streak exactly once
 * (`counted` flag), applying automatic recovery when the threshold is reached.
 *
 * An event OPENING never costs a free entry — this function only ever adds to
 * the streak or restores entries.
 */
async function reconcileParticipation(guestId: string, event: Row, state: Row): Promise<Row> {
  const client = sdb();
  const cfg = configOf(event);

  const { data: occurrences } = await client
    .from("crorepati_event_occurrences")
    .select("*")
    .eq("event_id", event["id"])
    .neq("status", "cancelled")
    .order("opened_at", { ascending: true })
    .limit(300);

  const rows = (occurrences ?? []).filter(
    (o: Row) =>
      Date.parse(o["opened_at"]) >= Date.parse(state["updated_at"] ?? 0) - 200 * 86_400_000,
  );
  if (!rows.length) return state;

  // A guest is only eligible for occurrences that opened after they existed.
  const { data: guest } = await client
    .from("guests")
    .select("created_at")
    .eq("id", guestId)
    .maybeSingle();
  const guestSince = guest?.["created_at"] ? Date.parse(guest["created_at"]) : 0;

  await client.from("crorepati_participation").upsert(
    rows.map((o: Row) => ({
      occurrence_id: o["id"],
      guest_id: guestId,
      event_id: event["id"],
      eligible: Date.parse(o["opened_at"]) >= guestSince,
      opened_at: o["opened_at"],
      closed_at: o["closed_at"],
    })),
    { onConflict: "occurrence_id,guest_id", ignoreDuplicates: true },
  );

  // Only CLOSED + eligible + unplayed + not-yet-counted occurrences count.
  const { data: pending } = await client
    .from("crorepati_participation")
    .select("*")
    .eq("guest_id", guestId)
    .eq("counted", false)
    .eq("played", false)
    .eq("eligible", true)
    .lte("closed_at", new Date().toISOString())
    .order("closed_at", { ascending: true });

  const missed = (pending ?? []).filter((p: Row) =>
    isMissedOccurrence({
      eligible: Boolean(p["eligible"]),
      played: Boolean(p["played"]),
      status: "closed",
      closedAt: String(p["closed_at"]),
    }),
  );
  if (!missed.length) return state;

  let streak = Number(state["missed_streak"] ?? 0);
  let free = Number(state["free_entries"] ?? 0);
  let recoveries = Number(state["recovery_count"] ?? 0);
  let recovered = false;

  for (const p of missed) {
    streak += 1;
    if (shouldRecover(streak, cfg.missedThreshold)) {
      // Recovery SETS the balance (capped) — it never stacks to 5.
      free = recoveredBalance(free, cfg.freeEntriesGrant, cfg.maxFreeEntries);
      streak = 0;
      recoveries += 1;
      recovered = true;
    }
    await client
      .from("crorepati_participation")
      .update({ counted: true })
      .eq("occurrence_id", p["occurrence_id"])
      .eq("guest_id", guestId)
      .eq("counted", false);
  }

  const patch: Row = {
    missed_streak: streak,
    free_entries: clampFreeEntries(free, cfg.maxFreeEntries),
    recovery_count: recoveries,
    updated_at: new Date().toISOString(),
  };
  if (recovered) {
    patch["last_recovered_at"] = new Date().toISOString();
    patch["zero_notified"] = false;
  }

  const { data: updated } = await client
    .from("crorepati_entry_state")
    .update(patch)
    .eq("guest_id", guestId)
    .select()
    .maybeSingle();

  if (recovered) {
    await notifyGuest(
      guestId,
      "free_entry_restored",
      `freeentry:restored:${String(event["id"])}`,
      { count: Number(patch["free_entries"] ?? 0) },
      {
        referenceType: "crorepati_event",
        referenceId: String(event["id"]),
        metadata: {
          eventId: event["id"],
          freeEntries: patch["free_entries"],
          threshold: cfg.missedThreshold,
        },
      },
    );
  }
  return updated ?? { ...state, ...patch };
}

/** Full authoritative entry state for the UI (also used before every start). */
export async function getEntryState(token: unknown): Promise<EntryStateView> {
  const guestId = await requireGuest(token);
  const event = await getEventRow();
  await syncOccurrences(event);
  let state = await ensureState(guestId, event);
  state = await reconcileParticipation(guestId, event, state);

  const cfg = configOf(event);
  const open = await currentOccurrence(event);
  const next = open ? null : await nextOccurrence(event);
  const balance = await coinBalance(guestId);
  const playedToday = open ? await hasPlayedOccurrence(guestId, String(open["id"])) : false;

  const { data: history } = await sdb()
    .from("crorepati_entries")
    .select("*")
    .eq("guest_id", guestId)
    .order("created_at", { ascending: false })
    .limit(10);

  return {
    eventId: String(event["id"]),
    freeEntries: Number(state["free_entries"] ?? 0),
    freeEntriesUsed: Number(state["free_entries_used"] ?? 0),
    paidEntriesUsed: Number(state["paid_entries_used"] ?? 0),
    missedStreak: Number(state["missed_streak"] ?? 0),
    missedThreshold: cfg.missedThreshold,
    maxFreeEntries: cfg.maxFreeEntries,
    recoveryCount: Number(state["recovery_count"] ?? 0),
    lastPlayedAt: (state["last_played_at"] as string) ?? null,
    lastRecoveredAt: (state["last_recovered_at"] as string) ?? null,
    coinBalance: balance,
    eventOpen: Boolean(open),
    currentOccurrenceId: open ? String(open["id"]) : null,
    opensAt: open ? String(open["opened_at"]) : next ? String(next["opened_at"]) : null,
    closesAt: open ? String(open["closed_at"]) : next ? String(next["closed_at"]) : null,
    playedCurrentOccurrence: playedToday,
    eligibility: playedToday
      ? {
          canStart: false,
          nextEntryType: null,
          reason: ALREADY_PLAYED_REASON,
          cost: 0,
        }
      : evaluateEligibility({
          freeEntries: Number(state["free_entries"] ?? 0),
          coinBalance: balance,
          eventOpen: Boolean(open),
          config: cfg,
        }),

    config: cfg,
    history: (history ?? []).map((r: Row) => ({
      id: String(r["id"]),
      entryType: r["entry_type"] as EntryType,
      price: Number(r["price"] ?? 0),
      currency: String(r["currency"]),
      status: String(r["status"]),
      attemptId: (r["attempt_id"] as string) ?? null,
      createdAt: String(r["created_at"]),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Granting an entry                                                   */
/* ------------------------------------------------------------------ */

export type GrantedEntry = {
  entryId: string;
  entryType: EntryType;
  cost: number;
  reused: boolean;
};

/**
 * Grant exactly ONE entry for the guest, or throw.
 *
 * Concurrency: the balance is decremented with a conditional update that also
 * matches the value we read (`eq("free_entries", before)`), and the entry row
 * is protected by a partial unique index allowing a single 'granted' row per
 * guest. Two tabs clicking Play at the same time therefore produce exactly one
 * consumed entry, and the balance can never go negative.
 *
 * Idempotency: an unconsumed entry is REUSED rather than re-charged, so a
 * refresh or a retry never costs a second attempt.
 */
export async function grantEntry(input: {
  token: unknown;
  /** Optional client key that makes a retried request provably the same one. */
  idempotencyKey?: string;
}): Promise<GrantedEntry> {
  const guestId = await requireGuest(input.token);
  const event = await getEventRow();
  await syncOccurrences(event);
  let state = await ensureState(guestId, event);
  state = await reconcileParticipation(guestId, event, state);
  const cfg = configOf(event);
  const client = sdb();

  // Refresh / double-click: an already granted, unconsumed entry is reused.
  const { data: open } = await client
    .from("crorepati_entries")
    .select("*")
    .eq("guest_id", guestId)
    .eq("status", "granted")
    .maybeSingle();
  if (open) {
    return {
      entryId: String(open["id"]),
      entryType: open["entry_type"] as EntryType,
      cost: Number(open["price"] ?? 0),
      reused: true,
    };
  }

  const occurrence = await currentOccurrence(event);
  if (!occurrence)
    throw new Error("Kon Banega Crorepati is not open right now. Come back at the next event.");

  // ONE PLAY PER EVENT DAY: an already played (consumed) entry for this
  // occurrence blocks a second attempt until the next Crorepati day.
  if (await hasPlayedOccurrence(guestId, String(occurrence["id"])))
    throw new Error(ALREADY_PLAYED_REASON);

  const balance = await coinBalance(guestId);
  const free = Number(state["free_entries"] ?? 0);
  const verdict = evaluateEligibility({
    freeEntries: free,
    coinBalance: balance,
    eventOpen: true,
    config: cfg,
  });
  if (!verdict.canStart || !verdict.nextEntryType) throw new Error(verdict.reason);

  const key =
    input.idempotencyKey?.slice(0, 120) ||
    `${occurrence["id"]}:${verdict.nextEntryType}:${Date.now()}`;

  if (verdict.nextEntryType === "free") {
    // Conditional decrement — only succeeds if nobody else spent it first.
    const { data: spent } = await client
      .from("crorepati_entry_state")
      .update({
        free_entries: free - 1,
        free_entries_used: Number(state["free_entries_used"] ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("guest_id", guestId)
      .eq("free_entries", free)
      .gt("free_entries", 0)
      .select()
      .maybeSingle();
    if (!spent)
      throw new Error(
        "That free entry was just used in another tab. Please refresh and try again.",
      );

    const entry = await insertEntry(client, {
      guestId,
      event,
      occurrence,
      entryType: "free",
      price: 0,
      key,
      onDuplicate: async () => {
        // Roll the balance back: the duplicate request must not cost anything.
        await client
          .from("crorepati_entry_state")
          .update({
            free_entries: free,
            free_entries_used: Number(state["free_entries_used"] ?? 0),
            updated_at: new Date().toISOString(),
          })
          .eq("guest_id", guestId);
      },
    });

    const remaining = Number(spent["free_entries"] ?? 0);
    await notifyGuest(
      guestId,
      "free_entry_used",
      `entry:${String(entry["id"])}`,
      { count: remaining },
      {
        referenceType: "crorepati_entry",
        referenceId: String(entry["id"]),
        metadata: { entryId: entry["id"], remaining, entryType: "free" },
      },
    );
    if (remaining === 0 && !state["zero_notified"]) {
      await client
        .from("crorepati_entry_state")
        .update({ zero_notified: true })
        .eq("guest_id", guestId);
      await notifyGuest(
        guestId,
        "free_entry_used",
        `freeentry:exhausted:${guestId}:${String(entry["id"])}`,
        { count: 0 },
        {
          referenceType: "crorepati_entry",
          referenceId: String(entry["id"]),
          metadata: { exhausted: true, nextCost: cfg.paidEntryCoinCost },
        },
      );
    }

    return { entryId: String(entry["id"]), entryType: "free", cost: 0, reused: false };
  }

  // Paid entry — virtual USTAD Coins only. A live Global Coin Offer discounts
  // the entry fee: the real discounted amount is what is charged and recorded.
  const offerPrice = await coinOfferPrice(cfg.paidEntryCoinCost);
  const cost = offerPrice.finalPrice;
  const entry = await insertEntry(client, {
    guestId,
    event,
    occurrence,
    entryType: "paid_coins",
    price: cost,
    key,
  });

  // Debit keyed by the entry id → a retry can never charge twice.
  await ledger(guestId, String(entry["id"]), -cost, "Kon Banega Crorepati paid entry");
  const after = await coinBalance(guestId);
  if (after < 0) {
    // Defensive: should be unreachable because eligibility checked the balance.
    await client.from("crorepati_entries").update({ status: "void" }).eq("id", entry["id"]);
    await ledger(guestId, `${entry["id"]}:refund`, cost, "Crorepati entry refund");
    throw new Error("Not enough USTAD Coins for a paid entry.");
  }

  // Audit a discounted transaction ONLY once the charge is confirmed.
  if (offerPrice.offerActive) {
    await recordOfferPurchase({
      weeklyOfferId: offerPrice.weeklyOfferId!,
      guestId,
      itemKind: "crorepati_entry",
      itemId: String(event["id"]),
      basePrice: cfg.paidEntryCoinCost,
      discountPct: offerPrice.discountPct,
      discountAmount: offerPrice.discountAmount,
      finalPrice: cost,
      source: "crorepati_entry",
      refId: String(entry["id"]),
    }).catch(() => {});
  }

  await client
    .from("crorepati_entry_state")
    .update({
      paid_entries_used: Number(state["paid_entries_used"] ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("guest_id", guestId);

  /*
   * No notification here on purpose: the coin debit above already raised a
   * "Coins Spent — Crorepati Entry" notification at the wallet chokepoint.
   * Adding one here would show the user the same fact twice.
   */

  return { entryId: String(entry["id"]), entryType: "paid_coins", cost, reused: false };
}

async function insertEntry(
  client: any,
  input: {
    guestId: string;
    event: Row;
    occurrence: Row;
    entryType: EntryType;
    price: number;
    key: string;
    onDuplicate?: () => Promise<void>;
  },
): Promise<Row> {
  const { data, error } = await client
    .from("crorepati_entries")
    .insert({
      guest_id: input.guestId,
      event_id: input.event["id"],
      occurrence_id: input.occurrence["id"],
      entry_type: input.entryType,
      free_entry_used: input.entryType === "free",
      paid_entry: input.entryType !== "free",
      price: input.price,
      currency: "USTAD_COIN",
      status: "granted",
      idempotency_key: input.key,
    })
    .select()
    .single();
  if (error) {
    await input.onDuplicate?.();
    const { data: again } = await client
      .from("crorepati_entries")
      .select("*")
      .eq("guest_id", input.guestId)
      .eq("status", "granted")
      .maybeSingle();
    if (again) return again;
    throw new Error(error.message);
  }
  return data;
}

/**
 * Bind a granted entry to the Part 1 attempt it paid for and mark the current
 * occurrence as PLAYED (which resets the missed streak — win, loss or timeout,
 * participation is what matters).
 */
export async function consumeEntry(input: {
  token: unknown;
  entryId: string;
  attemptId: string;
}): Promise<void> {
  const guestId = await requireGuest(input.token);
  const client = sdb();

  const { data: entry } = await client
    .from("crorepati_entries")
    .update({ status: "consumed", attempt_id: input.attemptId })
    .eq("id", input.entryId)
    .eq("guest_id", guestId) // ownership: never another guest's entry
    .eq("status", "granted")
    .select()
    .maybeSingle();
  if (!entry) return;

  await client
    .from("crorepati_attempts")
    .update({ entry_id: entry["id"] })
    .eq("id", input.attemptId)
    .eq("guest_id", guestId);

  if (entry["occurrence_id"]) {
    await client
      .from("crorepati_participation")
      .update({ played: true, counted: true, attempt_id: input.attemptId })
      .eq("occurrence_id", entry["occurrence_id"])
      .eq("guest_id", guestId);
  }

  // Playing resets the streak — a loss is still participation.
  await client
    .from("crorepati_entry_state")
    .update({
      missed_streak: 0,
      last_played_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("guest_id", guestId);
}

/** Release an entry that never became an attempt (e.g. question generation failed). */
export async function releaseEntry(input: { token: unknown; entryId: string }): Promise<void> {
  const guestId = await requireGuest(input.token);
  const client = sdb();
  const { data: entry } = await client
    .from("crorepati_entries")
    .select("*")
    .eq("id", input.entryId)
    .eq("guest_id", guestId)
    .eq("status", "granted")
    .maybeSingle();
  if (!entry) return;

  await client.from("crorepati_entries").update({ status: "void" }).eq("id", entry["id"]);

  if (entry["entry_type"] === "free") {
    const { data: state } = await client
      .from("crorepati_entry_state")
      .select("*")
      .eq("guest_id", guestId)
      .maybeSingle();
    const { data: event } = await client
      .from("crorepati_events")
      .select("*")
      .eq("id", entry["event_id"])
      .maybeSingle();
    const cfg = configOf(event ?? {});
    await client
      .from("crorepati_entry_state")
      .update({
        free_entries: clampFreeEntries(
          Number(state?.["free_entries"] ?? 0) + 1,
          cfg.maxFreeEntries,
        ),
        free_entries_used: Math.max(0, Number(state?.["free_entries_used"] ?? 1) - 1),
        updated_at: new Date().toISOString(),
      })
      .eq("guest_id", guestId);
  } else {
    // Refund the coins, keyed so it can only ever happen once.
    await ledger(
      guestId,
      `${entry["id"]}:refund`,
      Number(entry["price"] ?? 0),
      "Crorepati entry refund (attempt not started)",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Profile statistics (existing profile page — no new page)            */
/* ------------------------------------------------------------------ */

export async function entryProfileStats(token: unknown) {
  const guestId = await requireGuest(token);
  const event = await getEventRow();
  const state = await ensureState(guestId, event);
  const { data: entries } = await sdb()
    .from("crorepati_entries")
    .select("entry_type,status,price,created_at")
    .eq("guest_id", guestId)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows: Row[] = entries ?? [];

  return {
    freeEntries: Number(state["free_entries"] ?? 0),
    maxFreeEntries: Number(event["max_free_entries"] ?? 3),
    freeEntriesUsed: Number(state["free_entries_used"] ?? 0),
    paidEntriesUsed: Number(state["paid_entries_used"] ?? 0),
    missedStreak: Number(state["missed_streak"] ?? 0),
    missedThreshold: Number(event["missed_threshold"] ?? 10),
    recoveryCount: Number(state["recovery_count"] ?? 0),
    coinsSpentOnEntries: rows
      .filter((r) => r["status"] !== "void")
      .reduce((a, r) => a + Number(r["price"] ?? 0), 0),
    history: rows.slice(0, 10).map((r) => ({
      entryType: String(r["entry_type"]),
      status: String(r["status"]),
      price: Number(r["price"] ?? 0),
      at: String(r["created_at"]),
    })),
  };
}
