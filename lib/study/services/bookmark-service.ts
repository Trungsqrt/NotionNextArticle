/**
 * lib/study/services/bookmark-service.ts — Synchronized Study Bookmarks service
 * ──────────────────────────────────────────────────────────────────────────────
 * Persists user- and exam-scoped bookmarked question IDs in the private Notion
 * `Study Bookmarks` database.
 *
 * Concurrency & Consistency:
 * - Serializes read-modify-write updates per `(userId, examId)` using
 *   `withDistributedLock` (in-process mutex + Upstash Redis lease with periodic
 *   `PEXPIRE` heartbeat renewal and pre-write ownership assertion).
 * - Fails closed (`503 LOCK_UNAVAILABLE` or `409 LOCK_LOST`) when configured
 *   distributed locking fails or loses ownership rather than proceeding unlocked.
 * - Remaining limitation: Notion does not provide native atomic compare-and-swap
 *   (CAS) or transactions, so a severe pause between the pre-write lease check
 *   and Notion's HTTP commit could still race in extreme conditions.
 */

import type { StudyRepositories } from '../repositories'
import { buildBookmarkKey } from '../schemas'
import {
  withDistributedLock,
  type DistributedLockOptions,
} from '../concurrency/distributed-lock'

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

/**
 * Shared locked read-modify-write core for single mutations, coalesced syncs,
 * and legacy bookmark imports.
 */
async function applyBookmarkDelta(
  input: {
    userId: string
    examId: string
    addIds: readonly string[]
    removeIds: readonly string[]
    nowIso?: string
    lockOptions?: DistributedLockOptions
  },
  repos: StudyRepositories
): Promise<{
  examId: string
  questionIds: string[]
  addedCount: number
  changed: boolean
  updatedAt: string
}> {
  const bookmarksRepo = requireBookmarksRepo(repos)
  const cleanExamId = input.examId.trim()
  const bookmarkKey = buildBookmarkKey(input.userId, cleanExamId)
  const lockKey = `study:lock:bookmark:${bookmarkKey}`

  return withDistributedLock(
    lockKey,
    async (lease) => {
      const nowIso = input.nowIso || new Date().toISOString()
      const existing = await bookmarksRepo.findByUserAndExam(input.userId, cleanExamId)
      const currentIds = existing ? [...existing.questionIds] : []

      const removeSet = new Set(input.removeIds)
      const nextIds: string[] = []
      const seen = new Set<string>()

      for (const qId of currentIds) {
        if (removeSet.has(qId) || seen.has(qId)) continue
        seen.add(qId)
        nextIds.push(qId)
      }

      let addedCount = 0
      for (const qId of input.addIds) {
        if (nextIds.length >= MAX_BOOKMARKS_PER_EXAM) break
        if (!removeSet.has(qId) && !seen.has(qId)) {
          seen.add(qId)
          nextIds.push(qId)
          addedCount += 1
        }
      }

      const changed =
        nextIds.length !== currentIds.length ||
        nextIds.some((id, idx) => currentIds[idx] !== id)

      // Idempotent no-op avoids unnecessary Notion writes
      if (!changed) {
        return {
          examId: cleanExamId,
          questionIds: currentIds,
          addedCount: 0,
          changed: false,
          updatedAt: existing?.updatedAt || nowIso,
        }
      }

      // Verify distributed lock ownership is still valid right before committing to Notion
      lease.assertValid()

      const saved = await bookmarksRepo.save(
        {
          bookmarkKey,
          userId: input.userId,
          examId: cleanExamId,
          questionIds: nextIds,
          updatedAt: nowIso,
        },
        { skipExistenceCheck: !existing }
      )

      return {
        examId: cleanExamId,
        questionIds: saved.questionIds,
        addedCount,
        changed: true,
        updatedAt: saved.updatedAt,
      }
    },
    input.lockOptions
  )
}

export async function mutateUserBookmark(
  input: {
    userId: string
    examId: string
    questionId: string
    action: BookmarkAction
    nowIso?: string
    lockOptions?: DistributedLockOptions
  },
  repos: StudyRepositories
): Promise<BookmarkMutationResult> {
  requireBookmarksRepo(repos)
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

  const result = await applyBookmarkDelta(
    {
      userId: input.userId,
      examId: cleanExamId,
      addIds: input.action === 'add' ? [cleanQuestionId] : [],
      removeIds: input.action === 'remove' ? [cleanQuestionId] : [],
      nowIso: input.nowIso,
      lockOptions: input.lockOptions,
    },
    repos
  )

  return {
    examId: result.examId,
    questionIds: result.questionIds,
    changed: result.changed,
    updatedAt: result.updatedAt,
  }
}

export async function importLegacyBookmarks(
  input: {
    userId: string
    examId: string
    questionIds: readonly string[]
    nowIso?: string
    lockOptions?: DistributedLockOptions
  },
  repos: StudyRepositories
): Promise<BookmarkImportResult> {
  requireBookmarksRepo(repos)
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

  const result = await applyBookmarkDelta(
    {
      userId: input.userId,
      examId: cleanExamId,
      addIds: sanitizedIncoming,
      removeIds: [],
      nowIso: input.nowIso,
      lockOptions: input.lockOptions,
    },
    repos
  )

  return {
    examId: result.examId,
    questionIds: result.questionIds,
    importedCount: result.addedCount,
    updatedAt: result.updatedAt,
  }
}

/**
 * Applies a coalesced batch of bookmark additions and removals for one `(userId, examId)`
 * inside a single serialized lock & Notion update, awaiting actual Notion persistence
 * before returning the authoritative persisted question ID list.
 */
export async function syncUserBookmarks(
  input: {
    userId: string
    examId: string
    add: readonly string[]
    remove: readonly string[]
    nowIso?: string
    lockOptions?: DistributedLockOptions
  },
  repos: StudyRepositories
): Promise<BookmarkMutationResult> {
  requireBookmarksRepo(repos)
  const cleanExamId = input.examId.trim()

  const removeSet = new Set<string>()
  for (const rawId of input.remove) {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (id) removeSet.add(id)
  }

  const addIds: string[] = []
  const seenAdd = new Set<string>()
  for (const rawId of input.add) {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (id && !removeSet.has(id) && !seenAdd.has(id)) {
      seenAdd.add(id)
      addIds.push(id)
    }
  }

  const exam = await repos.exams.findByExamId(cleanExamId)
  if (!exam || exam.status !== 'published') {
    throw new BookmarkServiceError('Exam collection not found.', 404, 'EXAM_NOT_FOUND')
  }

  // Validate every added question exists, is published, and belongs to this exam (hits warm cache)
  if (addIds.length > 0) {
    const examQuestions = await repos.questions.listByExamId(cleanExamId, { status: 'published' })
    const validIds = new Set(examQuestions.map((q) => q.questionId))
    for (const qId of addIds) {
      if (!validIds.has(qId)) {
        throw new BookmarkServiceError(
          'One or more bookmarked questions do not belong to this published exam collection.',
          400,
          'EXAM_QUESTION_MISMATCH'
        )
      }
    }
  }

  const result = await applyBookmarkDelta(
    {
      userId: input.userId,
      examId: cleanExamId,
      addIds,
      removeIds: Array.from(removeSet),
      nowIso: input.nowIso,
      lockOptions: input.lockOptions,
    },
    repos
  )

  return {
    examId: result.examId,
    questionIds: result.questionIds,
    changed: result.changed,
    updatedAt: result.updatedAt,
  }
}
