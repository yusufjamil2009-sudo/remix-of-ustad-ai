# Permanent Guest ID · Backup ID · Sessions & Data (USTAD AI)

One-time identity setup, a **permanent** server-side Guest ID, and a login you can
carry to any device — built **on top of** the existing guest model. No existing
feature, table, page, engine or piece of user data was replaced.

---

## 1. What the user sees

| Situation | Result |
|---|---|
| Very first open (no identity on this device) | **Welcome**: `[NEW GUEST ID]` · `[BACKUP ID]` |
| New Guest ID | Username + Password form → account created server-side → **Home** |
| Username already taken | *"This username is already registered. Please choose another username or use Backup ID to restore your existing account."* |
| Backup ID | Username + Password → **existing** account reconnected (same Guest ID, same data) |
| Wrong username **or** wrong password | *"Username or password is incorrect."* (identical message — no account-existence leak) |
| Normal open after that | **Direct Home.** No Welcome, no password prompt |
| Refresh / browser restart / device restart / app close | Still signed in |
| `Settings → Data → Log Out` | Session revoked server-side → next open shows **Welcome**. Account + data untouched |
| `Settings → Data → Clear Cache` | Temporary files only → next open goes **straight Home** |
| `Settings → Data → Clear Data` | Confirmation dialog → local data cleared → next open shows **Welcome**. Server account + data untouched |
| Guest that predates this feature | Keeps its Guest ID **and keeps going straight Home**; is *offered* (never forced) a username + password via a dismissible notice |

Logout and Clear Data are **not** account deletion. Nothing here ever deletes a
Guest ID, a username, a password hash or any permanent data. There is no
automatic expiry, inactivity deletion or data reset anywhere in this system.

---

## 2. Architecture

```
client (ustad-client.ts)            server (server functions)             database
──────────────────────────          ──────────────────────────            ────────
one identity store         ──────▶  identityStatusFn   → resolveIdentity() │ guests (existing)
  status/identity/session  ──────▶  createGuestAccountFn → createAccount() │ ustad_accounts
  useGuest() everywhere    ──────▶  restoreBackupFn      → loginAccount()  │ ustad_sessions
  no per-component logic   ──────▶  claimIdentityFn      → claimExisting() │ ustad_login_attempts
                           ──────▶  logoutFn             → logoutSession()
```

* **`guests` stays the account row.** Its `id` *is* the permanent Guest ID, so
  profiles, coins, purchases, tournaments, events, cups, trophies, certificates,
  badges, leaderboards, notifications and settings keep pointing at the same key.
  No re-keying, no data migration.
* **`ustad_accounts`** adds the login layer: `guest_id` (PK), `user_id`,
  `username`, `username_normalized` (**UNIQUE**), `password_hash`, `password_algo`,
  `failed_attempts`, `locked_until`, `last_login_at`, timestamps.
* **`ustad_sessions`** (`jti` PK, guest, issued/expires/revoked) makes LOG OUT a
  real server-side revocation instead of a client flag.
* Migration: `supabase/migrations/20260909060000_guest_identity_accounts.sql` —
  idempotent, non-destructive, no drops, RLS enabled, service-role only.

### Identity concepts, kept distinct
| Concept | Meaning |
|---|---|
| `user_id` | Canonical UUID identity of the account |
| `guest_id` | Permanent, public, human-visible identifier — **not** a credential |
| `username` | The human login, unique via `username_normalized` |
| session `jti` | The revocable session this device holds |

---

## 3. Security properties

* **No fake auth.** Every screen calls a real server function; the server verifies
  credentials and returns a signed session. There is no `localStorage.isLoggedIn`
  flag and frontend validation is never the only check.
* **`guest_id` is not an authority.** Every server function derives the actor from
  the verified session (`requireGuest`) and then ownership-checks; a
  client-supplied `guest_id` / `user_id` / `username` is never trusted.
* **Passwords**: scrypt (memory-hard, Node core — see `src/lib/password.server.ts`),
  16-byte random salt per password, parameters stored with the hash
  (`scrypt$N$r$p$salt$hash`), constant-time comparison, never plaintext in the DB,
  logs, errors or responses.
* **No enumeration.** Unknown username and wrong password return the same generic
  error. Raw backend/constraint errors are never surfaced to the user.
* **Abuse protection**: failed-attempt counting plus a short, self-healing lock
  (`locked_until`) so legitimate users are never permanently locked out; every
  attempt is audited in `ustad_login_attempts`.
* **Race-safe uniqueness**: `username_normalized` is a DB unique index, so two
  simultaneous "New Guest ID" requests cannot both win.
* **Sessions** are HMAC-signed (`guestId.exp.jti.signature`), 365-day TTL, kept in
  an HttpOnly cookie plus the signed token. No password is ever stored locally.
  Legacy 2-part/3-part tokens still verify — nobody is logged out by this change.
* **Network failure ≠ new user.** Transient errors keep the stored identity and
  offer a retry; only an explicit user action changes identity.

---

## 4. Local data scopes (enforced by `cacheMayRemove` / `dataMayRemove`)

| Key | Clear Cache | Clear Data |
|---|---|---|
| `ustad.cache.*`, `ustad.ui.tmp.*`, `ustad.prefetch.*` | removed | removed |
| `ustad.guest.token`, `ustad.guest.id`, `ustad.identity.*` | **kept** | removed |
| `ustad.settings.<guestId>` mirror | kept | removed |
| `ustad.theme` (device display preference) | kept | **kept** |
| Server account + permanent data | untouched | untouched |

The existing server-side *"Delete selected"* scope deletion in
`Settings → Data` is untouched and remains a separate, explicitly confirmed
action; it never touches identity, username or password.

---

## 5. Patch notes — hardening pass (identity bugs)

| # | Bug | Fix |
|---|---|---|
| 1 | A session token could be handed out even if the `ustad_sessions` row was not written, producing a token that could never be revoked | `issueSessionToken()` now writes the row first, inspects the database's own `{ data, error }` (Supabase returns errors without throwing) and **throws `session_unavailable` before any token exists**. `issueFreshSessionToken()` rotates older sessions so create/restore/claim always leave exactly one live session. |
| 2 | Logout could be reported as successful when the revocation UPDATE failed | `revokeSession()` returns `{ ok }`, inspecting the DB error and treating only "already revoked" as success. `logoutSession()` returns `logout_failed` when it cannot confirm, and the client **keeps the session** and offers a retry instead of pretending the user signed out. |
| 3 | Legacy 2-part/3-part tokens bypassed the revocable session model | They keep working and are **migrated in place** on the next open: a new revocable session row + 4-part token for the SAME Guest ID. No new identity, no data change. |
| 4 | Clear Data deleted every `ustad.*` key | Replaced with an explicit **allowlist** (`DATA_STORAGE_KEYS`); unrelated feature state (classroom sessions, drafts, carts, device theme) survives. Covered by tests over a realistic device key set. |
| 5 | The one-time setup offer was dismissed globally | Key is now per guest (`ustad.identity.setupDismissed.<guestId>`), so one account's dismissal never hides it for another account on the same device. |
| 6 | Local localStorage username could act as identity | The display username is refreshed from the server account on every open (cache only), and a DB outage is a retryable transient error rather than an "unknown user" verdict. |

## 6. Hardening pass 2 — database-error model + atomic identity RPCs (2026-09-10)

Follow-up hardening prompt, implemented line-by-line (§1-§28):

**Typed error model (§1-§3).** The four cases can never blur: a genuinely absent
row is `null`; a database failure is a typed `database_error`; a transport failure
is `network`; a real unique violation is `username_taken`. `accountByNormalized`
and `accountByGuest` inspect `{ error }` and throw typed errors; `resolveIdentity`
throws `network` on any outage so an outage is never read as "invalid session" or
"new user"; the client store preserves the stored identity on transient failures.

**Atomic identity RPCs (§4, §5, §9).** Four `security definer` / service-role-only
functions (same pattern as the existing `ustad_shop_buy`):
`ustad_issue_fresh_session` (revoke-all + insert in ONE transaction — the
"old live + new live" state cannot exist), `ustad_refresh_session` (updates only a
session that exists, belongs to THIS guest and is not revoked; zero rows → no
token), `ustad_revoke_session` (LOG OUT), and `ustad_create_guest_account`
(guest + profile + settings + account + session as one atomic creation; 23505 →
username_taken, U0001 → guest_already_claimed, anything else → database_error).
`createAccount` and `claimExistingGuest` now run entirely through that RPC, so a
partial identity can never exist and a duplicate-username race is decided by the
unique index inside the transaction.

**Session states (§6, §7).** `sessionIsRevoked` is now a three-state verdict
(`active` / `revoked` / `missing`); a missing row is its own state and is never
"active". Bootstrap maps a genuinely dead session to `needsIdentity` (Welcome) but
maps ANY database/transport failure to a retryable `network` error with the stored
identity preserved — a stale/expired/revoked/missing session can never mint a new
Guest ID, and a temporary outage can never lose one.

**Login counter writes (§10).** The password is verified BEFORE the lock is
consulted (a locked account is unenumerable), the critical reset write is checked
before any session is issued, and a failed counter write never re-maps the
credential verdict.

**Token storage (§12).** One intentional source: persistent localStorage only;
`sessionStorage` is never used for identity. Cross-tab storage sync (§21) keeps
every tab on the same identity (login/logout/Clear Data in one tab propagate).

**Runtime integration tests (§26).** `tests/identity-runtime.test.ts` (36 tests)
executes the REAL modules over an injected in-memory database transport — real
scrypt hashing, real HMAC tokens, real RPC semantics with rollback — covering
new guest, duplicate/concurrent usernames, backup restore continuity, logout
(including revocation-failure honesty), expired/revoked/missing sessions,
every outage injection point, refresh verification, claim error mapping, lock
self-healing, legacy migration, rotation concurrency and cross-user isolation.

**Audit.** Full report: `docs/IDENTITY-AUDIT.md` (37 modules, 158 server
functions, 78 tables — 0 active legacy identity references).

## 7. Ultra-hardening pass 3 — production verification (2026-09-10)

Final pass over the whole identity surface. Everything already correct was left
untouched; only genuine gaps were patched:

**Double-submit hardening (§7).** The four identity actions (New Guest, Backup
ID, Secure this device, Log Out) share ONE in-flight request per action key: a
second tap while the first is running reuses it instead of racing itself. The
UI already had busy states; this is the store-level safety net. Database
uniqueness remains the final authority either way.

**Legacy documentation consistency (§6).** Verified: every doc/comment now
describes the ACTUAL runtime behaviour — a legacy guest keeps its Guest ID,
keeps all data, goes straight Home, and is only OFFERED (never forced) a
username + password via a dismissible notice. The migration header comment
was reworded to match; no application behaviour was changed for docs.

**Explicit non-goals (§16).** No password recovery/reset/forgot flow exists and
a guard test keeps it that way. One-active-session policy is preserved; no
multi-session UI or logout-all-devices was added. Settings → Language remains
the single language source of truth.

**Cross-feature restore matrix (§10).** The runtime restore test now carries
rows in EVERY user-owned feature table (wallets, ledger, purchases, tickets,
notifications + read state, tournament attempts + results, event attempts,
mega player results, certificates, achievements, trophies, rank awards,
profiles + board, settings + language) and asserts every one of them stays on
the SAME `guests.id` after logout → Backup ID restore, with zero new guests.

**Concurrency (§14).** Runtime tests cover simultaneous login (exactly one live
session afterwards), simultaneous logout (idempotent, revoked once), duplicate
concurrent create (exactly one winner, no orphans), concurrent refresh (same
jti, one row), and slow-network retry (an outage never raises `failed_attempts`
or locks a legitimate user).

## 8. Production verification boundary (what runs where)

| Verification | Where it ran | Status |
|---|---|---|
| Full automated suite (unit + pure + runtime + source guards) | this repository, executed | ✅ 524/524 passing (see §9) |
| Real Supabase schema/RPC/RLS + Test A–E | `scripts/production-identity-smoke.mjs` | ⏳ ready to run — requires `SUPABASE_SERVICE_ROLE_KEY` which is intentionally absent from this workspace (only public vars exist in the local `.env`) |
| Android Chrome / second device / browser flows | physical devices | ⏳ manual — the behaviour each step must show is listed in §1 and locked by tests |
| Cookie domain / SameSite / HTTPS | production host config | ⏳ set by the deployment target (the app writes HttpOnly/Secure/SameSite=lax cookies via the React Start server runtime) |

The sandbox never holds the service-role key or the signing secrets, so no
secret can leak from it; production runs the same code verified here, plus the
smoke script above as a one-command deployment check.

## 8b. Remaining-bugs pass + full lint cleanup (2026-09-11)

**Typed error classification (Bug Areas 1-4).** The narrow inline
`/fetch|network|.../` string matching is replaced by the central classifier in
`identity-spec.ts` — `classifyClientFailure()` → `network` (transport, DNS,
502/503/504) / `timeout` / `server_error` (500, unexpected RPC exceptions,
unknown Supabase errors). ALL THREE are retryable and NONE of them ever clears
identity: a THROWN bootstrap failure is by contract a server-side problem
(confirmed verdicts are return values, never throws), so the client always
preserves the stored token and shows a retry state — `clearToken()` is now
impossible on any throw and only runs for explicit Log Out / Clear Data / a
CONFIRMED invalid-session verdict / an explicit user re-handshake. Create /
restore / claim / logout failures map through `toIdentityErrorCode()` — an
unknown exception is `server_error`, never silently `validation`. The server
account lookups distinguish transport (`network`) from unknown backend throws
(`server_error`) — a database outage is still never "account not found".

**Regression tests (Bug Area 18).** Pure: classifier matrix (fetch, ECONN,
ENOTFOUND, 502/503/504, timeout, ETIMEDOUT, 500, unknown → every one preserves
identity, none maps to validation/credentials/username_taken) + trilingual
`timeout`/`server_error` messages. Runtime: a 500 during login → `server_error`
(never `invalid_credentials`, counter untouched, retry succeeds, no new guest);
a 500 during bootstrap → retryable throw, SAME `guests.id` after recovery;
concurrent bootstraps → one session row, one guest. Source guards: no
`clearToken()` call can live in a catch/retry path; passwords are never written
to any local storage; the inline error-regex matcher is gone.

**Full lint cleanup.** The entire repository now passes `npm run lint` with
**zero** problems (was 618 errors + 3 warnings). Fixes: prettier formatting
across previously-dirty files, `prefer-const` in `previewAuthStorage`,
`no-misleading-character-class` (intentional Devanagari ranges, documented),
`no-constant-condition` in `tournament-engine` (the `entry_txn_id || true`
tautology simplified to its actual always-true behaviour — refund semantics
unchanged), an honest `exhaustive-deps` fix in `NotificationCenter`, and
documented fast-refresh disables for the shadcn variant exports. No test was
weakened or removed; the suite grew from 514 to 524.

**Session-continuity matrix completed (Bug Area 5).** The restore test now
asserts EVERY user-owned surface from the prompt list, with REAL column names:
wallets/ledger (coins), purchases, tickets, notifications **including
read-state** (`is_read` + `read_at`), tournament attempts, events, mega
results, certificates, achievements, trophies, and the weekly
rankings/leaderboards payload (`ustad_rank_awards`: `cycle_start`, `rank`,
`cup_awarded`, `cup_count`, `coins`). Badges are equipped cosmetics
(`profiles.equipped_badge`/`equipped_frame`) and preferences are
`profiles.learning_preferences` — both asserted. `ustad_rank_cycles` is a
global settlement table (not guest-owned), verified separately by the rank
engine tests.

**Production smoke bridge extended (Part C).** `scripts/production-identity-smoke.mjs`
now also verifies: `USTAD_GUEST_SECRET` present (≥32 chars), RLS actually
hides identity rows from the public/anon key, the four identity RPCs reject
the anon key (public exec revoked), and optional `DEPLOYED_URL` HTTPS
reachability. SKIPped checks are reported honestly and never fail the run.

## 9. Deployment checklist

1. Apply `supabase/migrations/20260909060000_guest_identity_accounts.sql`.
   Existing guests are untouched and simply have no account row yet.
2. Set `USTAD_GUEST_SECRET` (≥ 32 chars) and `SUPABASE_SERVICE_ROLE_KEY` —
   the identity layer uses the same signing secret as existing sessions.
3. Run the production smoke bridge with server-only credentials:
   `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… USTAD_GUEST_SECRET=…     SUPABASE_PUBLISHABLE_KEY=… [DEPLOYED_URL=https://…]     node scripts/production-identity-smoke.mjs`
   — verifies schema, the four RPCs, RLS enforcement, public-exec revocation,
   unique-username authority, atomic creation, rotation, and the same-guest
   restore primitive. Exits 1 on any FAIL.
4. Edge/network layer (not checkable from this sandbox — verify on the live
   host): HTTPS enabled, the session cookie served with `Secure; HttpOnly;
   SameSite=Lax` on the app's domain, and the Cloudflare route forwarding the
   `/api/identity-*` endpoints correctly.
5. Real-device pass (Android + browser): Welcome → New Guest → Backup ID →
   logout → restore; offline → retry (identity kept); logout in one tab →
   other tab returns to Welcome; Clear Cache keeps sign-in, Clear Data shows
   Welcome.

Automated guard rails: `tests/identity.test.ts` (policy, decision table,
scopes, trilingual copy, enumeration safety, real scrypt hashing),
`tests/identity-runtime.test.ts` (43 runtime tests incl. the continuity
matrix), `tests/identity-source-guards.test.ts` (36 source guards) — 524
tests total.
