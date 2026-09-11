/**
 * SOURCE GUARDS — the permanent-identity acceptance criteria, checked against
 * the real code and migration on every run.
 *
 * These are deliberately static assertions: they lock in the properties that
 * cannot be proven by a unit test alone (a DB row is written before a token is
 * handed out, no code path can mint a Guest ID automatically, the ownership key
 * stays `guests.id`, no server function accepts a client-supplied guest id).
 * If someone later "simplifies" any of them, this file fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const migration = read("supabase/migrations/20260909060000_guest_identity_accounts.sql");
const guestServer = read("src/lib/guest.server.ts");
const dataServer = read("src/lib/data.server.ts");
const accountServer = read("src/lib/account.server.ts");

/* ------------------------------------------------------------------ */
/* §2 / §25 — guests.id stays the ONE ownership identity               */
/* ------------------------------------------------------------------ */

test("the account layer binds to the existing guests table and never replaces it", () => {
  assert.match(migration, /create table if not exists public\.ustad_accounts/);
  assert.match(
    migration,
    /guest_id text primary key references public\.guests \(id\) on delete cascade/,
    "ustad_accounts.guest_id must reference guests(id)",
  );
  // No destructive statement anywhere in the migration.
  for (const forbidden of [
    /\bdrop table\b/i,
    /\bdrop column\b/i,
    /\btruncate\b/i,
    /\bdelete from\b/i,
  ]) {
    assert.equal(forbidden.test(migration), false, `migration must not contain ${forbidden}`);
  }
});

test("username uniqueness is enforced by the DATABASE, not only by app code", () => {
  assert.match(
    migration,
    /create unique index if not exists ustad_accounts_username_norm_uidx\s+on public\.ustad_accounts \(username_normalized\)/,
  );
});

test("no feature table was re-keyed to a new account id", () => {
  // Every user-owned table already uses guest_id; the patch must not introduce
  // a second ownership column. (A new account_id/user_id column would appear in
  // the generated types as an ownership candidate.)
  const types = read("src/integrations/supabase/types.ts");
  const tables = types.split("\n      ").filter((b) => /^[a-z_]+: \{\n {8}Row: \{/.test(b));
  for (const block of tables) {
    const name = block.slice(0, block.indexOf(":"));
    if (name === "ustad_accounts") continue; // the credential layer itself
    assert.equal(
      /\n {10}account_id:/.test(block),
      false,
      `${name} must not gain an account_id ownership column`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* §3 — a token is never issued without a persisted session row        */
/* ------------------------------------------------------------------ */

test("issueSessionToken writes the session row first and inspects the DB error", () => {
  const start = guestServer.indexOf("export async function issueSessionToken");
  assert.notEqual(start, -1);
  const body = guestServer.slice(
    start,
    guestServer.indexOf("export async function issueFreshSessionToken"),
  );
  assert.match(body, /const \{ data, error \} = await db\(\)/, "must read { data, error }");
  assert.match(body, /from\("ustad_sessions"\)/);
  assert.match(body, /if \(error\) throw new Error\("database_error"\)/, "DB failure is typed");
  assert.match(body, /if \(!data\) throw new Error\("session_unavailable"\)/, "no row, no token");
  // The old silent-catch behaviour must be gone.
  assert.equal(/catch\s*\{\s*\/\* a session bookkeeping failure/.test(body), false);
  // The throw must come BEFORE the token is returned.
  assert.ok(
    body.indexOf("throw new Error") < body.indexOf("return buildSessionToken"),
    "no token may be built before the session row is confirmed",
  );
});

test("every place that hands out a device credential uses a confirmed session", () => {
  // create + claim: the session row comes from the atomic RPC, and the token
  // is only SIGNED after the RPC returned its jti.
  for (const fn of ["createAccount", "claimExistingGuest"]) {
    const start = accountServer.indexOf(`export async function ${fn}`);
    assert.notEqual(start, -1);
    const body = accountServer.slice(start, start + 6000);
    assert.match(body, /rpc\("ustad_create_guest_account"/);
    assert.match(body, /signSessionToken\(/);
    assert.match(body, /if \(!jti\) return \{ ok: false, code: "session_unavailable" \}/);
  }
  // login: rotates through the atomic session RPC, never a bare insert
  const start = accountServer.indexOf("export async function loginAccount");
  const body = accountServer.slice(start, start + 6000);
  assert.match(body, /issueFreshSessionToken\(/);
  assert.match(body, /toIdentityErrorCode\(e\)/, "no raw error escapes a login failure");
});

test("bootstrap refreshes or MIGRATES sessions instead of minting an identity", () => {
  assert.match(dataServer, /refreshSessionToken\(session\.guestId, session\.jti\)/);
  assert.match(dataServer, /: await issueSessionToken\(session\.guestId\)/);
  // The legacy 2/3-part token is upgraded in place: same guest id, new session.
  const start = dataServer.indexOf("export async function bootstrapGuest");
  const body = dataServer.slice(start, dataServer.indexOf("/* ---------- conversations"));
  assert.match(body, /verifySession\(candidate\)/);
  assert.match(body, /session\.jti\s*\?/);
});

/* ------------------------------------------------------------------ */
/* §4 — logout can never be reported as successful without revocation  */
/* ------------------------------------------------------------------ */

test("revokeSession reports the real outcome from the RPC result", () => {
  const start = guestServer.indexOf("export async function revokeSession");
  const body = guestServer.slice(start, guestServer.indexOf("export async function verifyToken"));
  assert.match(body, /Promise<\{ ok: boolean \}>/);
  assert.match(body, /rpc\("ustad_revoke_session"/);
  assert.match(body, /if \(error\) return \{ ok: false \}/);
  // a thrown transport failure is UNKNOWN, never success
  assert.match(body, /return \{ ok: false \}/);
});

test("logoutSession refuses to claim success when revocation failed", () => {
  const start = accountServer.indexOf("export async function logoutSession");
  const body = accountServer.slice(start, start + 1200);
  assert.match(body, /const \{ ok \} = await revokeSession\(session\.jti, "logout"\)/);
  assert.match(body, /if \(!ok\) \{/);
  assert.match(body, /code: "logout_failed"/);
});

test("the client keeps the session when the server cannot confirm a logout", () => {
  const client = read("src/lib/ustad-client.ts");
  const start = client.indexOf("export async function logoutIdentity");
  const body = client.slice(start, start + 1400);
  assert.match(body, /if \(!res\.ok\) return \{ ok: false, code: res\.code \}/);
  // clearToken() must come AFTER the confirmation, never before.
  assert.ok(
    body.indexOf("clearToken();") > body.indexOf("if (!res.ok) return"),
    "local identity must only be dropped after a confirmed revocation",
  );
});

/* ------------------------------------------------------------------ */
/* §7 — no automatic Guest ID creation remains anywhere                */
/* ------------------------------------------------------------------ */

test("no server module mints a Guest ID except explicit account creation", () => {
  const files = readdirSync(new URL("../src/lib", import.meta.url))
    .filter((f) => f.endsWith(".server.ts") || f.endsWith(".ts"))
    .map((f) => `src/lib/${f}`);
  const offenders: string[] = [];
  for (const f of files) {
    if (f.includes("guest.server.ts") || f.includes("account.server.ts")) continue;
    if (f.endsWith("identity-spec.ts")) continue;
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    if (/newGuestId\(|mintGuest|createGuest\(/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], "only account creation may mint a Guest ID");
});

test("bootstrapGuest can never report an authenticated session without a real guest row", () => {
  const start = dataServer.indexOf("export async function bootstrapGuest");
  const body = dataServer.slice(start, dataServer.indexOf("/* ---------- conversations"));
  assert.match(body, /needsIdentity: true/);
  assert.match(body, /hasExistingGuest: false/);
  assert.match(body, /if \(guestError\) \{/);
  assert.match(body, /throw new Error\("network"\)/, "a DB outage must not look like a new user");
});

/* ------------------------------------------------------------------ */
/* §17 — no server function trusts a client-supplied identity          */
/* ------------------------------------------------------------------ */

test("no server function accepts a guest id, user id or account id from the client", () => {
  const dir = new URL("../src/lib/", import.meta.url);
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!/\.(functions|server)\.ts$/.test(f)) continue;
    const src = readFileSync(new URL(f, dir), "utf8");
    // inputValidator payloads only — that is the untrusted surface.
    for (const m of src.matchAll(/inputValidator\(([\s\S]{0,400}?)\)\s*\n/g)) {
      if (/\b(guest_id|guestId|user_id|userId|account_id)\b/.test(m[1])) {
        offenders.push(`${f}: ${m[1].trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the identity endpoints derive identity from the session, never from the body", () => {
  const fns = read("src/lib/identity.functions.ts");
  // The only client-supplied fields are the credentials themselves.
  for (const m of fns.matchAll(/inputValidator\(\(d: ([^)]+)\)/g)) {
    assert.equal(
      /\b(guest_id|guestId|user_id|userId|password_hash)\b/.test(m[1]),
      false,
      `untrusted identity input: ${m[1]}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* §12 / §13 — data actions are allowlisted                            */
/* ------------------------------------------------------------------ */

test("the client no longer deletes every ustad.* key", () => {
  const client = read("src/lib/ustad-client.ts");
  assert.match(client, /dataKeysToRemove\(localKeys\(\)\)/);
  assert.match(client, /cacheKeysToRemove\(localKeys\(\)\)/);
  // The dangerous blanket pattern must be gone for good.
  assert.equal(
    client.includes('k.startsWith("ustad.")'),
    false,
    "broad ustad.* deletion must never come back",
  );
});

test("Clear Cache is guarded out of identity keys by the shared spec", () => {
  const spec = read("src/lib/identity-spec.ts");
  const start = spec.indexOf("export function cacheMayRemove");
  const body = spec.slice(start, spec.indexOf("export function dataMayRemove"));
  assert.match(body, /matches\(key, DATA_STORAGE_KEYS\)/, "identity keys must be excluded");
  assert.match(body, /matches\(key, PRESERVED_STORAGE_KEYS\)/, "device prefs must be excluded");
});

/* ------------------------------------------------------------------ */
/* §6 — exactly ONE writer for the local identity keys                 */
/* ------------------------------------------------------------------ */

test("only the central identity store may write or clear the guest id/token keys", () => {
  const dir = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  const walk = (url: URL) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const rel = `src/${child.pathname.split("/src/")[1]}`;
      const src = readFileSync(child, "utf8");
      const writes =
        /localStorage\.setItem\(\s*(?:ID_KEY|TOKEN_KEY)/.test(src) ||
        /localStorage\.removeItem\(\s*"(ustad\.guest\.(?:id|token))"/.test(src) ||
        /localStorage\.setItem\(\s*"(ustad\.guest\.(?:id|token))"/.test(src);
      if (writes && !rel.endsWith("src/lib/ustad-client.ts")) offenders.push(rel);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], "no feature may write the identity keys directly");
});

test("resolveIdentity treats a database outage as transient, not as an unknown user", () => {
  const start = accountServer.indexOf("export async function resolveIdentity");
  const body = accountServer.slice(start, start + 3500);
  assert.match(body, /const \{ data: guest, error: guestError \}/);
  assert.match(body, /if \(guestError\) \{/);
  assert.match(body, /throw new Error\("network"\)/);
  // the OUTAGE branch throws network; invalid_session is reserved for a
  // genuinely missing guest row
  const outageThrow = body.indexOf('throw new Error("network")');
  const guestMissing = body.indexOf("if (!guest) {");
  assert.ok(outageThrow !== -1 && outageThrow < guestMissing, "outage verdict comes first");
});

/* ------------------------------------------------------------------ */
/* Hardening §1-§12 — the typed error model, locked in source          */
/* ------------------------------------------------------------------ */

test("accountByNormalized / accountByGuest inspect { error } and throw typed errors", () => {
  const body = accountServer.slice(
    accountServer.indexOf("async function accountByNormalized"),
    accountServer.indexOf(
      "/* ------------------------------------------------------------------ */\n/* Identity resolution",
    ),
  );
  assert.match(body, /const \{ data, error \} = await sdb\(\)/);
  assert.match(body, /if \(error\) throw new Error\("database_error"\)/);
  assert.match(body, /return \(data as Row\) \?\? null/);
  // the typed catch: transport → network, anything else → server_error
  assert.match(body, /classifyClientFailure\(e\)/);
  assert.match(body, /throw new Error\(kind ===/);
  assert.match(body, /"server_error"\)/);
  // The forbidden pattern: destructuring only data and treating null as "absent".
  assert.equal(body.includes("const { data } = await sdb()"), false);
});

test("resolveIdentity cannot report invalid_session for a database outage", () => {
  const start = accountServer.indexOf("export async function resolveIdentity");
  const body = accountServer.slice(start, start + 3500);
  assert.match(body, /if \(guestError\) \{/);
  assert.match(body, /sessionIsRevoked\(session\.jti\)/, "revocation is part of resolution");
  // the ONLY invalid_session verdicts: revoked/missing session or missing guest
  const verdicts = (body.match(/state: "invalid_session"/g) ?? []).length;
  assert.equal(verdicts, 2);
});

test("createAccount + claim run ONE atomic RPC and map errors precisely (§9, §11)", () => {
  for (const fn of ["createAccount", "claimExistingGuest"]) {
    const start = accountServer.indexOf(`export async function ${fn}`);
    const body = accountServer.slice(start, start + 4000);
    assert.match(body, /rpc\("ustad_create_guest_account"/, `${fn} must use the atomic RPC`);
    assert.match(body, /mapRpcErrorCode\(String\(error\.code\)\)/, `${fn} must map error codes`);
  }
  // createAccount must NOT fall back to the old multi-step partial writes
  const createStart = accountServer.indexOf("export async function createAccount");
  const createBody = accountServer.slice(createStart, createStart + 3000);
  assert.equal(createBody.includes("ensureGuestRow"), false, "guest bootstrap moved INTO the RPC");
});

test("login verifies the password BEFORE consulting the lock (§10 no enumeration)", () => {
  const start = accountServer.indexOf("export async function loginAccount");
  const body = accountServer.slice(start, start + 3000);
  const verify = body.indexOf("await verifyPassword(");
  const lock = body.indexOf("await isTemporarilyLocked(row)");
  assert.ok(verify !== -1 && lock !== -1 && verify < lock, "password first, lock second");
  // the critical reset write is checked before any session is handed out
  assert.match(body, /const \{ error: resetError \} = await sdb\(\)/);
  assert.match(body, /if \(resetError\) return \{ ok: false, code: "database_error" \}/);
});

test("sessions: rotate/refresh/revoke all run through the verifying RPCs (§4-§6)", () => {
  assert.match(guestServer, /rpc\("ustad_issue_fresh_session"/, "rotation must be one transaction");
  assert.match(guestServer, /rpc\("ustad_refresh_session"/);
  assert.match(guestServer, /rpc\("ustad_revoke_session"/);
  // refresh: zero rows (missing/revoked/wrong guest) → no token
  const rf = guestServer.slice(
    guestServer.indexOf("export async function refreshSessionToken"),
    guestServer.indexOf("export type SessionState"),
  );
  assert.match(
    rf,
    /if \(!Array\.isArray\(data\) \|\| data\.length === 0\) throw new Error\("session_unavailable"\)/,
  );
  // session state is a THREE-state verdict, missing is never active
  const st = guestServer.slice(
    guestServer.indexOf("export type SessionState"),
    guestServer.indexOf("export async function revokeSession"),
  );
  assert.match(st, /export type SessionState = "active" \| "revoked" \| "missing"/);
  assert.match(st, /if \(!data\) return "missing"/);
});

test("bootstrap maps missing-session → Welcome but DB failure → retry (§7 vs §25)", () => {
  const start = dataServer.indexOf("export async function bootstrapGuest");
  const body = dataServer.slice(start, start + 6000);
  assert.match(body, /msg\.includes\("session_unavailable"\)/, "dead session goes to Welcome");
  assert.ok(
    body.indexOf('identity: "invalid_session"') < body.indexOf('throw new Error("network")'),
    "session_unavailable verdict precedes the network fallback",
  );
  assert.match(body, /throw new Error\("network"\)/, "DB failures preserve identity");
});

test("every identity server fn wraps its backend in a typed error boundary (§24)", () => {
  const fns = read("src/lib/identity.functions.ts");
  const handlers = (fns.match(/\.handler\(async /g) ?? []).length;
  const catches = (fns.match(/toIdentityErrorCode\(e\)/g) ?? []).length;
  assert.equal(handlers, 6);
  assert.equal(catches, 6, "no handler may leak a raw backend error");
  // no raw password/token is ever echoed or logged
  assert.equal(/console\.(log|error)\([^)]*password/i.test(fns), false);
  assert.equal(/console\.(log|error)\([^)]*password/i.test(accountServer), false);
  assert.equal(/console\.(log|error)\([^)]*password/i.test(guestServer), false);
});

test("token storage has ONE intentional source: persistent localStorage (§12)", () => {
  const client = read("src/lib/ustad-client.ts");
  const readToken = client.slice(
    client.indexOf("export function readToken"),
    client.indexOf("export function readStoredUsername"),
  );
  // the IMPLEMENTATION reads localStorage only — a sessionStorage read would
  // shadow the persistent identity and is forbidden (comments may mention it)
  assert.equal(readToken.includes("sessionStorage.getItem"), false);
  assert.match(readToken, /localStorage\.getItem\(TOKEN_KEY\)/);
  // cross-tab sync (§21) must react to identity changes in OTHER tabs
  assert.match(client, /addEventListener\("storage"/);
});

test("the migration ships the four atomic identity RPCs", () => {
  for (const fn of [
    "ustad_issue_fresh_session",
    "ustad_refresh_session",
    "ustad_revoke_session",
    "ustad_create_guest_account",
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}`), fn);
  }
  assert.match(migration, /errcode = 'U0001'/, "guest_already_claimed has its own SQLSTATE");
  // service-role-only execution, like the existing ustad_shop_buy pattern
  assert.match(
    migration,
    /grant execute on function public\.ustad_create_guest_account[^;]*to service_role/,
  );
  assert.match(
    migration,
    /revoke all on function public\.ustad_create_guest_account[^;]*from public/,
  );
});

/* ------------------------------------------------------------------ */
/* Ultra-hardening §7, §11, §16 — double-submit, ownership, no recovery */
/* ------------------------------------------------------------------ */

test("double-submit: identity actions share one in-flight request (§7)", () => {
  const client = read("src/lib/ustad-client.ts");
  assert.match(client, /const inflightActions = new Map/);
  assert.ok(client.includes("dedupe(`create:"), "create must be deduped");
  assert.ok(client.includes("dedupe(`restore:"), "restore must be deduped");
  assert.ok(client.includes("dedupe(`claim:"), "claim must be deduped");
  assert.ok(client.includes('dedupe("logout"'), "logout must be deduped");
  // UI busy guards exist as the first line of defence
  const screen = read("src/components/IdentityScreen.tsx");
  assert.match(screen, /if \(busy\) return;/);
  assert.match(screen, /disabled=\{busy\}/);
});

test("no ownership column exists beyond guests.id / account user_id (§11)", () => {
  const types = read("src/integrations/supabase/types.ts");
  // owner_id must not appear as any table column (guest_id is the ownership key)
  assert.equal(/owner_id:/.test(types), false, "owner_id columns must not exist");
  const client = read("src/lib/ustad-client.ts");
  // no legacy local identity key names beyond the canonical three
  assert.equal(client.includes('localStorage.setItem("guest_id"'), false);
  assert.equal(client.includes('localStorage.setItem("guestId"'), false);
  assert.equal(client.includes('localStorage.setItem("guest.id"'), false);
});

test("no feature-local identity store exists anywhere in src (§11)", () => {
  const dir = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  const walk = (url: URL) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const rel = `src/${child.pathname.split("/src/")[1]}`;
      // canonical owners of the identity keys + their spec constants
      if (
        [
          "src/lib/ustad-client.ts",
          "src/lib/identity-spec.ts",
          "src/components/IdentityScreen.tsx",
        ].includes(rel)
      )
        continue;
      const src = readFileSync(child, "utf8");
      // feature-local writes to identity-like keys are forbidden
      if (/localStorage\.setItem\(\s*["'`]ustad\.(guest|identity)\./.test(src)) offenders.push(rel);
      if (/\bgenerateGuestId\b|\bmintGuest\b|\bcreateGuestId\b/.test(src)) offenders.push(rel);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, []);
});

test("no password recovery / reset flow exists (§16 — explicitly NOT wanted)", () => {
  const dir = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  const walk = (url: URL) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const src = readFileSync(child, "utf8");
      if (
        /forgot[_-]?password|password[_-]?recovery|reset[_-]?password|recover[_-]?account|email[_-]?otp/i.test(
          src,
        )
      )
        offenders.push(`src/${child.pathname.split("/src/")[1]}`);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], "password recovery must not be implemented");
});

test("legacy docs and code agree: legacy guests keep Home + optional claim (§6)", () => {
  // the runtime path: authenticated without account → Home, offer only
  const start = accountServer.indexOf("export async function resolveIdentity");
  const body = accountServer.slice(start, start + 3000);
  assert.match(body, /account: row \? toAccountView\(row\) : null/);
  assert.match(body, /hasExistingGuest: true/);
  // the docs must describe the same behaviour
  const docs = read("docs/PERMANENT-GUEST-IDENTITY.md");
  assert.match(docs, /keeps going straight Home/i);
  assert.match(docs, /offered[^)]*never forced/i);
  // and no doc may claim legacy guests are forced into Welcome
  assert.equal(/every legacy [Gg]uest.*(must|has to).*(Welcome|NEW GUEST ID)/s.test(docs), false);
});

test("the one-active-session policy is preserved (§15 — no multi-session code)", () => {
  const migration = read("supabase/migrations/20260909060000_guest_identity_accounts.sql");
  // rotation revokes all live sessions in ONE transaction — not a multi-session design
  assert.match(
    migration,
    /update public\.ustad_sessions[\s\S]{0,120}?set revoked_at = now\(\), revoked_reason = 'rotated'/,
  );
  // no UI or code for session management was added
  const client = read("src/lib/ustad-client.ts");
  assert.equal(client.includes("logoutAll"), false);
  assert.equal(client.includes("activeSessions"), false);
});

/* ------------------------------------------------------------------ */
/* Hardening §1-§4, §14 — identity clearing + local storage security    */
/* ------------------------------------------------------------------ */

test("a THROWN bootstrap failure can never clear the stored token (§4)", () => {
  const client = read("src/lib/ustad-client.ts");
  const start = client.indexOf("export function ensureGuest");
  const end = client.indexOf("export async function recoverGuest");
  const body = client.slice(start, end);
  // the catch exists and reports a retryable state…
  assert.match(body, /\.catch\(/);
  assert.match(body, /status: "error"/);
  assert.match(body, /transient: true/);
  // …and clearToken() is NOT inside this function at all
  assert.equal(body.includes("clearToken();"), false, "no throw may clear identity");
  // the narrow string matcher is gone — the central typed classifier is used
  assert.equal(body.includes("isNetworkError"), false);
});

test("identity keys are only cleared by explicit actions or a confirmed verdict", () => {
  const client = read("src/lib/ustad-client.ts");
  const calls: { fn: string; at: number }[] = [];
  for (const m of client.matchAll(/clearToken\(\);/g)) {
    const before = client.slice(0, m.index);
    const fn = (before.match(/(?:export )?(?:async )?function (\w+)/g) ?? []).pop() ?? "?";
    calls.push({ fn, at: m.index });
  }
  // allowed sites: logoutIdentityOnce, clearLocalData (via allowlist, plus
  // resetGuestCache), recoverGuest(dropToken), and bootstrap's CONFIRMED
  // needsIdentity branch — never a catch, never a retry path
  for (const { fn } of calls) {
    assert.ok(
      /logoutIdentityOnce|recoverGuest|bootstrap/.test(fn),
      `clearToken may only run in an explicit/confirmed context, found in ${fn}`,
    );
  }
});

test("passwords are never persisted to any local storage (§14)", () => {
  const dir = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  const walk = (url: URL) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const src = readFileSync(child, "utf8");
      if (/(localStorage|sessionStorage)\.setItem\([^)]*password/i.test(src))
        offenders.push(`src/${child.pathname.split("/src/")[1]}`);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], "no component may write a password to storage");
});

test("the client uses the central typed failure classifier, not ad-hoc regexes", () => {
  const client = read("src/lib/ustad-client.ts");
  assert.match(client, /classifyClientFailure\(/);
  assert.match(client, /toIdentityErrorCode\(/);
  assert.match(client, /shouldPreserveIdentityOnError\(/);
  assert.equal(
    /fetch\|network\|Failed to fetch\|load failed\|timeout\|ECONN/.test(client),
    false,
    "the old inline error-regex matcher must not return",
  );
});
