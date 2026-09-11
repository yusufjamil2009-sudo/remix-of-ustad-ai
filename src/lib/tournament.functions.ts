/**
 * Weekly tournaments — server function boundary.
 * Thin validators only; every rule lives in `tournament-engine.server.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import * as engine from "./tournament-engine.server";
import type { TournamentKind } from "./tournament-spec";

const kindOf = (k: unknown): TournamentKind => (k === "god" ? "god" : "mystery");

export const tournamentStateFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; kind: string }) => d)
  .handler(async ({ data: d }) => engine.tournamentState({ token: d.token, kind: kindOf(d.kind) }));

export const tournamentStartFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; kind: string }) => d)
  .handler(async ({ data: d }) => engine.startTournament({ token: d.token, kind: kindOf(d.kind) }));

export const tournamentAnswerFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { token: string; attemptId: string; position: number; optionIndex: number }) => d,
  )
  .handler(async ({ data: d }) =>
    engine.answerTournament({
      token: d.token,
      attemptId: d.attemptId,
      position: Number(d.position),
      optionIndex: Number(d.optionIndex),
    }),
  );

export const tournamentReviewFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; attemptId: string }) => d)
  .handler(async ({ data: d }) =>
    engine.tournamentReview({ token: d.token, attemptId: d.attemptId }),
  );

export const tournamentLeaderboardFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; kind: string }) => d)
  .handler(async ({ data: d }) =>
    engine.tournamentLeaderboard({ token: d.token, kind: kindOf(d.kind) }),
  );

export const tournamentTicketsFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => engine.ticketBalance(await requireId(d.token)));

export const buyGodTicketFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => engine.buyGodTicket(d.token));

async function requireId(token: unknown): Promise<string> {
  const { requireGuest } = await import("./guest.server");
  return requireGuest(token);
}
