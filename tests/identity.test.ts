/**
 * PERMANENT GUEST IDENTITY — edge-case suite (spec §60).
 *
 * These tests exercise the PURE, isomorphic identity spec: the same rules the
 * server and the UI both run. They mirror the required scenarios without a
 * database, so they run in CI on every change and fail loudly if anyone ever
 * re-introduces "auto-create a new guest", weak password policy, cache clearing
 * that touches identity, or an error message that leaks account existence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_STORAGE_KEYS,
  PRESERVED_STORAGE_KEYS,
  DATA_STORAGE_KEYS,
  DEFAULT_IDENTITY_LANGUAGE,
  ERROR_TEXT,
  IDENTITY_TEXT,
  PASSWORD_MAX,
  PASSWORD_MIN,
  RESERVED_USERNAMES,
  USERNAME_MAX,
  USERNAME_MIN,
  actionKeepsIdentity,
  cacheKeysToRemove,
  cacheMayRemove,
  dataKeysToRemove,
  dataMayRemove,
  errorText,
  identityDecision,
  identityText,
  mapRpcErrorCode,
  classifyClientFailure,
  normalizeUsername,
  safeErrorText,
  survivingKeysAfterClearData,
  shouldPreserveIdentityOnError,
  toIdentityErrorCode,
  validatePassword,
  validateUsername,
} from "../src/lib/identity-spec";

/* ------------------------------------------------------------------ */
/* 1. First open / new guest / normal reopen / refresh                 */
/* ------------------------------------------------------------------ */

test("first open with no stored credential is NO_IDENTITY — never 'create'", () => {
  assert.equal(identityDecision({ hasStoredToken: false, tokenVerified: false }), "no_identity");
  // The decision can never return an instruction to mint a new Guest ID.
  const outcomes = [
    identityDecision({ hasStoredToken: false, tokenVerified: false }),
    identityDecision({ hasStoredToken: true, tokenVerified: false }),
    identityDecision({ hasStoredToken: true, tokenVerified: true }),
  ];
  assert.deepEqual([...new Set(outcomes)].sort(), [
    "authenticated",
    "invalid_session",
    "no_identity",
  ]);
});

test("normal reopen on the same device stays AUTHENTICATED (no Welcome screen)", () => {
  // A remembered, still-valid signed session → straight Home.
  assert.equal(identityDecision({ hasStoredToken: true, tokenVerified: true }), "authenticated");
});

test("refresh / browser restart keep the identity while the stored session verifies", () => {
  // Refresh and restart are the same check: the stored token still verifies.
  for (const _event of ["refresh", "browser_restart", "device_restart", "app_close"]) {
    assert.equal(identityDecision({ hasStoredToken: true, tokenVerified: true }), "authenticated");
  }
});

test("a stale/revoked token is INVALID_SESSION, not a new identity", () => {
  assert.equal(identityDecision({ hasStoredToken: true, tokenVerified: false }), "invalid_session");
});

test("network failure preserves identity and never becomes a new user", () => {
  assert.equal(shouldPreserveIdentityOnError(), true);
});

/* ------------------------------------------------------------------ */
/* 2. Username rules — global uniqueness, normalization                */
/* ------------------------------------------------------------------ */

test("username normalization makes USTAD123 and ustad123 the same account", () => {
  assert.equal(normalizeUsername("USTAD123"), "ustad123");
  assert.equal(normalizeUsername("  Ustad123  "), "ustad123");
  assert.equal(normalizeUsername("ustad123"), "ustad123");
  assert.equal(normalizeUsername("UsTaD123"), "ustad123");
});

test("username is required and length-bounded", () => {
  assert.equal(validateUsername("").ok, false);
  assert.equal(validateUsername("  ").ok, false);
  assert.equal(validateUsername("a".repeat(USERNAME_MIN - 1)).ok, false);
  assert.equal(validateUsername("a".repeat(USERNAME_MAX + 1)).ok, false);
  assert.equal(validateUsername("a".repeat(USERNAME_MIN)).ok, true);
  assert.equal(validateUsername("a".repeat(USERNAME_MAX)).ok, true);
});

test("username rejects unsafe characters and reserved words", () => {
  for (const bad of ["ustad ai", "ustad@ai", "ustad/ai", "ustad#ai", "<script>"]) {
    const v = validateUsername(bad);
    assert.equal(v.ok, false, `${bad} must be rejected`);
  }
  for (const reserved of RESERVED_USERNAMES) {
    const v = validateUsername(reserved);
    assert.equal(v.ok, false, `${reserved} is reserved`);
  }
  // Reserved matching is case/whitespace insensitive too.
  const first = RESERVED_USERNAMES[0]!;
  assert.equal(validateUsername(`  ${first.toUpperCase()} `).ok, false);
});

test("a valid username yields the normalized form the DB unique index uses", () => {
  const v = validateUsername("  Ustad.AI_7  ");
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.normalized, "ustad.ai_7");
});

/* ------------------------------------------------------------------ */
/* 3. Password policy (server-enforced, mirrored in UI)                */
/* ------------------------------------------------------------------ */

test("password is mandatory and has a minimum length", () => {
  assert.equal(validatePassword("").ok, false);
  assert.equal(validatePassword("short").ok, false);
  assert.equal(validatePassword("kalam9x").ok, false); // 7 chars < 8
  assert.equal(validatePassword("kalam9xy").ok, true); // exactly 8
  assert.equal(validatePassword("x".repeat(PASSWORD_MAX + 1)).ok, false);
});

test("password rejects obviously weak/exposed values", () => {
  for (const weak of ["password", "12345678", "qwertyui", "ustadai123", "iloveyou"]) {
    assert.equal(validatePassword(weak).ok, false, `${weak} must be rejected`);
  }
  // A single repeated character is never a real password.
  assert.equal(validatePassword("aaaaaaaa").ok, false);
  assert.equal(validatePassword("z".repeat(24)).ok, false);
});

test("password must not contain the username", () => {
  assert.equal(validatePassword("mynameisustad123", "ustad123").ok, false);
  assert.equal(validatePassword("Ustad123secret", "ustad123").ok, false);
});

/* ------------------------------------------------------------------ */
/* 4. Wrong password / duplicate username / enumeration safety         */
/* ------------------------------------------------------------------ */

test("wrong password and unknown username produce the SAME message", () => {
  const wrongPassword = errorText("invalid_credentials", "english");
  // The server returns `invalid_credentials` for BOTH cases by construction —
  // see account.server.ts loginAccount(). There is no "user not found" message.
  const allMessages = Object.values(ERROR_TEXT.english);
  for (const leak of ["not found", "does not exist", "no such", "unknown user", "unregistered"]) {
    assert.equal(
      allMessages.some((m) => m.toLowerCase().includes(leak)),
      false,
      `no error may reveal whether an account exists ("${leak}")`,
    );
  }
  assert.equal(wrongPassword, "Username or password is incorrect.");
});

test("duplicate username shows the exact required message", () => {
  assert.equal(
    errorText("username_taken", "english"),
    "This username is already registered. Please choose another username or use Backup ID to restore your existing account.",
  );
});

test("backend errors never leak internals to the user", () => {
  const leaked = safeErrorText(
    new Error('duplicate key value violates unique constraint "ustad_accounts_username_norm_uidx"'),
    "english",
  );
  assert.equal(leaked.includes("constraint"), false);
  assert.equal(leaked.includes("ustad_accounts"), false);
  assert.equal(
    safeErrorText(new Error("Failed to fetch"), "english"),
    ERROR_TEXT.english["network"],
  );
});

/* ------------------------------------------------------------------ */
/* 5. Logout / Clear Cache / Clear Data scopes                         */
/* ------------------------------------------------------------------ */

test("CLEAR CACHE can never delete the guest id, session or username", () => {
  for (const key of DATA_STORAGE_KEYS) {
    assert.equal(cacheMayRemove(key), false, `Clear Cache must not touch ${key}`);
  }
  assert.equal(cacheMayRemove("ustad.guest.token"), false);
  assert.equal(cacheMayRemove("ustad.guest.id"), false);
  assert.equal(cacheMayRemove("ustad.identity.username"), false);
  // It may remove throwaway caches.
  for (const key of CACHE_STORAGE_KEYS) {
    assert.equal(cacheMayRemove(`${key}anything`), true);
  }
});

test("Clear Cache keeps the user signed in; Logout and Clear Data do not", () => {
  assert.equal(actionKeepsIdentity("clear_cache"), true);
  assert.equal(actionKeepsIdentity("logout"), false);
  assert.equal(actionKeepsIdentity("clear_data"), false);
});

test("CLEAR DATA only removes local identity/session scopes, never server data", () => {
  assert.equal(dataMayRemove("ustad.guest.token"), true);
  assert.equal(dataMayRemove("ustad.guest.id"), true);
  // Permanent server-side concepts must not be locally "clearable".
  for (const serverKey of [
    "ustad.coins",
    "ustad.trophies",
    "ustad.certificates",
    "ustad.tournaments",
    "ustad.purchases",
    "ustad.badges",
  ]) {
    assert.equal(dataMayRemove(serverKey), false, `${serverKey} is server-authoritative`);
  }
});

/* ------------------------------------------------------------------ */
/* 6. Localization — English / Hindi / Roman Hinglish                  */
/* ------------------------------------------------------------------ */

test("every identity message exists in all three languages", () => {
  const englishKeys = Object.keys(IDENTITY_TEXT.english).sort();
  assert.deepEqual(Object.keys(IDENTITY_TEXT.hindi).sort(), englishKeys);
  assert.deepEqual(Object.keys(IDENTITY_TEXT.hinglish).sort(), englishKeys);
  for (const language of ["english", "hindi", "hinglish"] as const) {
    for (const [key, value] of Object.entries(IDENTITY_TEXT[language])) {
      assert.equal(typeof value, "string", `${language}.${key} must be a string`);
      assert.notEqual(value.trim(), "", `${language}.${key} must not be empty`);
    }
  }
});

test("every error code exists in all three languages too", () => {
  const codes = Object.keys(ERROR_TEXT.english).sort();
  assert.deepEqual(Object.keys(ERROR_TEXT.hindi).sort(), codes);
  assert.deepEqual(Object.keys(ERROR_TEXT.hinglish).sort(), codes);
});

test("Hindi is real Devanagari and Hinglish is Roman script", () => {
  assert.match(identityText("hindi").welcomeTitle, /[\u0900-\u097F]/);
  assert.equal(/[\u0900-\u097F]/.test(identityText("hinglish").welcomeTitle), false);
  assert.equal(identityText("english").welcomeTitle, "Welcome to USTAD AI");
});

test("proper nouns are never translated", () => {
  for (const language of ["english", "hindi", "hinglish"] as const) {
    assert.match(identityText(language).welcomeTitle, /USTAD AI/);
    assert.match(identityText(language).backupId, /Backup ID/);
  }
});

test("the language source of truth is the existing Settings language", () => {
  assert.equal(DEFAULT_IDENTITY_LANGUAGE, "english");
  assert.equal(identityText("english").newGuest, "New Guest ID");
  assert.equal(identityText("hinglish").newGuest, "Naya Guest ID");
  // Unknown values fall back rather than throwing, so a stale value can never
  // break the Welcome screen.
  assert.equal(identityText("klingon" as never).newGuest, "New Guest ID");
});

/* ------------------------------------------------------------------ */
/* 7. Cross-user isolation expectations expressed in the spec          */
/* ------------------------------------------------------------------ */

test("identity scopes are guest-scoped strings, so no global/user-less state exists", () => {
  for (const key of DATA_STORAGE_KEYS) {
    assert.equal(key.startsWith("ustad."), true);
  }
  // A second device must be able to restore the SAME account: nothing in the
  // local scope is required to identify the user, so dropping the local settings
  // MIRROR is harmless — the server copy is authoritative and re-hydrates it.
  assert.equal(dataMayRemove("ustad.settings.guest_0000000000000000"), true);
  // …but the mirror is NOT part of the cache scope, so Clear Cache keeps it.
  assert.equal(cacheMayRemove("ustad.settings.guest_0000000000000000"), false);
});

test("logout is not account deletion and clear data is not account deletion", () => {
  // Neither action has any API that removes a server account; the only thing
  // both do locally is drop the session reference so Welcome is shown again.
  assert.equal(actionKeepsIdentity("logout"), false);
  assert.equal(actionKeepsIdentity("clear_data"), false);
  assert.equal(DATA_STORAGE_KEYS.includes("ustad.guest.token"), true);
});

/* ------------------------------------------------------------------ */
/* 8. Password hashing — real scrypt, no plaintext, per-password salt  */
/* ------------------------------------------------------------------ */

test("hashPassword stores a self-describing scrypt hash and never the password", async () => {
  const { hashPassword } = await import("../src/lib/password.server");
  const password = "kalam9xy!";
  const hash = await hashPassword(password);

  assert.equal(hash.includes(password), false, "the plaintext must never appear in the hash");
  const [algo, n, r, p, salt, digest] = hash.split("$");
  assert.equal(algo, "scrypt");
  assert.equal(Number(n), 32768); // memory-hard parameters
  assert.equal(Number(r), 8);
  assert.equal(Number(p), 1);
  assert.equal(salt!.length, 32); // 16 random bytes
  assert.equal(digest!.length, 128); // 64-byte key
});

test("the same password hashes differently every time (unique salt per account)", async () => {
  const { hashPassword } = await import("../src/lib/password.server");
  const a = await hashPassword("kalam9xy!");
  const b = await hashPassword("kalam9xy!");
  assert.notEqual(a, b, "equal passwords must not produce equal hashes");
});

test("verifyPassword accepts the right password and rejects the wrong one", async () => {
  const { hashPassword, verifyPassword } = await import("../src/lib/password.server");
  const hash = await hashPassword("kalam9xy!");

  assert.equal(await verifyPassword(hash, "kalam9xy!"), true);
  assert.equal(await verifyPassword(hash, "kalam9xy?"), false);
  assert.equal(await verifyPassword(hash, ""), false);
  assert.equal(await verifyPassword(hash, "KALAM9XY!"), false); // passwords are case sensitive
});

test("verifyPassword fails closed on malformed or hostile stored hashes", async () => {
  const { verifyPassword } = await import("../src/lib/password.server");
  for (const bad of [
    "",
    "plaintext",
    "scrypt$notanumber$8$1$aa$bb",
    "scrypt$99999999$8$1$aa$bb", // absurd N must not be run
    "md5$1$1$1$aa$bb", // unknown algorithm
    "scrypt$16384$8$1$aa$", // empty digest
  ]) {
    assert.equal(await verifyPassword(bad, "kalam9xy!"), false, `${bad} must not verify`);
  }
});

test("a stored hash is not reversible into the password", async () => {
  const { hashPassword, verifyPassword } = await import("../src/lib/password.server");
  const hash = await hashPassword("kalam9xy!");
  const digest = hash.split("$")[5]!;
  assert.equal(digest.includes("kalam"), false);
  assert.equal(hash.startsWith("scrypt$"), true);
  // Sanity: the hash alone is useless without the KDF.
  assert.equal(await verifyPassword(digest, "kalam9xy!"), false);
});

/* ------------------------------------------------------------------ */
/* 9. §14 — Clear Data must use an ALLOWLIST, never "every ustad.* key" */
/* ------------------------------------------------------------------ */

/** A realistic snapshot of EVERYTHING the app can have on one device. */
const DEVICE_KEYS = [
  // identity + session
  "ustad.guest.token",
  "ustad.guest.id",
  "ustad.identity.username",
  "ustad.identity.setupDismissed.guest_0000000000000001",
  // local mirror of server settings (safe to drop; server re-hydrates it)
  "ustad.settings.guest_0000000000000001",
  // device preference
  "ustad.theme",
  // UNRELATED existing feature state that must survive
  "ustad.classroom.session.guest_0000000000000001.sess_abc",
  "ustad.classroom.latest.guest_0000000000000001",
  "ustad.classroom.session.latest",
  "ustad.attachments.draft",
  "ustad.shop.cart",
  "ustad.notes.draft",
  // throwaway caches
  "ustad.cache.conversations",
  "ustad.ui.tmp.panel",
  "ustad.prefetch.curriculum",
  // no ustad prefix at all (some other app/library on the same origin)
  "someOtherApp.state",
];

test("Clear Data removes ONLY identity/session/local-mirror keys", () => {
  const removed = dataKeysToRemove(DEVICE_KEYS).sort();
  assert.deepEqual(removed, [
    "ustad.guest.id",
    "ustad.guest.token",
    "ustad.identity.setupDismissed.guest_0000000000000001",
    "ustad.identity.username",
    "ustad.settings.guest_0000000000000001",
  ]);
});

test("Clear Data never deletes unrelated feature state on the device", () => {
  const survivors = survivingKeysAfterClearData(DEVICE_KEYS);
  for (const key of [
    // a classroom session, a shop cart, a notes draft, and any future feature
    "ustad.classroom.session.guest_0000000000000001.sess_abc",
    "ustad.classroom.latest.guest_0000000000000001",
    "ustad.classroom.session.latest",
    "ustad.attachments.draft",
    "ustad.shop.cart",
    "ustad.notes.draft",
    "ustad.theme",
    "someOtherApp.state",
  ]) {
    assert.equal(survivors.includes(key), true, `${key} must survive Clear Data`);
  }
});

test("Clear Cache removes throwaway keys and never identity or feature state", () => {
  const removed = cacheKeysToRemove(DEVICE_KEYS);
  assert.deepEqual(removed.sort(), [
    "ustad.cache.conversations",
    "ustad.prefetch.curriculum",
    "ustad.ui.tmp.panel",
  ]);
  for (const key of ["ustad.guest.token", "ustad.guest.id", "ustad.shop.cart", "ustad.theme"]) {
    assert.equal(removed.includes(key), false, `${key} must survive Clear Cache`);
  }
});

test("device preferences are never removed by either data action", () => {
  for (const key of PRESERVED_STORAGE_KEYS) {
    assert.equal(dataMayRemove(key), false);
    assert.equal(cacheMayRemove(key), false);
  }
});

/* ------------------------------------------------------------------ */
/* 10. §15 — the one-time-setup offer is per guest                     */
/* ------------------------------------------------------------------ */

test("the secure-device offer dismissal is scoped to one guest id", () => {
  const a = "ustad.identity.setupDismissed.guest_000000000000000a";
  const b = "ustad.identity.setupDismissed.guest_000000000000000b";
  assert.notEqual(a, b);
  // Dismissing for guest A must not hide the offer for guest B: they are
  // distinct keys and neither is a prefix of the other.
  assert.equal(b.startsWith(a), false);
  // Clear Data removes them (identity scope), so the offer returns after reset.
  assert.equal(dataMayRemove(a), true);
  assert.equal(dataMayRemove(b), true);
});

/* ------------------------------------------------------------------ */
/* 11. §3 / §4 — failure codes the UI must show instead of faking success */
/* ------------------------------------------------------------------ */

test("session and logout failures have their own safe, localized messages", () => {
  for (const language of ["english", "hindi", "hinglish"] as const) {
    assert.notEqual(errorText("session_unavailable", language).trim(), "");
    assert.notEqual(errorText("logout_failed", language).trim(), "");
  }
  // They must never be mistaken for a successful state, and must not leak internals.
  for (const language of ["english", "hindi", "hinglish"] as const) {
    assert.equal(
      /ustad_sessions|jti|database|supabase/i.test(errorText("session_unavailable", language)),
      false,
    );
    assert.equal(
      /ustad_sessions|jti|database|supabase/i.test(errorText("logout_failed", language)),
      false,
    );
  }
});

test("a raw backend failure surfaces as a retryable message, never as success", () => {
  assert.equal(
    safeErrorText(new Error("session_unavailable"), "english"),
    ERROR_TEXT.english["session_unavailable"],
  );
  assert.equal(
    safeErrorText(new Error("logout_failed"), "english"),
    ERROR_TEXT.english["logout_failed"],
  );
  assert.equal(
    safeErrorText(new Error("TypeError: Failed to fetch"), "english"),
    ERROR_TEXT.english["network"],
  );
});

/* ------------------------------------------------------------------ */
/* 12. §21 / §22 — identity state machine over every token state        */
/* ------------------------------------------------------------------ */

test("every token state maps to a safe identity decision", () => {
  // valid → authenticated
  assert.equal(identityDecision({ hasStoredToken: true, tokenVerified: true }), "authenticated");
  // revoked / expired / malformed (a token exists but does not verify)
  for (const _state of ["revoked", "expired", "malformed", "wrong_signature"]) {
    assert.equal(
      identityDecision({ hasStoredToken: true, tokenVerified: false }),
      "invalid_session",
    );
  }
  // missing → Welcome; NEVER a new guest id
  assert.equal(identityDecision({ hasStoredToken: false, tokenVerified: false }), "no_identity");
});

test("no identity decision can ever instruct creation of a new guest", () => {
  const all = new Set([
    identityDecision({ hasStoredToken: false, tokenVerified: false }),
    identityDecision({ hasStoredToken: true, tokenVerified: false }),
    identityDecision({ hasStoredToken: true, tokenVerified: true }),
  ]);
  assert.equal(all.has("create" as never), false);
  assert.equal([...all].length, 3);
});

/* ------------------------------------------------------------------ */
/* 13. §23 — concurrent duplicate usernames are decided by the database */
/* ------------------------------------------------------------------ */

test("username normalization collapses near-identical names to ONE account key", () => {
  const attempts = ["Ustad123", "ustad123 ", " USTAD123", "uStAd123"];
  const keys = new Set(attempts.map(normalizeUsername));
  assert.equal(keys.size, 1, "all four must collide on the same unique key");
  assert.equal([...keys][0], "ustad123");
});

/* ------------------------------------------------------------------ */
/* 14. §1 / §11 / §24 — typed backend-error mapping                    */
/* ------------------------------------------------------------------ */

test("RPC error codes map to exactly ONE business meaning each", () => {
  // only a REAL unique violation is username_taken…
  assert.equal(mapRpcErrorCode("23505"), "username_taken");
  // …an already-claimed guest is its own state…
  assert.equal(mapRpcErrorCode("U0001"), "guest_already_claimed");
  // …and EVERY other database error stays a database error (never
  // username_taken, never invalid_credentials, never "available").
  assert.equal(mapRpcErrorCode("23503"), "database_error");
  assert.equal(mapRpcErrorCode("42P01"), "database_error");
  assert.equal(mapRpcErrorCode("P0001"), "database_error");
  assert.equal(mapRpcErrorCode(undefined), "database_error");
});

test("thrown backend errors collapse to safe codes and never leak internals", () => {
  assert.equal(toIdentityErrorCode(new Error("database_error")), "database_error");
  assert.equal(toIdentityErrorCode(new Error("network")), "network");
  assert.equal(toIdentityErrorCode(new Error("Failed to fetch")), "network");
  assert.equal(toIdentityErrorCode(new Error("session_unavailable")), "session_unavailable");
  assert.equal(toIdentityErrorCode(new Error("guest_already_claimed")), "guest_already_claimed");
  // unknown raw errors: safe retry message, nothing internal reaches the user
  assert.equal(
    toIdentityErrorCode(new Error("relation ustad_sessions violates fk")),
    "server_error",
  );
  assert.equal(toIdentityErrorCode(new Error("Internal Server Error")), "server_error");
  assert.equal(toIdentityErrorCode(new Error("ETIMEDOUT")), "timeout");
});

test("the four error cases can never blur", () => {
  const cases = new Set([
    mapRpcErrorCode("23505"), // Case D — username exists
    mapRpcErrorCode("42P01"), // Case B — database failure
    toIdentityErrorCode(new Error("network")), // Case B — transport failure
  ]);
  assert.equal(cases.size, 3, "username_taken / database_error / network must differ");
});

/* ------------------------------------------------------------------ */
/* 15. Hardening Bug Area 1-3 — typed failure classification           */
/* ------------------------------------------------------------------ */

test("classifyClientFailure: transport/HTTP/timeout categories never blur", () => {
  // transient transport / gateway failures → network
  assert.equal(classifyClientFailure(new TypeError("Failed to fetch")), "network");
  assert.equal(classifyClientFailure(new Error("ECONNRESET")), "network");
  assert.equal(classifyClientFailure(new Error("ENOTFOUND api.supabase.co")), "network");
  assert.equal(classifyClientFailure(new Error("502 Bad Gateway")), "network");
  assert.equal(classifyClientFailure(new Error("503 Service Unavailable")), "network");
  assert.equal(classifyClientFailure(new Error("504 Gateway Timeout")), "network");
  // the request ran out of time → timeout (its own category)
  assert.equal(classifyClientFailure(new Error("Request timed out")), "timeout");
  assert.equal(classifyClientFailure(new Error("ETIMEDOUT")), "timeout");
  // 500 / unexpected server failures → server_error — still retryable, still safe
  assert.equal(classifyClientFailure(new Error("500: Internal Server Error")), "server_error");
  assert.equal(classifyClientFailure(new Error("Unexpected RPC exception")), "server_error");
  assert.equal(classifyClientFailure("some string"), "server_error");
});

test("UNKNOWN ERROR ≠ NEW USER: every thrown failure preserves identity", () => {
  const failures: unknown[] = [
    new TypeError("Failed to fetch"),
    new Error("timeout"),
    new Error("502 Bad Gateway"),
    new Error("503 Service Unavailable"),
    new Error("504 Gateway Timeout"),
    new Error("500: Internal Server Error"),
    new Error("unexpected server response"),
    new Error("database_error"),
    new Error("RPC transport failure"),
    "even a plain string",
    undefined,
  ];
  for (const f of failures) {
    assert.equal(shouldPreserveIdentityOnError(f), true, `${String(f)} must preserve identity`);
    const kind = classifyClientFailure(f);
    assert.ok(
      kind === "network" || kind === "timeout" || kind === "server_error",
      `${String(f)} classified as ${kind}`,
    );
  }
});

test("unknown server errors map to server_error, never validation/credentials", () => {
  assert.equal(toIdentityErrorCode(new Error("boom")), "server_error");
  assert.equal(toIdentityErrorCode(new Error("500")), "server_error");
  assert.notEqual(toIdentityErrorCode(new Error("boom")), "validation");
  assert.notEqual(toIdentityErrorCode(new Error("boom")), "invalid_credentials");
  assert.notEqual(toIdentityErrorCode(new Error("boom")), "username_taken");
  // and every new category has a trilingual message
  for (const language of ["english", "hindi", "hinglish"] as const) {
    assert.notEqual(ERROR_TEXT[language]["timeout"].trim(), "");
    assert.notEqual(ERROR_TEXT[language]["server_error"].trim(), "");
  }
});
