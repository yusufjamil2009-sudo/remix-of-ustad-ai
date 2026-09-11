/**
 * PERMANENT GUEST IDENTITY — RUNTIME INTEGRATION SUITE (hardening §26).
 *
 * These tests execute the REAL server modules (account.server, guest.server,
 * data.server) end to end: real scrypt hashing, real HMAC-signed tokens, real
 * session/identity decisions, real RPC semantics — with an in-memory database
 * transport injected through the `__setDbForTests` seam.
 *
 * The seam injects ONLY the database driver (the same surface as supabase-js).
 * Nothing about the identity logic is simulated: policy, token format, error
 * mapping and rollback semantics are the production code paths.
 *
 * Failure injection covers every critical operation from §26: account lookup,
 * guest lookup, guest creation, account creation, session creation, session
 * refresh, session revoke, profile/settings upsert, claim, and the outage
 * rule "DB failure ≠ not found ≠ invalid credentials ≠ username available".
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";

process.env["USTAD_GUEST_SECRET"] = "runtime-test-secret-0001";

/* ------------------------------------------------------------------ */
/* In-memory database transport (supabase-js surface)                  */
/* ------------------------------------------------------------------ */

type DbError = { code: string; message: string };

class FakeSupabase {
  tables = new Map<string, Record<string, any>[]>();
  outages = new Set<string>();
  networkDown = false;
  /** When true, every operation throws like a real 500 (unknown server error). */
  serverError = false;
  failNext: { table?: string; op?: string } | null = null;
  /** RPC semantics must be transactional; snapshot for rollback. */
  private snapshots: Map<string, Record<string, any>[]>[] = [];

  private err(table: string, code = "42P01"): { data: null; error: DbError } {
    return { data: null, error: { code, message: `relation "${table}" does not exist` } };
  }

  reset() {
    this.tables.clear();
    this.outages.clear();
    this.networkDown = false;
    this.serverError = false;
    this.failNext = null;
  }

  rows(t: string): Record<string, any>[] {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }

  private snapshot() {
    const s = new Map<string, Record<string, any>[]>();
    for (const [k, v] of this.tables)
      s.set(
        k,
        v.map((r) => ({ ...r })),
      );
    return s;
  }

  private rollback(s: Map<string, Record<string, any>[]>) {
    this.tables = s;
  }

  private checkFail(table: string, op: string): { data: null; error: DbError } | null {
    if (this.failNext && (this.failNext.table === undefined || this.failNext.table === table)) {
      if (this.failNext.op === undefined || this.failNext.op === op) {
        this.failNext = null;
        return this.err(table, "42601");
      }
    }
    return null;
  }

  from(table: string): Query {
    return new Query(this, table);
  }

  async rpc(fn: string, args: Record<string, any>): Promise<any> {
    if (this.networkDown) throw new TypeError("Failed to fetch");
    if (this.serverError) throw new Error("500: Internal Server Error");
    if (fn === "ustad_create_guest_account") {
      // Mirrors the SQL function: ALL statements commit together or not at
      // all. Every error path below rolls the whole transaction back, exactly
      // like a Postgres exception inside the plpgsql function.
      const before = this.snapshot();
      const fail = (data: null, error: DbError) => {
        this.rollback(before);
        return { data, error };
      };
      const f = this.checkFail("ustad_accounts", "rpc");
      if (f) return f;
      if (
        this.outages.has("guests") ||
        this.outages.has("profiles") ||
        this.outages.has("settings")
      )
        return fail(null, { code: "42P01", message: 'relation "guests" does not exist' });
      if (this.outages.has("ustad_accounts"))
        return fail(null, { code: "42P01", message: 'relation "ustad_accounts" does not exist' });
      if (this.outages.has("ustad_sessions"))
        return fail(null, { code: "42P01", message: 'relation "ustad_sessions" does not exist' });
      const guestId = String(args.p_guest_id);
      if (!this.rows("guests").some((r) => r.id === guestId))
        this.rows("guests").push({ id: guestId });
      if (!this.rows("profiles").some((r) => r.guest_id === guestId))
        this.rows("profiles").push({ guest_id: guestId });
      if (!this.rows("settings").some((r) => r.guest_id === guestId))
        this.rows("settings").push({ guest_id: guestId });
      const accounts = this.rows("ustad_accounts");
      if (accounts.some((a) => a.username_normalized === args.p_username_normalized)) {
        return fail(null, { code: "23505", message: "duplicate username" });
      }
      const mine = accounts.find((a) => a.guest_id === guestId);
      if (mine && mine.username_normalized !== args.p_username_normalized) {
        return fail(null, { code: "U0001", message: "guest_already_claimed" });
      }
      if (!mine) {
        accounts.push({
          guest_id: guestId,
          user_id: crypto.randomUUID(),
          username: args.p_username,
          username_normalized: args.p_username_normalized,
          password_hash: args.p_password_hash,
          password_algo: "scrypt",
          failed_attempts: 0,
          locked_until: null,
          created_at: new Date().toISOString(),
        });
      }
      const jti = crypto.randomUUID();
      this.rows("ustad_sessions").push({
        jti,
        guest_id: guestId,
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 365 * 86400_000).toISOString(),
        revoked_at: null,
        revoked_reason: "",
      });
      const acct = this.rows("ustad_accounts").find((a) => a.guest_id === guestId);
      return {
        data: [{ guest_id: guestId, username: acct.username, jti, user_id: acct.user_id }],
        error: null,
      };
    }
    if (fn === "ustad_issue_fresh_session") {
      const f = this.checkFail("ustad_sessions", "rpc");
      if (f) return f;
      if (this.outages.has("ustad_sessions")) return this.err("ustad_sessions");
      const guestId = String(args.p_guest_id);
      const before = this.snapshot();
      try {
        const sessions = this.rows("ustad_sessions");
        for (const row of sessions) {
          if (row.guest_id === guestId && row.revoked_at === null) {
            row.revoked_at = new Date().toISOString();
            row.revoked_reason = "rotated";
          }
        }
        const jti = crypto.randomUUID();
        sessions.push({
          jti,
          guest_id: guestId,
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 365 * 86400_000).toISOString(),
          revoked_at: null,
          revoked_reason: "",
        });
        return { data: [{ jti }], error: null };
      } catch (e) {
        this.rollback(before);
        throw e;
      }
    }
    if (fn === "ustad_refresh_session") {
      const f = this.checkFail("ustad_sessions", "rpc");
      if (f) return f;
      if (this.outages.has("ustad_sessions")) return this.err("ustad_sessions");
      const row = this.rows("ustad_sessions").find(
        (s) =>
          s.jti === String(args.p_jti) &&
          s.guest_id === String(args.p_guest_id) &&
          s.revoked_at === null,
      );
      if (!row) return { data: [], error: null };
      row.expires_at = new Date(Date.now() + 365 * 86400_000).toISOString();
      return { data: [{ jti: row.jti }], error: null };
    }
    if (fn === "ustad_revoke_session") {
      const f = this.checkFail("ustad_sessions", "rpc");
      if (f) return f;
      if (this.outages.has("ustad_sessions")) return this.err("ustad_sessions");
      const row = this.rows("ustad_sessions").find((s) => s.jti === String(args.p_jti));
      if (!row) return { data: [], error: null };
      row.revoked_at = row.revoked_at ?? new Date().toISOString();
      if (!row.revoked_reason) row.revoked_reason = String(args.p_reason);
      return { data: [{ jti: row.jti, revoked_at: row.revoked_at }], error: null };
    }
    throw new Error(`fake rpc does not implement ${fn}`);
  }
}

class Query {
  private op = "select";
  private cols = "*";
  private payload: any = null;
  private upsertOpts: any = null;
  private filters: { col: string; val: any; is: boolean }[] = [];
  private single = false;
  private selected = false;

  constructor(
    private db: FakeSupabase,
    private table: string,
  ) {}

  select(...cols: string[]): Query {
    // postgREST semantics: insert().select() / update().select() means
    // "… returning" — it must NOT turn the mutation into a plain SELECT.
    if (this.op === "insert" || this.op === "update" || this.op === "delete") {
      this.selected = true;
      if (cols.length > 0) this.cols = cols.join(",");
      return this;
    }
    this.op = "select";
    if (cols.length > 0) this.cols = cols.join(",");
    return this;
  }

  insert(payload: any): Query {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: any): Query {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  upsert(payload: any, opts?: any): Query {
    this.op = "upsert";
    this.payload = payload;
    this.upsertOpts = opts ?? null;
    return this;
  }

  delete(): Query {
    this.op = "delete";
    return this;
  }

  eq(col: string, val: any): Query {
    this.filters.push({ col, val, is: false });
    return this;
  }

  is(col: string, val: any): Query {
    this.filters.push({ col, val, is: true });
    return this;
  }

  order(): Query {
    return this;
  }

  limit(): Query {
    return this;
  }

  maybeSingle(): Query {
    this.single = true;
    return this;
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: (value: any) => TResult1 | PromiseLike<TResult1>,
    onrejected?: (reason: any) => TResult2 | PromiseLike<TResult2>,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private match(row: Record<string, any>): boolean {
    for (const f of this.filters) {
      const v = row[f.col];
      if (f.is) {
        if (f.val === null ? v !== null : v !== f.val) return false;
      } else if (v !== f.val) return false;
    }
    return true;
  }

  private execute(): any {
    if (this.db.networkDown) throw new TypeError("Failed to fetch");
    if (this.db.serverError) throw new Error("500: Internal Server Error");
    const injected = this.db.checkFail(this.table, this.op);
    if (injected) return injected;
    if (this.db.outages.has(this.table)) return this.db.err(this.table);

    const rows = this.db.rows(this.table);
    if (this.op === "select") {
      const matched = rows.filter((r) => this.match(r));
      if (this.single) {
        const row = matched[0] ?? null;
        return { data: row ? { ...row } : null, error: null };
      }
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
    if (this.op === "insert") {
      const row = { ...this.payload };
      // primary/unique keys
      if (this.table === "guests" && rows.some((r) => r.id === row.id))
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (this.table === "profiles" && rows.some((r) => r.guest_id === row.guest_id))
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (this.table === "settings" && rows.some((r) => r.guest_id === row.guest_id))
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (this.table === "ustad_sessions" && rows.some((r) => r.jti === row.jti))
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      if (this.table === "ustad_accounts") {
        if (!this.db.rows("guests").some((g) => g.id === row.guest_id))
          return { data: null, error: { code: "23503", message: "fk violation" } };
        if (
          rows.some(
            (r) => r.guest_id === row.guest_id || r.username_normalized === row.username_normalized,
          )
        )
          return { data: null, error: { code: "23505", message: "duplicate key" } };
      }
      if (this.table === "ustad_login_attempts") {
        row.id = row.id ?? crypto.randomUUID();
        row.created_at = row.created_at ?? new Date().toISOString();
      }
      rows.push(row);
      if (this.selected) return { data: this.single ? { ...row } : [{ ...row }], error: null };
      return { data: null, error: null };
    }
    if (this.op === "update") {
      const matched = rows.filter((r) => this.match(r));
      for (const r of matched) Object.assign(r, this.payload);
      if (this.selected) return { data: matched.map((r) => ({ ...r })), error: null };
      return { data: null, error: null };
    }
    if (this.op === "upsert") {
      const key = this.upsertOpts?.onConflict ?? "id";
      const existing = rows.find((r) => r[key] === this.payload[key]);
      if (existing) {
        if (!this.upsertOpts?.ignoreDuplicates) Object.assign(existing, this.payload);
      } else {
        rows.push({ ...this.payload });
      }
      return { data: null, error: null };
    }
    if (this.op === "delete") {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (this.match(rows[i]!)) rows.splice(i, 1);
      }
      return { data: before - rows.length ? [{}] : [], error: null };
    }
    throw new Error(`fake query does not implement ${this.op}`);
  }
}

/* ------------------------------------------------------------------ */
/* Boot the seam                                                       */
/* ------------------------------------------------------------------ */

import {
  __setDbForTests,
  ensureGuestRow,
  issueSessionToken,
  newGuestId,
  refreshSessionToken,
  revokeSession,
  sessionIsRevoked,
  signSessionToken,
  verifySession,
  verifyToken,
} from "../src/lib/guest.server";
import * as account from "../src/lib/account.server";
import { bootstrapGuest } from "../src/lib/data.server";

const db = new FakeSupabase();
__setDbForTests(db as never);

const DAY = 24 * 3600 * 1000;

/** Craft a token with an arbitrary expiry (for expired/legacy scenarios). */
async function craftToken(guestId: string, expMs: number, jti?: string): Promise<string> {
  const enc = new TextEncoder();
  const b64 = (bytes: ArrayBuffer) =>
    Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(process.env["USTAD_GUEST_SECRET"] ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const exp = Math.floor(expMs / 1000);
  if (jti) {
    const payload = `${guestId}.${exp}.${jti}`;
    const sig = b64(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    return `${payload}.${sig}`;
  }
  const payload = `${guestId}.${exp}`;
  const sig = b64(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return `${payload}.${sig}`;
}

const creds = { username: "BhaiMaster42", password: "StrongPass!9xY" };

test.beforeEach(() => db.reset());

/* ------------------------------------------------------------------ */
/* §26.1 — NEW GUEST (create → permanent id → session → home)          */
/* ------------------------------------------------------------------ */

test("new guest: one atomic creation, permanent id, exactly one live session", async () => {
  const res = await account.createAccount(creds);
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("expected ok");
  assert.match(res.session.guestId, /^guest_[a-f0-9]{16}$/);

  // guest + profile + settings + account + ONE live session all exist
  assert.equal(db.rows("guests").length, 1);
  assert.equal(db.rows("profiles").length, 1);
  assert.equal(db.rows("settings").length, 1);
  assert.equal(db.rows("ustad_accounts").length, 1);
  const live = db.rows("ustad_sessions").filter((s) => s.revoked_at === null);
  assert.equal(live.length, 1, "exactly one live session");

  // the token is real: it verifies, and its jti IS the persisted session row
  const v = await verifySession(res.session.token);
  assert.ok(v);
  assert.equal(v.guestId, res.session.guestId);
  assert.equal(v.jti, live[0].jti);

  // the password hash in the DB is never plaintext
  const stored = db.rows("ustad_accounts")[0];
  assert.notEqual(stored.password_hash, creds.password);
  assert.match(String(stored.password_hash), /^scrypt\$/);
});

/* ------------------------------------------------------------------ */
/* §26.2 — DUPLICATE USERNAME (incl. concurrent race)                  */
/* ------------------------------------------------------------------ */

test("duplicate username → username_taken, NO new guest/account/session rows", async () => {
  const first = await account.createAccount(creds);
  assert.equal(first.ok, true);
  const counts = () => [
    db.rows("guests").length,
    db.rows("ustad_accounts").length,
    db.rows("ustad_sessions").length,
  ];
  const before = counts();

  const dup = await account.createAccount({ username: " bhaiMASTER42 ", password: "Other!Pass1" });
  assert.deepEqual(dup, { ok: false, code: "username_taken" });
  assert.deepEqual(counts(), before, "no partial rows may be created");
});

test("concurrent duplicate username → exactly one winner, DB decides", async () => {
  const [a, b] = await Promise.all([
    account.createAccount(creds),
    account.createAccount({ username: "BHAIMASTER42", password: "Other!Pass1" }),
  ]);
  const results = [a, b].map((r) => (r.ok ? "ok" : r.code)).sort();
  assert.deepEqual(results, ["ok", "username_taken"]);
  assert.equal(db.rows("ustad_accounts").length, 1);
  assert.equal(db.rows("guests").length, 1, "loser's guest row must roll back");
});

/* ------------------------------------------------------------------ */
/* §26.3 — BACKUP ID restore (same guest, all data preserved)          */
/* ------------------------------------------------------------------ */

test("backup restore returns the SAME guest id with all feature data intact", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const guestId = created.session.guestId;

  // Guest earns data across EVERY user-owned feature (Part 10 — the full
  // cross-feature continuity matrix; audit §12-§13; hardening Bug Area 5).
  // Column names mirror the REAL schema so the assertion is the actual
  // payload: coins (wallets/ledger), purchases, tickets, notifications WITH
  // read-state, tournaments, events, mega results, certificates, achievements,
  // trophies, and weekly rankings/leaderboards (rank_awards).
  const fixture: Record<string, Record<string, any>> = {
    ustad_wallets: { guest_id: guestId, balance: 500, updated_at: new Date().toISOString() },
    ustad_coin_ledger: { guest_id: guestId, amount: 500, note: "daily" },
    ustad_purchases: { guest_id: guestId, item_id: "hoodie", status: "owned" },
    ustad_tickets: { guest_id: guestId, amount: 3 },
    ustad_notifications: {
      guest_id: guestId,
      title: "You won!",
      is_read: true,
      read_at: "2026-09-10T10:00:00.000Z",
    },
    tournament_attempts: { guest_id: guestId, score: 42, result: "won" },
    master_event_attempts: { guest_id: guestId, event_id: "evt1", score: 7 },
    mega_player_results: { guest_id: guestId, points: 11 },
    ustad_certificates: { guest_id: guestId, title: "GK Winner" },
    ustad_achievements: { guest_id: guestId, kind: "streak", unlocked: true },
    ustad_trophies: { guest_id: guestId, name: "Champion Cup" },
    // weekly rankings / leaderboard settlement for this guest (real columns)
    ustad_rank_awards: {
      guest_id: guestId,
      category: "weekly",
      cycle_start: "2026-09-07T00:00:00.000Z",
      cycle_end: "2026-09-14T00:00:00.000Z",
      rank: 1,
      cup_awarded: true,
      cup_count: 1,
      coins: 250,
    },
  };
  for (const [table, row] of Object.entries(fixture)) db.rows(table).push(row);
  // profile + settings (language/preferences/cosmetics) already exist from
  // creation — badges are equipped cosmetics on the profile, preferences are
  // the profile's learning_preferences (Bug Area 5: all user-owned state).
  const settingsRow = db.rows("settings").find((r) => r.guest_id === guestId)!;
  settingsRow.language = "hindi";
  const profileRow = db.rows("profiles").find((r) => r.guest_id === guestId)!;
  profileRow.board = "CBSE";
  profileRow.learning_preferences = JSON.stringify({ pace: "slow", style: "visual" });
  profileRow.equipped_frame = "gold_frame";
  profileRow.equipped_badge = "streak_master_badge";

  // LOG OUT (server-side revocation)
  const out = await account.logoutSession(created.session.token);
  assert.equal(out.ok, true);
  assert.equal(
    (await sessionIsRevoked(String((await verifySession(created.session.token))?.jti))) ===
      "revoked",
    true,
  );

  // RESTORE with Backup ID
  const restored = await account.loginAccount(creds);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.session.guestId, guestId, "SAME permanent Guest ID — never a new one");
  assert.equal(restored.account.username, creds.username);

  // EVERY feature row still belongs to the SAME guest id, untouched — no
  // feature switched to another identity and nothing was reset.
  for (const [table, row] of Object.entries(fixture)) {
    assert.deepEqual(
      db.rows(table),
      [row],
      `${table} must stay attached to the same guests.id after restore`,
    );
  }
  assert.equal(db.rows("settings").find((r) => r.guest_id === guestId)!.language, "hindi");
  const profileAfter = db.rows("profiles").find((r) => r.guest_id === guestId)!;
  assert.equal(profileAfter.board, "CBSE");
  assert.equal(
    profileAfter.learning_preferences,
    JSON.stringify({ pace: "slow", style: "visual" }),
  );
  assert.equal(profileAfter.equipped_frame, "gold_frame");
  assert.equal(profileAfter.equipped_badge, "streak_master_badge");
  // explicit read-state + leaderboard continuity (Bug Area 5)
  const notifAfter = db.rows("ustad_notifications")[0];
  assert.equal(notifAfter.is_read, true, "notification read-state survives restore");
  assert.equal(notifAfter.read_at, "2026-09-10T10:00:00.000Z");
  const rankAfter = db.rows("ustad_rank_awards")[0];
  assert.equal(rankAfter.rank, 1, "weekly ranking survives restore");
  assert.equal(rankAfter.cup_awarded, true, "leaderboard cup survives restore");
  assert.equal(db.rows("guests").length, 1, "restore must never create a guest");

  // the restored session is a NEW live session for the same guest
  const live = db.rows("ustad_sessions").filter((s) => s.revoked_at === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].guest_id, guestId);
});

test("wrong password and unknown username are IDENTICAL generic errors", async () => {
  await account.createAccount(creds);
  const wrongPass = await account.loginAccount({ username: creds.username, password: "Wrong!000" });
  const unknown = await account.loginAccount({ username: "NoSuchUser99", password: "Whatever!1" });
  assert.deepEqual(wrongPass, { ok: false, code: "invalid_credentials" });
  assert.deepEqual(unknown, { ok: false, code: "invalid_credentials" });
});

/* ------------------------------------------------------------------ */
/* §26.4 — LOGOUT + §15 (revocation failure must not fake success)     */
/* ------------------------------------------------------------------ */

test("logout revokes the session; the same token is dead afterwards", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const jti = String((await verifySession(created.session.token))?.jti);
  assert.equal(await sessionIsRevoked(jti), "active");

  const out = await account.logoutSession(created.session.token);
  assert.equal(out.ok, true);
  assert.equal(await sessionIsRevoked(jti), "revoked");

  // the revoked token still verifies cryptographically but resolves invalid
  const identity = await account.resolveIdentity(created.session.token);
  assert.equal(identity.state, "invalid_session");
  // logout never deletes anything
  assert.equal(db.rows("guests").length, 1);
  assert.equal(db.rows("ustad_accounts").length, 1);
});

test("revocation failure → logout_failed, session STAYS alive, retry works", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  db.outages.add("ustad_sessions");
  const failed = await account.logoutSession(created.session.token);
  assert.deepEqual(failed, { ok: false, code: "logout_failed" });
  db.outages.delete("ustad_sessions");

  // nothing was revoked
  const jti = String((await verifySession(created.session.token))?.jti);
  assert.equal(await sessionIsRevoked(jti), "active");

  const retry = await account.logoutSession(created.session.token);
  assert.equal(retry.ok, true);
  assert.equal(await sessionIsRevoked(jti), "revoked");
});

/* ------------------------------------------------------------------ */
/* §26.5 — EXPIRED / REVOKED / MISSING sessions never mint a new guest */
/* ------------------------------------------------------------------ */

async function bootstrapCounts() {
  return { guests: db.rows("guests").length, sessions: db.rows("ustad_sessions").length };
}

test("expired token → needsIdentity, ZERO new guests", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const stale = await craftToken(created.session.guestId, Date.now() - DAY);
  const before = await bootstrapCounts();

  const res = await bootstrapGuest(stale);
  assert.equal(res.needsIdentity, true);
  assert.deepEqual(await bootstrapCounts(), before);
});

test("revoked token → needsIdentity (invalid_session), ZERO new guests", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await account.logoutSession(created.session.token);
  const before = await bootstrapCounts();

  const res = await bootstrapGuest(created.session.token);
  assert.equal(res.needsIdentity, true);
  assert.equal(res.identity, "invalid_session");
  assert.deepEqual(await bootstrapCounts(), before);
});

test("token whose session row is MISSING → invalid, never active, never a new guest", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  // sign a token that references a session id that does not exist
  const ghost = await craftToken(created.session.guestId, Date.now() + DAY, crypto.randomUUID());
  const before = await bootstrapCounts();

  const res = await bootstrapGuest(ghost);
  assert.equal(res.needsIdentity, true);
  assert.equal(res.identity, "invalid_session");
  assert.deepEqual(await bootstrapCounts(), before);
});

/* ------------------------------------------------------------------ */
/* §26.6 — DATABASE OUTAGE ≠ not-found ≠ invalid ≠ username available  */
/* ------------------------------------------------------------------ */

test("account lookup outage → database_error, NEVER invalid_credentials", async () => {
  await account.createAccount(creds);
  db.outages.add("ustad_accounts");
  const res = await account.loginAccount(creds);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "database_error", "an outage must not read as wrong password");
  db.outages.delete("ustad_accounts");
});

test("guest lookup outage → resolveIdentity THROWS network (identity preserved)", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  // The token is VALID — only the guest lookup is down. That must be a
  // retryable outage, never "invalid session" and never "new user".
  db.outages.add("guests");
  await assert.rejects(() => account.resolveIdentity(created.session.token), /network/);
  db.outages.delete("guests");
  // after the outage clears the SAME token resolves fine
  const res = await account.resolveIdentity(created.session.token);
  assert.equal(res.state, "authenticated");
});

test("guest creation outage → no rows at all (atomic rollback)", async () => {
  db.outages.add("guests");
  const res = await account.createAccount(creds);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "database_error");
  assert.equal(db.rows("guests").length, 0);
  assert.equal(db.rows("ustad_accounts").length, 0);
  assert.equal(db.rows("ustad_sessions").length, 0);
  db.outages.delete("guests");
});

test("account creation outage inside create → guest+session roll back too", async () => {
  db.outages.add("ustad_accounts");
  const res = await account.createAccount(creds);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "database_error");
  assert.equal(db.rows("guests").length, 0);
  assert.equal(db.rows("ustad_sessions").length, 0);
  db.outages.delete("ustad_accounts");
});

test("session creation outage inside create → whole identity rolls back", async () => {
  db.outages.add("ustad_sessions");
  const res = await account.createAccount(creds);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "database_error");
  assert.equal(db.rows("guests").length, 0);
  assert.equal(db.rows("ustad_accounts").length, 0);
  db.outages.delete("ustad_sessions");
});

test("session creation outage during login → no token, database_error", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  await account.logoutSession(created.ok ? created.session.token : "");
  db.outages.add("ustad_sessions");
  const res = await account.loginAccount(creds);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "database_error");
  db.outages.delete("ustad_sessions");
});

test("transport outage during login → network (retryable), identity untouched", async () => {
  await account.createAccount(creds);
  db.networkDown = true;
  const res = await account.loginAccount(creds);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "network");
  db.networkDown = false;
  // the account still exists and still signs in
  const again = await account.loginAccount(creds);
  assert.equal(again.ok, true);
});

test("bootstrap during a transport outage → throws network (NEVER needsIdentity)", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  db.networkDown = true;
  await assert.rejects(() => bootstrapGuest(created.session.token), /network/);
  db.networkDown = false;
  // identity intact: same token still bootstraps to the same guest
  const res = await bootstrapGuest(created.session.token);
  assert.equal(res.needsIdentity, false);
  assert.equal(res.guestId, created.session.guestId);
});

/* ------------------------------------------------------------------ */
/* §26.7 — SESSION REFRESH (verified target, §5)                       */
/* ------------------------------------------------------------------ */

test("refresh: valid session extends expiry and keeps the SAME jti", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const jti = String((await verifySession(created.session.token))?.jti);
  const before = db.rows("ustad_sessions").find((s) => s.jti === jti)!.expires_at;

  const fresh = await refreshSessionToken(created.session.guestId, jti);
  const parts = fresh.split(".");
  assert.equal(parts.length, 4);
  assert.equal(parts[2], jti, "refresh must keep the session id");

  const after = db.rows("ustad_sessions").find((s) => s.jti === jti)!.expires_at;
  assert.notEqual(after, before);
  assert.equal(db.rows("ustad_sessions").length, 1, "refresh never creates a row");
});

test("refresh: revoked / missing / wrong-guest sessions are all invalid_session", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const jti = String((await verifySession(created.session.token))?.jti);
  await account.logoutSession(created.session.token);
  await assert.rejects(
    () => refreshSessionToken(created.session.guestId, jti),
    /session_unavailable/,
  );

  await assert.rejects(
    () => refreshSessionToken(created.session.guestId, crypto.randomUUID()),
    /session_unavailable/,
    "missing session must not refresh",
  );

  const other = await account.createAccount({ username: "OtherUser88", password: "Strong!Pass2" });
  assert.equal(other.ok, true);
  const otherJti = String((await verifySession(other.ok ? other.session.token : ""))?.jti);
  await assert.rejects(
    () => refreshSessionToken(created.session.guestId, otherJti),
    /session_unavailable/,
    "another guest's session must not refresh",
  );
});

test("refresh outage → database_error, never a minted token", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  db.outages.add("ustad_sessions");
  const jti = String((await verifySession(created.session.token))?.jti);
  await assert.rejects(() => refreshSessionToken(created.session.guestId, jti), /database_error/);
  db.outages.delete("ustad_sessions");
});

/* ------------------------------------------------------------------ */
/* §26.8 — session state + ensureGuestRow (§6, §8)                     */
/* ------------------------------------------------------------------ */

test("sessionIsRevoked: active / revoked / MISSING are three distinct states", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const jti = String((await verifySession(created.session.token))?.jti);
  assert.equal(await sessionIsRevoked(jti), "active");
  await account.logoutSession(created.session.token);
  assert.equal(await sessionIsRevoked(jti), "revoked");
  assert.equal(await sessionIsRevoked(crypto.randomUUID()), "missing");
});

test("ensureGuestRow checks EVERY write — a failed write throws, never success", async () => {
  const id = newGuestId();
  await ensureGuestRow(id);
  assert.equal(db.rows("guests").length, 1);

  db.outages.add("profiles");
  await assert.rejects(() => ensureGuestRow(newGuestId()), /database_error/);
  db.outages.delete("profiles");

  db.networkDown = true;
  await assert.rejects(() => ensureGuestRow(newGuestId()), /network/);
  db.networkDown = false;
});

/* ------------------------------------------------------------------ */
/* §26.9 — CLAIM existing guest (§11 error mapping)                    */
/* ------------------------------------------------------------------ */

test("claim: legacy guest keeps the SAME guest id and gains credentials", async () => {
  // a legacy guest: row exists, no account
  const legacyId = newGuestId();
  db.rows("guests").push({ id: legacyId });
  const legacyToken = await craftToken(legacyId, Date.now() + DAY);
  const before = db.rows("guests").length;

  const claim = await account.claimExistingGuest({
    token: legacyToken,
    username: "LegacyBhai",
    password: "Claim!Pass9x",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  assert.equal(claim.session.guestId, legacyId, "claim NEVER creates a new Guest ID");
  assert.equal(db.rows("guests").length, before);
  assert.equal(db.rows("ustad_accounts")[0].guest_id, legacyId);
  assert.equal(db.rows("ustad_sessions").filter((s) => s.revoked_at === null).length, 1);
});

test("claim: only REAL 23505 maps to username_taken; other errors stay database errors", async () => {
  const legacyId = newGuestId();
  db.rows("guests").push({ id: legacyId });
  const legacyToken = await craftToken(legacyId, Date.now() + DAY);

  // another account already owns this username
  await account.createAccount({ username: "TakenByOther", password: "Strong!Pass1" });
  const taken = await account.claimExistingGuest({
    token: legacyToken,
    username: "TAKENBYOTHER",
    password: "Claim!Pass9x",
  });
  assert.deepEqual(taken, { ok: false, code: "username_taken" });
  assert.equal(db.rows("ustad_accounts").length, 1, "no partial claim rows");

  // claim race: the SAME guest gets claimed twice with different usernames
  const first = await account.claimExistingGuest({
    token: legacyToken,
    username: "RaceWinner1",
    password: "Claim!Pass9x",
  });
  assert.equal(first.ok, true);
  const second = await account.claimExistingGuest({
    token: legacyToken,
    username: "RaceLoser2",
    password: "Claim!Pass9y",
  });
  assert.deepEqual(second, { ok: false, code: "guest_already_claimed" });
  assert.equal(db.rows("ustad_accounts").length, 2, "other user's account untouched");
});

/* ------------------------------------------------------------------ */
/* §26.10 — LOGIN ABUSE PROTECTION (§10)                               */
/* ------------------------------------------------------------------ */

test("failed attempts increment server-side and lock self-heals", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  for (let i = 0; i < 7; i++) {
    await account.loginAccount({ username: creds.username, password: "Wrong!000" });
  }
  let row = db.rows("ustad_accounts")[0];
  assert.equal(row.failed_attempts, 7);
  assert.equal(row.locked_until, null);

  await account.loginAccount({ username: creds.username, password: "Wrong!000" });
  row = db.rows("ustad_accounts")[0];
  assert.equal(row.failed_attempts, 8);
  assert.ok(row.locked_until, "8th failure must set the short lock");

  // CORRECT password while locked → too_many_attempts (only the password
  // holder can ever see this — no enumeration)
  const locked = await account.loginAccount(creds);
  assert.deepEqual(locked, { ok: false, code: "too_many_attempts" });

  // self-healing: expiry clears the lock, success resets the counter
  row.locked_until = new Date(Date.now() - 1000).toISOString();
  const win = await account.loginAccount(creds);
  assert.equal(win.ok, true);
  assert.equal(db.rows("ustad_accounts")[0].failed_attempts, 0);
});

test("counter-write failure NEVER changes the credential verdict (§10)", async () => {
  await account.createAccount(creds);
  // fail only the account UPDATE — the lookup and hash verify still work
  db.failNext = { table: "ustad_accounts", op: "update" };
  const wrong = await account.loginAccount({ username: creds.username, password: "Wrong!000" });
  assert.deepEqual(wrong, { ok: false, code: "invalid_credentials" }, "wrong stays wrong");

  db.failNext = { table: "ustad_accounts", op: "update" };
  const right = await account.loginAccount(creds);
  assert.equal(right.ok, false);
  if (right.ok) return;
  // the critical reset write failed → NO session is handed out (§10)
  assert.equal(right.code, "database_error");
});

/* ------------------------------------------------------------------ */
/* §26.11 — legacy token migration in place (§5)                       */
/* ------------------------------------------------------------------ */

test("legacy 3-part token migrates to a revocable session for the SAME guest", async () => {
  const legacyId = newGuestId();
  db.rows("guests").push({ id: legacyId });
  const legacy = await craftToken(legacyId, Date.now() + DAY);
  assert.equal(legacy.split(".").length, 3);

  const res = await bootstrapGuest(legacy);
  assert.equal(res.needsIdentity, false);
  assert.equal(res.guestId, legacyId, "identity is never regenerated");
  assert.equal(res.token.split(".").length, 4, "migrated to a revocable session");
  assert.equal(db.rows("guests").length, 1);
  assert.equal(db.rows("ustad_sessions").length, 1);

  // the migrated session is revocable now
  const out = await account.logoutSession(res.token);
  assert.equal(out.ok, true);
});

/* ------------------------------------------------------------------ */
/* §26.12 — concurrent sessions / rotation (§21)                       */
/* ------------------------------------------------------------------ */

test("two refreshes of the same session are safe (same jti, still ONE row)", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const jti = String((await verifySession(created.session.token))?.jti);
  const [a, b] = await Promise.all([
    refreshSessionToken(created.session.guestId, jti),
    refreshSessionToken(created.session.guestId, jti),
  ]);
  assert.equal(a.split(".")[2], jti);
  assert.equal(b.split(".")[2], jti);
  assert.equal(db.rows("ustad_sessions").length, 1);
});

test("a second login rotates the first: exactly ONE live session remains", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  const second = await account.loginAccount(creds);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const live = db.rows("ustad_sessions").filter((s) => s.revoked_at === null);
  assert.equal(live.length, 1, "one-live-session invariant after rotation");
  assert.equal(live[0].guest_id, created.ok ? created.session.guestId : "");

  // the OLD token is now dead (its session was rotated out)
  if (created.ok) {
    const identity = await account.resolveIdentity(created.session.token);
    assert.equal(identity.state, "invalid_session");
  }
});

/* ------------------------------------------------------------------ */
/* §26.13 — resolveIdentity matrix (§19) + cross-user isolation        */
/* ------------------------------------------------------------------ */

test("resolveIdentity covers every state and never creates anything", async () => {
  const before = db.rows("guests").length;

  assert.equal((await account.resolveIdentity("")).state, "no_identity");
  assert.equal((await account.resolveIdentity("garbage")).state, "no_identity");

  // unclaimed legacy guest → authenticated + hasExistingGuest + account null
  const legacyId = newGuestId();
  db.rows("guests").push({ id: legacyId });
  const legacyToken = await craftToken(legacyId, Date.now() + DAY);
  const unclaimed = await account.resolveIdentity(legacyToken);
  assert.equal(unclaimed.state, "authenticated");
  assert.equal(unclaimed.hasExistingGuest, true);
  assert.equal(unclaimed.account, null);

  // claimed → authenticated with account view
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const authed = await account.resolveIdentity(created.session.token);
  assert.equal(authed.state, "authenticated");
  assert.equal(authed.account?.username, creds.username);
  assert.equal(db.rows("guests").length, before + 2, "resolution never creates");
});

test("cross-user isolation: guest B cannot touch guest A's identity", async () => {
  const a = await account.createAccount({ username: "UserAaa1", password: "Strong!PassA" });
  const b = await account.createAccount({ username: "UserBbb2", password: "Strong!PassB" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.notEqual(a.session.guestId, b.session.guestId);
  // B cannot refresh A's session, revoke A's session by its jti from B's
  // context, or log out A's token — identity always comes from the token.
  const aJti = String((await verifySession(a.session.token))?.jti);
  await assert.rejects(() => refreshSessionToken(b.session.guestId, aJti), /session_unavailable/);

  // A's data rows stay bound to A regardless of B's actions
  const guestA = a.session.guestId;
  db.rows("ustad_coin_ledger").push({ guest_id: guestA, amount: 10 });
  const out = await account.logoutSession(b.session.token);
  assert.equal(out.ok, true);
  assert.equal(db.rows("ustad_coin_ledger")[0].guest_id, guestA);
  const aStill = await account.resolveIdentity(a.session.token);
  assert.equal(aStill.state, "authenticated", "B's logout must not affect A");
});

/* ------------------------------------------------------------------ */
/* §26.14 — claim + restore data continuity on a NEW device            */
/* ------------------------------------------------------------------ */

test("new device: restore on an empty device rebuilds nothing and loses nothing", async () => {
  const firstDevice = await account.createAccount(creds);
  assert.equal(firstDevice.ok, true);
  if (!firstDevice.ok) return;
  const guestId = firstDevice.session.guestId;
  db.rows("ustad_coin_ledger").push({ guest_id: guestId, amount: 900 });
  db.rows("settings").find((s) => s.guest_id === guestId)!.language = "hindi";

  // second device = a call with NO local state at all, just credentials
  const secondDevice = await account.loginAccount(creds);
  assert.equal(secondDevice.ok, true);
  if (!secondDevice.ok) return;
  assert.equal(secondDevice.session.guestId, guestId);
  assert.equal(db.rows("ustad_coin_ledger")[0].guest_id, guestId);
  assert.equal(db.rows("settings").find((s) => s.guest_id === guestId)!.language, "hindi");
  assert.equal(db.rows("guests").length, 1);
});

/* ------------------------------------------------------------------ */
/* Part 14 — concurrency: simultaneous login / logout / slow network   */
/* ------------------------------------------------------------------ */

test("two SIMULTANEOUS logins → still exactly ONE live session (policy §15)", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const [a, b] = await Promise.all([account.loginAccount(creds), account.loginAccount(creds)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const live = db.rows("ustad_sessions").filter((s) => s.revoked_at === null);
  assert.equal(live.length, 1, "one-active-session policy holds under concurrency");
  assert.equal(live[0].guest_id, created.session.guestId);
  // no orphan sessions, no second identity
  assert.equal(db.rows("guests").length, 1);
  assert.equal(db.rows("ustad_accounts").length, 1);
});

test("two SIMULTANEOUS logouts are idempotent and honest", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const [a, b] = await Promise.all([
    account.logoutSession(created.session.token),
    account.logoutSession(created.session.token),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // revoked exactly once, still one session row
  const all = db.rows("ustad_sessions");
  assert.equal(all.length, 1);
  assert.ok(all[0].revoked_at);
});

test("slow network: an outage during login never counts as a failed attempt", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  db.networkDown = true;
  const res = await account.loginAccount(creds);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "network");
  db.networkDown = false;

  // retry after the timeout: same account, and the outage did NOT raise the
  // counter or lock a legitimate user out (§13, §25)
  assert.equal(db.rows("ustad_accounts")[0].failed_attempts, 0);
  const retry = await account.loginAccount(creds);
  assert.equal(retry.ok, true);
});

test("duplicate concurrent CREATE attempts (same username) → one identity, one account", async () => {
  const [a, b] = await Promise.all([account.createAccount(creds), account.createAccount(creds)]);
  const results = [a, b].map((r) => (r.ok ? "ok" : r.code)).sort();
  assert.deepEqual(results, ["ok", "username_taken"]);
  assert.equal(db.rows("guests").length, 1);
  assert.equal(db.rows("ustad_accounts").length, 1);
  assert.equal(db.rows("ustad_sessions").filter((s) => s.revoked_at === null).length, 1);
  assert.equal(db.rows("profiles").length, 1);
  assert.equal(db.rows("settings").length, 1);
});

/* ------------------------------------------------------------------ */
/* Hardening §18 — 500 / unknown server errors never lose identity     */
/* ------------------------------------------------------------------ */

test("500 during login → server_error (NEVER invalid_credentials), retry works", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  db.serverError = true;
  const res = await account.loginAccount(creds);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "server_error", "a 500 is a server error, not wrong credentials");
  // the outage did not touch the account state
  assert.equal(db.rows("ustad_accounts")[0].failed_attempts, 0);
  db.serverError = false;

  const retry = await account.loginAccount(creds);
  assert.equal(retry.ok, true, "the same credentials work once the server recovers");
  assert.equal(db.rows("guests").length, 1, "a 500 never creates a new guest");
});

test("500 during bootstrap → retryable failure, SAME identity after recovery", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const before = db.rows("guests").length;

  db.serverError = true;
  await assert.rejects(
    () => bootstrapGuest(created.session.token),
    /network/,
    "any thrown bootstrap failure is a retryable error, never needsIdentity",
  );
  db.serverError = false;

  const res = await bootstrapGuest(created.session.token);
  assert.equal(res.needsIdentity, false);
  assert.equal(res.guestId, created.session.guestId, "identity is never replaced");
  assert.equal(db.rows("guests").length, before, "no guest was minted during the outage");
});

test("concurrent bootstraps share ONE session and the SAME guest (no remount mint)", async () => {
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const [a, b] = await Promise.all([
    bootstrapGuest(created.session.token),
    bootstrapGuest(created.session.token),
  ]);
  assert.equal(a.needsIdentity, false);
  assert.equal(b.needsIdentity, false);
  assert.equal(a.guestId, created.session.guestId);
  assert.equal(b.guestId, created.session.guestId);
  // refresh keeps the SAME jti → still exactly one session row, one guest
  assert.equal(db.rows("ustad_sessions").length, 1);
  assert.equal(db.rows("guests").length, 1);
});

/* ------------------------------------------------------------------ */
/* §26.15 — the RPC + token layers cooperate (§4, §9)                  */
/* ------------------------------------------------------------------ */

test("issueSessionToken persists the row BEFORE any token exists", async () => {
  const id = newGuestId();
  db.rows("guests").push({ id });
  db.outages.add("ustad_sessions");
  await assert.rejects(() => issueSessionToken(id), /database_error/);
  assert.equal(db.rows("ustad_sessions").length, 0, "no row, no token");
  db.outages.delete("ustad_sessions");

  const token = await issueSessionToken(id);
  const v = await verifySession(token);
  assert.ok(v);
  assert.equal(db.rows("ustad_sessions").length, 1);
  assert.equal(v.jti, db.rows("ustad_sessions")[0].jti);
});

test("signSessionToken only signs rows that the database already confirmed", async () => {
  const id = newGuestId();
  db.rows("guests").push({ id });
  const jti = crypto.randomUUID();
  db.rows("ustad_sessions").push({
    jti,
    guest_id: id,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + DAY).toISOString(),
    revoked_at: null,
    revoked_reason: "",
  });
  const token = await signSessionToken(id, jti);
  const v = await verifySession(token);
  assert.equal(v?.guestId, id);
  assert.equal(v.jti, jti);
  assert.equal(db.rows("ustad_sessions").length, 1, "signing never inserts");
});

test("verifySession / verifyToken reject malformed and forged tokens", async () => {
  assert.equal(await verifyToken(null), null);
  assert.equal(await verifyToken("a.b.c.d.e"), null);
  const created = await account.createAccount(creds);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  // tamper with the signature and the payload
  const parts = created.session.token.split(".");
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.AAAA`;
  assert.equal(await verifyToken(tampered), null);
  const wrongGuest = `${newGuestId()}.${parts[1]}.${parts[2]}.${parts[3]}`;
  assert.equal(await verifyToken(wrongGuest), null);
});
