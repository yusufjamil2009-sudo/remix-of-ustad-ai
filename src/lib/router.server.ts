/**
 * USTAD AI Router — intent detection, task classification, complexity,
 * response-length intelligence, language engine, provider/model selection,
 * fallback chain and retries.
 */
import {
  chatWithProvider,
  publicWebSearch,
  webSearch,
  readUrl,
  type ChatMessage,
} from "./provider-clients.server";
import { getProvider } from "./providers";
import { firstModelWith, providerCanSatisfy } from "./model-capabilities";
import { parseCurriculumRequest } from "./curriculum/request";
import { currentSession } from "./curriculum/session";
import type { CurriculumContext } from "./curriculum/types";

/** Framing info we push from the Curriculum Brain into the teaching pipeline. */
export type CurriculumRequestInfo = {
  board: string | null;
  boardName: string | null;
  klass: number | null;
  subject: string | null;
  subjectId: string | null;
  academicSession: string | null;
  chapterNumber: number | null;
  chapterName: string | null;
};

/**
 * Deterministic curriculum framing for a request (no network) so the router can
 * ground a lesson/teaching answer in the detected board/class/subject/session.
 * Returns null when the request carries no curriculum signal.
 */
export function detectCurriculumRequest(text: string): CurriculumRequestInfo | null {
  const parsed = parseCurriculumRequest(text, {});
  const hasSignal = Boolean(parsed.board || parsed.klass || parsed.subjectId);
  if (!hasSignal) return null;
  const session = parsed.board ? currentSession(parsed.board) : null;
  return {
    board: parsed.board,
    boardName: parsed.boardName,
    klass: parsed.klass,
    subject: parsed.subject,
    subjectId: parsed.subjectId,
    academicSession: session?.label ?? null,
    chapterNumber: parsed.chapterNumber,
    chapterName: parsed.chapterName,
  };
}

/** Compact prompt line for verified curriculum context (or the unverified note). */
export function curriculumContextLine(ctx: CurriculumContext): string {
  if (ctx.verificationStatus === "VERIFIED") {
    const parts = [
      `Verified curriculum: ${ctx.boardName} ${ctx.klass} · ${ctx.subject} · Session ${ctx.academicSession}.`,
    ];
    if (ctx.book) parts.push(`Book: ${ctx.book}.`);
    if (ctx.chapter) parts.push(`Chapter: ${ctx.chapter}.`);
    return `${parts.join(" ")} Teach strictly within this verified syllabus.`;
  }
  if (ctx.academicSession) {
    return `Curriculum source not yet verified for ${ctx.boardName ?? "this board"} ${ctx.klass ?? ""}. Do not present unconfirmed chapter lists as official.`;
  }
  return "";
}

export type Intent =
  | "chat"
  | "question"
  | "explain"
  | "code"
  | "math"
  | "translate"
  | "summarize"
  | "web"
  | "image-understanding"
  | "image-generation"
  | "ocr"
  | "exam"
  | "lesson"
  | "note"
  | "reminder";

export type Complexity = "simple" | "medium" | "complex";
export type Language = "hindi" | "hinglish" | "english";

export type RouteDecision = {
  intent: Intent;
  complexity: Complexity;
  language: Language;
  maxTokens: number;
  /**
   * Whether the TASK itself would benefit from live web data (latest news, a
   * URL the user pasted, etc.). This is NOT the user's permission — it is
   * gated by `webSearchEnabled` below before any web tool is called.
   */
  needsWeb: boolean;
  /**
   * The user's explicit web-search setting (Section 11). When false the router
   * MUST NOT call any web-search/url-reading tool, regardless of intent.
   */
  webSearchEnabled: boolean;
  needsVision: boolean;
  urls: string[];
};

const DEVANAGARI = /[\u0900-\u097F]/;
const HINGLISH_HINTS =
  /\b(kya|kaise|kyun|kyu|hai|hain|nahi|nahin|mujhe|mera|meri|tum|aap|karo|karna|batao|samjhao|thoda|acha|theek|kab|kahan|kitna|banao|chahiye)\b/i;

export function detectLanguage(text: string, preferred: Language): Language {
  const t = text.trim();
  if (!t) return preferred;
  if (/\b(in english|answer in english|english me?in)\b/i.test(t)) return "english";
  if (/\b(hindi me|hindi mein|answer in hindi)\b/i.test(t)) return "hindi";
  if (/\b(hinglish)\b/i.test(t)) return "hinglish";
  if (DEVANAGARI.test(t)) return "hindi";
  if (HINGLISH_HINTS.test(t)) return "hinglish";
  return preferred;
}

export function detectIntent(text: string, hasImages: boolean): Intent {
  const t = text.toLowerCase();
  if (hasImages) return "image-understanding";
  if (/\b(exam|test|quiz|mcq|paper)\b/.test(t)) return "exam";
  if (/\b(lesson|chapter|syllabus|teach me|padhao)\b/.test(t)) return "lesson";
  if (/\b(remind|reminder|yaad dila|schedule)\b/.test(t)) return "reminder";
  if (/\b(note|notes|save this)\b/.test(t)) return "note";
  if (/\b(translate|anuvad|translation)\b/.test(t)) return "translate";
  if (/\b(summar|tl;dr|short me|sankshep)\b/.test(t)) return "summarize";
  if (/```|\b(code|program|function|bug|error|python|javascript|java|c\+\+|sql|html|css)\b/.test(t))
    return "code";
  if (
    /\b(solve|integral|derivative|equation|calculate|sum of|percentage)\b/.test(t) ||
    /[0-9]\s*[+\-*/^]\s*[0-9]/.test(t)
  )
    return "math";
  if (
    /\b(latest|today|news|current|price|who won|live|2025|2026)\b/.test(t) ||
    /https?:\/\//.test(text)
  )
    return "web";
  if (/\b(explain|samjhao|why|how does|what is|kaise|kyun)\b/.test(t)) return "explain";
  if (/\?$/.test(t.trim())) return "question";
  return "chat";
}

export function detectComplexity(text: string, intent: Intent): Complexity {
  const words = text.trim().split(/\s+/).length;
  if (intent === "chat" && words < 12) return "simple";
  if (
    words > 120 ||
    /\b(compare|derive|prove|architecture|research|step by step|detail|full)\b/i.test(text)
  )
    return "complex";
  if (intent === "code" || intent === "math" || intent === "lesson" || intent === "exam")
    return "complex";
  if (words < 15) return "simple";
  return "medium";
}

/**
 * Per-request output budget. These are real generation ceilings, not a cosmetic
 * cap: when a provider still hits them, runChat auto-continues the same answer,
 * so long educational responses complete instead of stopping mid-sentence.
 */
export function responseBudget(complexity: Complexity, intent: Intent, dataSaver: boolean): number {
  let base = complexity === "simple" ? 800 : complexity === "medium" ? 2400 : 6000;
  if (intent === "lesson" || intent === "exam") base = 8000;
  if (dataSaver) base = Math.round(base * 0.6);
  return base;
}

export function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s)]+/g) ?? []).slice(0, 3);
}

/**
 * Build a clean web-search query from the user's intent only.
 * Never injects app/product/developer branding or internal instructions.
 */
const QUERY_STOP =
  /\b(ustad|ustaad|ai|complete|course|master|prompt|project|yusuf ali|please|pls|plz|kya|hai|hain|mujhe|batao|bata|do|de|dijiye|karo|kar|ka|ki|ke|ko|me|mein|se|par|aur|zara|thoda|bhai|sir|kripya|tell|me|the|a|an|of|for|about|can|you|could|would|give|show|find|search|dhoondo|dhundo|dhundho|khojo)\b/gi;

export function buildSearchQuery(text: string): string {
  const base = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*`>_~|]/g, " ")
    .replace(/\?+/g, " ")
    .trim();

  let q = base
    .replace(QUERY_STOP, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const t = base.toLowerCase();
  const hints: string[] = [];
  if (/\b(news|khabar|khabre|samachar)\b/.test(t)) hints.push("latest news");
  if (/\b(today|aaj|abhi|latest|taza|taaza|current)\b/.test(t)) hints.push("today");
  for (const hint of hints) if (!q.toLowerCase().includes(hint)) q = `${q} ${hint}`.trim();

  const words = q.split(/\s+/).filter(Boolean).slice(0, 12);
  const result = words.join(" ").trim();
  return result.length >= 3 ? result : base.slice(0, 120);
}

export function route(opts: {
  text: string;
  hasImages: boolean;
  preferredLanguage: Language;
  dataSaver: boolean;
  /**
   * The user's explicit web_search preference. Defaults to true so that
   * existing callers that don't pass it keep current behaviour; the chat
   * pipeline always passes the persisted setting.
   */
  webSearchEnabled?: boolean;
}): RouteDecision {
  const intent = detectIntent(opts.text, opts.hasImages);
  const complexity = detectComplexity(opts.text, intent);
  const language = detectLanguage(opts.text, opts.preferredLanguage);
  const urls = extractUrls(opts.text);
  const webSearchEnabled = opts.webSearchEnabled !== false;
  const wantsWeb = intent === "web" || urls.length > 0;
  return {
    intent,
    complexity,
    language,
    maxTokens: responseBudget(complexity, intent, opts.dataSaver),
    // The task wants web AND the user has allowed it. If the setting is off
    // the router must not call any web tool (Section 11).
    needsWeb: webSearchEnabled && wantsWeb,
    webSearchEnabled,
    needsVision: opts.hasImages,
    urls: webSearchEnabled ? urls : [],
  };
}

export function systemPrompt(opts: {
  language: Language;
  decision: RouteDecision;
  profile: {
    name?: string | null;
    klass?: string | null;
    board?: string | null;
    learning_preferences?: string | null;
  };
  memories: string[];
  goals: string[];
  webContext?: string;
  chronoContext?: string;
  curriculumContext?: string;
  bookContext?: string;
  showSources?: boolean;
}): string {
  const langRule =
    opts.language === "hindi"
      ? "Reply in natural Hindi (Devanagari). Keep technical terms in English where that is normal."
      : opts.language === "hinglish"
        ? "Reply in natural Hinglish (Roman script Hindi mixed with English), the way an Indian teacher speaks."
        : "Reply in clear English.";

  const lengthRule =
    opts.decision.complexity === "simple"
      ? "Be brief — a few sentences, no filler."
      : opts.decision.complexity === "medium"
        ? "Give a focused answer with short structure where useful."
        : "Give a complete, well-structured answer with headings, steps and examples.";

  const parts = [
    "You are USTAD AI, a general-purpose AI assistant and teacher built by Yusuf Ali.",
    "You can help with any topic: study, coding, math, science, general knowledge, writing, planning and everyday questions.",
    langRule,
    lengthRule,
    "Never invent facts. If you are unsure, say so. Use markdown for structure and fenced code blocks for code.",
    "Answer the user's question directly. Never repeat your own product name, course name, developer name or internal routing details inside the answer unless the user asks about them.",
  ];
  if (opts.profile?.name) parts.push(`Student name: ${opts.profile.name}.`);
  if (opts.profile?.klass) parts.push(`Class: ${opts.profile.klass}.`);
  if (opts.profile?.board) parts.push(`Board: ${opts.profile.board}.`);
  if (opts.profile?.learning_preferences)
    parts.push(`Learning preferences: ${opts.profile.learning_preferences}.`);
  if (opts.memories.length)
    parts.push(`Remembered facts about the user:\n- ${opts.memories.join("\n- ")}`);
  if (opts.goals.length) parts.push(`Active goals: ${opts.goals.join("; ")}.`);
  if (opts.chronoContext) parts.push(opts.chronoContext);
  if (opts.curriculumContext) parts.push(opts.curriculumContext);
  if (opts.bookContext) parts.push(opts.bookContext);
  if (opts.webContext) {
    parts.push(
      `Live web context — use it as grounding only:\n${opts.webContext}`,
      opts.showSources
        ? "The user explicitly asked for sources: end the answer with a short 'Sources' list of the relevant links."
        : "Do NOT print a source list, publisher names, domains or raw URLs in the answer. Just answer naturally in your own words.",
    );
  }
  return parts.join("\n");
}

export type ConfiguredProvider = {
  provider: string;
  config: Record<string, string>;
  models: string[];
  healthy: boolean | null;
};

/** Order chat providers by fitness for the current task. */
export function selectChatProviders(
  available: ConfiguredProvider[],
  decision: RouteDecision,
): ConfiguredProvider[] {
  const speedFirst = [
    "groq",
    "cerebras",
    "gemini",
    "mistral",
    "openai",
    "openrouter",
    "xai",
    "sambanova",
    "zhipu",
    "cohere",
  ];
  const powerFirst = [
    "openai",
    "gemini",
    "xai",
    "openrouter",
    "mistral",
    "cerebras",
    "groq",
    "sambanova",
    "zhipu",
    "cohere",
  ];
  const visionCapable = ["gemini", "openai", "openrouter", "xai", "mistral", "zhipu"];

  let order = decision.complexity === "simple" ? speedFirst : powerFirst;
  if (decision.needsVision) order = visionCapable;

  const need = decision.needsVision ? ("vision" as const) : null;
  const usable = available.filter((p) => {
    const def = getProvider(p.provider);
    if (!def?.chat) return false;
    if (need) {
      // Model-level capability is authoritative. An empty live model list is
      // UNKNOWN — never assume provider.capabilities means this model can see.
      if (!providerCanSatisfy(p.provider, p.models, need)) return false;
    }
    return true;
  });

  return usable.sort((a, b) => {
    const health = Number(b.healthy === true) - Number(a.healthy === true);
    if (health !== 0) return health;
    const ai = order.indexOf(a.provider);
    const bi = order.indexOf(b.provider);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

export type RunResult = {
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; ok: boolean; error?: string }>;
  /** True only when the provider itself reported hitting its output limit and continuation could not finish it. */
  truncated: boolean;
  continuations: number;
};

/** Hard ceiling on auto-continuation rounds, so a rambling model can never loop forever. */
const MAX_CONTINUATIONS = 4;

/**
 * Append a continuation chunk with correct whitespace (Bug 12).
 *  - strips overlap the model repeated (word-boundary aware)
 *  - inserts a single space only when both sides need one, and not
 *    before/after joining punctuation (so "laws" + "." stays "laws.",
 *    and "are" + "important" joins to "are important").
 */
function appendWithoutOverlap(base: string, next: string): string {
  if (!next) return base;
  if (!base) return next;

  const tail = base.slice(-600);
  const max = Math.min(tail.length, next.length);
  let overlap = 0;
  for (let len = max; len >= 3; len--) {
    const candidate = next.slice(0, len);
    if (tail.endsWith(candidate)) {
      const prevChar = tail[tail.length - len - 1] ?? " ";
      const atBoundary =
        len === next.length ||
        /[\s.,;:!?)]}"']/.test(next[len] ?? " ") ||
        /[\s({["']/.test(prevChar);
      if (atBoundary) {
        overlap = len;
        break;
      }
    }
  }
  const rest = next.slice(overlap);
  if (!rest) return base;
  if (/[\s]$/.test(base) || /^[\s]/.test(rest)) return base + rest;
  if (/^[.,;:!?)]}"'’”]/.test(rest)) return base + rest;
  if (/[([{"'‘“]$/.test(base)) return base + rest;
  return `${base} ${rest}`;
}

/**
 * Try providers/models in order, with one retry per provider on transient errors.
 * When a provider reports finish_reason = length the answer is genuinely truncated,
 * so we continue the SAME answer using the existing conversation context and append
 * the continuation instead of silently returning a half sentence.
 */
export async function runChat(opts: {
  candidates: ConfiguredProvider[];
  messages: ChatMessage[];
  maxTokens: number;
}): Promise<RunResult> {
  const attempts: RunResult["attempts"] = [];
  const wantsVision = opts.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => (p as { type?: string }).type === "image_url"),
  );
  for (const cand of opts.candidates) {
    const chosen = firstModelWith(cand.provider, cand.models, wantsVision ? "vision" : null);
    if (wantsVision && !chosen) {
      attempts.push({
        provider: cand.provider,
        ok: false,
        error: "No verified vision-capable model on this provider",
      });
      continue;
    }
    const models = chosen ? [chosen] : cand.models.length ? [cand.models[0]!] : [undefined];
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const first = await chatWithProvider({
            provider: cand.provider,
            config: cand.config,
            ...(model ? { model } : {}),
            messages: opts.messages,
            maxTokens: opts.maxTokens,
          });
          if (!first.text.trim()) throw new Error("Empty response from provider");

          let text = first.text;
          let finish = first.finishReason;
          let continuations = 0;

          while (finish === "length" && continuations < MAX_CONTINUATIONS) {
            continuations++;
            const cont = await chatWithProvider({
              provider: cand.provider,
              config: cand.config,
              ...(model ? { model } : {}),
              liveModels: cand.models,
              messages: [
                ...opts.messages,
                { role: "assistant", content: text },
                {
                  role: "user",
                  content:
                    "Continue exactly where you stopped. Do not repeat anything you already wrote, do not restart, do not add any preamble — just continue the same answer.",
                },
              ],
              maxTokens: opts.maxTokens,
            });
            if (!cont.text.trim()) break;
            text = appendWithoutOverlap(text, cont.text);
            finish = cont.finishReason;
          }

          attempts.push({ provider: cand.provider, ok: true });
          return {
            text,
            provider: first.provider,
            model: first.model,
            attempts,
            truncated: finish === "length",
            continuations,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          const transient = /429|5\d\d|timeout|network/i.test(msg);
          if (attempt === 0 && transient) {
            await new Promise((r) => setTimeout(r, 700));
            continue;
          }
          attempts.push({ provider: cand.provider, ok: false, error: msg });
          break;
        }
      }
    }
  }
  throw new Error(
    `All AI providers failed. ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`,
  );
}

/** Search providers in fallback order; readers double as searchers last. */
const SEARCH_CHAIN = ["tavily", "exa", "jina", "firecrawl"] as const;
const READ_CHAIN = ["jina", "firecrawl"] as const;

const chain = (available: ConfiguredProvider[], order: readonly string[]) =>
  order
    .map((name) => available.find((p) => p.provider === name))
    .filter(Boolean) as ConfiguredProvider[];

/**
 * Gather live web context.
 *
 * Every configured provider is tried in order; a provider is only skipped
 * after it actually fails, and if the whole chain fails the reason is
 * reported back instead of silently answering without the web.
 */
export async function gatherWeb(
  available: ConfiguredProvider[],
  decision: RouteDecision,
  query: string,
): Promise<{ context: string; sources: Array<{ title: string; url: string }>; webError?: string }> {
  const sources: Array<{ title: string; url: string }> = [];
  const failures: string[] = [];
  let context = "";

  const readers = chain(available, READ_CHAIN);
  for (const url of decision.urls) {
    if (!readers.length) {
      failures.push("No page reader (Jina or Firecrawl) is configured.");
      break;
    }
    let read = false;
    for (const reader of readers) {
      try {
        const text = await readUrl(reader.provider, reader.config, url);
        context += `\nSource ${url}:\n${text.slice(0, 4000)}\n`;
        sources.push({ title: url, url });
        read = true;
        break;
      } catch (e) {
        failures.push(`${reader.provider} could not read ${url}: ${(e as Error).message}`);
      }
    }
    if (!read) failures.push(`Could not read ${url} with any configured reader.`);
  }

  if (decision.intent === "web" && decision.urls.length === 0) {
    const searchers = chain(available, SEARCH_CHAIN);
    const cleaned = buildSearchQuery(query);
    let searched = false;
    for (const searcher of searchers) {
      try {
        const results = await webSearch(searcher.provider, searcher.config, cleaned);
        if (!results.length) {
          failures.push(`${searcher.provider} returned no results.`);
          continue;
        }
        for (const r of results) {
          context += `\n[${r.title}] ${r.url}\n${r.snippet}\n`;
          sources.push({ title: r.title, url: r.url });
        }
        searched = true;
        break;
      } catch (e) {
        failures.push(`${searcher.provider}: ${(e as Error).message}`);
      }
    }
    // Configured providers always get first chance. If none is configured or
    // all fail, use a real keyless public search rather than inventing results.
    if (!searched) {
      try {
        const results = await publicWebSearch(cleaned);
        for (const r of results) {
          context += `\n[${r.title}] ${r.url}\n${r.snippet}\n`;
          sources.push({ title: r.title, url: r.url });
        }
        searched = true;
      } catch (e) {
        failures.push(`Public web-search fallback: ${(e as Error).message}`);
      }
    }
    if (!searched) {
      failures.push(
        searchers.length
          ? "Configured search providers and the public web-search fallback failed."
          : "No configured search provider was available and the public web-search fallback failed.",
      );
    }
  }

  const result: {
    context: string;
    sources: Array<{ title: string; url: string }>;
    webError?: string;
  } = { context, sources };
  if (!sources.length && failures.length) result.webError = failures.join(" ");
  return result;
}
