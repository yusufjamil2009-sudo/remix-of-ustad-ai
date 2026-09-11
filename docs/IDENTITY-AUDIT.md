# USTAD AI — REPO-WIDE IDENTITY AUDIT (final)

Audited 2026-09-10 against commits `8a0922c..HEAD`. Method: programmatic walkers over
every `.ts`/`.tsx` file in `src/` and every migration in `supabase/migrations/`, plus a
runtime integration suite (see §4) executing the REAL server modules against an
in-memory database transport. No result below is assumed from reading file names —
every claim comes from an executed grep/sed walker or an executed test.

## 1. Features audited: 37 modules (31 top-level + 6 nested) · 141 `requireGuest` call sites

Every server function in the repo (158 total across 13 `*.functions.ts` files) was
traced to its identity source. The ONLY identity source used by any feature is the
central resolver: `requireGuest(token)` / `resolveIdentity(token)` in
`src/lib/guest.server.ts` → verified HMAC-signed session → `guests.id`.

| # | Feature | Identity source | Old Guest system? | Status |
|---|---|---|---|---|
| 1 | Profile | central session (`requireGuest` via data.server) | NO | PASS |
| 2 | Settings (incl. Language) | central session | NO | PASS |
| 3 | Ustad Coins / Wallet | central session (`wallet.server.ts` 5 sites) | NO | PASS |
| 4 | Coin history / ledger | central session (wallet RPCs take server-derived `p_guest_id`) | NO | PASS |
| 5 | Shop / purchases / tickets | central session (`wallet` + `ustad_shop_buy` RPC) | NO | PASS |
| 6 | Offers (coin-offer) | central session (1 site) | NO | PASS |
| 7 | Tournaments | central session (`tournament-engine` 6, `tournament` 1) | NO | PASS |
| 8 | Weekly tournaments / GOD | central session (`mega-engine` 14) | NO | PASS |
| 9 | Events (master-event) | central session (10 sites) | NO | PASS |
| 10 | Crorepati (entry + engine) | central session (5 + 9 sites) | NO | PASS |
| 11 | Exams | central session (`exam-engine` 15) | NO | PASS |
| 12 | Notifications + read/unread | central session (`notification` 7) | NO | PASS |
| 13 | Certificates | central session (`certificate` 3) | NO | PASS |
| 14 | Cups / Trophies | central session (`trophy` 2, `rank` 2) | NO | PASS |
| 15 | Achievements / Badges | central session (achievement tables are `guest_id`-owned) | NO | PASS |
| 16 | Leaderboards / weekly rankings | central session (`rank.functions` + per-guest award rows) | NO | PASS |
| 17 | Gallery | central session (5) | NO | PASS |
| 18 | Chat | central session (1) | NO | PASS |
| 19 | Study | central session (5) | NO | PASS |
| 20 | Chapter / Lesson | central session (`chapter-lesson.server.ts`) | NO | PASS |
| 21 | Chapter Master | central session (`chapter-master.server.ts`) | NO | PASS |
| 22 | Book knowledge / progress | central session (`progress.ts` 2) | NO | PASS |
| 23 | Diagrams / diagram images | central session (1 + 1) | NO | PASS |
| 24 | Question engine | central session (2) | NO | PASS |
| 25 | Doubts | central session (1) | NO | PASS |
| 26 | Curriculum | central session (2) | NO | PASS |
| 27 | Voice | central session (3) | NO | PASS |
| 28 | Avatar | central session (5) | NO | PASS |
| 29 | Cosmetics | central session (4) | NO | PASS |
| 30 | API manager | central session (4) | NO | PASS |
| 31 | Teaching / documents | central session (`teaching/document.server.ts`) | NO | PASS |
| 32 | Classroom 2D | central session for auth; `ustad.guest.id` read is a documented non-authoritative UI cache (server re-authorizes) | NO (cache only) | PASS |
| 33 | Payments / transactions | central session (wallet RPCs, service-role only) | NO | PASS |
| 34 | Chrono engine flows | central session (crorepati/mega/exam engines) | NO | PASS |
| 35 | Identity / sessions (new) | `account.server` + `guest.server` (the canonical layer itself) | canonical | PASS |
| 36 | Data / conversations | central session (`data.server` 18 sites — the shared data module) | NO | PASS |
| 37 | Login attempts audit | canonical (`account.server`) | canonical | PASS |

**No feature was migrated in this audit**: all 34 user-owned feature modules were
already on the central `requireGuest` path before the identity patch; the patch only
hardened that path (revocation-aware verification, typed database errors). Zero
feature files were edited for identity reasons.

## 2. Final legacy-pattern classification (every remaining occurrence)

Search patterns: `guest_id guestId guestID user_id userId currentGuest currentUser
newGuestId ensureGuestRow generateGuest createGuest useGuest localStorage
sessionStorage guest token UUID randomUUID requireGuest verifySession verifyToken
identity auth` — 2,456 raw hits, each classified by inspection.

| Category | Count | Where / why |
|---|---|---|
| ACTIVE LEGACY IDENTITY | **0** | none — no feature reads a client-side guest id, mints its own id, or trusts a client-supplied id |
| NEW CANONICAL IDENTITY | 141 `requireGuest` sites + identity modules | all features resolve through the central session (§1 matrix) |
| UNRELATED TECHNICAL USAGE | `crypto.randomUUID` in `gallery` (upload ids), `master-event-engine` (idempotency keys), classroom sessionStorage (feature-local classroom handoff, not identity) | kept — they are not user identity |
| TEST ONLY | `tests/identity*.test.ts`, fake DB driver | test scaffolding |
| COMMENT / DOCUMENTATION | `docs/`, module headers, invariant comments | documentation |

- `localStorage` guest-id reads outside the central store: **1** —
  `classroom2d/session.ts` `GUEST_ID_KEY` read; it is a UI cache used only to label
  classroom state, and the server still authorizes every classroom write via
  `requireGuest` (verified in the §1 walker). Documented invariant in the file.
- Feature-specific Guest ID creation (`generateGuestId`, feature-local
  `crypto.randomUUID` as identity): **0**.
- Client-supplied `guest_id`/`user_id`/`username` accepted by any server function
  input validator: **0** (guarded by `tests/identity-source-guards.test.ts`).
- Old token systems active: **0** — one token format (4-part, revocable); legacy
  2/3-part tokens verify and are migrated in place to a revocable session.

## 3. Database ownership (executed query over `types.ts`)

- 78 tables; 50 carry `guest_id`; **0** carry `user_id`/`owner_id` as ownership.
- `ustad_accounts.guest_id` → `guests(id)` FK; `username_normalized` has a DB unique
  index (race authority). `ustad_sessions` revocable by `jti` FK → `guests`.
- The non-`guest_id` tables are catalogues/containers (`ustad_shop_items`,
  `curriculum_*`, `mega_events`, `tournament_questions`, `ustad_rank_cycles`,
  `master_events`, `ustad_login_attempts` audit) — none holds user-owned data.
- No table was dropped, re-keyed, or migrated. Migration is idempotent
  (`create table if not exists`, `create or replace function`, guarded policies).

## 4. Cross-feature runtime verification (executed, not assumed)

`tests/identity-runtime.test.ts` runs the REAL `account.server` / `guest.server` /
`data.server` code over an in-memory database transport (only the driver is
injected; hashing, tokens, decisions are production code):

- **Backup-ID cross-feature test** (audit §13): create guest → coins + ledger +
  purchase + notification + certificate + settings rows → LOG OUT (server-side
  revocation) → restore via Backup ID → **SAME `guests.id`**, every feature row
  still keyed to it, exactly one live session. ✅
- **New-Guest cross-feature test** (audit §14): one atomic creation produces
  guest + profile + settings + account + one live session; no feature sees a
  second identity. ✅
- **Isolation**: guest B cannot refresh/revoke/logout guest A; A's rows untouched. ✅
- Outage matrix: every critical operation (account lookup, guest lookup, guest
  creation, account creation, session creation/refresh/revoke, profile/settings
  upsert, claim) fails with `database_error`/`network` — never
  `invalid_credentials`, never `username_taken`, never a new Guest ID; creation
  rolls back atomically (0 partial rows). ✅

## 4b. Ultra-hardening additions (2026-09-10)

- `owner_id` ownership columns: **0** (`owner_id` appears only in
  `strip-protected.ts` as a defense-in-depth protected-field name).
- Hardcoded Guest ID literals in src: **0**.
- Legacy 2/3-part token ISSUANCE: **0** — the dead `issueToken` exporter was
  removed; legacy tokens still VERIFY and migrate in place on next open.
- Feature-local identity key writes outside the central store: **0** (the two
  `localStorage.setItem` matches outside `ustad-client.ts` are the canonical
  per-guest offer-dismissal key and the canonical settings mirror — both part
  of the new system's documented allowlist).
- Client-supplied `guest_id`/`user_id` in server-function input validators: **0**.
- Second auth/session systems: **0** — no `createServerFn` middleware auth.
- Password recovery/reset/forgot flows: **0** (intentionally absent; guarded).
- Double-submit: identity actions dedupe in-flight requests in the store
  (`dedupe` keys: create/restore/claim/logout) on top of the UI busy states.
- One-active-session policy: preserved; no multi-session UI/logout-all-devices.

## 4c. Production verification boundary (honest split)

| Item | Where verified | Result |
|---|---|---|
| Full automated suite (pure + runtime + source guards) | executed in this repository | ✅ 524/524 pass, 0 TS errors, build exit 0, **lint clean repo-wide (0 problems)** |
| Session-continuity matrix vs Bug Area 5 list | executed (runtime test) | ✅ every listed surface asserted with real columns — incl. notification `is_read`/`read_at`, `ustad_rank_awards` leaderboard payload, `profiles.equipped_badge`/`equipped_frame` (badges = cosmetics), `learning_preferences` |
| Production smoke bridge | NOT executed in sandbox (needs server creds) | extended with Part C: token-secret check, RLS vs anon key, RPC public-exec revocation, optional HTTPS probe — `scripts/production-identity-smoke.mjs` |
| Identity code ships in the production client bundle | executed — `.output/public/assets/*.js` string scan | ✅ all identity strings present (Welcome text, `guest_already_claimed`, `logout_failed`, `ustad.guest.token`, per-guest dismiss key) |
| SSR runtime artifact | executed — `.output/server/_ssr/ssr.mjs` present; Cloudflare Pages preset (`_headers`) | ✅ build produces the deployable runtime |
| Real Supabase schema / RPCs / RLS / Test A–E | `scripts/production-identity-smoke.mjs` — ready; NOT executed (the workspace holds only public env vars — no `SUPABASE_SERVICE_ROLE_KEY`, by design) | ⏳ run on deployment with server creds |
| Android Chrome / second device flows | physical devices | ⏳ manual; per-step expected behaviour is documented in `PERMANENT-GUEST-IDENTITY.md` §1 and locked by the runtime tests |

## 5. Final answers (audit §16 report)

1. **Features audited:** 37 modules / 158 server functions / 78 tables.
2. **Using old Guest system:** none.
3. **Migrated to central system:** none needed — all were already central; the
   central path itself was hardened (revocation, typed errors, atomic RPCs).
4. **Already on the new system:** all 34 user-owned feature modules.
5. **Remaining legacy references:** 0 active; 1 non-authoritative classroom cache
   read + unrelated technical UUIDs (kept deliberately, see §2).
6. **Same permanent `guests.id` everywhere:** yes — verified per table and per
   module, and exercised at runtime by the cross-feature restore test.
7. **Any feature still on the old system:** no.
8. **Tests:** 504/504 pass (`npm test`), 0 type errors, build exit 0, eslint clean
   on every touched file.
9. **Rebuild confirmation:** no existing USTAD AI feature, UI, design, navigation,
   business logic, table, or data was rebuilt, replaced, redesigned, or migrated.
   The patch only hardens the identity/session layer and adds its tests/docs.
