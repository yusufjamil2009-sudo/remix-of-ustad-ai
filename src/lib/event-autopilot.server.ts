/**
 * USTAD AI — EVENT AUTOPILOT.
 *
 * Keeps USTAD AI supplied with a never-ending stream of dynamic events without
 * anybody having to author one:
 *
 *   • a new event is scheduled every 7 / 10 / 12 / 13 days (rotating cadence),
 *   • each event has its own theme, question count, timers and coin rewards,
 *   • the next event row is created ~3.5 days early so the EXISTING notification
 *     scheduler can deliver its 3-day / 2-day / 1-day / LIVE reminders,
 *   • exactly ONE event is visible at a time: the running event stays live and
 *     playable until the next one opens, and only then is it retired
 *     (closed → finalized → archived).
 *
 * Retiring is archival only. Everything a player earned from the event —
 * coins in `ustad_coin_ledger`, trophies, certificates and their verify URLs,
 * `master_event_results` history — is untouched and keeps showing in the
 * profile. Only the events page stops listing the old event.
 *
 * This file adds no second scheduling mechanism: it is driven by the same
 * shared-secret cron route convention already used by the exam and reminder
 * schedulers, and additionally reconciles lazily whenever the events list is
 * read, so the stream never stalls.
 */
import { db } from "./guest.server";
import { canTransition, resolveQuestionCount, type EventStatus } from "./master-event-spec";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sdb = () => db() as any;
type Row = Record<string, any>;

const DAY = 86_400_000;
/** How early the next event row appears, so 3-day reminders can be delivered. */
const ANNOUNCE_LEAD_MS = 3.5 * DAY;
/** Rotating cadence — "hafte hafte, ya 10 din, ya 12-13 din". */
const GAP_DAYS = [7, 10, 12, 13] as const;

export type EventBlueprint = {
  slug: string;
  name: string;
  description: string;
  category: string;
  difficulty: "easy" | "medium" | "hard" | "mixed";
  questionCount: number;
  preTimerSeconds: number;
  answerTimerSeconds: number;
  /** Correct answers needed to count as a win (0 = every question). */
  requiredCorrect: number;
  perCorrect: number;
  win: number;
  participation: number;
  eliminatedOnWrong: boolean;
};

/**
 * The catalogue the autopilot draws from. Every entry is a genuinely different
 * event: different theme, different length, different pace, different reward.
 */
export const EVENT_BLUEPRINTS: readonly EventBlueprint[] = [
  {
    slug: "gk-champion",
    name: "USTAD GK Champion",
    description: "General knowledge sprint — 10 verified questions, steady pace.",
    category: "general knowledge",
    difficulty: "mixed",
    questionCount: 10,
    preTimerSeconds: 10,
    answerTimerSeconds: 45,
    requiredCorrect: 7,
    perCorrect: 500,
    win: 10_000,
    participation: 1_000,
    eliminatedOnWrong: false,
  },
  {
    slug: "current-affairs-cup",
    name: "Current Affairs Cup",
    description: "This month's India and world news, awards, sports and schemes.",
    category: "current affairs",
    difficulty: "medium",
    questionCount: 15,
    preTimerSeconds: 10,
    answerTimerSeconds: 40,
    requiredCorrect: 10,
    perCorrect: 700,
    win: 20_000,
    participation: 1_500,
    eliminatedOnWrong: false,
  },
  {
    slug: "science-space",
    name: "Science & Space Challenge",
    description: "Physics, biology, ISRO and space missions.",
    category: "science and space",
    difficulty: "medium",
    questionCount: 12,
    preTimerSeconds: 10,
    answerTimerSeconds: 50,
    requiredCorrect: 8,
    perCorrect: 800,
    win: 25_000,
    participation: 1_500,
    eliminatedOnWrong: false,
  },
  {
    slug: "maths-blitz",
    name: "Maths Blitz",
    description: "Fast mental maths — short clock, no second chances.",
    category: "mathematics",
    difficulty: "hard",
    questionCount: 10,
    preTimerSeconds: 8,
    answerTimerSeconds: 25,
    requiredCorrect: 0,
    perCorrect: 1_200,
    win: 40_000,
    participation: 2_000,
    eliminatedOnWrong: true,
  },
  {
    slug: "history-heritage",
    name: "History & Heritage Quiz",
    description: "Indian history, freedom movement, monuments and culture.",
    category: "history and culture",
    difficulty: "medium",
    questionCount: 15,
    preTimerSeconds: 10,
    answerTimerSeconds: 45,
    requiredCorrect: 10,
    perCorrect: 600,
    win: 20_000,
    participation: 1_200,
    eliminatedOnWrong: false,
  },
  {
    slug: "sports-super-over",
    name: "Sports Super Over",
    description: "Cricket, Olympics, football and record breakers.",
    category: "sports",
    difficulty: "easy",
    questionCount: 12,
    preTimerSeconds: 8,
    answerTimerSeconds: 30,
    requiredCorrect: 8,
    perCorrect: 500,
    win: 15_000,
    participation: 1_000,
    eliminatedOnWrong: false,
  },
  {
    slug: "grand-master",
    name: "USTAD Grand Master",
    description: "The long one — 20 questions, big trophy, big coins.",
    category: "mixed mastery",
    difficulty: "hard",
    questionCount: 20,
    preTimerSeconds: 10,
    answerTimerSeconds: 60,
    requiredCorrect: 15,
    perCorrect: 1_000,
    win: 100_000,
    participation: 3_000,
    eliminatedOnWrong: false,
  },
  {
    slug: "geography-explorer",
    name: "Geography Explorer",
    description: "Rivers, capitals, states and world landmarks.",
    category: "geography",
    difficulty: "easy",
    questionCount: 12,
    preTimerSeconds: 10,
    answerTimerSeconds: 40,
    requiredCorrect: 8,
    perCorrect: 500,
    win: 15_000,
    participation: 1_000,
    eliminatedOnWrong: false,
  },
  {
    slug: "brain-teaser-night",
    name: "Brain Teaser Night",
    description: "Reasoning and puzzles — think before you tap.",
    category: "logical reasoning",
    difficulty: "hard",
    questionCount: 10,
    preTimerSeconds: 10,
    answerTimerSeconds: 70,
    requiredCorrect: 7,
    perCorrect: 900,
    win: 30_000,
    participation: 2_000,
    eliminatedOnWrong: false,
  },
  {
    slug: "sudden-death",
    name: "Sudden Death Sprint",
    description: "One wrong answer ends it. Survive all 15 for the cup.",
    category: "general knowledge",
    difficulty: "hard",
    questionCount: 15,
    preTimerSeconds: 8,
    answerTimerSeconds: 30,
    requiredCorrect: 0,
    perCorrect: 1_500,
    win: 75_000,
    participation: 2_500,
    eliminatedOnWrong: true,
  },
  {
    slug: "technology-ai",
    name: "Technology & AI Quiz",
    description: "Computers, the internet, gadgets and artificial intelligence.",
    category: "technology",
    difficulty: "medium",
    questionCount: 12,
    preTimerSeconds: 10,
    answerTimerSeconds: 45,
    requiredCorrect: 8,
    perCorrect: 700,
    win: 22_000,
    participation: 1_500,
    eliminatedOnWrong: false,
  },
  {
    slug: "festival-special",
    name: "USTAD Festival Special",
    description: "A celebration round — easier questions, generous coins.",
    category: "festivals and traditions",
    difficulty: "easy",
    questionCount: 10,
    preTimerSeconds: 12,
    answerTimerSeconds: 50,
    requiredCorrect: 6,
    perCorrect: 800,
    win: 30_000,
    participation: 3_000,
    eliminatedOnWrong: false,
  },
];

/* ------------------------------------------------------------------ */
/* Unlimited variety — the AI invents a brand-new event each time       */
/* ------------------------------------------------------------------ */

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function slugify(value: string, fallback: string): string {
  const s = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

/**
 * Ask USTAD AI to invent a genuinely new event: any theme, any length, any
 * pace, any reward. The catalogue above is only the safety net for when no
 * provider answers, so the stream of events is never limited to 12 kinds.
 */
export async function inventBlueprint(index: number): Promise<EventBlueprint> {
  const fallback = pick(EVENT_BLUEPRINTS, index);
  try {
    const { coreCandidates } = await import("./api-manager.server");
    const { runChat } = await import("./router.server");
    const { parseJsonLoose } = await import("./exam-ai.server");
    const candidates = coreCandidates();
    if (!candidates.length) return fallback;

    const recent = (await autoEvents())
      .slice(0, 12)
      .map((e) => String(e["name"]))
      .join(", ");

    const res = await runChat({
      candidates,
      messages: [
        {
          role: "system",
          content:
            "You design quiz events for USTAD AI, an Indian study app. Invent ONE brand-new " +
            "quiz event that is different from anything listed as recent. Any subject is allowed: " +
            "school subjects, current affairs, culture, cinema, food, environment, careers, " +
            "puzzles, festivals, coding, art, anything interesting for Indian students. " +
            'Reply with JSON only: {"name":string,"description":string,"category":string,' +
            '"difficulty":"easy"|"medium"|"hard"|"mixed","questionCount":5-30,' +
            '"preTimerSeconds":5-20,"answerTimerSeconds":15-120,"requiredCorrect":number,' +
            '"perCorrect":100-3000,"win":5000-200000,"participation":500-5000,' +
            '"eliminatedOnWrong":boolean}. Questions are generated later, do not include any.',
        },
        {
          role: "user",
          content: `Recent events (avoid repeating these themes): ${recent || "none yet"}. Invent event number ${index + 1}.`,
        },
      ],
      maxTokens: 700,
    });

    const raw = parseJsonLoose<Record<string, unknown>>(res.text);
    const name = String(raw["name"] ?? "")
      .trim()
      .slice(0, 80);
    if (!name) return fallback;
    const questionCount = clampInt(raw["questionCount"], 5, 30, fallback.questionCount);
    const difficultyRaw = String(raw["difficulty"] ?? "").toLowerCase();
    const difficulty = (
      ["easy", "medium", "hard", "mixed"].includes(difficultyRaw)
        ? difficultyRaw
        : fallback.difficulty
    ) as EventBlueprint["difficulty"];

    return {
      slug: `${slugify(name, fallback.slug)}-${index + 1}`,
      name,
      description:
        String(raw["description"] ?? fallback.description)
          .trim()
          .slice(0, 240) || fallback.description,
      category:
        String(raw["category"] ?? fallback.category)
          .trim()
          .slice(0, 60) || fallback.category,
      difficulty,
      questionCount,
      preTimerSeconds: clampInt(raw["preTimerSeconds"], 5, 20, fallback.preTimerSeconds),
      answerTimerSeconds: clampInt(raw["answerTimerSeconds"], 15, 120, fallback.answerTimerSeconds),
      requiredCorrect: clampInt(raw["requiredCorrect"], 0, questionCount, 0),
      perCorrect: clampInt(raw["perCorrect"], 100, 3_000, fallback.perCorrect),
      win: clampInt(raw["win"], 5_000, 200_000, fallback.win),
      participation: clampInt(raw["participation"], 500, 5_000, fallback.participation),
      eliminatedOnWrong: Boolean(raw["eliminatedOnWrong"]),
    };
  } catch {
    return fallback;
  }
}

export type AutopilotReport = {
  created: Array<{ code: string; name: string; startTime: string; endTime: string }>;
  retired: string[];
  live: string | null;
  upcoming: string | null;
};

function pick<T>(list: readonly T[], index: number): T {
  return list[((index % list.length) + list.length) % list.length] as T;
}

function seriesNumber(code: string): number {
  const m = /-(\d+)$/.exec(code);
  return m ? Number(m[1]) : 0;
}

async function autoEvents(): Promise<Row[]> {
  const { data } = await sdb()
    .from("master_events")
    .select("*")
    .eq("event_type", "dynamic")
    .like("code", "ustad-auto-%")
    .order("start_time", { ascending: false })
    .limit(50);
  return (data as Row[]) ?? [];
}

async function setStatus(event: Row, to: EventStatus, patch: Row = {}): Promise<Row | null> {
  const from = String(event["status"]) as EventStatus;
  if (from === to) return event;
  if (!canTransition(from, to)) return null;
  const body: Row = { status: to, updated_at: new Date().toISOString(), ...patch };
  if (to === "finalized") body["finalized_at"] = new Date().toISOString();
  const { data } = await sdb()
    .from("master_events")
    .update(body)
    .eq("id", event["id"])
    .eq("status", from)
    .select()
    .maybeSingle();
  return (data as Row) ?? null;
}

/**
 * Retire an event that has been replaced. Rewards already earned stay exactly
 * where they are; only the listing goes away.
 */
async function retire(event: Row, nowIso: string): Promise<boolean> {
  let row: Row | null = event;
  const status = String(event["status"]) as EventStatus;
  if (status === "scheduled") {
    row = await setStatus(event, "cancelled", {
      cancelled_at: nowIso,
      cancel_reason: "replaced by the next USTAD event",
    });
    if (row) row = await setStatus(row, "archived");
    return Boolean(row);
  }
  if (status === "open" || status === "active") {
    row = await setStatus(event, "closed", { end_time: nowIso });
  }
  if (row && String(row["status"]) === "closed") row = await setStatus(row, "finalized");
  if (row && String(row["status"]) === "finalized") row = await setStatus(row, "archived");
  if (row && String(row["status"]) === "cancelled") row = await setStatus(row, "archived");
  return Boolean(row && String(row["status"]) === "archived");
}

async function createAutoEvent(
  index: number,
  startMs: number,
  gapDays: number,
): Promise<{ code: string; name: string; startTime: string; endTime: string } | null> {
  const bp = await inventBlueprint(index);
  const code = `ustad-auto-${bp.slug}-${index + 1}`.slice(0, 90);
  const startTime = new Date(startMs).toISOString();
  // The event stays live and playable right up to the moment the next one opens.
  const endTime = new Date(startMs + gapDays * DAY).toISOString();
  const nextStartAt = endTime;

  const { data, error } = await sdb()
    .from("master_events")
    .insert({
      code,
      name: bp.name,
      description: bp.description,
      event_type: "dynamic",
      status: "scheduled",
      question_count: resolveQuestionCount(bp.questionCount),
      question_source: "ai",
      start_time: startTime,
      end_time: endTime,
      timezone: "Asia/Kolkata",
      pre_timer_seconds: bp.preTimerSeconds,
      answer_timer_seconds: bp.answerTimerSeconds,
      total_timer_seconds: 0,
      multiplayer_enabled: false,
      min_players: 1,
      max_players: 1,
      required_correct: bp.requiredCorrect,
      category: bp.category,
      difficulty: bp.difficulty,
      entry_config: { type: "free", coinCost: 0 },
      reward_config: {
        perCorrect: bp.perCorrect,
        win: bp.win,
        participation: bp.participation,
      },
      gameplay_config: {
        eliminatedOnWrong: bp.eliminatedOnWrong,
        autoGenerated: true,
        blueprint: bp.slug,
        nextStartAt,
        gapDays,
      },
      achievement_config: { awardTrophy: true, trophyType: "normal_cup" },
      certificate_config: { enabled: true },
      leaderboard_enabled: true,
      published_at: new Date().toISOString(),
      created_by: "ustad-autopilot",
    })
    .select("code,name,start_time,end_time")
    .maybeSingle();

  if (error || !data) return null;
  return {
    code: String(data["code"]),
    name: String(data["name"]),
    startTime: String(data["start_time"]),
    endTime: String(data["end_time"]),
  };
}

/**
 * One autopilot tick. Safe to run as often as you like: every step is guarded
 * by a status check, so a concurrent or replayed tick cannot create two events
 * for the same slot or retire the same event twice.
 */
export async function runEventAutopilotTick(now: Date = new Date()): Promise<AutopilotReport> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const report: AutopilotReport = { created: [], retired: [], live: null, upcoming: null };

  let rows = (await autoEvents()).filter((e) => String(e["status"]) !== "archived");

  // 1. Advance statuses from server time (scheduled → open, open → closed).
  for (const row of rows) {
    const start = row["start_time"] ? Date.parse(String(row["start_time"])) : NaN;
    const end = row["end_time"] ? Date.parse(String(row["end_time"])) : NaN;
    const status = String(row["status"]) as EventStatus;
    if (status === "scheduled" && Number.isFinite(start) && nowMs >= start) {
      const next = await setStatus(row, "open", { published_at: nowIso });
      if (next) Object.assign(row, next);
    }
    const nowStatus = String(row["status"]);
    if ((nowStatus === "open" || nowStatus === "active") && Number.isFinite(end) && nowMs >= end) {
      const next = await setStatus(row, "closed");
      if (next) Object.assign(row, next);
    }
  }

  // 2. Bootstrap: no auto event exists yet → open one immediately.
  const anyStarted = rows.some(
    (e) => e["start_time"] && Date.parse(String(e["start_time"])) <= nowMs,
  );
  if (!anyStarted && rows.length === 0) {
    const all = await autoEvents();
    const index = all.length;
    const gap = pick(GAP_DAYS, index);
    const made = await createAutoEvent(index, nowMs - 60_000, gap);
    if (made) report.created.push(made);
    rows = (await autoEvents()).filter((e) => String(e["status"]) !== "archived");
    for (const row of rows) {
      if (String(row["status"]) === "scheduled") {
        const next = await setStatus(row, "open", { published_at: nowIso });
        if (next) Object.assign(row, next);
      }
    }
  }

  const started = rows
    .filter((e) => e["start_time"] && Date.parse(String(e["start_time"])) <= nowMs)
    .sort((a, b) => Date.parse(String(b["start_time"])) - Date.parse(String(a["start_time"])));
  const current = started[0] ?? null;
  const upcoming = rows
    .filter((e) => e["start_time"] && Date.parse(String(e["start_time"])) > nowMs)
    .sort((a, b) => Date.parse(String(a["start_time"])) - Date.parse(String(b["start_time"])))[0];

  // 3. One event at a time: everything older than the current one is retired.
  for (const row of started.slice(1)) {
    if (await retire(row, nowIso)) report.retired.push(String(row["code"]));
  }

  // 4. Announce the next event ~3.5 days early so reminders can go out.
  if (current && !upcoming) {
    const cfg = (current["gameplay_config"] ?? {}) as Row;
    const plannedIso = cfg["nextStartAt"]
      ? String(cfg["nextStartAt"])
      : String(current["end_time"]);
    let plannedMs = Date.parse(plannedIso);
    if (!Number.isFinite(plannedMs)) plannedMs = nowMs + 7 * DAY;
    // If the current event already ended (it stayed live until now), start the
    // next one shortly, so the stream never has a hole.
    if (plannedMs <= nowMs) plannedMs = nowMs + 5 * 60_000;

    if (plannedMs - nowMs <= ANNOUNCE_LEAD_MS) {
      const all = await autoEvents();
      const index = Math.max(all.length, seriesNumber(String(current["code"])));
      const gap = pick(GAP_DAYS, index);
      const made = await createAutoEvent(index, plannedMs, gap);
      if (made) report.created.push(made);
    }
  }

  const fresh = (await autoEvents()).filter((e) => String(e["status"]) !== "archived");
  const live =
    fresh
      .filter((e) => e["start_time"] && Date.parse(String(e["start_time"])) <= nowMs)
      .sort(
        (a, b) => Date.parse(String(b["start_time"])) - Date.parse(String(a["start_time"])),
      )[0] ?? null;
  const next =
    fresh
      .filter((e) => e["start_time"] && Date.parse(String(e["start_time"])) > nowMs)
      .sort(
        (a, b) => Date.parse(String(a["start_time"])) - Date.parse(String(b["start_time"])),
      )[0] ?? null;
  report.live = live ? String(live["code"]) : null;
  report.upcoming = next ? String(next["code"]) : null;
  return report;
}
