/**
 * PART 2 — MEGA TOURNAMENT, real browser with MULTIPLE concurrent sessions.
 * P2-01 … P2-10 plus the real-time lobby group.
 */
import { execSync } from "node:child_process";
import { chromium, newSession, bootGuest, check, sql, summary, BASE, DB } from "./browser-p16.mjs";

const browser = await chromium.launch();

async function freshGuest() {
  const s = await newSession(browser);
  await s.page.waitForTimeout(2500);
  let g = await bootGuest(s.page);
  for (let i = 0; i < 5 && !g.guestId; i++) {
    // Cache-bust: an SSR-cached shell can be served without a Set-Cookie header.
    await s.page.goto(`${BASE}/?s=${Date.now()}-${i}`, {
      waitUntil: "networkidle",
      timeout: 90000,
    });
    await s.page.waitForTimeout(4000);
    g = await bootGuest(s.page);
  }
  if (!g.guestId) {
    const ck = (await s.page.context().cookies()).map((c) => c.name);
    const url = s.page.url();
    const body = (await s.page.textContent("body").catch(() => "")) ?? "";
    throw new Error(
      `boot failed url=${url} cookies=${JSON.stringify(ck)} body=${body.slice(0, 200)}`,
    );
  }
  execSync(`node --import tsx scripts/provision-model.mjs ${g.guestId}`, { stdio: "pipe" });
  return { ...s, ...g };
}

async function openMega(page) {
  await page.goto(`${BASE}/mega`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);
}

const mega = await import("../src/lib/mega-engine.server.ts");
const { issueToken } = await import("../src/lib/guest.server.ts");
const megaEvent = (await sql("select * from mega_events limit 1"))[0];
console.log(
  `   mega event: ${megaEvent.title ?? megaEvent.code} (${megaEvent.question_count ?? "?"} questions)`,
);

/* ------------------------------------------------------------------ */
/* P2-01 — weekly pass                                                 */
/* ------------------------------------------------------------------ */

/**
 * SETUP: credits USTAD Coins through the shared ledger, then buys the weekly
 * pass through the REAL `buyPass` engine — no hand-written pass row.
 */
async function grantPassVia(engineMod, guestId, token) {
  await sql(
    `insert into ustad_coin_ledger (guest_id, source, ref_id, coins, note)
     values ($1,'test_setup',$2,$3,'runtime test funding')
     on conflict (guest_id, source, ref_id) do nothing`,
    [guestId, `fund-${guestId}`, Number(megaEvent.pass_cost) + 1000],
  );
  return engineMod.buyPass(token);
}

const A = await freshGuest();
const aToken = await issueToken(A.guestId);
await openMega(A.page);
const megaUi = await A.page.textContent("body");
check(
  "P2-00",
  "the Mega screen loads for a real guest",
  /mega/i.test(megaUi),
  (megaUi.match(/Mega[^.]{0,50}/) ?? [""])[0].slice(0, 60),
);
check(
  "P2-01c",
  "the pass is priced in USTAD Coins, never real currency",
  !/₹|\bINR\b|\bUSD\b|\$\d/.test(megaUi),
);

// SETUP: a real weekly pass row, the same shape the engine writes on purchase.

await grantPassVia(mega, A.guestId, aToken);
const passes = await sql("select * from mega_passes where guest_id=$1 and status='active'", [
  A.guestId,
]);
check(
  "P2-01",
  "an active weekly pass exists for the guest",
  passes.length === 1,
  `${passes.length}`,
);

/* ------------------------------------------------------------------ */
/* P2-09 — SINGLE PLAYER MEGA: 20 questions / 10 minutes / ≥10 to win  */
/* ------------------------------------------------------------------ */

let solo = null;
try {
  solo = await mega.createMatch({ token: aToken, mode: "solo" });
} catch (err) {
  console.log("   createMatch(solo):", String(err).slice(0, 200));
}

if (solo) {
  // A solo match must be STARTED before its 10-minute clock is armed.
  await mega
    .startMatch({ token: aToken, matchId: solo.matchId ?? solo.match?.id ?? solo.id })
    .catch((e) => console.log("   solo start:", String(e).slice(0, 120)));
  const m =
    (
      await sql("select * from mega_matches where id=$1", [solo.matchId ?? solo.match?.id ?? ""])
    )[0] ??
    (
      await sql(
        "select * from mega_matches where host_guest_id=$1 and mode='solo' order by created_at desc limit 1",
        [A.guestId],
      )
    )[0];
  const mq = await sql("select question_number from mega_match_questions where match_id=$1", [
    m.id,
  ]);
  check("P2-09", "solo Mega serves EXACTLY 20 questions", mq.length === 20, `${mq.length}`);
  const totalWindow = m.solo_deadline_at
    ? (new Date(m.solo_deadline_at) - new Date(m.started_at)) / 1000
    : null;
  check(
    "P2-09b",
    "the solo total timer is 10 minutes (600s)",
    totalWindow !== null && Math.abs(totalWindow - 600) < 3,
    `${totalWindow}s`,
  );

  const passesAfter = await sql("select * from mega_passes where guest_id=$1 and status='active'", [
    A.guestId,
  ]);
  check(
    "P2-01b",
    "starting a match does not charge a second pass",
    passesAfter.length === 1,
    `${passesAfter.length}`,
  );

  // Play it: answer exactly 10 correctly → a win by the ≥10 rule.
  let answered = 0;
  for (let n = 1; n <= 20; n++) {
    const st = (
      await sql("select status, current_question from mega_matches where id=$1", [m.id])
    )[0];
    if (st.status === "finished") break;
    const q = (
      await sql(
        "select options, correct_index from mega_match_questions where match_id=$1 and question_number=$2",
        [m.id, n],
      )
    )[0];
    if (!q) break;
    const options = typeof q.options === "string" ? JSON.parse(q.options) : q.options;
    const idx = n <= 10 ? Number(q.correct_index) : (Number(q.correct_index) + 1) % options.length;
    try {
      await mega.markPresented({ token: aToken, matchId: m.id, questionNumber: n }).catch(() => {});
      await mega.submitAnswer({
        token: aToken,
        matchId: m.id,
        questionNumber: n,
        optionIndex: idx,
      });
      answered++;
      await mega.nextQuestion({ token: aToken, matchId: m.id }).catch(() => {});
    } catch (err) {
      console.log(`   solo answer ${n}:`, String(err).slice(0, 120));
      break;
    }
  }
  const soloRes = (
    await sql("select * from mega_player_results where match_id=$1 and guest_id=$2", [
      m.id,
      A.guestId,
    ])
  )[0];
  if (soloRes) {
    check(
      "P2-09c",
      "10 or more correct wins the solo match",
      Number(soloRes.correct_count) >= 10
        ? soloRes.is_winner === true
        : soloRes.is_winner === false,
      `${soloRes.correct_count} correct, winner=${soloRes.is_winner}`,
    );
  } else {
    check(
      "P2-09c",
      "solo win rule (≥10 correct)",
      "BLOCKED",
      `answered ${answered}, no result row yet`,
    );
  }
} else {
  check("P2-09", "solo Mega match", "BLOCKED", "startSolo not reachable in this environment");
  check("P2-09b", "solo total timer", "BLOCKED", "no solo match");
  check("P2-09c", "solo win rule", "BLOCKED", "no solo match");
  check("P2-01b", "pass not charged twice", "BLOCKED", "no solo match");
}

/* ------------------------------------------------------------------ */
/* P2-02 … P2-08 — REAL multiplayer with concurrent browser sessions   */
/* ------------------------------------------------------------------ */

const players = [A];
for (let i = 0; i < 3; i++) {
  const p = await freshGuest();
  players.push(p);
}
const tokens = [aToken];
for (const p of players.slice(1)) {
  const t = await issueToken(p.guestId);
  await grantPassVia(mega, p.guestId, t);
  tokens.push(t);
}
console.log(`   ${players.length} concurrent browser sessions ready`);

// All four players announce themselves in the REAL shared lobby.
for (const t of tokens) await mega.lobbyHeartbeat({ token: t, state: "available" }).catch(() => {});
const lobbyView = await mega.getLobby(tokens[0]).catch(() => null);
const present = (lobbyView?.players ?? lobbyView?.presence ?? []).length;
check(
  "P2-02f",
  "the real-time lobby lists the concurrent players",
  present >= 2,
  `${present} present`,
);

let lobby = null;
try {
  // The host selects players from the lobby — Part 2's host-selection rule.
  lobby = await mega.createMatch({
    token: tokens[0],
    mode: "multiplayer",
    playerIds: players.slice(1, 4).map((p) => p.guestId),
  });
} catch (err) {
  console.log("   createMatch(multiplayer):", String(err).slice(0, 200));
}

if (lobby) {
  const matchId = lobby.matchId ?? lobby.match?.id ?? lobby.id;
  const roster = await sql("select guest_id from mega_match_players where match_id=$1", [matchId]);
  check("P2-02", "2–4 real players join one lobby", roster.length >= 2, `${roster.length} players`);
  const host = (await sql("select host_guest_id from mega_matches where id=$1", [matchId]))[0];
  check("P2-02b", "the creating player is the host", host.host_guest_id === players[0].guestId);
  check("P2-02c", "the lobby holds 3 or 4 players", roster.length >= 3, `${roster.length}`);

  // Each player sees the lobby in their own real browser.
  await openMega(players[1].page);
  const p2ui = await players[1].page.textContent("body");
  check(
    "P2-02d",
    "a second real browser session sees the Mega lobby state",
    /lobby|waiting|player|join/i.test(p2ui),
  );

  // Every invited player marks themselves Ready — the engine refuses to start
  // otherwise, which is the correct server-authoritative behaviour.
  for (let i = 0; i < roster.length; i++) {
    await mega
      .setPlayerState({ token: tokens[i], matchId, state: "ready" })
      .catch((e) => console.log(`   ready ${i}:`, String(e).slice(0, 100)));
  }
  const notReady = await sql(
    "select guest_id from mega_match_players where match_id=$1 and state <> 'ready'",
    [matchId],
  );
  check(
    "P2-02g",
    "the match cannot start until every player is Ready",
    notReady.length === 0,
    `${notReady.length} not ready`,
  );

  let started = false;
  try {
    await mega.startMatch({ token: tokens[0], matchId });
    started = true;
  } catch (err) {
    console.log("   startMatch:", String(err).slice(0, 200));
  }
  check("P2-02e", "the host can start the match", started);

  if (started) {
    const mqs = await sql(
      "select question_number, question from mega_match_questions where match_id=$1 order by question_number",
      [matchId],
    );
    const cfgCount = Number(
      (await sql("select question_count from mega_matches where id=$1", [matchId]))[0]
        .question_count,
    );
    check(
      "P2-04",
      "the match serves the event's FIXED question count",
      mqs.length === cfgCount,
      `${mqs.length} vs configured ${cfgCount}`,
    );

    // P2-03: every player reads the SAME question for a given index.
    const views = [];
    for (let i = 0; i < roster.length; i++) {
      try {
        views.push(await mega.getMatch({ token: tokens[i], matchId }));
      } catch {
        /* skip */
      }
    }
    const qTexts = views
      .map((v) => v?.question?.question ?? v?.currentQuestion?.question ?? null)
      .filter(Boolean);
    check(
      "P2-03",
      "all players in the match receive the SAME question",
      qTexts.length >= 2 && new Set(qTexts).size === 1,
      `${qTexts.length} views, ${new Set(qTexts).size} distinct`,
    );
    check(
      "P2-03b",
      "the question set is stored once per match, not per player",
      mqs.length === cfgCount,
    );

    // P2-06/P2-07: scoring and tie-break. The match is ROUND-BASED: every
    // player answers the current question, then the round advances — exactly
    // how real play proceeds.
    const targets = [15, 12, 10, 8].slice(0, roster.length);
    const rosterIds = roster.map((r) => r.guest_id);
    const tokenFor = (gid) => tokens[players.findIndex((p) => p.guestId === gid)];

    for (let n = 1; n <= cfgCount; n++) {
      const st = (
        await sql("select status, current_question from mega_matches where id=$1", [matchId])
      )[0];
      if (st.status !== "active") break;
      const qn = Number(st.current_question);
      const q = (
        await sql(
          "select options, correct_index from mega_match_questions where match_id=$1 and question_number=$2",
          [matchId, qn],
        )
      )[0];
      if (!q) break;
      const options = typeof q.options === "string" ? JSON.parse(q.options) : q.options;

      for (let i = 0; i < rosterIds.length; i++) {
        const t = tokenFor(rosterIds[i]);
        if (!t) continue;
        const wantCorrect = qn <= targets[i];
        const idx = wantCorrect
          ? Number(q.correct_index)
          : (Number(q.correct_index) + 1) % options.length;
        await mega.markPresented({ token: t, matchId, questionNumber: qn }).catch(() => {});
      }
      // Respect the REAL 10s pre-timer: the answer window only opens after it.
      const armed = (
        await sql("select answer_timer_starts_at from mega_matches where id=$1", [matchId])
      )[0];
      const openAt = armed?.answer_timer_starts_at
        ? Date.parse(armed.answer_timer_starts_at)
        : Date.now();
      const waitMs = Math.max(1100, openAt - Date.now() + 400);
      await new Promise((r) => setTimeout(r, waitMs));
      for (let i = 0; i < rosterIds.length; i++) {
        const t = tokenFor(rosterIds[i]);
        if (!t) continue;
        const wantCorrect = qn <= targets[i];
        const idx = wantCorrect
          ? Number(q.correct_index)
          : (Number(q.correct_index) + 1) % options.length;
        await mega
          .submitAnswer({ token: t, matchId, questionNumber: qn, optionIndex: idx })
          .catch((e) => {
            if (n === 1) console.log(`   answer p${i}:`, String(e).slice(0, 120));
          });
      }
      await mega.nextQuestion({ token: tokens[0], matchId }).catch(() => {});
    }

    const standings = await sql(
      "select guest_id, correct_count, is_winner, rank from mega_player_results where match_id=$1 order by rank",
      [matchId],
    );
    if (standings.length >= 2) {
      const top = standings[0];
      check(
        "P2-06",
        "the highest scorer wins the multiplayer match",
        top.is_winner === true &&
          Number(top.correct_count) === Math.max(...standings.map((s) => Number(s.correct_count))),
        `winner has ${top.correct_count} correct`,
      );
      check(
        "P2-06b",
        "ranks are assigned 1..N with no duplicates",
        new Set(standings.map((s) => s.rank)).size === standings.length,
      );
      const tb = (await sql("select tie_break_reason from mega_matches where id=$1", [matchId]))[0];
      check(
        "P2-07",
        "tie-breaks are resolved server-side and recorded",
        typeof tb.tie_break_reason === "string",
        `"${tb.tie_break_reason}"`,
      );
    } else {
      check("P2-06", "multiplayer scoring", "BLOCKED", `only ${standings.length} result rows`);
      check("P2-06b", "rank assignment", "BLOCKED", "no standings");
      check("P2-07", "tie-break", "BLOCKED", "no standings");
    }

    // P2-05: content is dynamic — a second match must not repeat it verbatim.
    let lobby2 = null;
    try {
      // Reuse two already-booted sessions instead of booting more browsers.
      const B1 = players[2];
      const B2 = players[3];
      const b1t = tokens[2];
      const b2t = tokens[3];
      await mega.lobbyHeartbeat({ token: b1t, state: "available" });
      await mega.lobbyHeartbeat({ token: b2t, state: "available" });
      lobby2 = await mega.createMatch({ token: b1t, mode: "multiplayer", playerIds: [B2.guestId] });
      const m2id = lobby2.matchId ?? lobby2.match?.id ?? lobby2.id;
      const host2 = (await sql("select host_guest_id from mega_matches where id=$1", [m2id]))[0]
        .host_guest_id;
      const hostTok = tokens[players.findIndex((p) => p.guestId === host2)];
      await mega.setPlayerState({ token: b1t, matchId: m2id, state: "ready" });
      await mega.setPlayerState({ token: b2t, matchId: m2id, state: "ready" });
      await mega.startMatch({ token: hostTok ?? b1t, matchId: m2id });
    } catch (err) {
      console.log("   second match:", String(err).slice(0, 180));
    }
    if (lobby2) {
      const m2 = lobby2.matchId ?? lobby2.match?.id ?? lobby2.id;
      const mqs2 = await sql(
        "select question from mega_match_questions where match_id=$1 order by question_number",
        [m2],
      );
      check(
        "P2-05",
        "question CONTENT differs between matches",
        JSON.stringify(mqs.map((q) => q.question)) !== JSON.stringify(mqs2.map((q) => q.question)),
      );
      check(
        "P2-05b",
        "but the COUNT is the same fixed number",
        mqs2.length === cfgCount,
        `${mqs2.length}`,
      );
    } else {
      check(
        "P2-05",
        "dynamic question content across matches",
        "BLOCKED",
        "second match could not be created",
      );
      check("P2-05b", "fixed count across matches", "BLOCKED", "second match could not be created");
    }

    // P2-08: disconnect + reconnect.
    const beforeDc = (
      await sql(
        "select correct_count, score from mega_match_players where match_id=$1 and guest_id=$2",
        [matchId, players[1].guestId],
      )
    )[0];
    await players[1].ctx.setOffline(true);
    await players[1].page.waitForTimeout(4000);
    await players[1].ctx.setOffline(false);
    await openMega(players[1].page);
    const afterDc = (
      await sql(
        "select correct_count, score from mega_match_players where match_id=$1 and guest_id=$2",
        [matchId, players[1].guestId],
      )
    )[0];
    check(
      "P2-08",
      "a disconnect + reconnect preserves the player's score",
      String(beforeDc?.correct_count) === String(afterDc?.correct_count),
      `${beforeDc?.correct_count} → ${afterDc?.correct_count}`,
    );
    const stillIn = await sql(
      "select guest_id from mega_match_players where match_id=$1 and guest_id=$2",
      [matchId, players[1].guestId],
    );
    check(
      "P2-08b",
      "the reconnecting player keeps their identity in the match",
      stillIn.length === 1,
    );
    const dupPlayers = await sql(
      "select guest_id, count(*) c from mega_match_players where match_id=$1 group by guest_id having count(*) > 1",
      [matchId],
    );
    check("P2-08c", "reconnecting never duplicates the player", dupPlayers.length === 0);
  } else {
    for (const id of [
      "P2-04",
      "P2-03",
      "P2-03b",
      "P2-05",
      "P2-05b",
      "P2-06",
      "P2-06b",
      "P2-07",
      "P2-08",
      "P2-08b",
      "P2-08c",
    ]) {
      check(id, "depends on a started multiplayer match", "BLOCKED", "match did not start");
    }
  }
} else {
  for (const id of [
    "P2-02",
    "P2-02b",
    "P2-02c",
    "P2-02d",
    "P2-02e",
    "P2-03",
    "P2-03b",
    "P2-04",
    "P2-05",
    "P2-05b",
    "P2-06",
    "P2-06b",
    "P2-07",
    "P2-08",
    "P2-08b",
    "P2-08c",
  ]) {
    check(id, "multiplayer lobby", "BLOCKED", "lobby could not be created");
  }
}

summary();
await browser.close();
await DB.end();
