import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  StudyUser,
  ExamCollection,
  StudyQuestion,
  FsrsCardState,
  ReviewEvent,
} from '../../lib/study/types'
import {
  ConcurrencyConflictError,
  type StudyRepositories,
} from '../../lib/study/repositories'
import { buildCardStateKey } from '../../lib/study/schemas'
import {
  createInitialCardSnapshot,
  scheduleCardReview,
  previewAllRatings,
  FSRS_SCHEDULER_VERSION,
} from '../../lib/study/fsrs/scheduler'
import { getStudyDashboardData } from '../../lib/study/services/dashboard-service'
import {
  getRecallQueue,
  revealRecallAnswer,
  submitRecallReview,
  reconcileCardStateForQuestion,
  EventIdConflictError,
} from '../../lib/study/services/recall-service'
import {
  getPracticeExamPayload,
  checkPracticeAnswer,
} from '../../lib/study/services/practice-service'
import {
  startExamSession,
  submitExamSession,
} from '../../lib/study/services/exam-service'
import {
  SYNTHETIC_USER,
  SYNTHETIC_EXAM,
  SYNTHETIC_SINGLE_CHOICE_QUESTION,
  SYNTHETIC_MULTI_SELECT_QUESTION,
} from './fixtures/synthetic-study-data'

function createInMemoryRepos(): StudyRepositories {
  const users = new Map<string, StudyUser>([[SYNTHETIC_USER.userId, { ...SYNTHETIC_USER }]])
  const exams = new Map<string, ExamCollection>([[SYNTHETIC_EXAM.examId, { ...SYNTHETIC_EXAM }]])
  const questions = new Map<string, StudyQuestion>([
    [SYNTHETIC_SINGLE_CHOICE_QUESTION.questionId, { ...SYNTHETIC_SINGLE_CHOICE_QUESTION }],
    [SYNTHETIC_MULTI_SELECT_QUESTION.questionId, { ...SYNTHETIC_MULTI_SELECT_QUESTION }],
  ])
  const cardStates = new Map<string, FsrsCardState>()
  const reviewEvents = new Map<string, ReviewEvent>()

  return {
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
        } else if (typeof options.expectedRevision === 'number' && options.expectedRevision > 0) {
          throw new ConcurrencyConflictError(state.stateKey, options.expectedRevision, 0)
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
  }
}

const TEST_SECRET = 'phase5-test-secret-at-least-32-characters-long-0123456789'

describe('Phase 5 — FSRS-6 Engine (ts-fsrs)', () => {
  it('initializes new cards and transitions through New -> Learning -> Review -> Relearning', async () => {
    const t0 = '2026-03-01T10:00:00.000Z'
    const initial = await createInitialCardSnapshot('q-synth-001', t0)
    assert.equal(initial.state, 'New')
    assert.equal(initial.reps, 0)

    const previews = await previewAllRatings({ cardId: 'q-synth-001', current: initial, nowIso: t0 })
    assert.ok(Date.parse(previews.again.due) <= Date.parse(previews.good.due))
    assert.ok(Date.parse(previews.good.due) <= Date.parse(previews.easy.due))

    // Easy graduates directly to Review
    const step1 = await scheduleCardReview({
      cardId: 'q-synth-001',
      previous: initial,
      rating: 'easy',
      nowIso: t0,
    })
    assert.equal(step1.schedulerVersion, FSRS_SCHEDULER_VERSION)
    assert.equal(step1.resulting.state, 'Review')
    assert.equal(step1.resulting.reps, 1)
    assert.ok(step1.resulting.stability > 0)

    // Lapsing a Review card with Again enters Relearning and increments lapses
    const t1 = step1.resulting.due
    const step2 = await scheduleCardReview({
      cardId: 'q-synth-001',
      previous: step1.resulting,
      rating: 'again',
      nowIso: t1,
    })
    assert.equal(step2.resulting.state, 'Relearning')
    assert.equal(step2.resulting.lapses, 1)
  })
})

describe('Phase 5 — Active Recall, Cross-Device Concurrency & Multi-User Isolation', () => {
  it('serves prompt-only recall queue, saves FSRS review idempotently, updates dashboard, and isolates users', async () => {
    const repos = createInMemoryRepos()
    const nowIso = '2026-03-01T10:00:00.000Z'

    const queue = await getRecallQueue(SYNTHETIC_USER.userId, repos, { nowIso })
    assert.equal(queue.items.length, 2)
    assert.equal('correctOptionIds' in queue.items[0].prompt, false)
    assert.equal('explanation' in queue.items[0].prompt, false)

    // Reveal answer explicitly
    const revealed = await revealRecallAnswer('q-synth-001', repos)
    assert.ok(revealed)
    assert.deepEqual(revealed.correctOptionIds, ['B'])

    // Submit review
    const saved = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-synth-001',
        rating: 'good',
        eventId: 'evt-p5-001',
        expectedRevision: 0,
        nowIso,
      },
      repos
    )
    assert.equal(saved.duplicate, false)
    assert.equal(saved.cardState.revision, 1)

    // Duplicate submission with same eventId is idempotent
    const dup = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-synth-001',
        rating: 'good',
        eventId: 'evt-p5-001',
        expectedRevision: 0,
        nowIso,
      },
      repos
    )
    assert.equal(dup.duplicate, true)
    assert.equal(dup.cardState.revision, 1)

    // Stale cross-device submission with outdated expectedRevision (0 instead of 1) throws ConcurrencyConflictError
    await assert.rejects(
      () =>
        submitRecallReview(
          {
            userId: SYNTHETIC_USER.userId,
            questionId: 'q-synth-001',
            rating: 'easy',
            eventId: 'evt-p5-002',
            expectedRevision: 0,
            nowIso: '2026-03-01T10:15:00.000Z',
          },
          repos
        ),
      ConcurrencyConflictError
    )

    // Dashboard reflects real persisted progress & streak
    const dash = await getStudyDashboardData(SYNTHETIC_USER.userId, repos, nowIso)
    assert.equal(dash.totalCardsStudied, 1)
    assert.equal(dash.newCards, 1)
    assert.equal(dash.studyStreakDays, 1)
    assert.equal(dash.recentlyReviewed.length, 1)

    // Independent second user studying the same question has untouched progress
    const userBDash = await getStudyDashboardData('usr-other-002', repos, nowIso)
    assert.equal(userBDash.totalCardsStudied, 0)
    assert.equal(userBDash.newCards, 2)
  })

  it('reconciles partial failure (event written, card state save failed) on retry with same eventId', async () => {
    const repos = createInMemoryRepos()
    const origSave = repos.cardStates.save.bind(repos.cardStates)
    let failOnce = true
    repos.cardStates.save = async (state, options) => {
      if (failOnce) {
        failOnce = false
        throw new Error('Simulated Notion 503 during cardState write')
      }
      return origSave(state, options)
    }

    // First attempt: ReviewEvent succeeds, cardState save throws
    await assert.rejects(() =>
      submitRecallReview(
        {
          userId: SYNTHETIC_USER.userId,
          questionId: 'q-synth-001',
          rating: 'good',
          eventId: 'evt-partial-001',
          expectedRevision: 0,
          nowIso: '2026-03-01T10:00:00.000Z',
        },
        repos
      )
    )

    // Verify ReviewEvent was recorded while CardState is still missing
    assert.ok(await repos.reviewEvents.findByEventId('evt-partial-001'))
    assert.equal(
      await repos.cardStates.findByUserAndQuestion(SYNTHETIC_USER.userId, 'q-synth-001'),
      null
    )

    // Retry with same eventId -> reconciles CardState cleanly instead of returning stale state
    const retried = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-synth-001',
        rating: 'good',
        eventId: 'evt-partial-001',
        expectedRevision: 0,
        nowIso: '2026-03-01T10:00:00.000Z',
      },
      repos
    )
    assert.equal(retried.reconciled, true)
    assert.equal(retried.duplicate, false)
    assert.equal(retried.cardState.revision, 1)
    assert.equal(retried.cardState.card.reps, 1)
  })

  it('rejects reused eventId with different rating or questionId using EventIdConflictError', async () => {
    const repos = createInMemoryRepos()
    await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-synth-001',
        rating: 'good',
        eventId: 'evt-conflict-001',
        expectedRevision: 0,
        nowIso: '2026-03-01T10:00:00.000Z',
      },
      repos
    )

    // Same eventId with different rating
    await assert.rejects(
      () =>
        submitRecallReview(
          {
            userId: SYNTHETIC_USER.userId,
            questionId: 'q-synth-001',
            rating: 'again',
            eventId: 'evt-conflict-001',
            nowIso: '2026-03-01T10:01:00.000Z',
          },
          repos
        ),
      EventIdConflictError
    )

    // Same eventId with different questionId
    await assert.rejects(
      () =>
        submitRecallReview(
          {
            userId: SYNTHETIC_USER.userId,
            questionId: 'q-synth-002',
            rating: 'good',
            eventId: 'evt-conflict-001',
            nowIso: '2026-03-01T10:01:00.000Z',
          },
          repos
        ),
      EventIdConflictError
    )
  })

  it('recovers missing card state from latest ReviewEvent and serializes concurrent submissions', async () => {
    const repos = createInMemoryRepos()

    // Seed a ReviewEvent without a matching FsrsCardState row (simulating lost/unwritten card state)
    const step1 = await scheduleCardReview({
      cardId: 'q-synth-001',
      previous: null,
      rating: 'easy',
      nowIso: '2026-03-01T10:00:00.000Z',
    })
    await repos.reviewEvents.appendIfNotExists({
      eventId: 'evt-orphan-001',
      userId: SYNTHETIC_USER.userId,
      questionId: 'q-synth-001',
      reviewedAt: '2026-03-01T10:00:00.000Z',
      rating: 'easy',
      previousState: step1.previous,
      resultingState: step1.resulting,
      schedulerVersion: step1.schedulerVersion,
      parametersVersion: step1.parametersVersion,
    })

    // Queue does NOT scan full review history (listByUser must never be called by getRecallQueue)
    let listByUserCalled = false
    const origListByUser = repos.reviewEvents.listByUser.bind(repos.reviewEvents)
    repos.reviewEvents.listByUser = async (...args) => {
      listByUserCalled = true
      return origListByUser(...args)
    }
    await getRecallQueue(SYNTHETIC_USER.userId, repos, { nowIso: step1.resulting.due })
    assert.equal(listByUserCalled, false)

    // Dedicated idempotent question-level reconciliation recovers missing card state via O(1) lookup
    const rec1 = await reconcileCardStateForQuestion(SYNTHETIC_USER.userId, 'q-synth-001', repos)
    assert.equal(rec1.reconciled, true)
    assert.ok(rec1.state && rec1.state.card.reps === 1)

    // Calling reconcile again is a deterministic idempotent no-op
    const rec2 = await reconcileCardStateForQuestion(SYNTHETIC_USER.userId, 'q-synth-001', repos)
    assert.equal(rec2.reconciled, false)
    assert.equal(rec2.state?.revision, rec1.state?.revision)

    // Queue now reflects recovered reps=1 from persisted card state
    const queueAfterDue = await getRecallQueue(SYNTHETIC_USER.userId, repos, {
      nowIso: step1.resulting.due,
    })
    const recoveredItem = queueAfterDue.items.find((i) => i.prompt.questionId === 'q-synth-001')
    assert.ok(recoveredItem)
    assert.equal(recoveredItem.bucket, 'due')
    assert.equal(recoveredItem.reps, 1)

    // Next review schedules from recovered reps=1 (so resulting reps === 2, not reset to 1)
    const nextReview = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-synth-001',
        rating: 'good',
        eventId: 'evt-after-recover-002',
        nowIso: step1.resulting.due,
      },
      repos
    )
    assert.equal(nextReview.cardState.card.reps, 2)

    // Stale event / older timestamp cannot overwrite a newer card state
    await assert.rejects(
      () =>
        submitRecallReview(
          {
            userId: SYNTHETIC_USER.userId,
            questionId: 'q-synth-001',
            rating: 'again',
            eventId: 'evt-stale-older-003',
            nowIso: '2026-03-01T10:05:00.000Z',
          },
          repos
        ),
      ConcurrencyConflictError
    )

    // Retrying an older eventId (evt-orphan-001) after a newer review does NOT overwrite newer state
    const staleRetry = await submitRecallReview(
      {
        userId: SYNTHETIC_USER.userId,
        questionId: 'q-synth-001',
        rating: 'easy',
        eventId: 'evt-orphan-001',
        nowIso: '2026-03-01T10:00:00.000Z',
      },
      repos
    )
    assert.equal(staleRetry.duplicate, true)
    assert.equal(staleRetry.cardState.card.reps, 2)

    // Two concurrent reviews on q-synth-002 with expectedRevision=0 serialize cleanly: 1 succeeds, 1 gets 409 conflict
    const results = await Promise.allSettled([
      submitRecallReview(
        {
          userId: SYNTHETIC_USER.userId,
          questionId: 'q-synth-002',
          rating: 'good',
          eventId: 'evt-conc-001',
          expectedRevision: 0,
          nowIso: '2026-03-01T11:00:00.000Z',
        },
        repos
      ),
      submitRecallReview(
        {
          userId: SYNTHETIC_USER.userId,
          questionId: 'q-synth-002',
          rating: 'hard',
          eventId: 'evt-conc-002',
          expectedRevision: 0,
          nowIso: '2026-03-01T11:00:01.000Z',
        },
        repos
      ),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(
      rejected[0].status === 'rejected' &&
        rejected[0].reason instanceof ConcurrencyConflictError
    )
  })

  it('acquires and releases distributed Upstash Redis per-card lock and rejects when lock is held by another instance', async () => {
    const repos = createInMemoryRepos()
    const origUrl = process.env.UPSTASH_REDIS_REST_URL
    const origToken = process.env.UPSTASH_REDIS_REST_TOKEN
    const origFetch = globalThis.fetch

    try {
      process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example'
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-lock-token'

      const locks = new Map<string, string>()
      let evalReleases = 0
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const commands = JSON.parse(String(init?.body || '[]')) as string[][]
        const cmd = commands[0] || []
        if (cmd[0] === 'SET') {
          const [, key, val] = cmd
          if (locks.has(key)) {
            return new Response(JSON.stringify([{ result: null }]), { status: 200 })
          }
          locks.set(key, val)
          return new Response(JSON.stringify([{ result: 'OK' }]), { status: 200 })
        }
        if (cmd[0] === 'EXISTS') {
          const [, key] = cmd
          return new Response(JSON.stringify([{ result: locks.has(key) ? 1 : 0 }]), { status: 200 })
        }
        if (cmd[0] === 'EVAL') {
          const key = cmd[3]
          const val = cmd[4]
          if (locks.get(key) === val) {
            locks.delete(key)
            evalReleases += 1
          }
          return new Response(JSON.stringify([{ result: 1 }]), { status: 200 })
        }
        return new Response(JSON.stringify([{ result: null }]), { status: 200 })
      }) as typeof fetch

      // Normal submission acquires lock and releases it via Lua EVAL
      const ok = await submitRecallReview(
        {
          userId: SYNTHETIC_USER.userId,
          questionId: 'q-synth-001',
          rating: 'good',
          eventId: 'evt-redis-lock-001',
          nowIso: '2026-03-01T12:00:00.000Z',
        },
        repos
      )
      assert.equal(ok.cardState.revision, 1)
      assert.equal(evalReleases, 1)
      assert.equal(locks.size, 0)

      // Pre-held remote lock from another Vercel instance causes ConcurrencyConflictError
      locks.set(`study:lock:card:${buildCardStateKey(SYNTHETIC_USER.userId, 'q-synth-001')}`, 'other-instance')
      await assert.rejects(
        () =>
          submitRecallReview(
            {
              userId: SYNTHETIC_USER.userId,
              questionId: 'q-synth-001',
              rating: 'easy',
              eventId: 'evt-redis-lock-002',
              nowIso: '2026-03-01T12:05:00.000Z',
            },
            repos
          ),
        ConcurrencyConflictError
      )
    } finally {
      globalThis.fetch = origFetch
      if (origUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
      else process.env.UPSTASH_REDIS_REST_URL = origUrl
      if (origToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
      else process.env.UPSTASH_REDIS_REST_TOKEN = origToken
    }
  })
})

describe('Phase 5 — Practice Mode & Timed CSA Mock Exam Simulation', () => {
  it('grades single-choice & multi-select in Practice Mode without mutating FSRS state', async () => {
    const repos = createInMemoryRepos()
    const payload = await getPracticeExamPayload(SYNTHETIC_EXAM.examId, repos)
    assert.ok(payload)
    assert.equal(payload.questions.length, 2)
    assert.equal('correctOptionIds' in payload.questions[0], false)

    // Partial multi-select (only ['A'] when ['A', 'C'] required) -> incorrect
    const partial = await checkPracticeAnswer('q-synth-002', ['A'], repos)
    assert.ok(partial)
    assert.equal(partial.isCorrect, false)
    assert.deepEqual(partial.correctOptionIds, ['A', 'C'])

    // Exact multi-select (['C', 'A']) -> correct
    const exact = await checkPracticeAnswer('q-synth-002', ['C', 'A'], repos)
    assert.ok(exact)
    assert.equal(exact.isCorrect, true)

    // Practice checks MUST NOT touch FSRS state or review events
    const states = await repos.cardStates.listByUser(SYNTHETIC_USER.userId)
    const events = await repos.reviewEvents.listByUser(SYNTHETIC_USER.userId)
    assert.equal(states.length, 0)
    assert.equal(events.length, 0)
  })

  it('runs a timed exam without leaking answers and grades server-side with cross-user protection', async () => {
    const repos = createInMemoryRepos()
    const nowSec = 1_772_359_200

    const started = await startExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examId: SYNTHETIC_EXAM.examId,
        durationMinutes: 60,
        sessionSecret: TEST_SECRET,
        nowSec,
      },
      repos
    )
    assert.ok(started)
    assert.equal(started.questions.length, 2)
    for (const q of started.questions) {
      assert.equal('correctOptionIds' in q, false)
      assert.equal('explanation' in q, false)
    }

    // Cross-user submission rejected
    await assert.rejects(() =>
      submitExamSession(
        {
          userId: 'usr-other-999',
          examToken: started.examToken,
          answers: {},
          sessionSecret: TEST_SECRET,
          nowSec: nowSec + 120,
        },
        repos
      )
    )

    // Valid submission: Q1 correct (['B']), Q2 skipped ([]) -> 50% score
    const graded = await submitExamSession(
      {
        userId: SYNTHETIC_USER.userId,
        examToken: started.examToken,
        answers: {
          'q-synth-001': ['B'],
        },
        sessionSecret: TEST_SECRET,
        nowSec: nowSec + 300,
      },
      repos
    )
    assert.equal(graded.totalQuestions, 2)
    assert.equal(graded.correctCount, 1)
    assert.equal(graded.incorrectCount, 0)
    assert.equal(graded.skippedCount, 1)
    assert.equal(graded.scorePercent, 50)
    assert.equal(graded.passed, false)
    assert.equal(graded.reviewItems.length, 2)
    assert.ok(graded.reviewItems[0].explanation.length > 0)
  })
})
