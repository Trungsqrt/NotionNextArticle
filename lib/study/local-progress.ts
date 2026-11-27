/**
 * lib/study/local-progress.ts — Versioned, user- and exam-scoped localStorage persistence
 * ──────────────────────────────────────────────────────────────────────────────────────
 * Persists lightweight study state per authenticated `userId` and `examId`:
 *   - Bookmarks (question IDs)
 *   - Ongoing Practice attempt (checked correctness flags, selected option IDs, index, filter)
 *   - Latest completed Practice summary
 *   - Latest & best server-graded Mock Exam summary
 *
 * Security & privacy invariants:
 *   - Never persists auth secrets, session tokens, exam tokens, answer keys, or explanations.
 *   - Strictly scoped by `userId` and `examId`; legacy unscoped `study-bookmarks:*` keys are
 *     never silently adopted so another user's bookmarks are never assigned across accounts.
 *   - Bounded sizes, schema versioning (`version: 1`), and graceful fallback on malformed or
 *     unavailable browser storage.
 *
 * Scope note:
 *   All data managed by this module is device- and browser-specific and is not synchronized
 *   across devices.
 */

import type { GradedExamResult } from './services/exam-service'

export const STUDY_STORAGE_VERSION = 1 as const
const MAX_BOOKMARKS_PER_EXAM = 500
const MAX_ATTEMPT_QUESTIONS = 500
const MAX_OPTIONS_PER_QUESTION = 20
const MAX_ID_LENGTH = 128

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length?: number
  key?(index: number): string | null
}

export type StoredPracticeFilter = 'all' | 'incorrect' | 'bookmarked'

export interface StoredBookmarksV1 {
  version: 1
  questionIds: string[]
  updatedAt: string
}

export interface PendingBookmarkOp {
  action: 'add' | 'remove'
  updatedAt: string
  /** Optional unique operation ID used to avoid clobbering newer pending ops across controller instances */
  opId?: string
}

export interface StoredPendingBookmarkOpsV1 {
  version: 1
  examId: string
  ops: Record<string, PendingBookmarkOp>
  updatedAt: string
}

export interface StoredPracticeAttemptV1 {
  version: 1
  examId: string
  currentIndex: number
  filter: StoredPracticeFilter
  /** Map of questionId -> isCorrect (never stores answer keys or explanations) */
  checkedResults: Record<string, boolean>
  /** Map of questionId -> selected option IDs */
  selections: Record<string, string[]>
  completed: boolean
  updatedAt: string
}

export interface StoredPracticeSummaryV1 {
  version: 1
  examId: string
  totalQuestions: number
  completedCount: number
  correctCount: number
  incorrectCount: number
  accuracyPercent: number
  completedAt: string
}

export interface StoredExamSummaryV1 {
  version: 1
  examId: string
  latestScorePercent: number
  latestPassed: boolean
  latestCorrectCount: number
  latestIncorrectCount: number
  latestSkippedCount: number
  latestTotalQuestions: number
  latestPassThresholdPercent: number
  latestSubmittedAt: string
  bestScorePercent: number
  bestPassed: boolean
  attemptsCount: number
}

export interface DashboardExamItem {
  examId: string
  title: string
  certificationCategory: string
  questionCount: number
}

export type PracticeCollectionStatus = 'not_started' | 'in_progress' | 'completed'
export type MockExamCollectionStatus = 'not_attempted' | 'passed' | 'not_passed'

export interface ExamDashboardMetrics {
  exam: DashboardExamItem
  practice: {
    status: PracticeCollectionStatus
    checkedCount: number
    totalQuestions: number
    progressPercent: number
    accuracyPercent: number | null
    hasOngoingAttempt: boolean
    hasCompletedSummary: boolean
    actionLabel: 'Start Practice' | 'Continue Practice' | 'Review Practice'
  }
  mockExam: {
    status: MockExamCollectionStatus
    latestScorePercent: number | null
    bestScorePercent: number | null
    latestPassed: boolean | null
    attemptsCount: number
  }
}

export interface DashboardOverviewMetrics {
  totalCollections: number
  completedPracticeCount: number
  completedMockExamCount: number
  latestPracticeAccuracy: number | null
  bestExamScore: number | null
  exams: ExamDashboardMetrics[]
}

function getDefaultStorage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike }
    return g.localStorage ?? null
  } catch {
    return null
  }
}

function normalizeId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return ''
  return trimmed
}

function buildKey(userId: string, kind: string, examId: string): string {
  return `study-v1:u:${encodeURIComponent(userId.trim())}:${kind}:${encodeURIComponent(examId.trim())}`
}

export function getBookmarksStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'bookmarks', examId)
}

export function getPendingBookmarkOpsStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'bookmark-pending', examId)
}

export function getPracticeAttemptStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'practice-attempt', examId)
}

export function getPracticeSummaryStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'practice-summary', examId)
}

export function getExamSummaryStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'exam-summary', examId)
}

function safeReadJson(key: string, storage: StorageLike | null): unknown {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function safeWriteJson(key: string, value: unknown, storage: StorageLike | null): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function safeRemove(key: string, storage: StorageLike | null): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Ignore storage removal errors
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number = min): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function isValidIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

// ── Bookmarks ────────────────────────────────────────────────────────────────

/**
 * Checks whether an unscoped legacy `study-bookmarks:<examId>` key exists.
 * Legacy bookmarks are intentionally never auto-imported to prevent cross-account leakage.
 */
/**
 * Reads any browser-local bookmarks (both unscoped legacy `study-bookmarks:<examId>`
 * and earlier local-only `study-v1:u:<userId>:bookmarks:<examId>`) so the UI can
 * present an explicit one-time import confirmation without ever silently adopting
 * another account's bookmarks.
 */
export function readLegacyLocalBookmarksForImport(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): string[] {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam || !storage) return []

  const seen = new Set<string>()
  const ids: string[] = []

  const pushId = (raw: unknown) => {
    if (ids.length >= MAX_BOOKMARKS_PER_EXAM) return
    const qId = normalizeId(raw)
    if (qId && !seen.has(qId)) {
      seen.add(qId)
      ids.push(qId)
    }
  }

  // 1. User-scoped browser-local v1 bookmarks
  const userScoped = readUserBookmarks(cleanUser, cleanExam, storage)
  for (const qId of Object.keys(userScoped)) {
    pushId(qId)
  }

  // 2. Unscoped legacy `study-bookmarks:<examId>` map
  try {
    const raw = storage.getItem(`study-bookmarks:${cleanExam}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        for (const [qId, enabled] of Object.entries(parsed as Record<string, unknown>)) {
          if (enabled) pushId(qId)
        }
      }
    }
  } catch {
    // Ignore malformed legacy storage
  }

  return ids
}

export function clearLegacyLocalBookmarks(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): void {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanExam || !storage) return
  if (cleanUser) {
    safeRemove(getBookmarksStorageKey(cleanUser, cleanExam), storage)
  }
  safeRemove(`study-bookmarks:${cleanExam}`, storage)
}

export function hasLegacyBookmarks(
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): boolean {
  const cleanExamId = normalizeId(examId)
  if (!cleanExamId || !storage) return false
  try {
    const raw = storage.getItem(`study-bookmarks:${cleanExamId}`)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    return Boolean(parsed && typeof parsed === 'object' && Object.values(parsed).some(Boolean))
  } catch {
    return false
  }
}

export function readUserBookmarks(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): Record<string, boolean> {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return {}

  const parsed = safeReadJson(getBookmarksStorageKey(cleanUser, cleanExam), storage)
  if (!parsed || typeof parsed !== 'object') return {}
  const record = parsed as Partial<StoredBookmarksV1>
  if (record.version !== STUDY_STORAGE_VERSION || !Array.isArray(record.questionIds)) {
    return {}
  }

  const map: Record<string, boolean> = {}
  let count = 0
  for (const rawId of record.questionIds) {
    if (count >= MAX_BOOKMARKS_PER_EXAM) break
    const qId = normalizeId(rawId)
    if (qId && !map[qId]) {
      map[qId] = true
      count += 1
    }
  }
  return map
}

export function writeUserBookmarks(
  userId: string,
  examId: string,
  bookmarks: Readonly<Record<string, boolean>>,
  storage: StorageLike | null = getDefaultStorage(),
  nowIso: string = new Date().toISOString()
): boolean {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return false

  const ids: string[] = []
  const seen = new Set<string>()
  for (const [rawId, enabled] of Object.entries(bookmarks)) {
    if (!enabled) continue
    if (ids.length >= MAX_BOOKMARKS_PER_EXAM) break
    const qId = normalizeId(rawId)
    if (qId && !seen.has(qId)) {
      seen.add(qId)
      ids.push(qId)
    }
  }

  const payload: StoredBookmarksV1 = {
    version: STUDY_STORAGE_VERSION,
    questionIds: ids,
    updatedAt: nowIso,
  }
  return safeWriteJson(getBookmarksStorageKey(cleanUser, cleanExam), payload, storage)
}

export function listAllBookmarkedQuestionIds(
  userId: string,
  examIds: readonly string[],
  storage: StorageLike | null = getDefaultStorage()
): string[] {
  const cleanUser = normalizeId(userId)
  if (!cleanUser) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const examId of examIds) {
    const map = readUserBookmarks(cleanUser, examId, storage)
    for (const qId of Object.keys(map)) {
      if (!seen.has(qId)) {
        seen.add(qId)
        result.push(qId)
      }
    }
  }
  return result
}

// ── Pending / Failed Bookmark Sync Operations (User-Scoped Recovery) ─────────

export function readPendingBookmarkOps(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): Record<string, PendingBookmarkOp> {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return {}

  const parsed = safeReadJson(getPendingBookmarkOpsStorageKey(cleanUser, cleanExam), storage)
  if (!parsed || typeof parsed !== 'object') return {}
  const record = parsed as Partial<StoredPendingBookmarkOpsV1>
  if (
    record.version !== STUDY_STORAGE_VERSION ||
    record.examId !== cleanExam ||
    !record.ops ||
    typeof record.ops !== 'object'
  ) {
    return {}
  }

  const result: Record<string, PendingBookmarkOp> = {}
  let count = 0
  for (const [rawId, rawOp] of Object.entries(record.ops)) {
    if (count >= MAX_BOOKMARKS_PER_EXAM) break
    const qId = normalizeId(rawId)
    if (!qId || !rawOp || typeof rawOp !== 'object') continue
    const op = rawOp as Partial<PendingBookmarkOp>
    if (op.action !== 'add' && op.action !== 'remove') continue
    const cleanOpId = normalizeId(op.opId)
    result[qId] = {
      action: op.action,
      updatedAt: isValidIso(op.updatedAt) ? op.updatedAt : new Date(0).toISOString(),
      ...(cleanOpId ? { opId: cleanOpId } : {}),
    }
    count += 1
  }
  return result
}

export interface PendingBookmarkExamEntry {
  examId: string
  ops: Record<string, PendingBookmarkOp>
}

const MAX_SCANNED_STORAGE_KEYS = 2000

/**
 * Discovers all exams with persisted pending bookmark operations for the
 * authenticated `userId`, independently of any loaded recall queue batch.
 * Strictly isolated to `userId`'s key prefix; never inspects other users' keys.
 */
export function listPendingBookmarkExams(
  userId: string,
  storage: StorageLike | null = getDefaultStorage(),
  options?: { examIdFilter?: string }
): PendingBookmarkExamEntry[] {
  const cleanUser = normalizeId(userId)
  if (!cleanUser || !storage) return []

  const cleanFilter = normalizeId(options?.examIdFilter)
  if (cleanFilter) {
    const ops = readPendingBookmarkOps(cleanUser, cleanFilter, storage)
    return Object.keys(ops).length > 0 ? [{ examId: cleanFilter, ops }] : []
  }

  if (typeof storage.length !== 'number' || typeof storage.key !== 'function') {
    return []
  }

  const prefix = `study-v1:u:${encodeURIComponent(cleanUser)}:bookmark-pending:`
  const results: PendingBookmarkExamEntry[] = []
  const seenExams = new Set<string>()

  let totalKeys = 0
  try {
    totalKeys = Math.min(Math.max(0, storage.length), MAX_SCANNED_STORAGE_KEYS)
  } catch {
    return []
  }

  for (let i = 0; i < totalKeys; i++) {
    let rawKey: string | null = null
    try {
      rawKey = storage.key(i)
    } catch {
      continue
    }
    if (!rawKey || !rawKey.startsWith(prefix)) continue

    const encodedExamId = rawKey.slice(prefix.length)
    if (!encodedExamId) continue

    let decodedExamId = ''
    try {
      decodedExamId = decodeURIComponent(encodedExamId)
    } catch {
      continue
    }

    const cleanExamId = normalizeId(decodedExamId)
    if (!cleanExamId || seenExams.has(cleanExamId)) continue
    seenExams.add(cleanExamId)

    const ops = readPendingBookmarkOps(cleanUser, cleanExamId, storage)
    if (Object.keys(ops).length > 0) {
      results.push({ examId: cleanExamId, ops })
    }
  }

  return results
}

export function writePendingBookmarkOps(
  userId: string,
  examId: string,
  ops: Readonly<Record<string, PendingBookmarkOp>>,
  storage: StorageLike | null = getDefaultStorage(),
  nowIso: string = new Date().toISOString()
): boolean {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return false

  const key = getPendingBookmarkOpsStorageKey(cleanUser, cleanExam)
  const sanitized: Record<string, PendingBookmarkOp> = {}
  let count = 0

  for (const [rawId, op] of Object.entries(ops)) {
    if (count >= MAX_BOOKMARKS_PER_EXAM) break
    const qId = normalizeId(rawId)
    if (!qId || (op.action !== 'add' && op.action !== 'remove')) continue
    const cleanOpId = normalizeId(op.opId)
    sanitized[qId] = {
      action: op.action,
      updatedAt: isValidIso(op.updatedAt) ? op.updatedAt : nowIso,
      ...(cleanOpId ? { opId: cleanOpId } : {}),
    }
    count += 1
  }

  if (count === 0) {
    safeRemove(key, storage)
    return true
  }

  const payload: StoredPendingBookmarkOpsV1 = {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    ops: sanitized,
    updatedAt: nowIso,
  }
  return safeWriteJson(key, payload, storage)
}

// ── Practice Attempt (Ongoing) ───────────────────────────────────────────────

export function readPracticeAttempt(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): StoredPracticeAttemptV1 | null {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return null

  const parsed = safeReadJson(getPracticeAttemptStorageKey(cleanUser, cleanExam), storage)
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Partial<StoredPracticeAttemptV1>
  if (record.version !== STUDY_STORAGE_VERSION || record.examId !== cleanExam) {
    return null
  }

  const checkedResults: Record<string, boolean> = {}
  if (record.checkedResults && typeof record.checkedResults === 'object') {
    let count = 0
    for (const [rawId, val] of Object.entries(record.checkedResults)) {
      if (count >= MAX_ATTEMPT_QUESTIONS) break
      const qId = normalizeId(rawId)
      if (qId && typeof val === 'boolean') {
        checkedResults[qId] = val
        count += 1
      }
    }
  }

  const selections: Record<string, string[]> = {}
  if (record.selections && typeof record.selections === 'object') {
    let count = 0
    for (const [rawId, opts] of Object.entries(record.selections)) {
      if (count >= MAX_ATTEMPT_QUESTIONS) break
      const qId = normalizeId(rawId)
      if (!qId || !Array.isArray(opts)) continue
      const cleanOpts: string[] = []
      const seen = new Set<string>()
      for (const opt of opts) {
        if (cleanOpts.length >= MAX_OPTIONS_PER_QUESTION) break
        const cleanOpt = normalizeId(opt)
        if (cleanOpt && !seen.has(cleanOpt)) {
          seen.add(cleanOpt)
          cleanOpts.push(cleanOpt)
        }
      }
      if (cleanOpts.length > 0) {
        selections[qId] = cleanOpts
        count += 1
      }
    }
  }

  const filter: StoredPracticeFilter =
    record.filter === 'incorrect' || record.filter === 'bookmarked' ? record.filter : 'all'

  return {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    currentIndex: clampInt(record.currentIndex, 0, MAX_ATTEMPT_QUESTIONS, 0),
    filter,
    checkedResults,
    selections,
    completed: Boolean(record.completed),
    updatedAt: isValidIso(record.updatedAt) ? record.updatedAt : new Date(0).toISOString(),
  }
}

export function writePracticeAttempt(
  userId: string,
  examId: string,
  attempt: Omit<StoredPracticeAttemptV1, 'version' | 'examId' | 'updatedAt'>,
  storage: StorageLike | null = getDefaultStorage(),
  nowIso: string = new Date().toISOString()
): boolean {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return false

  const checkedResults: Record<string, boolean> = {}
  let checkedCount = 0
  for (const [rawId, isCorrect] of Object.entries(attempt.checkedResults)) {
    if (checkedCount >= MAX_ATTEMPT_QUESTIONS) break
    const qId = normalizeId(rawId)
    if (qId && typeof isCorrect === 'boolean') {
      checkedResults[qId] = isCorrect
      checkedCount += 1
    }
  }

  const selections: Record<string, string[]> = {}
  let selectionCount = 0
  for (const [rawId, opts] of Object.entries(attempt.selections)) {
    if (selectionCount >= MAX_ATTEMPT_QUESTIONS) break
    const qId = normalizeId(rawId)
    if (!qId || !Array.isArray(opts) || opts.length === 0) continue
    const cleanOpts = opts
      .map((o) => normalizeId(o))
      .filter(Boolean)
      .slice(0, MAX_OPTIONS_PER_QUESTION)
    if (cleanOpts.length > 0) {
      selections[qId] = [...new Set(cleanOpts)]
      selectionCount += 1
    }
  }

  const payload: StoredPracticeAttemptV1 = {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    currentIndex: clampInt(attempt.currentIndex, 0, MAX_ATTEMPT_QUESTIONS, 0),
    filter:
      attempt.filter === 'incorrect' || attempt.filter === 'bookmarked'
        ? attempt.filter
        : 'all',
    checkedResults,
    selections,
    completed: Boolean(attempt.completed),
    updatedAt: nowIso,
  }

  return safeWriteJson(getPracticeAttemptStorageKey(cleanUser, cleanExam), payload, storage)
}

export function clearPracticeAttempt(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): void {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return
  safeRemove(getPracticeAttemptStorageKey(cleanUser, cleanExam), storage)
}

// ── Latest Completed Practice Summary ────────────────────────────────────────

export function readPracticeSummary(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): StoredPracticeSummaryV1 | null {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return null

  const parsed = safeReadJson(getPracticeSummaryStorageKey(cleanUser, cleanExam), storage)
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Partial<StoredPracticeSummaryV1>
  if (record.version !== STUDY_STORAGE_VERSION || record.examId !== cleanExam) {
    return null
  }
  if (!isValidIso(record.completedAt)) return null

  const totalQuestions = clampInt(record.totalQuestions, 0, MAX_ATTEMPT_QUESTIONS, 0)
  const completedCount = clampInt(record.completedCount, 0, Math.max(totalQuestions, MAX_ATTEMPT_QUESTIONS), 0)
  const correctCount = clampInt(record.correctCount, 0, completedCount, 0)
  const incorrectCount = clampInt(record.incorrectCount, 0, completedCount, 0)
  const accuracyPercent = clampInt(record.accuracyPercent, 0, 100, 0)

  return {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    totalQuestions,
    completedCount,
    correctCount,
    incorrectCount,
    accuracyPercent,
    completedAt: record.completedAt,
  }
}

export function writePracticeSummary(
  userId: string,
  examId: string,
  summary: Omit<StoredPracticeSummaryV1, 'version' | 'examId' | 'completedAt'>,
  storage: StorageLike | null = getDefaultStorage(),
  completedAt: string = new Date().toISOString()
): boolean {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return false

  const payload: StoredPracticeSummaryV1 = {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    totalQuestions: clampInt(summary.totalQuestions, 0, MAX_ATTEMPT_QUESTIONS, 0),
    completedCount: clampInt(summary.completedCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    correctCount: clampInt(summary.correctCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    incorrectCount: clampInt(summary.incorrectCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    accuracyPercent: clampInt(summary.accuracyPercent, 0, 100, 0),
    completedAt,
  }

  return safeWriteJson(getPracticeSummaryStorageKey(cleanUser, cleanExam), payload, storage)
}

// ── Mock Exam Progress Summary (Server-Graded Results Only) ──────────────────

export function readMockExamSummary(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): StoredExamSummaryV1 | null {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return null

  const parsed = safeReadJson(getExamSummaryStorageKey(cleanUser, cleanExam), storage)
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Partial<StoredExamSummaryV1>
  if (record.version !== STUDY_STORAGE_VERSION || record.examId !== cleanExam) {
    return null
  }
  if (!isValidIso(record.latestSubmittedAt)) return null

  return {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    latestScorePercent: clampInt(record.latestScorePercent, 0, 100, 0),
    latestPassed: Boolean(record.latestPassed),
    latestCorrectCount: clampInt(record.latestCorrectCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    latestIncorrectCount: clampInt(record.latestIncorrectCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    latestSkippedCount: clampInt(record.latestSkippedCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    latestTotalQuestions: clampInt(record.latestTotalQuestions, 0, MAX_ATTEMPT_QUESTIONS, 0),
    latestPassThresholdPercent: clampInt(record.latestPassThresholdPercent, 0, 100, 70),
    latestSubmittedAt: record.latestSubmittedAt,
    bestScorePercent: clampInt(record.bestScorePercent, 0, 100, 0),
    bestPassed: Boolean(record.bestPassed),
    attemptsCount: clampInt(record.attemptsCount, 1, 100_000, 1),
  }
}

export function recordMockExamResult(
  userId: string,
  examId: string,
  graded: Pick<
    GradedExamResult,
    | 'scorePercent'
    | 'passed'
    | 'correctCount'
    | 'incorrectCount'
    | 'skippedCount'
    | 'totalQuestions'
    | 'passThresholdPercent'
  >,
  storage: StorageLike | null = getDefaultStorage(),
  submittedAt: string = new Date().toISOString()
): StoredExamSummaryV1 | null {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return null

  const prev = readMockExamSummary(cleanUser, cleanExam, storage)
  const latestScore = clampInt(graded.scorePercent, 0, 100, 0)
  const bestScore = prev ? Math.max(prev.bestScorePercent, latestScore) : latestScore

  const next: StoredExamSummaryV1 = {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    latestScorePercent: latestScore,
    latestPassed: Boolean(graded.passed),
    latestCorrectCount: clampInt(graded.correctCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    latestIncorrectCount: clampInt(graded.incorrectCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    latestSkippedCount: clampInt(graded.skippedCount, 0, MAX_ATTEMPT_QUESTIONS, 0),
    latestTotalQuestions: clampInt(graded.totalQuestions, 0, MAX_ATTEMPT_QUESTIONS, 0),
    latestPassThresholdPercent: clampInt(graded.passThresholdPercent, 0, 100, 70),
    latestSubmittedAt: submittedAt,
    bestScorePercent: bestScore,
    bestPassed: Boolean(prev?.bestPassed || graded.passed),
    attemptsCount: (prev?.attemptsCount ?? 0) + 1,
  }

  safeWriteJson(getExamSummaryStorageKey(cleanUser, cleanExam), next, storage)
  return next
}

// ── Dashboard Aggregation (Practice + Mock Exam Progress) ────────────────────

export function computeDashboardOverview(
  userId: string,
  exams: readonly DashboardExamItem[],
  storage: StorageLike | null = getDefaultStorage()
): DashboardOverviewMetrics {
  let completedPracticeCount = 0
  let completedMockExamCount = 0
  let latestPracticeAccuracy: number | null = null
  let latestPracticeTimestampMs = -1
  let bestExamScore: number | null = null

  const examMetrics: ExamDashboardMetrics[] = exams.map((exam) => {
    const attempt = readPracticeAttempt(userId, exam.examId, storage)
    const completedSummary = readPracticeSummary(userId, exam.examId, storage)
    const examSummary = readMockExamSummary(userId, exam.examId, storage)

    const totalQuestions = exam.questionCount

    // Derive Practice status: ongoing attempt takes precedence when actively in progress,
    // while completed summaries preserve Completed status even after Restart Practice
    // clears an active attempt without starting a new one.
    const attemptCheckedEntries = attempt ? Object.entries(attempt.checkedResults) : []
    const attemptCheckedCount = attemptCheckedEntries.length
    const attemptCorrectCount = attemptCheckedEntries.filter(([, ok]) => ok).length
    const attemptAllGraded =
      totalQuestions > 0 && attemptCheckedCount >= totalQuestions

    let practiceStatus: PracticeCollectionStatus = 'not_started'
    let checkedCount = 0
    let accuracyPercent: number | null = null
    let actionLabel: 'Start Practice' | 'Continue Practice' | 'Review Practice' = 'Start Practice'

    if (attempt && attemptCheckedCount > 0 && !attemptAllGraded) {
      practiceStatus = 'in_progress'
      checkedCount = Math.min(attemptCheckedCount, totalQuestions || attemptCheckedCount)
      accuracyPercent = Math.round((attemptCorrectCount / attemptCheckedCount) * 100)
      actionLabel = 'Continue Practice'
    } else if (attempt && attemptAllGraded) {
      practiceStatus = 'completed'
      checkedCount = totalQuestions
      accuracyPercent = Math.round((attemptCorrectCount / attemptCheckedCount) * 100)
      actionLabel = 'Review Practice'
    } else if (completedSummary) {
      practiceStatus = 'completed'
      checkedCount = totalQuestions > 0 ? totalQuestions : completedSummary.completedCount
      accuracyPercent = completedSummary.accuracyPercent
      actionLabel = 'Review Practice'
    }

    if (practiceStatus === 'completed' || completedSummary) {
      completedPracticeCount += 1
    }

    // Track latest Practice accuracy across completed summaries or latest active graded attempt
    if (completedSummary) {
      const ts = Date.parse(completedSummary.completedAt)
      if (!Number.isNaN(ts) && ts >= latestPracticeTimestampMs) {
        latestPracticeTimestampMs = ts
        latestPracticeAccuracy = completedSummary.accuracyPercent
      }
    }
    if (attempt && attemptCheckedCount > 0) {
      const ts = Date.parse(attempt.updatedAt)
      const attemptAcc = Math.round((attemptCorrectCount / attemptCheckedCount) * 100)
      if (!Number.isNaN(ts) && ts > latestPracticeTimestampMs) {
        latestPracticeTimestampMs = ts
        latestPracticeAccuracy = attemptAcc
      }
    }

    const progressPercent =
      totalQuestions > 0 ? Math.min(100, Math.round((checkedCount / totalQuestions) * 100)) : 0

    // Derive Mock Exam metrics from actual server-graded summary
    let mockExamStatus: MockExamCollectionStatus = 'not_attempted'
    if (examSummary) {
      completedMockExamCount += 1
      mockExamStatus = examSummary.latestPassed ? 'passed' : 'not_passed'
      if (bestExamScore === null || examSummary.bestScorePercent > bestExamScore) {
        bestExamScore = examSummary.bestScorePercent
      }
    }

    return {
      exam,
      practice: {
        status: practiceStatus,
        checkedCount,
        totalQuestions,
        progressPercent,
        accuracyPercent,
        hasOngoingAttempt: Boolean(attempt && attemptCheckedCount > 0 && !attemptAllGraded),
        hasCompletedSummary: Boolean(completedSummary),
        actionLabel,
      },
      mockExam: {
        status: mockExamStatus,
        latestScorePercent: examSummary ? examSummary.latestScorePercent : null,
        bestScorePercent: examSummary ? examSummary.bestScorePercent : null,
        latestPassed: examSummary ? examSummary.latestPassed : null,
        attemptsCount: examSummary ? examSummary.attemptsCount : 0,
      },
    }
  })

  return {
    totalCollections: exams.length,
    completedPracticeCount,
    completedMockExamCount,
    latestPracticeAccuracy,
    bestExamScore,
    exams: examMetrics,
  }
}
