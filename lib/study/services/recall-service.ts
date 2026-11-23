/**
 * lib/study/services/recall-service.ts — Active Recall + FSRS orchestration
 * ──────────────────────────────────────────────────────────────────────────
 * Coordinates due/new queue selection, explicit answer revelation, idempotent
 * review submission (`eventId`), optimistic concurrency checks (`expectedRevision`),
 * partial-failure reconciliation, and `ts-fsrs` scheduling.
 *
 * Persistence & Concurrency Architecture Note:
 * Notion does NOT provide native atomic compare-and-swap (CAS) or multi-database
 * ACID transactions. This service layers four safeguards:
 *   1. Distributed per-card lease lock via Upstash Redis (`SET NX PX` + Lua release)
 *      when `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN` are configured,
 *      paired with an in-process per-card mutex for local dev/single-instance runs.
 *   2. Append-first `ReviewEvent` (immutable source of truth for idempotency).
 *   3. `expectedRevision` + monotonic `updatedAt` checks (409 Conflict on mismatch;
 *      stale events are never allowed to overwrite newer card states).
 *   4. Indexed O(1) question-level recovery (`findLatestByUserAndQuestion`) and
 *      idempotent `reconcileCardStateForQuestion` — works for users with thousands
 *      of reviews without scanning review history on queue loads.
 *
 * Important Limitation:
 * Redis lease locks + optimistic revision checks do NOT provide full ACID
 * atomicity across `ReviewEvent` and `FsrsCardState` if a lease expires mid-write
 * or a process crashes between the two Notion writes. For strict transactional
 * concurrency guarantees in multi-instance production, keep Notion as the Question
 * Bank backend and replace ONLY `FsrsCardStateRepository` + `ReviewEventRepository`
 * with a transactional SQL store (e.g., Postgres / Neon / Turso).
 */

import { randomUUID } from 'node:crypto'
import type { StudyRepositories } from '../repositories'
import { ConcurrencyConflictError } from '../repositories'
import type {
  FsrsCardState,
  ReviewEvent,
  StudyQuestion,
  StudyQuestionPrompt,
  StudyRating,
} from '../types'
import { buildCardStateKey, toQuestionPrompt } from '../schemas'
import {
  previewAllRatings,
  scheduleCardReview,
  type RatingPreviewMap,
} from '../fsrs/scheduler'
import type { OptionFeedbackItem } from './grading'

export class EventIdConflictError extends Error {
  readonly code = 'EVENT_ID_CONFLICT'
  constructor(
    public readonly eventId: string,
    public readonly reason: string
  ) {
    super(`Review eventId "${eventId}" conflicts with an existing review: ${reason}`)
    this.name = 'EventIdConflictError'
  }
}

// Per-card in-process async mutex to serialize concurrent submissions on one warm instance
const cardLocks = new Map<string, Promise<unknown>>()

async function withInProcessCardLock<T>(cardKey: string, task: () => Promise<T>): Promise<T> {
  const prev = cardLocks.get(cardKey) || Promise.resolve()
  const next = prev.then(task, task)
  const cleanup = next.then(
    () => {
      if (cardLocks.get(cardKey) === cleanup) {
        cardLocks.delete(cardKey)
      }
    },
    () => {
      if (cardLocks.get(cardKey) === cleanup) {
        cardLocks.delete(cardKey)
      }
    }
  )
  cardLocks.set(cardKey, cleanup)
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

/**
 * Acquires a best-effort distributed per-card lease lock in Upstash Redis when
 * configured, layered on top of the in-process per-card mutex. Throws
 * ConcurrencyConflictError if another instance holds the lock past the retry budget.
 */
async function withCardLock<T>(cardKey: string, task: () => Promise<T>): Promise<T> {
  return withInProcessCardLock(cardKey, async () => {
    const upstash = getUpstashLockConfig()
    if (!upstash) {
      return task()
    }

    const lockKey = `study:lock:card:${cardKey}`
    const lockToken = randomUUID()
    const ttlMs = 10000
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
      throw new ConcurrencyConflictError(cardKey, -1, -1)
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
          // Lease will expire automatically after ttlMs
        }
      }
    }
  })
}

function isStateStaleRelativeToEvent(
  state: FsrsCardState | null,
  event: ReviewEvent
): boolean {
  if (!state) return true
  const stateMs = Date.parse(state.updatedAt)
  const eventMs = Date.parse(event.reviewedAt)
  if (Number.isNaN(stateMs) || Number.isNaN(eventMs)) return false
  return stateMs < eventMs
}

/**
 * Deterministic, idempotent reconciliation for a single (userId, questionId) card.
 * Uses O(1) indexed lookup (`findLatestByUserAndQuestion`) so it works for users
 * with thousands of reviews without scanning full history. Never overwrites a
 * newer card state with an older review event.
 */
export async function reconcileCardStateForQuestion(
  userId: string,
  questionId: string,
  repos: StudyRepositories
): Promise<{ state: FsrsCardState | null; reconciled: boolean }> {
  const cardKey = buildCardStateKey(userId, questionId)
  return withCardLock(cardKey, async () => {
    const [existingState, latestEvent] = await Promise.all([
      repos.cardStates.findByUserAndQuestion(userId, questionId),
      repos.reviewEvents.findLatestByUserAndQuestion(userId, questionId),
    ])

    if (!latestEvent) {
      return { state: existingState, reconciled: false }
    }

    if (!isStateStaleRelativeToEvent(existingState, latestEvent)) {
      return { state: existingState, reconciled: false }
    }

    const baseRevision = existingState?.revision ?? 0
    const reconciledState = await repos.cardStates.save(
      {
        stateKey: cardKey,
        userId,
        questionId,
        card: latestEvent.resultingState,
        due: latestEvent.resultingState.due,
        lastReview: latestEvent.resultingState.lastReview,
        revision: baseRevision + 1,
        schedulerVersion: latestEvent.schedulerVersion,
        parametersVersion: latestEvent.parametersVersion,
        updatedAt: latestEvent.reviewedAt,
      },
      { expectedRevision: baseRevision }
    )
    return { state: reconciledState, reconciled: true }
  })
}

export interface RecallQueueItem {
  prompt: StudyQuestionPrompt
  bucket: 'due' | 'new'
  revision: number
  state: string
  reps: number
  lapses: number
  due: string | null
  ratingPreviews: RatingPreviewMap
}

export interface RecallQueueResponse {
  items: RecallQueueItem[]
  dueCount: number
  newCount: number
  totalAvailable: number
}

export interface RevealedRecallAnswer {
  questionId: string
  correctOptionIds: string[]
  explanation: string
  optionFeedback: OptionFeedbackItem[]
}

export interface SubmitRecallReviewResult {
  duplicate: boolean
  reconciled: boolean
  cardState: FsrsCardState
  event: ReviewEvent
  intervalLabel: string
}

export async function getRecallQueue(
  userId: string,
  repos: StudyRepositories,
  options?: { examId?: string; limit?: number; nowIso?: string }
): Promise<RecallQueueResponse> {
  const nowIso = options?.nowIso || new Date().toISOString()
  const nowMs = Date.parse(nowIso)
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100)

  // Only read published exams and current card states — never scan full review history on queue loads
  const [exams, userStates] = await Promise.all([
    options?.examId
      ? repos.exams.findByExamId(options.examId).then((e) => (e && e.status === 'published' ? [e] : []))
      : repos.exams.list({ status: 'published' }),
    repos.cardStates.listByUser(userId),
  ])

  const stateByQuestion = new Map<string, FsrsCardState>()
  for (const st of userStates) {
    stateByQuestion.set(st.questionId, st)
  }

  const allQuestions: StudyQuestion[] = []
  for (const exam of exams) {
    const qs = await repos.questions.listByExamId(exam.examId, { status: 'published' })
    allQuestions.push(...qs)
  }

  const dueEntries: Array<{ question: (typeof allQuestions)[number]; state: FsrsCardState; dueMs: number }> = []
  const newEntries: Array<{ question: (typeof allQuestions)[number] }> = []

  for (const q of allQuestions) {
    const st = stateByQuestion.get(q.questionId)
    if (!st || st.card.reps === 0 || st.card.state === 'New') {
      newEntries.push({ question: q })
    } else {
      const dueMs = Date.parse(st.due)
      if (!Number.isNaN(dueMs) && dueMs <= nowMs) {
        dueEntries.push({ question: q, state: st, dueMs })
      }
    }
  }

  // Due cards ordered earliest due first
  dueEntries.sort((a, b) => a.dueMs - b.dueMs)

  const selectedDue = dueEntries.slice(0, limit)
  const remainingSlots = Math.max(0, limit - selectedDue.length)
  const selectedNew = newEntries.slice(0, remainingSlots)

  const items: RecallQueueItem[] = []

  for (const entry of selectedDue) {
    const ratingPreviews = await previewAllRatings({
      cardId: entry.question.questionId,
      current: entry.state.card,
      nowIso,
    })
    items.push({
      prompt: toQuestionPrompt(entry.question),
      bucket: 'due',
      revision: entry.state.revision,
      state: entry.state.card.state,
      reps: entry.state.card.reps,
      lapses: entry.state.card.lapses,
      due: entry.state.due,
      ratingPreviews,
    })
  }

  for (const entry of selectedNew) {
    const existingNew = stateByQuestion.get(entry.question.questionId) || null
    const ratingPreviews = await previewAllRatings({
      cardId: entry.question.questionId,
      current: existingNew?.card || null,
      nowIso,
    })
    items.push({
      prompt: toQuestionPrompt(entry.question),
      bucket: 'new',
      revision: existingNew?.revision ?? 0,
      state: 'New',
      reps: 0,
      lapses: 0,
      due: null,
      ratingPreviews,
    })
  }

  return {
    items,
    dueCount: dueEntries.length,
    newCount: newEntries.length,
    totalAvailable: dueEntries.length + newEntries.length,
  }
}

export async function revealRecallAnswer(
  questionId: string,
  repos: StudyRepositories
): Promise<RevealedRecallAnswer | null> {
  const question = await repos.questions.findByQuestionId(questionId)
  if (!question || question.status !== 'published') return null

  const optionFeedback: OptionFeedbackItem[] = question.options
    .filter((o) => typeof o.feedback === 'string' && o.feedback.trim().length > 0)
    .map((o) => ({ optionId: o.id, feedback: o.feedback!.trim() }))

  return {
    questionId: question.questionId,
    correctOptionIds: [...question.correctOptionIds],
    explanation: question.explanation,
    optionFeedback,
  }
}

export async function submitRecallReview(
  input: {
    userId: string
    questionId: string
    rating: StudyRating
    eventId: string
    expectedRevision?: number
    nowIso?: string
  },
  repos: StudyRepositories
): Promise<SubmitRecallReviewResult> {
  const cardKey = buildCardStateKey(input.userId, input.questionId)
  return withCardLock(cardKey, async () => {
    const nowIso = input.nowIso || new Date().toISOString()

    // 1. Idempotency + conflict check + partial-failure reconciliation
    const existingEvent = await repos.reviewEvents.findByEventId(input.eventId)
    if (existingEvent) {
      if (existingEvent.userId !== input.userId) {
        throw new EventIdConflictError(input.eventId, 'event belongs to another user')
      }
      if (
        existingEvent.questionId !== input.questionId ||
        existingEvent.rating !== input.rating
      ) {
        throw new EventIdConflictError(
          input.eventId,
          'eventId was already used for a different question or rating'
        )
      }

      const [existingState, latestEvent] = await Promise.all([
        repos.cardStates.findByUserAndQuestion(input.userId, existingEvent.questionId),
        repos.reviewEvents.findLatestByUserAndQuestion(input.userId, existingEvent.questionId),
      ])

      // Pick the newest authoritative event so a stale retry can NEVER overwrite a newer card state
      const authoritativeEvent =
        latestEvent && Date.parse(latestEvent.reviewedAt) >= Date.parse(existingEvent.reviewedAt)
          ? latestEvent
          : existingEvent

      if (isStateStaleRelativeToEvent(existingState, authoritativeEvent)) {
        const baseRevision = existingState?.revision ?? 0
        const reconciledState = await repos.cardStates.save(
          {
            stateKey: buildCardStateKey(input.userId, authoritativeEvent.questionId),
            userId: input.userId,
            questionId: authoritativeEvent.questionId,
            card: authoritativeEvent.resultingState,
            due: authoritativeEvent.resultingState.due,
            lastReview: authoritativeEvent.resultingState.lastReview,
            revision: baseRevision + 1,
            schedulerVersion: authoritativeEvent.schedulerVersion,
            parametersVersion: authoritativeEvent.parametersVersion,
            updatedAt: authoritativeEvent.reviewedAt,
          },
          { expectedRevision: baseRevision }
        )
        return {
          duplicate: false,
          reconciled: true,
          cardState: reconciledState,
          event: existingEvent,
          intervalLabel: '',
        }
      }

      return {
        duplicate: true,
        reconciled: false,
        cardState: existingState!,
        event: existingEvent,
        intervalLabel: '',
      }
    }

    // 2. Verify question exists and is published
    const question = await repos.questions.findByQuestionId(input.questionId)
    if (!question || question.status !== 'published') {
      throw new Error('Question not found or unavailable')
    }

    // 3. Load current user-scoped card state & recover from latest question-level event if missing/stale
    const storedState = await repos.cardStates.findByUserAndQuestion(
      input.userId,
      input.questionId
    )
    const currentRevision = storedState?.revision ?? 0

    if (
      typeof input.expectedRevision === 'number' &&
      input.expectedRevision !== currentRevision
    ) {
      throw new ConcurrencyConflictError(
        cardKey,
        input.expectedRevision,
        currentRevision
      )
    }

    // Prevent an older timestamp from overwriting a newer persisted card state
    if (storedState && Date.parse(nowIso) < Date.parse(storedState.updatedAt)) {
      throw new ConcurrencyConflictError(cardKey, currentRevision, currentRevision)
    }

    let previousCard = storedState?.card ?? null
    if (!storedState) {
      const latestEvent = await repos.reviewEvents.findLatestByUserAndQuestion(
        input.userId,
        input.questionId
      )
      if (latestEvent) {
        if (Date.parse(nowIso) < Date.parse(latestEvent.reviewedAt)) {
          throw new ConcurrencyConflictError(cardKey, currentRevision, currentRevision)
        }
        previousCard = latestEvent.resultingState
      }
    }

    // 4. Compute next FSRS-6 state using ts-fsrs
    const scheduled = await scheduleCardReview({
      cardId: input.questionId,
      previous: previousCard,
      rating: input.rating,
      nowIso,
    })

    // 5. Append immutable ReviewEvent FIRST (append-only source of truth)
    const reviewEvent: ReviewEvent = {
      eventId: input.eventId,
      userId: input.userId,
      questionId: input.questionId,
      reviewedAt: nowIso,
      rating: input.rating,
      previousState: scheduled.previous,
      resultingState: scheduled.resulting,
      schedulerVersion: scheduled.schedulerVersion,
      parametersVersion: scheduled.parametersVersion,
    }

    const appended = await repos.reviewEvents.appendIfNotExists(reviewEvent)
    if (!appended.created) {
      if (
        appended.event.userId !== input.userId ||
        appended.event.questionId !== input.questionId ||
        appended.event.rating !== input.rating
      ) {
        throw new EventIdConflictError(
          input.eventId,
          'concurrent submission reused eventId with different payload'
        )
      }
      const latestState = await repos.cardStates.findByUserAndQuestion(
        input.userId,
        input.questionId
      )
      if (latestState && !isStateStaleRelativeToEvent(latestState, appended.event)) {
        return {
          duplicate: true,
          reconciled: false,
          cardState: latestState,
          event: appended.event,
          intervalLabel: '',
        }
      }
    }

    // 6. Persist updated FSRS card state with incremented revision
    const effectiveResulting = appended.event.resultingState
    const effectiveReviewedAt = appended.event.reviewedAt
    const nextCardState: FsrsCardState = {
      stateKey: cardKey,
      userId: input.userId,
      questionId: input.questionId,
      card: effectiveResulting,
      due: effectiveResulting.due,
      lastReview: effectiveResulting.lastReview,
      revision: currentRevision + 1,
      schedulerVersion: appended.event.schedulerVersion,
      parametersVersion: appended.event.parametersVersion,
      updatedAt: effectiveReviewedAt,
    }

    const savedState = await repos.cardStates.save(nextCardState, {
      expectedRevision: currentRevision,
    })

    return {
      duplicate: !appended.created,
      reconciled: !appended.created,
      cardState: savedState,
      event: appended.event,
      intervalLabel: scheduled.intervalLabel,
    }
  })
}
