/** The USTAD AI chat pipeline: context → routing → provider fallback → persistence. */
import { requireGuest, db } from "./guest.server";
import { usableProviders, coreProvider, coreCandidates } from "./api-manager.server";
import {
  route,
  systemPrompt,
  selectChatProviders,
  runChat,
  gatherWeb,
  detectCurriculumRequest,
  curriculumContextLine,
  type Language,
} from "./router.server";
import { resolveCurriculumForUser, contextOf } from "./curriculum.server";
import { getChapterContextPack } from "./book-knowledge.server";
import { ocrImage, type ChatMessage } from "./provider-clients.server";
import { parseWhen, detectRepeat } from "./chronos";
import { answerChrono, chronoContext, needsChrono } from "./chrono-engine";
import { examContext } from "./exam-engine.server";
import { achievementContext } from "./trophy-engine.server";
import { certificateContext } from "./certificate-engine.server";
import { rankChatContext } from "./rank-engine.server";
import { masterEventContext } from "./master-event-engine.server";
import { walletContext } from "./wallet.server";
import { notificationContext } from "./notification.server";
import { generateImage, imagePromptFrom, wantsImageGeneration } from "./image-gen.server";
import { userFacingAiMessage } from "./provider-errors";
import { getProvider } from "./providers";

/** The user explicitly wants the text read out of an attached image. */
function wantsOcr(text: string): boolean {
  return /\b(ocr|read (?:the )?text|text nikal|text nikalo|extract text|type this|likha hua kya|scan)\b/i.test(
    text,
  );
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  meta?: JsonValue;
  attachments?: JsonValue;
};

export type SendResult = {
  conversationId: string;
  userMessage: MessageRow | null;
  assistantMessage: MessageRow | null;
  status: {
    intent: string;
    complexity: string;
    language: string;
    provider: string;
    model: string;
    fallbackUsed: boolean;
    sources: Array<{ title: string; url: string }>;
    showSources: boolean;
    truncated: boolean;
    continuations: number;
    chrono?: string;
    memorySaved?: string;
    reminderCreated?: string;
    /** Curriculum Brain resolution line (only when a curriculum signal was present). */
    curriculum?: string;
  };
  /**
   * BROWSER AI ROUTING (plan mode only): the exact prompt the on-device model
   * must answer. Absent when this turn cannot be answered on the device.
   */
  plan?:
    | { system: string; messages: Array<{ role: string; content: string }>; maxTokens: number }
    | undefined;


};

/** The user must explicitly ask before sources are shown in the UI. */
function wantsSources(text: string): boolean {
  return /\b(source|sources|sourc?e batao|sources dikhao|reference|references|citation|citations|links? do|link do|link bhejo|kahan se|where did you)\b/i.test(
    text,
  );
}

export async function sendMessage(input: {
  token: unknown;
  conversationId?: string | undefined;
  text: string;
  attachmentIds?: string[] | undefined;
  clientNow?: string | undefined;
  timeZone?: string | undefined;
  /** Browser AI routing: build and return the prompt only, answer nothing. */
  plan?: boolean | undefined;
  /** Browser AI routing: a validated answer already produced on the device. */
  deviceText?: string | undefined;
  /** Which on-device model produced `deviceText` (shown in the status line). */
  deviceEngine?: string | undefined;
}): Promise<SendResult> {
  const guestId = await requireGuest(input.token);
  const client = db();
  const text = input.text.trim();
  const attachmentIds = input.attachmentIds ?? [];
  const planOnly = input.plan === true;
  const deviceText = (input.deviceText ?? "").trim();
  if (!text && attachmentIds.length === 0) throw new Error("Message is empty.");


  /* conversation */
  let conversationId = input.conversationId;
  if (conversationId) {
    const { data } = await client
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("guest_id", guestId)
      .maybeSingle();
    if (!data) throw new Error("Conversation not found");
  } else {
    const { data, error } = await client
      .from("conversations")
      .insert({ guest_id: guestId, title: text.slice(0, 60) || "New chat" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    conversationId = data.id;
  }

  /* guest context */
  const [
    { data: profile },
    { data: settings },
    { data: memories },
    { data: goals },
    { data: history },
  ] = await Promise.all([
    client.from("profiles").select("*").eq("guest_id", guestId).maybeSingle(),
    client.from("settings").select("*").eq("guest_id", guestId).maybeSingle(),
    client
      .from("memories")
      .select("content")
      .eq("guest_id", guestId)
      .order("created_at", { ascending: false })
      .limit(25),
    client.from("goals").select("title").eq("guest_id", guestId).eq("status", "active").limit(10),
    client
      .from("messages")
      .select("role,content")
      .eq("guest_id", guestId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(16),
  ]);

  /* attachments */
  const attachments: Array<{
    id: string;
    name: string;
    mime: string;
    kind: string;
    data: string;
    extracted_text: string | null;
  }> = [];
  if (attachmentIds.length) {
    const { data } = await client
      .from("attachments")
      .select("id,name,mime,kind,data,extracted_text")
      .eq("guest_id", guestId)
      .in("id", attachmentIds);
    attachments.push(...((data ?? []) as typeof attachments));
  }

  const preferred = (settings?.language ?? profile?.language ?? "english") as Language;
  const dataSaver = Boolean(settings?.data_saver);
  // The user's explicit web-search setting (Section 11). It flows into the
  // router and gates every web tool below; a false value means no web search,
  // no URL reading, regardless of intent.
  const webSearchEnabled = (settings as { web_search?: boolean } | null)?.web_search !== false;
  const hasImages = attachments.some((a) => a.kind === "image");
  const decision = route({
    text,
    hasImages,
    preferredLanguage: preferred,
    dataSaver,
    webSearchEnabled,
  });
  // Explicit multimodal intents override the generic router.
  const imageRequest = !hasImages && wantsImageGeneration(text);
  if (imageRequest) decision.intent = "image-generation";
  const ocrRequest = hasImages && wantsOcr(text);
  if (ocrRequest) decision.intent = "ocr";

  /* CHRONO ENGINE — real clock, never guessed by the model. */
  const nowDate =
    input.clientNow && !Number.isNaN(Date.parse(input.clientNow))
      ? new Date(input.clientNow)
      : new Date();
  const timeZone = input.timeZone || (settings?.timezone as string | undefined) || "UTC";
  const chrono = needsChrono(text) ? answerChrono(text, nowDate, timeZone) : null;
  const chronoFacts = chronoContext(nowDate, timeZone);

  /* examination records — authoritative marks, never guessed */
  const examFacts = await examContext(guestId).catch(() => "");

  /* trophy / cup / grandmaster records — authoritative rank, never guessed */
  const achievementFacts = await achievementContext(guestId).catch(() => "");

  /* issued certificates — authoritative ids and dates, never guessed */
  const certificateFacts = await certificateContext(guestId).catch(() => "");

  /* weekly leaderboard — live standing, verified cups and settled ranks */
  const leaderboardFacts = await rankChatContext(guestId).catch(() => "");

  /* master event participation — verified results only, never guessed */
  const eventFacts = await masterEventContext(guestId).catch(() => "");

  /* weekly Mystery + GOD MASTER tournaments — verified attempts only */
  const tournamentFacts = await (
    await import("./tournament-engine.server")
  )
    .tournamentContext(guestId)
    .catch(() => "");

  /* USTAD Coin wallet — the authoritative balance, never guessed */
  const walletFacts = await walletContext(guestId).catch(() => "");
  const notificationFacts = await notificationContext(guestId).catch(() => "");

  const available = await usableProviders(guestId);

  /* IMAGE GENERATION BRANCH — a real generated picture, saved as an attachment. */
  if (imageRequest) {
    const prompt = imagePromptFrom(text);
    let image: Awaited<ReturnType<typeof generateImage>>["image"];
    let failures: string[];
    try {
      const generated = await generateImage(available, prompt);
      image = generated.image;
      failures = generated.failures;
    } catch (e) {
      throw new Error(
        userFacingAiMessage(e, {
          hadUserProvider: available.some((p) =>
            ["replicate", "openai", "stability"].includes(p.provider),
          ),
          coreConfigured: Boolean(coreProvider()),
        }),
      );
    }

    const { data: saved } = await client
      .from("attachments")
      .insert({
        guest_id: guestId,
        conversation_id: conversationId,
        name: `${prompt.slice(0, 40) || "image"}.png`,
        mime: "image/png",
        kind: "image",
        size: image.dataUrl.length,
        data: "",
      })
      .select("id")
      .maybeSingle();
    if (saved?.id) {
      const { storeGeneratedImageData } = await import("./data.server");
      const stored = await storeGeneratedImageData(guestId, saved.id, image.dataUrl);
      await client.from("attachments").update({ data: stored }).eq("id", saved.id);
    }

    const note =
      decision.language === "english"
        ? `Here is the image I generated for: **${prompt}**`
        : decision.language === "hindi"
          ? `यह रही आपके लिए बनाई गई तस्वीर: **${prompt}**`
          : `Yeh rahi aapke liye banayi gayi image: **${prompt}**`;
    // Bug 27: image lives in attachments only — never duplicate the base64 in markdown.
    const content = note;

    const { data: userMsg } = await client
      .from("messages")
      .insert({ conversation_id: conversationId, guest_id: guestId, role: "user", content: text })
      .select()
      .single();
    const { data: aiMsg } = await client
      .from("messages")
      .insert({
        conversation_id: conversationId,
        guest_id: guestId,
        role: "assistant",
        content,
        attachments: saved
          ? [
              {
                id: saved.id,
                name: `${prompt.slice(0, 40) || "image"}.png`,
                mime: "image/png",
                kind: "image",
              },
            ]
          : [],
        meta: {
          provider: image.provider,
          model: image.model,
          intent: "image-generation",
          complexity: decision.complexity,
          language: decision.language,
          sources: [],
          showSources: false,
          truncated: false,
          continuations: 0,
          imageAttachmentId: saved?.id ?? null,
          failures,
        },
      })
      .select()
      .single();

    await client
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("guest_id", guestId);

    return {
      conversationId,
      userMessage: (userMsg ?? null) as MessageRow | null,
      assistantMessage: (aiMsg ?? null) as MessageRow | null,
      status: {
        intent: "image-generation",
        complexity: decision.complexity,
        language: decision.language,
        provider: image.provider,
        model: image.model,
        fallbackUsed: failures.length > 0,
        sources: [],
        showSources: false,
        truncated: false,
        continuations: 0,
      },
    };
  }

  /* web intelligence — gated by the user's explicit web_search setting. */
  let webContext = "";
  let sources: Array<{ title: string; url: string }> = [];
  const showSources = wantsSources(text);
  if (
    decision.webSearchEnabled &&
    decision.needsWeb &&
    !(chrono?.handled && decision.urls.length === 0)
  ) {
    const web = await gatherWeb(available, decision, text);
    webContext = web.context;
    sources = web.sources;
    // Never pretend the web was consulted when it was not: the model is told
    // plainly, so the answer says so instead of inventing fresh facts.
    if (web.webError) {
      webContext += `\nLIVE WEB SEARCH UNAVAILABLE: ${web.webError}\nAnswer from your own knowledge and tell the user that live web results could not be fetched.\n`;
    }
  }

  /* provider candidates: user providers first, USTAD Core as final fallback when configured */
  const core = coreProvider();
  const candidates = [...selectChatProviders(available, decision), ...coreCandidates()];

  /* OCR fallback when no vision provider is configured */
  let ocrText = "";
  const visionCapable = candidates.some((c) => c.provider !== "ustad-core");
  const ocrProvider = available.find((p) => p.provider === "spaceocr");
  const { resolveAttachmentForProvider, attachmentAsDataUrl } = await import("./data.server");
  if (hasImages && ocrProvider && (ocrRequest || !visionCapable)) {
    for (const a of attachments.filter((x) => x.kind === "image")) {
      try {
        // Bug #1: OCR must receive a data URL, never a `storage:` identifier.
        const dataUrl = await attachmentAsDataUrl(a.data);
        ocrText += `\n[${a.name}]\n${await ocrImage(ocrProvider.config, dataUrl)}`;
      } catch (e) {
        throw new Error(
          e instanceof Error
            ? `OCR failed for ${a.name}: ${e.message}`
            : `OCR failed for ${a.name}`,
        );
      }
    }
  }

  /* build messages */
  const docContext = attachments
    .filter((a) => a.extracted_text)
    .map((a) => `Attached ${a.kind} "${a.name}":\n${a.extracted_text!.slice(0, 8000)}`)
    .join("\n\n");

  /* CURRICULUM BRAIN — ground teaching in verified board/session/class/subject.
   * Only runs when the request carries a curriculum signal; uses cache (no fetch)
   * so it never slows down or fabricates on every message. */
  let curriculumLine = "";
  let bookLine = "";
  try {
    const signal = detectCurriculumRequest(text);
    if (signal) {
      const resolution = await resolveCurriculumForUser(input.token, text, { allowFetch: true });
      curriculumLine = curriculumContextLine(contextOf(resolution));

      // PART 2 — if the user named a chapter, retrieve the verified book knowledge
      // and bring it into the AI context (only if verified; else it stays empty
      // and the AI never presents unconfirmed textbook content as official).
      if (signal.chapterNumber && resolution.kind === "verified") {
        const pack = await getChapterContextPack(input.token, text, signal.chapterNumber!);
        if (pack.verified && pack.prompt) bookLine = pack.prompt;
      }
    }
  } catch {
    curriculumLine = "";
  }

  const sys = systemPrompt({
    language: decision.language,
    decision,
    profile: profile ?? {},
    memories: [
      ...(memories ?? []).map((m) => m.content),
      ...(examFacts ? [examFacts] : []),
      ...(achievementFacts ? [achievementFacts] : []),
      ...(certificateFacts ? [certificateFacts] : []),
      ...(leaderboardFacts ? [leaderboardFacts] : []),
      ...(eventFacts ? [eventFacts] : []),
      ...(tournamentFacts ? [tournamentFacts] : []),

      ...(walletFacts ? [walletFacts] : []),
      ...(notificationFacts ? [notificationFacts] : []),
    ],
    goals: (goals ?? []).map((g) => g.title),
    chronoContext: chronoFacts,
    ...(curriculumLine ? { curriculumContext: curriculumLine } : {}),
    ...(bookLine ? { bookContext: bookLine } : {}),
    showSources,
    ...(webContext ? { webContext } : {}),
  });

  const messages: ChatMessage[] = [{ role: "system", content: sys }];
  for (const h of (history ?? []).slice().reverse()) {
    messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: h.content });
  }

  const chronoBlock = chrono?.handled
    ? `Chrono Engine computed result (authoritative — use it verbatim in your answer):\n${chrono.text}`
    : "";
  const userText = [text, chronoBlock, docContext, ocrText && `OCR text from images:\n${ocrText}`]
    .filter(Boolean)
    .join("\n\n");
  if (hasImages) {
    const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
    for (const a of attachments.filter((x) => x.kind === "image")) {
      // Bug #1: vision providers need a signed HTTPS or data: URL, never `storage:`.
      const url = await resolveAttachmentForProvider(a.data);
      imageParts.push({ type: "image_url", image_url: { url } });
    }
    messages.push({
      role: "user",
      content: [{ type: "text", text: userText || "Explain this image." }, ...imageParts],
    });
  } else {
    messages.push({ role: "user", content: userText });
  }

  let result: Awaited<ReturnType<typeof runChat>>;
  try {
    result = await runChat({ candidates, messages, maxTokens: decision.maxTokens });
  } catch (e) {
    // A chrono question is fully computed locally, so it must still be answerable
    // when every AI provider is unavailable.
    if (!chrono?.handled) throw e;
    result = {
      text: chrono.text,
      provider: "chrono-engine",
      model: "chrono",
      attempts: [],
      truncated: false,
      continuations: 0,
    };
  }

  /* memory intelligence */
  let memorySaved: string | undefined;
  const remember = text.match(/\b(?:remember|yaad rakho|note this)\b[:,]?\s*(.{4,200})/i);
  if (remember) {
    const content = remember[1]!.trim();
    await client
      .from("memories")
      .insert({ guest_id: guestId, content, source: "chat", kind: "fact" });
    memorySaved = content;
  } else {
    // Bug #15: structured LEARNING CONTEXT — only high-signal struggles,
    // never every conversation, never guessed sensitive facts.
    const struggle =
      /\b(samajh nahi|nahi samajh|confused|confus|galat|I keep getting|always get .* wrong|struggle|weak in)\b/i.test(
        text,
      );
    if (struggle && text.length >= 12) {
      const signal = `Weak concept: ${text.slice(0, 140)}`;
      const already = (memories ?? []).some((m) => m.content === signal);
      if (!already) {
        await client
          .from("memories")
          .insert({ guest_id: guestId, content: signal, source: "learning", kind: "learning" });
        memorySaved = signal;
      }
    }
  }

  /* reminder intelligence */
  let reminderCreated: string | undefined;
  if (decision.intent === "reminder") {
    const when = parseWhen(text);
    if (when) {
      const title =
        text
          .replace(/\b(remind me to|remind me|reminder)\b/i, "")
          .trim()
          .slice(0, 120) || "Reminder";
      await client.from("reminders").insert({
        guest_id: guestId,
        title,
        due_at: when.date.toISOString(),
        repeat_rule: detectRepeat(text),
        kind: "reminder",
      });
      reminderCreated = when.date.toISOString();
    }
  }

  /* persist */
  const { data: userMessage } = await client
    .from("messages")
    .insert({
      conversation_id: conversationId,
      guest_id: guestId,
      role: "user",
      content: text,
      attachments: attachments.map((a) => ({ id: a.id, name: a.name, mime: a.mime, kind: a.kind })),
    })
    .select()
    .single();

  const { data: assistantMessage } = await client
    .from("messages")
    .insert({
      conversation_id: conversationId,
      guest_id: guestId,
      role: "assistant",
      content: result.text,
      meta: {
        provider: result.provider,
        model: result.model,
        intent: decision.intent,
        complexity: decision.complexity,
        language: decision.language,
        sources,
        showSources,
        truncated: result.truncated,
        continuations: result.continuations,
        ...(chrono?.handled ? { chrono: chrono.kind } : {}),
      },
    })
    .select()
    .single();

  await client
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("guest_id", guestId);

  await client
    .from("attachments")
    .update({ conversation_id: conversationId })
    .eq("guest_id", guestId)
    .in("id", attachmentIds.length ? attachmentIds : ["00000000-0000-0000-0000-000000000000"]);

  return {
    conversationId,
    userMessage: (userMessage ?? null) as MessageRow | null,
    assistantMessage: (assistantMessage ?? null) as MessageRow | null,
    status: {
      intent: decision.intent,
      complexity: decision.complexity,
      language: decision.language,
      provider: result.provider,
      model: result.model,
      fallbackUsed: result.attempts.filter((a) => !a.ok).length > 0,
      sources,
      showSources,
      truncated: result.truncated,
      continuations: result.continuations,
      ...(chrono?.handled ? { chrono: chrono.kind } : {}),
      ...(memorySaved ? { memorySaved } : {}),
      ...(reminderCreated ? { reminderCreated } : {}),
      ...(curriculumLine ? { curriculum: curriculumLine } : {}),
    },
  };
}
