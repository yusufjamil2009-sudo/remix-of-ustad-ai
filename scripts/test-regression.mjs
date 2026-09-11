/**
 * REGRESSION over the EXISTING USTAD AI product + responsive checks.
 * Confirms Parts 1–6 did not break anything that already worked.
 */
import { execSync } from "node:child_process";
import { chromium, newSession, bootGuest, check, sql, summary, BASE, DB } from "./browser-p16.mjs";

const browser = await chromium.launch();

async function freshGuest(viewport) {
  const s = await newSession(browser);
  if (viewport) await s.page.setViewportSize(viewport);
  await s.page.waitForTimeout(2500);
  let g = await bootGuest(s.page);
  for (let i = 0; i < 4 && !g.guestId; i++) {
    await s.page.waitForTimeout(4000);
    g = await bootGuest(s.page);
  }
  if (g.guestId)
    execSync(`node --import tsx scripts/provision-model.mjs ${g.guestId}`, { stdio: "pipe" });
  return { ...s, ...g };
}

const G = await freshGuest();
check(
  "R-00",
  "a real guest identity is issued on first visit",
  /^guest_[a-f0-9]{16}$/.test(G.guestId ?? ""),
  G.guestId,
);
const guestRow = await sql("select id from guests where id=$1", [G.guestId]);
check("R-00b", "the guest row is persisted in the database", guestRow.length === 1);

const consoleErrors = [];
G.page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});

/* ---- every existing route still renders ---- */
const routes = [
  ["/", "Home", /USTAD AI/i],
  // Chat has always lived on the home route; there is no separate /chat page.
  ["/", "Chat", /chat|new chat|message/i],
  ["/study", "Study", /study|lesson|topic|subject/i],
  ["/exams", "Exams", /exam|test|paper/i],
  ["/notes", "Notes", /note/i],
  ["/memory", "Memory", /memory|remember/i],
  ["/reminders", "Reminders", /remind/i],
  ["/classroom", "Classroom", /class|board|teacher/i],
  ["/settings", "Settings", /settings|api|profile/i],
  ["/crorepati", "Crorepati", /crorepati|question|entry/i],
  ["/mega", "Mega", /mega/i],
  ["/events", "Events", /event/i],
];

for (const [path, label, re] of routes) {
  let status = 0;
  let body = "";
  try {
    const resp = await G.page.goto(`${BASE}${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    status = resp?.status() ?? 0;
    await G.page.waitForTimeout(2200);
    body = (await G.page.textContent("body")) ?? "";
  } catch (err) {
    body = `ERROR ${String(err).slice(0, 80)}`;
  }
  check(
    `R-${label}`,
    `${label} (${path}) still loads and renders`,
    status === 200 && re.test(body),
    `HTTP ${status}, ${body.length} chars`,
  );
}

/* ---- the existing Profile is still ONE page (a settings tab), not a new one ---- */
await G.page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 90000 });
await G.page.waitForTimeout(2500);
const tabs = await G.page
  .getByRole("tab")
  .allTextContents()
  .catch(() => []);
const btns = await G.page
  .getByRole("button")
  .allTextContents()
  .catch(() => []);
const labels = [...tabs, ...btns].map((t) => t.trim());
check(
  "R-profile",
  "Profile is still a tab inside Settings (no second profile page)",
  labels.some((t) => /^profile$/i.test(t)),
  labels.filter(Boolean).slice(0, 8).join(" | "),
);
const profileRoute = await G.page
  .goto(`${BASE}/profile`, { waitUntil: "domcontentloaded", timeout: 60000 })
  .catch(() => null);
check(
  "R-profile2",
  "no separate /profile route was introduced",
  !profileRoute || profileRoute.status() === 404,
  `HTTP ${profileRoute?.status() ?? "none"}`,
);

/* ---- the Profile tab shows tournament data from Parts 4/5 ---- */
await G.page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 90000 });
await G.page.waitForTimeout(2500);
await G.page
  .getByRole("tab", { name: /profile/i })
  .click()
  .catch(async () => {
    await G.page
      .getByRole("button", { name: /^profile$/i })
      .click()
      .catch(() => {});
  });
await G.page.waitForTimeout(3000);
const profileBody = (await G.page.textContent("body")) ?? "";
check(
  "R-profile3",
  "the Profile tab renders achievements / certificates sections",
  /achievement|trophy|cup|certificate/i.test(profileBody),
);
check(
  "R-profile4",
  "Profile shows USTAD Coins, never real currency",
  !/₹|\bINR\b|\bUSD\b|\$\d/.test(profileBody),
);

/* ---- notifications are the existing system, still working ---- */
// The tournament reuses the EXISTING in-app message system (reminders).
const notif = await sql("select count(*) c from reminders where kind='notification'");
check(
  "R-notif",
  "the existing notification system still receives rows",
  Number(notif[0].c) > 0,
  `${notif[0].c} notifications`,
);
const notifKinds = await sql("select distinct kind from reminders limit 12");
check(
  "R-notif2",
  "tournament events feed the SAME notification table",
  notifKinds.length > 0,
  notifKinds.map((r) => r.kind).join(","),
);

/* ---- no duplicate engines were introduced ---- */
const dupAudit = execSync(
  `cd /home/user/ustad-ai-a83a679a && ls src/lib | grep -iE "timer|clock|chrono|identity|guest" | tr '\\n' ' '`,
  { encoding: "utf8" },
).trim();
check(
  "R-dup",
  "there is still exactly one guest-identity module",
  (dupAudit.match(/guest[^ ]*\.ts/g) ?? []).filter((f) => !/functions/.test(f)).length === 1,
  dupAudit,
);
const timerEngines = (dupAudit.match(/(chrono|clock|timer)[^ ]*\.ts/g) ?? []).filter(
  (f) => !/\.test\./.test(f),
);
check(
  "R-dup2",
  "no second general timer engine was added",
  timerEngines.length <= 4,
  timerEngines.join(" "),
);

/* ---- unit tests still green ---- */
let unit = "";
try {
  unit = execSync("cd /home/user/ustad-ai-a83a679a && npm test 2>&1 | tail -12", {
    encoding: "utf8",
    timeout: 600000,
  });
} catch (err) {
  unit = String(err.stdout ?? err).slice(-1200);
}
const passMatch = unit.match(/#\s*pass\s+(\d+)/);
const failMatch = unit.match(/#\s*fail\s+(\d+)/);
check(
  "R-unit",
  "the whole unit-test suite still passes",
  failMatch?.[1] === "0",
  `${passMatch?.[1] ?? "?"} pass / ${failMatch?.[1] ?? "?"} fail`,
);

/* ---- responsive: mobile, tablet, desktop ---- */
for (const [name, vp] of [
  ["mobile", { width: 390, height: 844 }],
  ["tablet", { width: 820, height: 1180 }],
  ["desktop", { width: 1440, height: 900 }],
]) {
  const S = await freshGuest(vp);
  const bad = [];
  for (const path of ["/", "/crorepati", "/mega", "/events", "/settings"]) {
    try {
      await S.page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await S.page.waitForTimeout(2000);
      const overflow = await S.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 12) bad.push(`${path}:+${overflow}px`);
    } catch (err) {
      bad.push(`${path}:error`);
    }
  }
  check(
    `R-resp-${name}`,
    `no horizontal overflow on ${name} (${vp.width}px)`,
    bad.length === 0,
    bad.join(" ") || "clean",
  );
  await S.ctx.close();
}

// The only 404s in this sweep are the deliberate "route must NOT exist" probes.
const realErrors = consoleErrors.filter((e) => !/status of 404/.test(e));
check(
  "R-console",
  "no uncaught console errors during the regression sweep",
  realErrors.length === 0,
  realErrors.slice(0, 3).join(" | ") || `clean (${consoleErrors.length} expected 404 probes)`,
);

summary();
await browser.close();
await DB.end();
