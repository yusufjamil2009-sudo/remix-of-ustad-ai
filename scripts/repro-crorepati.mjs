/**
 * Reproduce the reported Crorepati bug: "answering one question then clicking
 * the next question / an option throws an error".
 *
 * Plays a FULL 20-question game in a real browser against the real engine,
 * clicking real option cards, and captures every toast, console error and
 * failed request along the way.
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

const errors = [];
const toasts = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("response", async (r) => {
  if (r.status() >= 400 && !r.url().includes("favicon")) {
    let body = "";
    try {
      body = (await r.text()).slice(0, 400);
    } catch {
      /* stream already consumed */
    }
    errors.push(`HTTP ${r.status()} ${r.url().split("/").slice(-1)[0]} :: ${body}`);
  }
});

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

// Real model provider, real generation path.
const { execSync } = await import("node:child_process");
execSync(`node --import tsx scripts/provision-model.mjs ${guest}`, { stdio: "inherit" });

// Give the guest coins so entry is never the blocker.
const { applyCoins } = await import("../src/lib/wallet.server.ts");
await applyCoins({
  guestId: guest,
  source: "admin",
  refId: `repro-${Date.now()}`,
  amount: 50000000,
  note: "repro funding",
});

await page.goto(`${BASE}/crorepati`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3000);

// Start.
const startBtn = page.getByRole("button", { name: /start|play|khel/i }).first();
if (await startBtn.count()) {
  await startBtn.click();
  console.log("clicked start; generating 20 questions…");
  await page.waitForTimeout(25000);
}

const answered = [];
for (let q = 1; q <= 20; q++) {
  // Wait out the 10s pre-answer animation until options are enabled.
  let ready = false;
  for (let w = 0; w < 30; w++) {
    const opts = page.locator("button[aria-label^='Option ']");
    const n = await opts.count();
    if (n >= 4) {
      const enabled = await opts
        .first()
        .isEnabled()
        .catch(() => false);
      if (enabled) {
        ready = true;
        break;
      }
    }
    await page.waitForTimeout(1000);
  }
  if (!ready) {
    console.log(`Q${q}: options never became clickable`);
    break;
  }

  // Ask the DB for the correct option so we can actually reach Q20.
  const row = (
    await sql(
      `select aq.question_number, aq.correct_index
         from crorepati_attempt_questions aq
         join crorepati_attempts a on a.id = aq.attempt_id
        where a.guest_id = $1 and a.status = 'active' and aq.question_number = $2`,
      [guest, q],
    )
  )[0];
  if (!row) {
    console.log(`Q${q}: no active attempt row`);
    break;
  }

  const before = errors.length;
  const opts = page.locator("button[aria-label^='Option ']");
  await opts.nth(Number(row.correct_index)).click();
  await page.waitForTimeout(2500);

  const toast = await page
    .locator("[data-sonner-toast], [role='status'], .toast")
    .allTextContents()
    .catch(() => []);
  if (toast.length) toasts.push(`Q${q}: ${toast.join(" | ")}`);

  const newErrors = errors.slice(before);
  answered.push(q);
  console.log(
    `Q${q}: answered${newErrors.length ? ` ⚠️ ${newErrors.length} error(s)` : ""}${toast.length ? ` toast=${toast.join(" ")}` : ""}`,
  );
  if (newErrors.length) newErrors.forEach((e) => console.log("   ", e));

  // Advance.
  const next = page.getByRole("button", { name: /next|aage|continue/i }).first();
  if (await next.count()) {
    const b2 = errors.length;
    await next.click();
    await page.waitForTimeout(2500);
    const ne = errors.slice(b2);
    if (ne.length) {
      console.log(`Q${q}→Q${q + 1}: ⚠️ NEXT click produced ${ne.length} error(s)`);
      ne.forEach((e) => console.log("   ", e));
    }
  }

  const st = (
    await sql(
      `select status, current_question, cleared_questions from crorepati_attempts where guest_id=$1 order by started_at desc limit 1`,
      [guest],
    )
  )[0];
  if (st?.status !== "active") {
    console.log(`game ended after Q${q}: status=${st?.status} cleared=${st?.cleared_questions}`);
    break;
  }
}

const final = (
  await sql(
    `select status, cleared_questions, coin_reward, result from crorepati_attempts where guest_id=$1 order by started_at desc limit 1`,
    [guest],
  )
)[0];

console.log("\n================ SUMMARY ================");
console.log("questions answered:", answered.length);
console.log("final attempt:", JSON.stringify(final));
console.log("total errors captured:", errors.length);
errors.slice(0, 25).forEach((e) => console.log(" -", e));
console.log("toasts:", toasts.length);
toasts.slice(0, 25).forEach((t) => console.log(" -", t));

await browser.close();
await DB.end();
