import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send,
  Plus,
  Paperclip,
  Camera,
  Mic,
  Trash2,
  Pin,
  Globe,
  Loader2,
  X,
  History,
  Image as ImageIcon,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Markdown } from "@/components/Markdown";
import { MessageActions } from "@/components/MessageActions";
import { CameraCapture } from "@/components/CameraCapture";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useGuest } from "@/lib/ustad-client";
import { useSettings } from "@/lib/settings-store";
import { useGreeting } from "@/hooks/useGreeting";
import { useOnline } from "@/hooks/usePwa";
import { UstadLogo } from "@/components/UstadLogo";
import { setClassroomHandoff } from "@/lib/classroom-handoff";
import { answerToLessonContent } from "@/lib/answer-to-lesson";
import { localTimeZone } from "@/lib/chrono-engine";
import { speakMessage, stopSpeaking } from "@/lib/tts";
import {
  listConversationsFn,
  createConversationFn,
  deleteConversationFn,
  updateConversationFn,
  listMessagesFn,
  sendMessageFn,
  uploadAttachmentFn,
  beginDirectUploadFn,
  finalizeDirectUploadFn,
  insertRowFn,
  transcribeFn,
} from "@/lib/ustad-api";
import { hasDeviceAi, runDeviceText } from "@/lib/browser-ai";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "USTAD AI — Guest AI Tutor, Chat, Exams & Notes" },
      {
        name: "description",
        content:
          "USTAD AI is a login-free AI tutor: multi-provider chat, web search, voice, exam generator, smart notes and memory. Developer by Yusuf Ali.",
      },
      { property: "og:title", content: "USTAD AI — Guest AI Tutor" },
      {
        property: "og:description",
        content: "Login-free AI tutor with multi-provider routing, exams, notes, memory and voice.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ChatPage,
});

type Conversation = { id: string; title: string; pinned: boolean; updated_at: string };
type Message = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  attachments?: Array<{
    id: string;
    name: string;
    mime?: string;
    kind?: string;
    previewUrl?: string;
  }>;
  meta?: {
    provider?: string;
    model?: string;
    intent?: string;
    showSources?: boolean;
    sources?: Array<{ title: string; url: string }>;
  } | null;
};
type Pending = { id: string; name: string; kind: string; previewUrl?: string };

const MAX_BYTES = 8 * 1024 * 1024;
/** Bug #20: above this, PUT raw bytes to a signed slot — never a huge data URL. */
const DIRECT_THRESHOLD = 256 * 1024;
const ACCEPTED =
  /^(image\/(png|jpeg|jpg|webp|gif)|application\/pdf|text\/plain|text\/markdown|text\/csv|application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))$/;

function guessMime(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext] ?? "application/octet-stream";
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function uploadViaDataUrl(token: string, file: File, mime: string) {
  const dataUrl = await fileToDataUrl(file);
  return uploadAttachmentFn({
    data: { token, file: { name: file.name, mime, size: file.size, dataUrl } },
  });
}

/** Large files go File → signed PUT → storage → DB. Small files keep the data-URL path. */
async function uploadOneFile(token: string, file: File, mime: string) {
  if (file.size > DIRECT_THRESHOLD) {
    try {
      const slot = (await beginDirectUploadFn({
        data: { token, file: { name: file.name, mime, size: file.size } },
      })) as { id: string; uploadUrl: string };
      const put = await fetch(slot.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": mime, "x-upsert": "true" },
      });
      if (!put.ok) throw new Error(`Direct upload failed (${put.status}).`);
      return finalizeDirectUploadFn({ data: { token, id: slot.id } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/not a valid|too large|unsupported/i.test(msg)) throw e;
      // Storage / CORS / unprovisioned bucket — documented data-URL fallback.
    }
  }
  return uploadViaDataUrl(token, file, mime);
}

function ChatPage() {
  const { token } = useGuest();
  const { settings } = useSettings();
  const greeting = useGreeting();
  const online = useOnline();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [showList, setShowList] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [revealSources, setRevealSources] = useState<Record<string, boolean>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const refreshConversations = useCallback(async () => {
    if (!token) return;
    try {
      const rows = (await listConversationsFn({ data: { token } })) as unknown as Conversation[];
      setConversations(rows);
    } catch {
      /* listing failure must never break the chat */
    }
  }, [token]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    if (!token || !activeId) return;
    let alive = true;
    void listMessagesFn({ data: { token, conversationId: activeId } })
      .then((rows) => alive && setMessages(rows as unknown as Message[]))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [token, activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  useEffect(() => () => stopSpeaking(), []);

  /* ---------- one shared attachment pipeline (file picker + camera) ---------- */
  const attachFiles = useCallback(
    async (files: File[]) => {
      if (!token || files.length === 0) return;
      setUploading(true);
      try {
        for (const file of files.slice(0, 4)) {
          const mime = guessMime(file);
          if (!ACCEPTED.test(mime)) {
            toast.error(`${file.name}: this file type is not supported.`);
            continue;
          }
          if (file.size > MAX_BYTES) {
            toast.error(`${file.name} is larger than 8 MB.`);
            continue;
          }
          try {
            const dataUrl = await fileToDataUrl(file);
            const saved = (await uploadAttachmentFn({
              data: { token, file: { name: file.name, mime, size: file.size, dataUrl } },
            })) as unknown as Pending;
            const entry: Pending = { id: saved.id, name: file.name, kind: saved.kind ?? "file" };
            if (mime.startsWith("image/")) entry.previewUrl = URL.createObjectURL(file);
            setPending((p) => [...p, entry]);
          } catch (e) {
            toast.error((e as Error).message || `Could not attach ${file.name}`);
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [token],
  );

  const removePending = (id: string) => {
    setPending((list) => {
      const target = list.find((x) => x.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return list.filter((x) => x.id !== id);
    });
  };

  const send = async () => {
    if (!token || busy) return;
    const text = input.trim();
    if (!text && pending.length === 0) return;
    setBusy(true);
    setStatus("Thinking…");
    setInput("");
    const attachmentIds = pending.map((p) => p.id);
    pending.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    setPending([]);
    setMessages((m) => [
      ...m,
      {
        id: `temp-${Date.now()}`,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      },
    ]);
    try {
      const base = {
        token,
        text,
        ...(activeId ? { conversationId: activeId } : {}),
        attachmentIds,
        clientNow: new Date().toISOString(),
        timeZone: localTimeZone(),
      };
      /* ROUTING — on-device AI models first (every compatible one, in order),
       * and only if all of them fail the existing API Manager path runs. */
      let res: Awaited<ReturnType<typeof sendMessageFn>>;
      if (await hasDeviceAi()) {
        const planned = await sendMessageFn({ data: { ...base, plan: true } });
        const plan = planned.plan;
        const device = plan
          ? await runDeviceText({
              system: plan.system,
              user: plan.messages
                .filter((m) => m.role !== "system")
                .map((m) => `${m.role === "assistant" ? "ASSISTANT" : "USER"}: ${m.content}`)
                .join("\n\n"),
            })
          : null;
        if (device) setStatus(`${device.engineLabel} · answering…`);
        res = await sendMessageFn({
          data: {
            ...base,
            conversationId: planned.conversationId,
            ...(device ? { deviceText: device.text, deviceEngine: device.engineId } : {}),
          },
        });
      } else {
        res = await sendMessageFn({ data: base });
      }

      setActiveId(res.conversationId);
      const rows = (await listMessagesFn({
        data: { token, conversationId: res.conversationId },
      })) as unknown as Message[];
      setMessages(rows);
      setStatus(
        `${res.status.provider} · ${res.status.model} · ${res.status.intent}` +
          (res.status.continuations ? ` · continued ×${res.status.continuations}` : ""),
      );
      if (res.status.memorySaved) toast.success("Saved to memory");
      if (res.status.reminderCreated) toast.success("Reminder created");
      // Honest truncation reporting — never silently return half an answer.
      if (res.status.truncated) {
        toast.warning(
          "Response reached this model's real output limit. Ask 'continue' for the rest.",
        );
      }
      // Bug 38: auto_speak is authoritative for chat answers.
      if (settings?.auto_speak) {
        const last = [...rows].reverse().find((m) => m.role === "assistant");
        if (last) speakMessage(last.id, last.content);
      }
      void refreshConversations();
    } catch (e) {
      toast.error((e as Error).message);
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const questionFor = (index: number) => {
    for (let i = index - 1; i >= 0; i--)
      if (messages[i]!.role === "user") return messages[i]!.content;
    return "";
  };

  const saveToNotes = async (m: Message, question: string) => {
    const stamp = new Date(m.created_at).toLocaleString();
    await insertRowFn({
      data: {
        token,
        table: "notes",
        values: {
          title: (question || m.content).replace(/\s+/g, " ").slice(0, 70) || "USTAD answer",
          content: `**Question:** ${question || "—"}\n\n${m.content}\n\n_Saved from chat on ${stamp}_`,
          source: "chat",
        },
      },
    });
    toast.success("Saved to Notes");
  };

  const teachIn3D = (m: Message, question: string) => {
    const topic = (question || "USTAD answer").slice(0, 70);
    setClassroomHandoff({
      topic,
      content: answerToLessonContent(question, m.content),
      autoplay: true,
    });
    toast.success("Opening this answer in the 2D Classroom…");
    void navigate({ to: "/classroom" });
  };

  const newChat = async () => {
    stopSpeaking();
    setActiveId(null);
    setMessages([]);
    setInput("");
    setPending([]);
    setStatus("");
    setShowList(false);
    void refreshConversations();
  };

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        try {
          const dataUrl = await fileToDataUrl(new File([blob], "voice.webm", { type: blob.type }));
          const res = await transcribeFn({
            data: { token, base64: dataUrl.split(",")[1] ?? "", mime: blob.type },
          });
          setInput((v) => (v ? `${v} ${res.text}` : res.text));
        } catch (e) {
          const msg = (e as Error).message || "";
          toast.error(
            /no speech-to-text provider/i.test(msg)
              ? "Voice input is unavailable on this browser. You can type your doubt."
              : msg || "Voice input is unavailable on this browser. You can type your doubt.",
          );
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      toast.error("Microphone permission is required for voice input.");
    }
  };

  return (
    <AppShell>
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* conversation history */}
        <div
          className={`${showList ? "flex" : "hidden"} absolute inset-0 z-20 flex-col bg-background p-3 lg:static lg:z-0 lg:flex lg:w-64 lg:border-r lg:border-border`}
        >
          <div className="flex items-center gap-2">
            <Button className="flex-1" onClick={() => void newChat()}>
              <Plus className="size-4" /> New chat
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setShowList(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
          <p className="mt-3 flex items-center gap-1 px-1 text-[10px] tracking-widest text-muted-foreground uppercase">
            <History className="size-3" /> Chat history
          </p>
          <div className="hide-scrollbar mt-1 flex-1 space-y-1 overflow-y-auto">
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`group flex items-center gap-1 rounded-lg px-2 py-2 text-sm ${
                  activeId === c.id ? "bg-surface-2" : "hover:bg-surface"
                }`}
              >
                <button
                  className="flex-1 truncate text-left"
                  onClick={() => {
                    stopSpeaking();
                    setActiveId(c.id);
                    setShowList(false);
                  }}
                >
                  {c.pinned ? "📌 " : ""}
                  {c.title}
                </button>
                <button
                  aria-label="Pin chat"
                  onClick={async () => {
                    await updateConversationFn({ data: { token, id: c.id, pinned: !c.pinned } });
                    void refreshConversations();
                  }}
                >
                  <Pin className="size-3.5 text-muted-foreground" />
                </button>
                <button
                  aria-label="Delete chat"
                  onClick={async () => {
                    await deleteConversationFn({ data: { token, id: c.id } });
                    if (activeId === c.id) {
                      setActiveId(null);
                      setMessages([]);
                    }
                    void refreshConversations();
                  }}
                >
                  <Trash2 className="size-3.5 text-destructive" />
                </button>
              </div>
            ))}
            {conversations.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">No chats yet.</p>
            ) : null}
          </div>
        </div>

        {/* chat area */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 md:px-4">
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="lg:hidden"
                onClick={() => setShowList(true)}
              >
                <History className="mr-1 size-4" /> History
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void newChat()}>
                <Plus className="mr-1 size-4" /> New chat
              </Button>
            </div>
            {/*
             * min-w-0 is what makes `truncate` actually able to truncate here.
             * A flex item's default min-width:auto refuses to shrink below its
             * content width, and this line is nowrap, so once the status grows
             * from "USTAD AI is ready." to "<provider> · <model> · <intent>" it
             * forced the header — and with it the whole page — wider than the
             * mobile viewport.
             */}
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {status || "USTAD AI is ready."}
            </p>
          </div>

          {online ? null : (
            <div
              role="status"
              className="border-b border-border bg-card/70 px-3 py-2 text-center text-xs text-muted-foreground md:px-8"
            >
              You are offline — saved pages still open, but AI replies need a connection.
            </div>
          )}

          <div className="hide-scrollbar flex-1 space-y-4 overflow-y-auto px-3 py-6 md:px-8">
            {messages.length === 0 ? (
              <div className="mx-auto max-w-xl py-14 text-center">
                <UstadLogo className="mx-auto mb-4 size-16 sm:size-20 md:size-24" priority />
                <h1 className="font-display text-lg font-bold tracking-[0.18em] uppercase gold-text sm:text-xl">
                  Welcome to USTAD AI
                </h1>
                <p
                  className="mt-2 text-xl font-semibold break-words text-foreground sm:text-2xl"
                  aria-live="polite"
                >
                  {greeting.text}{" "}
                  <span aria-hidden="true" className="text-[0.9em]">
                    {greeting.emoji}
                  </span>
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Kuch bhi poocho — padhai, coding, web se latest info, image samajhna, ya exam
                  banwana.
                </p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  {[
                    "Aaj ki date aur time kya hai?",
                    "Aaj ki taza tech news dhoondo",
                    "Photosynthesis Hinglish me samjhao",
                    "2 weeks baad kya date hogi?",
                  ].map((s) => (
                    <button
                      key={s}
                      onClick={() => setInput(s)}
                      className="panel px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((m, index) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[min(46rem,92%)] rounded-2xl px-4 py-3 ${
                    m.role === "user" ? "bg-primary text-primary-foreground" : "panel"
                  }`}
                >
                  {m.attachments?.length ? (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {m.attachments.map((a) =>
                        a.previewUrl ? (
                          <img
                            key={a.id}
                            src={a.previewUrl}
                            alt={a.name}
                            className="max-h-40 max-w-full rounded-lg object-contain"
                          />
                        ) : (
                          <span
                            key={a.id}
                            className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-xs"
                          >
                            <FileText className="size-3" />
                            {a.name}
                          </span>
                        ),
                      )}
                    </div>
                  ) : null}
                  {m.role === "user" ? (
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  ) : (
                    <>
                      <Markdown content={m.content} />
                      {(m.meta?.showSources || revealSources[m.id]) && m.meta?.sources?.length ? (
                        <div className="mt-3 space-y-1 border-t border-border pt-2">
                          <p className="flex items-center gap-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                            <Globe className="size-3" /> Sources
                          </p>
                          {m.meta.sources.slice(0, 5).map((s) => (
                            <a
                              key={s.url}
                              href={s.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block truncate text-xs text-accent hover:underline"
                            >
                              {s.title || s.url}
                            </a>
                          ))}
                        </div>
                      ) : null}
                      <MessageActions
                        message={m}
                        question={questionFor(index)}
                        onSaveNote={() => saveToNotes(m, questionFor(index))}
                        onTeachIn3D={() => teachIn3D(m, questionFor(index))}
                        onShowSources={() => setRevealSources((r) => ({ ...r, [m.id]: true }))}
                        hasSources={Boolean(m.meta?.sources?.length)}
                      />
                      {m.meta?.provider ? (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {m.meta.provider} · {m.meta.model}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ))}

            {busy ? (
              <div className="flex gap-1 px-2">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="typing-dot size-2 rounded-full bg-primary"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>

          {/* composer */}
          <div className="border-t border-border px-3 py-3 md:px-8">
            {pending.length ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {pending.map((p) => (
                  <span
                    key={p.id}
                    className="flex items-center gap-2 rounded-full bg-surface-2 px-2 py-1 text-xs"
                  >
                    {p.previewUrl ? (
                      <img
                        src={p.previewUrl}
                        alt={p.name}
                        className="size-7 rounded-full object-cover"
                      />
                    ) : p.kind === "pdf" ? (
                      <FileText className="size-3.5" />
                    ) : (
                      <ImageIcon className="size-3.5" />
                    )}
                    <span className="max-w-40 truncate">{p.name}</span>
                    <button
                      type="button"
                      onClick={() => removePending(p.id)}
                      aria-label={`Remove ${p.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="panel flex items-end gap-1 p-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.md,.csv,.doc,.docx"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void attachFiles(files);
                }}
              />
              <input
                ref={galleryRef}
                type="file"
                multiple
                className="hidden"
                accept="image/*"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void attachFiles(files);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={uploading}
                onClick={(e) => {
                  e.preventDefault();
                  galleryRef.current?.click();
                }}
                aria-label="Add photo from gallery"
              >
                <ImageIcon className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={uploading}
                onClick={(e) => {
                  e.preventDefault();
                  fileRef.current?.click();
                }}
                aria-label="Attach file"
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Paperclip className="size-4" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.preventDefault();
                  setCameraOpen(true);
                }}
                aria-label="Open camera"
              >
                <Camera className="size-4" />
              </Button>
              <Button
                type="button"
                variant={recording ? "destructive" : "ghost"}
                size="icon"
                onClick={() => void toggleRecording()}
                aria-label="Voice input"
              >
                <Mic className="size-4" />
              </Button>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="USTAD se kuch bhi poocho…"
                className="max-h-40 min-h-11 flex-1 resize-none border-0 bg-transparent focus-visible:ring-0"
              />
              <Button
                type="button"
                onClick={() => void send()}
                disabled={busy}
                size="icon"
                aria-label="Send"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </Button>
            </div>
            <p className="mt-2 text-center text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
              Developer by Yusuf Ali
            </p>
          </div>
        </div>
      </div>

      <CameraCapture
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(file) => void attachFiles([file])}
      />
    </AppShell>
  );
}
