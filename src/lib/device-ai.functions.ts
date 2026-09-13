/**
 * BROWSER AI FIRST for question generation.
 *
 * The client asks for the exact prompts the server would have sent
 * (`deviceQuestionPlanFn`), runs them through its own browser AI model pool,
 * and hands the raw JSON back (`deviceQuestionSubmitFn`). The next game start
 * consumes those batches inside the existing generators, where they are parsed,
 * validated and fact-checked exactly like provider output. Nothing about the
 * game rules, scoring, UI or API Manager fallback changes.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireGuest } from "./guest.server";
import { quizDevicePlan } from "./crorepati-ai.server";
import { tournamentDevicePlan } from "./tournament-ai.server";
import { storeDeviceBatches, isDeviceTask, type DeviceTask } from "./device-batches.server";
import type { Language } from "./router.server";

type PlanInput = { token: string; task: string; count?: number };

export const deviceQuestionPlanFn = createServerFn({ method: "POST" })
  .inputValidator((d: PlanInput) => d)
  .handler(async ({ data: d }) => {
    const guestId = await requireGuest(d.token);
    if (!isDeviceTask(d.task)) return { system: "", batches: [] };
    const task: DeviceTask = d.task;
    const count = Math.min(20, Math.max(1, Math.floor(Number(d.count) || 10)));

    const { guestLocale } = await import("./notification.server");
    const language = (await guestLocale(guestId)).language as Language;
    const seed = Math.floor(Math.random() * 1_000_000);

    if (task === "quiz") {
      return quizDevicePlan({ language, avoid: [], seed, count });
    }
    return tournamentDevicePlan({
      kind: task === "mystery" ? "mystery" : "god",
      language,
      avoid: [],
      seed,
      count,
    });
  });

export const deviceQuestionSubmitFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; task: string; batches: string[] }) => d)
  .handler(async ({ data: d }) => {
    const guestId = await requireGuest(d.token);
    if (!isDeviceTask(d.task)) return { stored: 0 };
    const stored = await storeDeviceBatches(
      guestId,
      d.task,
      Array.isArray(d.batches) ? d.batches.map((b) => String(b ?? "")) : [],
    );
    return { stored };
  });
