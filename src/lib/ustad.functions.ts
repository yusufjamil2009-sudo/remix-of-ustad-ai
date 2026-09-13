import { createServerFn } from "@tanstack/react-start";
import * as data from "./data.server";
import * as apiManager from "./api-manager.server";
import * as chat from "./chat.server";
import * as study from "./study.server";
import * as voice from "./voice.server";
import * as curriculum from "./curriculum.server";
import * as diagram from "./diagram.server";
import * as diagramImage from "./diagram-image.server";
import * as bookKnowledge from "./book-knowledge.server";
import * as chapterMaster from "./chapter-master.server";
import * as chapterLesson from "./chapter-lesson.server";
import * as questionEngine from "./question-engine.server";
import * as doubt from "./doubt.server";
import * as gallery from "./gallery.server";
import type { Language } from "./router.server";

type Tbl = "memories" | "goals" | "notes" | "reminders" | "lessons" | "exams" | "exam_results";

export const bootstrapFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token?: string }) => d)
  .handler(async ({ data: d }) => data.bootstrapGuest(d.token));

export const listConversationsFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => data.listConversations(d.token));

export const createConversationFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; title?: string }) => d)
  .handler(async ({ data: d }) => data.createConversation(d.token, d.title));

export const updateConversationFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; id: string; title?: string; pinned?: boolean }) => d)
  .handler(async ({ data: d }) =>
    data.updateConversation(d.token, d.id, {
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.pinned !== undefined ? { pinned: d.pinned } : {}),
    }),
  );

export const deleteConversationFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; id: string }) => d)
  .handler(async ({ data: d }) => data.deleteConversation(d.token, d.id));

export const listMessagesFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; conversationId: string }) => d)
  .handler(async ({ data: d }) => data.listMessages(d.token, d.conversationId));

export const saveProfileFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; patch: Record<string, unknown> }) => d)
  .handler(async ({ data: d }) => data.saveProfile(d.token, d.patch));

export const saveSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; patch: Record<string, unknown> }) => d)
  .handler(async ({ data: d }) => data.saveSettings(d.token, d.patch));

export const listRowsFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; table: Tbl }) => d)
  .handler(async ({ data: d }) =>
    data.listRows(d.token, d.table, d.table === "reminders" ? "due_at" : "created_at"),
  );

export const insertRowFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; table: Tbl; values: Record<string, unknown> }) => d)
  .handler(async ({ data: d }) => data.insertRow(d.token, d.table, d.values));

export const updateRowFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { token: string; table: Tbl; id: string; patch: Record<string, unknown> }) => d,
  )
  .handler(async ({ data: d }) => data.updateRow(d.token, d.table, d.id, d.patch));

export const deleteRowFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; table: Tbl; id: string }) => d)
  .handler(async ({ data: d }) => data.deleteRow(d.token, d.table, d.id));

export const uploadAttachmentFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { token: string; file: { name: string; mime: string; size: number; dataUrl: string } }) =>
      d,
  )
  .handler(async ({ data: d }) => data.saveAttachment(d.token, d.file));

export const beginDirectUploadFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; file: { name: string; mime: string; size: number } }) => d)
  .handler(async ({ data: d }) => data.beginDirectUpload(d.token, d.file));

export const finalizeDirectUploadFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; id: string }) => d)
  .handler(async ({ data: d }) => data.finalizeDirectUpload(d.token, d.id));

export const clearCacheFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => data.clearCache(d.token));

export const clearDataFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; scopes: string[] }) => d)
  .handler(async ({ data: d }) => data.clearData(d.token, d.scopes));

/* ---- USTAD Gallery (owner ops — guest token required) ---- */

export const galleryListFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => gallery.listGallery(d.token));

export const galleryUploadFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      file: {
        name: string;
        mime: string;
        size: number;
        width?: number;
        height?: number;
        optimized?: boolean;
        dataUrl: string;
      };
    }) => d,
  )
  .handler(async ({ data: d }) => gallery.uploadGalleryImage(d.token, d.file));

export const galleryDeleteFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; ids: string[] }) => d)
  .handler(async ({ data: d }) => gallery.deleteGalleryImages(d.token, d.ids));

export const galleryCreateShareFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; imageIds?: string[] }) => d)
  .handler(async ({ data: d }) => gallery.createGalleryShare(d.token, d.imageIds));

export const galleryListSharesFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => gallery.listGalleryShares(d.token));

/* ---- USTAD Gallery (PUBLIC share access — share token is the key) ---- */

export const galleryPublicFn = createServerFn({ method: "POST" })
  .inputValidator((d: { shareToken: string }) => d)
  .handler(async ({ data: d }) => gallery.getPublicGallery(d.shareToken));

/* ---- API manager ---- */

export const listApiConfigsFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => apiManager.listConfigs(d.token));

export const saveApiConfigFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; provider: string; config: Record<string, string> }) => d)
  .handler(async ({ data: d }) => apiManager.saveConfig(d.token, d.provider, d.config));

export const testApiConfigFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; provider: string }) => d)
  .handler(async ({ data: d }) => apiManager.testConfig(d.token, d.provider));

export const deleteApiConfigFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; provider: string }) => d)
  .handler(async ({ data: d }) => apiManager.deleteConfig(d.token, d.provider));

/* ---- chat ---- */

export const sendMessageFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      conversationId?: string;
      text: string;
      attachmentIds?: string[];
      clientNow?: string;
      timeZone?: string;
      plan?: boolean;
      deviceText?: string;
      deviceEngine?: string;
    }) => d,
  )
  .handler(async ({ data: d }) =>
    chat.sendMessage({
      token: d.token,
      conversationId: d.conversationId,
      text: d.text,
      attachmentIds: d.attachmentIds,
      clientNow: d.clientNow,
      timeZone: d.timeZone,
      plan: d.plan,
      deviceText: d.deviceText,
      deviceEngine: d.deviceEngine,
    }),
  );


export const getProfileFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => data.getProfile(d.token));

/* ---- study ---- */

export const generateExamFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      topic: string;
      mcq: number;
      truefalse: number;
      written: number;
      difficulty: string;
      language: Language;
      durationMinutes: number;
      negativeMarking: number;
    }) => d,
  )
  .handler(async ({ data: d }) => study.generateExam(d));

export const startStudyExamFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; examId: string }) => d)
  .handler(async ({ data: d }) => study.startStudyExam(d.token, d.examId));

export const submitExamFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      examId: string;
      answers: Record<string, string>;
      timeTakenSeconds: number;
    }) => d,
  )
  .handler(async ({ data: d }) => study.submitExam(d));

export const generateLessonFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; topic: string; level: string; language: Language }) => d)
  .handler(async ({ data: d }) => study.generateLesson(d));

export const processDocumentFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { token: string; attachmentId: string; chapterNumber?: number; language?: Language }) => d,
  )
  .handler(async ({ data: d }) => {
    const { processUploadedDocument } = await import("./teaching/document.server");
    return processUploadedDocument(d.token, d.attachmentId, {
      ...(d.chapterNumber != null ? { chapterNumber: d.chapterNumber } : {}),
      ...(d.language ? { language: d.language } : {}),
    });
  });

export const generateNotesFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; source: string; title?: string; language: Language }) => d)
  .handler(async ({ data: d }) => study.generateNotes(d));

/* ---- voice ---- */

export const synthesizeFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; provider?: string; language?: string }) => d)
  .handler(async ({ data: d }) => voice.synthesize(d));

export const transcribeFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; base64: string; mime: string; provider?: string }) => d)
  .handler(async ({ data: d }) => voice.transcribe(d));

export const voiceProvidersFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => voice.availableVoiceProviders(d.token));

/* ---- curriculum brain (Part 1) ---- */

export const getCurriculumPrefsFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) => d)
  .handler(async ({ data: d }) => curriculum.getCurriculumPrefs(d.token));

export const saveCurriculumPrefFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; board?: string; klass?: number; subject?: string }) => d)
  .handler(async ({ data: d }) =>
    curriculum.saveCurriculumPref(d.token, {
      ...(d.board !== undefined ? { board: d.board } : {}),
      ...(d.klass !== undefined ? { klass: d.klass } : {}),
      ...(d.subject !== undefined ? { subject: d.subject } : {}),
    }),
  );

export const resolveCurriculumFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; allowFetch?: boolean }) => d)
  .handler(async ({ data: d }) =>
    curriculum.resolveCurriculumForUser(d.token, d.text, {
      ...(d.allowFetch !== undefined ? { allowFetch: d.allowFetch } : {}),
    }),
  );

export const refreshCurriculumFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string }) => d)
  .handler(async ({ data: d }) => curriculum.refreshCurriculum(d.token, d.text));

/* ---- diagram + handwritten notes (part: universal diagram master) ---- */

export const diagramSpecFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      question: string;
      answer: string;
      language: Language;
      allowProvider?: boolean;
      allowImage?: boolean;
    }) => d,
  )
  .handler(async ({ data: d }) =>
    diagram.generateDiagramSpec(d.token, d.question, d.answer, d.language, {
      ...(d.allowProvider !== undefined ? { allowProvider: d.allowProvider } : {}),
      ...(d.allowImage !== undefined ? { allowImage: d.allowImage } : {}),
    }),
  );

export const diagramImageFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; question: string; answer: string; language: Language }) => d)
  .handler(async ({ data: d }) =>
    diagramImage.generateDiagramImage(d.token, d.question, d.answer, d.language),
  );

/* ---- book + chapter knowledge (Part 2) ---- */

export const extractChapterFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; chapterNumber: number }) => d)
  .handler(async ({ data: d }) =>
    bookKnowledge.extractChapterForUser(d.token, d.text, d.chapterNumber),
  );

export const chapterContextFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; chapterNumber: number; query?: string }) => d)
  .handler(async ({ data: d }) =>
    bookKnowledge.getChapterContextPack(d.token, d.text, d.chapterNumber, d.query),
  );

export const searchBookFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; query: string }) => d)
  .handler(async ({ data: d }) => bookKnowledge.searchBookKnowledge(d.token, d.text, d.query));

/* ---- chapter master + plan (Part 3) ---- */

export const chapterMasterFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      text: string;
      chapterNumber: number;
      level?: "beginner" | "intermediate" | "advanced";
    }) => d,
  )
  .handler(async ({ data: d }) =>
    chapterMaster.getChapterMaster(d.token, d.text, d.chapterNumber, d.level ?? "intermediate"),
  );

export const isChapterExtractedFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; chapterNumber: number }) => d)
  .handler(async ({ data: d }) =>
    chapterMaster.isChapterExtracted(d.token, d.text, d.chapterNumber),
  );

/* ---- progress (reuses existing memory) ---- */
export const getChapterProgressFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; chapterId: string; chapterName: string }) => d)
  .handler(async ({ data: d }) => {
    const { getChapterProgress } = await import("./book-knowledge/progress");
    return getChapterProgress(d.token, d.chapterId, d.chapterName);
  });

export const recordChapterProgressFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      chapterId: string;
      chapterName: string;
      event:
        | "chapter_started"
        | "topic_completed"
        | "concept_understood"
        | "diagram_viewed"
        | "question_attempted"
        | "question_correct"
        | "question_wrong"
        | "doubt_created"
        | "revision_required"
        | "lesson_completed";
      detail?: string;
    }) => d,
  )
  .handler(async ({ data: d }) => {
    const { recordProgress } = await import("./book-knowledge/progress");
    return recordProgress(d.token, d.chapterId, d.chapterName, d.event, d.detail);
  });

/* ---- deep chapter teaching + multi-day lesson master (Part 4) ---- */

export const chapterLessonMasterFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      text: string;
      chapterNumber: number;
      level?: "beginner" | "intermediate" | "advanced";
    }) => d,
  )
  .handler(async ({ data: d }) =>
    chapterLesson.getChaperLessonMaster(
      d.token,
      d.text,
      d.chapterNumber,
      d.level ?? "intermediate",
    ),
  );

export const lessonSessionFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { token: string; text: string; chapterNumber: number; sessionNumber: number }) => d,
  )
  .handler(async ({ data: d }) =>
    chapterLesson.getLessonSession(d.token, d.text, d.chapterNumber, d.sessionNumber),
  );

export const lessonRevisionFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; chapterNumber: number }) => d)
  .handler(async ({ data: d }) =>
    chapterLesson.getLessonRevision(d.token, d.text, d.chapterNumber),
  );

export const lessonTestFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      text: string;
      chapterNumber: number;
      difficulty?: "easy" | "medium" | "hard";
    }) => d,
  )
  .handler(async ({ data: d }) =>
    chapterLesson.getLessonTest(d.token, d.text, d.chapterNumber, d.difficulty ?? "medium"),
  );

export const scoreChapterTestFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      test: import("./book-knowledge/test").ChapterTest;
      answers: Array<{ id: string; given: string; correct: boolean }>;
    }) => d,
  )
  .handler(async ({ data: d }) => chapterLesson.scoreChapterTest(d.token, d.test, d.answers));

export const lessonContinuationFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; chapterNumber: number }) => d)
  .handler(async ({ data: d }) => chapterLesson.getContinuation(d.token, d.text, d.chapterNumber));

export const markChapterCompletedFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; chapterNumber: number }) => d)
  .handler(async ({ data: d }) =>
    chapterLesson.markChapterCompleted(d.token, d.text, d.chapterNumber),
  );

/* ---- question intelligence + adaptive revision + exam prep (Part 5) ---- */

export const chapterQuestionIntelligenceFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; chapterNumber: number }) => d)
  .handler(async ({ data: d }) =>
    questionEngine.getChapterQuestionIntelligence(d.token, d.text, d.chapterNumber),
  );

export const adaptiveRevisionFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { token: string; text: string; chapterNumber: number; mode?: "quick" | "deep" }) => d,
  )
  .handler(async ({ data: d }) =>
    questionEngine.getAdaptiveRevision(d.token, d.text, d.chapterNumber, d.mode ?? "quick"),
  );

export const gradeAndExplainFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      text: string;
      chapterNumber: number;
      concept: string;
      correct: boolean;
      mistake?: string;
    }) => d,
  )
  .handler(async ({ data: d }) =>
    questionEngine.gradeAndExplain(
      d.token,
      d.text,
      d.chapterNumber,
      d.concept,
      d.correct,
      d.mistake,
    ),
  );

export const examChapterTestFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      text: string;
      chapterNumber: number;
      difficulty?: "easy" | "medium" | "hard";
    }) => d,
  )
  .handler(async ({ data: d }) =>
    questionEngine.getExamChapterTest(d.token, d.text, d.chapterNumber, d.difficulty ?? "medium"),
  );

export const evaluateExamChapterTestFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      token: string;
      test: import("./book-knowledge/test").ChapterTest;
      answers: Array<{ id: string; given: string; correct: boolean }>;
    }) => d,
  )
  .handler(async ({ data: d }) =>
    questionEngine.evaluateExamChapterTest(d.token, d.test, d.answers),
  );

export const subjectPrepPlanFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; text: string; days?: number }) => d)
  .handler(async ({ data: d }) => questionEngine.getSubjectPrepPlan(d.token, d.text, d.days ?? 7));

/* ---- live doubt answering (classroom) ---- */

export const answerDoubtFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { token: string; question: string; context: import("./doubt.server").DoubtContext }) => d,
  )
  .handler(async ({ data: d }) => doubt.answerDoubt(d.token, d.question, d.context));
