/* eslint-disable @typescript-eslint/no-explicit-any */
/** All guest-scoped data operations. Every query is filtered by the verified guest id. */
import { requireGuest, db, ensureGuestRow } from "./guest.server";
import { stripProtectedFields } from "./strip-protected";

export { stripProtectedFields } from "./strip-protected";

/**
 * Resolve the current session WITHOUT EVER CREATING A GUEST.
 *
 * CHANGED BEHAVIOUR (permanent identity spec §7): this used to mint a brand-new
 * Guest ID whenever the stored token was missing or invalid. That silently
 * abandoned a real account (and its coins, chats, cups and certificates) the
 * moment a token went stale. It now returns `needsIdentity: true` instead, and
 * the app shows the Welcome screen so the USER decides: create a new Guest ID
 * or restore an existing one with Backup ID.
 *
 * Only an explicit user action (NEW GUEST ID / BACKUP ID / secure this device)
 * can establish or reconnect an identity, and those live in `identity.functions`.
 */
export type BootstrapResult =
  | {
      needsIdentity: true;
      identity: "no_identity" | "invalid_session";
      guestId: null;
      token: "";
      profile: null;
      settings: null;
      cookieSet: false;
      hasExistingGuest: false;
      hasAccount: false;
      username: null;
    }
  | {
      needsIdentity: false;
      identity: "authenticated";
      guestId: string;
      token: string;
      profile: any;
      settings: any;
      cookieSet: boolean;
      hasExistingGuest: true;
      /** True when this guest already holds a username/password (account row). */
      hasAccount: boolean;
      /** Server-authoritative display username (null for an unclaimed guest). */
      username: string | null;
    };

export async function bootstrapGuest(token?: string): Promise<BootstrapResult> {
  const {
    readGuestCookie,
    writeGuestCookie,
    verifySession,
    issueSessionToken,
    refreshSessionToken,
    sessionIsRevoked,
  } = await import("./guest.server");

  const candidate = token && token.includes(".") ? token : ((await readGuestCookie()) ?? "");
  const session = await verifySession(candidate);

  // §6: a session row must EXIST and be ACTIVE. "missing" is its own verdict
  // (a token pointing at nothing is invalid, never active); a DATABASE failure
  // throws network below so the stored identity is preserved (§25).
  if (!session) {
    return {
      needsIdentity: true,
      identity: "no_identity",
      guestId: null,
      token: "",
      profile: null,
      settings: null,
      cookieSet: false,
      hasExistingGuest: false,
      hasAccount: false,
      username: null,
    };
  }

  if (session.jti) {
    const state = await sessionIsRevoked(session.jti);
    if (state === "revoked" || state === "missing") {
      return {
        needsIdentity: true,
        identity: "invalid_session",
        guestId: null,
        token: "",
        profile: null,
        settings: null,
        cookieSet: false,
        hasExistingGuest: false,
        hasAccount: false,
        username: null,
      };
    }
  }

  const { data: guest, error: guestError } = await db()
    .from("guests")
    .select("id")
    .eq("id", session.guestId)
    .maybeSingle();
  if (guestError) {
    // DATABASE OUTAGE, not an unknown user (§20, §22). Throwing keeps the whole
    // client identity intact and surfaces a retryable error instead of dropping
    // the user into Welcome and inviting them to create a second identity.
    throw new Error("network");
  }
  if (!guest) {
    return {
      needsIdentity: true,
      identity: "invalid_session",
      guestId: null,
      token: "",
      profile: null,
      settings: null,
      cookieSet: false,
      hasExistingGuest: false,
      hasAccount: false,
      username: null,
    };
  }

  // Re-issue a session token for the SAME guest (identity is never regenerated
  // here) and keep the guest's last-seen marker fresh.
  //
  //   • 4-part tokens already carry a live session id → the SAME jti is reused,
  //     so LOG OUT still revokes the one session this device holds.
  //   • legacy 2/3-part tokens predate revocation (§5) → they are safely
  //     MIGRATED: a new revocable session row is created and a 4-part token is
  //     returned. The Guest ID never changes and no data is touched, so the user
  //     simply gains logout/revocation support on their next open.
  //
  // If the session row cannot be written we must NOT report an authenticated
  // session (that token could never be revoked) — the caller treats this as a
  // transient failure and keeps the user's existing identity intact.
  let issued: string;
  try {
    // Same jti refresh (verified by the RPC) or legacy→revocable migration.
    issued = session.jti
      ? await refreshSessionToken(session.guestId, session.jti)
      : await issueSessionToken(session.guestId);
    await ensureGuestRow(session.guestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    if (msg.includes("session_unavailable")) {
      // §7: the session row is genuinely missing/revoked → the token is dead.
      // The stored token is cleared (client) and the USER decides on Welcome.
      return {
        needsIdentity: true,
        identity: "invalid_session",
        guestId: null,
        token: "",
        profile: null,
        settings: null,
        cookieSet: false,
        hasExistingGuest: false,
        hasAccount: false,
        username: null,
      };
    }
    // §3 / §25: any DATABASE/transport failure must NEVER read as "new user".
    // The caller keeps the stored identity and surfaces a retryable error.
    throw new Error("network");
  }
  const cookieSet = await writeGuestCookie(issued);
  // Does this guest still need its ONE-TIME identity setup? A guest that
  // predates this feature keeps its data and is simply asked to add a username
  // and password — no new Guest ID is ever created for it.
  let hasAccount = false;
  let username: string | null = null;
  try {
    const { data: acct } = await db()
      .from("ustad_accounts")
      .select("guest_id,username")
      .eq("guest_id", session.guestId)
      .maybeSingle();
    hasAccount = Boolean(acct);
    // The SERVER account is the authority for the display username (§16); the
    // local copy is only a cache and is refreshed from here on every open.
    username = (acct?.["username"] as string | undefined) ?? null;
  } catch {
    hasAccount = false;
    username = null;
  }

  const client = db();
  const [{ data: profile }, { data: settings }] = await Promise.all([
    client.from("profiles").select("*").eq("guest_id", session.guestId).maybeSingle(),
    client.from("settings").select("*").eq("guest_id", session.guestId).maybeSingle(),
  ]);
  return {
    needsIdentity: false,
    identity: "authenticated",
    guestId: session.guestId,
    token: issued,
    profile,
    settings,
    cookieSet,
    hasExistingGuest: true,
    hasAccount,
    username,
  };
}

/* ---------- conversations ---------- */

export async function listConversations(token: unknown) {
  const guestId = await requireGuest(token);
  const { data, error } = await db()
    .from("conversations")
    .select("id,title,pinned,created_at,updated_at")
    .eq("guest_id", guestId)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createConversation(token: unknown, title = "New chat") {
  const guestId = await requireGuest(token);
  const { data, error } = await db()
    .from("conversations")
    .insert({ guest_id: guestId, title })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateConversation(
  token: unknown,
  id: string,
  patch: { title?: string; pinned?: boolean },
) {
  const guestId = await requireGuest(token);
  const { data, error } = await db()
    .from("conversations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("guest_id", guestId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Conversation not found");
  return data;
}

export async function deleteConversation(token: unknown, id: string) {
  const guestId = await requireGuest(token);
  const { error } = await db().from("conversations").delete().eq("id", id).eq("guest_id", guestId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/**
 * Read a message's `attachments` as an array, whatever jsonb actually holds.
 *
 * The `messages.attachments` column defaults to `'{}'::jsonb`, which decodes to
 * an empty OBJECT, not an empty array. Rows written without attachments (every
 * assistant reply) therefore carry `{}`, and `?? []` does not catch it because
 * `{}` is not null. Iterating it threw "object is not iterable" and the whole
 * message list failed to load after the first exchange.
 */
function attachmentsOf(row: { attachments?: unknown }): Array<{
  id?: string;
  name?: string;
  mime?: string;
  kind?: string;
}> {
  const value = row.attachments;
  return Array.isArray(value) ? value : [];
}

export async function listMessages(token: unknown, conversationId: string) {
  const guestId = await requireGuest(token);
  const { data, error } = await db()
    .from("messages")
    .select("*")
    .eq("guest_id", guestId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  // Bug 22: hydrate attachment previews so uploaded images still render after
  // a refresh. Message JSON only stores ids; the bytes live in attachments.
  const ids: string[] = [];
  for (const row of rows) {
    for (const a of attachmentsOf(row)) {
      if (a?.id) ids.push(a.id);
    }
  }
  if (!ids.length) return rows;
  const { data: files } = await db()
    .from("attachments")
    .select("id,name,mime,kind,data")
    .eq("guest_id", guestId)
    .in("id", ids);
  const byId = new Map((files ?? []).map((f) => [f.id, f]));
  return Promise.all(
    rows.map(async (row) => {
      const atts = attachmentsOf(row);
      if (!atts.length) return row;
      const hydrated = await Promise.all(
        atts.map(async (a) => {
          const f = a.id ? byId.get(a.id) : undefined;
          if (!f) return a;
          const previewUrl =
            f.kind === "image"
              ? ((await signedUrlFor(f.data as string | null)) ??
                resolveAttachmentSrc(f.data as string | null))
              : undefined;
          return {
            id: f.id,
            name: f.name ?? a.name,
            mime: f.mime ?? a.mime,
            kind: f.kind ?? a.kind,
            ...(previewUrl ? { previewUrl } : {}),
          };
        }),
      );
      return { ...row, attachments: hydrated };
    }),
  );
}

function resolveAttachmentSrc(data: string | null): string | undefined {
  if (!data) return undefined;
  if (data.startsWith("data:")) return data;
  if (data.startsWith("http://") || data.startsWith("https://")) return data;
  return undefined;
}

/* ---------- profile & settings ---------- */

export async function saveProfile(token: unknown, patch: Record<string, unknown>) {
  const guestId = await requireGuest(token);
  const safe = stripProtectedFields(patch);
  const { data, error } = await (db().from("profiles") as any)
    .upsert(
      { ...safe, guest_id: guestId, updated_at: new Date().toISOString() },
      { onConflict: "guest_id" },
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function saveSettings(token: unknown, patch: Record<string, unknown>) {
  const guestId = await requireGuest(token);
  const safe = stripProtectedFields(patch);
  const { data, error } = await (db().from("settings") as any)
    .upsert(
      { ...safe, guest_id: guestId, updated_at: new Date().toISOString() },
      { onConflict: "guest_id" },
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function getProfile(token: unknown) {
  const guestId = await requireGuest(token);
  const client = db();
  const [{ data: profile }, { data: settings }] = await Promise.all([
    client.from("profiles").select("*").eq("guest_id", guestId).maybeSingle(),
    client.from("settings").select("*").eq("guest_id", guestId).maybeSingle(),
  ]);
  return { profile, settings };
}

/* ---------- simple owned collections ---------- */

type Table = "memories" | "goals" | "notes" | "reminders" | "lessons" | "exams" | "exam_results";

export async function listRows(token: unknown, table: Table, order = "created_at") {
  const guestId = await requireGuest(token);
  const { data, error } = await db()
    .from(table)
    .select("*")
    .eq("guest_id", guestId)
    .order(order, { ascending: table === "reminders" });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function insertRow(token: unknown, table: Table, values: Record<string, unknown>) {
  const guestId = await requireGuest(token);
  const safe = stripProtectedFields(values);
  const { data, error } = await (db().from(table) as any)
    .insert({ ...safe, guest_id: guestId })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateRow(
  token: unknown,
  table: Table,
  id: string,
  patch: Record<string, unknown>,
) {
  const guestId = await requireGuest(token);
  const safe = stripProtectedFields(patch);
  const { data, error } = await (db().from(table) as any)
    .update(safe)
    .eq("id", id)
    .eq("guest_id", guestId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Item not found");
  return data;
}

export async function deleteRow(token: unknown, table: Table, id: string) {
  const guestId = await requireGuest(token);
  const { error } = await db().from(table).delete().eq("id", id).eq("guest_id", guestId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/* ---------- attachments ---------- */

const MAX_BYTES = 8 * 1024 * 1024;
const STORAGE_BUCKET = "ustad-attachments";
const STORAGE_PREFIX = "storage:";

/** Bug #22: discover/create the bucket once per process, not on every upload. */
let bucketReady: Promise<boolean> | null = null;

async function ensureAttachmentBucket(): Promise<boolean> {
  if (!bucketReady) {
    bucketReady = (async () => {
      try {
        const { data } = await db().storage.listBuckets();
        if (data?.some((b) => b.name === STORAGE_BUCKET)) return true;
        const { error } = await db().storage.createBucket(STORAGE_BUCKET, {
          public: false,
          fileSizeLimit: MAX_BYTES,
        });
        if (error && !/already exists|duplicate/i.test(error.message)) return false;
        return true;
      } catch {
        return false;
      }
    })();
  }
  const ok = await bucketReady;
  if (!ok) bucketReady = null;
  return ok;
}

async function uploadToStorage(
  guestId: string,
  id: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string | null> {
  const ok = await ensureAttachmentBucket();
  if (!ok) return null;
  const path = `${guestId}/${id}`;
  const { error } = await db().storage.from(STORAGE_BUCKET).upload(path, bytes, {
    contentType: mime,
    upsert: true,
  });
  if (error) return null;
  return `${STORAGE_PREFIX}${path}`;
}

async function deleteStorageObject(data: string | null): Promise<void> {
  if (!data?.startsWith(STORAGE_PREFIX)) return;
  const path = data.slice(STORAGE_PREFIX.length);
  try {
    await db().storage.from(STORAGE_BUCKET).remove([path]);
  } catch {
    /* physical delete is best-effort once the DB row is gone */
  }
}

async function signedUrlFor(data: string | null): Promise<string | undefined> {
  if (!data) return undefined;
  if (data.startsWith("data:") || data.startsWith("http")) return data;
  if (!data.startsWith(STORAGE_PREFIX)) return undefined;
  const path = data.slice(STORAGE_PREFIX.length);
  const { data: signed, error } = await db()
    .storage.from(STORAGE_BUCKET)
    .createSignedUrl(path, 3600);
  if (error || !signed?.signedUrl) return undefined;
  return signed.signedUrl;
}

/**
 * Resolve an attachment `data` column into a provider-usable URL (Bug #1).
 * `storage:guest/id` is NEVER sent to a vision/OCR provider — only a signed
 * HTTPS URL or a data: URL. Ownership is enforced by the caller (guest filter).
 */
export async function resolveAttachmentForProvider(data: string | null): Promise<string> {
  if (!data) throw new Error("Attachment has no stored data.");
  if (data.startsWith("data:")) return data;
  if (data.startsWith("https://") || data.startsWith("http://")) return data;
  if (data.startsWith(STORAGE_PREFIX)) {
    const url = await signedUrlFor(data);
    if (!url)
      throw new Error("Attachment storage URL could not be resolved. The file may have expired.");
    return url;
  }
  throw new Error("Unsupported attachment storage format.");
}

/** Fetch a signed/https image as a data URL (OCR.space wants base64). */
export async function attachmentAsDataUrl(data: string | null): Promise<string> {
  const resolved = await resolveAttachmentForProvider(data);
  if (resolved.startsWith("data:")) return resolved;
  const res = await fetch(resolved);
  if (!res.ok) throw new Error(`Could not read attachment bytes (${res.status}).`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "application/octet-stream";
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}
const ALLOWED =
  /^(image\/(png|jpeg|jpg|webp|gif)|application\/pdf|text\/plain|text\/markdown|text\/csv|application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))$/;

export type SavedAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "pdf" | "document";
  data: string | null;
  extracted_text: string | null;
};

/** Rolling retention cap per (guest, kind) for not-yet-referenced files. */
const RETAIN = { image: 5, pdf: 5 } as const;

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("Malformed file data.");
  const mime = (m[1] ?? "application/octet-stream").toLowerCase();
  const b64 = m[3] ?? "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

function looksLikeImage(bytes: Uint8Array, mime: string): boolean {
  // Magic-byte sniff so a renamed executable cannot pass as an image.
  const head = [...bytes.subarray(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  if (mime === "image/png") return head.startsWith("89 50 4e 47");
  if (mime === "image/jpeg") return head.startsWith("ff d8 ff");
  if (mime === "image/gif") return head.startsWith("47 49 46 38");
  if (mime === "image/webp")
    return head.startsWith("52 49 46 46") && head.slice(18, 23) === "57 45 42 50";
  return false;
}

/**
 * Enforce the rolling retention cap for a guest. Oldest unreferenced files
 * of the same kind beyond the cap are deleted (server-authoritative, Bug 1).
 * Referenced attachments (already attached to a message) are kept.
 */
/**
 * Enforce the rolling retention cap for a guest (Bug 1). After inserting a
 * new unreferenced attachment, keep only the newest CAP of that kind and
 * delete older ones. Attachments already referenced by a message are kept.
 */
async function enforceRetention(guestId: string, kind: "image" | "pdf"): Promise<void> {
  const cap = RETAIN[kind];
  const { data: all } = await db()
    .from("attachments")
    .select("id, created_at, data")
    .eq("guest_id", guestId)
    .eq("kind", kind)
    .order("created_at", { ascending: true });
  if (!all || all.length <= cap) return;

  const { data: used } = await db().from("messages").select("attachments").eq("guest_id", guestId);
  const referenced = new Set<string>();
  for (const row of used ?? []) {
    for (const a of (row.attachments as Array<{ id?: string }>) ?? [])
      if (a?.id) referenced.add(a.id);
  }
  // Only unreferenced files count against the rolling cap; delete the oldest
  // until at most cap unreferenced files remain.
  const unreferenced = all.filter((a) => !referenced.has(a.id));
  const excess = unreferenced.length - cap;
  if (excess <= 0) return;
  const doomed = unreferenced.slice(0, excess);
  const toDelete = doomed.map((a) => a.id);
  if (toDelete.length) {
    // Bug 28: delete the physical storage object along with the DB row.
    for (const row of doomed)
      await deleteStorageObject((row as { data?: string | null }).data ?? null);
    const { error } = await db()
      .from("attachments")
      .delete()
      .eq("guest_id", guestId)
      .in("id", toDelete);
    if (error) throw new Error(error.message);
  }
}

export async function saveAttachment(
  token: unknown,
  file: { name: string; mime: string; size: number; dataUrl: string },
) {
  const guestId = await requireGuest(token);

  // Decode and inspect the ACTUAL payload (Bug 3) — never trust client size/mime.
  const { mime: decodedMime, bytes } = decodeDataUrl(file.dataUrl);
  if (bytes.length > MAX_BYTES) throw new Error("File too large. Maximum size is 8 MB.");

  // MIME must be allowed and must match what the client claimed.
  const claimed = (file.mime ?? "").toLowerCase();
  if (!ALLOWED.test(decodedMime)) throw new Error(`Unsupported file type: ${decodedMime}`);
  if (claimed && claimed !== decodedMime)
    throw new Error("File content does not match its declared type.");

  const kind = decodedMime.startsWith("image/")
    ? "image"
    : decodedMime === "application/pdf"
      ? "pdf"
      : "document";

  // Validate actual file structure.
  if (kind === "image" && !looksLikeImage(bytes, decodedMime)) {
    throw new Error("File is not a valid image.");
  }
  if (kind === "pdf" && !looksLikePdf(bytes)) {
    throw new Error("File is not a valid PDF.");
  }

  let extracted: string | null = null;
  if (kind === "pdf") {
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const doc = await getDocumentProxy(bytes);
      const { text } = await extractText(doc, { mergePages: true });
      extracted = String(text).slice(0, 20000);
    } catch {
      extracted = null;
    }
  } else if (kind === "document" && decodedMime.startsWith("text/")) {
    try {
      extracted = new TextDecoder().decode(bytes).slice(0, 20000);
    } catch {
      extracted = null;
    }
  }

  const { data, error } = await db()
    .from("attachments")
    .insert({
      guest_id: guestId,
      name: file.name,
      mime: decodedMime,
      size: bytes.length,
      kind,
      data: "",
      extracted_text: extracted,
    })
    .select("id,name,mime,size,kind,extracted_text")
    .single();
  if (error) throw new Error(error.message);

  // Bug 2: prefer binary object storage. If the bucket is not provisioned,
  // keep the validated payload in the existing `data` column so uploads still
  // work — this is the documented compatibility path, not a fake success.
  const stored = (await uploadToStorage(guestId, data.id, bytes, decodedMime)) ?? file.dataUrl;
  await db().from("attachments").update({ data: stored }).eq("id", data.id).eq("guest_id", guestId);

  // Enforce rolling limit AFTER a successful insert (newest N retained).
  if (kind === "image" || kind === "pdf") await enforceRetention(guestId, kind);

  return data;
}

/** Move a generated-image data URL into object storage (Bugs 2, 27). */
export async function storeGeneratedImageData(
  guestId: string,
  attachmentId: string,
  dataUrl: string,
): Promise<string> {
  const { mime, bytes } = decodeDataUrl(dataUrl);
  return (await uploadToStorage(guestId, attachmentId, bytes, mime)) ?? dataUrl;
}

/**
 * Bug #20: signed direct upload slot. Client PUTs the raw file to `uploadUrl`
 * then the `data` column is set to storage:path. Small files can still use
 * saveAttachment (data URL) — this is the large-file path.
 */
export async function beginDirectUpload(
  token: unknown,
  file: { name: string; mime: string; size: number },
) {
  const guestId = await requireGuest(token);
  if (file.size > MAX_BYTES) throw new Error("File too large. Maximum size is 8 MB.");
  const mime = (file.mime ?? "").toLowerCase();
  if (!ALLOWED.test(mime)) throw new Error(`Unsupported file type: ${mime}`);
  const kind = mime.startsWith("image/")
    ? "image"
    : mime === "application/pdf"
      ? "pdf"
      : "document";
  const { data, error } = await db()
    .from("attachments")
    .insert({
      guest_id: guestId,
      name: file.name,
      mime,
      size: file.size,
      kind,
      data: "",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const ok = await ensureAttachmentBucket();
  if (!ok) throw new Error("Object storage is not configured for direct upload.");
  const path = `${guestId}/${data.id}`;
  const { data: signed, error: signErr } = await db()
    .storage.from(STORAGE_BUCKET)
    .createSignedUploadUrl(path);
  if (signErr || !signed?.signedUrl) {
    throw new Error("Could not create a signed upload URL.");
  }
  // `data` stays empty until finalizeDirectUpload verifies the object exists.
  return { id: data.id, uploadUrl: signed.signedUrl, path: `${STORAGE_PREFIX}${path}` };
}

/**
 * After the client PUTs bytes to the signed URL, verify the object and point
 * the attachment row at `storage:guest/id`. Magic-byte sniff rejects a renamed
 * executable the same way saveAttachment does.
 */
export async function finalizeDirectUpload(token: unknown, id: string) {
  const guestId = await requireGuest(token);
  const { data, error } = await db()
    .from("attachments")
    .select("id,name,mime,kind,size,data")
    .eq("id", id)
    .eq("guest_id", guestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Attachment not found");
  const path = `${guestId}/${id}`;
  const { data: signed, error: signErr } = await db()
    .storage.from(STORAGE_BUCKET)
    .createSignedUrl(path, 120);
  if (signErr || !signed?.signedUrl) {
    throw new Error("Upload was not found in storage. Try again.");
  }
  const head = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-31" } });
  if (!head.ok && head.status !== 206) {
    throw new Error(`Could not verify uploaded file (${head.status}).`);
  }
  const bytes = new Uint8Array(await head.arrayBuffer());
  const mime = (data.mime ?? "").toLowerCase();
  if (data.kind === "image" && !looksLikeImage(bytes, mime)) {
    await deleteStorageObject(`${STORAGE_PREFIX}${path}`);
    await db().from("attachments").delete().eq("id", id).eq("guest_id", guestId);
    throw new Error("File is not a valid image.");
  }
  if (data.kind === "pdf" && !looksLikePdf(bytes)) {
    await deleteStorageObject(`${STORAGE_PREFIX}${path}`);
    await db().from("attachments").delete().eq("id", id).eq("guest_id", guestId);
    throw new Error("File is not a valid PDF.");
  }
  const stored = `${STORAGE_PREFIX}${path}`;
  await db().from("attachments").update({ data: stored }).eq("id", id).eq("guest_id", guestId);
  if (data.kind === "image" || data.kind === "pdf") await enforceRetention(guestId, data.kind);
  return { id: data.id, name: data.name, mime: data.mime, kind: data.kind, data: stored };
}

export async function getAttachment(token: unknown, id: string) {
  const guestId = await requireGuest(token);
  const { data, error } = await db()
    .from("attachments")
    .select("*")
    .eq("id", id)
    .eq("guest_id", guestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Attachment not found");
  return data;
}

/* ---------- clear cache / clear data ---------- */

export async function clearCache(token: unknown) {
  const guestId = await requireGuest(token);
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: used } = await db().from("messages").select("attachments").eq("guest_id", guestId);
  const keep = new Set<string>();
  for (const row of used ?? []) {
    for (const a of (row.attachments as Array<{ id?: string }>) ?? []) if (a?.id) keep.add(a.id);
  }
  const { data: all } = await db()
    .from("attachments")
    .select("id,data")
    .eq("guest_id", guestId)
    .lt("created_at", cutoff);
  const doomed = (all ?? []).filter((a) => !keep.has(a.id));
  const removable = doomed.map((a) => a.id);
  if (removable.length) {
    for (const row of doomed) await deleteStorageObject(row.data as string | null);
    await db().from("attachments").delete().eq("guest_id", guestId).in("id", removable);
  }
  return { removed: removable.length };
}

export async function clearData(token: unknown, scopes: string[]) {
  const guestId = await requireGuest(token);
  const map: Record<string, Table | "conversations" | "attachments" | "api_configs"> = {
    chats: "conversations",
    attachments: "attachments",
    memories: "memories",
    goals: "goals",
    notes: "notes",
    reminders: "reminders",
    lessons: "lessons",
    exams: "exams",
    api: "api_configs",
  };
  const cleared: string[] = [];
  for (const scope of scopes) {
    const table = map[scope];
    if (!table) continue;
    const { error } = await db().from(table).delete().eq("guest_id", guestId);
    if (error) throw new Error(error.message);
    cleared.push(scope);
  }
  return { cleared };
}
