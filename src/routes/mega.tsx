import { prepareDeviceQuestions } from "@/lib/device-questions";
/**
 * USTAD AI MEGA TOURNAMENT — lobby + match screen (Part 2).
 *
 * Pure renderer of the authoritative server state (same contract as Part 1):
 * the client reports "question presented", polls the match for real-time
 * synchronisation and submits an option index. Membership, timers, scores,
 * ranking and the winner are all decided server-side.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Users,
  Ticket,
  Coins,
  Timer,
  Trophy,
  Lightbulb,
  Scissors,
  SkipForward,
  UserCheck,
} from "lucide-react";
import { toast } from "sonner";

import { AppShell, PageHeader } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useGuest } from "@/lib/ustad-client";
import {
  megaWalletFn,
  megaBuyPassFn,
  megaLobbyFn,
  megaLeaveLobbyFn,
  megaCreateMatchFn,
  megaMatchFn,
  megaPlayerStateFn,
  megaStartMatchFn,
  megaPresentedFn,
  megaAnswerFn,
  megaNextQuestionFn,
  megaLifelineFn,
} from "@/lib/mega.functions";
import {
  MEGA_HEARTBEAT_MS,
  MEGA_POLL_MS,
  formatDuration,
  type MegaEventView,
  type MegaLobbyPlayer,
  type MegaMatchView,
  type MegaPassView,
} from "@/lib/mega-spec";
import { formatCoins } from "@/lib/crorepati-spec";
import { clockLabel, secondsLeft, useServerClockOffset } from "@/lib/crorepati-clock";

export const Route = createFileRoute("/mega")({
  head: () => ({
    meta: [
      { title: "Mega Tournament — Weekly Multiplayer Quiz | USTAD AI" },
      {
        name: "description",
        content:
          "USTAD AI Mega Tournament: weekly pass, 2–4 player real-time matches, single-player 20-question run and USTAD Coin rewards.",
      },
      { property: "og:title", content: "Mega Tournament — USTAD AI" },
      {
        property: "og:description",
        content: "Compete live against other USTAD players or take on the 10-minute solo run.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MegaPage,
});

const LETTERS = ["A", "B", "C", "D"];

type LobbyState = {
  event: MegaEventView;
  eventOpen: boolean;
  pass: MegaPassView | null;
  balance: number;
  players: MegaLobbyPlayer[];
  activeMatchId: string | null;
  serverNow: string;
};

function MegaPage() {
  const { token, ready } = useGuest();
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [match, setMatch] = useState<MegaMatchView | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [serverNow, setServerNow] = useState<string | null>(null);
  const offsetRef = useServerClockOffset(serverNow);
  const presentedFor = useRef("");

  const matchId = match?.matchId ?? null;

  /* ---------- lobby heartbeat + presence ---------- */
  useEffect(() => {
    if (!ready || !token) return;
    let stopped = false;
    const beat = async () => {
      try {
        const res = (await megaLobbyFn({
          data: { token, state: matchId ? "in_match" : "available" },
        })) as unknown as LobbyState;
        if (stopped) return;
        setLobby(res);
        setServerNow(res.serverNow);
        if (res.activeMatchId && !matchId) void loadMatch(res.activeMatchId);
      } catch (e) {
        if (!stopped) toast.error((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void beat();
    const id = setInterval(() => void beat(), MEGA_HEARTBEAT_MS);
    const bye = () => void megaLeaveLobbyFn({ data: { token } }).catch(() => {});
    window.addEventListener("beforeunload", bye);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener("beforeunload", bye);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, token, matchId]);

  /* ---------- 4 Hz UI tick ---------- */
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  const applyMatch = useCallback((next: MegaMatchView) => {
    setMatch(next);
    setServerNow(next.timing.serverNow);
  }, []);

  const loadMatch = useCallback(
    async (id: string) => {
      if (!token) return;
      try {
        const next = (await megaMatchFn({
          data: { token, matchId: id },
        })) as unknown as MegaMatchView;
        applyMatch(next);
      } catch (e) {
        toast.error((e as Error).message);
        setMatch(null);
      }
    },
    [token, applyMatch],
  );

  /* ---------- real-time match polling (server is authoritative) ---------- */
  useEffect(() => {
    if (!token || !matchId) return;
    const id = setInterval(() => {
      if (match && (match.status === "completed" || match.status === "abandoned")) return;
      void loadMatch(matchId);
    }, MEGA_POLL_MS);
    return () => clearInterval(id);
  }, [token, matchId, match, loadMatch]);

  /* ---------- countdowns from server timestamps ---------- */
  const offset = offsetRef.current;
  const preLeft = useMemo(
    () => secondsLeft(match?.timing.answerTimerStartsAt ?? null, offset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [match?.timing.answerTimerStartsAt, offset, tick],
  );
  const questionLeft = useMemo(
    () => secondsLeft(match?.timing.questionDeadlineAt ?? null, offset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [match?.timing.questionDeadlineAt, offset, tick],
  );
  const soloLeft = useMemo(
    () => secondsLeft(match?.timing.soloDeadlineAt ?? null, offset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [match?.timing.soloDeadlineAt, offset, tick],
  );

  const solo = match?.mode === "solo";
  const resolved = Boolean(match?.questionResolved);
  const answered = match?.myAnswer != null;
  const inPreTimer = !solo && Boolean(match?.timing.answerTimerStartsAt) && preLeft > 0;
  const canAnswer = Boolean(
    match &&
    match.status === "active" &&
    match.question &&
    !answered &&
    !resolved &&
    (solo ? soloLeft > 0 : !inPreTimer && questionLeft > 0),
  );

  /* ---------- report presentation → arms the shared clock ---------- */
  const reportPresented = useCallback(async () => {
    if (!match || !token || match.status !== "active" || solo) return;
    const key = `${match.matchId}:${match.currentQuestion}`;
    if (presentedFor.current === key) return;
    presentedFor.current = key;
    try {
      const next = (await megaPresentedFn({
        data: { token, matchId: match.matchId, questionNumber: match.currentQuestion },
      })) as unknown as MegaMatchView;
      applyMatch(next);
    } catch {
      presentedFor.current = "";
    }
  }, [match, token, solo, applyMatch]);

  /* ---------- actions ---------- */
  const run = async (fn: () => Promise<MegaMatchView | void>) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await fn();
      if (next) applyMatch(next as MegaMatchView);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const buyPass = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const res = (await megaBuyPassFn({ data: { token } })) as unknown as {
        alreadyOwned: boolean;
      };
      toast.success(
        res.alreadyOwned ? "You already hold this week's pass." : "Weekly pass active!",
      );
      const w = (await megaWalletFn({ data: { token } })) as unknown as {
        balance: number;
        pass: MegaPassView | null;
      };
      setLobby((l) => (l ? { ...l, balance: w.balance, pass: w.pass } : l));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createMatch = (mode: "solo" | "multiplayer") =>
    run(async () => {
      if (!token) return;
      presentedFor.current = "";
      // BROWSER AI FIRST: build the questions on this device when possible.
      await prepareDeviceQuestions(token, "quiz", 20);
      return (await megaCreateMatchFn({
        data: { token, mode, ...(mode === "multiplayer" ? { playerIds: selected } : {}) },
      })) as unknown as MegaMatchView;
    });

  if (loading) {
    return (
      <AppShell>
        <PageHeader title="Mega Tournament" subtitle="Connecting to the arena…" />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  const ev = lobby?.event;
  const hasPass = Boolean(lobby?.pass?.valid);
  const inMatch = Boolean(match && match.status !== "completed" && match.status !== "abandoned");

  return (
    <AppShell>
      <PageHeader
        title="Mega Tournament"
        subtitle={
          ev
            ? `Weekly event · ${ev.questionCount} questions per match · 2–${ev.maxPlayers} players · solo run: ${ev.soloQuestionCount} questions in ${Math.round(ev.soloTotalSeconds / 60)} minutes, ${ev.soloRequiredCorrect}+ correct to win.`
            : "Weekly multiplayer and single-player quiz tournament."
        }
      />
      <div className="hide-scrollbar flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {/* wallet + pass */}
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
            <span className="flex items-center gap-1">
              <Coins className="size-4" /> {formatCoins(lobby?.balance ?? 0)} USTAD Coins
            </span>
            <span className="flex items-center gap-1">
              <Ticket className="size-4" />
              {hasPass ? "Weekly pass active — unlimited matches" : "No weekly pass"}
            </span>
            {!hasPass ? (
              <Button onClick={() => void buyPass()} disabled={busy || !lobby?.eventOpen}>
                Buy weekly pass · {formatCoins(ev?.passCost ?? 0)}
              </Button>
            ) : null}
          </div>

          {!inMatch ? (
            <>
              {/* lobby */}
              <div className="panel space-y-3 p-4">
                <p className="flex items-center gap-2 font-semibold">
                  <Users className="size-4" /> Live lobby
                </p>
                <p className="text-xs text-muted-foreground">
                  Select 1–{(ev?.maxPlayers ?? 4) - 1} players for a 2–{ev?.maxPlayers ?? 4} player
                  match. Only players present right now are shown.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(lobby?.players ?? [])
                    .filter((p) => !p.isSelf)
                    .map((p) => {
                      const picked = selected.includes(p.guestId);
                      const free = p.state === "available";
                      return (
                        <button
                          key={p.guestId}
                          type="button"
                          disabled={!free || !hasPass}
                          onClick={() =>
                            setSelected((s) =>
                              picked
                                ? s.filter((x) => x !== p.guestId)
                                : s.length >= (ev?.maxPlayers ?? 4) - 1
                                  ? s
                                  : [...s, p.guestId],
                            )
                          }
                          className={`flex min-h-12 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                            picked ? "border-primary bg-primary/10" : "border-border hover:bg-muted"
                          } disabled:opacity-50`}
                        >
                          <span className="min-w-0 truncate font-mono">{p.displayName}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {free ? (picked ? "selected" : "available") : p.state}
                          </span>
                        </button>
                      );
                    })}
                  {(lobby?.players ?? []).filter((p) => !p.isSelf).length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No other players in the lobby right now. You can still play the single-player
                      tournament.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void createMatch("multiplayer")}
                    disabled={busy || !hasPass || selected.length === 0}
                    className="min-h-11"
                  >
                    Create {selected.length + 1}-player match
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void createMatch("solo")}
                    disabled={busy || !hasPass}
                    className="min-h-11"
                  >
                    Play single player
                  </Button>
                </div>
              </div>

              {match?.result ? <ResultPanel result={match.result} /> : null}
            </>
          ) : null}

          {/* match */}
          {match && inMatch ? (
            <>
              {match.status !== "active" ? (
                <ReadyRoom
                  match={match}
                  busy={busy}
                  onReady={() =>
                    void run(async () =>
                      token
                        ? ((await megaPlayerStateFn({
                            data: { token, matchId: match.matchId, state: "ready" },
                          })) as unknown as MegaMatchView)
                        : undefined,
                    )
                  }
                  onLeave={() =>
                    void run(async () => {
                      if (!token) return;
                      await megaPlayerStateFn({
                        data: { token, matchId: match.matchId, state: "left" },
                      });
                      setMatch(null);
                      setSelected([]);
                    })
                  }
                  onStart={() =>
                    void run(async () =>
                      token
                        ? ((await megaStartMatchFn({
                            data: { token, matchId: match.matchId },
                          })) as unknown as MegaMatchView)
                        : undefined,
                    )
                  }
                />
              ) : null}

              {match.status === "active" && match.question ? (
                <>
                  <div className="panel flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                    <span className="font-semibold">
                      Question {match.currentQuestion} / {match.questionCount}
                    </span>
                    <span className="text-muted-foreground">{match.question.category}</span>
                    <span
                      aria-live="polite"
                      className={`flex items-center gap-1 rounded-lg px-2 py-1 font-mono tabular-nums ${
                        (solo ? soloLeft : questionLeft) <= 10
                          ? "bg-destructive/15 text-destructive"
                          : "bg-muted"
                      }`}
                    >
                      <Timer className="size-4" />
                      {solo
                        ? clockLabel(soloLeft)
                        : inPreTimer
                          ? `Get Ready… ${preLeft}`
                          : clockLabel(questionLeft)}
                    </span>
                  </div>

                  <div
                    key={`${match.matchId}:${match.currentQuestion}`}
                    className="panel kbc-question-anim space-y-4 p-4 md:p-6"
                  >
                    <p className="text-xs tracking-widest text-muted-foreground uppercase">
                      {match.question.difficulty}
                    </p>
                    <h2 className="text-base leading-relaxed font-semibold break-words md:text-lg">
                      {match.question.question}
                    </h2>

                    <div className="grid gap-2 sm:grid-cols-2">
                      {match.question.options.map((opt, i) => {
                        const removed = match.question!.removedOptions.includes(i);
                        const isCorrect = resolved && match.question!.correctIndex === i;
                        const isMineWrong = resolved && match.myAnswer === i && !isCorrect;
                        const isMine = !resolved && match.myAnswer === i;
                        return (
                          <button
                            key={i}
                            type="button"
                            disabled={removed || !canAnswer || busy}
                            aria-label={`Option ${LETTERS[i]}: ${opt}`}
                            onClick={() =>
                              void run(async () =>
                                token
                                  ? ((await megaAnswerFn({
                                      data: {
                                        token,
                                        matchId: match.matchId,
                                        questionNumber: match.currentQuestion,
                                        optionIndex: i,
                                      },
                                    })) as unknown as MegaMatchView)
                                  : undefined,
                              )
                            }
                            className={`kbc-option-anim flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-3 text-left text-sm transition-colors ${
                              isCorrect
                                ? "border-success bg-success/15"
                                : isMineWrong
                                  ? "border-destructive bg-destructive/15"
                                  : isMine
                                    ? "border-primary bg-primary/10"
                                    : removed
                                      ? "border-border/40 opacity-30"
                                      : "border-border hover:bg-muted disabled:opacity-60"
                            }`}
                            style={{ animationDelay: `${0.15 + i * 0.1}s` }}
                            onAnimationEnd={() => {
                              if (i === match.question!.options.length - 1) void reportPresented();
                            }}
                          >
                            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold">
                              {LETTERS[i]}
                            </span>
                            <span className="min-w-0 break-words">{removed ? "—" : opt}</span>
                          </button>
                        );
                      })}
                    </div>

                    {match.question.hint ? (
                      <p className="rounded-lg bg-muted p-3 text-sm">
                        <Lightbulb className="mr-1 inline size-4" /> {match.question.hint}
                      </p>
                    ) : null}

                    {resolved ? (
                      <div className="space-y-3 rounded-lg bg-muted p-3 text-sm">
                        <p className="font-semibold">
                          {match.myAnswer != null && match.myAnswer === match.question.correctIndex
                            ? "Correct! 🎉"
                            : "Not your question."}
                        </p>
                        {match.question.explanation ? <p>{match.question.explanation}</p> : null}
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              if (!token) return;
                              presentedFor.current = "";
                              return (await megaNextQuestionFn({
                                data: { token, matchId: match.matchId },
                              })) as unknown as MegaMatchView;
                            })
                          }
                        >
                          {match.currentQuestion >= match.questionCount
                            ? "Finish match"
                            : "Next question"}
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  {/* lifelines — the same Crorepati set, no new power-ups */}
                  <div className="panel flex flex-wrap gap-2 p-3">
                    {(
                      [
                        ["fifty", "50-50", Scissors],
                        ["hint", "Hint", Lightbulb],
                        ["skip", "Skip", SkipForward],
                      ] as const
                    ).map(([kind, label, Icon]) => {
                      const me = match.players.find((p) => p.isSelf);
                      const used =
                        kind === "fifty"
                          ? me?.lifelines.fiftyFiftyUsed
                          : kind === "hint"
                            ? me?.lifelines.hintUsed
                            : me?.lifelines.skipUsed;
                      return (
                        <Button
                          key={kind}
                          variant="outline"
                          className="min-h-11"
                          disabled={Boolean(used) || !canAnswer || busy}
                          onClick={() =>
                            void run(async () =>
                              token
                                ? ((await megaLifelineFn({
                                    data: { token, matchId: match.matchId, lifeline: kind },
                                  })) as unknown as MegaMatchView)
                                : undefined,
                            )
                          }
                        >
                          <Icon className="mr-1 size-4" /> {label}
                        </Button>
                      );
                    })}
                  </div>

                  <PlayerStrip match={match} />
                </>
              ) : null}
            </>
          ) : null}

          {match?.result && !inMatch ? null : null}
        </div>
      </div>
    </AppShell>
  );
}

function ReadyRoom({
  match,
  busy,
  onReady,
  onLeave,
  onStart,
}: {
  match: MegaMatchView;
  busy: boolean;
  onReady: () => void;
  onLeave: () => void;
  onStart: () => void;
}) {
  const me = match.players.find((p) => p.isSelf);
  const isHost = Boolean(me?.isHost);
  const readyCount = match.players.filter((p) => p.state === "ready").length;
  return (
    <div className="panel space-y-3 p-4">
      <p className="flex items-center gap-2 font-semibold">
        <UserCheck className="size-4" />
        {match.mode === "solo"
          ? "Single-player run"
          : `Match lobby · ${match.players.length} players`}
      </p>
      <ul className="space-y-1 text-sm">
        {match.players.map((p) => (
          <li key={p.guestId} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono">
              {p.displayName}
              {p.isHost ? " · host" : ""}
              {p.isSelf ? " (you)" : ""}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground capitalize">{p.state}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {!isHost && me?.state !== "ready" ? (
          <Button onClick={onReady} disabled={busy} className="min-h-11">
            I&apos;m ready
          </Button>
        ) : null}
        {isHost ? (
          <Button onClick={onStart} disabled={busy} className="min-h-11">
            Start match ({readyCount} ready)
          </Button>
        ) : null}
        <Button variant="outline" onClick={onLeave} disabled={busy} className="min-h-11">
          Leave
        </Button>
      </div>
    </div>
  );
}

function PlayerStrip({ match }: { match: MegaMatchView }) {
  return (
    <div className="panel grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
      {match.players.map((p) => (
        <div key={p.guestId} className="rounded-lg bg-muted/60 p-2 text-sm">
          <p className="truncate font-mono text-xs">
            {p.displayName}
            {p.isSelf ? " (you)" : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {p.correctCount} correct · {p.answerStatus}
          </p>
        </div>
      ))}
    </div>
  );
}

function ResultPanel({ result }: { result: NonNullable<MegaMatchView["result"]> }) {
  return (
    <div className="panel space-y-3 p-4">
      <p className="flex items-center gap-2 font-semibold">
        <Trophy className="size-4" /> Final standings · {result.outcome} ·{" "}
        {formatDuration(result.durationMs)}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground uppercase">
              <th className="py-1">Rank</th>
              <th>Player</th>
              <th>Correct</th>
              <th>Score</th>
              <th>Coins</th>
            </tr>
          </thead>
          <tbody>
            {result.standings.map((s) => (
              <tr key={s.guestId} className={s.isWinner ? "font-semibold text-success" : ""}>
                <td className="py-1">#{s.rank}</td>
                <td className="font-mono text-xs">{s.displayName}</td>
                <td>{s.correctCount}</td>
                <td>{s.score}</td>
                <td>{formatCoins(s.coinsAwarded)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.tieBreakReason ? (
        <p className="text-xs text-muted-foreground">{result.tieBreakReason}</p>
      ) : null}
    </div>
  );
}
