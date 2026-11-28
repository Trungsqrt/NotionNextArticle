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
  syncUserBookmarks,
} from '../../lib/study/services/bookmark-service'
import { getRecallQueue, submitRecallReview } from '../../lib/study/services/recall-service'
import {
  clearLegacyLocalBookmarks,
  readLegacyLocalBookmarksForImport,
  readPendingBookmarkOps,
  type StorageLike,
} from '../../lib/study/local-progress'
import {
  createBookmarkSyncController,
  createQuestionBookmarkFeedback,
  parseRetryAfterHeaderMs,
  type BookmarkSyncSnapshot,
  type BookmarkTransientFeedbackPhase,
} from '../../lib/study/bookmark-sync'
import {
  DistributedLockLostError,
  DistributedLockUnavailableError,
} from '../../lib/study/concurrency/distributed-lock'
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

describe('Non-blocking Bookmark Synchronization', () => {
  it('coalesces rapid toggles, cancels no-ops, and guarantees latest intention across in-flight requests', async () => {
    const storage = createMemoryStorage()
    const snapshots: BookmarkSyncSnapshot[] = []
    let serverSet = new Set<string>(['q-1'])
    const postPayloads: Array<{ add: string[]; remove: string[] }> = []
    let inFlightCount = 0
    let maxConcurrentPosts = 0
    let releaseFirstPost: (() => void) | null = null
    let firstPostStarted: (() => void) | null = null
    const firstPostStartedPromise = new Promise<void>((resolve) => {
      firstPostStarted = resolve
    })

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET' && url.includes('/api/study/bookmarks')) {
        return new Response(JSON.stringify({ examId: 'exam-1', questionIds: [...serverSet] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && url.includes('/api/study/bookmarks')) {
        inFlightCount += 1
        maxConcurrentPosts = Math.max(maxConcurrentPosts, inFlightCount)
        const body = JSON.parse(String(init?.body || '{}')) as {
          action: string
          add: string[]
          remove: string[]
        }
        assert.equal(body.action, 'sync')
        postPayloads.push({ add: [...body.add], remove: [...body.remove] })

        if (postPayloads.length === 1) {
          firstPostStarted?.()
          await new Promise<void>((resolve) => {
            releaseFirstPost = resolve
          })
        }

        for (const id of body.remove) serverSet.delete(id)
        for (const id of body.add) serverSet.add(id)
        inFlightCount -= 1

        return new Response(JSON.stringify({ examId: 'exam-1', questionIds: [...serverSet] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    }

    const ctrl = createBookmarkSyncController({
      userId: SYNTHETIC_USER.userId,
      examId: 'exam-1',
      validQuestionIds: new Set(['q-1', 'q-2', 'q-3']),
      onStateChange: (s) => snapshots.push(s),
      fetchImpl: mockFetch,
      storage,
      debounceMs: 25,
    })

    await ctrl.loadFromServer()
    assert.deepEqual(ctrl.getSnapshot().bookmarks, { 'q-1': true })

    // 1. Rapid toggle on -> off back to server-confirmed state cancels with 0 network requests
    ctrl.toggle('q-2') // add
    assert.equal(ctrl.getSnapshot().bookmarks['q-2'], true)
    ctrl.toggle('q-2') // remove (back to server state)
    assert.equal(ctrl.getSnapshot().bookmarks['q-2'], undefined)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(postPayloads.length, 0)

    // 2. Rapid burst across q-2 (add->remove->add) and q-3 (add) coalesces into 1 POST
    ctrl.toggle('q-2') // add
    ctrl.toggle('q-2') // remove
    ctrl.toggle('q-2') // add
    ctrl.toggle('q-3') // add
    assert.equal(ctrl.getSnapshot().status, 'saving')
    assert.deepEqual(ctrl.getSnapshot().bookmarks, { 'q-1': true, 'q-2': true, 'q-3': true })

    // Wait for first coalesced POST to start
    await firstPostStartedPromise
    assert.equal(postPayloads.length, 1)
    assert.deepEqual(postPayloads[0].add.sort(), ['q-2', 'q-3'])
    assert.deepEqual(postPayloads[0].remove, [])

    // 3. While first POST is in flight, user immediately unbookmarks q-2 and q-1
    ctrl.toggle('q-2') // remove q-2 (latest intention overrides in-flight add!)
    ctrl.toggle('q-1') // remove q-1
    assert.deepEqual(ctrl.getSnapshot().bookmarks, { 'q-3': true })

    // Release first POST; controller must keep latest intention and send 1 follow-up sync
    releaseFirstPost!()
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(maxConcurrentPosts, 1, 'Never sends concurrent duplicate POSTs for the same exam')
    assert.equal(postPayloads.length, 2)
    assert.deepEqual(postPayloads[1].remove.sort(), ['q-1', 'q-2'])
    assert.deepEqual([...serverSet].sort(), ['q-3'])
    assert.deepEqual(ctrl.getSnapshot().bookmarks, { 'q-3': true })
    assert.equal(ctrl.getSnapshot().status, 'saved')
    assert.equal(ctrl.getSnapshot().pendingCount, 0)
    assert.deepEqual(readPendingBookmarkOps(SYNTHETIC_USER.userId, 'exam-1', storage), {})

    ctrl.destroy()
  })

  it('respects Retry-After, bounded retries & timeouts, persists failed ops in user-scoped LocalStorage, and recovers on manual retry', async () => {
    const storage = createMemoryStorage()
    const sleepDelays: number[] = []
    let postAttempts = 0
    let shouldFail = true

    assert.equal(parseRetryAfterHeaderMs('3', 30_000), 3000)
    assert.equal(parseRetryAfterHeaderMs('120', 30_000), 30_000)
    assert.equal(
      parseRetryAfterHeaderMs(new Date(Date.now() + 4000).toUTCString(), 30_000, Date.now()) !== null,
      true
    )

    const mockFetch: typeof fetch = async (_input, init) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET') {
        return new Response(JSON.stringify({ examId: 'exam-1', questionIds: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      postAttempts += 1
      if (shouldFail) {
        if (postAttempts === 1) {
          return new Response(JSON.stringify({ error: 'Rate limited' }), {
            status: 429,
            headers: { 'Retry-After': '2' },
          })
        }
        // Simulate request timeout via AbortSignal
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')))
        })
      }
      return new Response(JSON.stringify({ examId: 'exam-1', questionIds: ['q-1'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const ctrl = createBookmarkSyncController({
      userId: SYNTHETIC_USER.userId,
      examId: 'exam-1',
      validQuestionIds: new Set(['q-1', 'q-2']),
      onStateChange: () => {},
      fetchImpl: mockFetch,
      storage,
      debounceMs: 0,
      timeoutMs: 25,
      maxRetries: 2,
      retryBaseDelayMs: 50,
      sleepFn: async (ms) => {
        sleepDelays.push(ms)
      },
    })

    await ctrl.loadFromServer()
    ctrl.toggle('q-1')
    // Wait for initial attempt + 2 bounded retries to settle
    await new Promise((r) => setTimeout(r, 120))

    // 1 initial attempt + 2 retries = 3 total attempts (bounded, no aggressive polling)
    assert.equal(postAttempts, 3)
    assert.equal(sleepDelays[0], 2000, 'Honored Retry-After: 2 header on 429')
    assert.equal(ctrl.getSnapshot().status, 'not_synced')
    // Optimistic state is preserved so user can keep studying uninterrupted
    assert.equal(ctrl.getSnapshot().bookmarks['q-1'], true)
    assert.equal(ctrl.getSnapshot().pendingCount, 1)

    // Persisted in user-scoped LocalStorage (strictly isolated from other accounts)
    const pendingUserA = readPendingBookmarkOps(SYNTHETIC_USER.userId, 'exam-1', storage)
    assert.equal(pendingUserA['q-1']?.action, 'add')
    const pendingUserB = readPendingBookmarkOps('usr-other-002', 'exam-1', storage)
    assert.deepEqual(pendingUserB, {})

    // Simulate manual Retry after Notion recovers (without refreshing the page)
    shouldFail = false
    await ctrl.retry()
    assert.equal(ctrl.getSnapshot().status, 'saved')
    assert.equal(ctrl.getSnapshot().pendingCount, 0)
    assert.deepEqual(ctrl.getSnapshot().bookmarks, { 'q-1': true })
    assert.deepEqual(readPendingBookmarkOps(SYNTHETIC_USER.userId, 'exam-1', storage), {})

    ctrl.destroy()
  })

  it('loads bookmarks independently without clobbering optimistic toggles made while load is slow', async () => {
    const storage = createMemoryStorage()
    let releaseGet: (() => void) | null = null
    let serverIds = ['q-1']

    const mockFetch: typeof fetch = async (_input, init) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET') {
        await new Promise<void>((resolve) => {
          releaseGet = resolve
        })
        return new Response(JSON.stringify({ examId: 'exam-1', questionIds: serverIds }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const body = JSON.parse(String(init?.body || '{}')) as { add: string[]; remove: string[] }
      const set = new Set(serverIds)
      for (const id of body.remove) set.delete(id)
      for (const id of body.add) set.add(id)
      serverIds = [...set]
      return new Response(JSON.stringify({ examId: 'exam-1', questionIds: serverIds }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const ctrl = createBookmarkSyncController({
      userId: SYNTHETIC_USER.userId,
      examId: 'exam-1',
      validQuestionIds: new Set(['q-1', 'q-2']),
      onStateChange: () => {},
      fetchImpl: mockFetch,
      storage,
      debounceMs: 40,
    })

    // Start independent GET (still slow/pending)
    const loadPromise = ctrl.loadFromServer()
    assert.equal(ctrl.getSnapshot().isInitialLoadPending, true)

    // User immediately bookmarks q-2 while GET has not even returned yet
    ctrl.toggle('q-2')
    assert.equal(ctrl.getSnapshot().bookmarks['q-2'], true)

    // Now slow GET returns ['q-1']; q-2 must remain overlaid and flush cleanly
    releaseGet!()
    await loadPromise
    await new Promise((r) => setTimeout(r, 80))

    assert.deepEqual(ctrl.getSnapshot().bookmarks, { 'q-1': true, 'q-2': true })
    assert.equal(ctrl.getSnapshot().status, 'saved')
    assert.deepEqual(serverIds.sort(), ['q-1', 'q-2'])
    ctrl.destroy()
  })

  it('syncUserBookmarks applies coalesced add/remove server-side and awaits real persistence', async () => {
    const { repos, counters } = createSyncedBookmarkTestRepos({ delayBookmarkSaveMs: 10 })

    const first = await syncUserBookmarks(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', add: ['q-1', 'q-2'], remove: [] },
      repos
    )
    assert.equal(first.changed, true)
    assert.deepEqual(first.questionIds, ['q-1', 'q-2'])
    assert.equal(counters.bookmarkSaves, 1)

    // No-op batch skips Notion write
    const noop = await syncUserBookmarks(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', add: ['q-1'], remove: ['q-3'] },
      repos
    )
    assert.equal(noop.changed, false)
    assert.equal(counters.bookmarkSaves, 1)

    // Mixed add + remove persists atomically in 1 save
    const mixed = await syncUserBookmarks(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', add: ['q-3'], remove: ['q-1'] },
      repos
    )
    assert.equal(mixed.changed, true)
    assert.deepEqual(mixed.questionIds, ['q-2', 'q-3'])
    assert.equal(counters.bookmarkSaves, 2)
  })

  it('prevents stale GET from overwriting a newer successful POST and validates API payloads', async () => {
    const storage = createMemoryStorage()
    let releaseSlowGet: (() => void) | null = null
    let returnMalformedPost = false

    const mockFetch: typeof fetch = async (_input, init) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET') {
        await new Promise<void>((resolve) => {
          releaseSlowGet = resolve
        })
        return new Response(
          JSON.stringify({ examId: 'exam-1', userId: SYNTHETIC_USER.userId, questionIds: ['q-1'] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      const body = JSON.parse(String(init?.body || '{}')) as {
        expectedUserId?: string
        add: string[]
      }
      assert.equal(body.expectedUserId, SYNTHETIC_USER.userId)
      if (returnMalformedPost) {
        // Malformed payload missing persisted questionId must NOT clear pending ops
        return new Response(JSON.stringify({ examId: 'exam-1', questionIds: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          examId: 'exam-1',
          userId: SYNTHETIC_USER.userId,
          questionIds: ['q-1', ...body.add],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const ctrl = createBookmarkSyncController({
      userId: SYNTHETIC_USER.userId,
      examId: 'exam-1',
      validQuestionIds: new Set(['q-1', 'q-2', 'q-3']),
      onStateChange: () => {},
      fetchImpl: mockFetch,
      storage,
      debounceMs: 0,
    })

    // Start slow GET, then immediately bookmark q-2 and let POST complete first
    const getPromise = ctrl.loadFromServer()
    ctrl.toggle('q-2')
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(ctrl.getSnapshot().bookmarks, { 'q-1': true, 'q-2': true })
    assert.equal(ctrl.getSnapshot().status, 'saved')

    // Now the stale GET resolves with only ['q-1'] — must NOT overwrite ['q-1', 'q-2']!
    releaseSlowGet!()
    await getPromise
    assert.deepEqual(ctrl.getSnapshot().bookmarks, { 'q-1': true, 'q-2': true })

    // Unconfirmed HTTP 200 response must NOT acknowledge/clear pending ops
    returnMalformedPost = true
    ctrl.toggle('q-3')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(ctrl.getSnapshot().status, 'not_synced')
    assert.equal(ctrl.getSnapshot().pendingCount, 1)
    assert.equal(readPendingBookmarkOps(SYNTHETIC_USER.userId, 'exam-1', storage)['q-3']?.action, 'add')

    ctrl.destroy()
  })

  it('does not clobber newer pending LocalStorage ops when switching away and returning before old save completes', async () => {
    const storage = createMemoryStorage()
    let releaseFirstPost: (() => void) | null = null
    let postCall = 0
    const serverSet = new Set<string>()

    const mockFetch: typeof fetch = async (_input, init) => {
      const method = (init?.method || 'GET').toUpperCase()
      if (method === 'GET') {
        return new Response(
          JSON.stringify({ examId: 'exam-1', userId: SYNTHETIC_USER.userId, questionIds: [...serverSet] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      postCall += 1
      const callNum = postCall
      const body = JSON.parse(String(init?.body || '{}')) as { add: string[]; remove: string[] }
      if (callNum === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstPost = resolve
        })
      }
      for (const id of body.remove) serverSet.delete(id)
      for (const id of body.add) serverSet.add(id)
      return new Response(
        JSON.stringify({ examId: 'exam-1', userId: SYNTHETIC_USER.userId, questionIds: [...serverSet] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // 1. User bookmarks q-1 on Exam 1 (ctrlA); POST #1 stays in flight
    const ctrlA = createBookmarkSyncController({
      userId: SYNTHETIC_USER.userId,
      examId: 'exam-1',
      validQuestionIds: new Set(['q-1', 'q-2']),
      onStateChange: () => {},
      fetchImpl: mockFetch,
      storage,
      debounceMs: 0,
    })
    ctrlA.toggle('q-1')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(postCall, 1)

    // 2. User switches to Exam 2 (ctrlA destroyed while POST #1 is still in flight)
    ctrlA.destroy()

    // 3. User returns to Exam 1 BEFORE POST #1 finishes (ctrlB mounts and bookmarks q-2)
    const ctrlB = createBookmarkSyncController({
      userId: SYNTHETIC_USER.userId,
      examId: 'exam-1',
      validQuestionIds: new Set(['q-1', 'q-2']),
      onStateChange: () => {},
      fetchImpl: mockFetch,
      storage,
      debounceMs: 30,
    })
    assert.equal(ctrlB.getSnapshot().bookmarks['q-1'], true)
    ctrlB.toggle('q-2')
    assert.deepEqual(ctrlB.getSnapshot().bookmarks, { 'q-1': true, 'q-2': true })

    // 4. Old ctrlA's POST #1 completes — must reconcile q-1 into ctrlB WITHOUT erasing q-2
    releaseFirstPost!()
    await new Promise((r) => setTimeout(r, 80))

    assert.deepEqual([...serverSet].sort(), ['q-1', 'q-2'])
    assert.deepEqual(ctrlB.getSnapshot().bookmarks, { 'q-1': true, 'q-2': true })
    assert.equal(ctrlB.getSnapshot().pendingCount, 0)
    assert.deepEqual(readPendingBookmarkOps(SYNTHETIC_USER.userId, 'exam-1', storage), {})

    ctrlB.destroy()
  })

  it('scopes minimal bookmark feedback to the triggering question: >400ms spinner, 600ms checkmark, immediate hide on navigation', async () => {
    const phases: BookmarkTransientFeedbackPhase[] = []
    const feedback = createQuestionBookmarkFeedback({
      onPhaseChange: (p) => phases.push(p),
      loadingDelayMs: 40,
      successDurationMs: 50,
    })

    const baseSnap: BookmarkSyncSnapshot = {
      bookmarks: { 'q-1': true },
      serverBookmarks: {},
      loadedFromServer: true,
      isInitialLoadPending: false,
      status: 'saving',
      pendingCount: 1,
      savingQuestionIds: ['q-1'],
      lastConfirmedEvent: null,
      loadFailed: false,
      errorMessage: null,
    }

    // 1. Fast successful sync (< loadingDelayMs): never shows loading, shows checkmark briefly, hides
    feedback.setActiveQuestion('q-1')
    feedback.onBookmarkTriggered('q-1')
    feedback.onSyncSnapshot(baseSnap)
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(feedback.getPhase(), 'hidden')
    feedback.onSyncSnapshot({
      ...baseSnap,
      status: 'saved',
      pendingCount: 0,
      savingQuestionIds: [],
      lastConfirmedEvent: { id: 1, questionIds: ['q-1'] },
    })
    assert.equal(feedback.getPhase(), 'success')
    assert.equal(phases.includes('loading'), false)
    await new Promise((r) => setTimeout(r, 70))
    assert.equal(feedback.getPhase(), 'hidden')

    // 2. Slow successful sync (> loadingDelayMs): shows loading, then brief checkmark, then hidden
    phases.length = 0
    feedback.onBookmarkTriggered('q-1')
    feedback.onSyncSnapshot(baseSnap)
    await new Promise((r) => setTimeout(r, 55))
    assert.equal(feedback.getPhase(), 'loading')
    feedback.onSyncSnapshot({
      ...baseSnap,
      status: 'saved',
      pendingCount: 0,
      savingQuestionIds: [],
      lastConfirmedEvent: { id: 2, questionIds: ['q-1'] },
    })
    assert.equal(feedback.getPhase(), 'success')
    await new Promise((r) => setTimeout(r, 70))
    assert.equal(feedback.getPhase(), 'hidden')

    // 3. Bookmark q-1 and immediately navigate to q-2: hides feedback immediately & never shows q-1's checkmark on q-2
    phases.length = 0
    feedback.onBookmarkTriggered('q-1')
    feedback.onSyncSnapshot(baseSnap)
    feedback.setActiveQuestion('q-2')
    assert.equal(feedback.getPhase(), 'hidden')
    await new Promise((r) => setTimeout(r, 55))
    assert.equal(feedback.getPhase(), 'hidden')
    feedback.onSyncSnapshot({
      ...baseSnap,
      status: 'saved',
      pendingCount: 0,
      savingQuestionIds: [],
      lastConfirmedEvent: { id: 3, questionIds: ['q-1'] },
    })
    assert.equal(feedback.getPhase(), 'hidden')
    assert.deepEqual(phases, [])

    feedback.destroy()
  })

  it('renews distributed bookmark lock during slow Notion writes, aborts on lost ownership, and fails closed when Redis fails', async () => {
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL
    const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN
    process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.local'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token'

    try {
      // 1. Slow Notion write exceeding initial lock TTL stays alive via PEXPIRE heartbeat renewals
      let renewCalls = 0
      let releaseCalls = 0
      const renewingFetch: typeof fetch = async (_url, init) => {
        const cmds = JSON.parse(String(init?.body || '[]')) as string[][]
        const [op, script] = cmds[0]
        if (op === 'SET') {
          return new Response(JSON.stringify([{ result: 'OK' }]), { status: 200 })
        }
        if (op === 'EVAL' && script.includes('pexpire')) {
          renewCalls += 1
          return new Response(JSON.stringify([{ result: 1 }]), { status: 200 })
        }
        if (op === 'EVAL' && script.includes('del')) {
          releaseCalls += 1
          return new Response(JSON.stringify([{ result: 1 }]), { status: 200 })
        }
        return new Response(JSON.stringify([{ result: null }]), { status: 200 })
      }

      const { repos: slowRepos, counters: slowCounters } = createSyncedBookmarkTestRepos({
        delayBookmarkSaveMs: 10,
      })
      const origFind = slowRepos.bookmarks!.findByUserAndExam.bind(slowRepos.bookmarks!)
      slowRepos.bookmarks!.findByUserAndExam = async (u, e) => {
        // Exceed the 220ms TTL cleanly so heartbeat renewals must fire
        await new Promise((r) => setTimeout(r, 280))
        return origFind(u, e)
      }

      const slowResult = await mutateUserBookmark(
        {
          userId: SYNTHETIC_USER.userId,
          examId: 'exam-1',
          questionId: 'q-1',
          action: 'add',
          lockOptions: {
            ttlMs: 220,
            renewIntervalMs: 70,
            fetchImpl: renewingFetch,
          },
        },
        slowRepos
      )
      assert.deepEqual(slowResult.questionIds, ['q-1'])
      assert.ok(renewCalls >= 2, `Expected >=2 lock renewals, got ${renewCalls}`)
      assert.equal(releaseCalls, 1)
      assert.equal(slowCounters.bookmarkSaves, 1)

      // 2. When renewal detects lost ownership (EVAL returns 0), abort BEFORE Notion write
      const lostOwnerFetch: typeof fetch = async (_url, init) => {
        const cmds = JSON.parse(String(init?.body || '[]')) as string[][]
        const [op, script] = cmds[0]
        if (op === 'SET') {
          return new Response(JSON.stringify([{ result: 'OK' }]), { status: 200 })
        }
        if (op === 'EVAL' && script.includes('pexpire')) {
          return new Response(JSON.stringify([{ result: 0 }]), { status: 200 })
        }
        return new Response(JSON.stringify([{ result: 0 }]), { status: 200 })
      }

      const { repos: lostRepos, counters: lostCounters } = createSyncedBookmarkTestRepos()
      const origLostFind = lostRepos.bookmarks!.findByUserAndExam.bind(lostRepos.bookmarks!)
      lostRepos.bookmarks!.findByUserAndExam = async (u, e) => {
        await new Promise((r) => setTimeout(r, 150))
        return origLostFind(u, e)
      }

      await assert.rejects(
        () =>
          mutateUserBookmark(
            {
              userId: SYNTHETIC_USER.userId,
              examId: 'exam-1',
              questionId: 'q-1',
              action: 'add',
              lockOptions: {
                ttlMs: 200,
                renewIntervalMs: 50,
                fetchImpl: lostOwnerFetch,
              },
            },
            lostRepos
          ),
        (err: unknown) => err instanceof DistributedLockLostError
      )
      assert.equal(lostCounters.bookmarkSaves, 0, 'Must never write to Notion after losing lock ownership')

      // 3. When configured Redis fails on acquire, fail closed (503) instead of writing unlocked
      const failingRedisFetch: typeof fetch = async () =>
        new Response('Service Unavailable', { status: 503 })
      const { repos: failClosedRepos, counters: failClosedCounters } =
        createSyncedBookmarkTestRepos()

      await assert.rejects(
        () =>
          mutateUserBookmark(
            {
              userId: SYNTHETIC_USER.userId,
              examId: 'exam-1',
              questionId: 'q-1',
              action: 'add',
              lockOptions: { fetchImpl: failingRedisFetch },
            },
            failClosedRepos
          ),
        (err: unknown) => err instanceof DistributedLockUnavailableError
      )
      assert.equal(failClosedCounters.bookmarkSaves, 0)
    } finally {
      if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
      else process.env.UPSTASH_REDIS_REST_URL = prevUrl
      if (prevToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
      else process.env.UPSTASH_REDIS_REST_TOKEN = prevToken
    }
  })

  it('loads questions ONLY from the 1 exam containing bookmarks out of 6 published exams, and skips redundant query on first bookmark creation', async () => {
    // Part A: 6 published exams, bookmarks only in exam-3 -> listByExamId called ONLY for exam-3
    const sixExams: ExamCollection[] = Array.from({ length: 6 }, (_, i) => ({
      ...SYNTHETIC_EXAM,
      examId: `exam-${i + 1}`,
      title: `CSA Practice ${i + 1}`,
      questionCount: 2,
      status: 'published' as const,
    }))
    const listedExamQuestionIds: string[] = []
    let examsListCalled = 0

    const { repos: baseRepos } = createSyncedBookmarkTestRepos()
    const sixExamRepos: StudyRepositories = {
      ...baseRepos,
      exams: {
        async findByExamId(id) {
          return sixExams.find((e) => e.examId === id) || null
        },
        async list(opts) {
          examsListCalled += 1
          return opts?.status ? sixExams.filter((e) => e.status === opts.status) : sixExams
        },
        async upsert(e) {
          return e
        },
      },
      questions: {
        async findByQuestionId(id) {
          if (id === 'q-exam3-1') {
            return { ...SYNTHETIC_SINGLE_CHOICE_QUESTION, questionId: id, examId: 'exam-3', status: 'published' }
          }
          return null
        },
        async listByExamId(examId) {
          listedExamQuestionIds.push(examId)
          if (examId === 'exam-3') {
            return [
              { ...SYNTHETIC_SINGLE_CHOICE_QUESTION, questionId: 'q-exam3-1', examId: 'exam-3', status: 'published' },
              { ...SYNTHETIC_SINGLE_CHOICE_QUESTION, questionId: 'q-exam3-2', examId: 'exam-3', status: 'published' },
            ]
          }
          return []
        },
        async listByQuestionIds() {
          return []
        },
        async upsert(q) {
          return q
        },
      },
    }

    await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-3', questionId: 'q-exam3-1', action: 'add' },
      sixExamRepos
    )
    listedExamQuestionIds.length = 0
    examsListCalled = 0

    const queue = await getRecallQueue(SYNTHETIC_USER.userId, sixExamRepos, {
      nowIso: '2026-04-10T10:00:00.000Z',
    })
    assert.equal(queue.bookmarkedCount, 1)
    assert.equal(queue.items.length, 1)
    assert.equal(queue.items[0].prompt.questionId, 'q-exam3-1')
    assert.deepEqual(listedExamQuestionIds, ['exam-3'])
    assert.equal(examsListCalled, 0, 'Single bookmarked exam resolves via findByExamId without scanning all exams')

    // Part B: First bookmark creation under lock performs 1 queryDatabaseAll + 1 createPage (0 redundant existence lookup)
    let queryCount = 0
    let createCount = 0
    let updateCount = 0
    const rows: NotionPageRecord[] = []
    const countingClient: StudyNotionClient = {
      async queryDatabaseAll(_dbId, opts) {
        queryCount += 1
        const filter = opts?.filter as { title?: { equals?: string } } | undefined
        if (filter?.title?.equals) {
          return rows.filter((r) => {
            const prop = r.properties['Bookmark Key'] as {
              title?: Array<{ plain_text?: string; text?: { content?: string } }>
            }
            const val = prop?.title?.[0]?.plain_text ?? prop?.title?.[0]?.text?.content
            return val === filter.title?.equals
          })
        }
        return rows
      },
      async createPage(_dbId, properties) {
        createCount += 1
        const page: NotionPageRecord = { id: `page-${createCount}`, properties }
        rows.push(page)
        return page
      },
      async updatePage(pageId, properties) {
        updateCount += 1
        const idx = rows.findIndex((r) => r.id === pageId)
        rows[idx] = { ...rows[idx], properties }
        return rows[idx]
      },
      async retrievePage(pageId) {
        return rows.find((r) => r.id === pageId)!
      },
    }

    const notionRepos = createNotionStudyRepositories(
      countingClient,
      {
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
      },
      { useContentCache: false }
    )

    const wiredRepos: StudyRepositories = {
      ...baseRepos,
      bookmarks: notionRepos.bookmarks,
    }

    await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-1', action: 'add' },
      wiredRepos
    )
    assert.equal(queryCount, 1, 'First bookmark creation must issue exactly 1 lookup query (no redundant second query)')
    assert.equal(createCount, 1)
    assert.equal(updateCount, 0)

    // Subsequent update on the same repo instance reuses cached pageId (1 lookup + 1 update)
    await mutateUserBookmark(
      { userId: SYNTHETIC_USER.userId, examId: 'exam-1', questionId: 'q-2', action: 'add' },
      wiredRepos
    )
    assert.equal(queryCount, 2)
    assert.equal(createCount, 1)
    assert.equal(updateCount, 1)
  })
})
