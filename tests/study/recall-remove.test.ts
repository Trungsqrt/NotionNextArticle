import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ExamCollection,
  FsrsCardState,
  ReviewEvent,
  StudyBookmarkRecord,
  StudyQuestion,
  StudyUser,
} from '../../lib/study/types'
import type { StudyRepositories } from '../../lib/study/repositories'
import { buildBookmarkKey, buildCardStateKey } from '../../lib/study/schemas'
import {
  getRecallQueue,
  submitRecallReview,
  type RecallQueueItem,
  type RecallQueueResponse,
} from '../../lib/study/services/recall-service'
import { syncUserBookmarks } from '../../lib/study/services/bookmark-service'
import {
  createBookmarkSyncController,
  type BookmarkSyncSnapshot,
} from '../../lib/study/bookmark-sync'
import {
  listPendingBookmarkExams,
  readPendingBookmarkOps,
  writePendingBookmarkOps,
  type StorageLike,
} from '../../lib/study/local-progress'
import {
  applyOptimisticRecallRemoval,
  computeRecallQueueFetchLimit,
  createRecallRemovalTracker,
  filterPendingRemovedRecallQueue,
  summarizeRecallBookmarkSync,
} from '../../lib/study/recall-removal'
import {
  SYNTHETIC_EXAM,
  SYNTHETIC_SINGLE_CHOICE_QUESTION,
  SYNTHETIC_USER,
} from './fixtures/synthetic-study-data'

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

function makeQueueItem(
  questionId: string,
  examId: string,
  bucket: 'due' | 'new'
): RecallQueueItem {
  return {
    prompt: {
      questionId,
      examId,
      questionText: `Question ${questionId}`,
      questionType: 'single_choice',
      options: [
        { id: 'A', text: 'Option A' },
        { id: 'B', text: 'Option B' },
      ],
      imageRefs: [],
      topic: 'Core Platform',
      contentVersion: 1,
    },
    bucket,
    revision: bucket === 'due' ? 1 : 0,
    state: bucket === 'due' ? 'Review' : 'New',
    reps: bucket === 'due' ? 1 : 0,
    lapses: 0,
    due: bucket === 'due' ? '2026-06-01T00:00:00.000Z' : null,
    ratingPreviews: {
      again: { due: '2026-06-01T00:05:00.000Z', intervalLabel: '5 min', state: 'Relearning' },
      hard: { due: '2026-06-02T00:00:00.000Z', intervalLabel: '1 day', state: 'Review' },
      good: { due: '2026-06-04T00:00:00.000Z', intervalLabel: '3 days', state: 'Review' },
      easy: { due: '2026-06-08T00:00:00.000Z', intervalLabel: '7 days', state: 'Review' },
    },
  }
}

function makeQuestion(questionId: string, examId: string): StudyQuestion {
  return {
    ...SYNTHETIC_SINGLE_CHOICE_QUESTION,
    questionId,
    examId,
    status: 'published',
    questionText: `Synthetic question ${questionId}`,
  }
}

function createRecallRemovalRepos() {
  const exam: ExamCollection = {
    ...SYNTHETIC_EXAM,
    examId: 'exam-recall-1',
    title: 'CSA Recall Exam',
    questionCount: 2,
    status: 'published',
  }
  const users = new Map<string, StudyUser>([[SYNTHETIC_USER.userId, { ...SYNTHETIC_USER }]])
  const exams = new Map<string, ExamCollection>([[exam.examId, exam]])
  const questions = new Map<string, StudyQuestion>([
    ['q-1', makeQuestion('q-1', exam.examId)],
    ['q-2', makeQuestion('q-2', exam.examId)],
  ])
  const cardStates = new Map<string, FsrsCardState>()
  const reviewEvents = new Map<string, ReviewEvent>()
  const bookmarks = new Map<string, StudyBookmarkRecord>()

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
        return [...exams.values()].filter((e) => !opts?.status || e.status === opts.status)
      },
      async upsert(e) {
        exams.set(e.examId, { ...e })
        return { ...e }
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
        return [...cardStates.values()].filter((s) => s.userId === userId)
      },
      async listDueByUser(userId, asOfIso) {
        const asOf = Date.parse(asOfIso)
        return [...cardStates.values()].filter(
          (s) => s.userId === userId && Date.parse(s.due) <= asOf
        )
      },
      async save(state) {
        const stored: FsrsCardState = { ...state, card: { ...state.card } }
        cardStates.set(state.stateKey, stored)
        return { ...stored, card: { ...stored.card } }
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
        const stored: StudyBookmarkRecord = {
          ...record,
          questionIds: [...record.questionIds],
        }
        bookmarks.set(record.bookmarkKey, stored)
        return { ...stored, questionIds: [...stored.questionIds] }
      },
    },
  }

  return { repos, exam, cardStates, reviewEvents, bookmarks }
}

describe('Active Recall — Remove from Recall optimistic queue transitions', () => {
  it('optimistically removes a due card in the middle of the queue and advances immediately', () => {
    const q1 = makeQueueItem('q-1', 'exam-1', 'due')
    const q2 = makeQueueItem('q-2', 'exam-1', 'new')
    const q3 = makeQueueItem('q-3', 'exam-2', 'new')

    const result = applyOptimisticRecallRemoval({
      queue: [q1, q2, q3],
      currentIdx: 0,
      counts: { due: 1, newCards: 2, bookmarked: 5 },
    })

    assert.equal(result.removedItem?.prompt.questionId, 'q-1')
    assert.deepEqual(
      result.queue.map((item) => item.prompt.questionId),
      ['q-2', 'q-3']
    )
    assert.equal(result.currentIdx, 0)
    assert.equal(result.queue[result.currentIdx]?.prompt.questionId, 'q-2')
    assert.deepEqual(result.counts, { due: 0, newCards: 2, bookmarked: 4 })
    assert.equal(result.reachedEndOfBatch, false)
    assert.equal(result.shouldRefreshMoreCards, false)
  })

  it('handles removing the final bookmarked card gracefully -> empty state without extra refresh', () => {
    const onlyCard = makeQueueItem('q-last', 'exam-1', 'new')

    const result = applyOptimisticRecallRemoval({
      queue: [onlyCard],
      currentIdx: 0,
      counts: { due: 0, newCards: 1, bookmarked: 1 },
    })

    assert.equal(result.removedItem?.prompt.questionId, 'q-last')
    assert.equal(result.queue.length, 0)
    assert.equal(result.currentIdx, 0)
    assert.deepEqual(result.counts, { due: 0, newCards: 0, bookmarked: 0 })
    assert.equal(result.reachedEndOfBatch, true)
    assert.equal(result.shouldRefreshMoreCards, false)
  })

  it('handles removing the final due card when future upcoming bookmarked cards remain', () => {
    const ratedCard = makeQueueItem('q-1', 'exam-1', 'due')
    const finalCard = makeQueueItem('q-2', 'exam-1', 'due')

    // User already rated q-1 (currentIdx = 1), now removes q-2 while 2 future bookmarked cards exist
    const result = applyOptimisticRecallRemoval({
      queue: [ratedCard, finalCard],
      currentIdx: 1,
      counts: { due: 1, newCards: 0, bookmarked: 3 },
    })

    assert.equal(result.removedItem?.prompt.questionId, 'q-2')
    assert.equal(result.queue.length, 1)
    assert.equal(result.currentIdx, 1)
    assert.equal(result.queue[result.currentIdx], undefined)
    assert.deepEqual(result.counts, { due: 0, newCards: 0, bookmarked: 2 })
    assert.equal(result.reachedEndOfBatch, true)
    assert.equal(result.shouldRefreshMoreCards, false)
  })

  it('requests a batch refresh only when end of current batch is reached and more due/new cards exist', () => {
    const q1 = makeQueueItem('q-1', 'exam-1', 'due')

    const result = applyOptimisticRecallRemoval({
      queue: [q1],
      currentIdx: 0,
      counts: { due: 3, newCards: 2, bookmarked: 10 },
    })

    assert.deepEqual(result.counts, { due: 2, newCards: 2, bookmarked: 9 })
    assert.equal(result.reachedEndOfBatch, true)
    assert.equal(result.shouldRefreshMoreCards, true)
  })
})

describe('Active Recall — pending removal filtering and sync controller reuse', () => {
  it('filters locally pending-removed cards out of reloaded recall queues and updates counts accurately', () => {
    const serverQueue: RecallQueueResponse = {
      items: [
        makeQueueItem('q-1', 'exam-1', 'due'),
        makeQueueItem('q-2', 'exam-1', 'new'),
        makeQueueItem('q-e2', 'exam-2', 'due'),
      ],
      dueCount: 2,
      newCount: 1,
      totalAvailable: 3,
      bookmarkedCount: 5,
      upcomingReviews: {
        laterToday: 1,
        tomorrow: 1,
        next3Days: 0,
        next7Days: 0,
        later: 0,
      },
    }

    const pendingRemovals = new Map<string, Set<string>>([
      ['exam-1', new Set(['q-1'])],
    ])

    const filtered = filterPendingRemovedRecallQueue(serverQueue, pendingRemovals)
    assert.deepEqual(
      filtered.items.map((i) => i.prompt.questionId),
      ['q-2', 'q-e2']
    )
    assert.equal(filtered.dueCount, 1)
    assert.equal(filtered.newCount, 1)
    assert.equal(filtered.totalAvailable, 2)
    assert.equal(filtered.bookmarkedCount, 4)
  })

  it('reuses bookmark sync controller to remove without extra GET, preserves pending ops on failure, and recovers on retry', async () => {
    const storage = createMemoryStorage()
    const requests: Array<{ url: string; method: string; body?: unknown }> = []
    let shouldFail = true

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method || 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ url, method, body })

      if (shouldFail) {
        return new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(
        JSON.stringify({
          examId: 'exam-1',
          userId: 'usr-1',
          questionIds: ['q-remaining'],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const snapshots: BookmarkSyncSnapshot[] = []
    const ctrl = createBookmarkSyncController({
      userId: 'usr-1',
      examId: 'exam-1',
      storage,
      fetchImpl: fakeFetch,
      debounceMs: 0,
      maxRetries: 0,
      sleepFn: async () => {},
      onStateChange: (snap) => {
        snapshots.push(snap)
      },
    })

    ctrl.enqueue('q-remove-1', 'remove')

    // Wait for async flush microtasks
    await new Promise((r) => setTimeout(r, 15))

    // Zero GET requests issued; single POST action: 'sync' with remove: ['q-remove-1']
    assert.equal(requests.filter((r) => r.method === 'GET').length, 0)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/api/study/bookmarks')
    assert.deepEqual(requests[0].body, {
      action: 'sync',
      examId: 'exam-1',
      add: [],
      remove: ['q-remove-1'],
      expectedUserId: 'usr-1',
    })

    // On failure: pending op preserved in localStorage and summary surfaces retryable error
    const persistedAfterFail = readPendingBookmarkOps('usr-1', 'exam-1', storage)
    assert.equal(persistedAfterFail['q-remove-1']?.action, 'remove')
    assert.equal(snapshots[snapshots.length - 1]?.status, 'not_synced')

    const failedSummary = summarizeRecallBookmarkSync([ctrl.getSnapshot()])
    assert.equal(failedSummary.hasUnsyncedError, true)
    assert.equal(failedSummary.pendingCount, 1)
    assert.ok(failedSummary.errorMessage)

    // Retry once server recovers -> clears pending op in localStorage and clears error summary
    shouldFail = false
    await ctrl.retry()

    assert.equal(ctrl.getSnapshot().status, 'saved')
    assert.equal(ctrl.getSnapshot().pendingCount, 0)
    assert.deepEqual(readPendingBookmarkOps('usr-1', 'exam-1', storage), {})
    const recoveredSummary = summarizeRecallBookmarkSync([ctrl.getSnapshot()])
    assert.equal(recoveredSummary.hasUnsyncedError, false)
    assert.equal(recoveredSummary.pendingCount, 0)

    ctrl.destroy()
  })
})

describe('Active Recall — FSRS preservation & re-bookmarking guarantees', () => {
  it('removing a bookmark excludes the card from Active Recall while preserving FSRS state and review history, and re-bookmarking reuses existing state', async () => {
    const { repos, exam, cardStates, reviewEvents } = createRecallRemovalRepos()
    const userId = SYNTHETIC_USER.userId

    // 1. Bookmark q-1 and q-2
    await syncUserBookmarks(
      { userId, examId: exam.examId, add: ['q-1', 'q-2'], remove: [] },
      repos
    )

    // 2. Submit one FSRS review for q-1
    const reviewedAt = '2026-06-01T10:00:00.000Z'
    const reviewResult = await submitRecallReview(
      {
        userId,
        questionId: 'q-1',
        rating: 'good',
        eventId: 'evt-recall-remove-1',
        expectedRevision: 0,
        nowIso: reviewedAt,
      },
      repos
    )
    const savedStateBeforeRemoval = await repos.cardStates.findByUserAndQuestion(userId, 'q-1')
    assert.ok(savedStateBeforeRemoval)
    assert.equal(savedStateBeforeRemoval.card.reps, 1)
    assert.equal(savedStateBeforeRemoval.revision, 1)
    assert.equal(reviewEvents.size, 1)

    // 3. Remove q-1 from Recall via synchronized bookmark sync API
    await syncUserBookmarks(
      { userId, examId: exam.examId, add: [], remove: ['q-1'] },
      repos
    )

    // 4. Verify FSRS Card State & Review Events are completely untouched and no rating was auto-submitted
    const stateAfterRemoval = await repos.cardStates.findByUserAndQuestion(userId, 'q-1')
    assert.deepEqual(stateAfterRemoval, savedStateBeforeRemoval)
    assert.equal(cardStates.size, 1)
    assert.equal(reviewEvents.size, 1)

    // Even far in the future when q-1 would be due, it is excluded while unbookmarked
    const futureIso = new Date(Date.parse(reviewResult.cardState.due) + 24 * 60 * 60 * 1000).toISOString()
    const queueWhileUnbookmarked = await getRecallQueue(userId, repos, { nowIso: futureIso })
    assert.deepEqual(
      queueWhileUnbookmarked.items.map((item) => item.prompt.questionId),
      ['q-2']
    )
    assert.equal(queueWhileUnbookmarked.bookmarkedCount, 1)

    // 5. Re-bookmark q-1 -> reuses existing FSRS state (due card with reps=1, revision=1, NOT reset to New)
    await syncUserBookmarks(
      { userId, examId: exam.examId, add: ['q-1'], remove: [] },
      repos
    )
    const queueAfterRebookmark = await getRecallQueue(userId, repos, { nowIso: futureIso })
    const rebookmarkedItem = queueAfterRebookmark.items.find(
      (item) => item.prompt.questionId === 'q-1'
    )
    assert.ok(rebookmarkedItem)
    assert.equal(rebookmarkedItem.bucket, 'due')
    assert.equal(rebookmarkedItem.reps, 1)
    assert.equal(rebookmarkedItem.revision, 1)
    assert.equal(rebookmarkedItem.due, savedStateBeforeRemoval.due)

    // 6. Rating a card 'easy' never automatically removes its bookmark
    await submitRecallReview(
      {
        userId,
        questionId: 'q-1',
        rating: 'easy',
        eventId: 'evt-recall-remove-2',
        expectedRevision: 1,
        nowIso: futureIso,
      },
      repos
    )
    const storedBookmarks = await repos.bookmarks!.findByUserAndExam(userId, exam.examId)
    assert.ok(storedBookmarks?.questionIds.includes('q-1'))
  })
})

describe('Active Recall — final edge case protections', () => {
  it('discovers pending bookmark operations across all relevant exams for the authenticated user only', () => {
    const storage = createMemoryStorage()

    // User A has pending ops in two exams (neither needs to appear in the 25-card recall queue)
    writePendingBookmarkOps(
      'usr-a',
      'exam-outside-batch',
      { 'q-99': { action: 'remove', updatedAt: '2026-06-01T10:00:00.000Z', opId: 'op-1' } },
      storage
    )
    writePendingBookmarkOps(
      'usr-a',
      'exam-second',
      { 'q-201': { action: 'add', updatedAt: '2026-06-01T10:01:00.000Z', opId: 'op-2' } },
      storage
    )
    // Another user's pending ops must never be exposed
    writePendingBookmarkOps(
      'usr-b',
      'exam-other-user',
      { 'q-500': { action: 'remove', updatedAt: '2026-06-01T10:02:00.000Z', opId: 'op-3' } },
      storage
    )

    const allForUserA = listPendingBookmarkExams('usr-a', storage)
    assert.deepEqual(
      allForUserA.map((e) => e.examId).sort(),
      ['exam-outside-batch', 'exam-second']
    )
    assert.equal(allForUserA.find((e) => e.examId === 'exam-outside-batch')?.ops['q-99']?.action, 'remove')
    assert.equal(allForUserA.find((e) => e.examId === 'exam-second')?.ops['q-201']?.action, 'add')

    // Scoped filter restricts discovery to the requested exam
    const scopedForUserA = listPendingBookmarkExams('usr-a', storage, {
      examIdFilter: 'exam-outside-batch',
    })
    assert.deepEqual(
      scopedForUserA.map((e) => e.examId),
      ['exam-outside-batch']
    )
  })

  it('prevents stale recall queue responses from reintroducing a removed card even after sync completes first', async () => {
    const storage = createMemoryStorage()
    const tracker = createRecallRemovalTracker()

    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          examId: 'exam-1',
          userId: 'usr-1',
          questionIds: ['q-2'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

    const ctrl = createBookmarkSyncController({
      userId: 'usr-1',
      examId: 'exam-1',
      storage,
      fetchImpl: fakeFetch,
      debounceMs: 0,
      maxRetries: 0,
      sleepFn: async () => {},
      onStateChange: (snap) => {
        tracker.reconcileSyncSnapshot('exam-1', snap)
      },
    })

    // 1. A recall queue GET starts BEFORE removal completes
    const staleRequestSeq = tracker.beginQueueRequest()

    // 2. User removes q-1 and its bookmark sync completes BEFORE the GET resolves
    tracker.recordRemoval('exam-1', 'q-1', { bucket: 'due', fromCurrentSession: true })
    ctrl.enqueue('q-1', 'remove')
    await new Promise((r) => setTimeout(r, 15))

    // Confirm pending op is already cleared from localStorage & controller
    assert.equal(ctrl.getSnapshot().status, 'saved')
    assert.deepEqual(readPendingBookmarkOps('usr-1', 'exam-1', storage), {})

    // 3. The earlier stale GET now resolves with a snapshot that still contains q-1
    const staleServerResponse: RecallQueueResponse = {
      items: [
        makeQueueItem('q-1', 'exam-1', 'due'),
        makeQueueItem('q-2', 'exam-1', 'new'),
      ],
      dueCount: 1,
      newCount: 1,
      totalAvailable: 2,
      bookmarkedCount: 2,
      upcomingReviews: { laterToday: 0, tomorrow: 0, next3Days: 0, next7Days: 0, later: 0 },
    }
    const excludedForStale = tracker.getExcludedEntriesForRequest(staleRequestSeq)
    const filteredStale = filterPendingRemovedRecallQueue(staleServerResponse, excludedForStale)

    assert.deepEqual(
      filteredStale.items.map((item) => item.prompt.questionId),
      ['q-2']
    )
    assert.equal(filteredStale.dueCount, 0)
    assert.equal(filteredStale.newCount, 1)
    assert.equal(filteredStale.bookmarkedCount, 1)

    // 4. A fresh GET started AFTER sync confirmed does not suppress q-1 if later re-bookmarked
    const freshRequestSeq = tracker.beginQueueRequest()
    const excludedForFresh = tracker.getExcludedEntriesForRequest(freshRequestSeq)
    assert.equal(excludedForFresh.length, 0)

    ctrl.destroy()
  })

  it('sizes queue fetch limit past pending removals and avoids incorrect counts or premature completion outside the 25-card batch', () => {
    // 25 pending removals -> request limit expands to 50 (capped at 100)
    assert.equal(computeRecallQueueFetchLimit(0), 25)
    assert.equal(computeRecallQueueFetchLimit(25), 50)
    assert.equal(computeRecallQueueFetchLimit(90), 100)

    // Simulate 26 due cards on server while first 25 are pending removal locally
    const all26Items = Array.from({ length: 26 }, (_, i) =>
      makeQueueItem(`q-${i + 1}`, 'exam-1', 'due')
    )
    const serverResponseWithExpandedLimit: RecallQueueResponse = {
      items: all26Items,
      dueCount: 26,
      newCount: 0,
      totalAvailable: 26,
      bookmarkedCount: 26,
      upcomingReviews: { laterToday: 0, tomorrow: 0, next3Days: 0, next7Days: 0, later: 0 },
    }
    const tracker = createRecallRemovalTracker()
    for (let i = 1; i <= 25; i++) {
      tracker.recordRemoval('exam-1', `q-${i}`, { bucket: 'due', fromCurrentSession: true })
    }
    const reqSeq = tracker.beginQueueRequest()
    const filtered = filterPendingRemovedRecallQueue(
      serverResponseWithExpandedLimit,
      tracker.getExcludedEntriesForRequest(reqSeq)
    )

    // q-26 is preserved cleanly — no premature session completion
    assert.deepEqual(
      filtered.items.map((item) => item.prompt.questionId),
      ['q-26']
    )
    assert.equal(filtered.dueCount, 1)
    assert.equal(filtered.totalAvailable, 1)
    assert.equal(filtered.bookmarkedCount, 1)
  })

  it('does not double-decrement counts when a truncated server queue already reflects a completed removal', () => {
    // User originally had 30 due cards and removed q-1 (and q-2 is still stale-present).
    // Server already applied q-1's removal before serving this truncated 25-card batch
    // (totalAvailable = 29 > items.length = 25), so q-1 is absent from items and already
    // excluded from dueCount/totalAvailable/bookmarkedCount.
    const truncatedAlreadySyncedItems = Array.from({ length: 25 }, (_, i) =>
      makeQueueItem(`q-${i + 2}`, 'exam-1', 'due')
    )
    const truncatedResponse: RecallQueueResponse = {
      items: truncatedAlreadySyncedItems,
      dueCount: 29,
      newCount: 0,
      totalAvailable: 29,
      bookmarkedCount: 31,
      upcomingReviews: { laterToday: 2, tomorrow: 0, next3Days: 0, next7Days: 0, later: 0 },
    }

    const tracker = createRecallRemovalTracker()
    const reqSeq = tracker.beginQueueRequest()
    // q-1 was removed in this session and already persisted on the server before GET read Notion
    tracker.recordRemoval('exam-1', 'q-1', {
      bucket: 'due',
      fromCurrentSession: true,
    })

    const filteredOnlyAlreadySynced = filterPendingRemovedRecallQueue(
      truncatedResponse,
      tracker.getExcludedEntriesForRequest(reqSeq)
    )
    // Counts must remain exact (29 due / 31 bookmarked) — never double-decremented to 28 / 30
    assert.equal(filteredOnlyAlreadySynced.items.length, 25)
    assert.equal(filteredOnlyAlreadySynced.dueCount, 29)
    assert.equal(filteredOnlyAlreadySynced.newCount, 0)
    assert.equal(filteredOnlyAlreadySynced.totalAvailable, 29)
    assert.equal(filteredOnlyAlreadySynced.bookmarkedCount, 31)

    // When another excluded card (q-2) IS still present in the truncated batch, ONLY q-2 is decremented
    tracker.recordRemoval('exam-1', 'q-2', {
      bucket: 'due',
      fromCurrentSession: true,
    })
    const filteredMixed = filterPendingRemovedRecallQueue(
      truncatedResponse,
      tracker.getExcludedEntriesForRequest(reqSeq)
    )
    assert.equal(filteredMixed.items.length, 24)
    assert.equal(filteredMixed.items[0]?.prompt.questionId, 'q-3')
    assert.equal(filteredMixed.dueCount, 28)
    assert.equal(filteredMixed.totalAvailable, 28)
    assert.equal(filteredMixed.bookmarkedCount, 30)
  })

  it('tracks subtle pending sync state separately from sync failures and clears cleanly once confirmed', () => {
    const baseSnapshot: BookmarkSyncSnapshot = {
      bookmarks: {},
      serverBookmarks: {},
      loadedFromServer: false,
      isInitialLoadPending: false,
      status: 'saving',
      pendingCount: 1,
      savingQuestionIds: ['q-1'],
      lastConfirmedEvent: null,
      loadFailed: false,
      errorMessage: null,
    }

    const pendingSummary = summarizeRecallBookmarkSync([baseSnapshot])
    assert.equal(pendingSummary.hasPendingSync, true)
    assert.equal(pendingSummary.hasUnsyncedError, false)

    const failedSummary = summarizeRecallBookmarkSync([
      {
        ...baseSnapshot,
        status: 'not_synced',
        errorMessage: 'Offline — saved locally.',
      },
    ])
    assert.equal(failedSummary.hasPendingSync, false)
    assert.equal(failedSummary.hasUnsyncedError, true)
    assert.equal(failedSummary.errorMessage, 'Offline — saved locally.')

    const confirmedSummary = summarizeRecallBookmarkSync([
      {
        ...baseSnapshot,
        loadedFromServer: true,
        status: 'saved',
        pendingCount: 0,
        savingQuestionIds: [],
      },
    ])
    assert.equal(confirmedSummary.hasPendingSync, false)
    assert.equal(confirmedSummary.hasUnsyncedError, false)
    assert.equal(confirmedSummary.pendingCount, 0)
  })
})
