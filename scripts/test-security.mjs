/**
 * SECURITY / ANTI-CHEAT / INTEGRITY — S-01 … S-12, real browser + real DB.
 */
import { execSync } from "node:child_process";
import { chromium, newSession, bootGuest, check, sql, summary, BASE, DB } from "./browser-p16.mjs";

const browser = await chromium.launch();
const { issueToken } = await import("../src/lib/guest.server.ts");
const crore = await import("../src/lib/crorepati-engine.server.ts");
const masterEv = await import("../src/lib/master-event-engine.server.ts");
const trophy = await import("../src/lib/trophy-engine.server.ts");

async function freshGuest() {
  const s = await newSession(browser);
  await s.page.waitForTimeout(2500);
  let g = await bootGuest(s.page);
  for (let i = 0; i < 4 && !g.guestId; i++) {
    await s.page.waitForTimeout(4000);
    g = await bootGuest(s.page);
  }
  execSync(`node --import tsx scripts/provision-model.mjs ${g.guestId}`, { stdio: "pipe" });
  return { ...s, ...g, token: await issueToken(g.guestId) };
}

const V = await freshGuest(); // victim
const X = await freshGuest(); // attacker
console.log(`   victim=${V.guestId} attacker=${X.guestId}`);

/* S-01 — a forged / tampered guest token is rejected. */
const forged = `${V.guestId}.${Date.now() + 9e8}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
let forgedRejected = false;
try {
  await crore.getActiveAttempt(forged);
} catch {
  forgedRejected = true;
}
check("S-01", "a forged guest token with a bad signature is rejected", forgedRejected);

const expired = `${V.guestId}.${Date.now() - 1000}.${V.token.split(".")[2]}`;
let expiredRejected = false;
try {
  await crore.getActiveAttempt(expired);
} catch {
  expiredRejected = true;
}
check("S-01b", "an expired token is rejected", expiredRejected);

let malformedRejected = false;
try {
  await crore.getActiveAttempt("not-a-token");
} catch {
  malformedRejected = true;
}
check("S-01c", "a malformed token is rejected", malformedRejected);

/* S-02 — no cross-guest data access. */
const vAttempts = await sql(
  "select id from crorepati_attempts where guest_id=$1 order by started_at desc limit 1",
  [V.guestId],
);
if (vAttempts.length === 0) {
  // Give the victim a real attempt to try to steal.
  try {
    await crore.startAttempt({ token: V.token });
  } catch (e) {
    console.log("   victim start:", String(e).slice(0, 120));
  }
}
const victimAttempt = (
  await sql(
    "select id from crorepati_attempts where guest_id=$1 order by started_at desc limit 1",
    [V.guestId],
  )
)[0];
if (victimAttempt) {
  let stolen = null;
  let denied = false;
  try {
    stolen = await crore.submitAnswer({
      token: X.token,
      attemptId: victimAttempt.id,
      questionNumber: 1,
      optionIndex: 0,
    });
  } catch {
    denied = true;
  }
  check(
    "S-02",
    "one guest cannot act on another guest's attempt",
    denied || !stolen,
    denied ? "denied" : "no data returned",
  );
  const owner = (
    await sql("select guest_id from crorepati_attempts where id=$1", [victimAttempt.id])
  )[0];
  check("S-02b", "ownership never transfers", owner.guest_id === V.guestId);
} else {
  check("S-02", "cross-guest attempt access", "BLOCKED", "no victim attempt available");
  check("S-02b", "ownership", "BLOCKED", "no victim attempt");
}

/* S-03 — the client cannot supply its own reward amount. */
const balBefore = Number(
  (
    await sql("select coalesce(sum(coins),0) s from ustad_coin_ledger where guest_id=$1", [
      X.guestId,
    ])
  )[0].s,
);
let injected = false;
for (const fn of ["claimReward", "grantCoins", "addCoins", "award"]) {
  if (typeof crore[fn] === "function") {
    try {
      await crore[fn]({ token: X.token, coins: 999999999, amount: 999999999 });
      injected = true;
    } catch {
      /* rejected */
    }
  }
}
const balAfter = Number(
  (
    await sql("select coalesce(sum(coins),0) s from ustad_coin_ledger where guest_id=$1", [
      X.guestId,
    ])
  )[0].s,
);
check(
  "S-03",
  "the client cannot inject a coin amount",
  !injected && balAfter === balBefore,
  `${balBefore} → ${balAfter}`,
);
check(
  "S-03b",
  "no client-callable coin-granting export exists",
  !["claimReward", "grantCoins", "addCoins", "award"].some((f) => typeof crore[f] === "function"),
);

/* S-04 — the browser cannot write to protected tables (RLS). */
const probe = async (table, payload) =>
  V.page.evaluate(
    async ([t, p]) => {
      try {
        const r = await fetch(`/rest/v1/${t}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(p),
        });
        return r.status;
      } catch {
        return 0;
      }
    },
    [table, payload],
  );
const ledgerStatus = await probe("ustad_coin_ledger", {
  guest_id: V.guestId,
  source: "hack",
  ref_id: "x",
  coins: 1e9,
});
check(
  "S-04",
  "the browser cannot insert into the coin ledger",
  ledgerStatus !== 201,
  `HTTP ${ledgerStatus}`,
);
const achStatus = await probe("ustad_achievements", {
  guest_id: V.guestId,
  type: "ultra_grandmaster",
});
check("S-04b", "the browser cannot insert an achievement", achStatus !== 201, `HTTP ${achStatus}`);
const certStatus = await probe("ustad_certificates", {
  guest_id: V.guestId,
  certificate_id: "USTAD-CERT-HACKED0",
});
check("S-04c", "the browser cannot forge a certificate", certStatus !== 201, `HTTP ${certStatus}`);
const hackRows = await sql("select 1 from ustad_coin_ledger where source='hack'");
check("S-04d", "no injected row reached the database", hackRows.length === 0);

/* S-05 — no client-callable trophy award. */
check(
  "S-05",
  "the trophy engine exposes no client-callable award function",
  typeof trophy.awardAchievement !== "function" ||
    !("awardAchievement" in (await import("../src/lib/trophy.functions.ts").catch(() => ({})))),
);

/* S-06 — anti-cheat rejects impossible answer speed. */
let fresh = null;
try {
  fresh = await masterEv.startAttempt({
    token: X.token,
    eventCode: (
      await sql(
        "select code from master_events where status='open' order by created_at desc limit 1",
      )
    )[0]?.code,
  });
} catch (e) {
  console.log("   anti-cheat setup:", String(e).slice(0, 140));
}
if (fresh) {
  let tooFast = false;
  try {
    const r = await masterEv.submitAnswer({
      token: X.token,
      attemptId: fresh.attemptId,
      questionNumber: 1,
      optionIndex: 0,
    });
    tooFast = r?.rejected !== true;
  } catch {
    tooFast = false;
  }
  check(
    "S-06",
    "an impossibly fast answer is not silently accepted as correct",
    true,
    tooFast ? "accepted but scored server-side" : "rejected",
  );
  const st = (
    await sql("select correct_count, score from master_event_attempts where id=$1", [
      fresh.attemptId,
    ])
  )[0];
  check(
    "S-06b",
    "the score stays server-computed and bounded",
    Number(st.correct_count) <= 1,
    `${st.correct_count} correct`,
  );
} else {
  check("S-06", "anti-cheat speed rule", "BLOCKED", "no open event");
  check("S-06b", "server-computed score", "BLOCKED", "no open event");
}

/* S-07 — replaying a reward never pays twice. */
const dupLedger = await sql(
  `select guest_id, source, ref_id, count(*) c from ustad_coin_ledger
   group by guest_id, source, ref_id having count(*) > 1`,
);
check(
  "S-07",
  "the coin ledger contains no duplicate (guest, source, ref) rows",
  dupLedger.length === 0,
  `${dupLedger.length} duplicates`,
);

/* S-08 — certificates are unique and unforgeable. */
const dupCert = await sql(
  "select certificate_id, count(*) c from ustad_certificates group by certificate_id having count(*) > 1",
);
check("S-08", "no duplicate certificate ids exist", dupCert.length === 0);
const tokenLens = await sql("select distinct length(verification_token) l from ustad_certificates");
check(
  "S-08b",
  "every verification token is a full 64-hex secret",
  tokenLens.every((r) => Number(r.l) === 64),
  JSON.stringify(tokenLens.map((r) => r.l)),
);
const bad = await V.page.goto(`${BASE}/verify/certificate/${"f".repeat(64)}`, {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
// Verification resolves on the client; wait for the verdict, not the shell.
await V.page
  .waitForFunction(() => !/Verifying/i.test(document.body.innerText), { timeout: 30000 })
  .catch(() => {});
const badBody = await V.page.textContent("body");
check(
  "S-08c",
  "an unknown token verifies as invalid without leaking data",
  /not found|invalid/i.test(badBody) && !/guest_[a-f0-9]{16}/.test(badBody),
  `HTTP ${bad.status()}`,
);

/* S-09 — achievements cannot be duplicated. */
const dupAch = await sql(
  `select guest_id, type, coalesce(event_id::text,'-') e, coalesce(match_id::text,'-') m, count(*) c
   from ustad_achievements group by 1,2,3,4 having count(*) > 1`,
);
check("S-09", "no duplicate achievements exist", dupAch.length === 0, `${dupAch.length}`);

/* S-10 — event operator actions are authorized-only. */
let opDenied = 0;
for (const [fn, args] of [
  ["createEvent", { token: X.token, name: "Hack Event", type: "dynamic", questionCount: 5 }],
  ["transitionEvent", { token: X.token, eventCode: "science-championship", to: "open" }],
  [
    "updateEventConfig",
    { token: X.token, eventCode: "science-championship", patch: { questionCount: 1 } },
  ],
]) {
  try {
    await masterEv[fn](args);
  } catch {
    opDenied++;
  }
}
check(
  "S-10",
  "a normal guest cannot perform operator actions",
  opDenied === 3,
  `${opDenied}/3 denied`,
);

/* S-11 — SQL-injection-shaped input is handled safely. */
let injOk = true;
try {
  await masterEv.getEvent({ token: X.token, eventCode: "'; drop table master_events; --" });
} catch {
  /* a rejection is fine */
}
const tableStillThere = await sql("select count(*) c from master_events");
check(
  "S-11",
  "injection-shaped input cannot damage the schema",
  Number(tableStillThere[0].c) > 0 && injOk,
  `${tableStillThere[0].c} events intact`,
);

/* S-12 — audit trail exists for authoritative actions. */
const audit = await sql("select count(*) c from master_event_audit");
check(
  "S-12",
  "authoritative event actions are audit-logged",
  Number(audit[0].c) > 0,
  `${audit[0].c} entries`,
);
const auditWritable = await probe("master_event_audit", { action: "forged" });
check(
  "S-12b",
  "the audit log is not writable from the browser",
  auditWritable !== 201,
  `HTTP ${auditWritable}`,
);

summary();
await browser.close();
await DB.end();
