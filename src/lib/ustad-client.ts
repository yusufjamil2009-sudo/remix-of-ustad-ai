/**
 * Authoritative Identity + Session Manager for USTAD AI.
 *
 * ONE store owns the permanent Guest ID, the session token and the identity
 * state. Every route/component reads THIS, so no page invents its own guest
 * logic and nothing can silently create a second identity.
 *
 * The five rules this module enforces:
 *   1. The client NEVER mints a Guest ID (the server does, cryptographically).
 *   2. A missing/invalid credential NEVER auto-creates a new identity — it
 *      becomes `needs_identity`, and the Welcome screen asks the user.
 *   3. A transient network error keeps the existing identity (never "new user").
 *   4. Logout / Clear data clear only LOCAL state; the server account survives.
 *   5. No password is ever held in this store after its request completes.
 */
import { useEffect, useState } from "react";
import { bootstrapFn } from "./ustad.functions";
import {
  claimIdentityFn,
  createGuestAccountFn,
  identityStatusFn,
  logoutFn,
  restoreBackupFn,
} from "./identity.functions";
import {
  ERROR_TEXT,
  cacheKeysToRemove,
  classifyClientFailure,
  dataKeysToRemove,
  shouldPreserveIdentityOnError,
  toIdentityErrorCode,
  type IdentityErrorCode,
  type IdentityState,
} from "./identity-spec";

const TOKEN_KEY = "ustad.guest.token";
const ID_KEY = "ustad.guest.id";
const USERNAME_KEY = "ustad.identity.username";

export type GuestStatus =
  "idle" | "initializing" | "ready" | "recovering" | "needs_identity" | "error";

export type GuestSession = {
  guestId: string;
  token: string;
  profile: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  cookieSet?: boolean;
  /** False until the guest has a username + password (one-time setup). */
  hasAccount: boolean;
  /** Server-authoritative display username (null for an unclaimed guest). */
  username: string | null;
};

export type IdentityAccount = { guestId: string; username: string } | null;

const EMPTY_SESSION: GuestSession = {
  guestId: "",
  token: "",
  profile: null,
  settings: null,
  hasAccount: false,
  username: null,
};

/* ---------------- local storage (never authoritative) ---------------- */

export function readToken(): string {
  if (typeof window === "undefined") return "";
  // INTENTIONAL SINGLE SOURCE (§12): localStorage is the ONLY persistent
  // identity store. sessionStorage is never used for identity — the guest id
  // and token must survive refresh, browser restart, app restart and device
  // restart, so nothing transient may shadow the persistent copy. The token
  // itself is a signed session reference, never a password or a username.
  return window.localStorage.getItem(TOKEN_KEY) ?? "";
}

export function readStoredUsername(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(USERNAME_KEY) ?? "";
}

function writeToken(token: string, guestId: string, username?: string) {
  if (typeof window === "undefined") return;
  // The HttpOnly cookie is a second layer, but browsers can silently drop it
  // (secure cookie over http, blocked third-party cookie). Keeping the signed
  // token here means a refresh never loses the identity — and it is NOT a
  // credential: every server call re-verifies the signature server-side.
  window.localStorage.setItem(ID_KEY, guestId);
  window.localStorage.setItem(TOKEN_KEY, token);
  if (username) window.localStorage.setItem(USERNAME_KEY, username);
}

/** Remove only the LOCAL session reference. Server account/data untouched. */
function clearToken() {
  if (typeof window === "undefined") return;
  // Defensive only: nothing in this codebase ever WRITES identity into
  // sessionStorage (§12) — this removal just guarantees a stale copy from a
  // previous version can never shadow the persistent one.
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(ID_KEY);
  window.localStorage.removeItem(USERNAME_KEY);
}

/* ---------------- single authoritative store ---------------- */

type Snapshot = {
  status: GuestStatus;
  session: GuestSession | null;
  error: string | null;
  /** Resolver output — the ONLY thing that decides Welcome vs Home. */
  identity: IdentityState;
  username: string | null;
  /** True when the last failure was transient (network) — never "new user". */
  transient: boolean;
};

let snapshot: Snapshot = {
  status: "idle",
  session: null,
  error: null,
  identity: "no_identity",
  username: null,
  transient: false,
};
let inflight: Promise<GuestSession> | null = null;
const listeners = new Set<(s: Snapshot) => void>();

function publish(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l(snapshot));
}

export function getSnapshot(): Snapshot {
  return snapshot;
}

/** All localStorage keys on this device (browser only, never throws). */
function localKeys(): string[] {
  if (typeof window === "undefined") return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k) keys.push(k);
    }
  } catch {
    return [];
  }
  return keys;
}

/** Ask the server who we are. This call can NEVER create an identity. */
async function bootstrap(existing: string): Promise<GuestSession> {
  const res = (await bootstrapFn({
    data: existing ? { token: existing } : {},
  })) as unknown as {
    needsIdentity: boolean;
    identity: IdentityState;
    guestId: string | null;
    token: string;
    profile: Record<string, unknown> | null;
    settings: Record<string, unknown> | null;
    cookieSet?: boolean;
    hasAccount?: boolean;
    username?: string | null;
  };

  if (res.needsIdentity || !res.token || !res.guestId) {
    // The backend has no valid identity for this client. The USER decides
    // whether to create a new Guest ID or restore one — we never auto-mint.
    if (existing) clearToken();
    publish({
      status: "needs_identity",
      identity: "no_identity",
      transient: false,
    });
    return EMPTY_SESSION;
  }

  const session: GuestSession = {
    guestId: res.guestId,
    token: res.token,
    profile: res.profile ?? null,
    settings: res.settings ?? null,
    hasAccount: Boolean(res.hasAccount),
    username: res.username ?? null,
  };
  // Keep the local username cache in step with the server account (it is a
  // cache only — the server remains authoritative, §16).
  writeToken(session.token, session.guestId, session.username ?? undefined);
  publish({
    status: "ready",
    session,
    identity: "authenticated",
    error: null,
    transient: false,
  });
  return session;
}

/**
 * Initialise (or reuse) the session. Concurrent callers share one in-flight
 * request, so a remount never creates a second identity.
 */
export function ensureGuest(): Promise<GuestSession> {
  if (snapshot.status === "needs_identity" && !snapshot.session) {
    return Promise.resolve(EMPTY_SESSION);
  }
  if (snapshot.session) return Promise.resolve(snapshot.session);
  if (inflight) return inflight;
  publish({ status: snapshot.status === "idle" ? "initializing" : snapshot.status, error: null });

  inflight = bootstrap(readToken())
    .catch((e: Error) => {
      // HARDENING Bug Area 1 + 4: a THROWN bootstrap failure is by contract a
      // transient/unknown SERVER-side problem — confirmed identity verdicts
      // (no_identity / invalid_session) are RETURN VALUES, never throws. So
      // EVERY throw preserves the stored token and shows a retryable state:
      // network, timeout, 502/503/504, 500, unknown backend error — none of
      // them is ever "new user", and clearToken() is NEVER called here.
      void shouldPreserveIdentityOnError(e);
      const kind = classifyClientFailure(e);
      publish({
        status: "error",
        error: ERROR_TEXT.english[kind],
        identity: readToken() ? "invalid_session" : "no_identity",
        transient: true,
      });
      return EMPTY_SESSION;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Re-handshake. `dropToken` discards the local reference first. */
export async function recoverGuest(dropToken: boolean): Promise<GuestSession> {
  publish({ status: "recovering" });
  if (dropToken) clearToken();
  snapshot = { ...snapshot, session: null };
  inflight = null;
  return ensureGuest();
}

/**
 * Retry after a transient failure WITHOUT discarding the stored token — the
 * identity is preserved and the user is never asked to sign in again.
 */
export async function retryIdentity(): Promise<GuestSession> {
  publish({ status: "initializing", error: null, transient: false });
  snapshot = { ...snapshot, session: null };
  inflight = null;
  return ensureGuest();
}

/** Current verified token, initialising the session if needed. */
export async function currentToken(): Promise<string> {
  const s = snapshot.session ?? (await ensureGuest());
  return s.token;
}

export function currentGuestId(): string {
  return snapshot.session?.guestId ?? "";
}

/** Patch the locally cached settings/profile so every screen reads one truth. */
export function patchSession(patch: Partial<GuestSession>) {
  if (!snapshot.session) return;
  publish({ session: { ...snapshot.session, ...patch } });
}

export function resetGuestCache() {
  snapshot = {
    status: "idle",
    session: null,
    error: null,
    identity: "no_identity",
    username: null,
    transient: false,
  };
  inflight = null;
}

/* ---------------- identity actions (server-backed) ---------------- */

export type IdentityActionResult = { ok: true } | { ok: false; code: IdentityErrorCode };

/**
 * §7 double-submit hardening: a second tap on the SAME action while the first
 * is still in flight shares the first request instead of firing a parallel
 * one. The database unique constraints stay the final authority either way,
 * but this keeps the client state consistent (no orphan local state, no
 * confusing "username taken" from the user's own duplicate tap) and prevents
 * the same device from racing itself into two sessions. Different actions
 * (e.g. Create vs Restore) are deliberately NOT deduped against each other.
 */
const inflightActions = new Map<string, Promise<IdentityActionResult>>();

function dedupe(
  key: string,
  run: () => Promise<IdentityActionResult>,
): Promise<IdentityActionResult> {
  const existing = inflightActions.get(key);
  if (existing) return existing;
  const promise = run().finally(() => {
    if (inflightActions.get(key) === promise) inflightActions.delete(key);
  });
  inflightActions.set(key, promise);
  return promise;
}

/** NEW GUEST ID: server generates the permanent id + stores the hash. */
export async function createIdentity(
  username: string,
  password: string,
): Promise<IdentityActionResult> {
  return dedupe(`create:${username}`, () => createIdentityOnce(username, password));
}

async function createIdentityOnce(
  username: string,
  password: string,
): Promise<IdentityActionResult> {
  // A previous transient failure must not keep the error notice on screen while
  // the user is actively trying again.
  publish({ error: null, transient: false });
  try {
    const res = (await createGuestAccountFn({ data: { username, password } })) as unknown as

      | { ok: true; session: { guestId: string; token: string; username: string } }
      | { ok: false; code: IdentityErrorCode };
    if (!res.ok) return { ok: false, code: res.code };
    await adoptSession(res.session.guestId, res.session.token, res.session.username);
    return { ok: true };
  } catch (e) {
    // HARDENING Bug Area 3: an unknown exception is NEVER "validation" —
    // it is a typed retryable category (network / timeout / server_error).
    return { ok: false, code: toIdentityErrorCode(e) };
  }
}

/** BACKUP ID: reconnect the EXISTING account. Never creates a Guest ID. */
export async function restoreIdentity(
  username: string,
  password: string,
): Promise<IdentityActionResult> {
  return dedupe(`restore:${username}`, () => restoreIdentityOnce(username, password));
}

async function restoreIdentityOnce(
  username: string,
  password: string,
): Promise<IdentityActionResult> {
  try {
    const res = (await restoreBackupFn({ data: { username, password } })) as unknown as
      | { ok: true; session: { guestId: string; token: string; username: string } }
      | { ok: false; code: IdentityErrorCode };
    if (!res.ok) return { ok: false, code: res.code };
    await adoptSession(res.session.guestId, res.session.token, res.session.username);
    return { ok: true };
  } catch (e) {
    // HARDENING Bug Area 3: an unknown exception is NEVER "validation" —
    // it is a typed retryable category (network / timeout / server_error).
    return { ok: false, code: toIdentityErrorCode(e) };
  }
}

/**
 * Secure an EXISTING guest (one-time setup for accounts created before this
 * feature). The permanent Guest ID and all data stay exactly as they are.
 */
export async function claimCurrentIdentity(
  username: string,
  password: string,
): Promise<IdentityActionResult> {
  return dedupe(`claim:${username}`, () => claimCurrentIdentityOnce(username, password));
}

async function claimCurrentIdentityOnce(
  username: string,
  password: string,
): Promise<IdentityActionResult> {
  try {
    const res = (await claimIdentityFn({
      data: { token: readToken(), username, password },
    })) as unknown as
      | { ok: true; session: { guestId: string; token: string; username: string } }
      | { ok: false; code: IdentityErrorCode };
    if (!res.ok) return { ok: false, code: res.code };
    await adoptSession(res.session.guestId, res.session.token, res.session.username);
    return { ok: true };
  } catch (e) {
    // HARDENING Bug Area 3: an unknown exception is NEVER "validation" —
    // it is a typed retryable category (network / timeout / server_error).
    return { ok: false, code: toIdentityErrorCode(e) };
  }
}

/**
 * LOG OUT: the server revokes the session; the account and data are untouched.
 *
 * If revocation cannot be confirmed the local identity is NOT dropped, because
 * claiming a logout that never happened would leave a live server session while
 * the user believes they signed out (§4). The user stays signed in and retries.
 */
export async function logoutIdentity(): Promise<IdentityActionResult> {
  return dedupe("logout", () => logoutIdentityOnce());
}

async function logoutIdentityOnce(): Promise<IdentityActionResult> {
  const token = readToken();
  if (token) {
    try {
      const res = (await logoutFn({ data: { token } })) as
        { ok: true } | { ok: false; code: IdentityErrorCode };
      if (!res.ok) return { ok: false, code: res.code };
    } catch (e) {
      const code = toIdentityErrorCode(e);
      return { ok: false, code: code === "network" || code === "timeout" ? code : "logout_failed" };
    }
  }
  clearToken();
  resetGuestCache();
  publish({ status: "needs_identity", identity: "no_identity", username: null });
  return { ok: true };
}

/**
 * Take ownership of a freshly issued server session.
 *
 * The DISPLAY username is cached locally for convenience only — the server
 * account stays authoritative, and it is re-read from the server here so a
 * stale or missing local copy can never become the identity (§16).
 */
async function adoptSession(guestId: string, token: string, username: string) {
  writeToken(token, guestId, username);
  snapshot = { ...snapshot, session: null, status: "initializing" };
  inflight = null;
  const status = (await identityStatusFn({ data: { token } })) as unknown as
    | { ok: false; code: IdentityErrorCode }
    | { state: IdentityState; account: { username: string } | null };
  // A failed status call is never an identity decision — bootstrap below is
  // the authority and will re-verify the signed token against the server.
  const serverUsername = "ok" in status ? "" : (status.account?.username ?? "");
  publish({
    identity:
      "state" in status && status.state === "authenticated" ? "authenticated" : "no_identity",
  });
  // A THROWN bootstrap here used to leave `status: "initializing"` forever —
  // the app then sat on the splash with no way out. A failure is transient by
  // contract, so publish a retryable error state and keep the stored token.
  let session: GuestSession;
  try {
    session = await bootstrap(token);
  } catch (e) {
    const kind = classifyClientFailure(e as Error);
    publish({
      status: "error",
      error: ERROR_TEXT.english[kind],
      identity: "invalid_session",
      transient: true,
    });
    throw e;
  }
  const display = serverUsername || (session.guestId ? username : "");
  if (display && session.guestId) writeToken(token, session.guestId, display);
  publish({ username: display });
}


/* ---------------- multi-tab identity sync (§21) ---------------- */

let storageBound = false;

/**
 * One browser, several tabs. Identity changes in ANOTHER tab (login, logout,
 * Clear Data) must not leave this tab pointing at a dead identity, and must
 * never let two tabs diverge into two identities. `storage` events fire only
 * in OTHER tabs, so there is no self-loop.
 */
function bindCrossTabSync() {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== TOKEN_KEY && event.key !== ID_KEY) return;
    const fresh = window.localStorage.getItem(TOKEN_KEY) ?? "";
    const mine = snapshot.session?.token ?? "";
    if (!fresh) {
      // Another tab logged out or cleared data → this tab follows suit.
      resetGuestCache();
      publish({ status: "needs_identity", identity: "no_identity", username: null });
      return;
    }
    if (fresh !== mine) {
      // Another tab established an identity (login/restore/claim) → adopt the
      // SAME identity instead of bootstrapping a stale local one.
      snapshot = { ...snapshot, session: null };
      inflight = null;
      publish({ status: "recovering" });
      void ensureGuest().catch(() => {});
    }
  });
}

/* ---------------- local scopes: Clear Cache / Clear Data ---------------- */

/**
 * CLEAR CACHE — temporary client state ONLY.
 *
 * Guarded by `cacheMayRemove` from the shared spec, so it can NEVER delete the
 * guest id, the session token, the username or any permanent data (§33, §34).
 * The next open goes straight Home.
 */
export function clearLocalCache(): number {
  if (typeof window === "undefined") return 0;
  const doomed = cacheKeysToRemove(localKeys());
  doomed.forEach((k) => window.localStorage.removeItem(k));
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
  if ("caches" in window) {
    void caches.keys().then((keys) => keys.forEach((k) => void caches.delete(k)));
  }
  return doomed.length;
}

/**
 * CLEAR DATA — destructive LOCAL action, only ever called after the user
 * confirms. It removes the local identity reference so the next open shows
 * Welcome. The SERVER account (guest id, username, password hash, coins,
 * history, cups, certificates, badges, tickets, tournaments, results, events,
 * achievements, purchases and permanent settings) is NOT deleted — the user can
 * sign back in with Backup ID (§37, §38). Clear Data is NOT account deletion.
 */
export function clearLocalData(): number {
  if (typeof window === "undefined") return 0;
  // ALLOWLIST ONLY (spec §14). Never "every ustad.* key": unrelated feature
  // state on this device (classroom sessions, drafts, and any future feature)
  // must survive a data action that only concerns the local identity.
  const doomed = dataKeysToRemove(localKeys());
  doomed.forEach((k) => window.localStorage.removeItem(k));
  const removed = doomed.length;
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
  if ("caches" in window) {
    void caches.keys().then((keys) => keys.forEach((k) => void caches.delete(k)));
  }
  resetGuestCache();
  publish({ status: "needs_identity", identity: "no_identity", username: null });
  return removed;
}

/* ---------------- react binding ---------------- */

export function useGuest() {
  const [snap, setSnap] = useState<Snapshot>(snapshot);

  useEffect(() => {
    const l = (s: Snapshot) => setSnap(s);
    listeners.add(l);
    setSnap(snapshot);
    bindCrossTabSync();
    void ensureGuest().catch(() => {});
    return () => {
      listeners.delete(l);
    };
  }, []);

  return {
    session: snap.session,
    token: snap.session?.token ?? "",
    guestId: snap.session?.guestId ?? "",
    username: snap.username ?? snap.session?.username ?? (snap.session ? readStoredUsername() : ""),
    hasAccount: Boolean(snap.session?.hasAccount),
    ready: snap.status === "ready" && Boolean(snap.session),
    status: snap.status,
    identity: snap.identity,
    transient: snap.transient,
    error: snap.error,
    retry: () => void (snap.transient ? retryIdentity() : recoverGuest(true)),
  };
}

export function shortId(guestId: string) {
  return guestId.slice(0, 8).toUpperCase();
}
