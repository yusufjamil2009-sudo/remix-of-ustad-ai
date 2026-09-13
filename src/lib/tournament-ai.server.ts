/**
 * Question/case generation for the two new weekly tournaments.
 *
 * Reuses the EXISTING USTAD AI Router / API Manager / USTAD Core fallback chain
 * (identical approach to `crorepati-ai.server.ts`). It never talks to a provider
 * directly, never ships a fixed hard-coded set, and always asks for a fresh set
 * seeded with an avoid-list so two attempts are never identical.
 */
import { usableProviders, coreCandidates } from "./api-manager.server";
import { selectChatProviders, runChat, route, type Language } from "./router.server";
import { parseJsonLoose, salvageJsonObjects } from "./exam-ai.server";
import type { ChatMessage } from "./provider-clients.server";
import type { TournamentKind } from "./tournament-spec";

export type TournamentItem = {
  caseTitle: string;
  story: string;
  suspects: string[];
  clues: string[];
  timeline: string[];
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  solution: string;
  category: string;
  difficulty: string;
};

function languageRule(language: Language): string {
  if (language === "hindi")
    return "Write everything in natural Hindi (Devanagari script). Do not mix English sentences.";
  if (language === "hinglish")
    return "Write everything in Hinglish (Roman-script Hindi mixed with English), conversational and clear.";
  return "Write everything in clear, simple English.";
}

const MYSTERY_THEMES = [
  "a locked-room theft",
  "a workplace sabotage",
  "a missing exam paper at a school",
  "a disappearance during a family wedding",
  "a poisoning at a small restaurant",
  "a forged signature in an office",
  "a psychological manipulation case (gaslighting)",
  "a lie-detection interview with four suspects",
  "a stolen artefact in a museum",
  "a hit-and-run with four witnesses",
  "an online scam traced to one of four people",
  "a body-language and micro-expression reading case",
];

const GOD_THEMES = [
  "multi-step logical deduction",
  "lateral thinking",
  "advanced probability and combinatorics",
  "cryptic pattern and sequence breaking",
  "situational judgement and ethics reasoning",
  "data interpretation traps",
  "paradox resolution",
  "spatial and 3D reasoning",
  "linguistic and cryptogram puzzles",
  "psychology of decision-making experiments",
  "physics and mathematics reasoning puzzles",
  "strategy and game-theory problems",
];

type Raw = Record<string, unknown>;

function str(v: unknown, max = 2000): string {
  return String(v ?? "")
    .trim()
    .slice(0, max);
}

function list(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => str(x, 300))
    .filter(Boolean)
    .slice(0, max);
}

function clean(kind: TournamentKind, rows: Raw[], seen: Set<string>): TournamentItem[] {
  const out: TournamentItem[] = [];
  for (const r of rows ?? []) {
    const prompt = str(r["question"] ?? r["prompt"], 900);
    if (prompt.length < 10) continue;
    const options = list(r["options"], 4);
    if (options.length !== 4) continue;
    if (new Set(options.map((o) => o.toLowerCase())).size !== 4) continue;

    let correctIndex = -1;
    const ci = r["correctIndex"];
    if (typeof ci === "number" && ci >= 0 && ci <= 3) correctIndex = Math.floor(ci);
    else {
      const answer = str(r["answer"], 200);
      const letter = answer.match(/^\(?([A-D])\)?[.):]?$/i);
      if (letter) correctIndex = letter[1]!.toUpperCase().charCodeAt(0) - 65;
      else correctIndex = options.findIndex((o) => o.toLowerCase() === answer.toLowerCase());
    }
    if (correctIndex < 0 || correctIndex > 3) continue;

    const suspects = list(r["suspects"], 4);
    if (kind === "mystery" && suspects.length !== 4) continue;
    const clues = list(r["clues"], 5);
    if (kind === "mystery" && clues.length < 4) continue;

    const key = prompt
      .toLowerCase()
      // The ऀ-ॿ range is the explicit Devanagari block kept for Hindi
      // question text; the escapes make the range unambiguous (false positive).
      // eslint-disable-next-line no-misleading-character-class
      .replace(/[^a-z0-9\u0900-\u097F]+/g, " ")
      .trim()
      .slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      caseTitle:
        str(r["caseTitle"] ?? r["title"], 120) || (kind === "mystery" ? "Case file" : "Challenge"),
      story: str(r["story"] ?? r["scenario"], 1600),
      suspects,
      clues,
      timeline: list(r["timeline"], 6),
      prompt,
      options,
      correctIndex,
      explanation: str(r["explanation"], 900),
      solution: str(r["solution"] ?? r["explanation"], 1600),
      category: str(r["category"], 60) || (kind === "mystery" ? "Mystery" : "Reasoning"),
      difficulty: ["easy", "medium", "hard", "very hard"].includes(
        str(r["difficulty"], 20).toLowerCase(),
      )
        ? str(r["difficulty"], 20).toLowerCase()
        : kind === "god"
          ? "very hard"
          : "hard",
    });
  }
  return out;
}

/**
 * Verification pass: each generated item is fact/logic-checked by a second AI
 * call. Rejected items are dropped and the generation loop asks for
 * replacements; a wrong claimed index is corrected. A provider hiccup never
 * blocks a match — the batch is then kept as generated.
 */
async function verify(
  batch: TournamentItem[],
  ctx: { guestId: string; language: Language },
): Promise<TournamentItem[]> {
  if (!batch.length) return batch;
  const listing = batch
    .map(
      (q, i) =>
        `${i}. ${q.story ? `${q.story}\n` : ""}${q.prompt}\n` +
        q.options.map((o, oi) => `   ${oi}) ${o}`).join("\n") +
        `\n   claimed correct index: ${q.correctIndex}`,
    )
    .join("\n\n");

  const system =
    "You are a strict reasoning and fact checker. Return STRICT JSON only, no prose, no markdown. " +
    'Schema: {"checks":[{"index":0,"correctIndex":0,"verdict":"ok|fixed|reject","reason":"short"}]}';
  const user = [
    "Check each puzzle below. Decide:",
    '- "ok": exactly one option is correct and it is the claimed one, and the scenario contains enough information to reach it.',
    '- "fixed": the puzzle is solvable but the claimed index is wrong — return the truly correct index.',
    '- "reject": ambiguous, unsolvable, multiple correct options, contradicts itself, or factually wrong.',
    "Reject anything you are not confident about.",
    "",
    listing,
  ].join("\n");

  try {
    const available = await usableProviders(ctx.guestId);
    const decision = route({
      text: `${user} verification detail`,
      hasImages: false,
      preferredLanguage: ctx.language,
      dataSaver: false,
    });
    const candidates = [...selectChatProviders(available, decision), ...coreCandidates()];
    if (!candidates.length) return batch;
    const res = await runChat({
      candidates,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 2500,
    });
    type Check = { index?: number; correctIndex?: number; verdict?: string };
    const parsed = parseJsonLoose<{ checks?: Check[] } | Check[]>(res.text);
    const checks = Array.isArray(parsed) ? parsed : (parsed.checks ?? []);
    if (!checks.length) return batch;
    const byIndex = new Map<number, Check>();
    for (const c of checks) if (typeof c?.index === "number") byIndex.set(Math.floor(c.index), c);

    const kept: TournamentItem[] = [];
    batch.forEach((q, i) => {
      const check = byIndex.get(i);
      if (!check) return;
      if (String(check.verdict ?? "").toLowerCase() === "reject") return;
      const fixed =
        typeof check.correctIndex === "number" && check.correctIndex >= 0 && check.correctIndex <= 3
          ? Math.floor(check.correctIndex)
          : q.correctIndex;
      kept.push({ ...q, correctIndex: fixed });
    });
    return kept;
  } catch {
    return batch;
  }
}

/** Generate exactly `count` verified items for one attempt. */
export type TournamentPromptInput = {
  kind: TournamentKind;
  language: Language;
  avoid: string[];
  seed: number;
  count: number;
};

/** Items per request. Mystery cases are long, so its batches are smaller. */
export function tournamentBatchSize(kind: TournamentKind): number {
  return kind === "mystery" ? 2 : 4;
}

/**
 * Single source of truth for the tournament prompts — shared by the server
 * generation loop and by the on-device (browser AI) plan, so device-made cases
 * are asked for identically and validated by the same server rules.
 */
export function tournamentPromptParts(input: TournamentPromptInput) {
  const mystery = input.kind === "mystery";
  const pool = mystery ? MYSTERY_THEMES : GOD_THEMES;
  const themes = [...pool].sort(
    (a, b) => ((input.seed + a.length) % 89) - ((input.seed * 5 + b.length) % 89),
  );

  const schema = mystery
    ? '{"cases":[{"caseTitle":"...","story":"a self-contained mystery in 60-120 words",' +
      '"suspects":["A","B","C","D"],"clues":["c1","c2","c3","c4"],"timeline":["step 1","step 2"],' +
      '"question":"who/what/why question","options":["opt1","opt2","opt3","opt4"],"correctIndex":0,' +
      '"explanation":"why this answer is the only possible one","solution":"step-by-step reasoning from the clues",' +
      '"category":"mystery|psychology","difficulty":"hard"}]}'
    : '{"cases":[{"caseTitle":"...","story":"optional setup","question":"the hard reasoning question",' +
      '"options":["opt1","opt2","opt3","opt4"],"correctIndex":0,"explanation":"why it is correct",' +
      '"solution":"full step-by-step working","category":"logic|maths|psychology|lateral","difficulty":"very hard"}]}';

  const system = [
    mystery
      ? "You are the case writer of USTAD AI's Mystery + Psychology Tournament."
      : "You are the question master of USTAD AI's GOD MASTER Tournament, the hardest reasoning contest in the app.",
    "Return STRICT JSON only — no prose, no markdown fence, no commentary.",
    `Schema: ${schema}`,
  ].join(" ");

  const buildUser = (need: number, round: number, alreadyAsked: string[]): string => {
    const avoidList = [...input.avoid.slice(-30), ...alreadyAsked]
      .slice(-50)
      .map((q) => `- ${q.slice(0, 90)}`)
      .join("\n");
    return [
      mystery
        ? `Create ${need} completely different mystery / psychology cases.`
        : `Create ${need} extremely hard reasoning questions of varied types (logic, lateral thinking, maths, psychology, pattern, situational judgement).`,
      mystery
        ? "Every case must be solvable ONLY by reading the clues — no outside knowledge, no guessing."
        : "Every question must be solvable by pure reasoning with a single defensible answer; make them genuinely hard but fair.",
      mystery
        ? "Every case has EXACTLY 4 suspects and 4 or 5 clues, plus a short timeline where it helps."
        : "",
      "Every item has EXACTLY 4 options and EXACTLY ONE correct option.",
      'Include "correctIndex" (0-based) and a detailed "solution" that explains the reasoning step by step.',
      `Rotate across these themes so the set feels varied: ${themes.slice(0, 6).join(", ")}.`,
      languageRule(input.language),
      `Randomisation seed ${input.seed}-${round}: avoid your usual first ideas.`,
      avoidList ? `Do NOT reuse or paraphrase any of these:\n${avoidList}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  return { system, buildUser };
}

/** Prompts the browser AI pool must answer to build the set on the device. */
export function tournamentDevicePlan(input: TournamentPromptInput): {
  system: string;
  batches: Array<{ user: string; need: number }>;
} {
  const count = Math.max(1, Math.floor(input.count));
  const size = tournamentBatchSize(input.kind);
  const { system, buildUser } = tournamentPromptParts(input);
  const batches: Array<{ user: string; need: number }> = [];
  for (let done = 0, round = 0; done < count; done += size, round++) {
    batches.push({ user: buildUser(Math.min(size, count - done), round, []), need: Math.min(size, count - done) });
  }
  return { system, batches };
}

export async function generateTournamentSet(input: {
  kind: TournamentKind;
  guestId: string;
  language: Language;
  avoid: string[];
  seed: number;
  count: number;
  /**
   * Raw JSON batches generated by the player's on-device (browser AI) models,
   * validated and fact-checked here exactly like provider output.
   */
  deviceBatches?: string[] | undefined;
}): Promise<{ items: TournamentItem[]; provider: string; model: string }> {
  const count = Math.max(1, Math.floor(input.count));
  const { system, buildUser } = tournamentPromptParts({
    kind: input.kind,
    language: input.language,
    avoid: input.avoid,
    seed: input.seed,
    count,
  });

  const seen = new Set(
    input.avoid.map((a) =>
      a
        .toLowerCase()
        // Intentional Devanagari block range (see the identical key builder above).
        // eslint-disable-next-line no-misleading-character-class
        .replace(/[^a-z0-9\u0900-\u097F]+/g, " ")
        .trim()
        .slice(0, 120),
    ),
  );
  const collected: TournamentItem[] = [];
  let provider = "";
  let model = "";

  /* BROWSER AI FIRST — device batches, validated server-side. */
  for (const raw of input.deviceBatches ?? []) {
    if (collected.length >= count) break;
    let rows: Raw[] = [];
    try {
      const parsed = parseJsonLoose<{ cases?: Raw[]; questions?: Raw[] } | Raw[]>(raw);
      rows = Array.isArray(parsed) ? parsed : (parsed.cases ?? parsed.questions ?? []);
    } catch {
      rows = salvageJsonObjects(raw) as Raw[];
    }
    if (!rows.length) continue;
    const verified = await verify(clean(input.kind, rows, seen), {
      guestId: input.guestId,
      language: input.language,
    });
    if (verified.length) {
      collected.push(...verified);
      provider = "browser-ai";
      model = "on-device";
    }
  }

  /*
   * SMALL BATCHES: mystery cases and GOD MASTER puzzles are long, so asking for
   * the whole set in one response used to hit the provider's output limit and
   * arrive truncated. Each request now covers only a few items.
   */
  const BATCH = tournamentBatchSize(input.kind);
  const maxRounds = Math.ceil(count / BATCH) * 3 + 4;

  for (let round = 0; round < maxRounds && collected.length < count; round++) {
    const need = Math.min(BATCH, count - collected.length);
    const user = buildUser(
      need,
      round,
      collected.map((q) => q.prompt),
    );


    const available = await usableProviders(input.guestId);
    const decision = route({
      text: `${user} tournament generation detail`,
      hasImages: false,
      preferredLanguage: input.language,
      dataSaver: false,
    });
    const candidates = [...selectChatProviders(available, decision), ...coreCandidates()];
    if (!candidates.length)
      throw new Error(
        "No AI provider is configured. Add a provider in Settings → API Manager to play this tournament.",
      );

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const res = await runChat({ candidates, messages, maxTokens: 6000 });
    provider = res.provider;
    model = res.model;

    let rows: Raw[] = [];
    try {
      const parsed = parseJsonLoose<{ cases?: Raw[]; questions?: Raw[] } | Raw[]>(res.text);
      rows = Array.isArray(parsed) ? parsed : (parsed.cases ?? parsed.questions ?? []);
    } catch {
      // Truncated response: salvage the complete cases and re-request the rest.
      rows = salvageJsonObjects(res.text) as Raw[];
    }
    if (!rows.length) continue;

    const cleaned = clean(input.kind, rows, seen);
    const verified = await verify(cleaned, { guestId: input.guestId, language: input.language });
    collected.push(...verified);
  }

  if (collected.length < count) {
    throw new Error(
      `Could not prepare all ${count} items right now. Please try again in a moment.`,
    );
  }

  return { items: collected.slice(0, count), provider, model };
}
