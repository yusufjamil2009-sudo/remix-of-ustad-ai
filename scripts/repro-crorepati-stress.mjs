/**
 * Reproduce the reported error under REALISTIC user behaviour:
 * impatient double-clicks on options, clicking Next immediately, and clicking
 * during the 10-second pre-timer. A calm scripted playthrough already passes,
 * so the bug has to live in one of these races.
 */
import { chromium } from "playwright";
import pg from "pg";

const DB = new pg.Client({ host: "/tmp", port: 55432, user: "postgres", database: "ustad" });
await DB.connect();
const sql = async (q, p = []) => (await DB.query(q, p)).rows;
const BASE = "http://localhost:5173";

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 250)}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 250)}`);
});
page.on("response", async (r) => {
  if (r.status() >= 400 && !r.url().includes("favicon")) {
    let b = "";
    try {
      b = (await r.text()).slice(0, 300);
    } catch {
      /* consumed */
    }
    problems.push(`HTTP ${r.status()} :: ${b}`);
  }
});

// Any visible error toast is exactly what the user reported seeing.
const readToasts = async () => {
  const t = await page
    .locator("[data-sonner-toast]")
    .allTextContents()
    .catch(() => []);
  return t.filter(Boolean);
};

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(4000);
let tok = (await ctx.cookies()).find((c) => c.name === "ustad.guest")?.value ?? null;
for (let i = 0; i < 5 && !tok; i++) {
  await page.goto(`${BASE}/?s=${Date.now()}`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(4000);
  tok = (await ctx.cookies()).find((c) => c.name === "ustad.guest")?.value ?? null;
}
const guest = tok.split(".")[0];
console.log("guest:", guest);

const { execSync } = await import("node:child_process");
execSync(`node --import tsx scripts/provision-model.mjs ${guest}`, { stdio: "inherit" });
const { applyCoins } = await import("../src/lib/wallet.server.ts");
await applyCoins({
  guestId: guest,
  source: "admin",
  refId: `stress-${Date.now()}`,
  amount: 50000000,
  note: "stress funding",
});

const OPT = "button[aria-label^='Option ']";
await page.goto(`${BASE}/crorepati`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3000);
await page
  .getByRole("button", { name: /start crorepati/i })
  .first()
  .click();
console.log("starting…");
// Wait only for the question to render, NOT for the answer window to open.
await page.locator(OPT).first().waitFor({ timeout: 120000 });
console.log("question rendered; options present");

const NEXT = /next question|next|aage/i;

for (let q = 1; q <= 20; q++) {
  const st = (
    await sql(
      `select id, status, current_question from crorepati_attempts where guest_id=$1 order by started_at desc limit 1`,
      [guest],
    )
  )[0];
  if (!st || st.status !== "active") {
    console.log(`stopped before Q${q}: status=${st?.status}`);
    break;
  }

  const before = problems.length;

  // ---- ABUSE 1: click options DURING the 10s pre-timer (must be ignored) ----
  // Only counts as abuse while the options are still disabled; once they are
  // enabled a click is a normal answer, not a race.
  if (q % 4 === 1) {
    const opts = page.locator(OPT);
    if (
      (await opts.count()) &&
      !(await opts
        .first()
        .isEnabled()
        .catch(() => true))
    ) {
      await opts
        .first()
        .click({ force: true, timeout: 5000 })
        .catch(() => {});
      await opts
        .nth(1)
        .click({ force: true, timeout: 5000 })
        .catch(() => {});
      const early = (
        await sql(
          `select status from crorepati_attempts where guest_id=$1 order by started_at desc limit 1`,
          [guest],
        )
      )[0];
      if (early?.status !== "active") {
        problems.push(`Q${q}: pre-timer click ENDED the attempt (status=${early?.status})`);
      }
    }
  }

  // wait until genuinely answerable
  let ready = false;
  for (let w = 0; w < 30; w++) {
    const opts = page.locator(OPT);
    if (
      (await opts.count()) >= 4 &&
      (await opts
        .first()
        .isEnabled()
        .catch(() => false))
    ) {
      ready = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!ready) {
    console.log(`Q${q}: options never became answerable`);
    problems.push(`Q${q}: options never became answerable`);
    break;
  }

  const row = (
    await sql(
      `select correct_index from crorepati_attempt_questions aq
        join crorepati_attempts a on a.id=aq.attempt_id
       where a.guest_id=$1 and a.status='active' and aq.question_number=$2`,
      [guest, q],
    )
  )[0];
  if (!row) break;

  const opts = page.locator(OPT);
  const correct = Number(row.correct_index);

  // ---- ABUSE 2: hammer the same option (double / triple click) ----
  if (q % 3 === 0) {
    await Promise.all([
      opts
        .nth(correct)
        .click({ timeout: 8000 })
        .catch(() => {}),
      opts
        .nth(correct)
        .click({ force: true, timeout: 8000 })
        .catch(() => {}),
      opts
        .nth(correct)
        .click({ force: true, timeout: 8000 })
        .catch(() => {}),
    ]);
  } else {
    await opts.nth(correct).click({ timeout: 8000 });
    // ---- ABUSE 3: click a DIFFERENT option right after answering ----
    if (q % 3 === 1) {
      await page.waitForTimeout(150);
      await opts
        .nth((correct + 1) % 4)
        .click({ force: true, timeout: 5000 })
        .catch(() => {});
    }
  }

  await page.waitForTimeout(2000);
  let toasts = await readToasts();
  if (toasts.length) problems.push(`Q${q} toast after answer: ${toasts.join(" | ")}`);

  // ---- ABUSE 4: mash Next immediately and repeatedly ----
  const next = page.getByRole("button", { name: NEXT }).first();
  if (await next.count()) {
    await Promise.all([
      next.click({ timeout: 8000 }).catch(() => {}),
      next.click({ force: true, timeout: 8000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(1500);
    toasts = await readToasts();
    if (toasts.length) problems.push(`Q${q} toast after NEXT: ${toasts.join(" | ")}`);
  }

  const newProblems = problems.slice(before);
  console.log(`Q${q}: done${newProblems.length ? ` ⚠️ ${newProblems.length}` : ""}`);
  newProblems.forEach((p) => console.log("    ", p));
}

const final = (
  await sql(
    `select status, cleared_questions, coin_reward, result from crorepati_attempts where guest_id=$1 order by started_at desc limit 1`,
    [guest],
  )
)[0];

console.log("\n============ STRESS SUMMARY ============");
console.log("final:", JSON.stringify(final));
console.log("problems:", problems.length);
problems.slice(0, 40).forEach((p) => console.log(" -", p));

await browser.close();
await DB.end();
