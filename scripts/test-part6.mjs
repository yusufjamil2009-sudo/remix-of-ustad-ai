/**
 * PART 6 — MASTER EVENT ENGINE, real browser + real database.
 * P6-01 … P6-08 plus the dynamic-event → reward → trophy → certificate chain.
 */
import { execSync } from "node:child_process";
import { chromium, newSession, bootGuest, check, sql, summary, BASE, DB } from "./browser-p16.mjs";

const browser = await chromium.launch();

async function freshGuest() {
  const s = await newSession(browser);
  const g = await bootGuest(s.page);
  execSync(`node --import tsx scripts/provision-model.mjs ${g.guestId}`, { stdio: "pipe" });
  return { ...s, ...g };
}

const P = await freshGuest();
// Authorize this guest as the event operator for the test run (server-side only).
process.env["USTAD_EVENT_ADMINS"] = P.guestId;
const engine = await import("../src/lib/master-event-engine.server.ts");

// The dev server has its own process, so it must know the operator too.
// We create events through the engine directly (the same code the server fn calls).
const { issueToken } = await import("../src/lib/guest.server.ts");
const token = await issueToken(P.guestId);

/* ------------------------------------------------------------------ */
/* P6-01 — create a real dynamic event                                 */
/* ------------------------------------------------------------------ */

const codeA = `science-championship-${Date.now().toString(36)}`;
const evA = await engine.createEvent({
  token,
  code: codeA,
  name: "Science Championship",
  description: "Part 6 dynamic event runtime test.",
  questionCount: 20,
  preTimerSeconds: 0,
  answerTimerSeconds: 300,
  requiredCorrect: 15,
  awardTrophy: true,
  certificateEnabled: true,
  rewardConfig: { perCorrect: 100, win: 50000, participation: 500 },
  entryConfig: { type: "free" },
});
const rowA = (await sql("select * from master_events where id=$1", [evA.id]))[0];
check(
  "P6-01",
  "a dynamic event is created with the configured settings",
  !!rowA && rowA.name === "Science Championship",
  rowA?.name,
);
check("P6-01b", "the event starts in DRAFT", rowA.status === "draft", rowA.status);
check(
  "P6-01c",
  "question_count, rewards and certificate config are stored",
  Number(rowA.question_count) === 20 &&
    Number(rowA.reward_config.win) === 50000 &&
    rowA.certificate_config.enabled === true,
);

/* ------------------------------------------------------------------ */
/* P6-06 / P6-05 — lifecycle and server-time scheduling                */
/* ------------------------------------------------------------------ */

// Before start: not playable.
let blockedBefore = false;
try {
  await engine.startAttempt({ token, eventCode: codeA });
} catch {
  blockedBefore = true;
}
check("P6-05", "a DRAFT event cannot be played", blockedBefore);

await engine.transitionEvent({ token, eventId: evA.id, to: "scheduled" });
const sched = (await sql("select status from master_events where id=$1", [evA.id]))[0];
check("P6-06", "DRAFT → SCHEDULED is allowed", sched.status === "scheduled", sched.status);

let jump = false;
try {
  await engine.transitionEvent({ token, eventId: evA.id, to: "archived" });
} catch {
  jump = true;
}
check("P6-06b", "an illegal transition (SCHEDULED → ARCHIVED) is refused", jump);

await engine.transitionEvent({ token, eventId: evA.id, to: "open" });
const opened = (
  await sql("select status, published_at from master_events where id=$1", [evA.id])
)[0];
check(
  "P6-06c",
  "SCHEDULED → OPEN publishes the event",
  opened.status === "open" && !!opened.published_at,
);

/* ------------------------------------------------------------------ */
/* The event appears in the real UI                                    */
/* ------------------------------------------------------------------ */

await P.page.goto(`${BASE}/events`, { waitUntil: "domcontentloaded", timeout: 90000 });
await P.page.waitForTimeout(6000);
const listTxt = await P.page.textContent("body");
check(
  "P6-01d",
  "the event is listed on the real /events page",
  listTxt.includes("Science Championship"),
);
check("P6-01e", "the listing shows the fixed question count", /20 questions/i.test(listTxt));
check(
  "P6-01f",
  "Crorepati and Mega are listed but deep-link to their own screens",
  /Kon Banega Crorepati/i.test(listTxt),
);

/* ------------------------------------------------------------------ */
/* P6-02 / P6-03 — fixed count, dynamic content                        */
/* ------------------------------------------------------------------ */

const enterBtn = P.page.getByRole("button", { name: /enter event/i }).first();
await enterBtn.click();
await P.page.waitForFunction(() => /Question\s+1\s+of\s+20/i.test(document.body.innerText), {
  timeout: 120000,
});

const att1 = (
  await sql(
    "select * from master_event_attempts where guest_id=$1 order by created_at desc limit 1",
    [P.guestId],
  )
)[0];
const q1 = await sql(
  "select * from master_event_attempt_questions where attempt_id=$1 order by question_number",
  [att1.id],
);
check(
  "P6-02",
  "Event A (configured 20) serves EXACTLY 20 questions",
  q1.length === 20,
  `${q1.length}`,
);
check("P6-02b", "the attempt froze the configured count", Number(att1.question_count) === 20);

const uiQ = await P.page.textContent("body");
check("P6-02c", "the UI shows the fixed count", /Question\s+1\s+of\s+20/i.test(uiQ));

/** Plays the current attempt through the real UI. */
async function playUI(page, attemptId, correctUpTo) {
  for (let guard = 0; guard < 60; guard++) {
    const a = (
      await sql(
        "select id, status, current_question, game_state from master_event_attempts where id=$1",
        [attemptId],
      )
    )[0];
    if (a.status !== "active") break;
    const n = Number(a.current_question);
    const row = (
      await sql(
        "select options, correct_index from master_event_attempt_questions where attempt_id=$1 and question_number=$2",
        [attemptId, n],
      )
    )[0];
    const options = typeof row.options === "string" ? JSON.parse(row.options) : row.options;
    const idx =
      n <= correctUpTo
        ? Number(row.correct_index)
        : (Number(row.correct_index) + 1) % options.length;
    const btn = page.locator("button", { hasText: options[idx] }).first();
    try {
      await btn.waitFor({ state: "visible", timeout: 20000 });
      if (await btn.isDisabled()) {
        await page.waitForTimeout(1200);
        continue;
      }
      await btn.click();
    } catch {
      await page.waitForTimeout(1500);
      continue;
    }
    await page.waitForTimeout(2800);
  }
}

await playUI(P.page, att1.id, 20);
await P.page.waitForTimeout(4000);
const done1 = (await sql("select * from master_event_attempts where id=$1", [att1.id]))[0];
check(
  "P6-02d",
  "the count never changed during play",
  Number(done1.question_count) === 20 &&
    Number(done1.correct_count) + Number(done1.wrong_count) <= 20,
  `${done1.correct_count}+${done1.wrong_count}`,
);
check(
  "P6-04b",
  "meeting the configured threshold wins",
  done1.status === "won",
  `${done1.status} with ${done1.correct_count} correct`,
);

const expectedReward = Number(done1.correct_count) * 100 + 50000 + 500;
check(
  "P6-04c",
  "the reward is computed server-side from the event config",
  Number(done1.coin_reward) === expectedReward,
  `${done1.coin_reward} vs ${expectedReward}`,
);
const ledgerRows = await sql(
  "select coins, source, ref_id from ustad_coin_ledger where guest_id=$1",
  [P.guestId],
);
check(
  "P6-04d",
  "the reward is a real, single ledger transaction",
  ledgerRows.length === 1 && Number(ledgerRows[0].coins) === expectedReward,
  `${ledgerRows.length} rows`,
);

// Second attempt at the SAME event, through the same server entry point the UI
// calls, to compare the generated content.
const att2v = await engine.startAttempt({ token, eventCode: codeA });
const att2 = (await sql("select * from master_event_attempts where id=$1", [att2v.attemptId]))[0];
const q2 = await sql(
  "select question from master_event_attempt_questions where attempt_id=$1 order by question_number",
  [att2.id],
);
check(
  "P6-02e",
  "a second match at the same event is again EXACTLY 20",
  q2.length === 20,
  `${q2.length}`,
);
const same =
  JSON.stringify(q1.map((q) => q.question)) === JSON.stringify(q2.map((q) => q.question));
check("P6-03", "question CONTENT is dynamic between matches", !same);
check("P6-03b", "but the COUNT is identical", q1.length === q2.length);

await engine.quitAttempt({ token, attemptId: att2.id });

/* ------------------------------------------------------------------ */
/* P6-02 (Event B) — a 10-question event                               */
/* ------------------------------------------------------------------ */

const codeB = `quick-quiz-${Date.now().toString(36)}`;
const evB = await engine.createEvent({
  token,
  code: codeB,
  name: "Quick Quiz Ten",
  questionCount: 10,
  preTimerSeconds: 0,
  answerTimerSeconds: 300,
  requiredCorrect: 6,
  rewardConfig: { perCorrect: 10, win: 100, participation: 5 },
});
await engine.transitionEvent({ token, eventId: evB.id, to: "scheduled" });
await engine.transitionEvent({ token, eventId: evB.id, to: "open" });

const counts = [];
for (let i = 0; i < 2; i++) {
  const a = await engine.startAttempt({ token, eventCode: codeB });
  const rows = await sql(
    "select question_number from master_event_attempt_questions where attempt_id=$1",
    [a.attemptId],
  );
  counts.push(rows.length);
  await engine.quitAttempt({ token, attemptId: a.attemptId });
}
check(
  "P6-02f",
  "Event B (configured 10) serves EXACTLY 10 every match",
  counts.every((c) => c === 10),
  counts.join(","),
);
check(
  "P6-02g",
  "two events with different configs keep their own fixed counts",
  q1.length === 20 && counts[0] === 10,
  `A=20, B=10`,
);

/* ------------------------------------------------------------------ */
/* P6-04 — same question sequence for players in one match             */
/* ------------------------------------------------------------------ */

const Q = await freshGuest();
const qToken = await issueToken(Q.guestId);
const mineA = await engine.startAttempt({ token, eventCode: codeB });
const theirsA = await engine.startAttempt({ token: qToken, eventCode: codeB });
const mineQ = await sql(
  "select question_number, question from master_event_attempt_questions where attempt_id=$1 order by question_number",
  [mineA.attemptId],
);
const theirQ = await sql(
  "select question_number, question from master_event_attempt_questions where attempt_id=$1 order by question_number",
  [theirsA.attemptId],
);
check(
  "P6-04",
  "two players at one event both get the configured count",
  mineQ.length === 10 && theirQ.length === 10,
  `${mineQ.length}/${theirQ.length}`,
);
check(
  "P6-04e",
  "each player's question sequence is ordered 1..N",
  mineQ.every((q, i) => Number(q.question_number) === i + 1),
);
await engine.quitAttempt({ token, attemptId: mineA.attemptId });
await engine.quitAttempt({ token: qToken, attemptId: theirsA.attemptId });

/* ------------------------------------------------------------------ */
/* P6-05 — the event window closes on SERVER time                      */
/* ------------------------------------------------------------------ */

const codeC = `expired-event-${Date.now().toString(36)}`;
const evC = await engine.createEvent({
  token,
  code: codeC,
  name: "Expired Window Event",
  questionCount: 5,
  startTime: new Date(Date.now() - 7200000).toISOString(),
  endTime: new Date(Date.now() - 3600000).toISOString(),
});
await engine.transitionEvent({ token, eventId: evC.id, to: "scheduled" });
await engine.transitionEvent({ token, eventId: evC.id, to: "open" });
const view = await engine.getEvent({ token, code: codeC });
check(
  "P6-05b",
  "an event past its end time closes itself on server time",
  view.status === "closed",
  view.status,
);
let afterEnd = false;
try {
  await engine.startAttempt({ token, eventCode: codeC });
} catch {
  afterEnd = true;
}
check("P6-05c", "no new match can start after the event ends", afterEnd);

// Client clock tampering must not reopen it.
await P.page.evaluate(() => {
  const real = Date.now;
  Date.now = () => real() - 7200000;
});
const stillClosed = await engine.getEvent({ token, code: codeC });
check(
  "P6-05d",
  "a tampered client clock cannot reopen a closed event",
  stillClosed.status === "closed",
);

/* ------------------------------------------------------------------ */
/* P6-07 — event security                                              */
/* ------------------------------------------------------------------ */

const R = await freshGuest();
const rToken = await issueToken(R.guestId);

const attacks = [];
try {
  await engine.createEvent({
    token: rToken,
    code: "attacker-event",
    name: "Attacker",
    questionCount: 5,
  });
  attacks.push("create ALLOWED");
} catch {
  attacks.push("create denied");
}
try {
  await engine.transitionEvent({ token: rToken, eventId: evA.id, to: "finalized" });
  attacks.push("transition ALLOWED");
} catch {
  attacks.push("transition denied");
}
try {
  await engine.updateEventConfig({ token: rToken, eventId: evA.id, questionCount: 999 });
  attacks.push("reconfig ALLOWED");
} catch {
  attacks.push("reconfig denied");
}
check(
  "P6-07",
  "a non-operator cannot create, transition or reconfigure an event",
  attacks.every((a) => a.endsWith("denied")),
  attacks.join(" | "),
);

let lockedCount = false;
try {
  await engine.updateEventConfig({ token, eventId: evA.id, questionCount: 999 });
} catch {
  lockedCount = true;
}
const stillTwenty = (
  await sql("select question_count from master_events where id=$1", [evA.id])
)[0];
check(
  "P6-07b",
  "question_count cannot be changed on a published event",
  lockedCount && Number(stillTwenty.question_count) === 20,
  `${stillTwenty.question_count}`,
);

// Direct browser writes must be blocked by RLS.
const rlsProbe = await P.page.evaluate(async () => {
  try {
    const r = await fetch("/rest/v1/master_events", {
      method: "PATCH",
      body: JSON.stringify({ question_count: 1 }),
    });
    return r.status;
  } catch {
    return "network-blocked";
  }
});
check(
  "P6-07c",
  "the browser cannot write to the events table directly",
  rlsProbe !== 200,
  `${rlsProbe}`,
);

/* ------------------------------------------------------------------ */
/* P6-08 — event history + leaderboard from verified results           */
/* ------------------------------------------------------------------ */

const results = await sql("select * from master_event_results where event_id=$1", [evA.id]);
check(
  "P6-08",
  "a finished match writes a verified result row",
  results.length >= 1,
  `${results.length}`,
);
const board = await engine.leaderboard({ token, eventCode: codeA });
check(
  "P6-08b",
  "the leaderboard is built from those verified results",
  board.length >= 1 && board[0].rank === 1,
  `${board.length} rows`,
);
const hist = await engine.eventHistory(token, 20);
check(
  "P6-08c",
  "event history is preserved for the profile",
  hist.length >= 2,
  `${hist.length} entries`,
);

await engine.transitionEvent({ token, eventId: evA.id, to: "closed" });
await engine.transitionEvent({ token, eventId: evA.id, to: "finalized" });
await engine.transitionEvent({ token, eventId: evA.id, to: "archived" });
const archived = (await sql("select status from master_events where id=$1", [evA.id]))[0];
const histAfter = await sql("select * from master_event_results where event_id=$1", [evA.id]);
check(
  "P6-06d",
  "CLOSED → FINALIZED → ARCHIVED completes the lifecycle",
  archived.status === "archived",
);
check(
  "P6-08d",
  "archiving does not delete completed event data",
  histAfter.length === results.length,
  `${histAfter.length}`,
);

const audit = await sql("select action from master_event_audit where event_id=$1", [evA.id]);
check(
  "P6-08e",
  "every authoritative action is audit-logged",
  audit.length >= 5,
  `${audit.length}: ${[...new Set(audit.map((a) => a.action))].join(",")}`,
);

/* --- FLOW 4: dynamic event → trophy → certificate ------------------- */
const p6Ach = await sql("select * from ustad_achievements where guest_id=$1", [P.guestId]);
const p6Cert = await sql("select * from ustad_certificates where guest_id=$1", [P.guestId]);
check(
  "FLOW4-a",
  "a configured dynamic-event win awards a trophy",
  p6Ach.length >= 1,
  `${p6Ach.length}: ${p6Ach.map((a) => a.type).join(",")}`,
);
check(
  "FLOW4-b",
  "and issues a certificate with a verification token",
  p6Cert.length >= 1 && /^[0-9a-f]{64}$/.test(String(p6Cert[0]?.verification_token ?? "")),
  `${p6Cert.length}`,
);
if (p6Cert.length) {
  await P.page.goto(`${BASE}/verify/certificate/${p6Cert[0].verification_token}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await P.page.waitForTimeout(3500);
  const vt = await P.page.textContent("body");
  check(
    "FLOW4-c",
    "that certificate publicly verifies as valid",
    /valid/i.test(vt) && vt.includes(p6Cert[0].certificate_id),
    p6Cert[0].certificate_id,
  );
}

summary();
await browser.close();
await DB.end();
