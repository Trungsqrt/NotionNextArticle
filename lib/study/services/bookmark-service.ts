/**
 * lib/study/services/bookmark-service.ts — Synchronized Study Bookmarks service
 * ──────────────────────────────────────────────────────────────────────────────
 * Persists user- and exam-scoped bookmarked question IDs in the private Notion
 * `Study Bookmarks` database. Uses per-(userId, examId) serialization locks
 * (in-process mutex + optional Upstash Redis lease lock) so rapid or concurrent
 * bookmark toggles do not overwrite each other.
 */

import { randomUUID } from 'node:crypto'
import type { StudyRepositories } from '../repositories'
import { ConcurrencyConflictError } from '../repositories'
import { buildBookmarkKey } from '../schemas'

export class BookmarkServiceError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'BookmarkServiceError'
    this.status = status
    this.code = code
  }
}

export type BookmarkAction = 'add' | 'remove'

export interface BookmarkExamState {
  examId: string
  questionIds: string[]
  updatedAt: string | null
}

export interface BookmarkMutationResult {
  examId: string
  questionIds: string[]
  changed: boolean
  updatedAt: string
}

export interface BookmarkImportResult {
  examId: string
  questionIds: string[]
  importedCount: number
  updatedAt: string
}

const MAX_BOOKMARKS_PER_EXAM = 500
const bookmarkLocks = new Map<string, Promise<unknown>>()

async function withInProcessLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = bookmarkLocks.get(key) || Promise.resolve()
  const next = prev.then(task, task)
  const cleanup = next.then(
    () => {
      if (bookmarkLocks.get(key) === cleanup) bookmarkLocks.delete(key)
    },
    () => {
      if (bookmarkLocks.get(key) === cleanup) bookmarkLocks.delete(key)
    }
  )
  bookmarkLocks.set(key, cleanup)
  return next
}

function getUpstashLockConfig(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '')
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim()
  if (!url || !token) return null
  return { url, token }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const RELEASE_LOCK_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'

async function withBookmarkLock<T>(bookmarkKey: string, task: () => Promise<T>): Promise<T> {
  return withInProcessLock(bookmarkKey, async () => {
    const upstash = getUpstashLockConfig()
    if (!upstash) return task()

    const lockKey = `study:lock:bookmark:${bookmarkKey}`
    const lockToken = randomUUID()
    const ttlMs = 8000
    const maxAttempts = 5
    let acquired = false
    let redisReachable = true

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(`${upstash.url}/pipeline`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${upstash.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([['SET', lockKey, lockToken, 'NX', 'PX', String(ttlMs)]]),
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) {
          const payload = (await res.json()) as Array<{ result?: unknown }>
          if (payload?.[0]?.result === 'OK') {
            acquired = true
            break
          }
        } else {
          redisReachable = false
          break
        }
      } catch {
        redisReachable = false
        break
      }
      await sleep(50 * (attempt + 1))
    }

    if (!acquired && redisReachable) {
      throw new ConcurrencyConflictError(bookmarkKey, -1, -1)
    }

    try {
      return await task()
    } finally {
      if (acquired) {
        try {
          await fetch(`${upstash.url}/pipeline`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${upstash.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify([['EVAL', RELEASE_LOCK_LUA, '1', lockKey, lockToken]]),
            signal: AbortSignal.timeout(3000),
          })
        } catch {
          // Lease expires automatically
        }
      }
    }
  })
}

function requireBookmarksRepo(repos: StudyRepositories) {
  if (!repos.bookmarks) {
    throw new BookmarkServiceError(
      'Study Bookmarks database is not configured.',
      503,
      'BOOKMARKS_NOT_CONFIGURED'
    )
  }
  return repos.bookmarks
}

export async function getUserBookmarksForExam(
  userId: string,
  examId: string,
  repos: StudyRepositories
): Promise<BookmarkExamState> {
  const bookmarksRepo = requireBookmarksRepo(repos)
  const cleanExamId = examId.trim()

  const [exam, record] = await Promise.all([
    repos.exams.findByExamId(cleanExamId),
    bookmarksRepo.findByUserAndExam(userId, cleanExamId),
  ])

  if (!exam || exam.status !== 'published') {
    throw new BookmarkServiceError('Exam collection not found.', 404, 'EXAM_NOT_FOUND')
  }

  return {
    examId: cleanExamId,
    questionIds: record ? [...record.questionIds] : [],
    updatedAt: record?.updatedAt || null,
  }
}

export async function listAllUserBookmarks(
  userId: string,
  repos: StudyRepositories,
  options?: { examId?: string }
): Promise<{
  bookmarksByExam: Record<string, string[]>
  questionIds: string[]
}> {
  const bookmarksRepo = requireBookmarksRepo(repos)

  if (options?.examId) {
    const cleanExamId = options.examId.trim()
    const record = await bookmarksRepo.findByUserAndExam(userId, cleanExamId)
    const ids = record ? [...record.questionIds] : []
    return {
      bookmarksByExam: ids.length > 0 ? { [cleanExamId]: ids } : {},
      questionIds: ids,
    }
  }

  const records = await bookmarksRepo.listByUser(userId)
  const bookmarksByExam: Record<string, string[]> = {}
  const seen = new Set<string>()
  const questionIds: string[] = []

  for (const rec of records) {
    if (rec.questionIds.length > 0) {
      bookmarksByExam[rec.examId] = [...rec.questionIds]
    }
    for (const qId of rec.questionIds) {
      if (!seen.has(qId)) {
        seen.add(qId)
        questionIds.push(qId)
      }
    }
  }

  return { bookmarksByExam, questionIds }
}

export async function mutateUserBookmark(
  input: {
    userId: string
    examId: string
    questionId: string
    action: BookmarkAction
    nowIso?: string
  },
  repos: StudyRepositories
): Promise<BookmarkMutationResult> {
  const bookmarksRepo = requireBookmarksRepo(repos)
  const cleanExamId = input.examId.trim()
  const cleanQuestionId = input.questionId.trim()

  // Validate published exam + published question + exam membership (usually <1ms via published cache)
  const [exam, question] = await Promise.all([
    repos.exams.findByExamId(cleanExamId),
    repos.questions.findByQuestionId(cleanQuestionId),
  ])

  if (!exam || exam.status !== 'published') {
    throw new BookmarkServiceError('Exam collection not found.', 404, 'EXAM_NOT_FOUND')
  }
  if (!question || question.status !== 'published') {
    throw new BookmarkServiceError('Question not found.', 404, 'QUESTION_NOT_FOUND')
  }
  if (question.examId !== cleanExamId) {
    throw new BookmarkServiceError(
      'Question does not belong to the specified exam collection.',
      400,
      'EXAM_QUESTION_MISMATCH'
    )
  }

  const bookmarkKey = buildBookmarkKey(input.userId, cleanExamId)
  return withBookmarkLock(bookmarkKey, async () => {
    const nowIso = input.nowIso || new Date().toISOString()
    const existing = await bookmarksRepo.findByUserAndExam(input.userId, cleanExamId)
    const currentIds = existing ? [...existing.questionIds] : []
    const alreadyPresent = currentIds.includes(cleanQuestionId)

    // Idempotent no-op avoids unnecessary Notion writes
    if (input.action === 'add' && alreadyPresent) {
      return {
        examId: cleanExamId,
        questionIds: currentIds,
        changed: false,
        updatedAt: existing?.updatedAt || nowIso,
      }
    }
    if (input.action === 'remove' && !alreadyPresent) {
      return {
        examId: cleanExamId,
        questionIds: currentIds,
        changed: false,
        updatedAt: existing?.updatedAt || nowIso,
      }
    }

    const nextIds =
      input.action === 'add'
        ? [...currentIds, cleanQuestionId].slice(0, MAX_BOOKMARKS_PER_EXAM)
        : currentIds.filter((id) => id !== cleanQuestionId)

    const saved = await bookmarksRepo.save({
      bookmarkKey,
      userId: input.userId,
      examId: cleanExamId,
      questionIds: nextIds,
      updatedAt: nowIso,
    })

    return {
      examId: cleanExamId,
      questionIds: saved.questionIds,
      changed: true,
      updatedAt: saved.updatedAt,
    }
  })
}

export async function importLegacyBookmarks(
  input: {
    userId: string
    examId: string
    questionIds: readonly string[]
    nowIso?: string
  },
  repos: StudyRepositories
): Promise<BookmarkImportResult> {
  const bookmarksRepo = requireBookmarksRepo(repos)
  const cleanExamId = input.examId.trim()

  const [exam, examQuestions] = await Promise.all([
    repos.exams.findByExamId(cleanExamId),
    repos.questions.listByExamId(cleanExamId, { status: 'published' }),
  ])

  if (!exam || exam.status !== 'published') {
    throw new BookmarkServiceError('Exam collection not found.', 404, 'EXAM_NOT_FOUND')
  }

  const validQuestionIds = new Set(examQuestions.map((q) => q.questionId))
  const sanitizedIncoming: string[] = []
  const seenIncoming = new Set<string>()
  for (const rawId of input.questionIds) {
    const cleanId = typeof rawId === 'string' ? rawId.trim() : ''
    if (cleanId && validQuestionIds.has(cleanId) && !seenIncoming.has(cleanId)) {
      seenIncoming.add(cleanId)
      sanitizedIncoming.push(cleanId)
    }
  }

  const bookmarkKey = buildBookmarkKey(input.userId, cleanExamId)
  return withBookmarkLock(bookmarkKey, async () => {
    const nowIso = input.nowIso || new Date().toISOString()
    const existing = await bookmarksRepo.findByUserAndExam(input.userId, cleanExamId)
    const merged = existing ? [...existing.questionIds] : []
    const existingSet = new Set(merged)
    let importedCount = 0

    for (const qId of sanitizedIncoming) {
      if (merged.length >= MAX_BOOKMARKS_PER_EXAM) break
      if (!existingSet.has(qId)) {
        existingSet.add(qId)
        merged.push(qId)
        importedCount += 1
      }
    }

    if (importedCount === 0) {
      return {
        examId: cleanExamId,
        questionIds: merged,
        importedCount: 0,
        updatedAt: existing?.updatedAt || nowIso,
      }
    }

    const saved = await bookmarksRepo.save({
      bookmarkKey,
      userId: input.userId,
      examId: cleanExamId,
      questionIds: merged,
      updatedAt: nowIso,
    })

    return {
      examId: cleanExamId,
      questionIds: saved.questionIds,
      importedCount,
      updatedAt: saved.updatedAt,
    }
  })
}
