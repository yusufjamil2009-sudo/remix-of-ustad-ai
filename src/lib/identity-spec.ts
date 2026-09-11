/**
 * USTAD AI — PERMANENT GUEST IDENTITY (pure, isomorphic specification).
 *
 * Pure and dependency-free so the SAME rules drive the server (authoritative)
 * and the UI (mirror), and so they can be unit-tested without a database.
 *
 * What this file decides (spec §11-§15, §22, §65-§67, §77, §78):
 *   • username policy + normalization (uniqueness key)
 *   • password policy (only ever a PRE-check; the server re-validates)
 *   • the identity state machine + the identity "gate" decision
 *   • enumeration-safe, localized messages
 *   • exactly what "Clear Cache" and "Clear Data" may touch locally
 *
 * This file contains NO database access and NO secrets.
 */

export type Language = "english" | "hindi" | "hinglish";

/* ------------------------------------------------------------------ */
/* Username policy (§11, §12)                                          */
/* ------------------------------------------------------------------ */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
/** Letters, digits, dot, underscore, hyphen. No spaces, no emoji, no @. */
const USERNAME_RE = /^[a-z0-9._-]+$/;

/**
 * Names that would collide with routing, branding or system concepts and must
 * never become a login identity.
 */
export const RESERVED_USERNAMES: readonly string[] = [
  "admin",
  "administrator",
  "root",
  "system",
  "ustad",
  "ustadai",
  "ustad_ai",
  "support",
  "help",
  "official",
  "owner",
  "moderator",
  "mod",
  "null",
  "undefined",
  "guest",
  "new",
  "backup",
  "login",
  "logout",
  "signup",
  "settings",
  "profile",
  "api",
] as const;

/**
 * The uniqueness key. Trimming and case-folding are what make
 * `USTAD123`, `Ustad123` and ` ustad123 ` the SAME username (§12), so the
 * database unique index can enforce it for real.
 */
export function normalizeUsername(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

export type UsernameVerdict = { ok: true; normalized: string } | { ok: false; code: UsernameError };

export type UsernameError = "too_short" | "too_long" | "bad_chars" | "reserved";

export function validateUsername(raw: unknown): UsernameVerdict {
  const normalized = normalizeUsername(raw);
  if (normalized.length < USERNAME_MIN) return { ok: false, code: "too_short" };
  if (normalized.length > USERNAME_MAX) return { ok: false, code: "too_long" };
  if (!USERNAME_RE.test(normalized)) return { ok: false, code: "bad_chars" };
  if (RESERVED_USERNAMES.includes(normalized)) return { ok: false, code: "reserved" };
  return { ok: true, normalized };
}

/* ------------------------------------------------------------------ */
/* Password policy (§14, §15)                                          */
/* ------------------------------------------------------------------ */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** Extremely common passwords that are rejected outright. */
export const WEAK_PASSWORDS: readonly string[] = [
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyui",
  "qwerty123",
  "iloveyou",
  "admin123",
  "letmein123",
  "ustad123",
  "ustadai123",
  "abcd1234",
  "00000000",
  "11111111",
  "aaaaaaaa",
] as const;

export type PasswordError = "too_short" | "too_long" | "too_weak" | "same_as_username";

export type PasswordVerdict = { ok: true } | { ok: false; code: PasswordError };

/**
 * Policy pre-check. The SERVER always runs this too — a client that skips it
 * (or a crafted request) cannot create a weak credential.
 */
export function validatePassword(raw: unknown, username?: unknown): PasswordVerdict {
  const value = String(raw ?? "");
  if (value.length < PASSWORD_MIN) return { ok: false, code: "too_short" };
  if (value.length > PASSWORD_MAX) return { ok: false, code: "too_long" };
  const lower = value.toLowerCase();
  if (WEAK_PASSWORDS.includes(lower)) return { ok: false, code: "too_weak" };
  // "all the same character" is never a real password.
  if (/^(.)\1+$/.test(value)) return { ok: false, code: "too_weak" };
  const un = normalizeUsername(username);
  if (un && (lower === un || lower.includes(un))) return { ok: false, code: "same_as_username" };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Identity state machine (§1, §8, §70, §71)                           */
/* ------------------------------------------------------------------ */

/**
 * The ONLY identity states the app may be in.
 *   authenticated   → the backend verified a live session. Go straight Home.
 *   no_identity     → no usable credential. Show Welcome. NEVER auto-create.
 *   invalid_session → a stored token exists but the backend rejected it.
 *                     The user must sign in again (Welcome).
 */
export type IdentityState = "authenticated" | "no_identity" | "invalid_session";

/**
 * The central identity decision. This is the single place that answers
 * "do we have a valid authenticated identity?" so no page/component invents
 * its own guest logic (§71).
 *
 * The critical non-negotiable rule (§7): a missing or unverifiable credential
 * NEVER yields "create". It yields no_identity / invalid_session, and the user
 * chooses explicitly.
 */
export function identityDecision(input: {
  hasStoredToken: boolean;
  tokenVerified: boolean;
}): IdentityState {
  if (input.tokenVerified) return "authenticated";
  if (input.hasStoredToken) return "invalid_session";
  return "no_identity";
}

/**
 * A THROWN bootstrap/client failure must NEVER be interpreted as "new user"
 * (§9, §62; hardening Bug Area 1 + 4). Confirmed identity verdicts are RETURN
 * VALUES from the server — every thrown error (network, timeout, 500, unknown)
 * preserves the stored identity and shows a retryable state. `clearToken()` is
 * only legal after an explicit user action (Log Out / Clear Data) or a
 * CONFIRMED invalid/revoked/missing session verdict.
 */
export function shouldPreserveIdentityOnError(_error?: unknown): true {
  return true;
}

/* ------------------------------------------------------------------ */
/* Local data scopes (§30-§38) — what each action may delete            */
/* ------------------------------------------------------------------ */

/**
 * CLEAR CACHE may remove only throwaway, non-authoritative client state.
 * Every key here is safe to lose: the server re-supplies the truth.
 */
export const CACHE_STORAGE_KEYS: readonly string[] = [
  "ustad.cache.",
  "ustad.ui.tmp.",
  "ustad.prefetch.",
] as const;

/**
 * CLEAR DATA removes the local identity/session reference plus local-only
 * state, so the next open shows Welcome. It NEVER deletes the server account
 * (§37): the Guest ID, username, password hash and every piece of permanent
 * data stay on the server and can be restored with BACKUP ID.
 *
 * This is a deliberate ALLOWLIST. An earlier version removed every key that
 * started with `ustad.`, which is dangerous: any unrelated feature state stored
 * on the device (classroom sessions, a future shop cart, a draft note…) would
 * be destroyed by a data action that has nothing to do with it. Only the keys
 * listed here may ever be removed.
 */
export const DATA_STORAGE_KEYS: readonly string[] = [
  // identity + session references
  "ustad.guest.token",
  "ustad.guest.id",
  "ustad.identity.",
  // local mirror of SERVER settings; the server remains authoritative and the
  // next successful sign-in re-hydrates it, so losing it is harmless
  "ustad.settings.",
] as const;

/**
 * Device-level PREFERENCES that belong to the device, not to an account, and
 * are therefore never removed by Clear Cache or Clear Data.
 */
export const PRESERVED_STORAGE_KEYS: readonly string[] = ["ustad.theme"] as const;

function matches(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key === prefix || key.startsWith(prefix));
}

/**
 * The session/identity keys CLEAR CACHE must NEVER touch (guarded so a future
 * edit cannot accidentally widen Clear Cache into a logout).
 */
export function cacheMayRemove(key: string): boolean {
  if (!key) return false;
  if (matches(key, PRESERVED_STORAGE_KEYS)) return false;
  if (matches(key, DATA_STORAGE_KEYS)) return false;
  return matches(key, CACHE_STORAGE_KEYS);
}

/** Clear Data may remove the identity reference + its local mirrors only. */
export function dataMayRemove(key: string): boolean {
  if (!key) return false;
  if (matches(key, PRESERVED_STORAGE_KEYS)) return false;
  return matches(key, DATA_STORAGE_KEYS);
}

/**
 * Resolve the exact keys each action is allowed to delete. Pure, so the policy
 * is unit-tested against real key lists instead of being buried in the UI.
 */
export function cacheKeysToRemove(keys: readonly string[]): string[] {
  return keys.filter(cacheMayRemove);
}

export function dataKeysToRemove(keys: readonly string[]): string[] {
  return keys.filter(dataMayRemove);
}

/** Keys that must SURVIVE Clear Data (used by tests and by the UI copy). */
export function survivingKeysAfterClearData(keys: readonly string[]): string[] {
  return keys.filter((k) => !dataMayRemove(k));
}

/** True when the action keeps the user signed in (§33 vs §39). */
export function actionKeepsIdentity(action: "clear_cache" | "clear_data" | "logout"): boolean {
  return action === "clear_cache";
}

/* ------------------------------------------------------------------ */
/* Error codes → messages (§13, §22, §67, §77)                         */
/* ------------------------------------------------------------------ */

export type IdentityErrorCode =
  | UsernameError
  | PasswordError
  | "username_taken"
  | "invalid_credentials"
  | "too_many_attempts"
  | "network"
  | "session"
  | "validation"
  /** The session row could not be persisted, so NO session was created. */
  | "session_unavailable"
  /** Server-side revocation could not be confirmed; nothing was claimed. */
  | "logout_failed"
  /** The DATABASE reported an error — distinct from "record not found". */
  | "database_error"
  /** The guest is already bound to a DIFFERENT username (claim race). */
  | "guest_already_claimed"
  /** The request ran out of time (retryable; identity is preserved). */
  | "timeout"
  /** An unexpected SERVER-side failure (retryable; identity is preserved). */
  | "server_error";

/**
 * Every user-visible error must come from here, so:
 *   • the message is localized (§51), and
 *   • "wrong password" and "no such user" are INDISTINGUISHABLE
 *     (`invalid_credentials`) — account enumeration is impossible (§22, §67).
 */
export const ERROR_TEXT: Record<Language, Record<IdentityErrorCode, string>> = {
  english: {
    too_short: "Username is too short.",
    too_long: "Username is too long.",
    bad_chars: "Use only letters, numbers, dot, underscore or hyphen.",
    reserved: "That username is not available.",
    too_weak: "Please choose a stronger password.",
    same_as_username: "Password must not contain your username.",
    username_taken:
      "This username is already registered. Please choose another username or use Backup ID to restore your existing account.",
    invalid_credentials: "Username or password is incorrect.",
    too_many_attempts: "Too many attempts. Please wait a moment and try again.",
    network: "Unable to connect. Please try again.",
    session: "Your session could not be restored. Please sign in again.",
    validation: "Please check the highlighted fields.",
    session_unavailable: "Could not start a secure session. Please try again.",
    logout_failed:
      "Log out could not be completed on the server. You are still signed in — please try again.",
    database_error: "Something went wrong on our side. Please try again.",
    guest_already_claimed:
      "This device is already linked to an account. Use Backup ID to sign in to it.",
    timeout: "The request timed out. Please try again.",
    server_error: "Something went wrong on our side. Please try again.",
  },
  hinglish: {
    too_short: "Username bahut chhota hai.",
    too_long: "Username bahut lamba hai.",
    bad_chars: "Sirf letters, numbers, dot, underscore ya hyphen use karein.",
    reserved: "Ye username available nahi hai.",
    too_weak: "Zyada strong password chunein.",
    same_as_username: "Password mein aapka username nahi ho sakta.",
    username_taken:
      "Ye username pehle se registered hai. Doosra username chunein ya Backup ID se apna account restore karein.",
    invalid_credentials: "Username ya password galat hai.",
    too_many_attempts: "Bahut attempts ho gaye. Thodi der baad try karein.",
    network: "Connect nahi ho paaya. Phir se try karein.",
    session: "Aapka session restore nahi ho paaya. Phir se sign in karein.",
    validation: "Highlight kiye gaye fields check karein.",
    session_unavailable: "Secure session shuru nahi ho paaya. Phir se try karein.",
    logout_failed:
      "Server par log out pura nahi hua. Aap abhi bhi signed in hain — phir se try karein.",
    database_error: "Hamari taraf se kuch gadbad ho gayi. Phir se try karein.",
    guest_already_claimed:
      "Ye device pehle se ek account se juda hai. Backup ID se us account mein sign in karein.",
    timeout: "Request time out ho gaya. Phir se try karein.",
    server_error: "Hamari taraf se kuch gadbad ho gayi. Phir se try karein.",
  },
  hindi: {
    too_short: "उपयोगकर्ता नाम बहुत छोटा है।",
    too_long: "उपयोगकर्ता नाम बहुत लंबा है।",
    bad_chars: "केवल अक्षर, अंक, डॉट, अंडरस्कोर या हाइफ़न उपयोग करें।",
    reserved: "यह उपयोगकर्ता नाम उपलब्ध नहीं है।",
    too_weak: "कृपया अधिक मज़बूत पासवर्ड चुनें।",
    same_as_username: "पासवर्ड में आपका उपयोगकर्ता नाम नहीं हो सकता।",
    username_taken:
      "यह उपयोगकर्ता नाम पहले से पंजीकृत है। कोई दूसरा नाम चुनें या Backup ID से अपना खाता restore करें।",
    invalid_credentials: "उपयोगकर्ता नाम या पासवर्ड गलत है।",
    too_many_attempts: "बहुत अधिक प्रयास। कृपया थोड़ी देर बाद पुनः प्रयास करें।",
    network: "कनेक्ट नहीं हो पाया। कृपया पुनः प्रयास करें।",
    session: "आपका सत्र restore नहीं हो सका। कृपया दोबारा साइन इन करें।",
    validation: "कृपया हाइलाइट किए गए फ़ील्ड जाँचें।",
    session_unavailable: "सुरक्षित सत्र शुरू नहीं हो सका। कृपया पुनः प्रयास करें।",
    logout_failed:
      "सर्वर पर लॉग आउट पूरा नहीं हुआ। आप अभी भी साइन इन हैं — कृपया पुनः प्रयास करें।",
    database_error: "हमारी ओर से कुछ गड़बड़ी हुई। कृपया पुनः प्रयास करें।",
    guest_already_claimed:
      "यह डिवाइस पहले से एक खाते से जुड़ा है। Backup ID से उस खाते में साइन इन करें।",
    timeout: "अनुरोध का समय समाप्त हो गया। कृपया पुनः प्रयास करें।",
    server_error: "हमारी ओर से कुछ गड़बड़ी हुई। कृपया पुनः प्रयास करें।",
  },
} as const;

export function errorText(code: IdentityErrorCode, language: Language): string {
  return ERROR_TEXT[language][code] ?? ERROR_TEXT[language].validation;
}

/**
 * Map any thrown server error to a safe, localized, non-revealing message.
 * Raw backend errors (which may name a constraint or a table) never reach the
 * user, so nothing internal can leak (§77).
 */
export function safeErrorText(error: unknown, language: Language): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const code = raw.trim() as IdentityErrorCode;
  if (code in ERROR_TEXT[language]) return errorText(code, language);
  if (/fetch|network|Failed to fetch|load failed/i.test(raw)) return errorText("network", language);
  return errorText("network", language);
}

/* ------------------------------------------------------------------ */
/* Identity UI text (§51) — the EXISTING Settings language decides       */
/* ------------------------------------------------------------------ */

export type IdentityStrings = {
  welcomeTitle: string;
  welcomeSubtitle: string;
  newGuest: string;
  backupId: string;
  secureDevice: string;
  secureDeviceHint: string;
  username: string;
  password: string;
  confirmPassword: string;
  usernamePlaceholder: string;
  passwordPlaceholder: string;
  createGuestId: string;
  restoreBackup: string;
  back: string;
  creating: string;
  restoring: string;
  signingOut: string;
  clearing: string;
  accountLabel: string;
  guestIdLabel: string;
  logOut: string;
  logOutHint: string;
  clearCache: string;
  clearCacheHint: string;
  clearData: string;
  clearDataHint: string;
  clearDataConfirmTitle: string;
  clearDataConfirmBody: string;
  confirm: string;
  cancel: string;
  cacheCleared: string;
  dataCleared: string;
  loggedOut: string;
  welcomeBack: string;
  haveAccount: string;
  noAccount: string;
  passwordMismatch: string;
  restoreBackupHint: string;
};

export const IDENTITY_TEXT: Record<Language, IdentityStrings> = {
  english: {
    welcomeTitle: "Welcome to USTAD AI",
    welcomeSubtitle: "Set up your permanent Guest ID once, then USTAD AI opens straight to Home.",
    newGuest: "New Guest ID",
    backupId: "Backup ID",
    secureDevice: "Secure this device",
    secureDeviceHint:
      "Add a username and password to this device's existing Guest ID. Your data stays exactly as it is.",
    username: "Username",
    password: "Password",
    confirmPassword: "Confirm password",
    usernamePlaceholder: "Enter username",
    passwordPlaceholder: "Create password",
    createGuestId: "Create New Guest ID",
    restoreBackup: "Restore Backup",
    back: "Back",
    creating: "Creating Guest ID…",
    restoring: "Restoring account…",
    signingOut: "Signing out…",
    clearing: "Clearing…",
    accountLabel: "Account",
    guestIdLabel: "Your Guest ID",
    logOut: "Log Out",
    logOutHint: "Ends this session on this device. Your account and data stay safe.",
    clearCache: "Clear Cache",
    clearCacheHint: "Removes temporary files only. You stay signed in.",
    clearData: "Clear Data",
    clearDataHint: "Removes local data on this device. Your server account stays safe.",
    clearDataConfirmTitle: "Clear Data?",
    clearDataConfirmBody:
      "Are you sure you want to clear local USTAD AI data? Your account, coins and progress on the server are NOT deleted and can be restored with Backup ID.",
    confirm: "Confirm",
    cancel: "Cancel",
    cacheCleared: "Cache cleared",
    dataCleared: "Local data cleared",
    loggedOut: "Signed out",
    welcomeBack: "Welcome back",
    haveAccount: "Already have an account?",
    noAccount: "New to USTAD AI?",
    passwordMismatch: "Passwords do not match.",
    restoreBackupHint:
      "Already have a Guest ID from another device? Sign in with your username and password.",
  },
  hinglish: {
    welcomeTitle: "USTAD AI mein aapka swagat hai",
    welcomeSubtitle:
      "Ek baar apna permanent Guest ID set karein, phir USTAD AI seedha Home khulega.",
    newGuest: "Naya Guest ID",
    backupId: "Backup ID",
    secureDevice: "Is device ko secure karein",
    secureDeviceHint:
      "Is device ke existing Guest ID par username aur password lagayein. Aapka data bilkul waisa hi rahega.",
    username: "Username",
    password: "Password",
    confirmPassword: "Password dobara",
    usernamePlaceholder: "Username likhein",
    passwordPlaceholder: "Password banayein",
    createGuestId: "Naya Guest ID banayein",
    restoreBackup: "Backup Restore karein",
    back: "Wapas",
    creating: "Guest ID ban raha hai…",
    restoring: "Account restore ho raha hai…",
    signingOut: "Sign out ho raha hai…",
    clearing: "Clear ho raha hai…",
    accountLabel: "Account",
    guestIdLabel: "Aapka Guest ID",
    logOut: "Log Out",
    logOutHint: "Is device par session khatam karega. Account aur data safe rahega.",
    clearCache: "Clear Cache",
    clearCacheHint: "Sirf temporary files hatengi. Aap sign in rahenge.",
    clearData: "Clear Data",
    clearDataHint: "Is device ka local data hatega. Server account safe rahega.",
    clearDataConfirmTitle: "Clear Data karein?",
    clearDataConfirmBody:
      "Kya aap local USTAD AI data clear karna chahte hain? Server par aapka account, coins aur progress delete NAHI honge aur Backup ID se restore ho sakte hain.",
    confirm: "Confirm",
    cancel: "Cancel",
    cacheCleared: "Cache clear ho gaya",
    dataCleared: "Local data clear ho gaya",
    loggedOut: "Sign out ho gaya",
    welcomeBack: "Wapas swagat",
    haveAccount: "Pehle se account hai?",
    noAccount: "USTAD AI par naye hain?",
    passwordMismatch: "Password match nahi kar rahe.",
    restoreBackupHint:
      "Kisi doosre device ka Guest ID hai? Username aur password se sign in karein.",
  },
  hindi: {
    welcomeTitle: "USTAD AI में आपका स्वागत है",
    welcomeSubtitle: "एक बार अपना स्थायी Guest ID सेट करें, फिर USTAD AI सीधे Home खुलेगा।",
    newGuest: "नया Guest ID",
    backupId: "Backup ID",
    secureDevice: "इस डिवाइस को सुरक्षित करें",
    secureDeviceHint:
      "इस डिवाइस के मौजूदा Guest ID पर उपयोगकर्ता नाम और पासवर्ड लगाएँ। आपका डेटा बिल्कुल वैसा ही रहेगा।",
    username: "उपयोगकर्ता नाम",
    password: "पासवर्ड",
    confirmPassword: "पासवर्ड दोबारा",
    usernamePlaceholder: "उपयोगकर्ता नाम लिखें",
    passwordPlaceholder: "पासवर्ड बनाएँ",
    createGuestId: "नया Guest ID बनाएँ",
    restoreBackup: "Backup Restore करें",
    back: "वापस",
    creating: "Guest ID बन रहा है…",
    restoring: "खाता restore हो रहा है…",
    signingOut: "साइन आउट हो रहा है…",
    clearing: "साफ़ हो रहा है…",
    accountLabel: "खाता",
    guestIdLabel: "आपका Guest ID",
    logOut: "Log Out",
    logOutHint: "इस डिवाइस पर सत्र समाप्त होगा। खाता और डेटा सुरक्षित रहेगा।",
    clearCache: "Clear Cache",
    clearCacheHint: "केवल अस्थायी फ़ाइलें हटेंगी। आप साइन इन रहेंगे।",
    clearData: "Clear Data",
    clearDataHint: "इस डिवाइस का स्थानीय डेटा हटेगा। सर्वर खाता सुरक्षित रहेगा।",
    clearDataConfirmTitle: "Clear Data करें?",
    clearDataConfirmBody:
      "क्या आप स्थानीय USTAD AI डेटा साफ़ करना चाहते हैं? सर्वर पर आपका खाता, सिक्के और प्रगति हटेंगे नहीं और Backup ID से restore हो सकते हैं।",
    confirm: "पुष्टि करें",
    cancel: "रद्द करें",
    cacheCleared: "कैश साफ़ हो गया",
    dataCleared: "स्थानीय डेटा साफ़ हो गया",
    loggedOut: "साइन आउट हो गया",
    welcomeBack: "आपका स्वागत है",
    haveAccount: "पहले से खाता है?",
    noAccount: "USTAD AI पर नए हैं?",
    passwordMismatch: "पासवर्ड मेल नहीं खा रहे।",
    restoreBackupHint:
      "किसी दूसरे डिवाइस का Guest ID है? उपयोगकर्ता नाम और पासवर्ड से साइन इन करें।",
  },
} as const;

export const DEFAULT_IDENTITY_LANGUAGE: Language = "english";

export function identityText(language: Language): IdentityStrings {
  return IDENTITY_TEXT[language] ?? IDENTITY_TEXT[DEFAULT_IDENTITY_LANGUAGE];
}

/* ------------------------------------------------------------------ */
/* Typed backend-error mapping (§1 Case A-D, §11, §24)                  */
/*                                                                      */
/* The four cases must never blur:                                     */
/*   Case A  record genuinely absent        → null (caller decides)    */
/*   Case B  database/network failure       → database_error / network */
/*   Case C  wrong credentials              → invalid_credentials      */
/*   Case D  username exists                → username_taken           */
/* ------------------------------------------------------------------ */

/**
 * Map a Postgres/RPC error code to the ONLY two business meanings it can have
 * for account creation: a real username unique-violation, or a claim on an
 * already-claimed guest. Everything else is a database error — in particular,
 * an insert failure that is NOT 23505 must never be reported as username_taken
 * (§11).
 */
export function mapRpcErrorCode(code: string | undefined): IdentityErrorCode {
  if (code === "23505") return "username_taken";
  if (code === "U0001") return "guest_already_claimed";
  return "database_error";
}

/**
 * CENTRAL typed failure classifier (hardening §1-§2).
 *
 * Three categories, ALL of which are retryable and NONE of which ever clears
 * identity (Bug Area 1: UNKNOWN ERROR ≠ NEW USER — identity loss is reserved
 * for a CONFIRMED invalid/revoked/missing session verdict, which the server
 * returns as a value, never as a thrown error):
 *
 *   network       fetch/transport/DNS failures, HTTP 502/503/504
 *   timeout       the request ran out of time
 *   server_error  anything else the backend threw (500, unexpected RPC
 *                 exceptions, unknown Supabase errors) — safe retry state
 */
export function classifyClientFailure(error: unknown): "network" | "timeout" | "server_error" {
  const raw = error instanceof Error ? (error.message ?? "") : String(error ?? "");
  // HTTP gateway/overload codes are grouped with transport failures (§1 lists
  // 502/503/504 as transient) and are checked BEFORE the timeout wording, so
  // "504 Gateway Timeout" lands in the right category.
  if (/\b(502|503|504)\b/.test(raw)) return "network";
  if (/timeout|timed out|ETIMEDOUT/i.test(raw)) return "timeout";
  if (
    /fetch|failed to fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|ERR_INTERNET|ERR_NETWORK|load failed/i.test(
      raw,
    )
  )
    return "network";
  return "server_error";
}

/**
 * Map a THROWN error to a safe user-facing code (hardening §1-§3). Typed
 * internal errors pass through; transport failures become `network`/`timeout`;
 * every other unknown backend failure becomes `server_error` — never
 * `validation`, never `invalid_credentials`, never `username_taken`, and never
 * a raw constraint/table message (§24, §77).
 */
export function toIdentityErrorCode(error: unknown): IdentityErrorCode {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw.includes("session_unavailable")) return "session_unavailable";
  if (raw.includes("database_error")) return "database_error";
  if (raw.includes("guest_already_claimed")) return "guest_already_claimed";
  const kind = classifyClientFailure(error);
  if (kind === "network") return "network";
  if (kind === "timeout") return "timeout";
  return "server_error";
}
