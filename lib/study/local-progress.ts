/**
 * lib/study/local-progress.ts — Versioned, user- and exam-scoped localStorage persistence
 * ──────────────────────────────────────────────────────────────────────────────────────
 * Public barrel re-exporting cohesive persistence modules under `lib/study/local-progress/`:
 *   - `storage.ts`           — shared storage primitives, bounds, and key builders
 *   - `legacy-bookmarks.ts`  — browser-local & legacy unscoped bookmark compatibility
 *   - `pending-bookmarks.ts` — user-scoped pending/failed bookmark sync operation recovery
 *   - `practice.ts`          — ongoing Practice attempts & latest completed summaries
 *   - `mock-exam.ts`         — latest & best server-graded Mock Exam summaries
 *   - `dashboard.ts`         — Study Dashboard local progress overview aggregation
 *
 * Security & privacy invariants:
 *   - Never persists auth secrets, session tokens, exam tokens, answer keys, or explanations.
 *   - Strictly scoped by `userId` and `examId`; legacy unscoped `study-bookmarks:*` keys are
 *     never silently adopted so another user's bookmarks are never assigned across accounts.
 *   - All data managed by these modules is device- and browser-specific (not cross-device).
 */

export {
  STUDY_STORAGE_VERSION,
  getBookmarksStorageKey,
  getPendingBookmarkOpsStorageKey,
  getPracticeAttemptStorageKey,
  getPracticeSummaryStorageKey,
  getExamSummaryStorageKey,
  type StorageLike,
} from './local-progress/storage'

export {
  readLegacyLocalBookmarksForImport,
  clearLegacyLocalBookmarks,
  hasLegacyBookmarks,
  readUserBookmarks,
  writeUserBookmarks,
  listAllBookmarkedQuestionIds,
  type StoredBookmarksV1,
} from './local-progress/legacy-bookmarks'

export {
  readPendingBookmarkOps,
  listPendingBookmarkExams,
  writePendingBookmarkOps,
  type PendingBookmarkOp,
  type StoredPendingBookmarkOpsV1,
  type PendingBookmarkExamEntry,
} from './local-progress/pending-bookmarks'

export {
  readPracticeAttempt,
  writePracticeAttempt,
  clearPracticeAttempt,
  readPracticeSummary,
  writePracticeSummary,
  type StoredPracticeFilter,
  type StoredPracticeAttemptV1,
  type StoredPracticeSummaryV1,
} from './local-progress/practice'

export {
  readMockExamSummary,
  recordMockExamResult,
  type StoredExamSummaryV1,
} from './local-progress/mock-exam'

export {
  computeDashboardOverview,
  type DashboardExamItem,
  type PracticeCollectionStatus,
  type MockExamCollectionStatus,
  type ExamDashboardMetrics,
  type DashboardOverviewMetrics,
} from './local-progress/dashboard'
