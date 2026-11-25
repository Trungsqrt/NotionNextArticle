import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import type {
  ExamCollection,
  FsrsCardState,
  ReviewEvent,
  StudyBookmarkRecord,
  StudyQuestion,
  StudyUser,
} from '../../lib/study/types'
import {
  ConcurrencyConflictError,
  createNotionStudyRepositories,
  fromChunkedRichText,
  mapNotionPageToStudyBookmarkRecord,
  mapStudyBookmarkRecordToNotionProperties,
  type StudyRepositories,
} from '../../lib/study/repositories'
import type { StudyNotionClient, NotionPageRecord } from '../../lib/study/notion-client'
import type { StudyNotionConfig } from '../../lib/study/config'
import { buildBookmarkKey, buildCardStateKey } from '../../lib/study/schemas'
import {
  BookmarkServiceError,
  getUserBookmarksForExam,
  importLegacyBookmarks,
  mutateUserBookmark,
} from '../../lib/study/services/bookmark-service'
import { getRecallQueue, submitRecallReview } from '../../lib/study/services/recall-service'
import {
  clearLegacyLocalBookmarks,
  readLegacyLocalBookmarksForImport,
  type StorageLike,
} from '../../lib/study/local-progress'
import { proxy } from '../../proxy'
import {
  SYNTHETIC_EXAM,
  SYNTHETIC_SINGLE_CHOICE_QUESTION,
  SYNTHETIC_USER,
} from './fixtures/synthetic-study-data'

function createMemoryStorage(): StorageLike & { keys: () => string[] } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
    keys: () => [...map.keys()],
  }
}

function makeQuestion(
  questionId: string,
  examId: string,
  status: StudyQuestion['status'] = 'published'
): StudyQuestion {
  return {
    ...SYNTHETIC_SINGLE_CHOICE_QUESTION,
    questionId,
    examId,
    status,
    questionText: `Synthetic question ${questionId}`,
  }
}

function createSyncedBookmarkTestRepos(options?: {
  includeBookmarksRepo?: boolean
  delayBookmarkSaveMs?: number
}) {
  const exam1: ExamCollection = {
    ...SYNTHETIC_EXAM,
    examId: 'exam-1',
    title: 'CSA Exam 1',
    questionCount: 3,
    status: 'published',
  }
  const exam2: ExamCollection = {
    ...SYNTHETIC_EXAM,
    examId: 'exam-2',
    title: 'CSA Exam 2',
    questionCount: 1,
    status: 'published',
  }
  const draftExam: ExamCollection = {
    ...SYNTHETIC_EXAM,
    examId: 'exam-draft',
    title: 'Draft Exam',
    questionCount: 1,
    status: 'draft',
  }

  const users = new Map<string, StudyUser>([
    [SYNTHETIC_USER.userId, { ...SYNTHETIC_USER }],
    ['usr-other-002', { ...SYNTHETIC_USER, userId: 'usr-other-002', username: 'other.student' }],
  ])
  const exams = new Map<string, ExamCollection>([
    [exam1.examId, exam1],
    [exam2.examId, exam2],
    [draftExam.examId, draftExam],
  ])
  const questions = new Map<string, StudyQuestion>([
    ['q-1', makeQuestion('q-1', 'exam-1', 'published')],
    ['q-2', makeQuestion('q-2', 'exam-1', 'published')],
    ['q-3', makeQuestion('q-3', 'exam-1', 'published')],
    ['q-draft', makeQuestion('q-draft', 'exam-1', 'draft')],
    ['q-e2-1', makeQuestion('q-e2-1', 'exam-2', 'published')],
    ['q-draft-exam', makeQuestion('q-draft-exam', 'exam-draft', 'published')],
  ])
  const cardStates = new Map<string, FsrsCardState>()
  const reviewEvents = new Map<string, ReviewEvent>()
  const bookmarks = new Map<string, StudyBookmarkRecord>()

  const counters = {
    bookmarkSaves: 0,
    examsListCalls: 0,
    cardStatesListCalls: 0,
  }

  const repos: StudyRepositories = {
    users: {
      async findByUsername(username) {
        const u = username.trim().toLowerCase()
        for (const v of users.values()) if (v.username === u) return { ...v }
        return null
      },
      async findByUserId(userId) {
        const v = users.get(userId)
        return v ? { ...v } : null
      },
      async upsert(user) {
        users.set(user.userId, { ...user })
        return { ...user }
      },
    },
    exams: {
      async findByExamId(examId) {
        const v = exams.get(examId)
        return v ? { ...v } : null
      },
      async list(opts) {
        counters.examsListCalls += 1
        return [...exams.values()].filter((e) => !opts?.status || e.status === opts.status)
      },
      async upsert(exam) {
        exams.set(exam.examId, { ...exam })
        return { ...exam }
      },
    },
    questions: {
      async findByQuestionId(qId) {
        const v = questions.get(qId)
        return v ? { ...v } : null
      },
      async listByExamId(examId, opts) {
        return [...questions.values()].filter(
          (q) => q.examId === examId && (!opts?.status || q.status === opts.status)
        )
      },
      async listByQuestionIds(ids) {
        return ids.map((id) => questions.get(id)).filter((q): q is StudyQuestion => Boolean(q))
      },
      async upsert(q) {
        questions.set(q.questionId, { ...q })
        return { ...q }
      },
    },
    cardStates: {
      async findByUserAndQuestion(userId, questionId) {
        const v = cardStates.get(buildCardStateKey(userId, questionId))
        return v ? { ...v, card: { ...v.card } } : null
      },
      async listByUser(userId) {
        counters.cardStatesListCalls += 1
        return [...cardStates.values()].filter((s) => s.userId === userId)
      },
      async listDueByUser(userId, asOfIso) {
        const asOf = Date.parse(asOfIso)
        return [...cardStates.values()].filter(
          (s) => s.userId === userId && Date.parse(s.due) <= asOf
        )
      },
      async save(state, opts = {}) {
        const existing = cardStates.get(state.stateKey)
        if (existing && typeof opts.expectedRevision === 'number' && existing.revision !== opts.expectedRevision) {
          throw new ConcurrencyConflictError(state.stateKey, opts.expectedRevision, existing.revision)
        }
        cardStates.set(state.stateKey, { ...state, card: { ...state.card } })
        return { ...state }
      },
    },
    reviewEvents: {
      async findByEventId(eventId) {
        const v = reviewEvents.get(eventId)
        return v ? { ...v } : null
      },
      async findLatestByUserAndQuestion(userId, questionId) {
        const list = [...reviewEvents.values()]
          .filter((e) => e.userId === userId && e.questionId === questionId)
          .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))
        return list[0] ? { ...list[0] } : null
      },
      async listByUser(userId, opts) {
        const list = [...reviewEvents.values()]
          .filter((e) => e.userId === userId)
          .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))
        return opts?.limit ? list.slice(0, opts.limit) : list
      },
      async appendIfNotExists(event) {
        const existing = reviewEvents.get(event.eventId)
        if (existing) return { event: existing, created: false }
        reviewEvents.set(event.eventId, { ...event })
        return { event, created: true }
      },
    },
    ...(options?.includeBookmarksRepo !== false
      ? {
          bookmarks: {
            async findByUserAndExam(userId, examId) {
              const v = bookmarks.get(buildBookmarkKey(userId, examId))
              return v ? { ...v, questionIds: [...v.questionIds] } : null
            },
            async listByUser(userId) {
              return [...bookmarks.values()]
                .filter((b) => b.userId === userId)
                .map((b) => ({ ...b, questionIds: [...b.questionIds] }))
            },
            async save(record) {
              if (options?.delayBookmarkSaveMs) {
                await new Promise((r) => setTimeout(r, options.delayBookmarkSaveMs))
              }
              counters.bookmarkSaves += 1
              bookmarks.set(record.bookmarkKey, {
                ...record,
                questionIds: [...record.questionIds],
              })
              return { ...record, questionIds: [...record.questionIds] }
            },
          },
        }
      : {}),
  }

  return { repos, counters, bookmarks, cardStates, reviewEvents }
}

describe('Synchronized Bookmarks & Personalized Active Recall', () => {
  it('syncs bookmarks across devices (desktop bookmark -> mobile Active Recall), isolates accounts, and stays idempotent', async () => {
    const { repos, counters } = createSyncedBookmarkTestRepos()
    const nowIso = '2026-04-10T10:00:00.000Z'

    // Desktop: User A bookmarks q-1 and q-e2-1 across two exams
    const add1 = await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-1', action: 'add', nowIso },
      repos
    )
    assert.equal(add1.changed, true)
    assert.deepEqual(add1.questionIds, ['q-1'])

    // Idempotent duplicate add performs ZERO additional saves
    const addDup = await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-1', action: 'add', nowIso },
      repos
    )
    assert.equal(addDup.changed, false)
    assert.equal(counters.bookmarkSaves, 1)

    await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-2', questionId: 'q-e2-1', action: 'add', nowIso },
      repos
    )

    // Mobile (same account, zero localStorage / zero client questionIds): Active Recall loads synced bookmarks
    const mobileQueue = await getRecallQueue(SYNTHETIC_USER.userId, repos, { nowIso })
    assert.equal(mobileQueue.bookmarkedCount, 2)
    assert.deepEqual(
      mobileQueue.items.map((i) => i.prompt.questionId).sort(),
      ['q-1', 'q-e2-1']
    )
    // Answer secrecy preserved
    assert.equal('correctOptionIds' in mobileQueue.items[0].prompt, false)
    assert.equal('explanation' in mobileQueue.items[0].prompt, false)

    // Account isolation: User B has 0 bookmarked questions and does NOT query exams/cardStates
    counters.examsListCalls = 0
    counters.cardStatesListCalls = 0
    const userBQueue = await getRecallQueue('usr-other-002', repos, { nowIso })
    assert.equal(userBQueue.bookmarkedCount, 0)
    assert.equal(userBQueue.items.length, 0)
    assert.equal(counters.examsListCalls, 0)
    assert.equal(counters.cardStatesListCalls, 0)
  })

  it('excludes unbookmarked cards without deleting FSRS state, reuses FSRS state on re-bookmark, and exposes both empty states', async () => {
    const { repos, cardStates, reviewEvents } = createSyncedBookmarkTestRepos()
    const t0 = '2026-04-10T10:00:00.000Z'

    // 1. Empty state 1: no bookmarks at all
    const empty1 = await getRecallQueue(SYNTHETIC_USER.userId, repos, { nowIso: t0 })
    assert.equal(empty1.bookmarkedCount, 0)
    assert.equal(empty1.items.length, 0)

    // 2. Bookmark q-1 and complete an FSRS review (Easy -> due days later)
    await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-1', action: 'add', nowIso: t0 },
      repos
    )
    const review = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-1',
        rating: 'easy',
        eventId: 'evt-sync-bm-1',
        expectedRevision: 0,
        nowIso: t0,
      },
      repos
    )

    // 3. Empty state 2: bookmark exists, but card is not due yet (upcomingReviews populated)
    const empty2 = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      nowIso: '2026-04-10T10:05:00.000Z',
    })
    assert.equal(empty2.bookmarkedCount, 1)
    assert.equal(empty2.items.length, 0)
    assert.equal(empty2.dueCount, 0)
    assert.equal(empty2.newCount, 0)
    const upcomingTotal =
      empty2.upcomingReviews.laterToday +
      empty2.upcomingReviews.tomorrow +
      empty2.upcomingReviews.next3Days +
      empty2.upcomingReviews.next7Days +
      empty2.upcomingReviews.later
    assert.equal(upcomingTotal, 1)

    // 4. Remove bookmark -> excluded from queue, FSRS CardState & ReviewEvent remain intact
    await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-1', action: 'remove', nowIso: t0 },
      repos
    )
    assert.equal(cardStates.size, 1)
    assert.equal(reviewEvents.size, 1)

    const afterRemove = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      nowIso: review.cardState.due,
    })
    assert.equal(afterRemove.bookmarkedCount, 0)
    assert.equal(afterRemove.items.length, 0)

    // 5. Re-bookmark q-1 -> reuses existing FSRS scheduling (due card, reps === 1, revision === 1)
    await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-1', action: 'add', nowIso: review.cardState.due },
      repos
    )
    const afterRebookmark = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      nowIso: review.cardState.due,
    })
    assert.equal(afterRebookmark.bookmarkedCount, 1)
    assert.equal(afterRebookmark.dueCount, 1)
    assert.equal(afterRebookmark.items[0].bucket, 'due')
    assert.equal(afterRebookmark.items[0].reps, 1)
    assert.equal(afterRebookmark.items[0].revision, 1)
  })

  it('serializes simultaneous bookmark updates without lost writes and validates exam/question membership', async () => {
    const { repos, bookmarks } = createSyncedBookmarkTestRepos({ delayBookmarkSaveMs: 15 })

    // Concurrent adds to the same (userId, examId) must both survive
    await Promise.all([
      mutateUserBookmark(
        { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-1', action: 'add' },
        repos
      ),
      mutateUserBookmark(
        { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-2', action: 'add' },
        repos
      ),
      mutateUserBookmark(
        { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-3', action: 'add' },
        repos
      ),
    ])

    assert.equal(bookmarks.size, 1) // Strictly one record per (userId, examId)
    const state = await getUserBookmarksForExam(SYNTHETIC_USER.userId, 'exam-1', repos)
    assert.deepEqual([...state.questionIds].sort(), ['q-1', 'q-2', 'q-3'])

    // Rejects question from a different exam
    await assert.rejects(
      () =>
        mutateUserBookmark(
          { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-e2-1', action: 'add' },
          repos
        ),
      (err: unknown) => err instanceof BookmarkServiceError && err.code === 'EXAM_QUESTION_MISMATCH'
    )

    // Rejects draft question
    await assert.rejects(
      () =>
        mutateUserBookmark(
          { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-draft', action: 'add' },
          repos
        ),
      (err: unknown) => err instanceof BookmarkServiceError && err.code === 'QUESTION_NOT_FOUND'
    )

    // Rejects unconfigured bookmarks DB cleanly with 503
    const { repos: unconfigured } = createSyncedBookmarkTestRepos({ includeBookmarksRepo: false })
    await assert.rejects(
      () =>
        mutateUserBookmark(
          { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-1', action: 'add' },
          unconfigured
        ),
      (err: unknown) =>
        err instanceof BookmarkServiceError &&
        err.status === 503 &&
        err.code === 'BOOKMARKS_NOT_CONFIGURED'
    )
  })

  it('imports legacy localStorage bookmarks explicitly, validates exam membership, and clears local keys', async () => {
    const { repos } = createSyncedBookmarkTestRepos()
    const storage = createMemoryStorage()
    storage.setItem(
      'study-bookmarks:exam-1',
      JSON.stringify({ 'q-1': true, 'q-draft': true, 'q-e2-1': true, 'q-removed': false })
    )

    const detected = readLegacyLocalBookmarksForImport(SYNTHETIC_USER.userId, 'exam-1', storage)
    assert.deepEqual(detected.sort(), ['q-1', 'q-draft', 'q-e2-1'])

    const imported = await importLegacyBookmarks(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionIds: detected },
      repos
    )
    // Only published question belonging to exam-1 (q-1) is imported!
    assert.equal(imported.importedCount, 1)
    assert.deepEqual(imported.questionIds, ['q-1'])

    clearLegacyLocalBookmarks(SYNTHETIC_USER.userId, 'exam-1', storage)
    assert.deepEqual(
      readLegacyLocalBookmarksForImport(SYNTHETIC_USER.userId, 'exam-1', storage),
      []
    )
  })

  it('round-trips StudyBookmarkRecord through Notion mappers & repository without duplicates, and blocks unauthenticated /api/study/bookmarks', async () => {
    const record: StudyBookmarkRecord = {
      bookmarkKey: buildBookmarkKey(SYNTHETIC_USER.userId, 'exam-1'),
      userId: SYNTHETIC_USER.userId,
      examId: 'exam-1',
      questionIds: ['q-1', 'q-2'],
      updatedAt: '2026-04-10T12:00:00.000Z',
    }

    const props = mapStudyBookmarkRecordToNotionProperties(record)
    const roundTripped = mapNotionPageToStudyBookmarkRecord({ id: 'page-bm-1', properties: props })
    assert.deepEqual(roundTripped, record)

    // Repository upsert updates single Notion record instead of duplicating
    const rows: NotionPageRecord[] = []
    let seq = 1
    const mockClient: StudyNotionClient = {
      async queryDatabaseAll(_dbId, opts) {
        const titleEq = (opts?.filter as { title?: { equals?: string } } | undefined)?.title?.equals
        if (titleEq) {
          return rows.filter((r) => fromChunkedRichText(r.properties['Bookmark Key']) === titleEq)
        }
        return rows
      },
      async createPage(_dbId, properties) {
        const page: NotionPageRecord = { id: `page-${seq++}`, properties }
        rows.push(page)
        return page
      },
      async updatePage(pageId, properties) {
        const idx = rows.findIndex((r) => r.id === pageId)
        rows[idx] = { ...rows[idx], properties }
        return rows[idx]
      },
      async retrievePage(pageId) {
        return rows.find((r) => r.id === pageId)!
      },
    }
    const cfg: StudyNotionConfig = {
      token: 'secret_test',
      usersDbId: 'db-u',
      examsDbId: 'db-e',
      questionsDbId: 'db-q',
      cardStatesDbId: 'db-c',
      reviewEventsDbId: 'db-r',
      bookmarksDbId: 'db-bm',
      timeoutMs: 5000,
      maxRetries: 0,
      minIntervalMs: 0,
      maxPaginationPages: 10,
    }
    const notionRepos = createNotionStudyRepositories(mockClient, cfg, { useContentCache: false })
    assert.ok(notionRepos.bookmarks)

    await notionRepos.bookmarks.save(record)
    await notionRepos.bookmarks.save({ ...record, questionIds: ['q-1', 'q-2', 'q-3'] })
    assert.equal(rows.length, 1)
    const loaded = await notionRepos.bookmarks.findByUserAndExam(SYNTHETIC_USER.userId, 'exam-1')
    assert.deepEqual(loaded?.questionIds, ['q-1', 'q-2', 'q-3'])

    // Unauthenticated access to /api/study/bookmarks returns 401 with noindex/no-store
    const res = proxy(new NextRequest('https://example.com/api/study/bookmarks?examId=exam-1'))
    assert.equal(res.status, 401)
    assert.ok(res.headers.get('x-robots-tag')?.includes('noindex'))
    assert.ok(res.headers.get('cache-control')?.includes('no-store'))
  })
})
