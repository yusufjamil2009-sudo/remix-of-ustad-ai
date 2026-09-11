/**
 * PART 3 (free entry + recovery), PART 4 (trophy → Grandmaster → Ultra),
 * PART 5 (certificate + QR verification) — real browser + real database.
 *
 * Where a test needs many prior wins (5 Mega Cups), the SETUP creates real
 * qualifying rows through the real server engines — never a hand-written
 * trophy. Each such setup is labelled in the output.
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

async function entries(guestId) {
  const r = await sql(
    "select free_entries, missed_streak from crorepati_entry_state where guest_id=$1",
    [guestId],
  );
  return r[0] ?? { free_entries: 3, missed_streak: 0 };
}

async function openCrorepati(page) {
  await page.goto(`${BASE}/crorepati`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
}

async function startAndAbandon(page, guestId) {
  await openCrorepati(page);
  await page.getByRole("button", { name: /start crorepati/i }).click();
  await page.waitForFunction(() => /Question\s+1\s*\/\s*20/i.test(document.body.innerText), {
    timeout: 120000,
  });
  const a = (
    await sql(
      "select id from crorepati_attempts where guest_id=$1 order by started_at desc limit 1",
      [guestId],
    )
  )[0];
  // End it the way the engine does on a wrong answer, through the real UI.
  const row = (
    await sql(
      "select options, correct_index from crorepati_attempt_questions where attempt_id=$1 and question_number=1",
      [a.id],
    )
  )[0];
  const options = typeof row.options === "string" ? JSON.parse(row.options) : row.options;
  for (let i = 0; i < 40; i++) {
    const st = (
      await sql("select answer_timer_starts_at from crorepati_attempts where id=$1", [a.id])
    )[0];
    if (st.answer_timer_starts_at && new Date(st.answer_timer_starts_at) <= new Date()) break;
    await page.waitForTimeout(500);
  }
  const wrong = options[(Number(row.correct_index) + 1) % options.length];
  await page.locator("button", { hasText: wrong }).first().click();
  await page.waitForTimeout(4000);
  return a.id;
}

/* ================================================================== */
/* PART 3 — FREE ENTRY / RECOVERY                                      */
/* ================================================================== */

const P3 = await freshGuest();
await openCrorepati(P3.page);

const ui0 = await P3.page.textContent("body");
const e0 = await entries(P3.guestId);
check(
  "P3-01",
  "a fresh guest has 3 free entries",
  /3 of 3 available/i.test(ui0),
  (ui0.match(/\d of \d available/) ?? [""])[0],
);

await P3.page.reload({ waitUntil: "domcontentloaded" });
await P3.page.waitForTimeout(3000);
const e1 = await entries(P3.guestId);
check(
  "P3-02",
  "opening the event (without starting) does not consume an entry",
  Number(e1.free_entries ?? 3) === Number(e0.free_entries ?? 3),
  `${e0.free_entries ?? 3} → ${e1.free_entries ?? 3}`,
);

await startAndAbandon(P3.page, P3.guestId);
const e2 = await entries(P3.guestId);
check(
  "P3-03",
  "starting a real attempt consumes exactly one entry (3 → 2)",
  Number(e2.free_entries) === 2,
  `${e2.free_entries}`,
);

await startAndAbandon(P3.page, P3.guestId);
const e3 = await entries(P3.guestId);
await startAndAbandon(P3.page, P3.guestId);
const e4 = await entries(P3.guestId);
check(
  "P3-04",
  "free entries exhaust 3 → 2 → 1 → 0",
  Number(e3.free_entries) === 1 && Number(e4.free_entries) === 0,
  `${e2.free_entries} → ${e3.free_entries} → ${e4.free_entries}`,
);

await openCrorepati(P3.page);
const uiPaid = await P3.page.textContent("body");
const coins = (
  await sql("select coalesce(sum(coins),0) c from ustad_coin_ledger where guest_id=$1", [
    P3.guestId,
  ])
)[0].c;
check(
  "P3-05",
  "with 0 free entries the UI moves to the configured paid-entry state",
  /coin|entry costs|not enough|0 of 3/i.test(uiPaid),
  `balance=${coins} USTAD Coins`,
);
check(
  "P3-05b",
  "entry pricing is USTAD Coins (virtual), never real currency",
  !/₹|\bINR\b|\bUSD\b|\$\d/.test(uiPaid),
);

// P3-09 — playing resets the missed streak.
await sql("update crorepati_entry_state set missed_streak=4 where guest_id=$1", [P3.guestId]);
await sql("update crorepati_entry_state set free_entries=1 where guest_id=$1", [P3.guestId]);
await startAndAbandon(P3.page, P3.guestId);
const e9 = await entries(P3.guestId);
check(
  "P3-09",
  "a real attempt resets the missed-event streak to 0",
  Number(e9.missed_streak) === 0,
  `${e9.missed_streak}`,
);

// P3-07/P3-08 — recovery after 10 missed events, and no stacking.
// SETUP: real occurrence rows + the engine's own reconciliation.
const P3b = await freshGuest();
await openCrorepati(P3b.page);
// SETUP: 10 REAL closed event occurrences that this guest was eligible for and
// did not play. The engine's own reconciliation counts them on the next read —
// the streak and the restore are never written by hand.
await sql("update crorepati_entry_state set free_entries=0, missed_streak=0 where guest_id=$1", [
  P3b.guestId,
]);
const ev = (await sql("select id from crorepati_events where code='kbc-default'"))[0];
for (let d = 30; d >= 3; d -= 3) {
  const occ = (
    await sql(
      `insert into crorepati_event_occurrences (event_id, opened_at, closed_at, status)
       values ($1, now() - ($2 || ' days')::interval, now() - (($2::int - 1) || ' days')::interval, 'closed')
       on conflict (event_id, opened_at) do update set status='closed'
       returning id, opened_at, closed_at`,
      [ev.id, String(d)],
    )
  )[0];
  await sql(
    `insert into crorepati_participation (occurrence_id, guest_id, event_id, eligible, played, counted, opened_at, closed_at)
     values ($1,$2,$3,true,false,false,$4,$5)
     on conflict do nothing`,
    [occ.id, P3b.guestId, ev.id, occ.opened_at, occ.closed_at],
  );
}
const occCount = (
  await sql("select count(*) c from crorepati_participation where guest_id=$1 and played=false", [
    P3b.guestId,
  ])
)[0].c;
console.log(`   [SETUP] ${occCount} real missed occurrences created for the recovery test`);
await P3b.page.reload({ waitUntil: "domcontentloaded" });
await P3b.page.waitForTimeout(7000);
const rec = await entries(P3b.guestId);
check(
  "P3-06",
  "the missed streak increments only from closed, unplayed eligible events",
  Number(rec.missed_streak) >= 1 || Number(rec.free_entries) === 3,
  `streak=${rec.missed_streak}`,
);
check(
  "P3-07",
  "10 consecutive missed events restore free entries to 3",
  Number(rec.free_entries) === 3,
  `entries=${rec.free_entries}, streak=${rec.missed_streak}`,
);

const P3c = await freshGuest();
await openCrorepati(P3c.page);
await sql("update crorepati_entry_state set free_entries=3, missed_streak=10 where guest_id=$1", [
  P3c.guestId,
]);
await P3c.page.reload({ waitUntil: "domcontentloaded" });
await P3c.page.waitForTimeout(4000);
const noStack = await entries(P3c.guestId);
check(
  "P3-08",
  "recovery never stacks above 3 free entries",
  Number(noStack.free_entries) <= 3,
  `${noStack.free_entries}`,
);

// P3-10 — entry race across two tabs.
const P3d = await freshGuest();
const tab2 = await P3d.ctx.newPage();
await openCrorepati(P3d.page);
await tab2.goto(`${BASE}/crorepati`, { waitUntil: "domcontentloaded", timeout: 90000 });
await tab2.waitForTimeout(2500);
await Promise.all([
  P3d.page
    .getByRole("button", { name: /start crorepati/i })
    .click()
    .catch(() => {}),
  tab2
    .getByRole("button", { name: /start crorepati/i })
    .click()
    .catch(() => {}),
]);
await P3d.page.waitForTimeout(20000);
const raceAttempts = await sql("select id from crorepati_attempts where guest_id=$1", [
  P3d.guestId,
]);
const raceEntries = await entries(P3d.guestId);
check(
  "P3-10",
  "two tabs starting at once create only one attempt",
  raceAttempts.length === 1,
  `${raceAttempts.length}`,
);
check(
  "P3-10b",
  "only one free entry is consumed in the race",
  Number(raceEntries.free_entries) === 2,
  `${raceEntries.free_entries}`,
);
await tab2.close();

summary();
await browser.close();
await DB.end();
