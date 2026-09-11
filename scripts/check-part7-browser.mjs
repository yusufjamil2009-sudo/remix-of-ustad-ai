import { chromium } from "playwright";
import pg from "pg";
const DB = new pg.Client({ host: "/tmp", port: 55432, user: "postgres", database: "ustad" });
await DB.connect();
const sql = async (q, p = []) => (await DB.query(q, p)).rows;
const BASE = "http://localhost:5173";
let pass = 0,
  fail = 0;
const ck = (id, d, ok, det = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${id} — ${d}${det ? ` (${det})` : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cookieOf = async (c) =>
  (await c.cookies()).find((x) => x.name === "ustad.guest")?.value ?? null;
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(4000);
let tok1 = await cookieOf(ctx);
for (let i = 0; i < 5 && !tok1; i++) {
  await page.goto(`${BASE}/?s=${Date.now()}`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(4000);
  tok1 = await cookieOf(ctx);
}
const guest1 = tok1?.split(".")[0];
ck("P7-02a", "a real guest identity is issued", /^guest_[a-f0-9]{16}$/.test(guest1 ?? ""), guest1);

// GUEST ID must survive refresh
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const guest2 = (await cookieOf(ctx))?.split(".")[0];
ck("P7-02b", "Guest ID is the SAME after refresh", guest1 === guest2, `${guest1} === ${guest2}`);

// fund + buy through the REAL server engine
const { applyCoins, getWallet, buyItem } = await import("../src/lib/wallet.server.ts");
const { issueToken } = await import("../src/lib/guest.server.ts");
const tok = await issueToken(guest1);
await applyCoins({
  guestId: guest1,
  source: "crorepati",
  refId: "browser-win",
  amount: 100000,
  note: "Crorepati Q3",
});

// Profile tab shows the authoritative balance
const openProfile = async (p) => {
  await p.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await p.waitForTimeout(2500);
  await p
    .getByRole("tab", { name: /^profile$/i })
    .click()
    .catch(() => {});
  await p.waitForTimeout(3500);
  return (await p.textContent("body")) ?? "";
};
let body = await openProfile(page);
ck("P7-32a", "the Profile shows the wallet balance", /1,00,000/.test(body), "1,00,000 visible");
ck("P7-32b", "Coin History lists the earning", /Crorepati Q3|Kon Banega Crorepati/i.test(body));

// SHOP in the existing navigation
await page.goto(`${BASE}/shop`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(4000);
const shopBody = (await page.textContent("body")) ?? "";
ck("P7-14", "USTAD Shop is reachable and in the existing nav", /USTAD Shop/i.test(shopBody));
const navHasShop = await page.getByRole("link", { name: /USTAD Shop/i }).count();
ck(
  "P7-14b",
  "the shop link lives in the existing navigation",
  navHasShop > 0,
  `${navHasShop} link(s)`,
);
ck(
  "P7-15",
  "the shop header shows the current coin balance",
  /1,00,000 USTAD Coins/.test(shopBody),
);
ck(
  "P7-15b",
  "shop categories are listed",
  /Avatar Frames/i.test(shopBody) && /Feature Unlocks/i.test(shopBody),
);
ck("P7-16", "exact prices are shown", /25,000 USTAD Coins/.test(shopBody));
ck("P7-26", "no real-money strings anywhere in the shop", !/₹|\bINR\b|\bUSD\b|\$\d/.test(shopBody));

// REAL BROWSER PURCHASE
await page.getByTestId("shop-buy-avatar_basic").click();
await page.waitForTimeout(5000);
const afterBuy = (await page.textContent("body")) ?? "";
ck(
  "P7-29",
  "a real browser purchase completes",
  /75,000 USTAD Coins/.test(afterBuy),
  "balance now 75,000",
);
const dbAfter = Number(
  (await sql("select current_balance from ustad_wallets where guest_id=$1", [guest1]))[0]
    .current_balance,
);
ck("P7-06c", "the database deducted exactly 25,000", dbAfter === 75000, `${dbAfter}`);

// REFRESH
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4500);
const afterRefresh = (await page.textContent("body")) ?? "";
ck("P7-31a", "REFRESH keeps the deducted balance", /75,000 USTAD Coins/.test(afterRefresh));
ck(
  "P7-31b",
  "Guest ID unchanged after purchase + refresh",
  (await cookieOf(ctx))?.split(".")[0] === guest1,
);

// CLOSE THE APP AND REOPEN (new page, same browser profile/cookies)
await page.close();
const page2 = await ctx.newPage();
await page2.goto(`${BASE}/shop`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page2.waitForTimeout(4500);
const reopened = (await page2.textContent("body")) ?? "";
ck("P7-31c", "REOPENING the app keeps the balance", /75,000 USTAD Coins/.test(reopened));
ck("P7-31d", "REOPENING keeps the same Guest ID", (await cookieOf(ctx))?.split(".")[0] === guest1);
ck("P7-25", "the purchased item shows as Owned", /Owned/.test(reopened));

// A BRAND NEW BROWSER SESSION with the SAME guest cookie = same wallet
const ctx2 = await browser.newContext();
await ctx2.addCookies([{ name: "ustad.guest", value: tok1, domain: "localhost", path: "/" }]);
const page3 = await ctx2.newPage();
await page3.goto(`${BASE}/shop`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page3.waitForTimeout(4500);
ck(
  "P7-31e",
  "a fresh browser session with the same identity sees the same wallet",
  /75,000 USTAD Coins/.test((await page3.textContent("body")) ?? ""),
);

// browser cannot write to wallet tables
const probe = async (t, payload) =>
  page3.evaluate(
    async ([tb, p]) => {
      try {
        const r = await fetch(`/rest/v1/${tb}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(p),
        });
        return r.status;
      } catch {
        return 0;
      }
    },
    [t, payload],
  );
ck(
  "P7-34f",
  "the browser cannot write to the wallet",
  (await probe("ustad_wallets", { guest_id: guest1, current_balance: 999999999 })) !== 201,
);
ck(
  "P7-34g",
  "the browser cannot forge a purchase",
  (await probe("ustad_purchases", { guest_id: guest1, item_id: "avatar_ultra", price_paid: 0 })) !==
    201,
);
const hacked = Number(
  (await sql("select current_balance from ustad_wallets where guest_id=$1", [guest1]))[0]
    .current_balance,
);
ck("P7-34h", "the balance is untouched after tampering attempts", hacked === 75000, `${hacked}`);

// Parts 1-6 intact
for (const [path, re] of [
  ["/", /USTAD AI/i],
  ["/crorepati", /crorepati/i],
  ["/mega", /mega/i],
  ["/events", /event/i],
  ["/settings", /settings|profile/i],
]) {
  const r = await page3.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page3.waitForTimeout(1800);
  ck(
    `P7-REG${path}`,
    `${path} still works`,
    r.status() === 200 && re.test((await page3.textContent("body")) ?? ""),
  );
}

// responsive
for (const [name, vp] of [
  ["mobile", { width: 390, height: 844 }],
  ["tablet", { width: 820, height: 1180 }],
  ["desktop", { width: 1440, height: 900 }],
]) {
  await page3.setViewportSize(vp);
  await page3.goto(`${BASE}/shop`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page3.waitForTimeout(2200);
  const of = await page3.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ck(`P7-resp-${name}`, `shop has no horizontal overflow on ${name}`, of <= 12, `+${of}px`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
await DB.end();
