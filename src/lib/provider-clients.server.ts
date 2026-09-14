/**
 * Real provider calls: connection tests, chat completions, web search,
 * OCR, TTS and STT. No fake responses — every state comes from a real HTTP call.
 */
import type { ProviderDef } from "./providers";
import { getProvider } from "./providers";
import {
  coreKeyConfigured,
  resolveCoreChatModel,
  USTAD_CORE_GATEWAY,
  isObsoleteCoreModel,
} from "./ustad-core";
import {
  openaiCompatibleBase,
  OPENAI_COMPATIBLE_ENDPOINTS,
  resolveChatModel,
  DIRECT_CHAT_DEFAULTS,
} from "./provider-defaults";
import { sanitizeErrorDetail } from "./provider-errors";

export type TestResult = {
  status:
    | "connected"
    | "invalid_credentials"
    | "unauthorized"
    | "rate_limited"
    | "quota_exceeded"
    | "provider_unavailable"
    | "network_error"
    | "failed"
    | "missing_field";
  detail: string;
  latencyMs: number;
  models?: string[] | undefined;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

function statusFromHttp(code: number, body: string): TestResult["status"] {
  if (code === 401 || code === 403) return "unauthorized";
  if (code === 429) return /quota|billing|credit/i.test(body) ? "quota_exceeded" : "rate_limited";
  if (code === 400 && /api key|invalid key|unauthor/i.test(body)) return "invalid_credentials";
  if (code >= 500) return "provider_unavailable";
  return "failed";
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const r = await fn();
  return [r, Date.now() - t];
}

async function probe(
  url: string,
  init: RequestInit,
  parseModels?: (json: unknown) => string[],
): Promise<TestResult> {
  try {
    const [res, latencyMs] = await timed(() => fetch(url, init));
    const text = await res.text();
    if (res.ok) {
      let models: string[] | undefined;
      if (parseModels) {
        try {
          models = parseModels(JSON.parse(text)).slice(0, 60);
        } catch {
          models = undefined;
        }
      }
      return { status: "connected", detail: "Connection verified", latencyMs, models };
    }
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      detail = (typeof j.error === "string" ? j.error : j.error?.message) || j.message || detail;
    } catch {
      /* keep raw text */
    }
    return {
      status: statusFromHttp(res.status, text),
      detail: detail || `HTTP ${res.status}`,
      latencyMs,
    };
  } catch (e) {
    return {
      status: "network_error",
      detail: e instanceof Error ? e.message : "Network error",
      latencyMs: 0,
    };
  }
}

const openaiModels = (j: unknown) =>
  ((j as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id);

export function missingFields(def: ProviderDef, config: Record<string, string>): string[] {
  return def.fields.filter((f) => f.required && !config[f.key]?.trim()).map((f) => f.label);
}

export async function testProvider(
  providerId: string,
  config: Record<string, string>,
): Promise<TestResult> {
  const def = getProvider(providerId);
  if (!def) return { status: "failed", detail: "Unknown provider", latencyMs: 0 };
  const missing = missingFields(def, config);
  if (missing.length) {
    return { status: "missing_field", detail: `Missing: ${missing.join(", ")}`, latencyMs: 0 };
  }
  const k = config["api_key"] ?? "";
  const bearer = { Authorization: `Bearer ${k}` };

  switch (providerId) {
    case "openai":
      return probe(
        `${config["base_url"] || "https://api.openai.com/v1"}/models`,
        {
          headers: {
            ...bearer,
            ...(config["organization_id"]
              ? { "OpenAI-Organization": config["organization_id"] }
              : {}),
          },
        },
        openaiModels,
      );
    case "mistral":
      return probe(
        `${config["base_url"] || "https://api.mistral.ai/v1"}/models`,
        { headers: bearer },
        openaiModels,
      );
    case "sambanova":
      return probe(
        `${config["base_url"] || "https://api.sambanova.ai/v1"}/models`,
        { headers: bearer },
        openaiModels,
      );
    case "groq":
      return probe("https://api.groq.com/openai/v1/models", { headers: bearer }, openaiModels);
    case "openrouter":
      return probe("https://openrouter.ai/api/v1/models", { headers: bearer }, (j) =>
        ((j as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id),
      );
    case "cerebras":
      return probe("https://api.cerebras.ai/v1/models", { headers: bearer }, openaiModels);
    case "xai":
      return probe("https://api.x.ai/v1/models", { headers: bearer }, openaiModels);
    case "zhipu":
      return probe("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-4-flash",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
    case "gemini":
      return probe(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`,
        {},
        (j) =>
          ((j as { models?: Array<{ name: string }> }).models ?? []).map((m) =>
            m.name.replace("models/", ""),
          ),
      );
    case "cohere":
      return probe("https://api.cohere.com/v1/models", { headers: bearer }, (j) =>
        ((j as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name),
      );
    case "tavily":
      return probe("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: k, query: "ustad ai connection test", max_results: 1 }),
      });
    case "exa":
      return probe("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": k, "content-type": "application/json" },
        body: JSON.stringify({ query: "connection test", numResults: 1 }),
      });
    case "firecrawl":
      return probe("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }),
      });
    case "jina":
      return probe("https://r.jina.ai/https://example.com", { headers: bearer });
    case "elevenlabs":
      return probe("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": k } }, (j) =>
        ((j as { voices?: Array<{ voice_id: string; name: string }> }).voices ?? []).map(
          (v) => `${v.name} (${v.voice_id})`,
        ),
      );
    case "deepgram":
      return probe("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${k}` },
      });
    case "assemblyai":
      return probe("https://api.assemblyai.com/v2/transcript?limit=1", {
        headers: { authorization: k },
      });
    case "replicate":
      return probe("https://api.replicate.com/v1/models", {
        headers: { Authorization: `Bearer ${k}` },
      });
    case "tensorart":
      return probe("https://ap-east-1.tensorart.cloud/v1/models?limit=1", { headers: bearer });
    case "spaceocr":
      return probe(
        "https://api.ocr.space/parse/imageurl?apikey=" +
          encodeURIComponent(k) +
          "&url=https://i.imgur.com/31d5L5y.jpg",
        {},
      );
    case "github":
      return probe("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${config["access_token"]}`, "User-Agent": "USTAD-AI" },
      });
    case "supabase":
      return probe(`${config["url"]!.replace(/\/$/, "")}/rest/v1/`, {
        headers: { apikey: config["anon_key"]!, Authorization: `Bearer ${config["anon_key"]}` },
      });
    case "turso":
      return probe(`${config["database_url"]!.replace(/\/$/, "")}/v2/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config["token"]}`, "content-type": "application/json" },
        body: JSON.stringify({
          requests: [{ type: "execute", stmt: { sql: "select 1" } }, { type: "close" }],
        }),
      });
    case "appwrite":
      return probe(`${config["endpoint"]!.replace(/\/$/, "")}/health`, {
        headers: {
          "X-Appwrite-Project": config["project_id"]!,
          ...(config["api_key"] ? { "X-Appwrite-Key": config["api_key"] } : {}),
        },
      });
    case "qdrant":
      return probe(`${config["url"]!.replace(/\/$/, "")}/collections`, {
        headers: { "api-key": config["api_key"]! },
      });
    case "chroma":
      return probe(`${config["url"]!.replace(/\/$/, "")}/api/v2/heartbeat`, {
        headers: config["token"] ? { Authorization: `Bearer ${config["token"]}` } : {},
      });
    case "pinecone":
      return probe("https://api.pinecone.io/indexes", {
        headers: { "Api-Key": k, "X-Pinecone-API-Version": "2024-07-01" },
      });
    default:
      return { status: "failed", detail: "No test implemented for this provider", latencyMs: 0 };
  }
}

/* ---------------- Chat completions ---------------- */

/** "stop" = model finished on its own, "length" = provider hit the output limit. */
export type FinishReason = "stop" | "length" | "other";

export type ChatCallResult = {
  text: string;
  model: string;
  provider: string;
  finishReason: FinishReason;
};

function normalizeFinish(raw: unknown): FinishReason {
  const v = String(raw ?? "").toLowerCase();
  if (!v) return "other";
  if (v === "length" || v === "max_tokens" || v === "model_length" || v === "max_token")
    return "length";
  if (v === "stop" || v === "end_turn" || v === "complete" || v === "eos" || v === "stop_sequence")
    return "stop";
  return "other";
}

const OPENAI_COMPATIBLE: Record<string, { url: string; defaultModels: string[] }> = {
  openai: { url: "https://api.openai.com/v1", defaultModels: ["gpt-4o-mini", "gpt-4o"] },
  groq: {
    url: "https://api.groq.com/openai/v1",
    defaultModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  mistral: {
    url: "https://api.mistral.ai/v1",
    defaultModels: ["mistral-large-latest", "mistral-small-latest"],
  },
  sambanova: { url: "https://api.sambanova.ai/v1", defaultModels: ["Meta-Llama-3.3-70B-Instruct"] },
  openrouter: { url: "https://openrouter.ai/api/v1", defaultModels: ["openai/gpt-4o-mini"] },
  cerebras: { url: "https://api.cerebras.ai/v1", defaultModels: ["llama-3.3-70b"] },
  xai: { url: "https://api.x.ai/v1", defaultModels: ["grok-2-latest"] },
  zhipu: { url: "https://open.bigmodel.cn/api/paas/v4", defaultModels: ["glm-4-flash"] },
};

/**
 * Reasoning-era OpenAI models reject `max_tokens` and `temperature`; they take
 * `max_completion_tokens` instead. Sending the wrong parameter is a 400, which
 * used to surface as a provider failure and an immediate fallback.
 */
function usesCompletionTokens(provider: string, model: string): boolean {
  if (provider !== "openai" && provider !== "openrouter") return false;
  return /(?:^|\/)(?:gpt-5|o1|o3|o4)/i.test(model);
}

export async function chatWithProvider(opts: {
  provider: string;
  config: Record<string, string>;
  model?: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  liveModels?: string[];
}): Promise<ChatCallResult> {
  const { provider, config, messages, maxTokens } = opts;
  const liveModels = opts.liveModels;

  if (provider === "ustad-core") {
    if (!coreKeyConfigured()) {
      throw new Error("USTAD Core is not configured.");
    }
    const requested = opts.model && !isObsoleteCoreModel(opts.model) ? opts.model : undefined;
    const model = resolveCoreChatModel(requested, liveModels);
    const res = await fetch(`${USTAD_CORE_GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env["LOVABLE_API_KEY"]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    });
    if (!res.ok) {
      const body = sanitizeErrorDetail(await res.text());
      throw new Error(`USTAD Core AI failed (${res.status}): ${body}`);
    }
    const j = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason?: string }>;
    };
    return {
      text: j.choices?.[0]?.message?.content ?? "",
      model,
      provider,
      finishReason: normalizeFinish(j.choices?.[0]?.finish_reason),
    };
  }

  if (provider === "gemini") {
    const model =
      resolveChatModel({
        provider,
        requested: opts.model,
        liveModels,
      }) || DIRECT_CHAT_DEFAULTS["gemini"]!;
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: toGeminiParts(m.content),
      }));
    const system = messages.find((m) => m.role === "system");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config["api_key"]!)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: String(system.content) }] } } : {}),
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Gemini failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    const cand = j.candidates?.[0];
    return {
      text: (cand?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
      model,
      provider,
      finishReason: normalizeFinish(cand?.finishReason === "STOP" ? "stop" : cand?.finishReason),
    };
  }

  if (provider === "cohere") {
    const model = opts.model || "command-r-plus";
    const res = await fetch("https://api.cohere.com/v2/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${config["api_key"]}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    });
    if (!res.ok)
      throw new Error(`Cohere failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as {
      message?: { content?: Array<{ text?: string }> };
      finish_reason?: string;
    };
    return {
      text: (j.message?.content ?? []).map((c) => c.text ?? "").join(""),
      model,
      provider,
      finishReason: normalizeFinish(j.finish_reason === "COMPLETE" ? "stop" : j.finish_reason),
    };
  }

  const oc = OPENAI_COMPATIBLE[provider];
  if (!oc) throw new Error(`Provider ${provider} cannot generate chat responses`);
  const base = openaiCompatibleBase(provider, config["base_url"]) || oc.url;
  const model =
    resolveChatModel({
      provider,
      requested: opts.model,
      liveModels,
    }) || oc.defaultModels[0]!;
  const completionStyle = usesCompletionTokens(provider, model);
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config["api_key"]}`,
      "content-type": "application/json",
      ...(provider === "openai" && config["organization_id"]
        ? { "OpenAI-Organization": config["organization_id"] }
        : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      ...(completionStyle ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(completionStyle ? {} : { temperature: opts.temperature ?? 0.7 }),
    }),
  });
  if (!res.ok)
    throw new Error(`${provider} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as {
    choices: Array<{ message: { content: string }; finish_reason?: string }>;
  };
  return {
    text: j.choices?.[0]?.message?.content ?? "",
    model,
    provider,
    finishReason: normalizeFinish(j.choices?.[0]?.finish_reason),
  };
}

function toGeminiParts(content: ChatMessage["content"]) {
  if (typeof content === "string") return [{ text: content }];
  return content.map((part) => {
    if (part["type"] === "image_url") {
      const url = String((part["image_url"] as { url: string }).url);
      const [meta, data] = url.split(",");
      return {
        inlineData: { mimeType: meta?.match(/data:(.*?);/)?.[1] ?? "image/png", data: data ?? "" },
      };
    }
    return { text: String(part["text"] ?? "") };
  });
}

/* ---------------- Web search / read ---------------- */

export type WebResult = { title: string; url: string; snippet: string };

export async function webSearch(
  provider: string,
  config: Record<string, string>,
  query: string,
): Promise<WebResult[]> {
  if (provider === "tavily") {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: config["api_key"],
        query,
        max_results: 5,
        include_answer: false,
      }),
    });
    if (!res.ok) throw new Error(`Tavily search failed (${res.status})`);
    const j = (await res.json()) as {
      results?: Array<{ title: string; url: string; content: string }>;
    };
    return (j.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 500) ?? "",
    }));
  }
  if (provider === "exa") {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": config["api_key"]!, "content-type": "application/json" },
      body: JSON.stringify({ query, numResults: 5, contents: { text: { maxCharacters: 500 } } }),
    });
    if (!res.ok) throw new Error(`EXA search failed (${res.status})`);
    const j = (await res.json()) as {
      results?: Array<{ title: string; url: string; text?: string }>;
    };
    return (j.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.text?.slice(0, 500) ?? "",
    }));
  }
  if (provider === "jina") {
    // Jina's search endpoint: same key as the reader, JSON result set.
    const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${config["api_key"]}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Jina search failed (${res.status})`);
    const j = (await res.json()) as {
      data?: Array<{ title?: string; url?: string; description?: string; content?: string }>;
    };
    return (j.data ?? [])
      .filter((r) => r.url)
      .slice(0, 5)
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        snippet: (r.description ?? r.content ?? "").slice(0, 500),
      }));
  }
  if (provider === "firecrawl") {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${config["api_key"]}`, "content-type": "application/json" },
      body: JSON.stringify({ query, limit: 5 }),
    });
    if (!res.ok) throw new Error(`Firecrawl search failed (${res.status})`);
    const j = (await res.json()) as {
      data?: Array<{ title?: string; url?: string; description?: string }>;
    };
    return (j.data ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        snippet: (r.description ?? "").slice(0, 500),
      }));
  }
  throw new Error(`Provider ${provider} does not support web search`);
}

/**
 * Keyless live-search fallback. This is server-side so browser CORS and
 * third-party credentials are never exposed to the client. DuckDuckGo's
 * public HTML endpoint returns real current result links without an API key.
 */
export async function publicWebSearch(query: string): Promise<WebResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html",
        "user-agent": "USTAD-AI/1.0 (live web search)",
      },
    });
    if (!res.ok) throw new Error(`Public web search failed (${res.status})`);
    const html = await res.text();
    const results: WebResult[] = [];
    const resultPattern =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;
    for (const match of html.matchAll(resultPattern)) {
      const rawUrl = decodeHtml(String(match[1] ?? ""));
      const resultUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
      const title = stripHtml(String(match[2] ?? ""));
      const snippet = stripHtml(String(match[3] ?? match[4] ?? ""));
      if (!/^https?:\/\//i.test(resultUrl) || !title || !snippet) continue;
      const redirectTarget = resultUrl.match(/[?&]uddg=([^&]+)/)?.[1];
      const resolvedUrl = redirectTarget ? safeDecodeURIComponent(redirectTarget) : resultUrl;
      if (!/^https?:\/\//i.test(resolvedUrl)) continue;
      results.push({ title, url: resolvedUrl, snippet: snippet.slice(0, 500) });
      if (results.length === 5) break;
    }
    if (!results.length) throw new Error("Public web search returned no parseable results.");
    return results;
  } finally {
    clearTimeout(timeout);
  }
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function readUrl(
  provider: string,
  config: Record<string, string>,
  url: string,
): Promise<string> {
  if (provider === "jina") {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Authorization: `Bearer ${config["api_key"]}` },
    });
    if (!res.ok) throw new Error(`Jina read failed (${res.status})`);
    return (await res.text()).slice(0, 8000);
  }
  if (provider === "firecrawl") {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${config["api_key"]}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!res.ok) throw new Error(`Firecrawl read failed (${res.status})`);
    const j = (await res.json()) as { data?: { markdown?: string } };
    return (j.data?.markdown ?? "").slice(0, 8000);
  }
  throw new Error(`Provider ${provider} does not support URL reading`);
}

/* ---------------- OCR ---------------- */

export async function ocrImage(
  config: Record<string, string>,
  base64DataUrl: string,
): Promise<string> {
  const form = new FormData();
  form.append("base64Image", base64DataUrl);
  form.append("apikey", config["api_key"]!);
  form.append("OCREngine", "2");
  const res = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: form });
  if (!res.ok) throw new Error(`OCR failed (${res.status})`);
  const j = (await res.json()) as {
    ParsedResults?: Array<{ ParsedText?: string }>;
    ErrorMessage?: string | string[];
  };
  if (j.ErrorMessage && j.ErrorMessage.length) throw new Error(String(j.ErrorMessage));
  return (j.ParsedResults ?? [])
    .map((p) => p.ParsedText ?? "")
    .join("\n")
    .trim();
}

/* ---------------- Voice ---------------- */

export async function ttsSynthesize(
  provider: string,
  config: Record<string, string>,
  text: string,
): Promise<{ audioBase64: string; mime: string }> {
  if (provider === "elevenlabs") {
    const voice = config["voice_id"] || "9BWtsMINqrJLrRacOk9x";
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "xi-api-key": config["api_key"]!, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status})`);
    return { audioBase64: bufToB64(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
  if (provider === "deepgram") {
    const res = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-en", {
      method: "POST",
      headers: { Authorization: `Token ${config["api_key"]}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Deepgram TTS failed (${res.status})`);
    return { audioBase64: bufToB64(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
  if (provider === "openai") {
    const res = await fetch(`${config["base_url"] || "https://api.openai.com/v1"}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config["api_key"]}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS failed (${res.status})`);
    return { audioBase64: bufToB64(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
  throw new Error(`Provider ${provider} does not support text-to-speech`);
}

export async function sttTranscribe(
  provider: string,
  config: Record<string, string>,
  audio: { base64: string; mime: string },
): Promise<string> {
  const bytes = b64ToBuf(audio.base64);
  if (provider === "deepgram") {
    const res = await fetch(
      "https://api.deepgram.com/v1/listen?smart_format=true&detect_language=true",
      {
        method: "POST",
        headers: { Authorization: `Token ${config["api_key"]}`, "content-type": audio.mime },
        body: bytes,
      },
    );
    if (!res.ok) throw new Error(`Deepgram STT failed (${res.status})`);
    const j = (await res.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    return j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  }
  if (provider === "groq" || provider === "openai") {
    const base =
      provider === "groq"
        ? "https://api.groq.com/openai/v1"
        : config["base_url"] || "https://api.openai.com/v1";
    const model = provider === "groq" ? "whisper-large-v3-turbo" : "gpt-4o-mini-transcribe";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: audio.mime }), "audio.webm");
    form.append("model", model);
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config["api_key"]}` },
      body: form,
    });
    if (!res.ok) throw new Error(`${provider} STT failed (${res.status})`);
    const j = (await res.json()) as { text?: string };
    return j.text ?? "";
  }
  if (provider === "assemblyai") {
    const up = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: { authorization: config["api_key"]! },
      body: bytes,
    });
    if (!up.ok) throw new Error(`AssemblyAI upload failed (${up.status})`);
    const { upload_url } = (await up.json()) as { upload_url: string };
    const start = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: { authorization: config["api_key"]!, "content-type": "application/json" },
      body: JSON.stringify({ audio_url: upload_url, language_detection: true }),
    });
    const { id } = (await start.json()) as { id: string };
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { authorization: config["api_key"]! },
      });
      const j = (await poll.json()) as { status: string; text?: string; error?: string };
      if (j.status === "completed") return j.text ?? "";
      if (j.status === "error") throw new Error(j.error ?? "AssemblyAI transcription failed");
    }
    throw new Error("AssemblyAI transcription timed out");
  }
  throw new Error(`Provider ${provider} does not support speech-to-text`);
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64ToBuf(b64: string): Uint8Array<ArrayBuffer> {
  const clean = b64.includes(",") ? b64.split(",")[1]! : b64;
  const bin = atob(clean);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
