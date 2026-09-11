import pg from "pg";
const DB = new pg.Client({ host: "/tmp", port: 55432, user: "postgres", database: "ustad" });
await DB.connect();
const sql = async (q, p = []) => (await DB.query(q, p)).rows;
let pass = 0,
  fail = 0;
const ck = (id, d, ok, det = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${id} — ${d}${det ? ` (${det})` : ""}`);
};

const g =
  "guest_" + [...Array(16)].map(() => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
await sql("insert into guests (id) values ($1)", [g]);

const { applyCoins, getWallet, buyItem } =
  await import("/home/user/ustad-ai-a83a679a/src/lib/wallet.server.ts");
const { issueToken } = await import("/home/user/ustad-ai-a83a679a/src/lib/guest.server.ts");
const tok = await issueToken(g);

// exact ladder + fixed costs
const lad = await sql(
  "select question_number qn, coins from crorepati_rewards where question_number in (1,2,3,20) order by qn",
);
const m = Object.fromEntries(lad.map((r) => [r.qn, Number(r.coins)]));
ck(
  "P7-10",
  "Crorepati ladder Q1/Q2/Q3/Q20 exact",
  m[1] === 10000 && m[2] === 50000 && m[3] === 100000 && m[20] === 100000000,
  `${m[1]}/${m[2]}/${m[3]}/${m[20]}`,
);
const mp = Number((await sql("select pass_cost from mega_events limit 1"))[0].pass_cost);
ck("P7-13", "Mega pass = 4 crore coins", mp === 40000000, String(mp));

// reward -> permanent wallet
await applyCoins({ guestId: g, source: "crorepati", refId: "att-1", amount: 10000, note: "Q1" });
await applyCoins({ guestId: g, source: "crorepati", refId: "att-2", amount: 50000, note: "Q2" });
let w = await getWallet(g);
ck("P7-08", "rewards saved to the permanent wallet", w.balance === 60000, `${w.balance}`);
const dbBal = Number(
  (await sql("select current_balance from ustad_wallets where guest_id=$1", [g]))[0]
    .current_balance,
);
ck("P7-03", "the DATABASE holds the authoritative balance", dbBal === 60000, `${dbBal}`);

// duplicate reward protection
const r2 = await applyCoins({
  guestId: g,
  source: "crorepati",
  refId: "att-1",
  amount: 10000,
  note: "Q1 replay",
});
w = await getWallet(g);
ck(
  "P7-09",
  "a replayed reward never credits twice",
  r2.applied === false && w.balance === 60000,
  `${w.balance}`,
);

// purchase: exact deduction 1,00,000 -> 25,000 item -> 75,000
await applyCoins({ guestId: g, source: "test", refId: "fund", amount: 40000, note: "top-up" });
w = await getWallet(g);
ck("P7-06a", "balance is 1,00,000 before purchase", w.balance === 100000, `${w.balance}`);
const buy = await buyItem({ token: tok, itemId: "avatar_basic" });
w = await getWallet(g);
ck(
  "P7-06",
  "25,000 item leaves exactly 75,000",
  buy.pricePaid === 25000 && w.balance === 75000,
  `${w.balance}`,
);
const persisted = Number(
  (await sql("select current_balance from ustad_wallets where guest_id=$1", [g]))[0]
    .current_balance,
);
ck(
  "P7-07",
  "75,000 is persisted in the database, not just the UI",
  persisted === 75000,
  `${persisted}`,
);
const own = await sql(
  "select * from ustad_purchases where guest_id=$1 and item_id='avatar_basic'",
  [g],
);
ck(
  "P7-28",
  "a permanent purchase + ownership record exists",
  own.length === 1 && own[0].ownership_status === "owned",
);
const tx = await sql(
  "select direction, balance_before, balance_after, tx_type from ustad_coin_ledger where guest_id=$1 and source='shop'",
  [g],
);
ck(
  "P7-05",
  "the transaction records direction and before/after balance",
  tx.length === 1 &&
    tx[0].direction === "SPEND" &&
    Number(tx[0].balance_before) === 100000 &&
    Number(tx[0].balance_after) === 75000,
  `${tx[0]?.balance_before}→${tx[0]?.balance_after}`,
);

// double purchase must not double-charge
const again = await buyItem({ token: tok, itemId: "avatar_basic" });
w = await getWallet(g);
ck(
  "P7-30a",
  "buying an owned item does not charge again",
  again.alreadyOwned === true && w.balance === 75000,
  `${w.balance}`,
);

// concurrent double-click
const before = (await getWallet(g)).balance;
await Promise.allSettled([
  buyItem({ token: tok, itemId: "profile_simple" }),
  buyItem({ token: tok, itemId: "profile_simple" }),
]);
w = await getWallet(g);
const rows = await sql(
  "select count(*) c from ustad_purchases where guest_id=$1 and item_id='profile_simple'",
  [g],
);
ck(
  "P7-34a",
  "two simultaneous purchases charge only once",
  Number(rows[0].c) === 1 && w.balance === before - 10000,
  `${before}→${w.balance}`,
);

// failed purchase must not lose coins
const bal0 = (await getWallet(g)).balance;
let failed = false;
try {
  await buyItem({ token: tok, itemId: "avatar_ultra" });
} catch {
  failed = true;
}
const bal1 = (await getWallet(g)).balance;
ck(
  "P7-30",
  "an unaffordable purchase fails and loses NO coins",
  failed && bal0 === bal1,
  `${bal0} → ${bal1}`,
);
const ghost = await sql(
  "select count(*) c from ustad_purchases where guest_id=$1 and item_id='avatar_ultra'",
  [g],
);
ck("P7-30b", "the failed purchase granted no item", Number(ghost[0].c) === 0);

// client cannot supply a price / amount
const { shopBuyFn } = await import("/home/user/ustad-ai-a83a679a/src/lib/wallet.functions.ts");
const bal2 = (await getWallet(g)).balance;
try {
  await buyItem({ token: tok, itemId: "avatar_gold", price: 1, priceCoins: 1, amount: 1 });
} catch {}
const goldRow = await sql(
  "select price_paid from ustad_purchases where guest_id=$1 and item_id='avatar_gold'",
  [g],
);
ck(
  "P7-34b",
  "a client-supplied price is ignored (server price wins)",
  goldRow.length === 0 || Number(goldRow[0].price_paid) === 250000,
  goldRow.length ? String(goldRow[0].price_paid) : "unaffordable→refused",
);

// negative / huge amounts
let negBlocked = false,
  hugeBlocked = false;
try {
  await applyCoins({ guestId: g, source: "hack", refId: "n1", amount: -999999999999999 });
} catch {
  negBlocked = true;
}
try {
  await applyCoins({ guestId: g, source: "hack", refId: "h1", amount: 1e15 });
} catch {
  hugeBlocked = true;
}
ck("P7-34c", "negative overdraft and absurd amounts are rejected", negBlocked && hugeBlocked);
const wallNeg = await sql("select count(*) c from ustad_wallets where current_balance < 0");
ck("P7-34d", "no wallet in the database is negative", Number(wallNeg[0].c) === 0);

// cross-guest
const g2 =
  "guest_" + [...Array(16)].map(() => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
await sql("insert into guests (id) values ($1)", [g2]);
const tok2 = await issueToken(g2);
let denied = false;
try {
  await buyItem({ token: tok2, itemId: "avatar_gold" });
} catch {
  denied = true;
}
const g2own = await sql("select count(*) c from ustad_purchases where guest_id=$1", [g2]);
ck("P7-34e", "Guest B cannot buy using Guest A's coins", denied && Number(g2own[0].c) === 0);

// one wallet per guest
const dup = await sql(
  "select guest_id, count(*) c from ustad_wallets group by guest_id having count(*)>1",
);
ck("P7-04", "exactly ONE wallet per guest", dup.length === 0);
// wallet never drifts from the ledger
const drift = await sql(
  "select count(*) c from (select w.guest_id from ustad_wallets w join (select guest_id,sum(coins) s from ustad_coin_ledger where status='completed' group by 1) l on l.guest_id=w.guest_id where w.current_balance <> greatest(l.s,0)) x",
);
ck(
  "P7-02",
  "no wallet drifts from its ledger history",
  Number(drift[0].c) === 0,
  `${drift[0].c} drifting`,
);

console.log(`\n${pass} passed, ${fail} failed`);
console.log("GUEST=" + g);
await DB.end();
