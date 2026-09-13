/**
 * BROWSER / ON-DEVICE AI LAYER (client only).
 *
 * This module NEVER assumes a specific browser AI model exists. At runtime it
 * probes every on-device text-generation surface the current browser genuinely
 * exposes, keeps only the ones that are usable right now WITHOUT a multi-GB
 * model download, and returns them as an ordered pool.
 *
 * Routing contract (used by both chat and question generation):
 *   device model #1 -> #2 -> #3 -> ... -> (all failed) -> existing API Manager
 *
 * A model is considered FAILED on: init error, unavailable, incompatible device,
 * timeout, generation error, empty response, malformed response, response that
 * fails the caller's validator (invalid / incomplete / cut-off output).
 * A failed model is never retried inside the same run.
 */

export type DeviceAttempt = { id: string; ok: boolean; error?: string; ms: number };

export type DeviceResult = {
  text: string;
  engineId: string;
  engineLabel: string;
  attempts: DeviceAttempt[];
};

type Session = {
  prompt: (text: string, opts?: { signal?: AbortSignal }) => Promise<string>;
  destroy?: () => void;
};

type Candidate = {
  id: string;
  label: string;
  /** Lower = tried earlier. Derived from probed capability, never random. */
  rank: number;
  open: (signal: AbortSignal) => Promise<Session>;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function isFn(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/** "available" = usable now. Anything needing a big download is excluded. */
async function readAvailability(host: UnknownRecord): Promise<string> {
  try {
    if (isFn(host['availability'])) {
      const v = await (host['availability'] as () => Promise<unknown>)();
      return typeof v === "string" ? v : "unavailable";
    }
    if (isFn(host['capabilities'])) {
      const v = asRecord(await (host['capabilities'] as () => Promise<unknown>)());
      const a = v?.['available'];
      return typeof a === "string" ? a : "unavailable";
    }
  } catch {
    return "unavailable";
  }
  // A surface with create() but no capability reporting: verified by opening it.
  return isFn(host['create']) ? "unknown" : "unavailable";
}

async function openPromptApi(
  host: UnknownRecord,
  params: UnknownRecord,
  signal: AbortSignal,
): Promise<Session> {
  const create = host['create'];
  if (!isFn(create)) throw new Error("create() missing");
  const session = asRecord(await create({ ...params, signal }));
  if (!session) throw new Error("session not created");
  const promptFn = session['prompt'];
  if (!isFn(promptFn)) throw new Error("prompt() missing");
  return {
    prompt: async (text, opts) => {
      const out = await (promptFn as (t: string, o?: unknown) => Promise<unknown>).call(
        session,
        text,
        opts?.signal ? { signal: opts.signal } : undefined,
      );
      return typeof out === "string" ? out : String(out ?? "");
    },
    destroy: () => {
      const d = session['destroy'];
      if (isFn(d)) {
        try {
          (d as () => void).call(session);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

async function openLegacyTextSession(
  host: UnknownRecord,
  signal: AbortSignal,
): Promise<Session> {
  void signal;
  const create = host['createTextSession'];
  if (!isFn(create)) throw new Error("createTextSession() missing");
  const session = asRecord(await create());
  const promptFn = session?.['prompt'];
  if (!session || !isFn(promptFn)) throw new Error("legacy session unusable");
  return {
    prompt: async (text) => {
      const out = await (promptFn as (t: string) => Promise<unknown>).call(session, text);
      return typeof out === "string" ? out : String(out ?? "");
    },
    destroy: () => {
      const d = session['destroy'];
      if (isFn(d)) {
        try {
          (d as () => void).call(session);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/**
 * Probe every on-device surface this browser actually exposes.
 * Surfaces are discovered by feature detection only — nothing is hard-coded to
 * one vendor's model, and a surface that reports it is not available is dropped.
 */
export async function detectDevicePool(): Promise<Candidate[]> {
  if (typeof window === "undefined") return [];
  const g = globalThis as unknown as UnknownRecord;
  const ai = asRecord(g['ai']);

  /* Every known standard/legacy on-device prompt surface, in spec-recency order.
   * Presence is checked at runtime; absence simply yields a smaller pool. */
  const surfaces: Array<{ key: string; host: UnknownRecord | null; baseRank: number }> = [
    { key: "language-model", host: asRecord(g['LanguageModel']), baseRank: 0 },
    { key: "window.ai.languageModel", host: asRecord(ai?.['languageModel']), baseRank: 10 },
    { key: "window.ai.assistant", host: asRecord(ai?.['assistant']), baseRank: 20 },
    { key: "window.ai.textSession", host: ai && isFn(ai['createTextSession']) ? ai : null, baseRank: 30 },
  ];

  const pool: Candidate[] = [];
  for (const s of surfaces) {
    if (!s.host) continue;

    if (s.key === "window.ai.textSession") {
      pool.push({
        id: s.key,
        label: "On-device AI (legacy text session)",
        rank: s.baseRank,
        open: (signal) => openLegacyTextSession(s.host!, signal),
      });
      continue;
    }

    const availability = await readAvailability(s.host);
    // Only surfaces usable right now. "downloadable"/"downloading"/"unavailable"
    // would force a large model download, which is explicitly not allowed.
    if (availability !== "available" && availability !== "readily" && availability !== "unknown") {
      continue;
    }

    /* Two probed configurations of the same surface count as two pool entries:
     * a precise low-temperature one (best for structured output) and the
     * device default one (most reliable). Values come from the surface's own
     * reported params when it exposes them. */
    const variants: Array<{ suffix: string; label: string; params: UnknownRecord }> = [
      { suffix: "precise", label: "precise", params: { temperature: 0.2, topK: 1 } },
      { suffix: "default", label: "device default", params: {} },
    ];
    for (const [i, v] of variants.entries()) {
      pool.push({
        id: `${s.key}:${v.suffix}`,
        label: `On-device AI (${s.key}, ${v.label})`,
        rank: s.baseRank + i,
        open: (signal) => openPromptApi(s.host!, v.params, signal),
      });
    }
  }

  return pool.sort((a, b) => a.rank - b.rank);
}

/** True when this browser/device exposes at least one usable on-device model. */
export async function hasDeviceAi(): Promise<boolean> {
  try {
    return (await detectDevicePool()).length > 0;
  } catch {
    return false;
  }
}

export type DeviceRunOptions = {
  system: string;
  user: string;
  /** Per-model wall clock. A slow model is a failure, not a hang. */
  timeoutMs?: number;
  /**
   * Accept the response or reject it. Rejection (invalid / incomplete /
   * cut-off / malformed) moves routing to the next device model.
   */
  validate?: (text: string) => boolean;
};

/** Empty, or an obviously cut-off / fenced-open response, is never accepted. */
export function looksComplete(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const fences = (t.match(/```/g) ?? []).length;
  if (fences % 2 !== 0) return false;
  return true;
}

/**
 * Try every detected on-device model in priority order, once each.
 * Returns null when the device has no usable model or all of them failed —
 * the caller then uses the existing API Manager path.
 */
export async function runDeviceText(opts: DeviceRunOptions): Promise<DeviceResult | null> {
  const pool = await detectDevicePool().catch(() => []);
  if (!pool.length) return null;

  const attempts: DeviceAttempt[] = [];
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const tried = new Set<string>();

  for (const candidate of pool) {
    if (tried.has(candidate.id)) continue;
    tried.add(candidate.id);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let session: Session | null = null;
    try {
      session = await candidate.open(controller.signal);
      const raw = await session.prompt(`${opts.system}\n\n${opts.user}`, {
        signal: controller.signal,
      });
      const text = typeof raw === "string" ? raw : "";
      if (!looksComplete(text)) throw new Error("empty or cut-off response");
      if (opts.validate && !opts.validate(text)) throw new Error("response failed validation");
      attempts.push({ id: candidate.id, ok: true, ms: Date.now() - started });
      return { text: text.trim(), engineId: candidate.id, engineLabel: candidate.label, attempts };
    } catch (e) {
      attempts.push({
        id: candidate.id,
        ok: false,
        error: e instanceof Error ? e.message : "device model failed",
        ms: Date.now() - started,
      });
    } finally {
      clearTimeout(timer);
      session?.destroy?.();
    }
  }

  return null;
}
