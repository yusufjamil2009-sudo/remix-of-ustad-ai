/**
 * KON BANEGA CROREPATI — authoritative game engine (Part 1).
 *
 * Design notes (deliberately reusing what already exists in USTAD AI):
 *   • identity/ownership  → `guest.server.ts` (requireGuest + service-role db)
 *   • question generation → `crorepati-ai.server.ts` → existing AI Router
 *   • timing              → server timestamps, rendered by the existing
 *                            Chrono/Timer helpers on the client (no new engine)
 *   • notifications       → existing `reminders` in-app message system
 *   • profile             → existing profile page reads `crorepatiProfileStats`
 *
 * SECURITY: the correct answer, the reward, the timer deadlines, the lifeline
 * state and the attempt result are ALL decided here. The client is a renderer.
 */
import { requireGuest, db } from "./guest.server";
import { notifyGuest } from "./notification.server";
import { applyCoins } from "./wallet.server";
import { generateCrorepatiSet, questionHash } from "./crorepati-ai.server";
import type { Language } from "./router.server";
import {
  CROREPATI_ANSWER_TIMER_SECONDS,
  CROREPATI_EVENT_CODE,
  CROREPATI_LATENCY_GRACE_MS,
  CROREPATI_PRE_TIMER_SECONDS,
  CROREPATI_QUESTION_COUNT,
  type CrorepatiAttemptView,
  type CrorepatiState,
  type CrorepatiStatus,
} from "./crorepati-spec";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sdb = () => db() as any;

type Row = Record<string, any>;

/* ------------------------------------------------------------------ */
/* Event + reward configuration (config-driven, never hard-coded in UI) */
/* ------------------------------------------------------------------ */

async function getEvent(): Promise<Row> {
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

async function rewardLadder(
  eventId: string,
): Promise<Array<{ questionNumber: number; coins: number }>> {
  const { data } = await sdb()
    .from("crorepati_rewards")
    .select("question_number,coins")
    .eq("event_id", eventId)
    .order("question_number", { ascending: true });
  return (data ?? []).map((r: Row) => ({
    questionNumber: Number(r["question_number"]),
    coins: Number(r["coins"]),
  }));
}

/** Reward for N cleared questions (0 cleared = 0 coins). */
export async function rewardForCleared(eventId: string, cleared: number): Promise<number> {
  if (cleared <= 0) return 0;
  const ladder = await rewardLadder(eventId);
  const hit = ladder.filter((l) => l.questionNumber <= cleared).pop();
  return hit ? hit.coins : 0;
}

/* ------------------------------------------------------------------ */
/* Timing helpers — server clock is the only truth                     */
/* ------------------------------------------------------------------ */

const PRE_MS = CROREPATI_PRE_TIMER_SECONDS * 1000;
const ANS_MS = CROREPATI_ANSWER_TIMER_SECONDS * 1000;

function deadlineOf(attempt: Row): number | null {
  return attempt["deadline_at"] ? Date.parse(attempt["deadline_at"]) : null;
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

async function currentQuestionRow(attemptId: string, questionNumber: number): Promise<Row | null> {
  const { data } = await sdb()
    .from("crorepati_attempt_questions")
    .select("*")
    .eq("attempt_id", attemptId)
    .eq("question_number", questionNumber)
    .maybeSingle();
  return data ?? null;
}

async function buildView(attempt: Row, event: Row, opts?: { revealExplanation?: string }) {
  const now = new Date();
  const status = attempt["status"] as CrorepatiStatus;
  const qRow =
    status === "active"
      ? await currentQuestionRow(attempt["id"], attempt["current_question"])
      : null;
  const ladder = await rewardLadder(event["id"]);
  const cleared = Number(attempt["cleared_questions"]);
  const rewardSoFar =
    cleared > 0 ? (ladder.filter((l) => l.questionNumber <= cleared).pop()?.coins ?? 0) : 0;

  const removed: number[] = Array.isArray(qRow?.["fifty_removed"]) ? qRow!["fifty_removed"] : [];

  const view: CrorepatiAttemptView = {
    attemptId: String(attempt["id"]),
    eventId: String(event["id"]),
    eventTitle: String(event["title"]),
    status,
    state: attempt["game_state"] as CrorepatiState,
    currentQuestion: Number(attempt["current_question"]),
    totalQuestions: CROREPATI_QUESTION_COUNT,
    clearedQuestions: cleared,
    skippedQuestions: Number(attempt["skipped_questions"]),
    wrongAtQuestion: attempt["wrong_question"] ? Number(attempt["wrong_question"]) : null,
    lifelines: {
      fiftyFiftyUsed: Boolean(attempt["fifty_fifty_used"]),
      hintUsed: Boolean(attempt["hint_used"]),
      skipUsed: Boolean(attempt["skip_used"]),
    },
    coinReward: Number(attempt["coin_reward"] ?? 0),
    result: (attempt["result"] as string) ?? null,
    question: qRow
      ? {
          id: String(qRow["id"]),
          attemptId: String(attempt["id"]),
          eventId: String(event["id"]),
          questionNumber: Number(qRow["question_number"]),
          question: String(qRow["question"]),
          options: (qRow["options"] as string[]) ?? [],
          difficulty: String(qRow["difficulty"]),
          category: String(qRow["category"]),
          removedOptions: removed,
          ...(attempt["hint_used"] && qRow["hint_shown"] ? { hint: String(qRow["hint"]) } : {}),
          ...(opts?.revealExplanation ? { explanation: opts.revealExplanation } : {}),
        }
      : null,
    timing: {
      serverNow: now.toISOString(),
      presentedAt: (attempt["presented_at"] as string) ?? null,
      answerTimerStartsAt: (attempt["answer_timer_starts_at"] as string) ?? null,
      deadlineAt: (attempt["deadline_at"] as string) ?? null,
      preTimerSeconds: Number(event["pre_timer_seconds"] ?? CROREPATI_PRE_TIMER_SECONDS),
      answerTimerSeconds: Number(event["answer_timer_seconds"] ?? CROREPATI_ANSWER_TIMER_SECONDS),
    },
    rewardSoFar,
    ladder,
  };
  return view;
}

/* ------------------------------------------------------------------ */
/* Ending an attempt (single funnel: coins + notification + stats)      */
/* ------------------------------------------------------------------ */

/**
 * Credits a verified reward through the Part 7 wallet. (guest_id, source,
 * ref_id) still makes double crediting impossible, and the coins now land in
 * the permanent wallet in the same database transaction as the ledger row —
 * so a refresh, retry or double-click can never pay twice, and the reward is
 * never held only in memory.
 */
async function creditCoins(guestId: string, attemptId: string, coins: number, note: string) {
  if (coins <= 0) return;
  await applyCoins({
    guestId,
    source: "crorepati",
    refId: attemptId,
    amount: coins,
    type: "crorepati_reward",
    note,
  });
}

/** Reuses the EXISTING in-app notification/message system (reminders feed). */
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
    /* notification is best-effort — never fails the game result */
  }
}

async function endAttempt(
  attempt: Row,
  event: Row,
  outcome: { status: Exclude<CrorepatiStatus, "active">; wrongAt?: number | null },
) {
  const guestId = String(attempt["guest_id"]);
  const cleared = Number(attempt["cleared_questions"]);
  const coins = await rewardForCleared(String(event["id"]), cleared);
  const result =
    outcome.status === "won" ? "WIN" : outcome.status === "timeout" ? "TIMEOUT" : "LOSS";

  const { data: updated } = await sdb()
    .from("crorepati_attempts")
    .update({
      status: outcome.status,
      game_state: "GAME_OVER",
      result,
      coin_reward: coins,
      ended_at: new Date().toISOString(),
      ...(outcome.wrongAt ? { wrong_question: outcome.wrongAt } : {}),
      deadline_at: null,
      answer_timer_starts_at: null,
    })
    .eq("id", attempt["id"])
    .eq("status", "active") // idempotent: a second call updates nothing
    .select()
    .maybeSingle();

  if (updated) {
    await creditCoins(
      guestId,
      String(attempt["id"]),
      coins,
      `Crorepati — ${cleared} questions cleared`,
    );
    // Part 9: the result notification is rendered in the user's own USTAD AI
    // language, from the real attempt outcome. The attempt id is the dedupe
    // key so a replayed finish cannot notify twice.
    await notifyGuest(
      guestId,
      outcome.status === "won" ? "crorepati_won" : "crorepati_lost",
      `crorepati:${String(attempt["id"])}:result`,
      {
        score: cleared,
        total: CROREPATI_QUESTION_COUNT,
        reward: coins,
      },
      {
        referenceType: "crorepati_attempt",
        referenceId: String(attempt["id"]),
        metadata: {
          attemptId: attempt["id"],
          eventId: event["id"],
          cleared,
          result,
          coins,
        },
      },
    );

    // Part 4: a verified Crorepati win earns the Normal Tournament Cup.
    // Normal cups never count toward Grandmaster / Ultra Great Grandmaster.
    if (outcome.status === "won") {
      try {
        const { onNormalWin } = await import("./trophy-engine.server");
        await onNormalWin({
          guestId,
          eventId: String(event["id"]),
          attemptId: String(attempt["id"]),
          metadata: { cleared, coins },
        });
      } catch {
        /* trophies never break gameplay */
      }
    }
  }

  const { data: fresh } = await sdb()
    .from("crorepati_attempts")
    .select("*")
    .eq("id", attempt["id"])
    .maybeSingle();
  return fresh ?? { ...attempt, status: outcome.status, result, coin_reward: coins };
}

/** Enforce the 90-second deadline on EVERY read/write touching an attempt. */
/**
 * Is the 90-second answer window actually open for this attempt?
 *
 * `answer_timer_starts_at` is written when the question is PRESENTED, so its
 * mere presence only means the 10s get-ready countdown has begun. An answer or
 * a lifeline is only legitimate once that instant has passed and the deadline
 * has not. Small clock skew between the app server and the database is
 * tolerated so a player on the boundary is never wrongly rejected.
 */
const CLOCK_SKEW_MS = 750;

function answerWindowOpen(attempt: Row): boolean {
  const startsAt = attempt["answer_timer_starts_at"] as string | null;
  const deadlineAt = attempt["deadline_at"] as string | null;
  if (!startsAt || !deadlineAt) return false;
  const now = Date.now();
  return (
    now >= new Date(startsAt).getTime() - CLOCK_SKEW_MS &&
    now <= new Date(deadlineAt).getTime() + CLOCK_SKEW_MS
  );
}

/**
 * How long after a missed deadline the server still treats the expiry as a
 * genuine timeout. Beyond that the player was clearly not on the page (tab
 * closed, reload, connection lost), so the question is RE-ARMED instead of the
 * attempt being destroyed: the player resumes the same game at the same
 * question and no entry is burnt. A player sitting on the page always times out
 * normally, because the client reports the expiry the moment it happens.
 */
const RESUME_REARM_AFTER_MS = 15_000;

async function enforceTimeout(attempt: Row, event: Row): Promise<Row> {
  if (attempt["status"] !== "active") return attempt;
  const deadline = deadlineOf(attempt);
  if (!deadline) return attempt;
  const late = Date.now() - deadline;
  if (late <= CROREPATI_LATENCY_GRACE_MS) return attempt;

  if (late > RESUME_REARM_AFTER_MS) {
    // Absent player → resume the same question on the next presentation.
    const { data: rearmed } = await sdb()
      .from("crorepati_attempts")
      .update({
        game_state: "QUESTION_ANIMATING",
        presented_at: null,
        answer_timer_starts_at: null,
        deadline_at: null,
      })
      .eq("id", attempt["id"])
      .eq("status", "active")
      .select()
      .maybeSingle();
    return rearmed ?? attempt;
  }

  return endAttempt(attempt, event, {
    status: "timeout",
    wrongAt: Number(attempt["current_question"]),
  });
}

async function loadAttempt(guestId: string, attemptId: string): Promise<Row> {
  const { data } = await sdb()
    .from("crorepati_attempts")
    .select("*")
    .eq("id", attemptId)
    .eq("guest_id", guestId) // ownership: another guest's attempt is invisible
    .maybeSingle();
  if (!data) throw new Error("Crorepati attempt not found.");
  return data;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Active attempt (if any) — used on page load / after a refresh. */
export async function getActiveAttempt(token: unknown) {
  const guestId = await requireGuest(token);
  const event = await getEvent();
  const { data } = await sdb()
    .from("crorepati_attempts")
    .select("*")
    .eq("guest_id", guestId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) {
    const ladder = await rewardLadder(String(event["id"]));
    return {
      attempt: null,
      event: {
        id: String(event["id"]),
        title: String(event["title"]),
        totalQuestions: CROREPATI_QUESTION_COUNT,
        preTimerSeconds: Number(event["pre_timer_seconds"]),
        answerTimerSeconds: Number(event["answer_timer_seconds"]),
      },
      ladder,
      serverNow: new Date().toISOString(),
    };
  }
  const attempt = await enforceTimeout(data, event);
  return {
    attempt: await buildView(attempt, event),
    event: {
      id: String(event["id"]),
      title: String(event["title"]),
      totalQuestions: CROREPATI_QUESTION_COUNT,
      preTimerSeconds: Number(event["pre_timer_seconds"]),
      answerTimerSeconds: Number(event["answer_timer_seconds"]),
    },
    ladder: await rewardLadder(String(event["id"])),
    serverNow: new Date().toISOString(),
  };
}

/**
 * Start a NEW attempt — or return the existing active one (refresh-safe).
 * Generates exactly 20 dynamic questions through the existing AI Router.
 */
export async function startAttempt(input: {
  token: unknown;
  /** Part 3: makes a retried/refreshed start provably the same request. */
  idempotencyKey?: string;
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEvent();
  const client = sdb();

  const { data: existing } = await client
    .from("crorepati_attempts")
    .select("*")
    .eq("guest_id", guestId)
    .eq("status", "active")
    .maybeSingle();
  if (existing) {
    const attempt = await enforceTimeout(existing, event);
    // Refresh-safe: an already running attempt never consumes a second entry.
    if (attempt["status"] === "active") return buildView(attempt, event);
  }

  /*
   * PART 3 ENTRY GATE. Gameplay below is untouched — this only decides WHO may
   * start and which entry (free / paid USTAD Coins) is spent. The entry is
   * granted before any AI work so a guest can never slip in without one, and
   * it is released again if the attempt cannot actually be created.
   */
  const { grantEntry, consumeEntry, releaseEntry } = await import("./crorepati-entry.server");
  const granted = await grantEntry({
    token: input.token,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  try {
    // Profile + already-served questions drive dynamic, non-repeating sets.
    const { data: profile } = await client
      .from("profiles")
      .select("klass,language")
      .eq("guest_id", guestId)
      .maybeSingle();
    const { data: served } = await client
      .from("crorepati_served_questions")
      .select("question_hash")
      .eq("guest_id", guestId)
      .order("last_served_at", { ascending: false })
      .limit(120);

    /*
     * Language comes from the ONE authoritative USTAD AI preference (the
     * `settings` store, read via the shared `guestLocale` helper) — never from
     * the client and never from the `profiles` mirror, which can drift. The
     * resolved value is snapshotted onto the attempt below so that changing
     * Settings mid-attempt cannot alter the game already in progress.
     */
    const { guestLocale } = await import("./notification.server");
    const language = (await guestLocale(guestId)).language as Language;

    const { questions } = await generateCrorepatiSet({
      guestId,
      language,
      klass: (profile?.["klass"] as string) ?? null,
      avoid: (served ?? []).map((r: Row) => String(r["question_hash"])),
      seed: Math.floor(Math.random() * 1_000_000),
    });

    const { data: attempt, error } = await client
      .from("crorepati_attempts")
      .insert({
        guest_id: guestId,
        event_id: event["id"],
        status: "active",
        game_state: "QUESTION_ANIMATING",
        language,
        current_question: 1,
      })
      .select()
      .single();
    if (error) {
      // Unique partial index → another tab created the attempt first. Reuse it
      // and hand the just-granted entry back so nothing is double-charged.
      const { data: other } = await client
        .from("crorepati_attempts")
        .select("*")
        .eq("guest_id", guestId)
        .eq("status", "active")
        .maybeSingle();
      if (other) {
        await releaseEntry({ token: input.token, entryId: granted.entryId }).catch(() => {});
        return buildView(other, event);
      }
      throw new Error(error.message);
    }

    await client.from("crorepati_attempt_questions").insert(
      questions.map((q, i) => ({
        attempt_id: attempt["id"],
        guest_id: guestId,
        question_number: i + 1,
        question: q.question,
        options: q.options,
        correct_index: q.correctIndex,
        difficulty: q.difficulty,
        category: q.category,
        explanation: q.explanation,
        hint: q.hint,
      })),
    );

    await client.from("crorepati_served_questions").upsert(
      questions.map((q) => ({
        guest_id: guestId,
        question_hash: questionHash(q.question),
        last_served_at: new Date().toISOString(),
      })),
      { onConflict: "guest_id,question_hash" },
    );

    // Bind the entry to this attempt and mark the occurrence as PLAYED, which
    // resets the missed-event streak (a loss still counts as participation).
    await consumeEntry({
      token: input.token,
      entryId: granted.entryId,
      attemptId: String(attempt["id"]),
    });

    return buildView(attempt, event);
  } catch (e) {
    // Nothing was played → give the entry back instead of burning it.
    await releaseEntry({ token: input.token, entryId: granted.entryId }).catch(() => {});
    throw e;
  }
}

/**
 * The client reports that the question finished animating in.
 * THIS starts the 10-second pre-timer; the 90-second timer starts 10s later.
 * Idempotent: re-reporting the same question never re-arms the clock.
 */
export async function markQuestionPresented(input: {
  token: unknown;
  attemptId: string;
  questionNumber: number;
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEvent();
  let attempt = await loadAttempt(guestId, input.attemptId);
  attempt = await enforceTimeout(attempt, event);
  if (attempt["status"] !== "active") return buildView(attempt, event);
  if (Number(attempt["current_question"]) !== input.questionNumber)
    return buildView(attempt, event);
  if (attempt["presented_at"] && attempt["deadline_at"]) return buildView(attempt, event);

  const now = Date.now();
  const start = new Date(now + PRE_MS);
  const deadline = new Date(now + PRE_MS + ANS_MS);
  const { data: updated } = await sdb()
    .from("crorepati_attempts")
    .update({
      game_state: "PRE_TIMER_10_SECONDS",
      presented_at: new Date(now).toISOString(),
      answer_timer_starts_at: start.toISOString(),
      deadline_at: deadline.toISOString(),
    })
    .eq("id", attempt["id"])
    .eq("status", "active")
    .is("deadline_at", null)
    .select()
    .maybeSingle();

  const fresh = updated ?? (await loadAttempt(guestId, input.attemptId));
  return buildView(fresh, event);
}

/** Submit an answer. Server decides correctness, timeout, reward and next state. */
export async function submitAnswer(input: {
  token: unknown;
  attemptId: string;
  questionNumber: number;
  optionIndex: number;
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEvent();
  let attempt = await loadAttempt(guestId, input.attemptId);
  attempt = await enforceTimeout(attempt, event);
  if (attempt["status"] !== "active") {
    return { view: await buildView(attempt, event), correct: false, alreadyOver: true };
  }
  if (Number(attempt["current_question"]) !== input.questionNumber) {
    // Duplicate/stale submission for a question we already moved past.
    return { view: await buildView(attempt, event), correct: false, duplicate: true };
  }

  const qRow = await currentQuestionRow(String(attempt["id"]), input.questionNumber);
  if (!qRow) throw new Error("Question not found.");
  if (qRow["answered_at"]) {
    return { view: await buildView(attempt, event), correct: false, duplicate: true };
  }
  /*
   * HOTFIX — the 90s answer window must actually be OPEN.
   *
   * This previously only checked that `answer_timer_starts_at` was set, not
   * that it had passed. The row is written the moment the question is
   * presented, so during the 10-second get-ready countdown the field is
   * already non-null and an early click was accepted as a real answer —
   * usually a wrong one, which ended the game on Q1 before the player could
   * legitimately answer. That is the reported "error when clicking an option".
   *
   * The client also disables the options during the pre-timer, but the client
   * is not the authority: the server has to reject an early answer itself.
   */
  if (!answerWindowOpen(attempt)) throw new Error("This question is not ready yet.");

  const index = Number(input.optionIndex);
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error("Invalid option.");

  // Atomic claim of this question row → rapid double clicks cannot both win.
  const { data: claimed } = await sdb()
    .from("crorepati_attempt_questions")
    .update({ answered_index: index, answered_at: new Date().toISOString() })
    .eq("id", qRow["id"])
    .is("answered_at", null)
    .select()
    .maybeSingle();
  if (!claimed) {
    return { view: await buildView(attempt, event), correct: false, duplicate: true };
  }

  const correct = Number(qRow["correct_index"]) === index;
  await sdb()
    .from("crorepati_attempt_questions")
    .update({ was_correct: correct })
    .eq("id", qRow["id"]);

  const explanation = String(qRow["explanation"] ?? "");

  if (!correct) {
    const ended = await endAttempt(attempt, event, {
      status: "lost",
      wrongAt: input.questionNumber,
    });
    return {
      view: await buildView(ended, event),
      correct: false,
      correctIndex: Number(qRow["correct_index"]),
      explanation,
    };
  }

  const cleared = Number(attempt["cleared_questions"]) + 1;

  if (input.questionNumber >= CROREPATI_QUESTION_COUNT) {
    const { data: bumped } = await sdb()
      .from("crorepati_attempts")
      .update({ cleared_questions: cleared })
      .eq("id", attempt["id"])
      .select()
      .single();
    const ended = await endAttempt(bumped, event, { status: "won" });
    return {
      view: await buildView(ended, event),
      correct: true,
      correctIndex: Number(qRow["correct_index"]),
      explanation,
    };
  }

  const { data: next } = await sdb()
    .from("crorepati_attempts")
    .update({
      cleared_questions: cleared,
      game_state: "ANSWER_SUBMITTED",
    })
    .eq("id", attempt["id"])
    .select()
    .single();

  return {
    view: await buildView(next, event),
    correct: true,
    correctIndex: Number(qRow["correct_index"]),
    explanation,
  };
}

/** Advance to the next question after a correct answer (fresh timers). */
export async function nextQuestion(input: { token: unknown; attemptId: string }) {
  const guestId = await requireGuest(input.token);
  const event = await getEvent();
  let attempt = await loadAttempt(guestId, input.attemptId);
  attempt = await enforceTimeout(attempt, event);
  if (attempt["status"] !== "active") return buildView(attempt, event);

  const current = Number(attempt["current_question"]);
  const qRow = await currentQuestionRow(String(attempt["id"]), current);
  // Only advance once the current question is actually resolved.
  if (!qRow?.["answered_at"] && !qRow?.["was_skipped"]) return buildView(attempt, event);
  if (current >= CROREPATI_QUESTION_COUNT) return buildView(attempt, event);

  const { data: updated } = await sdb()
    .from("crorepati_attempts")
    .update({
      current_question: current + 1,
      game_state: "QUESTION_ANIMATING",
      presented_at: null,
      answer_timer_starts_at: null,
      deadline_at: null,
    })
    .eq("id", attempt["id"])
    .eq("current_question", current) // idempotent: double-click advances once
    .eq("status", "active")
    .select()
    .maybeSingle();

  const fresh = updated ?? (await loadAttempt(guestId, input.attemptId));
  return buildView(fresh, event);
}

/** Use a lifeline. All three are FREE and usable once per attempt. */
export async function useLifeline(input: {
  token: unknown;
  attemptId: string;
  lifeline: "fifty" | "hint" | "skip";
}) {
  const guestId = await requireGuest(input.token);
  const event = await getEvent();
  let attempt = await loadAttempt(guestId, input.attemptId);
  attempt = await enforceTimeout(attempt, event);
  if (attempt["status"] !== "active") return { view: await buildView(attempt, event) };

  const column =
    input.lifeline === "fifty"
      ? "fifty_fifty_used"
      : input.lifeline === "hint"
        ? "hint_used"
        : "skip_used";
  if (attempt[column]) throw new Error("That lifeline has already been used in this attempt.");

  const current = Number(attempt["current_question"]);
  const qRow = await currentQuestionRow(String(attempt["id"]), current);
  if (!qRow) throw new Error("Question not found.");

  // Same window rule as answering: a lifeline used during the 10s get-ready
  // countdown would otherwise be consumed before the question was ever live.
  if (!answerWindowOpen(attempt)) throw new Error("This question is not ready yet.");
  // A question that is already resolved cannot take another lifeline.
  if (qRow["answered_at"] || qRow["was_skipped"]) {
    throw new Error("This question has already been answered.");
  }

  // Atomically consume the lifeline (false → true) so a double click uses one.
  const { data: consumed } = await sdb()
    .from("crorepati_attempts")
    .update({ [column]: true })
    .eq("id", attempt["id"])
    .eq(column, false)
    .eq("status", "active")
    .select()
    .maybeSingle();
  if (!consumed) throw new Error("That lifeline has already been used in this attempt.");

  if (input.lifeline === "fifty") {
    const correctIndex = Number(qRow["correct_index"]);
    const wrong = [0, 1, 2, 3].filter((i) => i !== correctIndex);
    // Remove exactly two wrong options; one wrong + the correct one remain.
    const shuffled = wrong
      .sort(() => Math.random() - 0.5)
      .slice(0, 2)
      .sort();
    await sdb()
      .from("crorepati_attempt_questions")
      .update({ fifty_removed: shuffled })
      .eq("id", qRow["id"]);
    return { view: await buildView(consumed, event), removedOptions: shuffled };
  }

  if (input.lifeline === "hint") {
    const hint =
      String(qRow["hint"] ?? "").trim() ||
      `Think about the ${String(qRow["category"])} category — eliminate the options that do not belong there.`;
    await sdb()
      .from("crorepati_attempt_questions")
      .update({ hint_shown: true })
      .eq("id", qRow["id"]);
    return { view: await buildView(consumed, event), hint };
  }

  // SKIP — question is not counted as cleared; move on with fresh timers.
  await sdb()
    .from("crorepati_attempt_questions")
    .update({ was_skipped: true, answered_at: new Date().toISOString(), was_correct: false })
    .eq("id", qRow["id"])
    .is("answered_at", null);

  if (current >= CROREPATI_QUESTION_COUNT) {
    const { data: bumped } = await sdb()
      .from("crorepati_attempts")
      .update({ skipped_questions: Number(attempt["skipped_questions"]) + 1 })
      .eq("id", attempt["id"])
      .select()
      .single();
    const ended = await endAttempt(bumped, event, { status: "lost" });
    return { view: await buildView(ended, event), skipped: true };
  }

  const { data: advanced } = await sdb()
    .from("crorepati_attempts")
    .update({
      skipped_questions: Number(attempt["skipped_questions"]) + 1,
      current_question: current + 1,
      game_state: "QUESTION_ANIMATING",
      presented_at: null,
      answer_timer_starts_at: null,
      deadline_at: null,
    })
    .eq("id", attempt["id"])
    .eq("current_question", current)
    .select()
    .maybeSingle();

  const fresh = advanced ?? (await loadAttempt(guestId, input.attemptId));
  return { view: await buildView(fresh, event), skipped: true };
}

/** Called by the client when its 90s countdown hits zero; server re-verifies. */
export async function reportTimeout(input: { token: unknown; attemptId: string }) {
  const guestId = await requireGuest(input.token);
  const event = await getEvent();
  const attempt = await loadAttempt(guestId, input.attemptId);
  if (attempt["status"] !== "active") return buildView(attempt, event);
  const deadline = deadlineOf(attempt);
  // The client cannot fake a timeout: the server clock decides.
  if (!deadline || Date.now() < deadline - CROREPATI_LATENCY_GRACE_MS)
    return buildView(attempt, event);
  const ended = await endAttempt(attempt, event, {
    status: "timeout",
    wrongAt: Number(attempt["current_question"]),
  });
  return buildView(ended, event);
}

/* ------------------------------------------------------------------ */
/* Profile data (rendered by the EXISTING profile page — no new page)   */
/* ------------------------------------------------------------------ */

export async function crorepatiProfileStats(token: unknown) {
  const guestId = await requireGuest(token);
  const { data } = await sdb()
    .from("crorepati_attempts")
    .select("id,status,cleared_questions,coin_reward,result,started_at,ended_at")
    .eq("guest_id", guestId)
    .order("started_at", { ascending: false })
    .limit(50);
  const rows: Row[] = data ?? [];
  const finished = rows.filter((r) => r["status"] !== "active");
  const { data: coinRows } = await sdb()
    .from("ustad_coin_ledger")
    .select("coins")
    .eq("guest_id", guestId)
    .eq("source", "crorepati");

  return {
    attempts: finished.length,
    wins: finished.filter((r) => r["status"] === "won").length,
    losses: finished.filter((r) => r["status"] === "lost" || r["status"] === "timeout").length,
    totalQuestionsCleared: finished.reduce((a, r) => a + Number(r["cleared_questions"] ?? 0), 0),
    totalCoins: (coinRows ?? []).reduce((a: number, r: Row) => a + Number(r["coins"] ?? 0), 0),
    bestCleared: finished.reduce((a, r) => Math.max(a, Number(r["cleared_questions"] ?? 0)), 0),
    history: finished.slice(0, 10).map((r) => ({
      attemptId: String(r["id"]),
      status: String(r["status"]),
      cleared: Number(r["cleared_questions"] ?? 0),
      coins: Number(r["coin_reward"] ?? 0),
      endedAt: (r["ended_at"] as string) ?? null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Leaderboard (public, verified attempts only)                        */
/* ------------------------------------------------------------------ */

export type CrorepatiLeaderboardRow = {
  rank: number;
  name: string;
  cleared: number;
  coins: number;
  result: string;
  endedAt: string | null;
  isYou: boolean;
};

/**
 * Top verified attempts for the Crorepati event. Ranked by questions cleared
 * first, then by the reward, then by who got there earlier. Only finished
 * attempts count, and only a display name is ever exposed.
 */
export async function crorepatiLeaderboard(token: unknown, limit = 20) {
  const guestId = await requireGuest(token);
  const { data } = await sdb()
    .from("crorepati_attempts")
    .select("guest_id,cleared_questions,coin_reward,result,status,ended_at")
    .neq("status", "active")
    .order("cleared_questions", { ascending: false })
    .order("coin_reward", { ascending: false })
    .order("ended_at", { ascending: true })
    .limit(300);

  const rows: Row[] = data ?? [];
  // One best attempt per player.
  const best = new Map<string, Row>();
  for (const r of rows) {
    const key = String(r["guest_id"]);
    const prev = best.get(key);
    if (
      !prev ||
      Number(r["cleared_questions"] ?? 0) > Number(prev["cleared_questions"] ?? 0) ||
      (Number(r["cleared_questions"] ?? 0) === Number(prev["cleared_questions"] ?? 0) &&
        Number(r["coin_reward"] ?? 0) > Number(prev["coin_reward"] ?? 0))
    ) {
      best.set(key, r);
    }
  }

  const ordered = [...best.values()]
    .sort(
      (a, b) =>
        Number(b["cleared_questions"] ?? 0) - Number(a["cleared_questions"] ?? 0) ||
        Number(b["coin_reward"] ?? 0) - Number(a["coin_reward"] ?? 0) ||
        Date.parse(String(a["ended_at"] ?? 0)) - Date.parse(String(b["ended_at"] ?? 0)),
    )
    .slice(0, Math.max(1, Math.min(limit, 50)));

  const ids = ordered.map((r) => String(r["guest_id"]));
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: profiles } = await sdb()
      .from("profiles")
      .select("guest_id,name")
      .in("guest_id", ids);
    for (const p of (profiles ?? []) as Row[]) {
      const n = String(p["name"] ?? "").trim();
      if (n) names.set(String(p["guest_id"]), n);
    }
  }

  return ordered.map<CrorepatiLeaderboardRow>((r, i) => {
    const gid = String(r["guest_id"]);
    return {
      rank: i + 1,
      name: gid === guestId ? "You" : (names.get(gid) ?? `Player ${gid.slice(0, 4).toUpperCase()}`),
      cleared: Number(r["cleared_questions"] ?? 0),
      coins: Number(r["coin_reward"] ?? 0),
      result: String(r["result"] ?? r["status"] ?? ""),
      endedAt: (r["ended_at"] as string) ?? null,
      isYou: gid === guestId,
    };
  });
}
