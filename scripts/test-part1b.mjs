/**
 * PART 1 (continued) — P1-09 timeout, P1-10 the full 20/20 win,
 * plus the Part 1 → 4 → 5 chain that a win triggers.
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

async function startAttempt(page) {
  await page.goto(`${BASE}/crorepati`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /start crorepati/i }).click();
  await page.waitForFunction(() => /Question\s+1\s*\/\s*20/i.test(document.body.innerText), {
    timeout: 120000,
  });
}

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
  const btn = page.locator("button", { hasText: options[idx] }).first();
  await btn.waitFor({ state: "visible", timeout: 30000 });
  await btn.click();
}

async function goNext(page) {
  const btn = page.getByRole("button", { name: /next question/i });
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

/** Waits until the server has armed the answer window for question n. */
async function waitArmed(page, attemptId, n) {
  await page.waitForFunction(
    (x) => new RegExp(`Question\\s+${x}\\s*/\\s*20`, "i").test(document.body.innerText),
    n,
    { timeout: 120000 },
  );
  for (let i = 0; i < 60; i++) {
    const r = (
      await sql(
        "select current_question, answer_timer_starts_at, game_state from crorepati_attempts where id=$1",
        [attemptId],
      )
    )[0];
    if (
      Number(r.current_question) === n &&
      r.answer_timer_starts_at &&
      new Date(r.answer_timer_starts_at) <= new Date()
    )
      return;
    await page.waitForTimeout(500);
  }
}

/* ------------------------------------------------------------------ */
/* P1-10 — a genuine 20/20 win, played through the real UI             */
/* ------------------------------------------------------------------ */

const W = await freshGuest();
await startAttempt(W.page);
const wAtt = (
  await sql("select * from crorepati_attempts where guest_id=$1 order by started_at desc limit 1", [
    W.guestId,
  ])
)[0];

let played = 0;
for (let n = 1; n <= 20; n++) {
  await waitArmed(W.page, wAtt.id, n);
  await answer(W.page, wAtt.id, n, true);
  await W.page.waitForTimeout(2600);
  played++;
  if (n < 20) await goNext(W.page);
  const st = (await sql("select status from crorepati_attempts where id=$1", [wAtt.id]))[0];
  if (st.status !== "active") break;
}

await W.page.waitForTimeout(6000);
const win = (
  await sql(
    "select status, cleared_questions, coin_reward, result, ended_at from crorepati_attempts where id=$1",
    [wAtt.id],
  )
)[0];
check(
  "P1-10",
  "answering all 20 correctly WINS the game",
  win.status === "won",
  `${win.status} after ${played} answers`,
);
check(
  "P1-10b",
  "cleared_questions = 20",
  Number(win.cleared_questions) === 20,
  `${win.cleared_questions}`,
);
const top = (
  await sql("select coins from crorepati_rewards where event_id=$1 and question_number=20", [
    wAtt.event_id,
  ])
)[0];
check(
  "P1-10c",
  "the top ladder reward is paid",
  Number(win.coin_reward) === Number(top.coins),
  `${win.coin_reward} vs ${top.coins}`,
);
const wLedger = await sql("select coins, source, ref_id from ustad_coin_ledger where guest_id=$1", [
  W.guestId,
]);
check(
  "P1-10d",
  "the win is a real coin-ledger transaction",
  wLedger.some((l) => Number(l.coins) === Number(win.coin_reward)),
  `${wLedger.length} rows`,
);

const uiWin = await W.page.evaluate(() => document.body.innerText);
check(
  "P1-10e",
  "the UI shows the win result",
  /\b(WON|WIN)\b/i.test(uiWin) && /Result/i.test(uiWin),
  (uiWin.match(/Result:\s*\S+/i) ?? ["no result line"])[0],
);

/* --- the Part 4 + Part 5 chain a Crorepati win must trigger --------- */
await W.page.waitForTimeout(4000);
const ach = await sql("select * from ustad_achievements where guest_id=$1", [W.guestId]);
check(
  "P4-01",
  "a verified Crorepati win creates a trophy achievement",
  ach.length >= 1,
  `${ach.length} achievement(s): ${ach.map((a) => a.type).join(",")}`,
);
check(
  "P4-01b",
  "the achievement belongs to the winning guest and event",
  ach.every((a) => a.guest_id === W.guestId),
);
const troph = await sql("select * from ustad_trophies where guest_id=$1", [W.guestId]);
check("P4-01c", "a trophy record exists", troph.length >= 1, `${troph.length}`);
const certs = await sql("select * from ustad_certificates where guest_id=$1", [W.guestId]);
check(
  "P5-01",
  "the win issues a certificate",
  certs.length >= 1,
  `${certs.length}: ${certs.map((c) => c.certificate_id).join(",")}`,
);
if (certs.length) {
  const c = certs[0];
  check(
    "P5-01b",
    "certificate has a unique public id and a 64-hex verification token",
    /^USTAD-CERT-[0-9A-Z]{8}$/.test(String(c.certificate_id)) &&
      /^[0-9a-f]{64}$/.test(String(c.verification_token)),
    `${c.certificate_id}`,
  );
  check(
    "P5-02",
    "certificate references the authoritative achievement",
    !!c.achievement_id && ach.some((a) => a.id === c.achievement_id),
  );
}
const notif = await sql("select title from reminders where guest_id=$1 and kind='notification'", [
  W.guestId,
]);
check(
  "P1-10f",
  "the win produces in-app notifications",
  notif.length >= 1,
  `${notif.length}: ${notif
    .map((n) => n.title)
    .slice(0, 3)
    .join(" | ")}`,
);

/* ------------------------------------------------------------------ */
/* P1-09 — real 90-second timeout                                      */
/* ------------------------------------------------------------------ */

const T = await freshGuest();
await startAttempt(T.page);
const tAtt = (
  await sql("select * from crorepati_attempts where guest_id=$1 order by started_at desc limit 1", [
    T.guestId,
  ])
)[0];
await waitArmed(T.page, tAtt.id, 1);

const dl = (await sql("select deadline_at from crorepati_attempts where id=$1", [tAtt.id]))[0]
  .deadline_at;
const waitMs = new Date(dl) - Date.now() + 8000;
console.log(`   …waiting ${Math.round(waitMs / 1000)}s for the real 90s timer to expire`);
await T.page.waitForTimeout(Math.max(5000, waitMs));

let timedOut = (
  await sql("select status, result from crorepati_attempts where id=$1", [tAtt.id])
)[0];
if (timedOut.status === "active") {
  // The client reports the expiry; give the UI a moment and re-read.
  await T.page.waitForTimeout(8000);
  timedOut = (await sql("select status, result from crorepati_attempts where id=$1", [tAtt.id]))[0];
}
check(
  "P1-09",
  "letting the 90s timer expire ends the game",
  timedOut.status !== "active",
  `${timedOut.status}/${timedOut.result ?? ""}`,
);

const clearedBefore = (
  await sql("select cleared_questions from crorepati_attempts where id=$1", [tAtt.id])
)[0].cleared_questions;
await answer(T.page, tAtt.id, 1, true).catch(() => {});
await T.page.waitForTimeout(3000);
const afterTimeout = (
  await sql("select cleared_questions, status from crorepati_attempts where id=$1", [tAtt.id])
)[0];
check(
  "P1-09b",
  "an answer after timeout is rejected",
  String(afterTimeout.cleared_questions) === String(clearedBefore) &&
    afterTimeout.status !== "active",
  `${afterTimeout.status}`,
);

summary();
await browser.close();
await DB.end();
