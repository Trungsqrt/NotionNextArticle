/**
 * lib/study/cache/content-cache.ts — Bounded server-side TTL cache for published Study content
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * Caches ONLY published `ExamCollection` and `StudyQuestion` records in server memory
 * (isolated from public `globalThis.__notionCache`).
 *
 * Security & privacy invariants:
 * - Strictly server-only (throws if imported in browser).
 * - NEVER caches `StudyUser`, `FsrsCardState`, or `ReviewEvent` records.
 * - NEVER caches `draft` or `retired` questions/exams.
 * - Callers MUST still sanitize prompts via `toQuestionPrompt()` before sending
 *   Practice, Recall, or Exam payloads to the browser.
 *
 * Invalidation model:
 * - Bounded TTL (default 5 minutes; configurable via STUDY_CONTENT_CACHE_TTL_MS, 10s–30m).
 * - Immediate write-through invalidation on `QuestionBankRepository.upsert()` and
 *   `ExamCollectionRepository.upsert()` within the same server instance.
 * - Bounded LRU eviction (`MAX_CACHED_QUESTIONS = 1000`, `MAX_CACHED_EXAMS = 50`).
 * - Across multiple Vercel serverless instances, updates propagate within TTL or on cold start.
 */

import type { ExamCollection, StudyQuestion } from '../types'

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MIN_TTL_MS = 10 * 1000 // 10 seconds
const MAX_TTL_MS = 30 * 60 * 1000 // 30 minutes
const MAX_CACHED_QUESTIONS = 1000
const MAX_CACHED_EXAMS = 50
const MAX_CACHED_EXAM_QUESTION_LISTS = 50

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

interface StudyContentCacheStore {
  questionsById: Map<string, CacheEntry<StudyQuestion>>
  publishedQuestionsByExam: Map<string, CacheEntry<StudyQuestion[]>>
  examsById: Map<string, CacheEntry<ExamCollection>>
  publishedExamsList: CacheEntry<ExamCollection[]> | null
}

function assertServerOnly(): void {
  if ('window' in globalThis) {
    throw new Error('lib/study/cache/content-cache is server-only and cannot run in the browser')
  }
}

export function getStudyContentCacheTtlMs(): number {
  const raw = process.env.STUDY_CONTENT_CACHE_TTL_MS
  if (!raw) return DEFAULT_TTL_MS
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_MS
  return Math.min(Math.max(parsed, MIN_TTL_MS), MAX_TTL_MS)
}

function getStore(): StudyContentCacheStore {
  assertServerOnly()
  const g = globalThis as unknown as { __studyContentCache?: StudyContentCacheStore }
  if (!g.__studyContentCache) {
    g.__studyContentCache = {
      questionsById: new Map(),
      publishedQuestionsByExam: new Map(),
      examsById: new Map(),
      publishedExamsList: null,
    }
  }
  return g.__studyContentCache
}

function setBounded<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  maxSize: number,
  ttlMs: number,
  now: number
): void {
  if (map.has(key)) {
    map.delete(key)
  } else if (map.size >= maxSize) {
    // Evict oldest entry (Map preserves insertion order)
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) {
      map.delete(oldestKey)
    }
  }
  map.set(key, { value, expiresAt: now + ttlMs })
}

function getValid<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  now: number
): T | null {
  const entry = map.get(key)
  if (!entry) return null
  if (now >= entry.expiresAt) {
    map.delete(key)
    return null
  }
  // Touch for LRU recency
  map.delete(key)
  map.set(key, entry)
  return entry.value
}

// ── Published Question cache ────────────────────────────────────────────────

export function getCachedPublishedQuestion(
  questionId: string,
  now: number = Date.now()
): StudyQuestion | null {
  const key = questionId.trim()
  if (!key) return null
  return getValid(getStore().questionsById, key, now)
}

export function setCachedPublishedQuestion(
  question: StudyQuestion,
  now: number = Date.now()
): void {
  if (question.status !== 'published') return
  const ttlMs = getStudyContentCacheTtlMs()
  setBounded(getStore().questionsById, question.questionId.trim(), question, MAX_CACHED_QUESTIONS, ttlMs, now)
}

export function getCachedPublishedQuestionsByExam(
  examId: string,
  now: number = Date.now()
): StudyQuestion[] | null {
  const key = examId.trim()
  if (!key) return null
  return getValid(getStore().publishedQuestionsByExam, key, now)
}

export function setCachedPublishedQuestionsByExam(
  examId: string,
  questions: StudyQuestion[],
  now: number = Date.now()
): void {
  const key = examId.trim()
  if (!key) return
  const publishedOnly = questions.filter((q) => q.status === 'published')
  const ttlMs = getStudyContentCacheTtlMs()
  const store = getStore()
  setBounded(
    store.publishedQuestionsByExam,
    key,
    publishedOnly,
    MAX_CACHED_EXAM_QUESTION_LISTS,
    ttlMs,
    now
  )
  // Warm individual questionById entries so Check Answer & Reveal Answer hit memory in <1ms
  for (const q of publishedOnly) {
    setBounded(store.questionsById, q.questionId.trim(), q, MAX_CACHED_QUESTIONS, ttlMs, now)
  }
}

export function invalidateCachedQuestion(questionId: string, examId?: string): void {
  const store = getStore()
  const cleanId = questionId.trim()
  const existing = store.questionsById.get(cleanId)?.value
  store.questionsById.delete(cleanId)
  const targetExamId = examId?.trim() || existing?.examId
  if (targetExamId) {
    store.publishedQuestionsByExam.delete(targetExamId)
  }
}

// ── Published Exam cache ────────────────────────────────────────────────────

export function getCachedPublishedExam(
  examId: string,
  now: number = Date.now()
): ExamCollection | null {
  const key = examId.trim()
  if (!key) return null
  return getValid(getStore().examsById, key, now)
}

export function setCachedPublishedExam(
  exam: ExamCollection,
  now: number = Date.now()
): void {
  if (exam.status !== 'published') return
  const ttlMs = getStudyContentCacheTtlMs()
  setBounded(getStore().examsById, exam.examId.trim(), exam, MAX_CACHED_EXAMS, ttlMs, now)
}

export function getCachedPublishedExamsList(
  now: number = Date.now()
): ExamCollection[] | null {
  const store = getStore()
  const entry = store.publishedExamsList
  if (!entry) return null
  if (now >= entry.expiresAt) {
    store.publishedExamsList = null
    return null
  }
  return entry.value
}

export function setCachedPublishedExamsList(
  exams: ExamCollection[],
  now: number = Date.now()
): void {
  const publishedOnly = exams.filter((e) => e.status === 'published')
  const ttlMs = getStudyContentCacheTtlMs()
  const store = getStore()
  store.publishedExamsList = {
    value: publishedOnly,
    expiresAt: now + ttlMs,
  }
  for (const exam of publishedOnly) {
    setBounded(store.examsById, exam.examId.trim(), exam, MAX_CACHED_EXAMS, ttlMs, now)
  }
}

export function invalidateCachedExam(examId: string): void {
  const store = getStore()
  store.examsById.delete(examId.trim())
  store.publishedExamsList = null
}

export function clearStudyContentCache(): void {
  const store = getStore()
  store.questionsById.clear()
  store.publishedQuestionsByExam.clear()
  store.examsById.clear()
  store.publishedExamsList = null
}
