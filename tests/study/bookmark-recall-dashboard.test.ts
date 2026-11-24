import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ExamCollection,
  FsrsCardState,
  ReviewEvent,
  StudyQuestion,
  StudyUser,
} from '../../lib/study/types'
import { ConcurrencyConflictError, type StudyRepositories } from '../../lib/study/repositories'
import { buildCardStateKey } from '../../lib/study/schemas'
import { getRecallQueue, submitRecallReview } from '../../lib/study/services/recall-service'
import { getStudyDashboardCatalog } from '../../lib/study/services/dashboard-service'
import {
  clearPracticeAttempt,
  computeDashboardOverview,
  hasLegacyBookmarks,
  listAllBookmarkedQuestionIds,
  readMockExamSummary,
  readPracticeAttempt,
  readPracticeSummary,
  readUserBookmarks,
  recordMockExamResult,
  writePracticeAttempt,
  writePracticeSummary,
  writeUserBookmarks,
  type StorageLike,
} from '../../lib/study/local-progress'
import {
  SYNTHETIC_EXAM,
  SYNTHETIC_SINGLE_CHOICE_QUESTION,
  SYNTHETIC_USER,
} from './fixtures/synthetic-study-data'

function createMemoryStorage(): StorageLike & { dump: () => Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem(key) {
      return map.has(key) ? map.get(key)! : null
    },
    setItem(key, value) {
      map.set(key, value)
    },
    removeItem(key) {
      map.delete(key)
    },
    dump() {
      return Object.fromEntries(map.entries())
    },
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
    questionText: `Question ${questionId}`,
  }
}

function createMultiExamRepos(): {
  repos: StudyRepositories
  counters: {
    examsListCalls: number
    cardStatesListCalls: number
    reviewEventsListCalls: number
  }
} {
  const exam1: ExamCollection = {
    ...SYNTHETIC_EXAM,
    examId: 'exam-1',
    title: 'CSA Exam 1',
    questionCount: 4,
    status: 'published',
  }
  const exam2: ExamCollection = {
    ...SYNTHETIC_EXAM,
    examId: 'exam-2',
    title: 'CSA Exam 2',
    questionCount: 2,
    status: 'published',
  }
  const draftExam: ExamCollection = {
    ...SYNTHETIC_EXAM,
    examId: 'exam-draft',
    title: 'Draft Exam',
    questionCount: 1,
    status: 'draft',
  }

  const users = new Map<string, StudyUser>([[SYNTHETIC_USER.userId, { ...SYNTHETIC_USER }]])
  const exams = new Map<string, ExamCollection>([
    [exam1.examId, exam1],
    [exam2.examId, exam2],
    [draftExam.examId, draftExam],
  ])
  const questions = new Map<string, StudyQuestion>([
    ['q-1', makeQuestion('q-1', 'exam-1', 'published')],
    ['q-2', makeQuestion('q-2', 'exam-1', 'published')],
    ['q-3', makeQuestion('q-3', 'exam-1', 'published')],
    ['q-4', makeQuestion('q-4', 'exam-1', 'published')],
    ['q-draft', makeQuestion('q-draft', 'exam-1', 'draft')],
    ['q-e2-1', makeQuestion('q-e2-1', 'exam-2', 'published')],
    ['q-e2-2', makeQuestion('q-e2-2', 'exam-2', 'published')],
    ['q-draft-exam', makeQuestion('q-draft-exam', 'exam-draft', 'published')],
  ])
  const cardStates = new Map<string, FsrsCardState>()
  const reviewEvents = new Map<string, ReviewEvent>()

  const counters = {
    examsListCalls: 0,
    cardStatesListCalls: 0,
    reviewEventsListCalls: 0,
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
      async save(state, options = {}) {
        const existing = cardStates.get(state.stateKey)
        if (existing) {
          if (
            typeof options.expectedRevision === 'number' &&
            existing.revision !== options.expectedRevision
          ) {
            throw new ConcurrencyConflictError(
              state.stateKey,
              options.expectedRevision,
              existing.revision
            )
          }
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
        counters.reviewEventsListCalls += 1
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
  }

  return { repos, counters }
}

describe('Bookmark-Based Active Recall Queue', () => {
  it('returns empty queue without Notion queries when no bookmarks exist', async () => {
    const { repos, counters } = createMultiExamRepos()
    const res = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      bookmarkedQuestionIds: [],
      nowIso: '2026-04-01T10:00:00.000Z',
    })

    assert.equal(res.items.length, 0)
    assert.equal(res.bookmarkedCount, 0)
    assert.equal(res.dueCount, 0)
    assert.equal(res.newCount, 0)
    assert.equal(counters.examsListCalls, 0)
    assert.equal(counters.cardStatesListCalls, 0)
  })

  it('filters bookmarks BEFORE applying queue limit and validates against published exam scope', async () => {
    const { repos } = createMultiExamRepos()
    const nowIso = '2026-04-01T10:00:00.000Z'

    // Only q-3 and q-4 are bookmarked, plus invalid/draft/other-exam IDs; limit=2 must still return q-3 and q-4
    const res = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      examId: 'exam-1',
      limit: 2,
      nowIso,
      bookmarkedQuestionIds: [
        'q-3',
        'q-4',
        'q-draft',
        'q-draft-exam',
        'q-e2-1',
        'non-existent-id',
      ],
    })

    assert.equal(res.bookmarkedCount, 2)
    assert.equal(res.newCount, 2)
    assert.equal(res.items.length, 2)
    assert.deepEqual(
      res.items.map((i) => i.prompt.questionId).sort(),
      ['q-3', 'q-4']
    )
    // Answer secrecy preserved
    assert.equal('correctOptionIds' in res.items[0].prompt, false)
    assert.equal('explanation' in res.items[0].prompt, false)
  })

  it('prioritizes bookmarked due cards before new cards, excludes not-yet-due cards, and tracks upcoming reviews', async () => {
    const { repos } = createMultiExamRepos()
    const t0 = '2026-04-01T10:00:00.000Z'

    // Schedule q-1 (easy -> due several days later) and q-2 (good -> due sooner)
    const rev1 = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-1',
        rating: 'easy',
        eventId: 'evt-bm-1',
        nowIso: t0,
      },
      repos
    )
    const rev2 = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-2',
        rating: 'again',
        eventId: 'evt-bm-2',
        nowIso: t0,
      },
      repos
    )

    // Evaluate at a timestamp where q-2 is due, q-1 is still in the future, and q-3 is a new bookmarked card
    const checkTimeIso = new Date(Date.parse(rev2.cardState.due) + 60_000).toISOString()
    assert.ok(Date.parse(rev1.cardState.due) > Date.parse(checkTimeIso))

    const queue = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      nowIso: checkTimeIso,
      limit: 10,
      bookmarkedQuestionIds: ['q-1', 'q-2', 'q-3'],
    })

    assert.equal(queue.bookmarkedCount, 3)
    assert.equal(queue.dueCount, 1)
    assert.equal(queue.newCount, 1)
    assert.deepEqual(
      queue.items.map((i) => ({ id: i.prompt.questionId, bucket: i.bucket })),
      [
        { id: 'q-2', bucket: 'due' },
        { id: 'q-3', bucket: 'new' },
      ]
    )

    // q-1 (not yet due) must be excluded from items and counted in upcomingReviews
    const upcomingTotal =
      queue.upcomingReviews.laterToday +
      queue.upcomingReviews.tomorrow +
      queue.upcomingReviews.next3Days +
      queue.upcomingReviews.next7Days +
      queue.upcomingReviews.later
    assert.equal(upcomingTotal, 1)
  })

  it('unbookmarking excludes a card without deleting FSRS state, and re-bookmarking reuses existing FSRS state', async () => {
    const { repos } = createMultiExamRepos()
    const t0 = '2026-04-01T10:00:00.000Z'

    const firstReview = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-1',
        rating: 'good',
        eventId: 'evt-rebook-1',
        nowIso: t0,
      },
      repos
    )
    const afterDueIso = new Date(Date.parse(firstReview.cardState.due) + 60_000).toISOString()

    // Unbookmark q-1 -> excluded from recall queue
    const withoutQ1 = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      nowIso: afterDueIso,
      bookmarkedQuestionIds: ['q-2'],
    })
    assert.equal(
      withoutQ1.items.some((i) => i.prompt.questionId === 'q-1'),
      false
    )

    // Persisted FSRS state and review history are untouched
    const persistedState = await repos.cardStates.findByUserAndQuestion(
      SYNTHETIC_USER.userId,
      'q-1'
    )
    assert.ok(persistedState)
    assert.equal(persistedState.revision, 1)
    assert.equal(persistedState.card.reps, 1)

    // Re-bookmark q-1 -> reuses existing FSRS state (bucket='due', reps=1, revision=1)
    const rebookmarked = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      nowIso: afterDueIso,
      bookmarkedQuestionIds: ['q-1'],
    })
    assert.equal(rebookmarked.items.length, 1)
    assert.equal(rebookmarked.items[0].prompt.questionId, 'q-1')
    assert.equal(rebookmarked.items[0].bucket, 'due')
    assert.equal(rebookmarked.items[0].reps, 1)
    assert.equal(rebookmarked.items[0].revision, 1)
  })
})

describe('Lightweight Dashboard Catalog & Local Progress Persistence', () => {
  it('getStudyDashboardCatalog fetches only published exams and never queries FSRS state or review history', async () => {
    const { repos, counters } = createMultiExamRepos()
    const catalog = await getStudyDashboardCatalog(repos)

    assert.equal(catalog.exams.length, 2)
    assert.deepEqual(
      catalog.exams.map((e) => e.examId),
      ['exam-1', 'exam-2']
    )
    assert.equal(counters.examsListCalls, 1)
    assert.equal(counters.cardStatesListCalls, 0)
    assert.equal(counters.reviewEventsListCalls, 0)
  })

  it('isolates bookmarks and progress per userId and never silently adopts legacy unscoped bookmarks', () => {
    const storage = createMemoryStorage()
    storage.setItem('study-bookmarks:exam-1', JSON.stringify({ 'q-1': true }))

    assert.equal(hasLegacyBookmarks('exam-1', storage), true)
    // Neither user inherits legacy unscoped bookmarks
    assert.deepEqual(readUserBookmarks('user-a', 'exam-1', storage), {})
    assert.deepEqual(readUserBookmarks('user-b', 'exam-1', storage), {})

    // User A bookmarks q-1 and q-2; User B bookmarks q-3
    writeUserBookmarks('user-a', 'exam-1', { 'q-1': true, 'q-2': true }, storage)
    writeUserBookmarks('user-b', 'exam-1', { 'q-3': true }, storage)

    assert.deepEqual(readUserBookmarks('user-a', 'exam-1', storage), {
      'q-1': true,
      'q-2': true,
    })
    assert.deepEqual(readUserBookmarks('user-b', 'exam-1', storage), { 'q-3': true })
    assert.deepEqual(
      listAllBookmarkedQuestionIds('user-a', ['exam-1', 'exam-2'], storage).sort(),
      ['q-1', 'q-2']
    )
  })

  it('persists and resumes Practice attempts without storing answer keys or explanations, and Restart preserves bookmarks & completed summaries', () => {
    const storage = createMemoryStorage()

    writeUserBookmarks('user-a', 'exam-1', { 'q-2': true }, storage)
    writePracticeAttempt(
      'user-a',
      'exam-1',
      {
        currentIndex: 2,
        filter: 'all',
        checkedResults: { 'q-1': true, 'q-2': false },
        selections: { 'q-1': ['B'], 'q-2': ['A'], 'q-3': ['C'] },
        completed: false,
      },
      storage,
      '2026-04-01T10:00:00.000Z'
    )

    // Verify stored payload contains zero answer keys, tokens, or explanations
    const serialized = JSON.stringify(storage.dump())
    assert.equal(serialized.includes('correctOptionIds'), false)
    assert.equal(serialized.includes('explanation'), false)
    assert.equal(serialized.includes('examToken'), false)

    // Restoring after page refresh restores progress cleanly
    const restored = readPracticeAttempt('user-a', 'exam-1', storage)
    assert.ok(restored)
    assert.equal(restored.currentIndex, 2)
    assert.deepEqual(restored.checkedResults, { 'q-1': true, 'q-2': false })
    assert.deepEqual(restored.selections, { 'q-1': ['B'], 'q-2': ['A'], 'q-3': ['C'] })
    assert.equal(restored.completed, false)

    // Complete the attempt and save summary
    writePracticeSummary(
      'user-a',
      'exam-1',
      {
        totalQuestions: 4,
        completedCount: 4,
        correctCount: 3,
        incorrectCount: 1,
        accuracyPercent: 75,
      },
      storage,
      '2026-04-01T10:10:00.000Z'
    )

    // Restart Practice clears only the ongoing attempt; bookmarks & completed summary remain intact
    clearPracticeAttempt('user-a', 'exam-1', storage)
    assert.equal(readPracticeAttempt('user-a', 'exam-1', storage), null)
    assert.deepEqual(readUserBookmarks('user-a', 'exam-1', storage), { 'q-2': true })
    const prevSummary = readPracticeSummary('user-a', 'exam-1', storage)
    assert.ok(prevSummary)
    assert.equal(prevSummary.accuracyPercent, 75)
  })

  it('tracks latest and best server-graded Mock Exam scores and computes Dashboard overview accurately', () => {
    const storage = createMemoryStorage()
    const examCatalog = [
      { examId: 'exam-1', title: 'CSA Exam 1', certificationCategory: 'CSA', questionCount: 4 },
      { examId: 'exam-2', title: 'CSA Exam 2', certificationCategory: 'CSA', questionCount: 2 },
      { examId: 'exam-3', title: 'CSA Exam 3', certificationCategory: 'CSA', questionCount: 10 },
    ]

    // Exam 1: Completed Practice (75%), Mock Exam attempted twice (80% Passed, then 65% Not Passed)
    writePracticeSummary(
      'user-a',
      'exam-1',
      {
        totalQuestions: 4,
        completedCount: 4,
        correctCount: 3,
        incorrectCount: 1,
        accuracyPercent: 75,
      },
      storage,
      '2026-04-01T09:00:00.000Z'
    )
    recordMockExamResult(
      'user-a',
      'exam-1',
      {
        scorePercent: 80,
        passed: true,
        correctCount: 4,
        incorrectCount: 1,
        skippedCount: 0,
        totalQuestions: 5,
        passThresholdPercent: 70,
      },
      storage,
      '2026-04-01T09:30:00.000Z'
    )
    recordMockExamResult(
      'user-a',
      'exam-1',
      {
        scorePercent: 65,
        passed: false,
        correctCount: 13,
        incorrectCount: 7,
        skippedCount: 0,
        totalQuestions: 20,
        passThresholdPercent: 70,
      },
      storage,
      '2026-04-01T10:30:00.000Z'
    )

    const exam1Summary = readMockExamSummary('user-a', 'exam-1', storage)
    assert.ok(exam1Summary)
    assert.equal(exam1Summary.latestScorePercent, 65)
    assert.equal(exam1Summary.latestPassed, false)
    assert.equal(exam1Summary.bestScorePercent, 80)
    assert.equal(exam1Summary.attemptsCount, 2)

    // Exam 2: In Progress Practice (1/2 checked, 100% accuracy, more recent timestamp)
    writePracticeAttempt(
      'user-a',
      'exam-2',
      {
        currentIndex: 1,
        filter: 'all',
        checkedResults: { 'q-e2-1': true },
        selections: { 'q-e2-1': ['A'] },
        completed: false,
      },
      storage,
      '2026-04-01T11:00:00.000Z'
    )

    const overview = computeDashboardOverview('user-a', examCatalog, storage)
    assert.equal(overview.totalCollections, 3)
    assert.equal(overview.completedPracticeCount, 1)
    assert.equal(overview.completedMockExamCount, 1)
    assert.equal(overview.latestPracticeAccuracy, 100)
    assert.equal(overview.bestExamScore, 80)

    // Exam 1 card
    assert.equal(overview.exams[0].practice.status, 'completed')
    assert.equal(overview.exams[0].practice.actionLabel, 'Review Practice')
    assert.equal(overview.exams[0].mockExam.status, 'not_passed')
    assert.equal(overview.exams[0].mockExam.latestScorePercent, 65)
    assert.equal(overview.exams[0].mockExam.bestScorePercent, 80)

    // Exam 2 card
    assert.equal(overview.exams[1].practice.status, 'in_progress')
    assert.equal(overview.exams[1].practice.checkedCount, 1)
    assert.equal(overview.exams[1].practice.progressPercent, 50)
    assert.equal(overview.exams[1].practice.actionLabel, 'Continue Practice')
    assert.equal(overview.exams[1].mockExam.status, 'not_attempted')

    // Exam 3 card
    assert.equal(overview.exams[2].practice.status, 'not_started')
    assert.equal(overview.exams[2].practice.actionLabel, 'Start Practice')
    assert.equal(overview.exams[2].mockExam.status, 'not_attempted')
  })

  it('handles malformed JSON and throwing browser storage gracefully', () => {
    const corrupt = createMemoryStorage()
    corrupt.setItem('study-v1:u:user-a:bookmarks:exam-1', '{invalid-json')
    corrupt.setItem('study-v1:u:user-a:practice-attempt:exam-1', JSON.stringify({ version: 99 }))

    assert.deepEqual(readUserBookmarks('user-a', 'exam-1', corrupt), {})
    assert.equal(readPracticeAttempt('user-a', 'exam-1', corrupt), null)

    const throwingStorage: StorageLike = {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
      removeItem() {
        throw new Error('SecurityError')
      },
    }
    assert.deepEqual(readUserBookmarks('user-a', 'exam-1', throwingStorage), {})
    assert.equal(writeUserBookmarks('user-a', 'exam-1', { 'q-1': true }, throwingStorage), false)
    assert.equal(readMockExamSummary('user-a', 'exam-1', throwingStorage), null)
  })
})
