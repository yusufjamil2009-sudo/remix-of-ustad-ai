/**
 * Session-safe API layer. Every guest-scoped server function is called through
 * here so that a stale/expired guest token is recovered automatically (one
 * silent re-bootstrap + retry) instead of surfacing
 * "Invalid guest session. Please reload USTAD AI." to the user.
 *
 * Call sites keep their existing shape: fn({ data: { token, ... } }).
 * The token is always replaced with the authoritative one from the session manager.
 */
import * as fns from "./ustad.functions";
import * as examFns from "./exam.functions";
import { currentToken, recoverGuest } from "./ustad-client";

const RECOVERABLE = /invalid guest session|guest session expired|guest signing secret/i;

type Payload = { data?: Record<string, unknown> };
type ServerFn = (arg: never) => Promise<unknown>;

function wrap<F extends ServerFn>(fn: F): F {
  const call = async (arg: Payload = {}) => {
    const data = { ...(arg.data ?? {}) };
    const token = await currentToken();
    // No identity yet (Welcome screen): calling the server would fail with
    // "Invalid guest session", which would trigger a recovery + re-bootstrap and
    // publish a new snapshot — remounting the callers and starting the whole
    // cycle again. Fail locally instead: no request, no recovery, no loop.
    if (!token) throw new Error("NO_GUEST_SESSION");
    data["token"] = token;
    try {
      return await (fn as unknown as (a: Payload) => Promise<unknown>)({ ...arg, data });
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (!RECOVERABLE.test(msg)) throw e;
      const session = await recoverGuest(true);
      // The re-handshake produced no identity — retrying would fail identically
      // and each attempt republishes the snapshot, so stop here.
      if (!session.token) throw e;
      return (fn as unknown as (a: Payload) => Promise<unknown>)({
        ...arg,
        data: { ...data, token: session.token },
      });
    }
  };
  return call as unknown as F;
}


export const listConversationsFn = wrap(fns.listConversationsFn);
export const createConversationFn = wrap(fns.createConversationFn);
export const updateConversationFn = wrap(fns.updateConversationFn);
export const deleteConversationFn = wrap(fns.deleteConversationFn);
export const listMessagesFn = wrap(fns.listMessagesFn);
export const saveProfileFn = wrap(fns.saveProfileFn);
export const saveSettingsFn = wrap(fns.saveSettingsFn);
export const getProfileFn = wrap(fns.getProfileFn);
export const listRowsFn = wrap(fns.listRowsFn);
export const insertRowFn = wrap(fns.insertRowFn);
export const updateRowFn = wrap(fns.updateRowFn);
export const deleteRowFn = wrap(fns.deleteRowFn);
export const uploadAttachmentFn = wrap(fns.uploadAttachmentFn);
export const beginDirectUploadFn = wrap(fns.beginDirectUploadFn);
export const finalizeDirectUploadFn = wrap(fns.finalizeDirectUploadFn);
export const clearCacheFn = wrap(fns.clearCacheFn);
export const clearDataFn = wrap(fns.clearDataFn);
export const galleryListFn = wrap(fns.galleryListFn);
export const galleryUploadFn = wrap(fns.galleryUploadFn);
export const galleryDeleteFn = wrap(fns.galleryDeleteFn);
export const galleryCreateShareFn = wrap(fns.galleryCreateShareFn);
export const galleryListSharesFn = wrap(fns.galleryListSharesFn);
/** Public share data — no guest token needed; the share token IS the key. */
export const galleryPublicFn = fns.galleryPublicFn;
export const listApiConfigsFn = wrap(fns.listApiConfigsFn);
export const saveApiConfigFn = wrap(fns.saveApiConfigFn);
export const testApiConfigFn = wrap(fns.testApiConfigFn);
export const deleteApiConfigFn = wrap(fns.deleteApiConfigFn);
export const setApiModelFn = wrap(fns.setApiModelFn);
export const sendMessageFn = wrap(fns.sendMessageFn);
export const generateExamFn = wrap(fns.generateExamFn);
export const startStudyExamFn = wrap(fns.startStudyExamFn);
export const submitExamFn = wrap(fns.submitExamFn);
export const generateLessonFn = wrap(fns.generateLessonFn);
export const generateNotesFn = wrap(fns.generateNotesFn);
export const processDocumentFn = wrap(fns.processDocumentFn);
export const synthesizeFn = wrap(fns.synthesizeFn);
export const transcribeFn = wrap(fns.transcribeFn);
export const voiceProvidersFn = wrap(fns.voiceProvidersFn);

/* ---- curriculum brain (Part 1) ---- */
export const getCurriculumPrefsFn = wrap(fns.getCurriculumPrefsFn);
export const saveCurriculumPrefFn = wrap(fns.saveCurriculumPrefFn);
export const resolveCurriculumFn = wrap(fns.resolveCurriculumFn);
export const refreshCurriculumFn = wrap(fns.refreshCurriculumFn);

/* ---- diagram + handwritten notes ---- */
export const diagramSpecFn = wrap(fns.diagramSpecFn);
export const diagramImageFn = wrap(fns.diagramImageFn);

/* ---- book + chapter knowledge (Part 2) ---- */
export const extractChapterFn = wrap(fns.extractChapterFn);
export const chapterContextFn = wrap(fns.chapterContextFn);
export const searchBookFn = wrap(fns.searchBookFn);

/* ---- chapter master + plan (Part 3) ---- */
export const chapterMasterFn = wrap(fns.chapterMasterFn);
export const isChapterExtractedFn = wrap(fns.isChapterExtractedFn);
export const getChapterProgressFn = wrap(fns.getChapterProgressFn);
export const recordChapterProgressFn = wrap(fns.recordChapterProgressFn);

/* ---- deep chapter teaching + multi-day lesson master (Part 4) ---- */
export const chapterLessonMasterFn = wrap(fns.chapterLessonMasterFn);
export const lessonSessionFn = wrap(fns.lessonSessionFn);
export const lessonRevisionFn = wrap(fns.lessonRevisionFn);
export const lessonTestFn = wrap(fns.lessonTestFn);
export const scoreChapterTestFn = wrap(fns.scoreChapterTestFn);
export const lessonContinuationFn = wrap(fns.lessonContinuationFn);
export const markChapterCompletedFn = wrap(fns.markChapterCompletedFn);

/* ---- question intelligence + adaptive revision + exam prep (Part 5) ---- */
export const chapterQuestionIntelligenceFn = wrap(fns.chapterQuestionIntelligenceFn);
export const adaptiveRevisionFn = wrap(fns.adaptiveRevisionFn);
export const gradeAndExplainFn = wrap(fns.gradeAndExplainFn);
export const examChapterTestFn = wrap(fns.examChapterTestFn);
export const evaluateExamChapterTestFn = wrap(fns.evaluateExamChapterTestFn);
export const subjectPrepPlanFn = wrap(fns.subjectPrepPlanFn);

/* ---- live classroom doubt answering ---- */
export const answerDoubtFn = wrap(fns.answerDoubtFn);

/* ---- examination engine ---- */
export const createExamBatchFn = wrap(examFns.createExamBatchFn);
export const listBatchesFn = wrap(examFns.listBatchesFn);
export const getBatchFn = wrap(examFns.getBatchFn);
export const updateExamScheduleFn = wrap(examFns.updateExamScheduleFn);
export const confirmBatchFn = wrap(examFns.confirmBatchFn);
export const cancelBatchFn = wrap(examFns.cancelBatchFn);
export const openExamFn = wrap(examFns.openExamFn);
export const startExamAttemptFn = wrap(examFns.startExamAttemptFn);
export const saveProgressFn = wrap(examFns.saveProgressFn);
export const submitExamAttemptFn = wrap(examFns.submitExamAttemptFn);
export const reevaluateExamFn = wrap(examFns.reevaluateExamFn);
export const examResultFn = wrap(examFns.examResultFn);
export const combineResultsFn = wrap(examFns.combineResultsFn);
export const timetableDocumentFn = wrap(examFns.timetableDocumentFn);
export const questionPaperDocumentFn = wrap(examFns.questionPaperDocumentFn);
export const resultDocumentFn = wrap(examFns.resultDocumentFn);
