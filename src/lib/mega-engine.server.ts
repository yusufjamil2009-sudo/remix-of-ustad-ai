/**
 * USTAD AI MEGA TOURNAMENT — authoritative engine (Part 2).
 *
 * Reuses, never rebuilds:
 *   • identity/ownership  → `guest.server.ts` (requireGuest + service-role db)
 *   • question generation → `crorepati-ai.server.ts#generateQuizSet` (Part 1)
 *   • coin wallet         → `ustad_coin_ledger` (Part 1)
 *   • notifications       → existing `reminders` feed
 *   • profile             → existing profile page reads `megaProfileStats()`
 *   • timing              → server timestamps rendered by `crorepati-clock.ts`
 *                            (the Chrono Engine itself is untouched)
 *
 * The client is a renderer. Match membership, pass validity, the question set,
 * the correct answers, the timers, the scores, the ranking, the winner and the
 * match completion are all decided here.
 */
import { requireGuest, db } from "./guest.server";
import { notifyGuest } from "./notification.server";
import { applyCoins, balanceOf } from "./wallet.server";
import { coinOfferPrice, recordOfferPurchase } from "./coin-offer.server";
import { generateQuizSet, questionHash } from "./crorepati-ai.server";
import type { Language } from "./router.server";
import {
  DEFAULT_SCORING,
  MEGA_EVENT_CODE,
  MEGA_LATENCY_GRACE_MS,
  MEGA_PRESENCE_TTL_MS,
  rankPlayers,
  soloOutcome,
  type MegaEventView,
  type MegaMatchPlayerView,
  type MegaMatchStatus,
  type MegaMatchView,
  type MegaMode,
  type MegaResultView,
  type MegaScoring,
  type MegaStanding,
} from "./mega-spec";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sdb = () => db() as any;
type Row = Record<string, any>;

/** Same public identity the rest of USTAD AI shows — no new identity system. */
function displayNameFor(guestId: string): string {
  return `USTAD ${guestId
    .replace(/^guest_/, "")
    .slice(0, 8)
    .toUpperCase()}`;
}

/* ------------------------------------------------------------------ */
/* Event configuration                                                 */
/* ------------------------------------------------------------------ */

async function getEventRow(): Promise<Row> {
  const client = sdb();
  const { data } = await client
    .from("mega_events")
    .select("*")
    .eq("code", MEGA_EVENT_CODE)
    .maybeSingle();
  if (data) return data;
  const { data: created, error } = await client
    .from("mega_events")
    .insert({ code: MEGA_EVENT_CODE, title: "USTAD AI Mega Tournament" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return created;
}

function eventView(row: Row): MegaEventView {
  return {
    id: String(row["id"]),
    code: String(row["code"]),
    title: String(row["title"]),
    status: String(row["status"]),
    timezone: String(row["timezone"]),
    startsAt: String(row["starts_at"]),
    endsAt: String(row["ends_at"]),
    questionCount: Number(row["question_count"]),
    questionSeconds: Number(row["question_seconds"]),
    preTimerSeconds: Number(row["pre_timer_seconds"]),
    soloQuestionCount: Number(row["solo_question_count"]),
    soloTotalSeconds: Number(row["solo_total_seconds"]),
    soloRequiredCorrect: Number(row["solo_required_correct"]),
    minPlayers: Number(row["min_players"]),
    maxPlayers: Number(row["max_players"]),
    passCost: Number(row["pass_cost"]),
    soloEnabled: Boolean(row["solo_enabled"]),
    multiplayerEnabled: Boolean(row["multiplayer_enabled"]),
    scoring: { ...DEFAULT_SCORING, ...((row["scoring"] as MegaScoring) ?? {}) },
    rewards: (row["rewards"] as Record<string, number>) ?? {},
  };
}

function eventIsOpen(row: Row): boolean {
  const now = Date.now();
  return (
    row["status"] === "open" &&
    Date.parse(row["starts_at"]) <= now &&
    now < Date.parse(row["ends_at"])
  );
}

/* ------------------------------------------------------------------ */
/* Coins (shared Part 1 ledger)                                        */
/* ------------------------------------------------------------------ */

/**
 * The authoritative balance. Part 7 routes this through the ONE wallet module
 * so every engine reads the same permanent, database-backed number.
 */
export async function coinBalance(guestId: string): Promise<number> {
  return balanceOf(guestId);
}

/**
 * Idempotent credit/debit through the Part 7 wallet: the ledger row and the
 * permanent wallet balance move together in one database transaction, and
 * (guest_id, source, ref_id) still blocks duplicates.
 */
async function ledger(guestId: string, source: string, refId: string, coins: number, note: string) {
  if (!coins) return;
  await applyCoins({ guestId, source, refId, amount: coins, type: source, note });
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
    /* best effort — never fails a match result */
  }
}

/* ------------------------------------------------------------------ */
/* Weekly pass                                                         */
/* ------------------------------------------------------------------ */

async function activePass(guestId: string, event: Row): Promise<Row | null> {
  const { data } = await sdb()
    .from("mega_passes")
    .select("*")
    .eq("guest_id", guestId)
    .eq("event_id", event["id"])
    .maybeSingle();
  if (!data) return null;
  const now = Date.now();
  // A pass is bound to ONE event window; last week's pass never carries over.
  const valid =
    data["status"] === "active" &&
    Date.parse(data["valid_from"]) <= now &&
    now < Date.parse(data["valid_until"]);
  return { ...data, valid };
}

async function requirePass(guestId: string, event: Row): Promise<Row> {
  const pass = await activePass(guestId, event);
  if (!pass || !pass["valid"])
    throw new Error("A valid weekly Mega Tournament pass is required to play.");
  return pass;
}

/** Buy the weekly pass. Charged exactly once per (guest, event). */
export async function buyPass(token: unknown) {
  const guestId = await requireGuest(token);
  const event = await getEventRow();
  if (!eventIsOpen(event)) throw new Error("The Mega Tournament event is not open right now.");

  const existing = await activePass(guestId, event);
  if (existing) {
    // Duplicate purchase attempt → no second charge, just return the pass.
    return { pass: passView(existing), balance: await coinBalance(guestId), alreadyOwned: true };
  }

  const baseCost = Number(event["pass_cost"]);
  // A live Global Coin Offer discounts the pass — charge the real amount.
  const offerPrice = await coinOfferPrice(baseCost);
  const cost = offerPrice.finalPrice;
  const balance = await coinBalance(guestId);
  if (balance < cost) {
    throw new Error(
      `Not enough USTAD Coins. The weekly pass costs ${cost.toLocaleString("en-IN")} and you have ${balance.toLocaleString("en-IN")}.`,
    );
  }

  const { data: created, error } = await sdb()
    .from("mega_passes")
    .insert({
      guest_id: guestId,
      event_id: event["id"],
      cost,
      base_cost: baseCost,
      status: "active",
      valid_from: event["starts_at"],
      valid_until: event["ends_at"],
    })
    .select()
    .single();
  if (error) {
    // unique(guest_id,event_id) → a racing second click lands here, uncharged.
    const again = await activePass(guestId, event);
    if (again) return { pass: passView(again), balance, alreadyOwned: true };
    throw new Error(error.message);
  }

  // The debit is keyed by the pass id, so it can never be applied twice.
  await ledger(
    guestId,
    "mega_pass",
    String(created["id"]),
    -cost,
    offerPrice.offerActive
      ? `Mega Tournament weekly pass (${offerPrice.discountPct}% OFF)`
      : "Mega Tournament weekly pass",
  );
  if (offerPrice.offerActive) {
    await recordOfferPurchase({
      weeklyOfferId: offerPrice.weeklyOfferId!,
      guestId,
      itemKind: "pass",
      itemId: "mega_pass",
      basePrice: baseCost,
      discountPct: offerPrice.discountPct,
      discountAmount: offerPrice.discountAmount,
      finalPrice: cost,
      source: "mega_pass",
      refId: String(created["id"]),
    }).catch(() => {});
  }
  // Part 9 (spec §14): raised only after the debit and the pass row both
  // succeeded, keyed on the pass id so a retry cannot notify twice.
  await notifyGuest(
    guestId,
    "mega_pass",
    `megapass:${String(created["id"])}`,
    { amount: cost },
    {
      referenceType: "mega_pass",
      referenceId: String(created["id"]),
      metadata: { eventId: event["id"], passId: created["id"], cost },
    },
  );

  return {
    pass: passView({ ...created, valid: true }),
    balance: await coinBalance(guestId),
    alreadyOwned: false,
  };
}

function passView(row: Row) {
  return {
    id: String(row["id"]),
    eventId: String(row["event_id"]),
    cost: Number(row["cost"]),
    status: String(row["status"]),
    purchasedAt: String(row["purchased_at"]),
    validFrom: String(row["valid_from"]),
    validUntil: String(row["valid_until"]),
    valid: Boolean(row["valid"]),
  };
}

/* ------------------------------------------------------------------ */
/* Lobby + presence                                                    */
/* ------------------------------------------------------------------ */

/** Heartbeat: keeps the guest visible in the lobby and returns the live list. */
export async function lobbyHeartbeat(input: {
  token: unknown;
  state?: "available" | "away" | "in_match";
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEventRow();
  const now = new Date();

  await sdb()
    .from("mega_lobby_presence")
    .upsert(
      {
        guest_id: guestId,
        event_id: event["id"],
        display_name: displayNameFor(guestId),
        state: input.state ?? "available",
        last_seen_at: now.toISOString(),
      },
      { onConflict: "guest_id" },
    );

  // Cleanup: stale presences are removed, so no user lingers forever.
  const cutoff = new Date(now.getTime() - MEGA_PRESENCE_TTL_MS * 4).toISOString();
  await sdb().from("mega_lobby_presence").delete().lt("last_seen_at", cutoff);

  return getLobby(input.token);
}

export async function leaveLobby(token: unknown) {
  const guestId = await requireGuest(token);
  await sdb().from("mega_lobby_presence").delete().eq("guest_id", guestId);
  return { ok: true };
}

export async function getLobby(token: unknown) {
  const guestId = await requireGuest(token);
  const event = await getEventRow();
  const fresh = new Date(Date.now() - MEGA_PRESENCE_TTL_MS).toISOString();

  const { data } = await sdb()
    .from("mega_lobby_presence")
    .select("*")
    .eq("event_id", event["id"])
    .gte("last_seen_at", fresh)
    .order("last_seen_at", { ascending: false })
    .limit(60);

  const pass = await activePass(guestId, event);
  const live = await currentMatchIdFor(guestId);

  return {
    event: eventView(event),
    eventOpen: eventIsOpen(event),
    pass: pass ? passView(pass) : null,
    balance: await coinBalance(guestId),
    players: (data ?? []).map((r: Row) => ({
      guestId: String(r["guest_id"]),
      displayName: String(r["display_name"] || displayNameFor(String(r["guest_id"]))),
      state: String(r["state"]),
      lastSeenAt: String(r["last_seen_at"]),
      isSelf: String(r["guest_id"]) === guestId,
    })),
    activeMatchId: live,
    serverNow: new Date().toISOString(),
  };
}

async function currentMatchIdFor(guestId: string): Promise<string | null> {
  const { data } = await sdb()
    .from("mega_match_players")
    .select("match_id, mega_matches!inner(status)")
    .eq("guest_id", guestId)
    .in("mega_matches.status", ["lobby", "ready", "active"])
    .limit(1);
  const row = (data ?? [])[0];
  return row ? String(row["match_id"]) : null;
}

/* ------------------------------------------------------------------ */
/* Match creation                                                      */
/* ------------------------------------------------------------------ */

async function generateMatchQuestions(input: {
  guestId: string;
  eventId: string;
  matchId: string;
  count: number;
  language: Language;
  klass: string | null;
  avoid: string[];
}) {
  const { questions } = await generateQuizSet({
    guestId: input.guestId,
    language: input.language,
    klass: input.klass,
    avoid: input.avoid,
    seed: Math.floor(Math.random() * 1_000_000),
    // FIXED count from the event configuration — the AI cannot change it.
    count: input.count,
    showName: "Mega Tournament",
  });

  await sdb()
    .from("mega_match_questions")
    .insert(
      questions.map((q, i) => ({
        match_id: input.matchId,
        event_id: input.eventId,
        question_number: i + 1,
        question: q.question,
        options: q.options,
        correct_index: q.correctIndex,
        category: q.category,
        difficulty: q.difficulty,
        explanation: q.explanation,
        hint: q.hint,
      })),
    );

  await sdb()
    .from("mega_served_questions")
    .upsert(
      questions.map((q) => ({
        guest_id: input.guestId,
        question_hash: questionHash(q.question),
        last_served_at: new Date().toISOString(),
      })),
      { onConflict: "guest_id,question_hash" },
    );
}

async function profileOf(guestId: string) {
  const { data } = await sdb()
    .from("profiles")
    .select("klass,language")
    .eq("guest_id", guestId)
    .maybeSingle();
  return {
    klass: (data?.["klass"] as string) ?? null,
    language: ((data?.["language"] as Language) ?? "english") as Language,
  };
}

async function servedHashes(guestId: string): Promise<string[]> {
  const { data } = await sdb()
    .from("mega_served_questions")
    .select("question_hash")
    .eq("guest_id", guestId)
    .order("last_served_at", { ascending: false })
    .limit(120);
  return (data ?? []).map((r: Row) => String(r["question_hash"]));
}

/**
 * Create a match. `mode: "solo"` uses the single-player rule set (20 questions,
 * 10 minutes total, >= 10 correct to win); `mode: "multiplayer"` uses the
 * event-configured fixed count and per-question timer with 2–4 real players.
 */
export async function createMatch(input: {
  token: unknown;
  mode: MegaMode;
  /** Guest ids selected from the lobby (multiplayer only, 1–3 of them). */
  playerIds?: string[];
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEventRow();
  if (!eventIsOpen(event)) throw new Error("The Mega Tournament event is not open right now.");
  await requirePass(guestId, event);

  if (input.mode === "solo" && !event["solo_enabled"])
    throw new Error("Single-player Mega Tournament is disabled for this event.");
  if (input.mode === "multiplayer" && !event["multiplayer_enabled"])
    throw new Error("Multiplayer Mega Tournament is disabled for this event.");

  // One live match per guest → duplicate match creation is impossible.
  const live = await currentMatchIdFor(guestId);
  if (live) return getMatch({ token: input.token, matchId: live });

  const selected = Array.from(
    new Set((input.playerIds ?? []).filter((id) => id && id !== guestId)),
  );
  if (input.mode === "multiplayer") {
    const size = selected.length + 1;
    if (size < Number(event["min_players"]))
      throw new Error(`Select at least ${Number(event["min_players"]) - 1} other player.`);
    if (size > Number(event["max_players"]))
      throw new Error(`A Mega Tournament match can have at most ${event["max_players"]} players.`);

    // Every selected player must hold a valid pass and be free right now.
    for (const id of selected) {
      const theirPass = await activePass(id, event);
      if (!theirPass?.["valid"])
        throw new Error(`${displayNameFor(id)} does not hold a valid weekly pass.`);
      if (await currentMatchIdFor(id))
        throw new Error(`${displayNameFor(id)} is already in another match.`);
    }
  }

  const solo = input.mode === "solo";
  const questionCount = solo
    ? Number(event["solo_question_count"])
    : Number(event["question_count"]);

  const { data: match, error } = await sdb()
    .from("mega_matches")
    .insert({
      event_id: event["id"],
      host_guest_id: guestId,
      mode: input.mode,
      status: solo ? "ready" : "lobby",
      question_count: questionCount,
      question_seconds: Number(event["question_seconds"]),
      current_question: 0,
    })
    .select()
    .single();
  if (error) {
    const again = await currentMatchIdFor(guestId);
    if (again) return getMatch({ token: input.token, matchId: again });
    throw new Error(error.message);
  }

  const members = [guestId, ...(solo ? [] : selected)];
  await sdb()
    .from("mega_match_players")
    .insert(
      members.map((id) => ({
        match_id: match["id"],
        guest_id: id,
        display_name: displayNameFor(id),
        is_host: id === guestId,
        // The host is ready immediately; invited players must accept.
        state: id === guestId ? "ready" : "joining",
      })),
    );

  const prof = await profileOf(guestId);
  await generateMatchQuestions({
    guestId,
    eventId: String(event["id"]),
    matchId: String(match["id"]),
    count: questionCount,
    language: prof.language,
    klass: prof.klass,
    avoid: await servedHashes(guestId),
  });

  await sdb()
    .from("mega_lobby_presence")
    .update({ state: "in_match", match_id: match["id"] })
    .in("guest_id", members);

  for (const id of members.filter((m) => m !== guestId)) {
    await notify(
      id,
      "🏟️ Mega Tournament invitation",
      `${displayNameFor(guestId)} invited you to a Mega Tournament match.`,
      { kind: "mega_invite", matchId: match["id"], eventId: event["id"] },
    );
  }

  return getMatch({ token: input.token, matchId: String(match["id"]) });
}

/** A selected player marks themselves Ready / Not Ready, or leaves. */
export async function setPlayerState(input: {
  token: unknown;
  matchId: string;
  state: "ready" | "joining" | "left";
}) {
  const guestId = await requireGuest(input.token);
  const match = await loadMatch(input.matchId, guestId);
  if (match["status"] === "completed" || match["status"] === "abandoned")
    return getMatch({ token: input.token, matchId: input.matchId });

  await sdb()
    .from("mega_match_players")
    .update({ state: input.state, last_seen_at: new Date().toISOString() })
    .eq("match_id", input.matchId)
    .eq("guest_id", guestId);

  if (input.state === "left") {
    await sdb()
      .from("mega_lobby_presence")
      .update({ state: "available", match_id: null })
      .eq("guest_id", guestId);
    await applyAbandonmentRule(match);
  }
  return getMatch({ token: input.token, matchId: input.matchId });
}

/**
 * Host starts the match. Only players who are actually Ready take part; the
 * client cannot decide the roster.
 */
export async function startMatch(input: { token: unknown; matchId: string }) {
  const guestId = await requireGuest(input.token);
  const event = await getEventRow();
  const match = await loadMatch(input.matchId, guestId);
  if (String(match["host_guest_id"]) !== guestId)
    throw new Error("Only the host can start the match.");
  if (match["status"] === "active") return getMatch({ token: input.token, matchId: input.matchId });
  if (match["status"] !== "lobby" && match["status"] !== "ready")
    throw new Error("This match can no longer be started.");

  await requirePass(guestId, event);

  const { data: players } = await sdb()
    .from("mega_match_players")
    .select("*")
    .eq("match_id", input.matchId);
  const active = (players ?? []).filter((p: Row) => p["state"] === "ready");

  if (match["mode"] === "multiplayer") {
    if (active.length < Number(event["min_players"]))
      throw new Error("Not every selected player is ready yet.");
    // Players who never accepted are dropped before the match locks.
    await sdb()
      .from("mega_match_players")
      .update({ state: "left" })
      .eq("match_id", input.matchId)
      .in("state", ["joining", "disconnected"]);
  }

  const now = new Date();
  const solo = match["mode"] === "solo";
  const patch: Row = {
    status: "active",
    started_at: now.toISOString(),
    current_question: 1,
    presented_at: null,
    answer_timer_starts_at: null,
    question_deadline_at: null,
  };
  if (solo) {
    // ONE total 10-minute clock for the whole single-player tournament.
    patch["solo_deadline_at"] = new Date(
      now.getTime() + Number(event["solo_total_seconds"]) * 1000,
    ).toISOString();
  }

  await sdb()
    .from("mega_matches")
    .update(patch)
    .eq("id", input.matchId)
    .in("status", ["lobby", "ready"]); // idempotent: a second click is a no-op

  await sdb()
    .from("mega_match_players")
    .update({ state: "playing" })
    .eq("match_id", input.matchId)
    .eq("state", "ready");

  return getMatch({ token: input.token, matchId: input.matchId });
}

/* ------------------------------------------------------------------ */
/* Match state                                                         */
/* ------------------------------------------------------------------ */

async function loadMatch(matchId: string, guestId: string): Promise<Row> {
  const { data: member } = await sdb()
    .from("mega_match_players")
    .select("guest_id")
    .eq("match_id", matchId)
    .eq("guest_id", guestId)
    .maybeSingle();
  // Membership is server-checked: a non-member cannot even read the match.
  if (!member) throw new Error("You are not part of this match.");
  const { data } = await sdb().from("mega_matches").select("*").eq("id", matchId).maybeSingle();
  if (!data) throw new Error("Match not found.");
  return data;
}

async function questionRow(matchId: string, number: number): Promise<Row | null> {
  const { data } = await sdb()
    .from("mega_match_questions")
    .select("*")
    .eq("match_id", matchId)
    .eq("question_number", number)
    .maybeSingle();
  return data ?? null;
}

/** Heartbeat + full authoritative snapshot for every poll. */
export async function getMatch(input: { token: unknown; matchId: string }): Promise<MegaMatchView> {
  const guestId = await requireGuest(input.token);
  let match = await loadMatch(input.matchId, guestId);
  const event = await getEventRow();

  await sdb()
    .from("mega_match_players")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("match_id", input.matchId)
    .eq("guest_id", guestId);

  match = await enforceClocks(match, event);
  return buildMatchView(match, event, guestId);
}

/**
 * Server-side clock enforcement, run on EVERY touch of the match:
 *   • solo   → the 10-minute total timer ends the match
 *   • multi  → an expired per-question deadline resolves the question
 * The client can never gain time by not reporting.
 */
async function enforceClocks(match: Row, event: Row): Promise<Row> {
  if (match["status"] !== "active") return match;

  if (match["mode"] === "solo") {
    const deadline = match["solo_deadline_at"] ? Date.parse(match["solo_deadline_at"]) : null;
    if (deadline && Date.now() > deadline + MEGA_LATENCY_GRACE_MS) {
      return completeMatch(match, event);
    }
    return match;
  }

  const qDeadline = match["question_deadline_at"]
    ? Date.parse(match["question_deadline_at"])
    : null;
  if (qDeadline && Date.now() > qDeadline + MEGA_LATENCY_GRACE_MS) {
    return resolveQuestion(match, event);
  }
  return match;
}

async function buildMatchView(match: Row, event: Row, guestId: string): Promise<MegaMatchView> {
  const matchId = String(match["id"]);
  const number = Number(match["current_question"]);

  const { data: playerRows } = await sdb()
    .from("mega_match_players")
    .select("*")
    .eq("match_id", matchId)
    .order("joined_at", { ascending: true });

  const qRow = number > 0 ? await questionRow(matchId, number) : null;
  const resolved = Boolean(qRow?.["resolved"]);

  const { data: answerRows } = await sdb()
    .from("mega_match_answers")
    .select("*")
    .eq("match_id", matchId)
    .eq("question_number", number);

  const answers = new Map<string, Row>();
  for (const a of answerRows ?? []) answers.set(String(a["guest_id"]), a);
  const mine = answers.get(guestId) ?? null;

  const expired =
    match["question_deadline_at"] && Date.now() > Date.parse(match["question_deadline_at"]);

  const players: MegaMatchPlayerView[] = (playerRows ?? []).map((p: Row) => {
    const id = String(p["guest_id"]);
    const a = answers.get(id);
    return {
      guestId: id,
      displayName: String(p["display_name"] || displayNameFor(id)),
      isHost: Boolean(p["is_host"]),
      isSelf: id === guestId,
      state: p["state"],
      correctCount: Number(p["correct_count"]),
      wrongCount: Number(p["wrong_count"]),
      unansweredCount: Number(p["unanswered_count"]),
      score: Number(p["score"]),
      totalResponseMs: Number(p["total_response_ms"]),
      rank: p["rank"] == null ? null : Number(p["rank"]),
      // Non-sensitive status only — never the option another player picked.
      answerStatus: a ? "answered" : expired ? "expired" : "thinking",
      lifelines: {
        fiftyFiftyUsed: Boolean(p["fifty_fifty_used"]),
        hintUsed: Boolean(p["hint_used"]),
        skipUsed: Boolean(p["skip_used"]),
      },
    };
  });

  const result =
    match["status"] === "completed" || match["status"] === "abandoned"
      ? await loadResult(matchId)
      : null;

  return {
    matchId,
    eventId: String(match["event_id"]),
    mode: match["mode"] as MegaMode,
    status: match["status"] as MegaMatchStatus,
    questionCount: Number(match["question_count"]),
    currentQuestion: number,
    players,
    question: qRow
      ? {
          id: String(qRow["id"]),
          matchId,
          eventId: String(match["event_id"]),
          questionNumber: Number(qRow["question_number"]),
          question: String(qRow["question"]),
          options: (qRow["options"] as string[]) ?? [],
          category: String(qRow["category"]),
          difficulty: String(qRow["difficulty"]),
          removedOptions: Array.isArray(mine?.["removed_options"]) ? mine!["removed_options"] : [],
          ...(mine?.["hint_shown"] ? { hint: String(qRow["hint"]) } : {}),
          // The correct answer is revealed ONLY after official resolution.
          ...(resolved
            ? {
                correctIndex: Number(qRow["correct_index"]),
                explanation: String(qRow["explanation"] ?? ""),
              }
            : {}),
        }
      : null,
    questionResolved: resolved,
    myAnswer: mine && mine["option_index"] != null ? Number(mine["option_index"]) : null,
    timing: {
      serverNow: new Date().toISOString(),
      presentedAt: (match["presented_at"] as string) ?? null,
      answerTimerStartsAt: (match["answer_timer_starts_at"] as string) ?? null,
      questionDeadlineAt: (match["question_deadline_at"] as string) ?? null,
      soloDeadlineAt: (match["solo_deadline_at"] as string) ?? null,
      preTimerSeconds: Number(event["pre_timer_seconds"]),
      questionSeconds: Number(match["question_seconds"]),
    },
    result,
  };
}

/* ------------------------------------------------------------------ */
/* Question presentation + answering                                   */
/* ------------------------------------------------------------------ */

/**
 * Reported once the question animation finished (same Part 1 flow).
 * Multiplayer: the FIRST report arms one shared clock for every player, so all
 * players answer against exactly the same deadline.
 */
export async function markPresented(input: {
  token: unknown;
  matchId: string;
  questionNumber: number;
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEventRow();
  let match = await loadMatch(input.matchId, guestId);
  match = await enforceClocks(match, event);
  if (match["status"] !== "active") return buildMatchView(match, event, guestId);
  if (Number(match["current_question"]) !== input.questionNumber)
    return buildMatchView(match, event, guestId);
  if (match["question_deadline_at"]) return buildMatchView(match, event, guestId);

  const pre = Number(event["pre_timer_seconds"]) * 1000;
  const window = Number(match["question_seconds"]) * 1000;
  const now = Date.now();

  const { data: updated } = await sdb()
    .from("mega_matches")
    .update({
      presented_at: new Date(now).toISOString(),
      answer_timer_starts_at: new Date(now + pre).toISOString(),
      question_deadline_at: new Date(now + pre + window).toISOString(),
    })
    .eq("id", input.matchId)
    .eq("status", "active")
    .is("question_deadline_at", null)
    .select()
    .maybeSingle();

  const fresh = updated ?? (await loadMatch(input.matchId, guestId));
  return buildMatchView(fresh, event, guestId);
}

/** Submit an answer. One locked answer per player per question. */
export async function submitAnswer(input: {
  token: unknown;
  matchId: string;
  questionNumber: number;
  optionIndex: number;
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEventRow();
  let match = await loadMatch(input.matchId, guestId);
  match = await enforceClocks(match, event);
  if (match["status"] !== "active") return buildMatchView(match, event, guestId);
  if (Number(match["current_question"]) !== input.questionNumber)
    return buildMatchView(match, event, guestId);

  const index = Number(input.optionIndex);
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error("Invalid option.");

  const qRow = await questionRow(input.matchId, input.questionNumber);
  if (!qRow) throw new Error("Question not found.");

  const solo = match["mode"] === "solo";
  if (!solo && !match["answer_timer_starts_at"]) throw new Error("This question is not ready yet.");
  if (!solo) {
    const startsAt = Date.parse(match["answer_timer_starts_at"]);
    if (Date.now() + MEGA_LATENCY_GRACE_MS < startsAt)
      throw new Error("The answer window has not opened yet.");
  }

  const startRef = solo
    ? Date.parse(match["started_at"] ?? new Date().toISOString())
    : Date.parse(match["answer_timer_starts_at"]);
  const responseMs = Math.max(0, Date.now() - startRef);
  const correct = Number(qRow["correct_index"]) === index;
  const scoring: MegaScoring = { ...DEFAULT_SCORING, ...((event["scoring"] as MegaScoring) ?? {}) };
  const delta = correct ? scoring.correct : scoring.wrong;

  // Insert-only: the composite PK makes a second submission impossible.
  // Check if already answered to provide better error handling
  const { data: existingAnswer } = await sdb()
    .from("mega_match_answers")
    .select("id")
    .eq("match_id", input.matchId)
    .eq("question_number", input.questionNumber)
    .eq("guest_id", guestId)
    .maybeSingle();
  
  if (existingAnswer) {
    // Already answered — the answer stays locked, nothing is scored twice.
    return buildMatchView(match, event, guestId);
  }

  const { error } = await sdb().from("mega_match_answers").insert({
    match_id: input.matchId,
    question_number: input.questionNumber,
    guest_id: guestId,
    option_index: index,
    is_correct: correct,
    response_ms: responseMs,
    score_delta: delta,
  });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      // Already answered — the answer stays locked, nothing is scored twice.
      return buildMatchView(match, event, guestId);
    }
    throw new Error(error.message);
  }

  const { data: player } = await sdb()
    .from("mega_match_players")
    .select("*")
    .eq("match_id", input.matchId)
    .eq("guest_id", guestId)
    .maybeSingle();

  if (!player) throw new Error("Player not found in match.");

  // Only update if the answer was actually inserted (not a duplicate)
  const currentCorrect = Number(player?.["correct_count"] ?? 0);
  const currentWrong = Number(player?.["wrong_count"] ?? 0);
  const currentScore = Number(player?.["score"] ?? 0);
  const currentResponseMs = Number(player?.["total_response_ms"] ?? 0);

  await sdb()
    .from("mega_match_players")
    .update({
      correct_count: currentCorrect + (correct ? 1 : 0),
      wrong_count: currentWrong + (correct ? 0 : 1),
      score: currentScore + delta,
      total_response_ms: currentResponseMs + responseMs,
      last_seen_at: new Date().toISOString(),
    })
    .eq("match_id", input.matchId)
    .eq("guest_id", guestId);

  if (solo) {
    const fresh = await advanceSolo(match, event, guestId);
    return buildMatchView(fresh, event, guestId);
  }

  // Multiplayer: resolve as soon as every active player has submitted.
  const settled = await maybeResolveWhenAllAnswered(match, event);
  return buildMatchView(settled, event, guestId);
}

/** Solo advance: next question, or finish when the fixed set is done. */
async function advanceSolo(match: Row, event: Row, _guestId: string): Promise<Row> {
  const current = Number(match["current_question"]);
  await sdb()
    .from("mega_match_questions")
    .update({ resolved: true })
    .eq("match_id", match["id"])
    .eq("question_number", current);

  if (current >= Number(match["question_count"])) return completeMatch(match, event);

  const { data: updated } = await sdb()
    .from("mega_matches")
    .update({
      current_question: current + 1,
      presented_at: null,
      answer_timer_starts_at: null,
      question_deadline_at: null,
    })
    .eq("id", match["id"])
    .eq("current_question", current)
    .eq("status", "active")
    .select()
    .maybeSingle();
  return updated ?? match;
}

async function activePlayerIds(matchId: string): Promise<string[]> {
  const { data } = await sdb()
    .from("mega_match_players")
    .select("guest_id,state")
    .eq("match_id", matchId);
  return (data ?? [])
    .filter((p: Row) => p["state"] === "playing" || p["state"] === "disconnected")
    .map((p: Row) => String(p["guest_id"]));
}

async function maybeResolveWhenAllAnswered(match: Row, event: Row): Promise<Row> {
  const number = Number(match["current_question"]);
  const ids = await activePlayerIds(String(match["id"]));
  const { data: answers } = await sdb()
    .from("mega_match_answers")
    .select("guest_id")
    .eq("match_id", match["id"])
    .eq("question_number", number);
  const answered = new Set((answers ?? []).map((a: Row) => String(a["guest_id"])));
  if (ids.every((id) => answered.has(id))) return resolveQuestion(match, event);
  return match;
}

/**
 * Official multiplayer question resolution: happens when the shared timer
 * expires OR every active player has answered. Missing answers are recorded as
 * unanswered, then the match advances or completes.
 */
async function resolveQuestion(match: Row, event: Row): Promise<Row> {
  const matchId = String(match["id"]);
  const number = Number(match["current_question"]);

  // Claim the resolution so two concurrent callers cannot double-advance.
  const { data: claimed } = await sdb()
    .from("mega_match_questions")
    .update({ resolved: true })
    .eq("match_id", matchId)
    .eq("question_number", number)
    .eq("resolved", false)
    .select()
    .maybeSingle();
  if (!claimed) {
    const { data: fresh } = await sdb()
      .from("mega_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    return fresh ?? match;
  }

  const ids = await activePlayerIds(matchId);
  const { data: answers } = await sdb()
    .from("mega_match_answers")
    .select("guest_id")
    .eq("match_id", matchId)
    .eq("question_number", number);
  const answered = new Set((answers ?? []).map((a: Row) => String(a["guest_id"])));

  for (const id of ids) {
    if (answered.has(id)) continue;
    await sdb()
      .from("mega_match_answers")
      .insert({
        match_id: matchId,
        question_number: number,
        guest_id: id,
        option_index: null,
        is_correct: false,
        response_ms: Number(match["question_seconds"]) * 1000,
        score_delta: 0,
      });
    const { data: p } = await sdb()
      .from("mega_match_players")
      .select("unanswered_count,total_response_ms")
      .eq("match_id", matchId)
      .eq("guest_id", id)
      .maybeSingle();
    await sdb()
      .from("mega_match_players")
      .update({
        unanswered_count: Number(p?.["unanswered_count"] ?? 0) + 1,
        total_response_ms:
          Number(p?.["total_response_ms"] ?? 0) + Number(match["question_seconds"]) * 1000,
      })
      .eq("match_id", matchId)
      .eq("guest_id", id);
  }

  if (number >= Number(match["question_count"])) return completeMatch(match, event);
  const { data: fresh } = await sdb()
    .from("mega_matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();
  return fresh ?? match;
}

/** Host/any player advances after everyone has seen the resolved question. */
export async function nextQuestion(input: { token: unknown; matchId: string }) {
  const guestId = await requireGuest(input.token);
  const event = await getEventRow();
  let match = await loadMatch(input.matchId, guestId);
  match = await enforceClocks(match, event);
  if (match["status"] !== "active") return buildMatchView(match, event, guestId);

  const current = Number(match["current_question"]);
  const qRow = await questionRow(input.matchId, current);
  if (!qRow?.["resolved"]) return buildMatchView(match, event, guestId);
  if (current >= Number(match["question_count"])) {
    const done = await completeMatch(match, event);
    return buildMatchView(done, event, guestId);
  }

  const { data: updated } = await sdb()
    .from("mega_matches")
    .update({
      current_question: current + 1,
      presented_at: null,
      answer_timer_starts_at: null,
      question_deadline_at: null,
    })
    .eq("id", input.matchId)
    .eq("current_question", current) // idempotent advance
    .eq("status", "active")
    .select()
    .maybeSingle();

  const fresh = updated ?? (await loadMatch(input.matchId, guestId));
  return buildMatchView(fresh, event, guestId);
}

/* ------------------------------------------------------------------ */
/* Lifelines (reused Part 1 Crorepati-style set, no new power-ups)      */
/* ------------------------------------------------------------------ */

export async function useLifeline(input: {
  token: unknown;
  matchId: string;
  lifeline: "fifty" | "hint" | "skip";
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEventRow();
  let match = await loadMatch(input.matchId, guestId);
  match = await enforceClocks(match, event);
  if (match["status"] !== "active") return buildMatchView(match, event, guestId);

  const column =
    input.lifeline === "fifty"
      ? "fifty_fifty_used"
      : input.lifeline === "hint"
        ? "hint_used"
        : "skip_used";

  const number = Number(match["current_question"]);
  const qRow = await questionRow(input.matchId, number);
  if (!qRow) throw new Error("Question not found.");

  // Atomic false → true so a double click consumes exactly one lifeline.
  const { data: consumed } = await sdb()
    .from("mega_match_players")
    .update({ [column]: true })
    .eq("match_id", input.matchId)
    .eq("guest_id", guestId)
    .eq(column, false)
    .select()
    .maybeSingle();
  if (!consumed) throw new Error("That lifeline has already been used in this match.");

  if (input.lifeline === "fifty") {
    const correctIndex = Number(qRow["correct_index"]);
    const removed = [0, 1, 2, 3]
      .filter((i) => i !== correctIndex)
      .sort(() => Math.random() - 0.5)
      .slice(0, 2)
      .sort();
    await sdb().from("mega_match_answers").upsert(
      {
        match_id: input.matchId,
        question_number: number,
        guest_id: guestId,
        option_index: null,
        removed_options: removed,
        is_correct: false,
        score_delta: 0,
        response_ms: 0,
      },
      { onConflict: "match_id,question_number,guest_id", ignoreDuplicates: true },
    );
    // The row above only exists to carry lifeline metadata when unanswered.
    await sdb()
      .from("mega_match_answers")
      .update({ removed_options: removed })
      .eq("match_id", input.matchId)
      .eq("question_number", number)
      .eq("guest_id", guestId);
    return buildMatchView(match, event, guestId);
  }

  if (input.lifeline === "hint") {
    await sdb().from("mega_match_answers").upsert(
      {
        match_id: input.matchId,
        question_number: number,
        guest_id: guestId,
        option_index: null,
        hint_shown: true,
        is_correct: false,
        score_delta: 0,
        response_ms: 0,
      },
      { onConflict: "match_id,question_number,guest_id", ignoreDuplicates: true },
    );
    await sdb()
      .from("mega_match_answers")
      .update({ hint_shown: true })
      .eq("match_id", input.matchId)
      .eq("question_number", number)
      .eq("guest_id", guestId);
    return buildMatchView(match, event, guestId);
  }

  // SKIP — counts as unanswered for this player, never as correct.
  await sdb().from("mega_match_answers").upsert(
    {
      match_id: input.matchId,
      question_number: number,
      guest_id: guestId,
      option_index: null,
      skipped: true,
      is_correct: false,
      score_delta: 0,
      response_ms: 0,
    },
    { onConflict: "match_id,question_number,guest_id", ignoreDuplicates: true },
  );
  const { data: p } = await sdb()
    .from("mega_match_players")
    .select("unanswered_count")
    .eq("match_id", input.matchId)
    .eq("guest_id", guestId)
    .maybeSingle();
  await sdb()
    .from("mega_match_players")
    .update({ unanswered_count: Number(p?.["unanswered_count"] ?? 0) + 1 })
    .eq("match_id", input.matchId)
    .eq("guest_id", guestId);

  const after =
    match["mode"] === "solo"
      ? await advanceSolo(match, event, guestId)
      : await maybeResolveWhenAllAnswered(match, event);
  return buildMatchView(after, event, guestId);
}

/* ------------------------------------------------------------------ */
/* Disconnect / abandonment                                            */
/* ------------------------------------------------------------------ */

/** A player who stops sending heartbeats is flagged, never deleted or reset. */
export async function markDisconnected(matchId: string, staleMs = 60_000) {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  await sdb()
    .from("mega_match_players")
    .update({ state: "disconnected" })
    .eq("match_id", matchId)
    .eq("state", "playing")
    .lt("last_seen_at", cutoff);
}

/** Configured abandonment rule: a match with nobody left is abandoned. */
async function applyAbandonmentRule(match: Row) {
  const { data: players } = await sdb()
    .from("mega_match_players")
    .select("state")
    .eq("match_id", match["id"]);
  const remaining = (players ?? []).filter((p: Row) => p["state"] !== "left");
  if (remaining.length === 0) {
    await sdb()
      .from("mega_matches")
      .update({ status: "abandoned", ended_at: new Date().toISOString() })
      .eq("id", match["id"])
      .in("status", ["lobby", "ready", "active"]);
  }
}

/* ------------------------------------------------------------------ */
/* Completion, ranking and rewards                                     */
/* ------------------------------------------------------------------ */

async function loadResult(matchId: string): Promise<MegaResultView | null> {
  const { data } = await sdb()
    .from("mega_match_results")
    .select("*")
    .eq("match_id", matchId)
    .maybeSingle();
  if (!data) return null;
  return {
    matchId,
    eventId: String(data["event_id"]),
    mode: data["mode"] as MegaMode,
    outcome: String(data["outcome"]),
    winnerGuestId: (data["winner_guest_id"] as string) ?? null,
    standings: (data["standings"] as MegaStanding[]) ?? [],
    tieBreakReason: String(data["tie_break_reason"] ?? ""),
    startedAt: (data["started_at"] as string) ?? null,
    endedAt: (data["ended_at"] as string) ?? null,
    durationMs: Number(data["duration_ms"] ?? 0),
    questionCount: Number(data["question_count"]),
  };
}

/**
 * Finish the match exactly once: rank, persist the authoritative result,
 * credit coins, write per-player achievement rows and notify everyone.
 */
async function completeMatch(match: Row, event: Row): Promise<Row> {
  const matchId = String(match["id"]);

  // Atomic completion claim → no duplicate results / winners / payouts.
  const { data: claimed } = await sdb()
    .from("mega_matches")
    .update({ status: "completed", ended_at: new Date().toISOString() })
    .eq("id", matchId)
    .eq("status", "active")
    .select()
    .maybeSingle();
  if (!claimed) {
    const { data: fresh } = await sdb()
      .from("mega_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    return fresh ?? match;
  }

  const { data: playerRows } = await sdb()
    .from("mega_match_players")
    .select("*")
    .eq("match_id", matchId)
    .neq("state", "left");

  const scoring: MegaScoring = { ...DEFAULT_SCORING, ...((event["scoring"] as MegaScoring) ?? {}) };
  const rewards = (event["rewards"] as Record<string, number>) ?? {};
  const solo = match["mode"] === "solo";
  const questionCount = Number(match["question_count"]);

  type Tallied = {
    guestId: string;
    displayName: string;
    correctCount: number;
    wrongCount: number;
    unansweredCount: number;
    score: number;
    totalResponseMs: number;
    joinedAt: string;
  };

  const base: Tallied[] = (playerRows ?? []).map((p: Row): Tallied => {
    const answeredish = Number(p["correct_count"]) + Number(p["wrong_count"]);
    return {
      guestId: String(p["guest_id"]),
      displayName: String(p["display_name"] || displayNameFor(String(p["guest_id"]))),
      correctCount: Number(p["correct_count"]),
      wrongCount: Number(p["wrong_count"]),
      // Everything never reached also counts as unanswered.
      unansweredCount: Math.max(Number(p["unanswered_count"]), questionCount - answeredish),
      score: Number(p["score"]),
      totalResponseMs: Number(p["total_response_ms"]),
      joinedAt: String(p["joined_at"]),
    };
  });

  const { ranked, reason } = rankPlayers<Tallied>(base, scoring);

  let outcome = "COMPLETED";
  let winnerGuestId: string | null = null;
  const standings: MegaStanding[] = [];

  if (solo) {
    const me = ranked[0];
    const required = Number(event["solo_required_correct"]);
    // SINGLE-PLAYER RULE: >= 10 correct within the 10 minutes = WIN.
    outcome = me ? soloOutcome(me.correctCount, required) : "LOSS";
    const coins = outcome === "WIN" ? Number(rewards["soloWin"] ?? 0) : 0;
    if (me) {
      winnerGuestId = outcome === "WIN" ? me.guestId : null;
      standings.push({
        guestId: me.guestId,
        displayName: me.displayName,
        rank: 1,
        isWinner: outcome === "WIN",
        correctCount: me.correctCount,
        wrongCount: me.wrongCount,
        unansweredCount: me.unansweredCount,
        score: me.score,
        totalResponseMs: me.totalResponseMs,
        coinsAwarded: coins,
      });
    }
  } else {
    ranked.forEach((p, i) => {
      const rank = i + 1;
      const coins =
        rank === 1
          ? Number(rewards["winner"] ?? 0)
          : rank === 2
            ? Number(rewards["runnerUp"] ?? 0)
            : Number(rewards["participation"] ?? 0);
      if (rank === 1) winnerGuestId = p.guestId;
      standings.push({
        guestId: p.guestId,
        displayName: p.displayName,
        rank,
        isWinner: rank === 1,
        correctCount: p.correctCount,
        wrongCount: p.wrongCount,
        unansweredCount: p.unansweredCount,
        score: p.score,
        totalResponseMs: p.totalResponseMs,
        coinsAwarded: coins,
      });
    });
  }

  const startedAt = (claimed["started_at"] as string) ?? (match["started_at"] as string) ?? null;
  const endedAt = (claimed["ended_at"] as string) ?? new Date().toISOString();
  const durationMs = startedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : 0;

  await sdb()
    .from("mega_matches")
    .update({ winner_guest_id: winnerGuestId, tie_break_reason: reason })
    .eq("id", matchId);

  // unique(match_id) → the authoritative result exists exactly once.
  await sdb()
    .from("mega_match_results")
    .upsert(
      {
        match_id: matchId,
        event_id: String(match["event_id"]),
        mode: match["mode"],
        question_count: questionCount,
        winner_guest_id: winnerGuestId,
        outcome,
        standings,
        tie_break_reason: reason,
        started_at: startedAt,
        ended_at: endedAt,
        duration_ms: durationMs,
      },
      { onConflict: "match_id", ignoreDuplicates: true },
    );

  for (const s of standings) {
    await sdb()
      .from("mega_match_players")
      .update({ rank: s.rank })
      .eq("match_id", matchId)
      .eq("guest_id", s.guestId);

    // Clean per-player record — the future Trophy/Certificate source of truth.
    await sdb()
      .from("mega_player_results")
      .upsert(
        {
          match_id: matchId,
          guest_id: s.guestId,
          event_id: String(match["event_id"]),
          mode: match["mode"],
          rank: s.rank,
          is_winner: s.isWinner,
          correct_count: s.correctCount,
          wrong_count: s.wrongCount,
          unanswered_count: s.unansweredCount,
          score: s.score,
          total_response_ms: s.totalResponseMs,
          coins_awarded: s.coinsAwarded,
          outcome: solo ? outcome : s.isWinner ? "WIN" : "LOSS",
        },
        { onConflict: "match_id,guest_id", ignoreDuplicates: true },
      );

    await ledger(
      s.guestId,
      "mega_tournament",
      matchId,
      s.coinsAwarded,
      `Mega Tournament ${solo ? "single player" : `rank #${s.rank}`}`,
    );

    // Part 9: the match result in the player's own language.
    await notifyGuest(
      s.guestId,
      s.isWinner ? "tournament_won" : "tournament_lost",
      `mega:${matchId}:${s.guestId}:result`,
      {
        eventName: "Mega Tournament",
        reward: s.coinsAwarded,
        score: s.correctCount,
      },
      {
        referenceType: "mega_match",
        referenceId: matchId,
        metadata: {
          matchId,
          eventId: String(match["event_id"]),
          mode: match["mode"],
          rank: s.rank,
          correct: s.correctCount,
          outcome: solo ? outcome : s.isWinner ? "WIN" : "LOSS",
          coins: s.coinsAwarded,
        },
      },
    );

    // Part 4: verified winner → Mega Cup → Grandmaster / Ultra recalculation.
    // Idempotent and best-effort: it re-reads mega_player_results itself and
    // must never be able to fail a finished match.
    if (s.isWinner) {
      try {
        const { onMegaWin } = await import("./trophy-engine.server");
        await onMegaWin({
          guestId: s.guestId,
          eventId: String(match["event_id"]),
          matchId,
          metadata: { mode: match["mode"], questionCount },
        });
      } catch {
        /* trophies never break gameplay */
      }
    }
  }

  await sdb()
    .from("mega_lobby_presence")
    .update({ state: "available", match_id: null })
    .in(
      "guest_id",
      standings.map((s) => s.guestId),
    );

  const { data: fresh } = await sdb()
    .from("mega_matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();
  return fresh ?? claimed;
}

/* ------------------------------------------------------------------ */
/* Profile statistics (existing profile page — no new page)            */
/* ------------------------------------------------------------------ */

export async function megaProfileStats(token: unknown) {
  const guestId = await requireGuest(token);
  const { data } = await sdb()
    .from("mega_player_results")
    .select("*")
    .eq("guest_id", guestId)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows: Row[] = data ?? [];
  const wins = rows.filter((r) => r["is_winner"] || r["outcome"] === "WIN");

  return {
    matches: rows.length,
    wins: wins.length,
    losses: rows.length - wins.length,
    multiplayerWins: wins.filter((r) => r["mode"] === "multiplayer").length,
    soloWins: wins.filter((r) => r["mode"] === "solo").length,
    totalCorrect: rows.reduce((a, r) => a + Number(r["correct_count"] ?? 0), 0),
    bestCorrect: rows.reduce((a, r) => Math.max(a, Number(r["correct_count"] ?? 0)), 0),
    coinsFromTournament: rows.reduce((a, r) => a + Number(r["coins_awarded"] ?? 0), 0),
    history: rows.slice(0, 10).map((r) => ({
      matchId: String(r["match_id"]),
      mode: String(r["mode"]),
      rank: Number(r["rank"] ?? 0),
      correct: Number(r["correct_count"] ?? 0),
      outcome: String(r["outcome"]),
      coins: Number(r["coins_awarded"] ?? 0),
      at: String(r["created_at"]),
    })),
  };
}

/** Coin balance + pass status for the lobby header. */
export async function megaWallet(token: unknown) {
  const guestId = await requireGuest(token);
  const event = await getEventRow();
  const pass = await activePass(guestId, event);
  return {
    balance: await coinBalance(guestId),
    pass: pass ? passView(pass) : null,
    event: eventView(event),
    eventOpen: eventIsOpen(event),
  };
}
