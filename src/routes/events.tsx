import { prepareDeviceQuestions } from "@/lib/device-questions";
/**
 * USTAD EVENTS — master event hub + dynamic event player (Part 6).
 *
 * One screen for every event in USTAD AI:
 *   • Crorepati and Mega events are LISTED here but deep-link to their own
 *     screens, so Part 1 and Part 2 rules stay entirely in their own engines.
 *   • Dynamic events are played here.
 *
 * The client is a renderer. It shows the server's question count, renders the
 * server's deadlines with the existing clock helpers, and submits an option
 * index. Score, reward, timing and result are all decided on the server.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CalendarClock, Coins, Loader2, Medal, Timer, Trophy, Users } from "lucide-react";
import { toast } from "sonner";

import { AppShell, PageHeader } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useGuest } from "@/lib/ustad-client";
import {
  masterEventsFn,
  masterEventStartFn,
  masterEventAttemptFn,
  masterEventBeginFn,
  masterEventAnswerFn,
  masterEventQuitFn,
  masterEventLeaderboardFn,
} from "@/lib/master-event.functions";
import { clockLabel, secondsLeft, useServerClockOffset } from "@/lib/crorepati-clock";

export const Route = createFileRoute("/events")({
  head: () => ({
    meta: [
      { title: "USTAD Events — Quiz Tournaments | USTAD AI" },
      {
        name: "description",
        content:
          "Every USTAD AI quiz event in one place: Kon Banega Crorepati, Mega tournaments and dynamic events with fixed question counts and fresh AI questions.",
      },
      { property: "og:title", content: "USTAD Events — USTAD AI" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: EventsPage,
});

const LETTERS = ["A", "B", "C", "D"];

type EventView = Awaited<ReturnType<typeof masterEventsFn>>[number];
type AttemptView = Awaited<ReturnType<typeof masterEventStartFn>>;
type BoardRow = Awaited<ReturnType<typeof masterEventLeaderboardFn>>[number];
type Reveal = { correctIndex: number; chosen: number; explanation: string } | null;

function statusTone(status: string): string {
  if (status === "active" || status === "open") return "bg-emerald-500/15 text-emerald-300";
  if (status === "scheduled") return "bg-amber-500/15 text-amber-300";
  if (status === "cancelled") return "bg-red-500/15 text-red-300";
  return "bg-muted text-muted-foreground";
}

function EventsPage() {
  const { session } = useGuest();
  const token = session?.token ?? "";

  const [events, setEvents] = useState<EventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<Reveal>(null);

  const offsetRef = useServerClockOffset(attempt?.serverNow ?? events[0]?.serverNow);
  const offset = offsetRef.current;

  // One shared 250ms tick drives the countdown re-render (no second timer engine).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!attempt || attempt.status !== "active") return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [attempt]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const list = await masterEventsFn({ data: { token } });
      setEvents(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load events.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadBoard = useCallback(
    async (code: string) => {
      if (!token) return;
      try {
        setBoard(await masterEventLeaderboardFn({ data: { token, code, limit: 10 } }));
        setOpenCode(code);
      } catch {
        setBoard([]);
      }
    },
    [token],
  );

  const start = useCallback(
    async (code: string) => {
      if (!token || busy) return;
      setBusy(true);
      try {
        // A stable key so a double click or a retry resumes rather than restarts.
        const view = await masterEventStartFn({
          data: { token, code, idempotencyKey: `start:${code}:${token.slice(0, 12)}` },
        });
        setAttempt(view);
        setReveal(null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not start this event.");
      } finally {
        setBusy(false);
      }
    },
    [token, busy],
  );

  // Arm the answering window once the pre-timer has elapsed on the server clock.
  useEffect(() => {
    if (!attempt || attempt.status !== "active" || attempt.gameState !== "QUESTION_INTRO") return;
    const left = secondsLeft(attempt.answerTimerStartsAt, offset);
    const t = setTimeout(
      () => {
        void (async () => {
          try {
            setAttempt(await masterEventBeginFn({ data: { token, attemptId: attempt.attemptId } }));
          } catch {
            /* the next poll recovers */
          }
        })();
      },
      Math.max(0, left * 1000),
    );
    return () => clearTimeout(t);
  }, [attempt, offset, token]);

  // Reconnect / refresh safety: re-read the authoritative attempt periodically.
  useEffect(() => {
    if (!attempt || attempt.status !== "active") return;
    const id = setInterval(() => {
      void (async () => {
        try {
          const fresh = await masterEventAttemptFn({
            data: { token, attemptId: attempt.attemptId },
          });
          if (fresh) setAttempt(fresh);
        } catch {
          /* offline — keep showing the last known state */
        }
      })();
    }, 15000);
    return () => clearInterval(id);
  }, [attempt, token]);

  const answer = useCallback(
    async (index: number) => {
      if (!attempt?.question || busy || reveal) return;
      setBusy(true);
      try {
        const res = await masterEventAnswerFn({
          data: {
            token,
            attemptId: attempt.attemptId,
            questionNumber: attempt.question.questionNumber,
            chosenIndex: index,
          },
        });
        if (!res.accepted) {
          setAttempt(res.attempt);
          toast.message("That answer was not accepted.");
          return;
        }
        setReveal({ correctIndex: res.correctIndex, chosen: index, explanation: res.explanation });
        setTimeout(() => {
          setReveal(null);
          setAttempt(res.attempt);
          if (res.attempt.status !== "active") void load();
        }, 2200);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not submit that answer.");
      } finally {
        setBusy(false);
      }
    },
    [attempt, busy, reveal, token, load],
  );

  const quit = useCallback(async () => {
    if (!attempt) return;
    try {
      setAttempt(await masterEventQuitFn({ data: { token, attemptId: attempt.attemptId } }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not leave the event.");
    }
  }, [attempt, token]);

  const answerLeft = useMemo(
    () => (attempt?.gameState === "ANSWERING" ? secondsLeft(attempt.deadlineAt, offset) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attempt, offset, tick],
  );
  const introLeft = useMemo(
    () =>
      attempt?.gameState === "QUESTION_INTRO"
        ? secondsLeft(attempt.answerTimerStartsAt, offset)
        : 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attempt, offset, tick],
  );

  /* ---------------------------------------------------------------- */
  /* Active dynamic event                                              */
  /* ---------------------------------------------------------------- */

  if (attempt && attempt.status === "active") {
    const q = attempt.question;
    return (
      <AppShell>
        <PageHeader title={attempt.eventName} subtitle="Live event" />
        <div className="mx-auto w-full max-w-3xl px-4 pb-24">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card/60 p-3">
            <span className="text-sm font-medium">
              Question {attempt.currentQuestion} of {attempt.questionCount}
            </span>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Trophy className="size-4" /> {attempt.correctCount} correct
            </span>
            <span className="flex items-center gap-2 font-mono text-sm">
              <Timer className="size-4" />
              {attempt.gameState === "ANSWERING"
                ? clockLabel(answerLeft)
                : `Starts in ${introLeft}s`}
            </span>
          </div>

          {q ? (
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="mb-1 text-xs tracking-wide text-muted-foreground uppercase">
                {q.category} · {q.difficulty}
              </p>
              <h2 className="mb-5 text-lg leading-snug font-medium">{q.question}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {q.options.map((opt, i) => {
                  const isCorrect = reveal && i === reveal.correctIndex;
                  const isWrong = reveal && i === reveal.chosen && i !== reveal.correctIndex;
                  return (
                    <button
                      key={`${q.questionNumber}-${i}`}
                      type="button"
                      disabled={busy || !!reveal || attempt.gameState !== "ANSWERING"}
                      onClick={() => void answer(i)}
                      className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition disabled:opacity-70 ${
                        isCorrect
                          ? "border-emerald-500 bg-emerald-500/15"
                          : isWrong
                            ? "border-red-500 bg-red-500/15"
                            : "border-border bg-background hover:border-primary/60"
                      }`}
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold">
                        {LETTERS[i]}
                      </span>
                      <span>{opt}</span>
                    </button>
                  );
                })}
              </div>
              {reveal?.explanation ? (
                <p className="mt-4 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
                  {reveal.explanation}
                </p>
              ) : q.hint ? (
                <p className="mt-4 text-xs text-muted-foreground">Hint: {q.hint}</p>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Preparing the next question…
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => void quit()}>
              Leave event
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Finished attempt                                                  */
  /* ---------------------------------------------------------------- */

  if (attempt && attempt.status !== "active") {
    const won = attempt.status === "won";
    return (
      <AppShell>
        <PageHeader title={attempt.eventName} subtitle="Result" />
        <div className="mx-auto w-full max-w-md px-4 pb-24">
          <div className="rounded-2xl border border-border bg-card p-6 text-center">
            <div className="mb-3 text-4xl">{won ? "🏅" : "🎯"}</div>
            <h2 className="mb-1 text-xl font-semibold">{won ? "You won!" : "Event finished"}</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {attempt.correctCount} of {attempt.questionCount} correct
            </p>
            <p className="mb-6 flex items-center justify-center gap-2 text-sm">
              <Coins className="size-4 text-amber-400" />
              {attempt.coinReward.toLocaleString("en-IN")} USTAD Coins
            </p>
            <div className="flex flex-col gap-2">
              <Button onClick={() => void loadBoard(attempt.eventCode)}>View leaderboard</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setAttempt(null);
                  void load();
                }}
              >
                Back to events
              </Button>
            </div>
          </div>
          {openCode === attempt.eventCode && board.length > 0 ? <Leaderboard rows={board} /> : null}
        </div>
      </AppShell>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Event list                                                        */
  /* ---------------------------------------------------------------- */

  return (
    <AppShell>
      <PageHeader
        title="USTAD Events"
        subtitle="Every quiz event in one place — fixed question counts, always-fresh questions."
      />
      <div className="mx-auto w-full max-w-3xl px-4 pb-24">
        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading events…
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No events are scheduled right now. Check back soon.
          </div>
        ) : (
          <div className="grid gap-4">
            {events.map((e) => (
              <div key={e.id} className="rounded-2xl border border-border bg-card p-5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{e.name}</h3>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] uppercase ${statusTone(e.status)}`}
                  >
                    {e.status}
                  </span>
                </div>
                {e.description ? (
                  <p className="mb-3 text-sm text-muted-foreground">{e.description}</p>
                ) : null}
                <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Medal className="size-3.5" /> {e.questionCount} questions
                  </span>
                  <span className="flex items-center gap-1">
                    <Timer className="size-3.5" /> {e.answerTimerSeconds}s per question
                  </span>
                  {e.multiplayerEnabled ? (
                    <span className="flex items-center gap-1">
                      <Users className="size-3.5" /> {e.minPlayers}–{e.maxPlayers} players
                    </span>
                  ) : null}
                  {e.startTime ? (
                    <span className="flex items-center gap-1">
                      <CalendarClock className="size-3.5" />
                      {new Date(e.startTime).toLocaleString("en-IN")}
                    </span>
                  ) : null}
                  <span className="flex items-center gap-1">
                    <Coins className="size-3.5" /> {e.rewardSummary}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {e.eventType === "crorepati" ? (
                    <Button asChild size="sm">
                      <Link to="/crorepati">Play on the Crorepati screen</Link>
                    </Button>
                  ) : e.eventType === "mega" ? (
                    <Button asChild size="sm">
                      <Link to="/mega">Play on the Mega screen</Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={
                        busy || Boolean(e.locked) || !(e.status === "open" || e.status === "active")
                      }
                      onClick={() => void start(e.code)}
                    >
                      {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      {e.locked
                        ? e.lockKind === "won"
                          ? "Won · locked"
                          : "Played today"
                        : e.status === "open" || e.status === "active"
                          ? "Enter event"
                          : "Not open yet"}
                    </Button>
                  )}
                  {e.leaderboardEnabled ? (
                    <Button variant="ghost" size="sm" onClick={() => void loadBoard(e.code)}>
                      Leaderboard
                    </Button>
                  ) : null}
                </div>
                {e.locked && e.lockReason ? (
                  <p className="mt-2 text-[12px] text-muted-foreground">{e.lockReason}</p>
                ) : null}
                {openCode === e.code ? <Leaderboard rows={board} /> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Leaderboard({ rows }: { rows: BoardRow[] }) {
  if (rows.length === 0) {
    return <p className="mt-4 text-xs text-muted-foreground">No verified results yet.</p>;
  }
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-border">
      {rows.map((r) => (
        <div
          key={`${r.rank}-${r.guestId}`}
          className={`flex items-center gap-3 px-3 py-2 text-sm ${r.isYou ? "bg-primary/10" : ""}`}
        >
          <span className="w-6 text-right font-mono text-xs text-muted-foreground">{r.rank}</span>
          <span className="flex-1 truncate">{r.displayName}</span>
          <span className="text-xs text-muted-foreground">{r.correctCount} correct</span>
          <span className="font-mono text-xs">{r.score}</span>
        </div>
      ))}
    </div>
  );
}
