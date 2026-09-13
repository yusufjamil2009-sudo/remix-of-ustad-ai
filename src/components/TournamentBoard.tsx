import { prepareDeviceQuestions } from "@/lib/device-questions";
/**
 * Shared renderer for the two weekly tournaments (Mystery + Psychology, GOD
 * MASTER). It renders EXACTLY what the server sends: the server owns the
 * questions, the score, the locks, the coins and the result. The score stays
 * hidden until the final question, because the server does not send it.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Coins, Loader2, Lock, ShieldCheck, Sparkles, Ticket, Trophy } from "lucide-react";
import { toast } from "sonner";

import { AppShell, PageHeader } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useGuest } from "@/lib/ustad-client";
import {
  tournamentStateFn,
  tournamentStartFn,
  tournamentAnswerFn,
  tournamentLeaderboardFn,
} from "@/lib/tournament.functions";
import { formatIndianCoins, stringsFor, type TournamentKind } from "@/lib/tournament-spec";

type State = Awaited<ReturnType<typeof tournamentStateFn>>;
type Ranks = Awaited<ReturnType<typeof tournamentLeaderboardFn>>;

export function TournamentBoard({ kind, intro }: { kind: TournamentKind; intro: string }) {
  const { token } = useGuest();
  const [state, setState] = useState<State | null>(null);
  const [ranks, setRanks] = useState<Ranks>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [view, board] = await Promise.all([
        tournamentStateFn({ data: { token, kind } }),
        tournamentLeaderboardFn({ data: { token, kind } }).catch(() => [] as Ranks),
      ]);
      setState(view);
      setRanks(board);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the tournament.");
    } finally {
      setLoading(false);
    }
  }, [token, kind]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const t = stringsFor(state?.language ?? "english");

  const start = useCallback(async () => {
    if (!token || busy) return;
    setBusy(true);
    try {
      // BROWSER AI FIRST: build the cases on this device when possible.
      await prepareDeviceQuestions(token, kind === "god" ? "god" : "mystery", 20);
      const view = await tournamentStartFn({ data: { token, kind } });
      setState(view);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the tournament.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [token, kind, busy, refresh]);

  const lockAnswer = useCallback(async () => {
    const q = state?.attempt?.question;
    if (!token || !state?.attempt || !q || choice === null || busy) return;
    setBusy(true);
    try {
      const view = await tournamentAnswerFn({
        data: {
          token,
          attemptId: state.attempt.attemptId,
          position: q.position,
          optionIndex: choice,
        },
      });
      setChoice(null);
      setState(view);
      if (!view.attempt && view.lastResult) void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your answer.");
    } finally {
      setBusy(false);
    }
  }, [token, state, choice, busy, refresh]);

  const question = state?.attempt?.question ?? null;
  const result = state?.lastResult ?? null;

  return (
    <AppShell>
      <PageHeader title={state?.title ?? "USTAD Tournament"} subtitle={intro} />

      <div className="w-full min-w-0 flex-1 space-y-6 px-4 py-5 md:px-8">
        {loading ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
          </p>
        ) : !state ? (
          <p className="text-muted-foreground">Tournament unavailable right now.</p>
        ) : (
          <>
            {/* ---- Wallet / entry summary ---- */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                icon={<Coins className="size-4 text-amber-400" />}
                label={t.balance}
                value={`🪙 ${formatIndianCoins(state.balance)}`}
              />
              <Stat
                icon={<Sparkles className="size-4 text-primary" />}
                label={t.entryFee}
                value={`🪙 ${formatIndianCoins(state.entryFee)}`}
              />
              <Stat
                icon={<Trophy className="size-4 text-amber-300" />}
                label={t.reward}
                value={`🪙 ${formatIndianCoins(state.winReward)}`}
              />
              {state.requiresTicket ? (
                <Stat
                  icon={<Ticket className="size-4 text-emerald-300" />}
                  label={t.tickets}
                  value={String(state.tickets)}
                />
              ) : (
                <Stat
                  icon={<ShieldCheck className="size-4 text-emerald-300" />}
                  label="Status"
                  value={state.badge}
                />
              )}
            </div>

            {/* ---- Active question ---- */}
            {question ? (
              <section className="rounded-2xl border border-border/60 bg-card/60 p-4 md:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span>
                    {t.question} {question.position} /{" "}
                    {state.attempt?.questionCount ?? state.questionCount}
                  </span>
                  <span>{t.hiddenScore}</span>
                </div>

                {question.caseTitle ? (
                  <h2 className="mt-3 text-lg font-semibold">{question.caseTitle}</h2>
                ) : null}
                {question.story ? (
                  <p className="mt-2 leading-relaxed whitespace-pre-line">{question.story}</p>
                ) : null}

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {question.suspects && question.suspects.length ? (
                    <Panel title={t.suspects} items={question.suspects} />
                  ) : null}
                  {question.clues && question.clues.length ? (
                    <Panel title={t.clues} items={question.clues} />
                  ) : null}
                  {question.timeline && question.timeline.length ? (
                    <Panel title={t.timeline} items={question.timeline} />
                  ) : null}
                </div>

                <p className="mt-5 font-medium">{question.prompt}</p>
                <div className="mt-3 grid gap-2">
                  {question.options.map((opt, i) => (
                    <button
                      key={i}
                      data-testid={`tournament-option-${i}`}
                      onClick={() => setChoice(i)}
                      className={`rounded-xl border px-4 py-3 text-left text-sm transition ${
                        choice === i
                          ? "border-primary bg-primary/15"
                          : "border-border/60 hover:border-primary/50"
                      }`}
                    >
                      <span className="mr-2 font-semibold text-primary">
                        {String.fromCharCode(65 + i)}.
                      </span>
                      {opt}
                    </button>
                  ))}
                </div>

                <Button
                  className="mt-4 w-full sm:w-auto"
                  disabled={choice === null || busy}
                  onClick={lockAnswer}
                  data-testid="tournament-lock"
                >
                  {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                  {t.lockAnswer}
                </Button>
              </section>
            ) : (
              /* ---- Entry / lock card ---- */
              <section className="rounded-2xl border border-border/60 bg-card/60 p-4 md:p-6">
                {state.lock === "open" ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {state.questionCount} {kind === "mystery" ? "cases" : "questions"} ·{" "}
                      {state.requiredCorrect}/{state.questionCount} to win
                    </p>
                    <Button
                      className="mt-4"
                      onClick={start}
                      disabled={busy}
                      data-testid="tournament-start"
                    >
                      {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                      {busy ? t.starting : t.start}
                    </Button>
                  </>
                ) : (
                  <p className="flex items-center gap-2 text-sm">
                    <Lock className="size-4 text-muted-foreground" aria-hidden />
                    {state.lockMessage}
                  </p>
                )}
                {state.requiresTicket && state.tickets < 1 ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    <Link to="/shop" className="text-primary underline">
                      {t.buyTicket}
                    </Link>{" "}
                    — 🪙 {formatIndianCoins(state.ticketPrice)}
                  </p>
                ) : null}
              </section>
            )}

            {/* ---- Result + full review ---- */}
            {!question && result ? (
              <section
                data-testid="tournament-result"
                className="rounded-2xl border border-border/60 bg-card/60 p-4 md:p-6"
              >
                <h2 className="text-lg font-semibold">
                  {result.result === "WIN" ? `🏆 ${t.won}` : t.lost}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {result.correctCount}/{result.questionCount} · {result.requiredCorrect} needed
                  {result.coinsAwarded ? ` · 🪙 ${formatIndianCoins(result.coinsAwarded)}` : ""}
                </p>
                {result.certificateUrl ? (
                  <p className="mt-2 text-sm">
                    {t.certificate}:{" "}
                    <a className="text-primary underline" href={result.certificateUrl}>
                      {result.certificateUrl}
                    </a>
                  </p>
                ) : null}

                <h3 className="mt-5 font-medium">{t.review}</h3>
                <ol className="mt-2 space-y-3">
                  {result.review.map((r) => (
                    <li key={r.position} className="rounded-xl border border-border/50 p-3 text-sm">
                      <p className="font-medium">
                        {r.position}. {r.caseTitle ? `${r.caseTitle} — ` : ""}
                        {r.prompt}
                      </p>
                      <p className={r.isCorrect ? "mt-1 text-emerald-400" : "mt-1 text-red-400"}>
                        {t.yourAnswer}:{" "}
                        {r.selectedIndex === null ? "—" : r.options[r.selectedIndex]}
                      </p>
                      <p className="mt-1 text-emerald-300">
                        {t.correct}: {r.options[r.correctIndex]}
                      </p>
                      {r.explanation ? (
                        <p className="mt-1 text-muted-foreground">
                          {t.explanation}: {r.explanation}
                        </p>
                      ) : null}
                      {r.solution && r.solution !== r.explanation ? (
                        <p className="mt-1 whitespace-pre-line text-muted-foreground">
                          {t.solution}: {r.solution}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {/* ---- Verified ranking ---- */}
            {ranks.length ? (
              <section className="rounded-2xl border border-border/60 bg-card/60 p-4 md:p-6">
                <h2 className="font-semibold">{t.leaderboard}</h2>
                <ul className="mt-3 space-y-1 text-sm">
                  {ranks.map((r) => (
                    <li
                      key={r.guestId}
                      className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1 ${
                        r.isSelf ? "bg-primary/10" : ""
                      }`}
                    >
                      <span className="truncate">
                        #{r.rank} {r.displayName} · {r.title}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {r.wins} win{r.wins === 1 ? "" : "s"} · best {r.bestCorrect}/20
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function Panel({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-border/50 p-3">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
