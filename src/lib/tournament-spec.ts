/**
 * USTAD AI — MYSTERY + PSYCHOLOGY WEEKLY TOURNAMENT (kind: "mystery")
 * USTAD AI — GOD MASTER WEEKLY TOURNAMENT          (kind: "god")
 *
 * Shared, side-effect-free specification imported by BOTH the browser UI and
 * the server engine, exactly like `crorepati-spec.ts` and `mega-spec.ts`, so a
 * rule can never drift between client and server.
 *
 * Nothing here replaces an existing feature. Coins, wallet, trophies,
 * certificates, notifications, language settings and the guest session all stay
 * with their existing owners; this file only describes the two new tournaments.
 */

export type TournamentKind = "mystery" | "god";
export type TournamentLanguage = "english" | "hindi" | "hinglish";

export type TournamentConfig = {
  kind: TournamentKind;
  code: string;
  path: string;
  title: string;
  /** Fixed number of questions/cases in one attempt. */
  questionCount: number;
  /** Minimum correct answers required to WIN. */
  requiredCorrect: number;
  /** Coins charged to enter one attempt. */
  entryFee: number;
  /** Coins credited exactly once on a verified win. */
  winReward: number;
  /** God Tournament also needs one ticket from the shop. */
  requiresTicket: boolean;
  /** Coin price of that ticket in the shop. */
  ticketPrice: number;
  /** Attempts allowed per India calendar day (while not locked). */
  attemptsPerDay: number;
  /** Attempts allowed per weekly cycle (0 = unlimited, day limit still applies). */
  attemptsPerCycle: number;
};

export const MYSTERY: TournamentConfig = {
  kind: "mystery",
  code: "ustad-mystery-weekly",
  path: "/tournament",
  title: "USTAD Mystery + Psychology Tournament",
  questionCount: 20,
  requiredCorrect: 12,
  entryFee: 40_000_000, // 4,00,00,000 USTAD Coins
  winReward: 30_000_000, // 3,00,00,000 USTAD Coins
  requiresTicket: false,
  ticketPrice: 0,
  attemptsPerDay: 1,
  attemptsPerCycle: 0,
};

export const GOD: TournamentConfig = {
  kind: "god",
  code: "ustad-god-weekly",
  path: "/god-tournament",
  title: "USTAD GOD MASTER Tournament",
  questionCount: 20,
  requiredCorrect: 16,
  entryFee: 100_000_000, // 10,00,00,000 USTAD Coins
  winReward: 150_000_000, // 15,00,00,000 USTAD Coins
  requiresTicket: true,
  ticketPrice: 100_000_000, // 10,00,00,000 USTAD Coins
  attemptsPerDay: 1,
  attemptsPerCycle: 1,
};

export const TOURNAMENTS: Record<TournamentKind, TournamentConfig> = {
  mystery: MYSTERY,
  god: GOD,
};

export function configFor(kind: string): TournamentConfig {
  const cfg = TOURNAMENTS[kind as TournamentKind];
  if (!cfg) throw new Error("Unknown tournament.");
  return cfg;
}

/** God Tournament ticket, sold through the existing shop screen. */
export const GOD_TICKET = {
  itemId: "god_tournament_ticket",
  name: "God Tournament Ticket",
  price: GOD.ticketPrice,
  description:
    "One entry ticket for the USTAD GOD MASTER Tournament. Consumed when a match starts. It never affects answers, timers or scoring.",
};

/* ------------------------------------------------------------------ */
/* India-time helpers — one clock for both tournaments                 */
/* ------------------------------------------------------------------ */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** India calendar day key (YYYY-MM-DD) for an instant. */
export function istDateKey(at: Date | number = Date.now()): string {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export type TournamentCycle = { id: string; startsAt: string; endsAt: string };

/**
 * Weekly cycle: Monday 00:00 IST → next Monday 00:00 IST.
 * Deterministic, so client and server always agree on "this week".
 */
export function cycleFor(kind: TournamentKind, at: Date | number = Date.now()): TournamentCycle {
  const ms = typeof at === "number" ? at : at.getTime();
  const ist = new Date(ms + IST_OFFSET_MS);
  const dow = (ist.getUTCDay() + 6) % 7; // Monday = 0
  const dayStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  const weekStartIst = dayStart - dow * 86_400_000;
  const startsAt = new Date(weekStartIst - IST_OFFSET_MS);
  const endsAt = new Date(weekStartIst + 7 * 86_400_000 - IST_OFFSET_MS);
  const key = new Date(weekStartIst).toISOString().slice(0, 10);
  return { id: `${kind}-${key}`, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

/** Coin formatting in the Indian system, used by both tournament screens. */
export function formatIndianCoins(value: number): string {
  const n = Math.round(Math.abs(value));
  const s = String(n);
  if (s.length <= 3) return `${value < 0 ? "-" : ""}${s}`;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${value < 0 ? "-" : ""}${rest},${last3}`;
}

/* ------------------------------------------------------------------ */
/* Scoring — server authoritative, mirrored here for the review screen */
/* ------------------------------------------------------------------ */

export function isWin(kind: TournamentKind, correct: number): boolean {
  return correct >= configFor(kind).requiredCorrect;
}

export type LockReason =
  "open" | "won_this_week" | "played_today" | "played_this_week" | "no_coins" | "no_ticket";

/* ------------------------------------------------------------------ */
/* Ranking titles (God Tournament)                                     */
/* ------------------------------------------------------------------ */

export function godTitleFor(wins: number): string {
  if (wins >= 3) return "USTAD GOD";
  if (wins >= 1) return "JUNIOR GOD";
  return "Challenger";
}

/* ------------------------------------------------------------------ */
/* UI strings in the three supported languages (spec: language follows */
/* the user's existing setting and is locked for the whole attempt).   */
/* ------------------------------------------------------------------ */

type Strings = {
  entryFee: string;
  reward: string;
  balance: string;
  tickets: string;
  buyTicket: string;
  start: string;
  starting: string;
  question: string;
  lockAnswer: string;
  hiddenScore: string;
  suspects: string;
  clues: string;
  timeline: string;
  review: string;
  won: string;
  lost: string;
  wonLock: string;
  playedToday: string;
  playedWeek: string;
  needCoins: string;
  needTicket: string;
  correct: string;
  yourAnswer: string;
  explanation: string;
  solution: string;
  certificate: string;
  leaderboard: string;
  rules: string;
};

export const STRINGS: Record<TournamentLanguage, Strings> = {
  english: {
    entryFee: "Entry fee",
    reward: "Winning reward",
    balance: "Your USTAD Coins",
    tickets: "God tickets",
    buyTicket: "Buy a ticket",
    start: "Start the tournament",
    starting: "Preparing your cases…",
    question: "Question",
    lockAnswer: "Lock answer",
    hiddenScore: "Your score stays hidden until question 20.",
    suspects: "Suspects",
    clues: "Clues",
    timeline: "Timeline",
    review: "Full review",
    won: "You won!",
    lost: "Not this time.",
    wonLock: "You already won this week. The next entry opens next week.",
    playedToday: "You already played today. Come back tomorrow.",
    playedWeek: "You already played this week. Come back next week.",
    needCoins: "Not enough USTAD Coins for the entry fee.",
    needTicket: "You need a God Tournament Ticket from the shop.",
    correct: "Correct answer",
    yourAnswer: "Your answer",
    explanation: "Explanation",
    solution: "Detailed solution",
    certificate: "Your certificate",
    leaderboard: "Verified ranking",
    rules: "Rules",
  },
  hindi: {
    entryFee: "प्रवेश शुल्क",
    reward: "जीत का इनाम",
    balance: "आपके USTAD Coins",
    tickets: "गॉड टिकट",
    buyTicket: "टिकट खरीदें",
    start: "टूर्नामेंट शुरू करें",
    starting: "आपके केस तैयार हो रहे हैं…",
    question: "प्रश्न",
    lockAnswer: "उत्तर लॉक करें",
    hiddenScore: "आपका स्कोर 20वें प्रश्न तक छिपा रहेगा।",
    suspects: "संदिग्ध",
    clues: "सुराग",
    timeline: "घटनाक्रम",
    review: "पूरा विश्लेषण",
    won: "आप जीत गए!",
    lost: "इस बार नहीं।",
    wonLock: "आप इस हफ्ते जीत चुके हैं। अगली एंट्री अगले हफ्ते खुलेगी।",
    playedToday: "आप आज खेल चुके हैं। कल फिर आइए।",
    playedWeek: "आप इस हफ्ते खेल चुके हैं। अगले हफ्ते आइए।",
    needCoins: "प्रवेश शुल्क के लिए पर्याप्त USTAD Coins नहीं हैं।",
    needTicket: "आपको शॉप से गॉड टूर्नामेंट टिकट चाहिए।",
    correct: "सही उत्तर",
    yourAnswer: "आपका उत्तर",
    explanation: "व्याख्या",
    solution: "विस्तृत हल",
    certificate: "आपका प्रमाणपत्र",
    leaderboard: "सत्यापित रैंकिंग",
    rules: "नियम",
  },
  hinglish: {
    entryFee: "Entry fee",
    reward: "Jeet ka reward",
    balance: "Aapke USTAD Coins",
    tickets: "God tickets",
    buyTicket: "Ticket kharidein",
    start: "Tournament shuru karein",
    starting: "Aapke cases taiyar ho rahe hain…",
    question: "Sawaal",
    lockAnswer: "Answer lock karein",
    hiddenScore: "Aapka score 20th sawaal tak chhupa rahega.",
    suspects: "Suspects",
    clues: "Clues",
    timeline: "Timeline",
    review: "Poora review",
    won: "Aap jeet gaye!",
    lost: "Is baar nahi.",
    wonLock: "Aap is hafte jeet chuke hain. Agli entry agle hafte khulegi.",
    playedToday: "Aap aaj khel chuke hain. Kal phir aaiye.",
    playedWeek: "Aap is hafte khel chuke hain. Agle hafte aaiye.",
    needCoins: "Entry fee ke liye USTAD Coins kam hain.",
    needTicket: "Shop se God Tournament Ticket chahiye.",
    correct: "Sahi jawab",
    yourAnswer: "Aapka jawab",
    explanation: "Explanation",
    solution: "Detailed solution",
    certificate: "Aapka certificate",
    leaderboard: "Verified ranking",
    rules: "Rules",
  },
};

export function stringsFor(language: string): Strings {
  return STRINGS[
    (language as TournamentLanguage) in STRINGS ? (language as TournamentLanguage) : "english"
  ];
}

/* ------------------------------------------------------------------ */
/* Client-visible shapes                                               */
/* ------------------------------------------------------------------ */

export type TournamentQuestionView = {
  position: number;
  prompt: string;
  options: string[];
  category: string;
  difficulty: string;
  caseTitle?: string;
  story?: string;
  suspects?: string[];
  clues?: string[];
  timeline?: string[];
  selectedIndex: number | null;
};

export type TournamentReviewItem = {
  position: number;
  prompt: string;
  options: string[];
  correctIndex: number;
  selectedIndex: number | null;
  isCorrect: boolean;
  explanation: string;
  solution: string;
  caseTitle?: string;
};

export type TournamentResultView = {
  attemptId: string;
  result: "WIN" | "LOSS";
  correctCount: number;
  wrongCount: number;
  questionCount: number;
  requiredCorrect: number;
  coinsAwarded: number;
  certificateUrl: string;
  trophyAwarded: boolean;
  review: TournamentReviewItem[];
};

export type TournamentStateView = {
  kind: TournamentKind;
  title: string;
  language: TournamentLanguage;
  cycle: TournamentCycle;
  entryFee: number;
  winReward: number;
  questionCount: number;
  requiredCorrect: number;
  requiresTicket: boolean;
  ticketPrice: number;
  balance: number;
  tickets: number;
  lock: LockReason;
  lockMessage: string;
  canPlay: boolean;
  wonThisCycle: boolean;
  attempt: {
    attemptId: string;
    answered: number;
    questionCount: number;
    question: TournamentQuestionView | null;
  } | null;
  lastResult: TournamentResultView | null;
  badge: string;
  totalWins: number;
};
