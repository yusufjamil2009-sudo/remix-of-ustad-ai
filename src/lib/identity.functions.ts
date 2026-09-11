/**
 * PERMANENT GUEST IDENTITY — server function boundary.
 *
 * The client may ONLY: ask its identity state, create a new Guest ID with a
 * username + password, restore an existing one (Backup ID), claim the current
 * legacy guest, and log out.
 *
 * The client may NEVER: supply a guest id, a user id, a password hash, or an
 * existing account's identity. Every one of those is derived server-side from
 * the verified session or created by the server.
 *
 * ERROR BOUNDARY (§24): every handler maps ANY thrown backend error to a
 * safe, localized code. Raw Supabase/database messages (constraint names,
 * table names, driver text) never cross this boundary, and no credential or
 * token secret is ever echoed back.
 */
import { createServerFn } from "@tanstack/react-start";
import * as account from "./account.server";
import { writeGuestCookie } from "./guest.server";
import { toIdentityErrorCode, type IdentityErrorCode } from "./identity-spec";

/** Identity resolution result OR a safe typed failure (never a raw error). */
export type IdentityStatusResult =
  Awaited<ReturnType<typeof account.resolveIdentity>> | { ok: false; code: IdentityErrorCode };

/** Resolve identity for a stored token (never creates anything). */
export const identityStatusFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token?: string }) => d)
  .handler(async ({ data: d }): Promise<IdentityStatusResult> => {
    try {
      const res = await account.resolveIdentity(d.token ?? "");
      // Keep the HttpOnly cookie in sync while it is still valid.
      if (res.state === "authenticated" && res.token) await writeGuestCookie(res.token);
      return res;
    } catch (e) {
      return { ok: false, code: toIdentityErrorCode(e) };
    }
  });

/** NEW GUEST ID: creates the permanent Guest ID + credentials server-side. */
export const createGuestAccountFn = createServerFn({ method: "POST" })
  .inputValidator((d: { username: string; password: string }) => d)
  .handler(async ({ data: d }) => {
    try {
      const res = await account.createAccount({
        username: d.username,
        password: d.password,
      });
      if (res.ok) await writeGuestCookie(res.session.token);
      return res;
    } catch (e) {
      return { ok: false, code: toIdentityErrorCode(e) };
    }
  });

/** BACKUP ID: reconnect the existing account (never creates a Guest ID). */
export const restoreBackupFn = createServerFn({ method: "POST" })
  .inputValidator((d: { username: string; password: string }) => d)
  .handler(async ({ data: d }) => {
    try {
      const res = await account.loginAccount({
        username: d.username,
        password: d.password,
      });
      if (res.ok) await writeGuestCookie(res.session.token);
      return res;
    } catch (e) {
      return { ok: false, code: toIdentityErrorCode(e) };
    }
  });

/** Secure the current (legacy) guest: same Guest ID, now with credentials. */
export const claimIdentityFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; username: string; password: string }) => d)
  .handler(async ({ data: d }) => {
    try {
      const res = await account.claimExistingGuest({
        token: d.token,
        username: d.username,
        password: d.password,
      });
      if (res.ok) await writeGuestCookie(res.session.token);
      return res;
    } catch (e) {
      return { ok: false, code: toIdentityErrorCode(e) };
    }
  });

/**
 * LOG OUT: revokes THIS session server-side. Account + data stay untouched.
 *
 * The result is a real outcome, not a courtesy success: if the revocation could
 * not be confirmed the caller keeps the session and offers a retry (§4). A
 * legacy token (no session id) is a no-op that the client simply drops; its next
 * open migrates it to a revocable session.
 */
export const logoutFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => {
    try {
      return await account.logoutSession(d.token);
    } catch (e) {
      return { ok: false, code: toIdentityErrorCode(e) };
    }
  });

/** The signed-in account view (Settings → Data). */
export const currentAccountFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => {
    try {
      return await account.currentAccount(d.token);
    } catch (e) {
      return { ok: false, code: toIdentityErrorCode(e) };
    }
  });
