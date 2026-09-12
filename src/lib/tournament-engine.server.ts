/**
 * USTAD AI — WEEKLY TOURNAMENT ENGINE (Mystery + Psychology, GOD MASTER).
 *
 * SERVER AUTHORITY. The client is a renderer: it sends an option index and
 * nothing else. Correct answers, score, win/loss, coins, locks, trophies and
 * certificates are all decided here.
 *
 * Nothing is re-implemented:
 *   identity / ownership → guest.server.ts           (requireGuest, service db)
 *   coins                → wallet.server.ts          (applyCoins, balanceOf)
 *   language + timezone  → notification.server.ts    (guestLocale, existing settings)
 *   notifications        → notification.server.ts    (notifyGuest)
 *   trophies             → trophy-engine.server.ts   (awardAchievement)
 *   certificates + QR    → certificate-engine.server (issued by the trophy award)
 *   question generation  → tournament-ai.server.ts   (existing router / providers)
 */
import { requireGuest, db } from "./guest.server";
import { applyCoins, balanceOf } from "./wallet.server";
import { guestLocale, notifyGuest } from "./notification.server";
import { awardAchievement } from "./trophy-engine.server";
import { coinOfferPrice, recordOfferPurchase } from "./coin-offer.server";
import { generateTournamentSet } from "./tournament-ai.server";
import {
  configFor,
  cycleFor,
  istDateKey,
  godTitleFor,
  isWin,
  stringsFor,
  type LockReason,
  type TournamentKind,
  type TournamentLanguage,
  type TournamentResultView,
  type TournamentReviewItem,
  type TournamentStateView,
  type TournamentQuestionView,
  GOD_TICKET,
} from "./tournament-spec";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sdb = () => db() as any;
type Row = Record<string, any>;

const ATTEMPTS = "tournament_attempts";
const QUESTIONS = "tournament_questions";

/* ------------------------------------------------------------------ */
/* Tickets                                                             */
/* ------------------------------------------------------------------ */

export async function ticketBalance(guestId: string): Promise<number> {
  const { data } = await sdb()
    .from("ustad_tickets")
    .select("god_tickets")
    .eq("guest_id", guestId)
    .maybeSingle();
  return Number((data as Row | null)?.["god_tickets"] ?? 0);
}

/**
 * Buy one God Tournament ticket with USTAD Coins.
 * The coin debit is idempotent (source + ref id) and the ticket is granted only
 * when the debit actually applied.
 */
export async function buyGodTicket(token: unknown): Promise<{
  tickets: number;
  balance: number;
  message: string;
}> {
  const guestId = await requireGuest(token);
  const price = GOD_TICKET.price;
  // A live Global Coin Offer discounts the ticket — the discounted amount is
  // what is actually charged (server-authoritative, never client-chosen).
  const offerPrice = await coinOfferPrice(price);
  const payable = offerPrice.finalPrice;
  const balance = await balanceOf(guestId);
  if (balance < payable)
    throw new Error(
      `Not enough USTAD Coins for a God Tournament Ticket${
        offerPrice.offerActive ? ` (offer price ${payable.toLocaleString("en-IN")})` : ""
      }.`,
    );

  const refId = `god_ticket:${guestId}:${Date.now()}`;
  const res = await applyCoins({
    guestId,
    source: "tournament_ticket",
    refId,
    amount: -payable,
    type: "purchase",
    note: offerPrice.offerActive
      ? `God Tournament Ticket (${offerPrice.discountPct}% OFF)`
      : "God Tournament Ticket",
  });
  // Audit the discounted transaction when an offer applied.
  if (offerPrice.offerActive) {
    await recordOfferPurchase({
      weeklyOfferId: offerPrice.weeklyOfferId!,
      guestId,
      itemKind: "ticket",
      itemId: GOD_TICKET.itemId,
      basePrice: price,
      discountPct: offerPrice.discountPct,
      discountAmount: offerPrice.discountAmount,
      finalPrice: payable,
      source: "tournament_ticket",
      refId,
    }).catch(() => {});
  }

  const { data } = await sdb().rpc("ustad_ticket_grant", { p_guest_id: guestId, p_amount: 1 });
  const tickets = Number(data ?? (await ticketBalance(guestId)));

  await notifyGuest(guestId, "shop_purchase", `god_ticket:${refId}`, {
    itemName: GOD_TICKET.name,
  }).catch(() => null);

  return {
    tickets,
    balance: Number(res?.balanceAfter ?? (await balanceOf(guestId))),
    message: "God Tournament Ticket added to your profile.",
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function activeAttempt(guestId: string, kind: TournamentKind): Promise<Row | null> {
  const { data } = await sdb()
    .from(ATTEMPTS)
    .select("*")
    .eq("guest_id", guestId)
    .eq("kind", kind)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data as Row[]) ?? [])[0] ?? null;
}

async function attemptsInCycle(guestId: string, kind: TournamentKind, cycleId: string) {
  const { data } = await sdb()
    .from(ATTEMPTS)
    .select("*")
    .eq("guest_id", guestId)
    .eq("kind", kind)
    .eq("cycle_id", cycleId);
  return (data as Row[]) ?? [];
}

async function questionsOf(attemptId: string): Promise<Row[]> {
  const { data } = await sdb()
    .from(QUESTIONS)
    .select("*")
    .eq("attempt_id", attemptId)
    .order("position", { ascending: true });
  return (data as Row[]) ?? [];
}

function publicQuestion(row: Row): TournamentQuestionView {
  const payload = (row["payload"] ?? {}) as Row;
  return {
    position: Number(row["position"]),
    prompt: String(row["prompt"] ?? ""),
    options: (row["options"] as string[]) ?? [],
    category: String(row["category"] ?? ""),
    difficulty: String(row["difficulty"] ?? ""),
    caseTitle: String(payload["caseTitle"] ?? ""),
    story: String(payload["story"] ?? ""),
    suspects: (payload["suspects"] as string[]) ?? [],
    clues: (payload["clues"] as string[]) ?? [],
    timeline: (payload["timeline"] as string[]) ?? [],
    selectedIndex: row["selected_index"] === null ? null : Number(row["selected_index"]),
  };
}

async function buildResult(attempt: Row): Promise<TournamentResultView> {
  const kind = String(attempt["kind"]) as TournamentKind;
  const cfg = configFor(kind);
  const rows = await questionsOf(String(attempt["id"]));
  const review: TournamentReviewItem[] = rows.map((r) => ({
    position: Number(r["position"]),
    prompt: String(r["prompt"] ?? ""),
    options: (r["options"] as string[]) ?? [],
    correctIndex: Number(r["correct_index"] ?? 0),
    selectedIndex: r["selected_index"] === null ? null : Number(r["selected_index"]),
    isCorrect: r["is_correct"] === true,
    explanation: String(r["explanation"] ?? ""),
    solution: String(r["solution"] ?? ""),
    caseTitle: String(((r["payload"] ?? {}) as Row)["caseTitle"] ?? ""),
  }));
  return {
    attemptId: String(attempt["id"]),
    result: (String(attempt["result"]) === "WIN" ? "WIN" : "LOSS") as "WIN" | "LOSS",
    correctCount: Number(attempt["correct_count"] ?? 0),
    wrongCount: Number(attempt["wrong_count"] ?? 0),
    questionCount: Number(attempt["total_questions"] ?? cfg.questionCount),
    requiredCorrect: cfg.requiredCorrect,
    coinsAwarded: Number(attempt["coins_awarded"] ?? 0),
    certificateUrl: String(attempt["certificate_url"] ?? ""),
    trophyAwarded: Boolean(attempt["achievement_id"]),
    review,
  };
}

/** Full state for one tournament screen. Score stays hidden while playing. */
export async function tournamentState(input: {
  token: unknown;
  kind: TournamentKind;
}): Promise<TournamentStateView> {
  const guestId = await requireGuest(input.token);
  const cfg = configFor(input.kind);
  const cycle = cycleFor(input.kind);
  const locale = await guestLocale(guestId);
  const language = locale.language as TournamentLanguage;
  const t = stringsFor(language);

  const [balance, tickets, cycleAttempts, active] = await Promise.all([
    balanceOf(guestId),
    input.kind === "god" ? ticketBalance(guestId) : Promise.resolve(0),
    attemptsInCycle(guestId, input.kind, cycle.id),
    activeAttempt(guestId, input.kind),
  ]);

  const wonThisCycle = cycleAttempts.some((a) => String(a["result"]) === "WIN");
  const today = istDateKey();
  const playedToday = cycleAttempts.some(
    (a) => String(a["attempt_date"]) === today && String(a["status"]) === "completed",
  );
  const completedInCycle = cycleAttempts.filter((a) => String(a["status"]) === "completed").length;

  let lock: LockReason = "open";
  if (wonThisCycle) lock = "won_this_week";
  else if (cfg.attemptsPerCycle > 0 && completedInCycle >= cfg.attemptsPerCycle)
    lock = "played_this_week";
  else if (playedToday) lock = "played_today";
  else if (cfg.requiresTicket && tickets < 1) lock = "no_ticket";
  else if (balance < cfg.entryFee) lock = "no_coins";

  const lockMessage =
    lock === "won_this_week"
      ? t.wonLock
      : lock === "played_this_week"
        ? t.playedWeek
        : lock === "played_today"
          ? t.playedToday
          : lock === "no_ticket"
            ? t.needTicket
            : lock === "no_coins"
              ? t.needCoins
              : "";

  let attemptView: TournamentStateView["attempt"] = null;
  if (active) {
    const rows = await questionsOf(String(active["id"]));
    const next = rows.find((r) => r["selected_index"] === null) ?? null;
    attemptView = {
      attemptId: String(active["id"]),
      answered: rows.filter((r) => r["selected_index"] !== null).length,
      questionCount: rows.length,
      question: next ? publicQuestion(next) : null,
    };
  }

  const { data: winRows } = await sdb()
    .from(ATTEMPTS)
    .select("id")
    .eq("guest_id", guestId)
    .eq("kind", input.kind)
    .eq("result", "WIN");
  const totalWins = ((winRows as Row[]) ?? []).length;

  const lastCompleted = cycleAttempts
    .filter((a) => String(a["status"]) === "completed")
    .sort((a, b) =>
      String(b["completed_at"] ?? "").localeCompare(String(a["completed_at"] ?? "")),
    )[0];

  return {
    kind: input.kind,
    title: cfg.title,
    language,
    cycle,
    entryFee: cfg.entryFee,
    winReward: cfg.winReward,
    questionCount: cfg.questionCount,
    requiredCorrect: cfg.requiredCorrect,
    requiresTicket: cfg.requiresTicket,
    ticketPrice: cfg.ticketPrice,
    balance,
    tickets,
    lock,
    lockMessage,
    canPlay: lock === "open" || Boolean(active),
    wonThisCycle,
    attempt: attemptView,
    lastResult: !active && lastCompleted ? await buildResult(lastCompleted) : null,
    badge:
      input.kind === "god"
        ? godTitleFor(totalWins)
        : totalWins > 0
          ? "Mystery Winner"
          : "Investigator",
    totalWins,
  };
}

/* ------------------------------------------------------------------ */
/* Start an attempt                                                     */
/* ------------------------------------------------------------------ */

export async function startTournament(input: {
  token: unknown;
  kind: TournamentKind;
}): Promise<TournamentStateView> {
  const guestId = await requireGuest(input.token);
  const cfg = configFor(input.kind);
  const cycle = cycleFor(input.kind);
  const today = istDateKey();
  const locale = await guestLocale(guestId);
  const language = locale.language as TournamentLanguage;
  const t = stringsFor(language);

  // Resume instead of charging twice — a refresh must never cost an entry.
  const existing = await activeAttempt(guestId, input.kind);
  if (existing) return tournamentState({ token: input.token, kind: input.kind });

  const cycleAttempts = await attemptsInCycle(guestId, input.kind, cycle.id);
  if (cycleAttempts.some((a) => String(a["result"]) === "WIN")) throw new Error(t.wonLock);
  const completed = cycleAttempts.filter((a) => String(a["status"]) === "completed");
  if (cfg.attemptsPerCycle > 0 && completed.length >= cfg.attemptsPerCycle)
    throw new Error(t.playedWeek);
  if (completed.some((a) => String(a["attempt_date"]) === today)) throw new Error(t.playedToday);

  if (cfg.requiresTicket && (await ticketBalance(guestId)) < 1) throw new Error(t.needTicket);
  if ((await balanceOf(guestId)) < cfg.entryFee) throw new Error(t.needCoins);

  // Reserve the day slot FIRST: the unique index makes a double-click, a second
  // tab and a retry all collapse into one attempt before any coin moves.
  const { data: created, error } = await sdb()
    .from(ATTEMPTS)
    .insert({
      guest_id: guestId,
      kind: input.kind,
      cycle_id: cycle.id,
      cycle_start: cycle.startsAt,
      cycle_end: cycle.endsAt,
      attempt_date: today,
      language,
      status: "active",
      total_questions: cfg.questionCount,
      entry_amount: cfg.entryFee,
    })
    .select()
    .maybeSingle();
  if (error || !created) throw new Error(t.playedToday);
  const attempt = created as Row;
  const attemptId = String(attempt["id"]);

  try {
    if (cfg.requiresTicket) {
      const { error: tErr } = await sdb().rpc("ustad_ticket_consume", { p_guest_id: guestId });
      if (tErr) throw new Error(t.needTicket);
      await sdb().from(ATTEMPTS).update({ ticket_consumed: true }).eq("id", attemptId);
    }

    // A live Global Coin Offer discounts the entry fee — charge the real price.
    const offerPrice = await coinOfferPrice(cfg.entryFee);
    const payable = offerPrice.finalPrice;
    const paid = await applyCoins({
      guestId,
      source: "tournament_entry",
      refId: attemptId,
      amount: -payable,
      type: "entry_fee",
      note: offerPrice.offerActive
        ? `${cfg.title} entry (${offerPrice.discountPct}% OFF)`
        : `${cfg.title} entry`,
    });
    if (offerPrice.offerActive) {
      await recordOfferPurchase({
        weeklyOfferId: offerPrice.weeklyOfferId!,
        guestId,
        itemKind: "tournament_entry",
        itemId: cfg.kind,
        basePrice: cfg.entryFee,
        discountPct: offerPrice.discountPct,
        discountAmount: offerPrice.discountAmount,
        finalPrice: payable,
        source: "tournament_entry",
        refId: attemptId,
      }).catch(() => {});
    }
    await sdb()
      .from(ATTEMPTS)
      .update({ entry_txn_id: String(paid?.transactionId ?? ""), entry_amount: payable })
      .eq("id", attemptId);

    const { data: pastRows } = await sdb()
      .from(QUESTIONS)
      .select("prompt")
      .order("created_at", { ascending: false })
      .limit(60);
    const avoid = ((pastRows as Row[]) ?? []).map((r) => String(r["prompt"] ?? "")).filter(Boolean);

    const { items } = await generateTournamentSet({
      kind: input.kind,
      guestId,
      language,
      avoid,
      seed: Math.floor(Math.random() * 100000),
      count: cfg.questionCount,
    });

    await sdb()
      .from(QUESTIONS)
      .insert(
        items.map((q, i) => ({
          attempt_id: attemptId,
          position: i + 1,
          prompt: q.prompt,
          options: q.options,
          correct_index: q.correctIndex,
          explanation: q.explanation,
          solution: q.solution,
          difficulty: q.difficulty,
          category: q.category,
          payload: {
            caseTitle: q.caseTitle,
            story: q.story,
            suspects: q.suspects,
            clues: q.clues,
            timeline: q.timeline,
          },
        })),
      );

    await notifyGuest(guestId, "tournament_started", `tournament_start:${attemptId}`, {
      eventName: cfg.title,
    }).catch(() => null);
  } catch (e) {
    // Preparation failed → refund everything and free the day slot.
    await refundAndCancel(guestId, attempt, cfg.requiresTicket);
    throw e;
  }

  return tournamentState({ token: input.token, kind: input.kind });
}

async function refundAndCancel(guestId: string, attempt: Row, hadTicket: boolean) {
  const attemptId = String(attempt["id"]);
  try {
    // Entry refund for every cancelled attempt. Older attempts may not carry an
    // entry_txn_id, so the refund is intentionally unconditional (pre-existing
    // behaviour preserved — the previous `entry_txn_id || true` was always true).
    await applyCoins({
      guestId,
      source: "tournament_refund",
      refId: attemptId,
      amount: Number(attempt["entry_amount"] ?? 0),
      type: "refund",
      note: "Tournament could not start — entry refunded",
    }).catch(() => null);
    if (hadTicket) {
      await sdb().rpc("ustad_ticket_grant", { p_guest_id: guestId, p_amount: 1 });
    }
  } finally {
    await sdb().from(ATTEMPTS).delete().eq("id", attemptId);
  }
}

/* ------------------------------------------------------------------ */
/* Answer + finalize                                                    */
/* ------------------------------------------------------------------ */

export async function answerTournament(input: {
  token: unknown;
  attemptId: string;
  position: number;
  optionIndex: number;
}): Promise<TournamentStateView> {
  const guestId = await requireGuest(input.token);
  const { data: aData } = await sdb()
    .from(ATTEMPTS)
    .select("*")
    .eq("id", input.attemptId)
    .eq("guest_id", guestId)
    .maybeSingle();
  const attempt = (aData as Row) ?? null;
  if (!attempt) throw new Error("Tournament attempt not found.");
  const kind = String(attempt["kind"]) as TournamentKind;
  if (String(attempt["status"]) !== "active") return tournamentState({ token: input.token, kind });

  // Validate that we're answering the expected question (prevent stale/out-of-order submissions)
  const currentIndex = Number(attempt["current_index"] ?? 0);
  const expectedPosition = currentIndex + 1;
  if (input.position !== expectedPosition) {
    // Already moved past this question or answering out of order
    return tournamentState({ token: input.token, kind });
  }

  const { data: qData } = await sdb()
    .from(QUESTIONS)
    .select("*")
    .eq("attempt_id", input.attemptId)
    .eq("position", input.position)
    .maybeSingle();
  const question = (qData as Row) ?? null;
  if (!question) throw new Error("Question not found.");

  // Anti-cheat: an answer is locked once and never re-scored.
  // Also prevent duplicate submissions for the same question
  if (question["selected_index"] === null) {
    const chosen = Math.max(0, Math.min(3, Math.floor(Number(input.optionIndex))));
    const correct = chosen === Number(question["correct_index"]);
    const { data: claimed } = await sdb()
      .from(QUESTIONS)
      .update({
        selected_index: chosen,
        is_correct: correct,
        answered_at: new Date().toISOString(),
      })
      .eq("id", question["id"])
      .is("selected_index", null)
      .select()
      .maybeSingle();
    if (!claimed) {
      // Another request already answered this question
      return tournamentState({ token: input.token, kind });
    }
  } else {
    // Question already answered - prevent duplicate scoring
    return tournamentState({ token: input.token, kind });
  }

  const rows = await questionsOf(input.attemptId);
  const answered = rows.filter((r) => r["selected_index"] !== null);
  const nextIndex = answered.length;
  await sdb().from(ATTEMPTS).update({ current_index: nextIndex }).eq("id", input.attemptId);

  if (answered.length >= rows.length && rows.length > 0) {
    await finalize(guestId, { ...attempt, current_index: answered.length }, rows);
  }

  return tournamentState({ token: input.token, kind });
}

async function finalize(guestId: string, attempt: Row, rows: Row[]) {
  const attemptId = String(attempt["id"]);
  const kind = String(attempt["kind"]) as TournamentKind;
  const cfg = configFor(kind);
  const correct = rows.filter((r) => r["is_correct"] === true).length;
  const wrong = rows.length - correct;
  const won = isWin(kind, correct);

  const { data: updated } = await sdb()
    .from(ATTEMPTS)
    .update({
      status: "completed",
      result: won ? "WIN" : "LOSS",
      correct_count: correct,
      wrong_count: wrong,
      score: correct * 10,
      completed_at: new Date().toISOString(),
    })
    .eq("id", attemptId)
    .eq("status", "active") // only the first finalizer wins
    .select()
    .maybeSingle();
  if (!updated) return; // already finalized by a concurrent request

  if (!won) {
    await notifyGuest(guestId, "tournament_lost", `tournament_result:${attemptId}`, {
      eventName: cfg.title,
    }).catch(() => null);
    return;
  }

  // ---- Winner: coins (idempotent), trophy, certificate, notification ----
  const paid = await applyCoins({
    guestId,
    source: "tournament_reward",
    refId: attemptId,
    amount: cfg.winReward,
    type: "reward",
    note: `${cfg.title} winner reward`,
  }).catch(() => null);

  const award = await awardAchievement({
    guestId,
    type: "normal_cup",
    eventId: null,
    matchId: attemptId,
    eventKind: kind === "god" ? "god_tournament" : "mystery_tournament",
    eventName: cfg.title,
    tournament: cfg.title,
    source: "tournament_attempts",
    metadata: { correct, total: rows.length, coins: cfg.winReward, kind },
  }).catch(() => ({ created: false, achievementId: null }));

  let certificateUrl = "";
  if (award.achievementId) {
    try {
      const { data: cert } = await sdb()
        .from("ustad_certificates")
        .select("*")
        .eq("achievement_id", award.achievementId)
        .maybeSingle();
      const row = (cert as Row) ?? null;
      const token = String(row?.["verification_token"] ?? row?.["public_token"] ?? "");
      const { publicOrigin } = await import("./certificate-engine.server");
      if (token) certificateUrl = `${publicOrigin()}/verify/certificate/${token}`;
    } catch {
      /* a certificate hiccup never blocks the win */
    }
  }

  await sdb()
    .from(ATTEMPTS)
    .update({
      reward_issued: true,
      reward_txn_id: String(paid?.transactionId ?? ""),
      coins_awarded: cfg.winReward,
      achievement_id: award.achievementId,
      certificate_url: certificateUrl,
    })
    .eq("id", attemptId);

  await notifyGuest(guestId, "tournament_won", `tournament_result:${attemptId}`, {
    eventName: cfg.title,
    amount: cfg.winReward,
  }).catch(() => null);
}

/* ------------------------------------------------------------------ */
/* Review + leaderboard                                                 */
/* ------------------------------------------------------------------ */

export async function tournamentReview(input: {
  token: unknown;
  attemptId: string;
}): Promise<TournamentResultView> {
  const guestId = await requireGuest(input.token);
  const { data } = await sdb()
    .from(ATTEMPTS)
    .select("*")
    .eq("id", input.attemptId)
    .eq("guest_id", guestId)
    .maybeSingle();
  const attempt = (data as Row) ?? null;
  if (!attempt) throw new Error("Tournament attempt not found.");
  if (String(attempt["status"]) !== "completed")
    throw new Error("The review opens after question 20.");
  return buildResult(attempt);
}

export type TournamentRankRow = {
  rank: number;
  guestId: string;
  displayName: string;
  wins: number;
  bestCorrect: number;
  title: string;
  isSelf: boolean;
};

/** Verified top-20 ranking, built only from finalized winning attempts. */
export async function tournamentLeaderboard(input: {
  token: unknown;
  kind: TournamentKind;
}): Promise<TournamentRankRow[]> {
  const guestId = await requireGuest(input.token);
  const { data } = await sdb()
    .from(ATTEMPTS)
    .select("guest_id,result,correct_count")
    .eq("kind", input.kind)
    .eq("status", "completed");
  const rows = (data as Row[]) ?? [];
  const byGuest = new Map<string, { wins: number; best: number }>();
  for (const r of rows) {
    const g = String(r["guest_id"]);
    const cur = byGuest.get(g) ?? { wins: 0, best: 0 };
    if (String(r["result"]) === "WIN") cur.wins += 1;
    cur.best = Math.max(cur.best, Number(r["correct_count"] ?? 0));
    byGuest.set(g, cur);
  }
  return [...byGuest.entries()]
    .filter(([, v]) => v.wins > 0 || v.best > 0)
    .sort((a, b) => b[1].wins - a[1].wins || b[1].best - a[1].best || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([g, v], i) => ({
      rank: i + 1,
      guestId: g,
      displayName: `Player ${g.slice(-4).toUpperCase()}`,
      wins: v.wins,
      bestCorrect: v.best,
      title:
        input.kind === "god" ? godTitleFor(v.wins) : v.wins > 0 ? "Mystery Winner" : "Investigator",
      isSelf: g === guestId,
    }));
}

/** Short factual summary the existing chat assistant can quote. */
export async function tournamentContext(guestId: string): Promise<string> {
  try {
    const { data } = await sdb()
      .from(ATTEMPTS)
      .select("kind,result,correct_count,coins_awarded,completed_at")
      .eq("guest_id", guestId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(6);
    const rows = (data as Row[]) ?? [];
    if (!rows.length) return "";
    const wins = rows.filter((r) => String(r["result"]) === "WIN").length;
    const lines = rows.map(
      (r) =>
        `- ${r["kind"] === "god" ? "GOD MASTER" : "Mystery + Psychology"} tournament: ${r["result"]} with ${r["correct_count"]}/20 correct`,
    );
    return [
      `USTAD weekly tournaments — recent attempts (${wins} win(s)):`,
      ...lines,
      `God Tournament title: ${godTitleFor(
        rows.filter((r) => r["kind"] === "god" && String(r["result"]) === "WIN").length,
      )}`,
    ].join("\n");
  } catch {
    return "";
  }
}
