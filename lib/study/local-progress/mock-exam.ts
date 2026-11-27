/**
 * lib/study/local-progress/mock-exam.ts — Server-graded Mock Exam summary storage
 * ───────────────────────────────────────────────────────────────────────────────
 * Persists latest and best server-graded Mock Exam scores per `(userId, examId)`.
 * Never stores exam tokens, answer keys, or explanations.
 */

import type { GradedExamResult } from '../services/exam-service'
import {
  MAX_ATTEMPT_QUESTIONS,
  STUDY_STORAGE_VERSION,
  clampInt,
  getDefaultStorage,
  getExamSummaryStorageKey,
  isValidIso,
  normalizeId,
  safeReadJson,
  safeWriteJson,
  type StorageLike,
} from './storage'

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
