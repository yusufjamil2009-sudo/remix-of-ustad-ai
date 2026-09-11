/**
 * The exact 15-step acceptance test for the chat width bug, plus long-message
 * and long-model-name stress, plus desktop/tablet regression.
 */
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import pg from "pg";

const BASE = "http://localhost:5173";
const DB = new pg.Client({ host: "/tmp", port: 55432, user: "postgres", database: "ustad" });
await DB.connect();

let pass = 0;
let fail = 0;
const ck = (id, what, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${id} — ${what}${detail ? ` :: ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(7000);
let tok = (await ctx.cookies()).find((c) => c.name === "ustad.guest")?.value ?? null;
for (let i = 0; i < 6 && !tok; i++) {
  await page.goto(`${BASE}/?s=${Date.now()}`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(4000);
  tok = (await ctx.cookies()).find((c) => c.name === "ustad.guest")?.value ?? null;
}
const guest = tok.split(".")[0];
execSync(`node --import tsx scripts/provision-model.mjs ${guest}`, { stdio: "ignore" });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

const geo = () =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const el = (s) => document.querySelector(s);
    const w = (s) => {
      const e = el(s);
      return e ? Math.round(e.getBoundingClientRect().width) : null;
    };
    const r = (s) => {
      const e = el(s);
      return e ? Math.round(e.getBoundingClientRect().right) : null;
    };
    return {
      vw,
      overflow: document.documentElement.scrollWidth - vw,
      aside: w("aside"),
      asideRight: r("aside"),
      main: w("main"),
      mainRight: r("main"),
      nav: w("nav[aria-label='Primary']"),
    };
  });

const sendMessage = async (text) => {
  const ta = page.locator("textarea").first();
  await ta.click();
  await ta.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(1500);
    const s = (await page.locator("p.truncate").first().textContent()) ?? "";
    if (s.includes("·")) return true;
  }
  return false;
};

/* Steps 1-3: empty chat */
const empty = await geo();
ck(
  "C-01",
  "empty chat: header/rail fills the viewport",
  empty.aside === empty.vw,
  `aside=${empty.aside} vw=${empty.vw}`,
);
ck("C-02", "empty chat: main fills the viewport", empty.main === empty.vw, `main=${empty.main}`);
ck("C-03", "empty chat: no horizontal overflow", empty.overflow <= 0, `overflow=${empty.overflow}`);

/* Steps 4-11: after a real message + real reply */
const replied = await sendMessage("Hi");
ck("C-04", "the AI reply actually arrives", replied);
const after = await geo();
ck(
  "C-05",
  "AFTER message: header/rail still fills the viewport",
  after.aside === after.vw,
  `aside=${after.aside} vw=${after.vw}`,
);
ck(
  "C-06",
  "AFTER message: main still fills the viewport",
  after.main === after.vw,
  `main=${after.main}`,
);
ck(
  "C-07",
  "AFTER message: main still ends at the right edge (no blank strip)",
  after.mainRight === after.vw,
  `right=${after.mainRight}`,
);
ck(
  "C-08",
  "AFTER message: no horizontal overflow",
  after.overflow <= 0,
  `overflow=${after.overflow}`,
);
ck(
  "C-09",
  "layout is identical before and after",
  empty.aside === after.aside && empty.main === after.main,
);

const statusBox = await page.locator("p.truncate").first().boundingBox();
ck(
  "C-10",
  "provider/model status stays inside the viewport",
  statusBox.x + statusBox.width <= after.vw + 1,
  `right=${Math.round(statusBox.x + statusBox.width)}`,
);

const histBox = await page
  .getByRole("button", { name: /History/i })
  .first()
  .boundingBox();
const newBox = await page
  .getByRole("button", { name: /New chat/i })
  .first()
  .boundingBox();
ck(
  "C-11",
  "History / New chat row stays inside the viewport",
  histBox.x >= -1 && newBox.x + newBox.width <= after.vw + 1,
);

// Check the actual message bubbles rather than the whole page text, which
// also contains nav labels and the status line.
const bubbles = await page.locator(".rounded-2xl").allTextContents();
ck(
  "C-12",
  "the user message renders",
  bubbles.some((t) => t.trim() === "Hi"),
  `${bubbles.length} bubbles`,
);
ck("C-13", "the assistant reply renders", bubbles.length >= 2 && bubbles[1].trim().length > 0);

const composer = await page.locator("textarea").first().boundingBox();
ck("C-14", "composer stays inside the viewport", composer.x + composer.width <= after.vw + 1);

/* Steps 12-15: New chat returns to the empty layout, then send again */
await page
  .getByRole("button", { name: /New chat/i })
  .first()
  .click();
await page.waitForTimeout(2500);
const fresh = await geo();
ck(
  "C-15",
  "New chat returns to the correct empty layout",
  fresh.aside === fresh.vw && fresh.overflow <= 0,
  `overflow=${fresh.overflow}`,
);
await sendMessage("Hi again");
const again = await geo();
ck(
  "C-16",
  "the bug does not return on the second message",
  again.overflow <= 0 && again.aside === again.vw,
  `overflow=${again.overflow}`,
);

/* Long message + long model name */
await sendMessage(
  "Explain " + "supercalifragilisticexpialidocious ".repeat(12) + " in great detail please",
);
const longMsg = await geo();
ck(
  "C-17",
  "a very long message does not break the width",
  longMsg.overflow <= 0,
  `overflow=${longMsg.overflow}`,
);

await DB.query(`update api_configs set models=$1 where guest_id=$2`, [
  JSON.stringify([
    "an-extremely-long-provider/model-name-that-should-never-widen-the-page-v2.5-instruct",
  ]),
  guest,
]);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
await sendMessage("Hi");
const longModel = await geo();
ck(
  "C-18",
  "a very long provider/model name does not break the width",
  longModel.overflow <= 0,
  `overflow=${longModel.overflow}`,
);
await DB.query(`update api_configs set models=$1 where guest_id=$2`, [
  JSON.stringify(["mock-quiz-model"]),
  guest,
]);

/* Desktop + tablet regression */
for (const [name, vp] of [
  ["tablet", { width: 820, height: 1180 }],
  ["desktop", { width: 1440, height: 900 }],
  ["wide desktop", { width: 1920, height: 1080 }],
]) {
  await page.setViewportSize(vp);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await sendMessage("Hi");
  const g = await geo();
  ck(
    `C-19 ${name}`,
    "desktop/tablet layout still correct",
    g.overflow <= 0 && g.main + g.aside >= g.vw - 2,
    `overflow=${g.overflow} aside=${g.aside} main=${g.main}`,
  );
}

ck(
  "C-20",
  "no uncaught page errors during the whole run",
  errors.length === 0,
  errors.slice(0, 2).join(" | "),
);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
await DB.end();
process.exit(fail ? 1 : 0);
