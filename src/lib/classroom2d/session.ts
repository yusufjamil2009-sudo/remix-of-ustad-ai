/**
 * Classroom session identity + persistence (Sections 27–32).
 *
 * Every classroom session has a stable sessionId, lessonId and a versioned
 * snapshot of the master timeline, board state, stage state, teacher state and
 * voice state. The snapshot lives in localStorage, SCOPED BY GUEST, so an
 * active lesson survives a refresh without leaking into another guest.
 *
 * Keys:
 *   ustad.classroom.session.<guestId>.<sessionId>
 *   ustad.classroom.latest.<guestId>
 *
 * The unscoped key `ustad.classroom.session.latest` is NEVER the authoritative
 * recovery source (FIX #3).
 */
import type { TimelineSnapshot } from "./timeline";
import type { LessonLang } from "./lesson";
import type { BoardSnapshot } from "./board";
import type { TeacherAnimation } from "./types";
import type { BoardTheme } from "./board";
import type { Object3DKind } from "./types";
import type { StudentLevel, TeachingLifecycle, TeachingMode } from "../teaching/lifecycle";
import type { LessonSourceType } from "../teaching/source";

/** A semantic visual pinned to the 2D stage alongside the board. */
export type SceneObjectSnapshot = {
  id: string;
  kind: Object3DKind;
  labels: string[];
  visible: boolean;
};

export type TeacherSnapshot = {
  animation: TeacherAnimation;
  /** 2D stage anchor the teacher stands at */
  anchor: "board" | "center" | "left" | "right" | "desk";
  facing: 1 | -1;
};

/** 2D stage snapshot (replaces the old 3D camera snapshot). */
export type StageSnapshot = {
  theme: BoardTheme;
  ratio: "auto" | "16:9" | "9:16";
  scroll: number;
};

export type ClassroomResumeSnapshot = {
  sessionId: string;
  lessonId: string;
  topic: string;
  lang: LessonLang;
  timeline: TimelineSnapshot;
  board: BoardSnapshot | null;
  scene?: {
    objects: SceneObjectSnapshot[];
    teacher: TeacherSnapshot;
    stage: StageSnapshot;
    lastTeacherSpeech?: string;
  };
  playing: boolean;
  doubt: ClassroomSessionSnapshot["doubt"];
  completedConcepts: string[];
  currentConcept: string;
  studentLevel: StudentLevel | null;
  sourceType: LessonSourceType | null;
  lifecycle: TeachingLifecycle;
  lastTeacherSpeech?: string;
};

export type ClassroomSessionSnapshot = {
  v: 1;
  guestId: string;
  sessionId: string;
  lessonId: string;
  topic: string;
  lang: LessonLang;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineSnapshot;
  board: BoardSnapshot | null;
  /** Whether the lesson was playing when the snapshot was taken. */
  playing: boolean;
  /** Active doubt-branch metadata (if a doubt was open at refresh). */
  doubt: {
    question: string;
    branchStepIds: string[];
    resumeIndex: number;
  } | null;
  /** 2D stage / teacher / visuals. Optional for v1 snapshots. */
  scene?: {
    objects: SceneObjectSnapshot[];
    teacher: TeacherSnapshot;
    stage: StageSnapshot;
    lastTeacherSpeech?: string;
  };
  /** Orchestrator slice — optional so v1 snapshots still restore. */
  orchestrator?: {
    lifecycle: TeachingLifecycle;
    teachingMode: TeachingMode;
    completedConcepts: string[];
    sourceType: LessonSourceType | null;
    studentLevel: StudentLevel | null;
  };
};

const SESSION_PREFIX = "ustad.classroom.session.";
const LATEST_PREFIX = "ustad.classroom.latest.";
/** Legacy unscoped pointer — never trusted as current-guest recovery. */
export const LEGACY_LATEST_KEY = "ustad.classroom.session.latest";
const GUEST_ID_KEY = "ustad.guest.id";

export type ClassroomKv = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

let testStore: ClassroomKv | null = null;

/** Test-only storage injection. Production always uses window.localStorage. */
export function _setClassroomStorageForTests(store: ClassroomKv | null): void {
  testStore = store;
}

function store(): ClassroomKv | null {
  if (testStore) return testStore;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function sessionStorageKey(guestId: string, sessionId: string): string {
  return `${SESSION_PREFIX}${guestId}.${sessionId}`;
}

export function latestStorageKey(guestId: string): string {
  return `${LATEST_PREFIX}${guestId}`;
}

/**
 * Guest identity for classroom persistence — never from a request body.
 *
 * INVARIANT (audited with the permanent-identity change): `ustad.guest.id` has
 * exactly ONE writer, the central identity store in `ustad-client.ts`, which
 * writes it only for the currently authenticated guest and removes it on LOG
 * OUT / CLEAR DATA. It is therefore never an authority — the server still
 * derives ownership from the verified session — and when it is absent (fresh
 * device, cleared data) snapshots are simply not restored instead of being
 * attributed to the wrong guest. No feature may write this key directly.
 */
export function classroomGuestId(): string {
  const s = store();
  if (!s) return "";
  try {
    return s.getItem(GUEST_ID_KEY) ?? "";
  } catch {
    return "";
  }
}

function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newSessionId(): string {
  return rid("sess");
}

export function newLessonId(): string {
  return rid("les");
}

function ownsSnapshot(snap: ClassroomSessionSnapshot, guestId: string): boolean {
  if (!guestId) return false;
  if (snap.guestId && snap.guestId !== guestId) return false;
  // Legacy snapshots without guestId are untrusted — do not restore them.
  if (!snap.guestId) return false;
  return true;
}

/** Save a session snapshot. Best-effort; never throws. Requires a guest id. */
export function saveSession(snapshot: ClassroomSessionSnapshot, guestId?: string): void {
  const s = store();
  if (!s) return;
  const gid = (guestId || snapshot.guestId || classroomGuestId()).trim();
  if (!gid) return;
  try {
    const next: ClassroomSessionSnapshot = {
      ...snapshot,
      guestId: gid,
      updatedAt: new Date().toISOString(),
    };
    s.setItem(sessionStorageKey(gid, snapshot.sessionId), JSON.stringify(next));
    s.setItem(latestStorageKey(gid), snapshot.sessionId);
    // Drop the unscoped pointer so it cannot resurrect another guest's lesson.
    s.removeItem(LEGACY_LATEST_KEY);
  } catch {
    /* storage full / disabled — persist is best-effort */
  }
}

/** Load a session snapshot by id, only if it belongs to `guestId`. */
export function loadSession(sessionId: string, guestId?: string): ClassroomSessionSnapshot | null {
  const s = store();
  if (!s) return null;
  const gid = (guestId || classroomGuestId()).trim();
  if (!gid || !sessionId) return null;
  try {
    const raw = s.getItem(sessionStorageKey(gid, sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClassroomSessionSnapshot;
    if (parsed.v !== 1) return null;
    if (!ownsSnapshot(parsed, gid)) return null;
    if (parsed.sessionId !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load the most recently active session for THIS guest.
 * Never reads `ustad.classroom.session.latest`.
 */
export function loadLatestSession(guestId?: string): ClassroomSessionSnapshot | null {
  const s = store();
  if (!s) return null;
  const gid = (guestId || classroomGuestId()).trim();
  if (!gid) return null;
  try {
    const id = s.getItem(latestStorageKey(gid));
    return id ? loadSession(id, gid) : null;
  } catch {
    return null;
  }
}

/** Forget a session (lesson finished / user exited). */
export function clearSession(sessionId: string, guestId?: string): void {
  const s = store();
  if (!s) return;
  const gid = (guestId || classroomGuestId()).trim();
  if (!gid) return;
  try {
    s.removeItem(sessionStorageKey(gid, sessionId));
    const latest = s.getItem(latestStorageKey(gid));
    if (latest === sessionId) s.removeItem(latestStorageKey(gid));
  } catch {
    /* ignore */
  }
}

/** True when a snapshot is safe to restore for this guest + optional session. */
export function validateSessionOwnership(
  snap: ClassroomSessionSnapshot | null,
  guestId: string,
  sessionId?: string,
): snap is ClassroomSessionSnapshot {
  if (!snap || !guestId) return false;
  if (!ownsSnapshot(snap, guestId)) return false;
  if (sessionId && snap.sessionId !== sessionId) return false;
  return true;
}
