/**
 * USTAD AI — MASTER EVENT ENGINE (Part 6) · server authority.
 *
 * ORCHESTRATION ONLY. This file is the one place that knows about *all* events,
 * but it re-implements none of them:
 *
 *   identity / ownership   → guest.server.ts        (requireGuest, service db)
 *   question generation    → crorepati-ai.server.ts (generateQuizSet, one fixed count)
 *   Crorepati gameplay     → crorepati-engine.server.ts   (Part 1, untouched)
 *   Mega gameplay & lobby  → mega-engine.server.ts        (Part 2, untouched)
 *   free entries           → crorepati-entry.server.ts    (Part 3, untouched)
 *   trophies               → trophy-engine.server.ts      (Part 4)
 *   certificates + QR      → certificate-engine.server.ts (Part 5, via trophies)
 *   timers                 → server timestamps + chrono-engine.ts on the client
 *   notifications          → the existing `reminders` feed
 *   coins                  → the existing `ustad_coin_ledger`
 *
 * Only DYNAMIC events (type C) are played through this engine. Crorepati and
 * Mega events are merely *registered* here so that one registry, one lifecycle
 * and one leaderboard surface can describe every event in USTAD AI.
 *
 * SECURITY: correct answers, deadlines, status, scores and rewards are decided
 * here. The client is a renderer that sends option indexes.
 */
import { randomUUID } from "node:crypto";

import { requireGuest, db } from "./guest.server";
import { notifyGuest } from "./notification.server";
import { applyCoins, balanceOf } from "./wallet.server";
import { coinOfferCharge } from "./coin-offer.server";
import { generateQuizSet, questionHash, ladderDifficulty } from "./crorepati-ai.server";
import type { Language } from "./router.server";
import { onMasterEventWin } from "./trophy-engine.server";
import {
  MASTER_ENGINE_VERSION,
  REWARD_SOURCE,
  acceptsEntries,
  assertQuestionSetUsable,
  calculateReward,
  canTransition,
  checkAnswer,
  detectImpossibleState,
  evaluateEntry,
  idempotencyKey,
  isEditable,
  isLegacyEventType,
  isWin,
  rankResults,
  resolveQuestionCount,
  rewardRefId,
  scheduledStatus,
  validateEventDraft,
  type EntryConfig,
  type EventStatus,
  type EventType,
  type GameState,
  type RewardConfig,
} from "./master-event-spec";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sdb = () => db() as any;
type Row = Record<string, any>;

/* ------------------------------------------------------------------ */
/* Authorization for event authoring                                   */
/* ------------------------------------------------------------------ */

/**
 * Creating, publishing, cancelling and finalizing an event are OPERATOR
 * actions. USTAD AI has no admin accounts, so authority comes from a
 * server-only allowlist of guest ids in `USTAD_EVENT_ADMINS`. If the variable
 * is unset nobody is authorized — the safe default.
 */
function isOperator(guestId: string): boolean {
  const list = (process.env["USTAD_EVENT_ADMINS"] ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(guestId);
}

async function requireOperator(token: unknown): Promise<string> {
  const guestId = await requireGuest(token);
  if (!isOperator(guestId)) throw new Error("You are not authorized to manage events.");
  return guestId;
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

async function audit(entry: {
  eventId?: string | null;
  guestId?: string | null;
  action: string;
  fromStatus?: string;
  toStatus?: string;
  reason?: string;
  detail?: Row;
}) {
  try {
    await sdb()
      .from("master_event_audit")
      .insert({
        event_id: entry.eventId ?? null,
        guest_id: entry.guestId ?? null,
        action: entry.action,
        from_status: entry.fromStatus ?? "",
        to_status: entry.toStatus ?? "",
        reason: entry.reason ?? "",
        engine_version: MASTER_ENGINE_VERSION,
        detail: entry.detail ?? {},
      });
  } catch {
    /* auditing must never break gameplay */
  }
}

/* ------------------------------------------------------------------ */
/* Coins & notifications (shared, never duplicated)                    */
/* ------------------------------------------------------------------ */

/**
 * The authoritative balance. Part 7 routes this through the ONE wallet module
 * so every engine reads the same permanent, database-backed number.
 */
async function coinBalance(guestId: string): Promise<number> {
  return balanceOf(guestId);
}

/** Idempotent: unique(guest_id, source, ref_id) makes a replay a no-op. */
async function ledger(guestId: string, refId: string, coins: number, note: string) {
  if (!coins) return;
  await applyCoins({
    guestId,
    source: "master_event",
    refId,
    amount: coins,
    type: "master_event",
    note,
  });
}

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
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* Event access                                                        */
/* ------------------------------------------------------------------ */

async function eventByCode(code: string): Promise<Row | null> {
  const { data } = await sdb().from("master_events").select("*").eq("code", code).maybeSingle();
  return (data as Row) ?? null;
}

async function eventById(id: string): Promise<Row | null> {
  const { data } = await sdb().from("master_events").select("*").eq("id", id).maybeSingle();
  return (data as Row) ?? null;
}

/**
 * Applies the schedule to an event using SERVER time only, and persists the
 * result. This is how an event becomes `open` / `closed` without a cron job:
 * any read reconciles it. Client clocks are never consulted.
 */
async function reconcileStatus(event: Row): Promise<Row> {
  const current = String(event["status"]) as EventStatus;
  const want = scheduledStatus(
    current,
    event["start_time"] ? String(event["start_time"]) : null,
    event["end_time"] ? String(event["end_time"]) : null,
    Date.now(),
  );
  if (want === current || !canTransition(current, want)) return event;
  const { data } = await sdb()
    .from("master_events")
    .update({ status: want, updated_at: new Date().toISOString() })
    .eq("id", event["id"])
    .eq("status", current) // optimistic: concurrent reconciles cannot double-apply
    .select()
    .maybeSingle();
  const next = (data as Row) ?? event;
  if (data) {
    await audit({
      eventId: String(event["id"]),
      action: "transitioned",
      fromStatus: current,
      toStatus: want,
      reason: "schedule reached on server time",
    });
  }
  return next;
}

export type MasterEventView = {
  id: string;
  code: string;
  name: string;
  description: string;
  eventType: EventType;
  status: EventStatus;
  startTime: string | null;
  endTime: string | null;
  /** Fixed at configuration time. Identical for every player, every attempt. */
  questionCount: number;
  preTimerSeconds: number;
  answerTimerSeconds: number;
  totalTimerSeconds: number;
  multiplayerEnabled: boolean;
  minPlayers: number;
  maxPlayers: number;
  requiredCorrect: number;
  leaderboardEnabled: boolean;
  entryType: string;
  entryCoinCost: number;
  rewardSummary: string;
  serverNow: string;
  playable: boolean;
  managedBy: string;
  /** Per-guest entry lock: already won this event, or today's single try used. */
  locked?: boolean;
  lockKind?: "won" | "daily" | null;
  lockReason?: string | null;
};

function toView(e: Row): MasterEventView {
  const entry = (e["entry_config"] ?? {}) as EntryConfig;
  const reward = (e["reward_config"] ?? {}) as RewardConfig;
  const type = String(e["event_type"]) as EventType;
  const parts: string[] = [];
  if (reward.perCorrect) parts.push(`${reward.perCorrect} per correct`);
  if (reward.win) parts.push(`${reward.win} on a win`);
  if (reward.participation) parts.push(`${reward.participation} for taking part`);
  return {
    id: String(e["id"]),
    code: String(e["code"]),
    name: String(e["name"]),
    description: String(e["description"] ?? ""),
    eventType: type,
    status: String(e["status"]) as EventStatus,
    startTime: e["start_time"] ? String(e["start_time"]) : null,
    endTime: e["end_time"] ? String(e["end_time"]) : null,
    questionCount: Number(e["question_count"]),
    preTimerSeconds: Number(e["pre_timer_seconds"]),
    answerTimerSeconds: Number(e["answer_timer_seconds"]),
    totalTimerSeconds: Number(e["total_timer_seconds"] ?? 0),
    multiplayerEnabled: Boolean(e["multiplayer_enabled"]),
    minPlayers: Number(e["min_players"] ?? 1),
    maxPlayers: Number(e["max_players"] ?? 1),
    requiredCorrect: Number(e["required_correct"] ?? 0),
    leaderboardEnabled: Boolean(e["leaderboard_enabled"]),
    entryType: String(entry.type ?? "free"),
    entryCoinCost: Number(entry.coinCost ?? 0),
    rewardSummary: parts.length ? `${parts.join(" · ")} USTAD Coins` : "No coin reward",
    serverNow: new Date().toISOString(),
    // Only dynamic events are played through this engine; the others deep-link
    // to their own screens so Part 1 / Part 2 rules stay in charge.
    playable: type === "dynamic",
    managedBy: isLegacyEventType(type) ? `${type} engine` : "master event engine",
  };
}

/* ------------------------------------------------------------------ */
/* Per-guest entry lock                                                */
/* ------------------------------------------------------------------ */

/** Start of the current India day (05:30 UTC boundary), as an ISO timestamp. */
function startOfIndiaDayIso(now: Date = new Date()): string {
  const IST = 5.5 * 3_600_000;
  const shifted = now.getTime() + IST;
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000;
  return new Date(dayStart - IST).toISOString();
}

export type EntryLock = {
  locked: boolean;
  kind: "won" | "daily" | null;
  reason: string | null;
};

const UNLOCKED: EntryLock = { locked: false, kind: null, reason: null };

/**
 * Two rules, both per guest and per event:
 *   • WON → the event is locked for this guest until the next event opens.
 *   • LOST → one try per India day while the event is still running.
 * A live (active) attempt is never blocked; it is resumed instead.
 */
export async function entryLock(guestId: string, event: Row): Promise<EntryLock> {
  if (String(event["event_type"]) !== "dynamic") return UNLOCKED;
  const eventId = event["id"];

  const { data: won } = await sdb()
    .from("master_event_results")
    .select("id")
    .eq("event_id", eventId)
    .eq("guest_id", guestId)
    .eq("is_winner", true)
    .limit(1)
    .maybeSingle();
  if (won) {
    return {
      locked: true,
      kind: "won",
      reason: "You have already won this event. It unlocks when the next event opens.",
    };
  }

  const { data: today } = await sdb()
    .from("master_event_attempts")
    .select("id,status")
    .eq("event_id", eventId)
    .eq("guest_id", guestId)
    .gte("started_at", startOfIndiaDayIso())
    .limit(5);
  const rows = ((today ?? []) as Row[]).filter((r) => String(r["status"]) !== "active");
  if (rows.length > 0) {
    return {
      locked: true,
      kind: "daily",
      reason: "One try per day for this event. Come back tomorrow (India time).",
    };
  }
  return UNLOCKED;
}

/** Autopilot runs at most once a minute per server instance. */
let lastAutopilotMs = 0;

async function autopilotIfDue(): Promise<void> {
  if (Date.now() - lastAutopilotMs < 60_000) return;
  lastAutopilotMs = Date.now();
  try {
    const { runEventAutopilotTick } = await import("./event-autopilot.server");
    await runEventAutopilotTick();
  } catch (error) {
    console.error("event autopilot failed", error);
  }
}

/**
 * Public list of events. Drafts are operator-only.
 *
 * ONE EVENT AT A TIME: an archived event (replaced by the next one) and a
 * future auto-generated event that has only been announced are not listed. The
 * running event stays listed until its successor actually opens.
 */
export async function listEvents(token: unknown): Promise<MasterEventView[]> {
  const guestId = await requireGuest(token);
  await autopilotIfDue();
  const { data } = await sdb()
    .from("master_events")
    .select("*")
    .order("start_time", { ascending: true, nullsFirst: false })
    .limit(100);
  const nowMs = Date.now();
  const rows = ((data ?? []) as Row[]).filter((e) => {
    const status = String(e["status"]);
    if (!isOperator(guestId) && status === "draft") return false;
    if (status === "archived") return false;
    const start = e["start_time"] ? Date.parse(String(e["start_time"])) : NaN;
    const auto = Boolean((e["gameplay_config"] ?? {})["autoGenerated"]);
    if (auto && Number.isFinite(start) && start > nowMs) return false;
    return true;
  });
  const reconciled: Row[] = [];
  for (const row of rows) reconciled.push(await reconcileStatus(row));
  const views: MasterEventView[] = [];
  for (const row of reconciled.filter((e) => String(e["status"]) !== "archived")) {
    const view = toView(row);
    const lock = await entryLock(guestId, row);
    views.push({ ...view, locked: lock.locked, lockKind: lock.kind, lockReason: lock.reason });
  }
  return views;
}

export async function getEvent(input: {
  token: unknown;
  code: string;
}): Promise<MasterEventView | null> {
  const guestId = await requireGuest(input.token);
  const event = await eventByCode(input.code);
  if (!event) return null;
  const row = await reconcileStatus(event);
  const lock = await entryLock(guestId, row);
  return { ...toView(row), locked: lock.locked, lockKind: lock.kind, lockReason: lock.reason };
}

/* ------------------------------------------------------------------ */
/* Event authoring (operator only)                                     */
/* ------------------------------------------------------------------ */

export async function createEvent(input: {
  token: unknown;
  code: string;
  name: string;
  description?: string;
  /** Fixed number of questions. Cannot change once the event is published. */
  questionCount: number;
  startTime?: string;
  endTime?: string;
  preTimerSeconds?: number;
  answerTimerSeconds?: number;
  totalTimerSeconds?: number;
  multiplayerEnabled?: boolean;
  minPlayers?: number;
  maxPlayers?: number;
  requiredCorrect?: number;
  category?: string;
  difficulty?: string;
  entryConfig?: EntryConfig;
  rewardConfig?: RewardConfig;
  eliminatedOnWrong?: boolean;
  awardTrophy?: boolean;
  certificateEnabled?: boolean;
}): Promise<{ id: string; code: string }> {
  const guestId = await requireOperator(input.token);

  const issues = validateEventDraft({
    code: input.code,
    name: input.name,
    eventType: "dynamic",
    questionCount: input.questionCount,
    startTime: input.startTime,
    endTime: input.endTime,
    minPlayers: input.minPlayers ?? 1,
    maxPlayers: input.maxPlayers ?? 1,
    multiplayerEnabled: input.multiplayerEnabled ?? false,
    answerTimerSeconds: input.answerTimerSeconds ?? 90,
    preTimerSeconds: input.preTimerSeconds ?? 10,
    requiredCorrect: input.requiredCorrect ?? 0,
  });
  if (issues.length) throw new Error(`Event configuration rejected: ${issues.join("; ")}`);

  const count = resolveQuestionCount(input.questionCount);

  const { data, error } = await sdb()
    .from("master_events")
    .insert({
      code: input.code.trim(),
      name: input.name.trim(),
      description: (input.description ?? "").trim(),
      event_type: "dynamic",
      status: "draft",
      question_count: count,
      start_time: input.startTime ?? null,
      end_time: input.endTime ?? null,
      pre_timer_seconds: input.preTimerSeconds ?? 10,
      answer_timer_seconds: input.answerTimerSeconds ?? 90,
      total_timer_seconds: input.totalTimerSeconds ?? 0,
      multiplayer_enabled: input.multiplayerEnabled ?? false,
      min_players: input.minPlayers ?? 1,
      max_players: input.maxPlayers ?? 1,
      required_correct: input.requiredCorrect ?? 0,
      category: input.category ?? "mixed",
      difficulty: input.difficulty ?? "mixed",
      entry_config: input.entryConfig ?? { type: "free" },
      reward_config: input.rewardConfig ?? { perCorrect: 0, win: 0, participation: 0 },
      gameplay_config: { eliminatedOnWrong: input.eliminatedOnWrong ?? false },
      achievement_config: { awardTrophy: input.awardTrophy ?? false, trophyType: "normal_cup" },
      certificate_config: { enabled: input.certificateEnabled ?? false },
      leaderboard_enabled: true,
      created_by: guestId,
    })
    .select("id,code")
    .single();
  if (error) throw new Error(error.message);

  await audit({
    eventId: String(data["id"]),
    guestId,
    action: "created",
    toStatus: "draft",
    detail: { questionCount: count },
  });
  return { id: String(data["id"]), code: String(data["code"]) };
}

/**
 * The only way an event's status ever changes by hand. The requested target is
 * checked against the state machine, so no client can jump an event straight to
 * `finalized` or reopen an archived one.
 */
export async function transitionEvent(input: {
  token: unknown;
  eventId: string;
  to: EventStatus;
  reason?: string;
}): Promise<{ status: EventStatus }> {
  const guestId = await requireOperator(input.token);
  const event = await eventById(input.eventId);
  if (!event) throw new Error("Event not found.");
  const from = String(event["status"]) as EventStatus;
  if (!canTransition(from, input.to)) {
    throw new Error(`Cannot move an event from ${from} to ${input.to}.`);
  }

  const patch: Row = { status: input.to, updated_at: new Date().toISOString() };
  if (input.to === "open" || input.to === "scheduled")
    patch["published_at"] = new Date().toISOString();
  if (input.to === "finalized") patch["finalized_at"] = new Date().toISOString();
  if (input.to === "cancelled") {
    patch["cancelled_at"] = new Date().toISOString();
    patch["cancel_reason"] = input.reason ?? "";
  }

  const { data } = await sdb()
    .from("master_events")
    .update(patch)
    .eq("id", input.eventId)
    .eq("status", from) // idempotent: a replayed request finds nothing to change
    .select("status")
    .maybeSingle();
  if (!data) return { status: from };

  await audit({
    eventId: input.eventId,
    guestId,
    action: input.to === "cancelled" ? "cancelled" : "transitioned",
    fromStatus: from,
    toStatus: input.to,
    reason: input.reason ?? "",
  });
  return { status: input.to };
}

/** Configuration edits are refused once an event has been published. */
export async function updateEventConfig(input: {
  token: unknown;
  eventId: string;
  name?: string;
  description?: string;
  questionCount?: number;
  startTime?: string;
  endTime?: string;
  rewardConfig?: RewardConfig;
  entryConfig?: EntryConfig;
}): Promise<{ updated: boolean }> {
  const guestId = await requireOperator(input.token);
  const event = await eventById(input.eventId);
  if (!event) throw new Error("Event not found.");
  const status = String(event["status"]) as EventStatus;
  if (!isEditable(status)) throw new Error(`A ${status} event can no longer be reconfigured.`);

  const patch: Row = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch["name"] = input.name.trim();
  if (input.description !== undefined) patch["description"] = input.description.trim();
  if (input.questionCount !== undefined)
    patch["question_count"] = resolveQuestionCount(input.questionCount);
  if (input.startTime !== undefined) patch["start_time"] = input.startTime;
  if (input.endTime !== undefined) patch["end_time"] = input.endTime;
  if (input.rewardConfig !== undefined) patch["reward_config"] = input.rewardConfig;
  if (input.entryConfig !== undefined) patch["entry_config"] = input.entryConfig;

  await sdb().from("master_events").update(patch).eq("id", input.eventId).eq("status", status);
  await audit({ eventId: input.eventId, guestId, action: "config_changed", detail: patch });
  return { updated: true };
}

/* ------------------------------------------------------------------ */
/* Attempt lifecycle (dynamic events)                                  */
/* ------------------------------------------------------------------ */

export type MasterQuestionView = {
  questionNumber: number;
  question: string;
  options: string[];
  difficulty: string;
  category: string;
  hint: string;
};

export type MasterAttemptView = {
  attemptId: string;
  eventCode: string;
  eventName: string;
  status: string;
  gameState: GameState;
  questionCount: number;
  currentQuestion: number;
  correctCount: number;
  wrongCount: number;
  score: number;
  coinReward: number;
  result: string;
  question: MasterQuestionView | null;
  /** Server deadlines. The client renders them with the existing Chrono engine. */
  answerTimerStartsAt: string | null;
  deadlineAt: string | null;
  totalDeadlineAt: string | null;
  serverNow: string;
};

async function questionRow(attemptId: string, n: number): Promise<Row | null> {
  const { data } = await sdb()
    .from("master_event_attempt_questions")
    .select("*")
    .eq("attempt_id", attemptId)
    .eq("question_number", n)
    .maybeSingle();
  return (data as Row) ?? null;
}

/** Never includes `correct_index` — the answer stays on the server. */
function viewAttempt(attempt: Row, event: Row, q: Row | null): MasterAttemptView {
  return {
    attemptId: String(attempt["id"]),
    eventCode: String(event["code"]),
    eventName: String(event["name"]),
    status: String(attempt["status"]),
    gameState: String(attempt["game_state"]) as GameState,
    questionCount: Number(attempt["question_count"]),
    currentQuestion: Number(attempt["current_question"]),
    correctCount: Number(attempt["correct_count"] ?? 0),
    wrongCount: Number(attempt["wrong_count"] ?? 0),
    score: Number(attempt["score"] ?? 0),
    coinReward: Number(attempt["coin_reward"] ?? 0),
    result: String(attempt["result"] ?? ""),
    question: q
      ? {
          questionNumber: Number(q["question_number"]),
          question: String(q["question"]),
          options: (q["options"] ?? []) as string[],
          difficulty: String(q["difficulty"] ?? "medium"),
          category: String(q["category"] ?? ""),
          hint: String(q["hint"] ?? ""),
        }
      : null,
    answerTimerStartsAt: attempt["answer_timer_starts_at"]
      ? String(attempt["answer_timer_starts_at"])
      : null,
    deadlineAt: attempt["deadline_at"] ? String(attempt["deadline_at"]) : null,
    totalDeadlineAt: attempt["total_deadline_at"] ? String(attempt["total_deadline_at"]) : null,
    serverNow: new Date().toISOString(),
  };
}

/**
 * Builds the question set for one attempt.
 *
 * The COUNT comes from the event configuration and nothing else. The CONTENT is
 * generated fresh every time by the existing generator, seeded and filtered
 * against everything this guest has already been served for this event.
 */
async function buildQuestions(input: {
  language: Language;
  guestId: string;
  event: Row;
  count: number;
}): Promise<Array<Row>> {
  const { data: served } = await sdb()
    .from("master_event_served_questions")
    .select("question_hash")
    .eq("event_id", input.event["id"])
    .eq("guest_id", input.guestId)
    .limit(600);
  const avoid = ((served ?? []) as Row[]).map((r) => String(r["question_hash"]));

  const { data: guest } = await sdb()
    .from("guests")
    .select("klass")
    .eq("id", input.guestId)
    .maybeSingle();

  /*
   * One authoritative language for ALL event content. It comes from the USTAD
   * AI settings store (never from `guests`/`profiles`, never from the client)
   * and is passed in already-resolved by the caller, which snapshots it on the
   * attempt. For a multiplayer match that snapshot is decided once by the
   * server and shared by every player.
   */
  const generated = await generateQuizSet({
    guestId: input.guestId,
    language: input.language,
    klass: (guest as Row)?.["klass"] ?? null,
    avoid,
    seed: Date.now() % 100000,
    count: input.count, // ← fixed, from configuration
    showName: String(input.event["name"]),
  });

  const questions = generated.questions.map((q, i) => ({
    ...q,
    difficulty: q.difficulty || ladderDifficulty(i + 1, input.count),
  }));

  // Nothing enters an active match until the whole set passes validation.
  assertQuestionSetUsable(questions, input.count, questionHash);

  return questions.map((q, i) => ({
    question_number: i + 1,
    question: q.question,
    options: q.options,
    correct_index: q.correctIndex,
    difficulty: q.difficulty,
    category: q.category,
    explanation: q.explanation,
    hint: q.hint,
  }));
}

/**
 * Starts (or resumes) an attempt at a dynamic event.
 *
 * Refresh-safe and double-click-safe: a live attempt is returned as-is, and the
 * idempotency key plus the partial unique index make a duplicate start
 * impossible even under a race.
 */
export async function startAttempt(input: {
  token: unknown;
  eventCode: string;
  idempotencyKey?: string;
}): Promise<MasterAttemptView> {
  const guestId = await requireGuest(input.token);
  let event = await eventByCode(input.eventCode);
  if (!event) throw new Error("Event not found.");
  event = await reconcileStatus(event);

  const type = String(event["event_type"]);
  if (type !== "dynamic") {
    throw new Error(
      type === "crorepati"
        ? "Kon Banega Crorepati is played on its own screen."
        : "Mega tournament matches are played on the Mega screen.",
    );
  }

  // Resume: a refresh or reconnect never starts a second game.
  const { data: live } = await sdb()
    .from("master_event_attempts")
    .select("*")
    .eq("event_id", event["id"])
    .eq("guest_id", guestId)
    .eq("status", "active")
    .maybeSingle();
  if (live) {
    const row = live as Row;
    return viewAttempt(
      row,
      event,
      await questionRow(String(row["id"]), Number(row["current_question"])),
    );
  }

  const status = String(event["status"]) as EventStatus;
  if (!acceptsEntries(status)) throw new Error("This event is not open for entries right now.");

  // Won → locked until the next event. Lost → one try per India day.
  const lock = await entryLock(guestId, event);
  if (lock.locked) throw new Error(lock.reason ?? "This event is locked for you right now.");

  const decision = evaluateEntry({
    config: (event["entry_config"] ?? {}) as EntryConfig,
    status,
    freeEntriesLeft: 0, // free-entry balances belong to the Part 3 Crorepati engine
    coinBalance: await coinBalance(guestId),
    hasPass: false,
    hasActiveAttempt: false,
  });
  if (!decision.allowed) throw new Error(decision.reason);

  const count = resolveQuestionCount(Number(event["question_count"]));
  // Resolve the effective language ONCE, at start, from the single preference.
  const { guestLocale } = await import("./notification.server");
  const language = (await guestLocale(guestId)).language as Language;
  const questions = await buildQuestions({ guestId, event, count, language });

  const now = new Date();
  const pre = Number(event["pre_timer_seconds"] ?? 10);
  const answer = Number(event["answer_timer_seconds"] ?? 90);
  const total = Number(event["total_timer_seconds"] ?? 0);
  const answerStart = new Date(now.getTime() + pre * 1000);
  // Idempotency identifies THE REQUEST, not a slice of time. A caller-supplied
  // key makes a retry provably the same request; without one we mint a unique
  // key, because duplicate-protection is already guaranteed by the partial
  // unique index on live attempts. (A time-bucketed key used to collide with a
  // *finished* attempt from the same minute and hard-failed a legitimate
  // replay of the event.)
  const key =
    input.idempotencyKey?.slice(0, 120) ||
    idempotencyKey(["start", String(event["id"]), guestId, now.toISOString(), randomUUID()]);

  const { data: created, error } = await sdb()
    .from("master_event_attempts")
    .insert({
      event_id: event["id"],
      guest_id: guestId,
      status: "active",
      game_state: "QUESTION_INTRO",
      question_count: count, // frozen on the attempt
      language, // language snapshot — Settings changes cannot alter a live attempt
      current_question: 1,
      started_at: now.toISOString(),
      answer_timer_starts_at: answerStart.toISOString(),
      deadline_at: new Date(answerStart.getTime() + answer * 1000).toISOString(),
      total_deadline_at: total > 0 ? new Date(now.getTime() + total * 1000).toISOString() : null,
      idempotency_key: key,
    })
    .select()
    .single();
  if (error) {
    // Lost a race with our own duplicate request: return the winner's attempt.
    const { data: existing } = await sdb()
      .from("master_event_attempts")
      .select("*")
      .eq("event_id", event["id"])
      .eq("guest_id", guestId)
      .eq("status", "active")
      .maybeSingle();
    if (existing) {
      const row = existing as Row;
      return viewAttempt(
        row,
        event,
        await questionRow(String(row["id"]), Number(row["current_question"])),
      );
    }
    // A retry of a request whose attempt has already FINISHED: return that
    // settled attempt rather than failing, so a replayed click is a no-op.
    const { data: settled } = await sdb()
      .from("master_event_attempts")
      .select("*")
      .eq("guest_id", guestId)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (settled) {
      const row = settled as Row;
      return viewAttempt(row, event, null);
    }
    throw new Error(error.message);
  }

  const attemptId = String(created["id"]);
  const { error: qError } = await sdb()
    .from("master_event_attempt_questions")
    .insert(questions.map((q) => ({ ...q, attempt_id: attemptId })));
  if (qError) {
    // Never leave a playable-looking attempt with no questions: an unplayable
    // attempt would later be settled as a 0-correct "finished" event.
    await sdb()
      .from("master_event_attempts")
      .update({ status: "abandoned", result: "abandoned", game_state: "GAME_OVER" })
      .eq("id", attemptId);
    throw new Error("Event questions could not be loaded. Please try again in a moment.");
  }

  await sdb()
    .from("master_event_served_questions")
    .upsert(
      questions.map((q) => ({
        event_id: event!["id"],
        guest_id: guestId,
        question_hash: questionHash(String(q["question"])),
        question: String(q["question"]).slice(0, 400),
      })),
      { onConflict: "event_id,guest_id,question_hash", ignoreDuplicates: true },
    );

  if (decision.coinCost > 0) {
    // A live Global Coin Offer discounts the event entry — the real discounted
    // amount is charged and audited in one atomic choke point. coinOfferCharge
    // reuses master_event's own applyCoins source + reward-ref id, so retries
    // stay idempotent exactly as the local ledger() did.
    await coinOfferCharge({
      guestId,
      source: "master_event",
      refId: rewardRefId(String(event["id"]), attemptId, "entry"),
      basePrice: decision.coinCost,
      type: "master_event",
      note: `Entry — ${String(event["name"])}`,
      itemKind: "master_event_entry",
      itemId: String(event["id"]),
    });
  }

  await audit({
    eventId: String(event["id"]),
    guestId,
    action: "attempt_started",
    detail: { attemptId, questionCount: count, coinCost: decision.coinCost },
  });

  return viewAttempt(created as Row, event, await questionRow(attemptId, 1));
}

/** Current state of the guest's attempt. Safe to poll; used after a reconnect. */
export async function getAttempt(input: {
  token: unknown;
  attemptId: string;
}): Promise<MasterAttemptView | null> {
  const guestId = await requireGuest(input.token);
  const { data } = await sdb()
    .from("master_event_attempts")
    .select("*")
    .eq("id", input.attemptId)
    .eq("guest_id", guestId) // ownership
    .maybeSingle();
  if (!data) return null;
  let attempt = data as Row;
  const event = await eventById(String(attempt["event_id"]));
  if (!event) return null;

  // The server enforces the timer even if the client never reported back.
  if (attempt["status"] === "active") attempt = await enforceTimeout(attempt, event);

  return viewAttempt(
    attempt,
    event,
    await questionRow(String(attempt["id"]), Number(attempt["current_question"])),
  );
}

/** Moves an attempt from the pre-timer into the answering window. */
export async function beginQuestion(input: {
  token: unknown;
  attemptId: string;
}): Promise<MasterAttemptView> {
  const guestId = await requireGuest(input.token);
  const { data } = await sdb()
    .from("master_event_attempts")
    .select("*")
    .eq("id", input.attemptId)
    .eq("guest_id", guestId)
    .maybeSingle();
  if (!data) throw new Error("Attempt not found.");
  const attempt = data as Row;
  const event = await eventById(String(attempt["event_id"]));
  if (!event) throw new Error("Event not found.");
  if (attempt["status"] !== "active") throw new Error("This attempt has already ended.");

  if (attempt["game_state"] === "ANSWERING") {
    return viewAttempt(
      attempt,
      event,
      await questionRow(String(attempt["id"]), Number(attempt["current_question"])),
    );
  }

  // The pre-timer is server-owned: asking early does not shorten it.
  const startsAt = attempt["answer_timer_starts_at"]
    ? Date.parse(String(attempt["answer_timer_starts_at"]))
    : Date.now();
  const effectiveStart = Math.max(Date.now(), startsAt);
  const answer = Number(event["answer_timer_seconds"] ?? 90);

  const { data: updated } = await sdb()
    .from("master_event_attempts")
    .update({
      game_state: "ANSWERING",
      answer_timer_starts_at: new Date(effectiveStart).toISOString(),
      deadline_at: new Date(effectiveStart + answer * 1000).toISOString(),
    })
    .eq("id", input.attemptId)
    .eq("guest_id", guestId)
    .eq("game_state", "QUESTION_INTRO")
    .select()
    .maybeSingle();

  const row = (updated as Row) ?? attempt;
  return viewAttempt(
    row,
    event,
    await questionRow(String(row["id"]), Number(row["current_question"])),
  );
}

/**
 * Self-heal an active attempt whose question rows are missing (a failed or
 * partial question insert, or a generation that never landed). An attempt with
 * no question to show is NOT a completed attempt: it is repaired here and the
 * answering window is re-armed, so the player still sees Question N.
 */
async function repairQuestions(attempt: Row, event: Row): Promise<Row> {
  const current = Number(attempt["current_question"] ?? 1);
  if (await questionRow(String(attempt["id"]), current)) return attempt;

  const count = Number(attempt["question_count"] ?? 0) || resolveQuestionCount(0);
  const language = String(attempt["language"] ?? "en") as Language;
  const questions = await buildQuestions({
    guestId: String(attempt["guest_id"]),
    event,
    count,
    language,
  });

  const { data: have } = await sdb()
    .from("master_event_attempt_questions")
    .select("question_number")
    .eq("attempt_id", attempt["id"]);
  const known = new Set(((have ?? []) as Row[]).map((r) => Number(r["question_number"])));
  const missing = questions.filter((q) => !known.has(Number(q["question_number"])));
  if (missing.length > 0) {
    const { error } = await sdb()
      .from("master_event_attempt_questions")
      .insert(missing.map((q) => ({ ...q, attempt_id: attempt["id"] })));
    if (error) throw new Error("Event questions are still loading. Please try again in a moment.");
  }

  // The time lost to the failure was never the player's: re-arm the window.
  const pre = Number(event["pre_timer_seconds"] ?? 10);
  const answerSec = Number(event["answer_timer_seconds"] ?? 90);
  const start = Date.now() + pre * 1000;
  const patch: Row = {
    game_state: "QUESTION_INTRO",
    answer_timer_starts_at: new Date(start).toISOString(),
    deadline_at: new Date(start + answerSec * 1000).toISOString(),
  };
  const total = Number(event["total_timer_seconds"] ?? 0);
  const totalDeadline = attempt["total_deadline_at"]
    ? Date.parse(String(attempt["total_deadline_at"]))
    : NaN;
  if (total > 0 && Number.isFinite(totalDeadline) && Date.now() > totalDeadline) {
    patch["total_deadline_at"] = new Date(Date.now() + total * 1000).toISOString();
  }
  const { data: updated } = await sdb()
    .from("master_event_attempts")
    .update(patch)
    .eq("id", attempt["id"])
    .eq("status", "active")
    .select()
    .maybeSingle();
  return (updated as Row) ?? attempt;
}

async function enforceTimeout(attempt: Row, event: Row): Promise<Row> {
  // A missing question can never expire the attempt — repair it first.
  attempt = await repairQuestions(attempt, event);
  const now = Date.now();

  const deadline = attempt["deadline_at"] ? Date.parse(String(attempt["deadline_at"])) : NaN;
  const totalDeadline = attempt["total_deadline_at"]
    ? Date.parse(String(attempt["total_deadline_at"]))
    : NaN;
  const overTotal = Number.isFinite(totalDeadline) && now > totalDeadline;
  const overAnswer =
    attempt["game_state"] === "ANSWERING" && Number.isFinite(deadline) && now > deadline + 1500;
  if (!overTotal && !overAnswer) return attempt;
  return finishAttempt(attempt, event, "timeout");
}

/**
 * Submits an answer. The chosen index is compared on the server; the correct
 * index is only revealed afterwards, in the response for that question.
 */
export async function submitAnswer(input: {
  token: unknown;
  attemptId: string;
  questionNumber: number;
  chosenIndex: number;
}): Promise<{
  accepted: boolean;
  correct: boolean;
  correctIndex: number;
  explanation: string;
  attempt: MasterAttemptView;
}> {
  const guestId = await requireGuest(input.token);
  const { data } = await sdb()
    .from("master_event_attempts")
    .select("*")
    .eq("id", input.attemptId)
    .eq("guest_id", guestId)
    .maybeSingle();
  if (!data) throw new Error("Attempt not found.");
  let attempt = data as Row;
  const event = await eventById(String(attempt["event_id"]));
  if (!event) throw new Error("Event not found.");

  if (attempt["status"] !== "active") {
    const q = await questionRow(String(attempt["id"]), Number(attempt["current_question"]));
    return {
      accepted: false,
      correct: false,
      correctIndex: -1,
      explanation: "",
      attempt: viewAttempt(attempt, event, q),
    };
  }

  attempt = await enforceTimeout(attempt, event);
  if (attempt["status"] !== "active") {
    return {
      accepted: false,
      correct: false,
      correctIndex: -1,
      explanation: "",
      attempt: viewAttempt(attempt, event, null),
    };
  }

  const q = await questionRow(String(attempt["id"]), input.questionNumber);
  if (!q) throw new Error("Question not found.");

  // Auto-transition from QUESTION_INTRO to ANSWERING if the pre-timer has elapsed.
  // This handles cases where the client hasn't called beginQuestion yet but the
  // pre-timer has already passed on the server clock.
  let effectiveAttempt = attempt;
  if (String(attempt["game_state"]) === "QUESTION_INTRO") {
    const preTimerStartsAt = attempt["answer_timer_starts_at"]
      ? Date.parse(String(attempt["answer_timer_starts_at"]))
      : null;
    if (preTimerStartsAt && Date.now() >= preTimerStartsAt) {
      const answerTimerSec = Number(event["answer_timer_seconds"] ?? 90);
      const { data: transitioned } = await sdb()
        .from("master_event_attempts")
        .update({
          game_state: "ANSWERING",
          deadline_at: new Date(Date.now() + answerTimerSec * 1000).toISOString(),
        })
        .eq("id", attempt["id"])
        .eq("guest_id", guestId)
        .eq("game_state", "QUESTION_INTRO")
        .select()
        .maybeSingle();
      if (transitioned) effectiveAttempt = transitioned as Row;
    }
  }

  const verdict = checkAnswer({
    chosenIndex: input.chosenIndex,
    correctIndex: Number(q["correct_index"]),
    optionCount: ((q["options"] ?? []) as string[]).length,
    questionNumber: input.questionNumber,
    expectedQuestionNumber: Number(effectiveAttempt["current_question"]),
    alreadyAnswered: q["answered_at"] !== null && q["answered_at"] !== undefined,
    gameState: String(effectiveAttempt["game_state"]) as GameState,
    nowMs: Date.now(),
    deadlineMs: effectiveAttempt["deadline_at"] ? Date.parse(String(effectiveAttempt["deadline_at"])) : null,
  });

  if (!verdict.ok) {
    // Double submission or a late/duplicate packet: state is left untouched.
    return {
      accepted: false,
      correct: Boolean(q["was_correct"]),
      correctIndex: q["answered_at"] ? Number(q["correct_index"]) : -1,
      explanation: q["answered_at"] ? String(q["explanation"] ?? "") : "",
      attempt: viewAttempt(attempt, event, q),
    };
  }

  // Claim the question atomically — a racing second click finds it answered.
  const { data: claimed } = await sdb()
    .from("master_event_attempt_questions")
    .update({
      answered_index: input.chosenIndex,
      answered_at: new Date().toISOString(),
      was_correct: verdict.correct,
    })
    .eq("attempt_id", effectiveAttempt["id"])
    .eq("question_number", input.questionNumber)
    .is("answered_at", null)
    .select()
    .maybeSingle();
  if (!claimed) {
    return {
      accepted: false,
      correct: Boolean(q["was_correct"]),
      correctIndex: Number(q["correct_index"]),
      explanation: String(q["explanation"] ?? ""),
      attempt: viewAttempt(effectiveAttempt, event, q),
    };
  }

  const gameplay = (event["gameplay_config"] ?? {}) as { eliminatedOnWrong?: boolean };
  const correctCount = Number(effectiveAttempt["correct_count"] ?? 0) + (verdict.correct ? 1 : 0);
  const wrongCount = Number(effectiveAttempt["wrong_count"] ?? 0) + (verdict.correct ? 0 : 1);
  const cleared = Number(effectiveAttempt["cleared_questions"] ?? 0) + (verdict.correct ? 1 : 0);
  const count = Number(effectiveAttempt["question_count"]);
  const nextNumber = Number(effectiveAttempt["current_question"]) + 1;

  const eliminated = Boolean(gameplay.eliminatedOnWrong) && !verdict.correct;
  const finished = eliminated || nextNumber > count;

  const patch: Row = {
    correct_count: correctCount,
    wrong_count: wrongCount,
    cleared_questions: cleared,
    score: correctCount,
  };

  if (!finished) {
    const pre = Number(event["pre_timer_seconds"] ?? 10);
    const start = Date.now() + pre * 1000;
    patch["current_question"] = nextNumber;
    patch["game_state"] = "QUESTION_INTRO";
    patch["answer_timer_starts_at"] = new Date(start).toISOString();
    patch["deadline_at"] = new Date(
      start + Number(event["answer_timer_seconds"] ?? 90) * 1000,
    ).toISOString();
  }
  // Update attempt reference after potential auto-transition
  attempt = effectiveAttempt;

  const { data: updated } = await sdb()
    .from("master_event_attempts")
    .update(patch)
    .eq("id", effectiveAttempt["id"])
    .eq("guest_id", guestId)
    .select()
    .single();
  let next = updated as Row;

  if (finished) {
    const won = isWin({
      correctCount,
      requiredCorrect: Number(event["required_correct"] ?? 0),
      questionCount: count,
      eliminatedOnWrong: Boolean(gameplay.eliminatedOnWrong),
      wrongCount,
    });
    next = await finishAttempt(next, event, won ? "won" : "lost");
  }

  return {
    accepted: true,
    correct: verdict.correct,
    correctIndex: Number(q["correct_index"]),
    explanation: String(q["explanation"] ?? ""),
    attempt: viewAttempt(
      next,
      event,
      finished ? null : await questionRow(String(next["id"]), nextNumber),
    ),
  };
}

/** Voluntarily walk away. Counts as a completed attempt with what was earned. */
export async function quitAttempt(input: {
  token: unknown;
  attemptId: string;
}): Promise<MasterAttemptView> {
  const guestId = await requireGuest(input.token);
  const { data } = await sdb()
    .from("master_event_attempts")
    .select("*")
    .eq("id", input.attemptId)
    .eq("guest_id", guestId)
    .maybeSingle();
  if (!data) throw new Error("Attempt not found.");
  const attempt = data as Row;
  const event = await eventById(String(attempt["event_id"]));
  if (!event) throw new Error("Event not found.");
  if (attempt["status"] !== "active") return viewAttempt(attempt, event, null);
  const done = await finishAttempt(attempt, event, "abandoned");
  return viewAttempt(done, event, null);
}

/* ------------------------------------------------------------------ */
/* Finalization, rewards, trophies, certificates                       */
/* ------------------------------------------------------------------ */

/**
 * The single exit point for an attempt. Everything that pays out or awards
 * anything happens here, exactly once:
 *   1. close the attempt atomically (a racing caller finds it already closed),
 *   2. reject impossible states before any reward,
 *   3. compute the reward from the stored config — never from client input,
 *   4. credit through the idempotent ledger,
 *   5. record a verified result row for the leaderboard,
 *   6. hand a win to the Part 4 trophy engine, which itself issues the Part 5
 *      certificate.
 */
async function finishAttempt(attempt: Row, event: Row, outcome: string): Promise<Row> {
  const guestId = String(attempt["guest_id"]);
  const attemptId = String(attempt["id"]);
  const eventId = String(event["id"]);
  const endedAt = new Date();

  const { data: closed } = await sdb()
    .from("master_event_attempts")
    .update({
      status: outcome,
      game_state: "GAME_OVER",
      ended_at: endedAt.toISOString(),
      result: outcome,
    })
    .eq("id", attemptId)
    .eq("status", "active") // ← only the first caller proceeds
    .select()
    .maybeSingle();
  if (!closed) {
    const { data: current } = await sdb()
      .from("master_event_attempts")
      .select("*")
      .eq("id", attemptId)
      .maybeSingle();
    return (current as Row) ?? attempt;
  }
  const row = closed as Row;

  const durationMs = Math.max(0, endedAt.getTime() - Date.parse(String(row["started_at"])));
  const correctCount = Number(row["correct_count"] ?? 0);
  const violations = detectImpossibleState({
    questionCount: Number(row["question_count"]),
    correctCount,
    wrongCount: Number(row["wrong_count"] ?? 0),
    clearedQuestions: Number(row["cleared_questions"] ?? 0),
    durationMs,
  });

  const isWinner = outcome === "won" && violations.length === 0;

  if (violations.length) {
    await audit({
      eventId,
      guestId,
      action: "anti_cheat_reject",
      reason: violations.join("; "),
      detail: { attemptId },
    });
  }

  // Rewards are computed server-side from the event's stored configuration.
  const reward = violations.length
    ? { total: 0, perCorrect: 0, win: 0, participation: 0, placement: 0 }
    : calculateReward({
        config: (event["reward_config"] ?? {}) as RewardConfig,
        correctCount,
        isWinner,
        attempted: true,
      });

  if (reward.total > 0) {
    await ledger(
      guestId,
      rewardRefId(eventId, attemptId),
      reward.total,
      `${String(event["name"])} — ${isWinner ? "win" : "reward"}`,
    );
    await sdb()
      .from("master_event_attempts")
      .update({ coin_reward: reward.total })
      .eq("id", attemptId);
    row["coin_reward"] = reward.total;
  }

  // Verified result. Unique (event, guest, attempt) makes a replay a no-op.
  await sdb()
    .from("master_event_results")
    .upsert(
      {
        event_id: eventId,
        guest_id: guestId,
        attempt_id: attemptId,
        rank: 0,
        is_winner: isWinner,
        correct_count: correctCount,
        score: Number(row["score"] ?? correctCount),
        duration_ms: durationMs,
        coins_awarded: reward.total,
        outcome,
      },
      { onConflict: "event_id,guest_id,attempt_id", ignoreDuplicates: true },
    );

  // Trophies (Part 4) → which issue certificates (Part 5). Never re-implemented.
  const achievement = (event["achievement_config"] ?? {}) as { awardTrophy?: boolean };
  if (isWinner && achievement.awardTrophy) {
    try {
      // Uses the Part 4 engine's master-event entry point, which verifies the
      // result row this function has just written.
      await onMasterEventWin({ guestId, eventId, attemptId });
    } catch {
      /* an achievement failure must never void a settled result */
    }
  }

  await notifyGuest(
    guestId,
    isWinner ? "tournament_won" : "event_result",
    `masterevent:${attemptId}:result`,
    {
      eventName: String(event["name"]),
      score: correctCount,
      total: Number(row["question_count"]),
      reward: reward.total,
    },
    {
      referenceType: "master_event_attempt",
      referenceId: attemptId,
      metadata: { eventId, attemptId, outcome, coins: reward.total },
    },
  );

  await audit({
    eventId,
    guestId,
    action: "attempt_ended",
    toStatus: outcome,
    detail: { attemptId, correctCount, coins: reward.total, durationMs },
  });

  return row;
}

/* ------------------------------------------------------------------ */
/* Leaderboard & history                                               */
/* ------------------------------------------------------------------ */

export type LeaderboardEntry = {
  rank: number;
  guestId: string;
  displayName: string;
  score: number;
  correctCount: number;
  durationMs: number;
  isWinner: boolean;
  isYou: boolean;
};

/** Built ONLY from verified, finalized result rows. */
export async function leaderboard(input: {
  token: unknown;
  eventCode: string;
  limit?: number;
}): Promise<LeaderboardEntry[]> {
  const guestId = await requireGuest(input.token);
  const event = await eventByCode(input.eventCode);
  if (!event || !event["leaderboard_enabled"]) return [];

  const { data } = await sdb()
    .from("master_event_results")
    .select("guest_id,score,correct_count,duration_ms,is_winner")
    .eq("event_id", event["id"])
    .limit(500);

  const ranked = rankResults(
    ((data ?? []) as Row[]).map((r) => ({
      guestId: String(r["guest_id"]),
      score: Number(r["score"] ?? 0),
      correctCount: Number(r["correct_count"] ?? 0),
      durationMs: Number(r["duration_ms"] ?? 0),
      isWinner: Boolean(r["is_winner"]),
    })),
  ).slice(0, Math.min(100, input.limit ?? 20));

  const ids = ranked.map((r) => r.guestId);
  const { data: names } = await sdb()
    .from("guests")
    .select("id,name")
    .in("id", ids.length ? ids : [""]);
  const nameOf = new Map(
    ((names ?? []) as Row[]).map((g) => [String(g["id"]), String(g["name"] ?? "")]),
  );

  return ranked.map((r) => ({
    rank: r.rank,
    guestId: r.guestId,
    displayName: nameOf.get(r.guestId) || `Player ${r.guestId.slice(0, 6)}`,
    score: r.score,
    correctCount: r.correctCount,
    durationMs: r.durationMs,
    isWinner: r.isWinner,
    isYou: r.guestId === guestId,
  }));
}

export type HistoryEntry = {
  eventName: string;
  eventCode: string;
  outcome: string;
  correctCount: number;
  questionCount: number;
  coinsAwarded: number;
  playedAt: string;
};

/** Event history for the EXISTING profile page. No second profile is created. */
export async function eventHistory(token: unknown, limit = 20): Promise<HistoryEntry[]> {
  const guestId = await requireGuest(token);
  const { data } = await sdb()
    .from("master_event_attempts")
    .select("event_id,status,correct_count,question_count,coin_reward,ended_at,created_at")
    .eq("guest_id", guestId)
    .neq("status", "active")
    .order("created_at", { ascending: false })
    .limit(Math.min(50, limit));

  const rows = (data ?? []) as Row[];
  const ids = [...new Set(rows.map((r) => String(r["event_id"])))];
  const { data: events } = await sdb()
    .from("master_events")
    .select("id,name,code")
    .in("id", ids.length ? ids : [""]);
  const byId = new Map(((events ?? []) as Row[]).map((e) => [String(e["id"]), e]));

  return rows.map((r) => {
    const e = byId.get(String(r["event_id"]));
    return {
      eventName: String(e?.["name"] ?? "Event"),
      eventCode: String(e?.["code"] ?? ""),
      outcome: String(r["status"]),
      correctCount: Number(r["correct_count"] ?? 0),
      questionCount: Number(r["question_count"] ?? 0),
      coinsAwarded: Number(r["coin_reward"] ?? 0),
      playedAt: String(r["ended_at"] ?? r["created_at"]),
    };
  });
}

/** Short summary for the AI's memory context. Reuses the existing pipeline. */
export async function masterEventContext(guestId: string): Promise<string> {
  try {
    const { data } = await sdb()
      .from("master_event_results")
      .select("is_winner,correct_count,coins_awarded")
      .eq("guest_id", guestId)
      .limit(100);
    const rows = (data ?? []) as Row[];
    if (!rows.length) return "";
    const wins = rows.filter((r) => r["is_winner"]).length;
    const coins = rows.reduce((a, r) => a + Number(r["coins_awarded"] ?? 0), 0);
    return `USTAD events played: ${rows.length}, wins: ${wins}, USTAD Coins earned from events: ${coins}.`;
  } catch {
    return "";
  }
}
