/**
 * FREE-TIER MODEL ELIGIBILITY (client-safe, no keys).
 *
 * The API Manager model dropdown must ONLY offer models that a provider serves
 * on its free tier, and "Default" must resolve to the BEST free model that the
 * provider actually reported in the live connection test — never a random pick
 * and never a paid-only model.
 *
 * Rules are matched against the live model list from the provider itself. A
 * provider with no rule is treated as "unknown", which means NOT free (we never
 * silently offer a paid-only model).
 */

type Rule = { free: RegExp; paid?: RegExp };

const NONE = /$^/;

const FREE_RULES: Record<string, Rule> = {
  // Free developer tiers: every chat model listed is usable without payment.
  groq: { free: /.*/, paid: NONE },
  cerebras: { free: /.*/, paid: NONE },
  sambanova: { free: /.*/, paid: NONE },
  "ustad-core": { free: /.*/, paid: NONE },
  // Google free tier: Flash / Flash-Lite / Gemma. Pro & Imagen are paid.
  gemini: { free: /flash|gemma/i, paid: /\bpro\b|ultra|imagen|veo/i },
  // Mistral free (La Plateforme free tier / open weights).
  mistral: {
    free: /^open-|mistral-small|ministral|magistral-small|devstral-small|pixtral-12b/i,
    paid: /large|medium|codestral-latest|embed/i,
  },
  // OpenRouter marks free variants with the `:free` suffix.
  openrouter: { free: /:free$/i, paid: NONE },
  // Zhipu free models: Flash / Air family.
  zhipu: { free: /flash|-air/i, paid: NONE },
  // Cohere trial keys: command-r / command-light (not the plus tier).
  cohere: { free: /command-light|command-r(?!-plus)|^command$/i, paid: /plus/i },
  // No free chat tier.
  openai: { free: NONE },
  xai: { free: NONE },
};

export function providerHasFreeTier(provider: string): boolean {
  const rule = FREE_RULES[provider];
  return !!rule && rule.free !== NONE;
}

export function isFreeModel(provider: string, model: string): boolean {
  const rule = FREE_RULES[provider];
  const id = model.trim();
  if (!rule || !id) return false;
  if (rule.paid && rule.paid !== NONE && rule.paid.test(id)) return false;
  return rule.free.test(id);
}

/** Higher = better quality. Derived from the model id itself, never random. */
export function modelQualityScore(model: string): number {
  const m = model.toLowerCase();
  let score = 50;
  const params = /(\d{2,3})\s*b\b/.exec(m);
  if (params) score += Math.min(40, Number(params[1]) / 3);
  if (/(?:^|[^a-z])(?:405|70|72|120)b/.test(m)) score += 15;
  if (/pro|large|ultra|maverick|versatile|reason|thinking/.test(m)) score += 12;
  if (/2\.5|3\.\d|4\.\d|-4o|glm-4\.5|latest/.test(m)) score += 6;
  if (/small|mini|lite|nano|tiny|8b|7b|instant|light|1b|3b/.test(m)) score -= 12;
  if (/flash-lite/.test(m)) score -= 6;
  return score;
}

/** Free models this provider actually reported, best quality first. */
export function freeModelsFor(provider: string, models: string[]): string[] {
  const seen = new Set<string>();
  return models
    .map((m) => m.trim())
    .filter((m) => m && isFreeModel(provider, m) && !seen.has(m) && (seen.add(m), true))
    .sort((a, b) => modelQualityScore(b) - modelQualityScore(a));
}

/** Best active FREE model, or undefined when the provider reported none. */
export function bestFreeModel(provider: string, models: string[]): string | undefined {
  return freeModelsFor(provider, models)[0];
}
