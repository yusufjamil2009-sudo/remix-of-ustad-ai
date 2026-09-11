/**
 * Guest identity + ownership enforcement.
 *
 * USTAD AI has no login. Each browser gets a server-issued Guest ID together
 * with an HMAC-signed token. Every server function verifies the signature
 * before touching data, so a client can never claim another guest's ID.
 */

/**
 * Node 20 dev-compat: @supabase/supabase-js v2.112 requires a WebSocket global
 * (Node 22 has it natively). Provide the `ws` implementation when missing so
 * the dev server can run on Node 20; production on Node 22+ skips this.
 */
if (typeof globalThis !== "undefined" && !globalThis.WebSocket) {
  try {
    const { createRequire } = await import("node:module");
    const ws = createRequire(import.meta.url)("ws") as typeof import("ws");
    (globalThis as Record<string, unknown>)["WebSocket"] = ws.WebSocket;
  } catch {
    /* no ws available — realtime is unavailable but everything else works */
  }
}

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function currentSecret(): string {
  const secret = process.env["USTAD_GUEST_SECRET"];
  if (!secret) throw new Error("Guest signing secret is not configured");
  return secret;
}

/** Old secret kept during a rotation window so existing tokens keep working. */
function previousSecret(): string | undefined {
  const prev = process.env["USTAD_GUEST_SECRET_PREVIOUS"]?.trim();
  return prev && prev !== process.env["USTAD_GUEST_SECRET"] ? prev : undefined;
}

async function signPayload(payload: string, secret = currentSecret()): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload));
  return b64url(sig);
}

export function newGuestId(): string {
  const raw = crypto.randomUUID().replace(/-/g, "");
  return `guest_${raw.slice(0, 16)}`;
}

/** How long a guest token stays valid from issue. Prevents a leaked token from
 *  being usable forever. Legacy (2-part, no expiry) tokens stay verifiable for
 *  backward compatibility but nothing new is issued without an expiry. */
const TOKEN_TTL_MS = 365 * 24 * 3600 * 1000; // 365 days

// NOTE: no issuer for legacy 2/3-part tokens remains — nothing new is minted
// outside the revocable 4-part session format. Legacy tokens STILL VERIFY
// (verifySession below) so no existing user is ever logged out; their next
// open migrates them to a revocable session (§5).
/**
 * Issue a REVOCABLE session token for a guest.
 *
 * Format: `guestId.expiry.jti.signature` (signature covers the first three
 * fields, so neither the expiry nor the session id can be forged). The session
 * row it references is what makes LOG OUT a real server-side revocation instead
 * of a client-side flag.
 *
 * Tokens issued BEFORE this feature (2-part legacy, 3-part expiry) still
 * verify, so no existing user is logged out by this change.
 */
/** Sign the 4-part token for a session id that is ALREADY persisted. */
async function buildSessionToken(guestId: string, jti: string, exp: number): Promise<string> {
  return `${guestId}.${exp}.${jti}.${await signPayload(`${guestId}.${exp}.${jti}`)}`;
}

/**
 * Sign a token for a session id that was persisted by an RPC (atomic create /
 * rotate). Used only AFTER the database confirmed the row — the RPC response
 * is the persistence proof, so no second insert happens here (§3, §9).
 */
export async function signSessionToken(guestId: string, jti: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + Math.floor(TOKEN_TTL_MS / 1000);
  return buildSessionToken(guestId, jti, exp);
}

export async function issueSessionToken(guestId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + Math.floor(TOKEN_TTL_MS / 1000);
  const jti = crypto.randomUUID();
  const expiresAt = new Date(exp * 1000).toISOString();

  // TRANSACTIONAL FROM THE APPLICATION'S POINT OF VIEW (spec §3):
  // the session row is written FIRST and the database's own { data, error }
  // response is inspected — Supabase returns errors without throwing, so a
  // try/catch alone is not enough. If the row is not definitely persisted we
  // throw and NO token is handed out, because a token whose jti has no row
  // could never be revoked (LOG OUT would silently do nothing).
  const { data, error } = await db()
    .from("ustad_sessions")
    .insert({ jti, guest_id: guestId, expires_at: expiresAt })
    .select("jti")
    .maybeSingle();

  if (error) throw new Error("database_error");
  if (!data) throw new Error("session_unavailable");

  return buildSessionToken(guestId, jti, exp);
}

/**
 * Revoke every OTHER live session for a guest and issue a new one.
 *
 * Used where a fresh device credential - not a mere token refresh - is being
 * handed out (account creation, restore, claiming an unclaimed guest). It keeps
 * the "one revocable session per device credential" invariant true: the user
 * always holds exactly one live, revocable session, so LOG OUT is always
 * effective even if an earlier handshake wrote to a lost response.
 *
 * Throws (no token returned) when the session row cannot be written.
 */
export async function issueFreshSessionToken(guestId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + Math.floor(TOKEN_TTL_MS / 1000);
  // §4 — revoke ALL live sessions + create the new one as ONE database
  // transaction (ustad_issue_fresh_session). The old sessions are revoked IN
  // THE SAME TRANSACTION as the insert, so the state "old session active AND
  // new session active" cannot exist, and a failed revoke/insert rolls back
  // instead of silently leaving extra live sessions behind.
  const { data, error } = await db().rpc("ustad_issue_fresh_session", { p_guest_id: guestId });
  if (error) throw new Error("database_error");
  const jti = Array.isArray(data) && data.length > 0 ? String(data[0]?.["jti"] ?? "") : "";
  if (!jti) throw new Error("session_unavailable");
  return buildSessionToken(guestId, jti, exp);
}

/**
 * Re-sign the SAME session (same jti) with a fresh expiry.
 *
 * Used when a still-valid token is presented on open: the session keeps its
 * identity, so LOG OUT can revoke the device's one and only session instead of
 * leaving earlier rotations alive. No new row is created.
 */
export async function refreshSessionToken(guestId: string, jti: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + Math.floor(TOKEN_TTL_MS / 1000);
  // §5 — the refresh is verified, not assumed: the RPC updates the expiry ONLY
  // where the session EXISTS, BELONGS TO THIS GUEST and is NOT REVOKED, and
  // returns the updated row. Zero rows (missing / revoked / another guest's
  // session) means no token is ever minted from it. A transport failure is a
  // retryable network error, never an invalid session.
  const { data, error } = await db().rpc("ustad_refresh_session", {
    p_guest_id: guestId,
    p_jti: jti,
  });
  if (error) throw new Error("database_error");
  if (!Array.isArray(data) || data.length === 0) throw new Error("session_unavailable");
  return buildSessionToken(guestId, jti, exp);
}

export type VerifiedSession = { guestId: string; jti: string | null };

/** Verify a token and return the trusted guest id + its session id (if any). */
export async function verifySession(token: unknown): Promise<VerifiedSession | null> {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const parts = token.split(".");
  let guestId: string | undefined;
  let sig: string | undefined;
  let exp: number | undefined;
  let jti: string | null = null;
  if (parts.length === 4) {
    // Current format: guestId.exp.jti.sig
    guestId = parts[0];
    exp = Number(parts[1]);
    jti = parts[2] ?? null;
    sig = parts[3];
  } else if (parts.length === 3) {
    guestId = parts[0];
    exp = Number(parts[1]);
    sig = parts[2];
  } else if (parts.length === 2) {
    guestId = parts[0];
    sig = parts[1];
  } else {
    return null;
  }
  if (!/^guest_[a-f0-9]{16}$/.test(guestId ?? "")) return null;
  if (exp !== undefined && (Number.isNaN(exp) || exp * 1000 < Date.now())) return null;
  if (!sig) return null;
  const signed = exp !== undefined ? parts.slice(0, parts.length - 1).join(".") : guestId!;
  const secrets = [currentSecret(), previousSecret()].filter(Boolean) as string[];
  for (const secret of secrets) {
    const expected = await signPayload(signed, secret);
    if (expected.length !== sig.length) continue;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff === 0) return { guestId: guestId!, jti };
  }
  return null;
}

/**
 * Three-state session lookup (§6): a MISSING row is its own state and must
 * never be treated as "active" — a token pointing at nothing is invalid, and
 * a DATABASE failure is neither active nor missing: it throws `network` so the
 * caller can preserve the user's identity instead of pretending the session
 * was revoked/missing during an outage (§3, §25).
 */
export type SessionState = "active" | "revoked" | "missing";

export async function sessionIsRevoked(jti: string): Promise<SessionState> {
  try {
    const { data, error } = await db()
      .from("ustad_sessions")
      .select("revoked_at")
      .eq("jti", jti)
      .maybeSingle();
    if (error) throw new Error("database_error");
    if (!data) return "missing";
    return data["revoked_at"] ? "revoked" : "active";
  } catch (e) {
    if (e instanceof Error && e.message === "database_error") throw new Error("network");
    throw new Error("network");
  }
}

/**
 * Revoke ONE session (LOG OUT). Never touches the guest or its data.
 *
 * Returns whether the revocation is DEFINITELY in effect. The database's own
 * `{ error }` is inspected (Supabase does not throw for a failed UPDATE), and
 * "already revoked" counts as success. Callers must not report a successful
 * server-side logout when this returns false (spec §4).
 */
export async function revokeSession(jti: string, reason = "logout"): Promise<{ ok: boolean }> {
  try {
    const { data, error } = await db().rpc("ustad_revoke_session", {
      p_jti: jti,
      p_reason: reason,
    });
    if (error) return { ok: false };
    // A returned row means the session existed and its revoked_at is set
    // (now, or already) — the token is dead. Zero rows means the session
    // never existed: there is nothing left to revoke (idempotent success).
    return { ok: true };
  } catch {
    // Transport failure: the revocation outcome is UNKNOWN, never "success".
    return { ok: false };
  }
}

/** Backward-compatible helper: the trusted guest id, or null. */
export async function verifyToken(token: unknown): Promise<string | null> {
  const s = await verifySession(token);
  return s?.guestId ?? null;
}

const GUEST_COOKIE = "ustad.guest";

/** HttpOnly cookie helpers (Bug 30). No-ops outside a request context (tests). */
export async function readGuestCookie(): Promise<string | undefined> {
  try {
    const { getCookie } = await import("@tanstack/react-start/server");
    return getCookie(GUEST_COOKIE);
  } catch {
    return undefined;
  }
}

export async function writeGuestCookie(token: string): Promise<boolean> {
  try {
    const { setCookie } = await import("@tanstack/react-start/server");
    setCookie(GUEST_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(TOKEN_TTL_MS / 1000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Throws when the token is invalid. Returns the trusted guest id. */
export async function requireGuest(token: unknown): Promise<string> {
  let session = await verifySession(token);
  if (!session) session = await verifySession(await readGuestCookie());
  if (!session) throw new Error("Invalid guest session. Please reload USTAD AI.");
  // Server-side session revocation (LOG OUT). Only tokens that carry a session
  // id can be revoked; legacy tokens predate revocation and stay valid. A
  // MISSING session row is invalid (§6), and a database outage propagates as a
  // typed network error so the caller never confuses it with a revoked token.
  if (session.jti) {
    const state = await sessionIsRevoked(session.jti);
    if (state === "revoked" || state === "missing") {
      throw new Error("Invalid guest session. Please reload USTAD AI.");
    }
  }
  const { data, error } = await db()
    .from("guests")
    .select("id")
    .eq("id", session.guestId)
    .maybeSingle();
  if (error) throw new Error("network");
  if (!data) throw new Error("Guest session expired. Please reload USTAD AI.");
  return session.guestId;
}

/**
 * Single database access point for the identity layer.
 *
 * Production uses the service-role client. Runtime integration tests swap in a
 * fake transport through `__setDbForTests` — the seam injects ONLY the database
 * driver; every policy, hash, token and decision in these modules stays real
 * (§26 runtime tests are not simulation).
 */
let dbOverride: unknown = null;
export function __setDbForTests(client: unknown): void {
  dbOverride = client;
}

export function db() {
  return (dbOverride ?? supabaseAdmin) as typeof supabaseAdmin;
}

/**
 * Bootstrap the guest's workspace rows (guests + profiles + settings).
 *
 * EVERY critical write is checked (§8): a Supabase call returns its error
 * without throwing, so each `{ error }` is inspected and a failed write throws
 * a typed `database_error` instead of letting the caller continue as if the
 * rows existed. A transport failure throws `network`. The caller must never
 * report success after a failed bootstrap write.
 */
export async function ensureGuestRow(guestId: string) {
  const client = db();
  try {
    const guestWrite = await client
      .from("guests")
      .upsert({ id: guestId, last_seen_at: new Date().toISOString() });
    if (guestWrite.error) throw new Error("database_error");
    const profileWrite = await client
      .from("profiles")
      .upsert({ guest_id: guestId }, { onConflict: "guest_id", ignoreDuplicates: true });
    if (profileWrite.error) throw new Error("database_error");
    const settingsWrite = await client
      .from("settings")
      .upsert({ guest_id: guestId }, { onConflict: "guest_id", ignoreDuplicates: true });
    if (settingsWrite.error) throw new Error("database_error");
  } catch (e) {
    if (e instanceof Error && e.message === "database_error") throw e;
    throw new Error("network");
  }
}
