/**
 * lib/study/local-progress/practice.ts — Practice attempt & completion summary storage
 * ────────────────────────────────────────────────────────────────────────────────────
 * Persists ongoing Practice Mode progress (checked correctness booleans, selected
 * option IDs, position, filter) and latest completed Practice summaries.
 * Never persists answer keys or explanations in browser storage.
 */

import {
  MAX_ATTEMPT_QUESTIONS,
  MAX_OPTIONS_PER_QUESTION,
  STUDY_STORAGE_VERSION,
  clampInt,
  getDefaultStorage,
  getPracticeAttemptStorageKey,
  getPracticeSummaryStorageKey,
  isValidIso,
  normalizeId,
  safeReadJson,
  safeRemove,
  safeWriteJson,
  type StorageLike,
} from './storage'

export type StoredPracticeFilter = 'all' | 'incorrect' | 'bookmarked'

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

function sanitizeCheckedResults(raw: unknown): Record<string, boolean> {
  const checkedResults: Record<string, boolean> = {}
  if (!raw || typeof raw !== 'object') return checkedResults
  let count = 0
  for (const [rawId, val] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_ATTEMPT_QUESTIONS) break
    const qId = normalizeId(rawId)
    if (qId && typeof val === 'boolean') {
      checkedResults[qId] = val
      count += 1
    }
  }
  return checkedResults
}

function sanitizeSelections(raw: unknown): Record<string, string[]> {
  const selections: Record<string, string[]> = {}
  if (!raw || typeof raw !== 'object') return selections
  let count = 0
  for (const [rawId, opts] of Object.entries(raw as Record<string, unknown>)) {
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
  return selections
}

function sanitizeFilter(raw: unknown): StoredPracticeFilter {
  return raw === 'incorrect' || raw === 'bookmarked' ? raw : 'all'
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

  return {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    currentIndex: clampInt(record.currentIndex, 0, MAX_ATTEMPT_QUESTIONS, 0),
    filter: sanitizeFilter(record.filter),
    checkedResults: sanitizeCheckedResults(record.checkedResults),
    selections: sanitizeSelections(record.selections),
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

  const payload: StoredPracticeAttemptV1 = {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    currentIndex: clampInt(attempt.currentIndex, 0, MAX_ATTEMPT_QUESTIONS, 0),
    filter: sanitizeFilter(attempt.filter),
    checkedResults: sanitizeCheckedResults(attempt.checkedResults),
    selections: sanitizeSelections(attempt.selections),
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
  const completedCount = clampInt(
    record.completedCount,
    0,
    Math.max(totalQuestions, MAX_ATTEMPT_QUESTIONS),
    0
  )
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
