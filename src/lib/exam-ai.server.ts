/**
 * Examination AI layer — question generation and written-answer evaluation.
 * Reuses the existing USTAD AI Router, API Manager credentials, provider
 * fallback chain and USTAD Core; it never talks to a provider directly.
 */
import { usableProviders, coreCandidates } from "./api-manager.server";
import { selectChatProviders, runChat, route, type Language } from "./router.server";
import { mathIssues, matchesLanguage } from "./math-notation";
import type { ChatMessage } from "./provider-clients.server";
import {
  DIFFICULTY_MIX,
  TYPE_SPECS,
  round2,
  type ExamQuestion,
  type QuestionType,
} from "./exam-spec";

/**
 * Ask the router for an exam-grade completion.
 * `power` routes through the complex/reasoning ordering (generation, evaluation);
 * the returned text is raw model output, parsed by the caller.
 */
async function ask(guestId: string, system: string, user: string, maxTokens: number, power = true) {
  const available = await usableProviders(guestId);
  const decision = route({
    // "exam" intent + explicit detail keyword => complex ordering (reasoning-first providers)
    text: power ? `${user} step by step detail exam` : user,
    hasImages: false,
    preferredLanguage: "english",
    dataSaver: false,
  });
  const candidates = [...selectChatProviders(available, decision), ...coreCandidates()];
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return runChat({ candidates, messages, maxTokens });
}

export function parseJsonLoose<T>(raw: string): T {
  const fenced = raw.replace(/```json/gi, "```").split("```");
  const candidate = fenced.find((c) => c.trim().startsWith("{") || c.trim().startsWith("[")) ?? raw;
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (start < 0 || end <= start) throw new Error("The AI response was not valid JSON.");
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    // Repair the most common model slip: a trailing comma before a closing brace.
    return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")) as T;
  }
}

/**
 * Salvage every COMPLETE top-level JSON object from a possibly TRUNCATED AI
 * response (a response cut off mid-array leaves valid objects before the cut).
 *
 * Used only as a fallback after `parseJsonLoose` fails: it never fabricates a
 * record, it only keeps objects whose braces/strings actually closed. The
 * caller still validates every salvaged row against its own schema.
 */
export function salvageJsonObjects(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const value = JSON.parse(raw.slice(start, i + 1)) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value))
            out.push(value as Record<string, unknown>);
        } catch {
          /* not a usable object — skip it */
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  // A wrapper object like {"questions":[...]} also matches; unwrap its array.
  const flattened: Record<string, unknown>[] = [];
  for (const obj of out) {
    const arrays = Object.values(obj).filter(Array.isArray) as unknown[][];
    if (arrays.length === 1 && !("question" in obj) && !("prompt" in obj)) {
      for (const item of arrays[0]!)
        if (item && typeof item === "object" && !Array.isArray(item))
          flattened.push(item as Record<string, unknown>);
    } else flattened.push(obj);
  }
  return flattened;
}


function norm(text: string): string {
  // Devanagari block kept intentionally so Hindi/Devanagari questions compare alike.
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F]+/g, " ") // eslint-disable-line no-misleading-character-class
    .trim();
}

function languageRule(language: Language): string {
  if (language === "hindi")
    return "Write every question and option in Hindi (Devanagari). Keep standard technical terms in English where a school textbook would.";
  if (language === "hinglish")
    return "Write every question in Hinglish (Roman-script Hindi mixed with English), the way an Indian teacher speaks in class.";
  return "Write every question in clear English.";
}

/**
 * The class is a HARD academic boundary and difficulty only controls complexity
 * inside that boundary — this prompt block is what enforces rule 49.
 */
function scopeRule(
  klass: string,
  subject: string,
  board: string | null,
  difficulty: string,
): string {
  const mix = DIFFICULTY_MIX[difficulty] ?? DIFFICULTY_MIX["medium"]!;
  return [
    `Subject: ${subject}. Class: ${klass}.${board ? ` Board/curriculum: ${board}.` : ""}`,
    `ABSOLUTE SCOPE RULE: every question must be answerable from the Class ${klass} ${subject} syllabus only.`,
    `Never use a topic from a higher or lower class. Difficulty changes only how demanding the question is, never the syllabus level.`,
    `Difficulty setting: ${difficulty}. Approximate mix inside the Class ${klass} syllabus: ${mix.easy}% easy, ${mix.medium}% medium, ${mix.hard}% hard.`,
    `Tag each question with "level": "easy" | "medium" | "hard".`,
    "Questions must be factually correct, unambiguous, non-repetitive and academically meaningful.",
  ].join("\n");
}

type RawQ = {
  question?: string;
  options?: string[];
  answer?: string;
  marks?: number;
  concepts?: string[];
  explanation?: string;
  level?: string;
};

function cleanBatch(raw: RawQ[], type: QuestionType): ExamQuestion[] {
  const out: ExamQuestion[] = [];
  for (const q of raw ?? []) {
    const question = String(q.question ?? "").trim();
    if (question.length < 6) continue;
    const level = (["easy", "medium", "hard"] as const).includes(q.level as never)
      ? (q.level as "easy" | "medium" | "hard")
      : "medium";

    if (type === "mcq") {
      const options = (q.options ?? []).map((o) => String(o).trim()).filter(Boolean);
      if (options.length !== 4) continue;
      let answer = String(q.answer ?? "").trim();
      // Accept "B" / "B)" style keys as well as the full option text.
      const letter = answer.match(/^\(?([A-D])\)?[.):]?$/i);
      if (letter) answer = options[letter[1]!.toUpperCase().charCodeAt(0) - 65] ?? "";
      const match = options.find((o) => norm(o) === norm(answer));
      if (!match) continue;
      out.push({
        id: "",
        type,
        question,
        options,
        answer: match,
        marks: 2,
        level,
        ...(q.explanation ? { explanation: String(q.explanation).slice(0, 500) } : {}),
      });
      continue;
    }

    if (type === "truefalse") {
      const a = String(q.answer ?? "")
        .trim()
        .toLowerCase();
      const answer = /^(true|sahi|yes|t)$/.test(a)
        ? "True"
        : /^(false|galat|no|f)$/.test(a)
          ? "False"
          : "";
      if (!answer) continue;
      out.push({
        id: "",
        type,
        question,
        options: ["True", "False"],
        answer,
        marks: 1.5,
        level,
        ...(q.explanation ? { explanation: String(q.explanation).slice(0, 500) } : {}),
      });
      continue;
    }

    const marks = Number(q.marks);
    const answer = String(q.answer ?? "").trim();
    if (!answer) continue;
    out.push({
      id: "",
      type,
      question,
      answer,
      marks: Number.isFinite(marks) && marks > 0 ? Math.min(20, round2(marks)) : 4,
      level,
      concepts: (q.concepts ?? []).map((c) => String(c).slice(0, 160)).slice(0, 8),
    });
  }
  return out;
}

/** Force written marks to total exactly 100 while keeping harder questions heavier. */
function rebalanceWritten(questions: ExamQuestion[], target: number): ExamQuestion[] {
  const weights = questions.map((q) => Math.max(1, q.marks));
  const sum = weights.reduce((a, b) => a + b, 0);
  // Scale to the target, snapped to half marks so the paper stays printable.
  const marks = weights.map((w) => Math.max(1, Math.round((w / sum) * target * 2) / 2));
  let diff = round2(target - marks.reduce((a, b) => a + b, 0));
  // Distribute the remainder on the heaviest questions first, in 0.5 steps.
  const order = marks
    .map((m, i) => [m, i] as const)
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i);
  let guard = 0;
  while (Math.abs(diff) >= 0.5 && guard < 2000) {
    for (const i of order) {
      if (Math.abs(diff) < 0.5) break;
      const step = diff > 0 ? 0.5 : -0.5;
      if (marks[i]! + step < 1) continue;
      marks[i] = round2(marks[i]! + step);
      diff = round2(diff - step);
    }
    guard++;
  }
  // Safety net: if rounding could not fully absorb the remainder (e.g. every
  // question sat on its 1-mark floor), fold it into the heaviest question so the
  // paper always totals exactly `target`.
  if (Math.abs(diff) >= 0.5) {
    const idx = marks.reduce((bi, m, i) => (m > marks[bi]! ? i : bi), 0);
    while (Math.abs(diff) >= 0.5) {
      const step = diff > 0 ? 0.5 : -0.5;
      const next = round2(marks[idx]! + step);
      if (next < 1) break;
      marks[idx] = next;
      diff = round2(diff - step);
    }
  }
  return questions.map((q, i) => ({ ...q, marks: marks[i]! }));
}

export type GenerationReport = {
  questions: ExamQuestion[];
  provider: string;
  model: string;
  batches: number;
  discarded: number;
};

/**
 * Generate a validated paper of the exact required shape.
 * Generation runs in batches because a 50/75-question paper does not fit in one
 * reliable JSON response; duplicates are removed and short batches are topped up.
 */
export async function generatePaper(input: {
  guestId: string;
  subject: string;
  klass: string;
  board: string | null;
  language: Language;
  difficulty: string;
  questionType: QuestionType;
}): Promise<GenerationReport> {
  const spec = TYPE_SPECS[input.questionType];
  const batchSize = input.questionType === "written" ? 9 : 25;

  const schema =
    input.questionType === "mcq"
      ? '{"questions":[{"question":"...","options":["opt A","opt B","opt C","opt D"],"answer":"exact text of the correct option","level":"easy|medium|hard","explanation":"one line"}]}'
      : input.questionType === "truefalse"
        ? '{"questions":[{"question":"a statement that is clearly true or false","answer":"True|False","level":"easy|medium|hard","explanation":"one line"}]}'
        : '{"questions":[{"question":"...","marks":6,"answer":"model answer","concepts":["key concept 1","key concept 2"],"level":"easy|medium|hard"}]}';

  const system = [
    "You are USTAD AI's examination paper generator for Indian school examinations.",
    "Return STRICT JSON only — no prose, no markdown fence, no commentary.",
    `Schema: ${schema}`,
  ].join(" ");

  const collected: ExamQuestion[] = [];
  const seen = new Set<string>();
  let provider = "";
  let model = "";
  let batches = 0;
  let discarded = 0;
  /** Concrete complaints fed back to the model instead of a silent retry. */
  let corrections: string[] = [];

  for (let round = 0; round < 8 && collected.length < spec.count; round++) {
    const need = Math.min(batchSize, spec.count - collected.length);
    const avoid = collected.slice(-30).map((q) => q.question.slice(0, 90));
    const user = [
      `Generate exactly ${need} ${spec.label} questions.`,
      scopeRule(input.klass, input.subject, input.board, input.difficulty),
      languageRule(input.language),
      input.questionType === "written"
        ? "Assign each question a marks value between 2 and 10 based on its depth: short definitions get fewer marks, long explanations get more. Also list the key concepts a correct answer must contain."
        : input.questionType === "mcq"
          ? "Exactly 4 options per question and exactly one correct option."
          : "Each statement must be definitively true or false — never opinion based.",
      avoid.length
        ? `Do NOT repeat or rephrase any of these already-generated questions:\n- ${avoid.join("\n- ")}`
        : "",
      corrections.length
        ? `The previous batch was REJECTED. Fix these problems and do not repeat them:\n- ${corrections.slice(0, 6).join("\n- ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await ask(
      input.guestId,
      system,
      user,
      input.questionType === "written" ? 4000 : 5000,
    );
    batches++;
    provider ||= result.provider;
    model ||= result.model;

    let batch: ExamQuestion[] = [];
    try {
      batch = cleanBatch(
        parseJsonLoose<{ questions: RawQ[] }>(result.text).questions,
        input.questionType,
      );
    } catch {
      continue; // malformed batch: retry, never fabricate questions
    }

    corrections = [];
    for (const q of batch) {
      const key = norm(q.question).slice(0, 120);
      if (!key || seen.has(key)) {
        discarded++;
        continue;
      }
      // A question whose math is structurally broken (empty fraction, unbalanced
      // bracket, dangling operator) is never shipped to a student — it is
      // rejected and regenerated with the reason handed back to the model.
      const parts = [q.question, ...(q.options ?? []), q.answer ?? ""].filter(Boolean);
      const badMath = parts.flatMap((t) => mathIssues(t)).slice(0, 2);
      if (badMath.length) {
        discarded++;
        corrections.push(`"${q.question.slice(0, 70)}" — broken math: ${badMath.join("; ")}`);
        continue;
      }
      // Nor one that drifted into the wrong script mid-paper.
      if (!matchesLanguage(parts.join(" "), input.language)) {
        discarded++;
        corrections.push(
          `"${q.question.slice(0, 70)}" — wrong language: the whole paper must be in ${input.language}.`,
        );
        continue;
      }
      seen.add(key);
      collected.push(q);
      if (collected.length >= spec.count) break;
    }
  }

  if (collected.length < spec.count) {
    throw new Error(
      `Paper generation incomplete for ${input.subject}: got ${collected.length} of ${spec.count} valid questions. No placeholder questions were added.`,
    );
  }

  let questions = collected.slice(0, spec.count).map((q, i) => ({ ...q, id: `q${i + 1}` }));
  if (input.questionType === "written") questions = rebalanceWritten(questions, spec.totalMarks);

  validatePaper(questions, input.questionType);
  return { questions, provider, model, batches, discarded };
}

/** Publish-time gate: a paper that fails any rule is never stored as ready. */
export function validatePaper(questions: ExamQuestion[], type: QuestionType) {
  const spec = TYPE_SPECS[type];
  if (questions.length !== spec.count) {
    throw new Error(
      `Validation failed: ${questions.length} questions, expected exactly ${spec.count}.`,
    );
  }
  const total = round2(questions.reduce((sum, q) => sum + q.marks, 0));
  if (total !== spec.totalMarks) {
    throw new Error(
      `Validation failed: total marks ${total}, expected exactly ${spec.totalMarks}.`,
    );
  }
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) throw new Error("Validation failed: duplicate question id.");
    ids.add(q.id);
    if (q.type !== type) throw new Error("Validation failed: mixed question types.");
    if (!q.answer) throw new Error(`Validation failed: ${q.id} has no answer key.`);
    if (type === "mcq") {
      if ((q.options ?? []).length !== 4)
        throw new Error(`Validation failed: ${q.id} does not have 4 options.`);
      if (!q.options!.includes(q.answer))
        throw new Error(`Validation failed: ${q.id} answer key is not one of its options.`);
      if (q.marks !== 2) throw new Error(`Validation failed: ${q.id} is not worth 2 marks.`);
    }
    if (type === "truefalse" && q.marks !== 1.5) {
      throw new Error(`Validation failed: ${q.id} is not worth 1.5 marks.`);
    }
    if (type === "written" && q.marks <= 0)
      throw new Error(`Validation failed: ${q.id} has no maximum marks.`);
  }
}

export type WrittenGrade = {
  id: string;
  awarded: number;
  reason: string;
  missing: string[];
};

/**
 * Rubric-based evaluation of written answers. Marks come from the model's
 * structured judgement against the stored concepts — never from string equality
 * and never invented when the model fails (the caller marks it pending instead).
 */
export async function evaluateWritten(input: {
  guestId: string;
  klass: string;
  subject: string;
  items: Array<{
    id: string;
    question: string;
    marks: number;
    expected: string;
    concepts: string[];
    answer: string;
  }>;
}): Promise<WrittenGrade[]> {
  const grades: WrittenGrade[] = [];
  const system = [
    "You are a strict but fair school examiner evaluating written answers.",
    "Award marks ONLY for concepts the student actually wrote. Partial marks are expected.",
    "A blank or irrelevant answer scores 0. Never exceed the maximum marks.",
    'Return STRICT JSON only: {"grades":[{"id":"q1","awarded":5.5,"reason":"why these marks","missing":["concept not written"]}]}',
  ].join(" ");

  for (let i = 0; i < input.items.length; i += 5) {
    const chunk = input.items.slice(i, i + 5);
    const user = [
      `Class ${input.klass} ${input.subject} written paper. Evaluate each answer against its rubric.`,
      ...chunk.map((it) =>
        [
          `--- ${it.id} (maximum ${it.marks} marks)`,
          `Question: ${it.question}`,
          `Expected model answer: ${it.expected}`,
          it.concepts.length ? `Required concepts: ${it.concepts.join("; ")}` : "",
          `Student answer: ${it.answer.trim() || "(left blank)"}`,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ].join("\n\n");

    let parsed: {
      grades?: Array<{ id?: string; awarded?: number; reason?: string; missing?: string[] }>;
    } | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const res = await ask(input.guestId, system, user, 2500);
        parsed = parseJsonLoose(res.text);
      } catch {
        parsed = null;
      }
    }
    if (!parsed)
      throw new Error("Written evaluation could not be completed by any configured model.");

    for (const it of chunk) {
      const g = parsed.grades?.find((x) => String(x.id) === it.id);
      if (!g || !Number.isFinite(Number(g.awarded))) {
        throw new Error(`Written evaluation returned no marks for ${it.id}.`);
      }
      grades.push({
        id: it.id,
        awarded: Math.max(0, Math.min(it.marks, round2(Number(g.awarded)))),
        reason: String(g.reason ?? "").slice(0, 600),
        missing: (g.missing ?? []).map((m) => String(m).slice(0, 160)).slice(0, 6),
      });
    }
  }
  return grades;
}
