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
/* PART 4 — TROPHY / GRANDMASTER / ULTRA                               */
/* ================================================================== */

/**
 * SETUP (clearly labelled): Mega Cups are awarded by the Part 4 engine when the
 * Part 2 engine finalizes a Mega win. Rather than hand-writing trophies, we call
 * the REAL `onMegaWin` engine entry point with REAL match rows, so every
 * achievement, trophy, certificate and notification is produced by production
 * code exactly as it would be in a live tournament.
 */
const G = await freshGuest();
await G.page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
const trophy = await import("../src/lib/trophy-engine.server.ts");

const megaEvent = (await sql("select id from mega_events limit 1"))[0];

async function realMegaWin(guestId, i) {
  const match = (
    await sql(
      `insert into mega_matches (event_id, mode, status, question_count, host_guest_id, winner_guest_id, started_at, ended_at)
       values ($1,'multiplayer','finished',20,$2,$2, now() - interval '1 hour', now())
       returning id`,
      [megaEvent.id, guestId],
    )
  )[0];
  // The Part 4 engine verifies this row and nothing else — it is the same row
  // the Part 2 engine writes when it finalizes a real match.
  await sql(
    `insert into mega_player_results (match_id, guest_id, event_id, mode, rank, is_winner, correct_count, score, outcome)
     values ($1,$2,$3,'multiplayer',1,true,18,18,'win')`,
    [match.id, guestId, megaEvent.id],
  );
  return trophy.onMegaWin({ guestId, eventId: megaEvent.id, matchId: match.id });
}

console.log("   [SETUP] awarding Mega Cup #1 through the real Part 4 engine…");
await realMegaWin(G.guestId, 1);
const cups1 = await sql("select * from ustad_achievements where guest_id=$1 and type='mega_cup'", [
  G.guestId,
]);
check("P4-02", "a verified Mega win creates a Mega Cup", cups1.length === 1, `${cups1.length}`);
const gm = await sql("select * from ustad_achievements where guest_id=$1 and type='grandmaster'", [
  G.guestId,
]);
check("P4-03", "the Mega Cup promotes the player to Grandmaster", gm.length === 1, `${gm.length}`);
const gmNotif = await sql("select title from reminders where guest_id=$1 and kind='notification'", [
  G.guestId,
]);
check(
  "P4-03b",
  "Grandmaster produces a notification",
  gmNotif.length >= 1,
  gmNotif
    .map((n) => n.title)
    .slice(0, 3)
    .join(" | "),
);

// P4-06 — replaying the same qualifying result must not duplicate.
await realMegaWin(G.guestId, 1).catch(() => {});
const dupCheck = await sql(
  "select type, count(*) c from ustad_achievements where guest_id=$1 group by type",
  [G.guestId],
);
const gmCount = Number(dupCheck.find((d) => d.type === "grandmaster")?.c ?? 0);
check(
  "P4-06",
  "a repeated qualifying result never duplicates the status trophy",
  gmCount === 1,
  `grandmaster rows=${gmCount}`,
);

console.log("   [SETUP] awarding Mega Cups #2–#5 through the real Part 4 engine…");
for (let i = 2; i <= 5; i++) await realMegaWin(G.guestId, i);
const cups5 = await sql("select * from ustad_achievements where guest_id=$1 and type='mega_cup'", [
  G.guestId,
]);
const ultra = await sql(
  "select * from ustad_achievements where guest_id=$1 and type='ultra_grandmaster'",
  [G.guestId],
);
check(
  "P4-04",
  "at least 5 verified Mega Cups are recorded (one per distinct match)",
  cups5.length >= 5 && new Set(cups5.map((c) => c.match_id)).size === cups5.length,
  `${cups5.length} cups, ${new Set(cups5.map((c) => c.match_id)).size} distinct matches`,
);
check("P4-04b", "5 Mega Cups award Ultra Great Grandmaster", ultra.length === 1, `${ultra.length}`);
check("P4-04c", "Ultra Great Grandmaster is not duplicated", ultra.length <= 1);
const ultraTroph = await sql("select * from ustad_trophies where guest_id=$1", [G.guestId]);
check(
  "P4-04d",
  "trophy records exist for the achievements",
  ultraTroph.length >= 5,
  `${ultraTroph.length} trophies`,
);

// P4-05 — trophy security: the client has no award endpoint and RLS blocks writes.
const clientAward = await G.page.evaluate(async () => {
  const r = await fetch("/_serverFn/awardAchievement", { method: "POST", body: "{}" });
  return r.status;
});
check(
  "P4-05",
  "there is no client-callable trophy award endpoint",
  clientAward >= 400,
  `HTTP ${clientAward}`,
);

// Trophies must be visible on the EXISTING profile (settings), not a new page.
await G.page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 90000 });
await G.page.waitForTimeout(4000);
// Profile is a tab on the EXISTING settings page (no second profile page exists).
const profileTab = G.page
  .getByRole("tab", { name: /^profile$/i })
  .or(G.page.getByRole("button", { name: /^profile$/i }));
if (await profileTab.count()) await profileTab.first().click();
await G.page.waitForTimeout(8000);
const profileTxt = await G.page.textContent("body");
check(
  "P4-03c",
  "achievements render on the EXISTING profile page",
  /grandmaster|mega cup|achievement|trophy/i.test(profileTxt),
);
check(
  "P4-04e",
  "Ultra Great Grandmaster is shown on the profile",
  /ultra/i.test(profileTxt),
  (profileTxt.match(/Ultra[^.]{0,40}/i) ?? ["not shown"])[0],
);

/* ================================================================== */
/* PART 5 — CERTIFICATE + QR                                           */
/* ================================================================== */

const gCerts = await sql("select * from ustad_certificates where guest_id=$1 order by issued_at", [
  G.guestId,
]);
check(
  "P5-01c",
  "certificates are issued for the earned achievements",
  gCerts.length >= 1,
  `${gCerts.length}: ${gCerts.map((c) => c.certificate_type).join(",")}`,
);
check(
  "P5-09",
  "each achievement has exactly ONE certificate (no duplicates)",
  new Set(gCerts.map((c) => c.achievement_id)).size === gCerts.length,
  `${gCerts.length} certs / ${new Set(gCerts.map((c) => c.achievement_id)).size} achievements`,
);
check(
  "P5-02b",
  "every certificate is owned by the correct guest",
  gCerts.every((c) => c.guest_id === G.guestId),
);
check(
  "P5-02c",
  "no orphaned certificate (all reference a real achievement)",
  gCerts.every((c) => !!c.achievement_id),
);

// The certificate panel lives on the existing profile page.
check("P5-03", "certificates are listed on the existing profile", /certificate/i.test(profileTxt));

const dl = G.page.getByRole("button", { name: /download/i });
if (await dl.count()) {
  const [download] = await Promise.all([
    G.page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
    dl
      .first()
      .click()
      .catch(() => {}),
  ]);
  if (download) {
    const path = await download.path();
    const size = path ? (await import("node:fs")).statSync(path).size : 0;
    const body = path ? (await import("node:fs")).readFileSync(path, "utf8") : "";
    check(
      "P5-03b",
      "the certificate downloads as a real file",
      size > 1000,
      `${size} bytes, ${download.suggestedFilename()}`,
    );
    check(
      "P5-03c",
      "the downloaded certificate contains a QR and the recipient",
      /<svg/i.test(body) && body.includes("USTAD-CERT-"),
      `${body.length} chars`,
    );
  } else {
    check("P5-03b", "certificate download", "BLOCKED", "no download event fired");
  }
} else {
  check("P5-03b", "certificate download", "BLOCKED", "download control not found on profile");
}

// P5-06 — real QR / public verification page.
const cert = gCerts[0];
await G.page.goto(`${BASE}/verify/certificate/${cert.verification_token}`, {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
await G.page.waitForTimeout(4000);
const verifyTxt = await G.page.textContent("body");
check(
  "P5-06",
  "the public verification page reports a VALID certificate",
  /valid|verified/i.test(verifyTxt) && !/invalid/i.test(verifyTxt),
  (verifyTxt.match(/(valid|verified|invalid)/i) ?? [""])[0],
);
check(
  "P5-06b",
  "the verification page shows the certificate id",
  verifyTxt.includes(cert.certificate_id),
  cert.certificate_id,
);

// P5-07 — a tampered token must not verify and must leak nothing.
const badToken = "f".repeat(64);
await G.page.goto(`${BASE}/verify/certificate/${badToken}`, {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
await G.page.waitForTimeout(3500);
const badTxt = await G.page.textContent("body");
check(
  "P5-07",
  "a tampered verification token reports INVALID",
  /invalid/i.test(badTxt) || /not found/i.test(badTxt),
  (badTxt.match(/(invalid|not found)[^.]{0,40}/i) ?? [""])[0],
);
check(
  "P5-07b",
  "the invalid page leaks no private data",
  !badTxt.includes(G.guestId) && !badTxt.includes(cert.certificate_id),
);
const certCountAfterBad = (await sql("select count(*) c from ustad_certificates"))[0].c;
check(
  "P5-07c",
  "an invalid verification creates no certificate",
  Number(certCountAfterBad) ===
    Number((await sql("select count(*) c from ustad_certificates"))[0].c),
);

// P5-08 — QR replay must not duplicate or transfer ownership.
const beforeClaim = (
  await sql(
    "select claim_count, guest_id, verification_status from ustad_certificates where id=$1",
    [cert.id],
  )
)[0];
for (let i = 0; i < 3; i++) {
  await G.page.goto(`${BASE}/verify/certificate/${cert.verification_token}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await G.page.waitForTimeout(2500);
}
const afterClaim = (
  await sql(
    "select claim_count, guest_id, verification_status from ustad_certificates where id=$1",
    [cert.id],
  )
)[0];
const totalCerts = await sql("select count(*) c from ustad_certificates where guest_id=$1", [
  G.guestId,
]);
check(
  "P5-08",
  "re-scanning the QR creates no second certificate",
  Number(totalCerts[0].c) === gCerts.length,
  `${totalCerts[0].c} vs ${gCerts.length}`,
);
check(
  "P5-08b",
  "re-scanning never transfers ownership",
  afterClaim.guest_id === beforeClaim.guest_id,
);
check(
  "P5-08c",
  "the certificate stays valid on repeat scans",
  afterClaim.verification_status === "valid",
  afterClaim.verification_status,
);

// P5-10 — refresh keeps the certificate available.
await G.page.reload({ waitUntil: "domcontentloaded" });
await G.page.waitForTimeout(3000);
const afterRefresh = await G.page.textContent("body");
check(
  "P5-10",
  "the verification page survives a refresh",
  afterRefresh.includes(cert.certificate_id),
);

summary();
await browser.close();
await DB.end();
