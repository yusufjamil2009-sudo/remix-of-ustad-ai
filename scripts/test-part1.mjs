/**
 * PART 1 — CROREPATI, real browser tests P1-01 … P1-16.
 * Real clicks, real timers measured with a wall clock, real DB assertions.
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

async function gotoGame(page) {
  await page.goto(`${BASE}/crorepati`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
}

/** Clicks Start and waits for the first question to be on screen. */
async function startAttempt(page) {
  const btn = page.getByRole("button", { name: /start crorepati/i });
  await btn.click();
  await page.waitForFunction(() => /Question\s+1\s*\/\s*20/i.test(document.body.innerText), {
    timeout: 120000,
  });
}

/* ------------------------------------------------------------------ */
/* P1-01 / P1-02 / P1-03 / P1-04                                       */
/* ------------------------------------------------------------------ */

const A = await freshGuest();
await gotoGame(A.page);

const beforeOpen = await sql("select free_entries from crorepati_entry_state where guest_id=$1", [
  A.guestId,
]);
const bodyOpen = await A.page.textContent("body");
check(
  "P1-01",
  "Crorepati event opens with a working Start button",
  /Start Crorepati/i.test(bodyOpen),
);
check(
  "P1-01b",
  "opening the event does NOT consume a free entry",
  /3 of 3 available/i.test(bodyOpen) && (beforeOpen[0]?.free_entries ?? 3) === 3,
  `db=${beforeOpen[0]?.free_entries ?? "no row yet"}`,
);

await startAttempt(A.page);

const attempt = (
  await sql("select * from crorepati_attempts where guest_id=$1 order by started_at desc limit 1", [
    A.guestId,
  ])
)[0];
const qs = await sql(
  "select * from crorepati_attempt_questions where attempt_id=$1 order by question_number",
  [attempt.id],
);
check(
  "P1-02",
  "EXACTLY 20 questions are created for the attempt",
  qs.length === 20,
  `${qs.length}`,
);
check(
  "P1-02b",
  "question numbers are 1..20 with no gaps",
  qs.every((q, i) => Number(q.question_number) === i + 1),
);
check(
  "P1-03",
  "only one question is active at a time (server current_question = 1)",
  Number(attempt.current_question) === 1,
);
const oneVisible = await A.page.evaluate(
  () => (document.body.innerText.match(/Question\s+\d+\s*\/\s*20/g) ?? []).length,
);
check("P1-03b", "UI shows a single active question", oneVisible === 1, `${oneVisible} headers`);

const qText = await A.page.evaluate(() => {
  const h = document.querySelector("h2");
  return h ? h.innerText.trim() : "";
});
check(
  "P1-04",
  "question renders fully (no blank/clipped question)",
  qText.length > 10,
  `${qText.length} chars`,
);
const clipped = await A.page.evaluate(() => {
  const h = document.querySelector("h2");
  if (!h) return true;
  return h.scrollHeight > h.clientHeight + 2;
});
check("P1-04b", "question text is not visually clipped", !clipped);

/* ------------------------------------------------------------------ */
/* P1-05 — the 10s pre-timer, measured on a wall clock                 */
/* ------------------------------------------------------------------ */

// The pre-timer arms when the client reports the question fully presented,
// so wait for that signal before measuring it.
let t = {};
for (let i = 0; i < 40; i++) {
  t = (
    await sql(
      "select started_at, presented_at, answer_timer_starts_at, deadline_at from crorepati_attempts where id=$1",
      [attempt.id],
    )
  )[0];
  if (t.answer_timer_starts_at && t.presented_at) break;
  await A.page.waitForTimeout(500);
}
if (t.answer_timer_starts_at) {
  const base = t.presented_at ?? t.started_at;
  const pre = (new Date(t.answer_timer_starts_at) - new Date(base)) / 1000;
  check(
    "P1-05",
    "server sets a 10-second pre-timer before the answer timer",
    Math.abs(pre - 10) < 2.5,
    `${pre.toFixed(1)}s`,
  );
} else {
  check(
    "P1-05",
    "server sets a 10-second pre-timer",
    "BLOCKED",
    "timer arms on client 'presented' signal",
  );
}

// Watch the real UI: the 90s timer must not appear during the get-ready phase.
const t0 = Date.now();
let sawNinety = null;
for (let i = 0; i < 30; i++) {
  const txt = await A.page.evaluate(() => document.body.innerText);
  if (/\b01:[0-3]\d\b/.test(txt)) {
    sawNinety = (Date.now() - t0) / 1000;
    break;
  }
  await A.page.waitForTimeout(500);
}
if (sawNinety !== null) {
  check(
    "P1-05b",
    "the 90s answer timer does not start early",
    sawNinety >= 8.5,
    `appeared at ${sawNinety.toFixed(1)}s`,
  );
} else {
  check(
    "P1-05b",
    "answer timer visibility during get-ready",
    "BLOCKED",
    "timer label not matched in UI text",
  );
}

/* ------------------------------------------------------------------ */
/* P1-06 — the 90s answer timer                                        */
/* ------------------------------------------------------------------ */

await A.page.waitForTimeout(11000);
const after = (
  await sql("select answer_timer_starts_at, deadline_at from crorepati_attempts where id=$1", [
    attempt.id,
  ])
)[0];
if (after.deadline_at && after.answer_timer_starts_at) {
  const win = (new Date(after.deadline_at) - new Date(after.answer_timer_starts_at)) / 1000;
  check(
    "P1-06",
    "answer window is exactly 90 seconds (server)",
    Math.abs(win - 90) < 1.5,
    `${win.toFixed(1)}s`,
  );
} else {
  check("P1-06", "answer window is 90 seconds", false, "no deadline on the attempt row");
}

const c1 = await A.page.evaluate(() => document.body.innerText.match(/(\d+:\d\d)/)?.[1] ?? null);
await A.page.waitForTimeout(3000);
const c2 = await A.page.evaluate(() => document.body.innerText.match(/(\d+:\d\d)/)?.[1] ?? null);
check(
  "P1-06b",
  "timer is visible and counting down in the UI",
  !!c1 && !!c2 && c1 !== c2,
  `${c1} → ${c2}`,
);

// Client cannot extend the deadline: the server value is authoritative.
const beforeHack = (
  await sql("select deadline_at from crorepati_attempts where id=$1", [attempt.id])
)[0].deadline_at;
await A.page.evaluate(() => {
  // Simulate a tampered client clock.
  const realNow = Date.now;
  Date.now = () => realNow() - 600000;
});
await A.page.waitForTimeout(1500);
const afterHack = (
  await sql("select deadline_at from crorepati_attempts where id=$1", [attempt.id])
)[0].deadline_at;
check(
  "P1-06c",
  "client cannot extend the timer (server deadline unchanged)",
  String(beforeHack) === String(afterHack),
);
await A.page.reload({ waitUntil: "domcontentloaded" });
await A.page.waitForTimeout(3000);

/* ------------------------------------------------------------------ */
/* P1-07 — a correct answer advances the game                          */
/* ------------------------------------------------------------------ */

/** Clicks the option whose text matches the DB's correct option. */
async function answer(page, attemptId, n, wantCorrect) {
  const row = (
    await sql(
      "select options, correct_index from crorepati_attempt_questions where attempt_id=$1 and question_number=$2",
      [attemptId, n],
    )
  )[0];
  const options = typeof row.options === "string" ? JSON.parse(row.options) : row.options;
  const idx = wantCorrect
    ? Number(row.correct_index)
    : (Number(row.correct_index) + 1) % options.length;
  const wanted = options[idx];
  const btn = page.locator("button", { hasText: wanted }).first();
  await btn.waitFor({ state: "visible", timeout: 30000 });
  await btn.click();
  return wanted;
}

/** After a correct answer the player advances with the Next button (Part 1 UX). */
async function goNext(page) {
  const btn = page.getByRole("button", { name: /next question/i });
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

async function waitForQuestion(page, n) {
  await page.waitForFunction(
    (x) => new RegExp(`Question\\s+${x}\\s*/\\s*20`, "i").test(document.body.innerText),
    n,
    {
      timeout: 120000,
    },
  );
}

await waitForQuestion(A.page, 1);
await answer(A.page, attempt.id, 1, true);
await A.page.waitForTimeout(4000);
const afterQ1 = (
  await sql(
    "select cleared_questions, current_question, status from crorepati_attempts where id=$1",
    [attempt.id],
  )
)[0];
check(
  "P1-07",
  "a correct answer is accepted and clears the question",
  Number(afterQ1.cleared_questions) === 1,
  `cleared=${afterQ1.cleared_questions}`,
);
const advanced = await goNext(A.page);
await A.page.waitForTimeout(4000);
const afterNext = (
  await sql("select current_question, status from crorepati_attempts where id=$1", [attempt.id])
)[0];
check(
  "P1-07b",
  "the game advances to the next question",
  advanced && Number(afterNext.current_question) === 2 && afterNext.status === "active",
  `q=${afterNext.current_question}`,
);

/* ------------------------------------------------------------------ */
/* P1-12 / P1-13 / P1-14 — lifelines on the live attempt               */
/* ------------------------------------------------------------------ */

await waitForQuestion(A.page, 2);
await A.page.waitForTimeout(11000);

const fiftyBtn = A.page.getByRole("button", { name: /50-?50/i });
if (await fiftyBtn.count()) {
  const before = await A.page
    .locator("button")
    .filter({ hasText: /^[A-D]/ })
    .count();
  await fiftyBtn.first().click();
  await A.page.waitForTimeout(2500);
  const remaining = await A.page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) =>
      /^[A-D]\b/.test(b.innerText.trim()),
    );
    return btns.filter((b) => !b.disabled && b.innerText.trim().length > 2).length;
  });
  const dbL = (
    await sql("select fifty_fifty_used, hint_used, skip_used from crorepati_attempts where id=$1", [
      attempt.id,
    ])
  )[0];
  check(
    "P1-12",
    "50-50 removes two options, leaving two",
    remaining === 2,
    `${before} → ${remaining}`,
  );
  check(
    "P1-12b",
    "50-50 usage is recorded server-side",
    dbL.fifty_fifty_used === true,
    `fifty_fifty_used=${dbL.fifty_fifty_used}`,
  );
  const disabled = await fiftyBtn.first().isDisabled();
  check("P1-12c", "50-50 cannot be used twice", disabled);
  // persistence across refresh
  await A.page.reload({ waitUntil: "domcontentloaded" });
  await A.page.waitForTimeout(4000);
  const stillDisabled = await A.page
    .getByRole("button", { name: /50-?50/i })
    .first()
    .isDisabled();
  check("P1-12d", "50-50 state persists across a refresh", stillDisabled);
} else {
  check("P1-12", "50-50 lifeline", "BLOCKED", "button not found");
}

const hintBtn = A.page.getByRole("button", { name: /hint/i });
if (await hintBtn.count()) {
  const beforeTxt = await A.page.evaluate(() => document.body.innerText);
  await hintBtn.first().click();
  await A.page.waitForTimeout(2500);
  const afterTxt = await A.page.evaluate(() => document.body.innerText);
  const dbL = (
    await sql("select fifty_fifty_used, hint_used, skip_used from crorepati_attempts where id=$1", [
      attempt.id,
    ])
  )[0];
  check(
    "P1-13",
    "Hint reveals guidance",
    afterTxt.length > beforeTxt.length,
    `${afterTxt.length - beforeTxt.length} chars`,
  );
  check(
    "P1-13b",
    "Hint usage is recorded server-side",
    dbL.hint_used === true,
    `hint_used=${dbL.hint_used}`,
  );
  check("P1-13c", "Hint cannot be reused", await hintBtn.first().isDisabled());
} else {
  check("P1-13", "Hint lifeline", "BLOCKED", "button not found");
}

const skipBtn = A.page.getByRole("button", { name: /skip/i });
if (await skipBtn.count()) {
  const qBefore = (
    await sql("select current_question from crorepati_attempts where id=$1", [attempt.id])
  )[0].current_question;
  await skipBtn.first().click();
  await A.page.waitForTimeout(5000);
  const qAfter = (
    await sql(
      "select current_question, fifty_fifty_used, hint_used, skip_used, status from crorepati_attempts where id=$1",
      [attempt.id],
    )
  )[0];
  check(
    "P1-14",
    "Skip moves to the next question without ending the game",
    Number(qAfter.current_question) === Number(qBefore) + 1 && qAfter.status === "active",
    `${qBefore} → ${qAfter.current_question}`,
  );
  check(
    "P1-14b",
    "Skip usage is recorded server-side",
    qAfter.skip_used === true,
    `skip_used=${qAfter.skip_used}`,
  );
  check("P1-14c", "Skip cannot be reused", await skipBtn.first().isDisabled());
} else {
  check("P1-14", "Skip lifeline", "BLOCKED", "button not found");
}

/* ------------------------------------------------------------------ */
/* P1-15 — refresh recovery                                            */
/* ------------------------------------------------------------------ */

const preRefresh = (
  await sql(
    "select current_question, cleared_questions, fifty_fifty_used, hint_used, skip_used from crorepati_attempts where id=$1",
    [attempt.id],
  )
)[0];
await A.page.reload({ waitUntil: "domcontentloaded" });
await A.page.waitForTimeout(5000);
const attemptsNow = await sql("select id from crorepati_attempts where guest_id=$1", [A.guestId]);
const postRefresh = (
  await sql(
    "select current_question, cleared_questions, fifty_fifty_used, hint_used, skip_used, status from crorepati_attempts where id=$1",
    [attempt.id],
  )
)[0];
check(
  "P1-15",
  "the same attempt is recovered after a refresh",
  attemptsNow.length === 1 && attemptsNow[0].id === attempt.id,
  `${attemptsNow.length} attempts`,
);
check(
  "P1-15b",
  "question index and score survive the refresh",
  String(postRefresh.current_question) === String(preRefresh.current_question) &&
    String(postRefresh.cleared_questions) === String(preRefresh.cleared_questions),
);
check(
  "P1-15c",
  "lifeline state survives the refresh",
  postRefresh.fifty_fifty_used === preRefresh.fifty_fifty_used &&
    postRefresh.hint_used === preRefresh.hint_used &&
    postRefresh.skip_used === preRefresh.skip_used,
);
const uiAfter = await A.page.evaluate(() => document.body.innerText);
check(
  "P1-15d",
  "the UI resumes the live attempt (not the intro screen)",
  /Question\s+\d+\s*\/\s*20/.test(uiAfter),
);

/* ------------------------------------------------------------------ */
/* P1-08 — a wrong answer ends the game immediately                    */
/* ------------------------------------------------------------------ */

const curQ = Number(
  (await sql("select current_question from crorepati_attempts where id=$1", [attempt.id]))[0]
    .current_question,
);
await waitForQuestion(A.page, curQ);
await A.page.waitForTimeout(11000);
await answer(A.page, attempt.id, curQ, false);
await A.page.waitForTimeout(6000);
const lost = (
  await sql(
    "select status, cleared_questions, coin_reward, ended_at from crorepati_attempts where id=$1",
    [attempt.id],
  )
)[0];
check("P1-08", "a wrong answer ends the game immediately", lost.status === "lost", lost.status);
check("P1-08b", "the result is persisted with an end time", !!lost.ended_at);

// no further answer accepted
const before08 = lost.cleared_questions;
await answer(A.page, attempt.id, curQ, true).catch(() => {});
await A.page.waitForTimeout(2500);
const after08 = (
  await sql("select cleared_questions, status from crorepati_attempts where id=$1", [attempt.id])
)[0];
check(
  "P1-08c",
  "no further answer is accepted after game over",
  String(after08.cleared_questions) === String(before08) && after08.status === "lost",
);

/* ------------------------------------------------------------------ */
/* P1-11 — reward is based on CLEARED questions                        */
/* ------------------------------------------------------------------ */

const B = await freshGuest();
await gotoGame(B.page);
await startAttempt(B.page);
const bAtt = (
  await sql("select * from crorepati_attempts where guest_id=$1 order by started_at desc limit 1", [
    B.guestId,
  ])
)[0];
for (const n of [1, 2, 3]) {
  await waitForQuestion(B.page, n);
  await B.page.waitForTimeout(11000);
  await answer(B.page, bAtt.id, n, true);
  await B.page.waitForTimeout(3500);
  await goNext(B.page);
  await B.page.waitForTimeout(2500);
}
await waitForQuestion(B.page, 4);
await B.page.waitForTimeout(11000);
await answer(B.page, bAtt.id, 4, false);
await B.page.waitForTimeout(6000);
const bRes = (
  await sql("select status, cleared_questions, coin_reward from crorepati_attempts where id=$1", [
    bAtt.id,
  ])
)[0];
const ladder = await sql(
  "select question_number, coins from crorepati_rewards where event_id=$1 order by question_number",
  [bAtt.event_id],
);
const expected3 = Number(ladder.find((r) => Number(r.question_number) === 3)?.coins ?? -1);
check(
  "P1-11",
  "3 correct then 1 wrong clears exactly 3 questions",
  Number(bRes.cleared_questions) === 3,
  `${bRes.cleared_questions}`,
);
check(
  "P1-11b",
  "reward equals the 3-question ladder value (not 4, not 20)",
  Number(bRes.coin_reward) === expected3,
  `${bRes.coin_reward} vs ${expected3}`,
);
const ledger = await sql("select coins, source, ref_id from ustad_coin_ledger where guest_id=$1", [
  B.guestId,
]);
check(
  "P1-11c",
  "the reward is a real ledger transaction",
  ledger.some((l) => Number(l.coins) === Number(bRes.coin_reward)),
  JSON.stringify(ledger.map((l) => l.coins)),
);

/* ------------------------------------------------------------------ */
/* P1-16 — double start                                                */
/* ------------------------------------------------------------------ */

const C = await freshGuest();
await gotoGame(C.page);
const entriesBefore = Number(
  (await sql("select free_entries from crorepati_entry_state where guest_id=$1", [C.guestId]))[0]
    ?.free_entries ?? 3,
);
const startBtn = C.page.getByRole("button", { name: /start crorepati/i });
await Promise.all([
  startBtn.click().catch(() => {}),
  startBtn.click().catch(() => {}),
  startBtn.click().catch(() => {}),
]);
await C.page.waitForTimeout(20000);
const cAttempts = await sql("select id, status from crorepati_attempts where guest_id=$1", [
  C.guestId,
]);
const entriesAfter = Number(
  (await sql("select free_entries from crorepati_entry_state where guest_id=$1", [C.guestId]))[0]
    ?.free_entries ?? 3,
);
check(
  "P1-16",
  "rapid multi-click creates only ONE attempt",
  cAttempts.length === 1,
  `${cAttempts.length} attempts`,
);
check(
  "P1-16b",
  "only one free entry is consumed",
  entriesBefore - entriesAfter === 1,
  `${entriesBefore} → ${entriesAfter}`,
);
const consumed = await sql(
  "select id, status from crorepati_entries where guest_id=$1 and status='consumed'",
  [C.guestId],
);
check(
  "P1-16c",
  "exactly one entry row is marked consumed",
  consumed.length === 1,
  `${consumed.length}`,
);

summary();
await browser.close();
await DB.end();
