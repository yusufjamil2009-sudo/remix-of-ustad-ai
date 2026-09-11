/**
 * USTAD AI — PERMANENT GUEST IDENTITY + CREDENTIALS (server authority).
 *
 * EXTENDS the existing identity system; it never replaces it:
 *   • the permanent account row is the EXISTING `guests` row (its `id` IS the
 *     permanent Guest ID) — nothing is re-keyed and no data is migrated,
 *   • sessions reuse the EXISTING HMAC-signed token mechanism
 *     (`guest.server.ts`), now with a revocable session id,
 *   • profiles, coins, purchases, tournaments, certificates, notifications and
 *     settings stay exactly where they already are.
 *
 * SECURITY MODEL (spec §2-§5, §14, §43-§47, §57-§59):
 *   • `guest_id` is NOT a credential. Authorization always runs from the
 *     verified session (`requireGuest`), never from a client-supplied id.
 *   • passwords are hashed with scrypt (memory-hard, built into Node) using a
 *     per-password random salt. Plaintext is never stored, logged or returned.
 *   • username uniqueness is a DATABASE unique index, so it is race-safe.
 *   • wrong password and unknown username return the SAME generic error, so
 *     accounts cannot be enumerated.
 *
 * ERROR MODEL (hardening §1): the four cases never blur.
 *   Case A  record genuinely absent       → null
 *   Case B  database/network failure      → typed database_error / network
 *   Case C  wrong credentials             → invalid_credentials (generic)
 *   Case D  username exists               → username_taken (23505 only)
 */
import { hashPassword, verifyPassword } from "./password.server";
import {
  db,
  issueFreshSessionToken,
  revokeSession,
  verifySession,
  newGuestId,
} from "./guest.server";
import {
  classifyClientFailure,
  mapRpcErrorCode,
  normalizeUsername,
  toIdentityErrorCode,
  validatePassword,
  validateUsername,
  type IdentityErrorCode,
  type IdentityState,
} from "./identity-spec";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const sdb = () => db() as any;

/* ------------------------------------------------------------------ */
/* Login abuse protection (spec §15)                                  */
/* ------------------------------------------------------------------ */

const LOCK_THRESHOLD = 8; // consecutive failures before a short lock
const LOCK_MS = 60 * 1000; // 1 minute — self-healing, never a permanent lockout

/**
 * Audit-row insert (no secrets). The audit log is best-effort BY DESIGN: the
 * security-critical counter lives on the account row itself and is checked
 * separately — a failed audit insert must never grant or deny access.
 */
async function recordLoginAttempt(usernameNormalized: string, outcome: string): Promise<void> {
  const { error } = await sdb()
    .from("ustad_login_attempts")
    .insert({ username_normalized: usernameNormalized, outcome });
  if (error) {
    // Inspected on purpose (§10): the authentication verdict below does not
    // depend on this row, so an audit failure never changes success→failure
    // or failure→success.
    return;
  }
}

/** Recent failure count for an account (server-side; the client cannot reset it). */
async function isTemporarilyLocked(row: Row): Promise<boolean> {
  const until = row["locked_until"] ? Date.parse(String(row["locked_until"])) : 0;
  return Number.isFinite(until) && until > Date.now();
}

/* ------------------------------------------------------------------ */
/* Shaping                                                            */
/* ------------------------------------------------------------------ */

export type SessionPayload = {
  guestId: string;
  token: string;
  username: string;
  userId: string;
};

export type AccountView = {
  guestId: string;
  username: string;
  createdAt: string;
  lastLoginAt: string | null;
};

/** Public-safe account view (never includes hashes, ids or lock state). */
export function toAccountView(row: Row): AccountView {
  return {
    guestId: String(row["guest_id"]),
    username: String(row["username"] ?? ""),
    createdAt: String(row["created_at"] ?? ""),
    lastLoginAt: (row["last_login_at"] as string) ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Account lookups — §2 / §3: DB error ≠ "not found"                   */
/* ------------------------------------------------------------------ */

/**
 * Look up an account by its normalized username.
 *
 *   DB success + row    → the row
 *   DB success + no row → null (genuinely absent — Case A)
 *   DB failure          → throws typed `database_error` (Case B)
 *   transport failure   → throws typed `network`   (Case B)
 *
 * A database outage must NEVER surface as "username available" or
 * "invalid credentials" — those meanings belong to real answers only.
 */
async function accountByNormalized(normalized: string): Promise<Row | null> {
  try {
    const { data, error } = await sdb()
      .from("ustad_accounts")
      .select("*")
      .eq("username_normalized", normalized)
      .maybeSingle();
    if (error) throw new Error("database_error");
    return (data as Row) ?? null;
  } catch (e) {
    if (e instanceof Error && e.message === "database_error") throw e;
    // Hardening Bug Area 2: a transport failure is `network`; ANY other throw
    // (500, unexpected RPC exception, unknown Supabase error) is `server_error`
    // — both are retryable and neither is ever "account not found".
    const kind = classifyClientFailure(e);
    throw new Error(kind === "network" || kind === "timeout" ? "network" : "server_error");
  }
}

/**
 * Look up an account by Guest ID. Same contract as accountByNormalized: a
 * failed query is NOT an unclaimed guest — it is a typed database error (§3).
 */
async function accountByGuest(guestId: string): Promise<Row | null> {
  try {
    const { data, error } = await sdb()
      .from("ustad_accounts")
      .select("*")
      .eq("guest_id", guestId)
      .maybeSingle();
    if (error) throw new Error("database_error");
    return (data as Row) ?? null;
  } catch (e) {
    if (e instanceof Error && e.message === "database_error") throw e;
    const kind = classifyClientFailure(e);
    throw new Error(kind === "network" || kind === "timeout" ? "network" : "server_error");
  }
}

/* ------------------------------------------------------------------ */
/* Identity resolution (spec §62, §71)                                */
/* ------------------------------------------------------------------ */

export type IdentityResolution = {
  state: IdentityState;
  guestId: string | null;
  token: string | null;
  account: AccountView | null;
  hasExistingGuest: boolean;
};

/**
 * THE centralized identity resolver (§71). Every route/component asks THIS,
 * so no page invents its own guest logic.
 *
 *   valid session + account        → authenticated
 *   valid session, no account yet  → authenticated (legacy guest that has not
 *                                    been claimed) with `hasExistingGuest:true`,
 *                                    so the UI can offer "Secure this device"
 *                                    WITHOUT EVER minting a new Guest ID
 *   revoked / missing session      → invalid_session
 *   expired/malformed token        → no_identity / invalid_session
 *   nothing at all                 → no_identity
 *   DATABASE OUTAGE                → THROWS network: the caller must preserve
 *                                    the existing identity and offer a retry —
 *                                    an outage is never "new user" (§3, §25)
 *
 * It NEVER creates a guest. Automatic new Guest ID is forbidden (§7).
 */
export async function resolveIdentity(token: unknown): Promise<IdentityResolution> {
  const session = await verifySession(token);
  if (!session) {
    return {
      state: "no_identity",
      guestId: null,
      token: null,
      account: null,
      hasExistingGuest: false,
    };
  }
  // Revocation is part of resolution (§19): a token whose session row is
  // revoked or MISSING is not authenticated, and a database failure here
  // throws (network) so the stored identity is preserved.
  if (session.jti) {
    const { sessionIsRevoked } = await import("./guest.server");
    const state = await sessionIsRevoked(session.jti);
    if (state === "revoked" || state === "missing") {
      return {
        state: "invalid_session",
        guestId: null,
        token: null,
        account: null,
        hasExistingGuest: false,
      };
    }
  }
  // Revoked or missing guest row → the stored token is worthless.
  const { data: guest, error: guestError } = await sdb()
    .from("guests")
    .select("id")
    .eq("id", session.guestId)
    .maybeSingle();
  if (guestError) {
    // DATABASE OUTAGE, not an unknown user (§20, §22): throwing keeps the
    // caller's stored identity intact and asks for a retry instead of sending
    // the user to Welcome where they might create a second account.
    throw new Error("network");
  }
  if (!guest) {
    return {
      state: "invalid_session",
      guestId: null,
      token: null,
      account: null,
      hasExistingGuest: false,
    };
  }
  const row = await accountByGuest(session.guestId);
  return {
    state: "authenticated",
    guestId: session.guestId,
    token: String(token),
    account: row ? toAccountView(row) : null,
    hasExistingGuest: true,
  };
}

/* ------------------------------------------------------------------ */
/* NEW GUEST ID (spec §11-§13, §66)                                   */
/* ------------------------------------------------------------------ */

/** Failure codes are the localized, enumeration-safe codes from identity-spec. */
export type CreateResult =
  { ok: true; session: SessionPayload } | { ok: false; code: IdentityErrorCode };

/**
 * Create a brand-new permanent Guest ID with credentials.
 *
 * The Guest ID itself is GENERATED SERVER-SIDE (crypto.randomUUID-derived,
 * unpredictable, non-sequential) — the client can never supply or influence
 * it (§3). The whole creation (guest + profile + settings + account + initial
 * session) runs as ONE database transaction via `ustad_create_guest_account`
 * (§9): if ANY statement fails, EVERYTHING rolls back, so a partial identity
 * can never exist and a duplicate-username race is decided by the database
 * unique index, not by the friendly pre-check (§22).
 */
export async function createAccount(input: {
  username: unknown;
  password: unknown;
}): Promise<CreateResult> {
  const uv = validateUsername(input.username);
  if (!uv.ok) return { ok: false, code: uv.code };
  const pv = validatePassword(input.password, uv.normalized);
  if (!pv.ok) return { ok: false, code: pv.code };

  // Friendly pre-check only — the unique index inside the RPC is the real
  // guard. A DB error here is typed, never "username available" (§2).
  try {
    if (await accountByNormalized(uv.normalized)) return { ok: false, code: "username_taken" };
  } catch (e) {
    return { ok: false, code: toIdentityErrorCode(e) };
  }

  // Permanent Guest ID: generated HERE, server-side, from a CSPRNG. The client
  // cannot supply, predict or influence it, and it is never sequential.
  const guestId = newGuestId();
  const passwordHash = await hashPassword(String(input.password));

  try {
    // One atomic creation: guest + profile + settings + account + session.
    const { data, error } = await sdb().rpc("ustad_create_guest_account", {
      p_guest_id: guestId,
      p_username: String(input.username).trim(),
      p_username_normalized: uv.normalized,
      p_password_hash: passwordHash,
    });
    if (error) {
      // §11: ONLY a real 23505 (username unique violation) is username_taken;
      // every other database failure stays a database error.
      return { ok: false, code: mapRpcErrorCode(String(error.code)) };
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row) return { ok: false, code: "database_error" };
    const jti = String(row["jti"] ?? "");
    if (!jti) return { ok: false, code: "session_unavailable" };
    // The RPC response IS the persistence proof: the session row already
    // exists, so signing here adds no new DB write (§3, §9).
    const { signSessionToken } = await import("./guest.server");
    const token = await signSessionToken(guestId, jti);
    await recordLoginAttempt(uv.normalized, "success");
    return {
      ok: true,
      session: {
        guestId,
        token,
        username: String(row["username"] ?? input.username),
        userId: String(row["user_id"] ?? ""),
      },
    };
  } catch (e) {
    return { ok: false, code: toIdentityErrorCode(e) };
  }
}

/* ------------------------------------------------------------------ */
/* BACKUP ID / RESTORE (spec §18-§24, §40, §72)                        */
/* ------------------------------------------------------------------ */

export type LoginResult =
  | { ok: true; session: SessionPayload; account: AccountView }
  | { ok: false; code: IdentityErrorCode };

/**
 * BACKUP ID restore: reconnect the EXISTING account.
 *
 * It NEVER creates a Guest ID, never copies data and never resets anything —
 * on success the caller simply receives a fresh session for the SAME guest id,
 * with the SAME username and the SAME server data (§21, §69).
 *
 * Login order (§10): the password is verified FIRST and the lock is only
 * consulted afterwards, so a locked account never leaks its existence to
 * someone who does not know the password.
 */
export async function loginAccount(input: {
  username: unknown;
  password: unknown;
}): Promise<LoginResult> {
  const normalized = normalizeUsername(input.username);
  const password = String(input.password ?? "");
  if (!normalized || !password) return { ok: false, code: "invalid_credentials" };

  try {
    const row = await accountByNormalized(normalized);
    // Unknown username and wrong password are INDISTINGUISHABLE (§22, §67).
    if (!row) {
      await recordLoginAttempt(normalized, "failed");
      return { ok: false, code: "invalid_credentials" };
    }

    const matches = await verifyPassword(String(row["password_hash"] ?? ""), password);
    if (!matches) {
      // Security counter update (§10): its failure must NEVER change the
      // credential verdict — the password is wrong, so the result stays
      // invalid_credentials. Granting success would be catastrophic; denying
      // differently would leak lock state to someone without the password.
      const failures = Number(row["failed_attempts"] ?? 0) + 1;
      await recordLoginAttempt(normalized, "failed");
      const { error } = await sdb()
        .from("ustad_accounts")
        .update({
          failed_attempts: failures,
          locked_until:
            failures >= LOCK_THRESHOLD ? new Date(Date.now() + LOCK_MS).toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("guest_id", row["guest_id"]);
      if (error) {
        // Inspected and intentionally non-fatal: the verdict (the password is
        // wrong) is already correct and must not be re-mapped by a counter
        // write failure.
      }
      return { ok: false, code: "invalid_credentials" };
    }

    // Correct password. The lock is only consulted NOW: only someone who
    // already knows the password can ever see too_many_attempts, so locked
    // accounts stay unenumerable.
    if (await isTemporarilyLocked(row)) {
      await recordLoginAttempt(normalized, "locked");
      return { ok: false, code: "too_many_attempts" };
    }

    // Reset the counter + stamp the login. This write is CRITICAL (§10): if it
    // cannot be confirmed, no session is handed out — reporting success after
    // a failed account-state update would leave the counter high and could
    // lock a legitimate user out.
    const { error: resetError } = await sdb()
      .from("ustad_accounts")
      .update({
        failed_attempts: 0,
        locked_until: null,
        last_login_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("guest_id", row["guest_id"]);
    if (resetError) return { ok: false, code: "database_error" };
    await recordLoginAttempt(normalized, "success");

    // Fresh revocable session (rotates older sessions atomically — §4).
    const guestId = String(row["guest_id"]);
    let token: string;
    try {
      token = await issueFreshSessionToken(guestId);
    } catch (e) {
      return { ok: false, code: toIdentityErrorCode(e) };
    }
    return {
      ok: true,
      session: {
        guestId,
        token,
        username: String(row["username"]),
        userId: String(row["user_id"]),
      },
      account: toAccountView(row),
    };
  } catch (e) {
    return { ok: false, code: toIdentityErrorCode(e) };
  }
}

/* ------------------------------------------------------------------ */
/* CLAIM an existing (legacy) guest — no new Guest ID, no data loss    */
/* ------------------------------------------------------------------ */

export type ClaimResult =
  | { ok: true; session: SessionPayload; account: AccountView }
  | { ok: false; code: IdentityErrorCode };

/**
 * "Secure this device": bind credentials to the CURRENT guest without creating
 * a new one. This is the safe migration path for guests created before this
 * feature (§54-§56): their permanent Guest ID and every piece of existing data
 * are kept, and they gain a username + password to restore on other devices.
 *
 * The caller MUST already hold a valid session (identity is taken from the
 * verified session, never from a client-supplied guest id — §44). The account
 * row + session are written in ONE transaction (§9), and the error mapping is
 * precise (§11): 23505 → username_taken, U0001 → guest_already_claimed,
 * anything else → database_error / network.
 */
export async function claimExistingGuest(input: {
  token: unknown;
  username: unknown;
  password: unknown;
}): Promise<ClaimResult> {
  const session = await verifySession(input.token);
  if (!session) return { ok: false, code: "invalid_credentials" };

  const uv = validateUsername(input.username);
  if (!uv.ok) return { ok: false, code: "validation" };
  const pv = validatePassword(input.password, uv.normalized);
  if (!pv.ok) return { ok: false, code: "validation" };

  try {
    if (await accountByGuest(session.guestId)) return { ok: false, code: "guest_already_claimed" };
    // Friendly pre-check only; the unique index inside the RPC is authoritative.
    if (await accountByNormalized(uv.normalized)) return { ok: false, code: "username_taken" };
  } catch (e) {
    return { ok: false, code: toIdentityErrorCode(e) };
  }

  const passwordHash = await hashPassword(String(input.password));

  try {
    const { data, error } = await sdb().rpc("ustad_create_guest_account", {
      p_guest_id: session.guestId, // SAME permanent Guest ID — never a new one
      p_username: String(input.username).trim(),
      p_username_normalized: uv.normalized,
      p_password_hash: passwordHash,
    });
    if (error) return { ok: false, code: mapRpcErrorCode(String(error.code)) };
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row) return { ok: false, code: "database_error" };
    const jti = String(row["jti"] ?? "");
    if (!jti) return { ok: false, code: "session_unavailable" };
    const token = await import("./guest.server").then((m) =>
      m.signSessionToken(session.guestId, jti),
    );
    return {
      ok: true,
      session: {
        guestId: session.guestId,
        token,
        username: String(row["username"] ?? input.username),
        userId: String(row["user_id"] ?? ""),
      },
      account: toAccountView(row),
    };
  } catch (e) {
    return { ok: false, code: toIdentityErrorCode(e) };
  }
}

/* ------------------------------------------------------------------ */
/* LOG OUT (spec §27-§29, §63)                                        */
/* ------------------------------------------------------------------ */

/**
 * LOG OUT = terminate THIS session, server-side.
 *
 * Revokes the session row so the token is dead everywhere immediately. The
 * permanent Guest ID, username, password hash, coins, cups, certificates,
 * badges, tournaments, events, notifications and settings are NOT touched —
 * logout is not account deletion.
 */
export async function logoutSession(
  token: unknown,
): Promise<{ ok: true } | { ok: false; code: "logout_failed" | "session" }> {
  const session = await verifySession(token);
  if (!session) return { ok: false, code: "session" };

  // A legacy token has no session id — nothing to revoke server-side. The
  // client drops it, and the next open migrates to a revocable session (§5).
  if (!session.jti) return { ok: true };

  const { ok } = await revokeSession(session.jti, "logout");
  if (!ok) {
    // Do NOT pretend the session was revoked: the user stays signed in and the
    // action can be retried. The permanent Guest ID and all data are untouched.
    return { ok: false, code: "logout_failed" };
  }
  return { ok: true };
}

/** Account view for the currently signed-in guest (for Settings → Data). */
export async function currentAccount(token: unknown): Promise<AccountView | null> {
  const session = await verifySession(token);
  if (!session) return null;
  try {
    const row = await accountByGuest(session.guestId);
    return row ? toAccountView(row) : null;
  } catch {
    // Display-only helper: a DB outage shows "unknown account" in the panel,
    // which is never used as an identity decision (the store is the authority).
    return null;
  }
}
