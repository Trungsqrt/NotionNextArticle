/**
 * lib/study/services/recall-service.ts — Active Recall + FSRS orchestration
 * ──────────────────────────────────────────────────────────────────────────
 * Coordinates due/new queue selection, explicit answer revelation, idempotent
 * review submission (`eventId`), optimistic concurrency checks (`expectedRevision`),
 * partial-failure reconciliation, and `ts-fsrs` scheduling.
 *
 * Persistence note: Notion does NOT provide native atomic CAS or multi-database
 * transactions. This service mitigates non-transactional writes with:
 *   1. Append-first `ReviewEvent` (immutable source of truth for idempotency)
 *   2. Per-card in-process serialization queue for concurrent requests on one instance
 *   3. `expectedRevision` optimistic concurrency check (409 Conflict on mismatch)
 *   4. Automatic partial-failure reconciliation when retrying an `eventId` whose
 *      `ReviewEvent` succeeded but `FsrsCardState` write failed or is stale
 *   5. Missing/stale card state recovery from the latest `ReviewEvent`
 */

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

// Per-card in-process async mutex to serialize concurrent submissions on the same warm instance
const cardLocks = new Map<string, Promise<unknown>>()

async function withCardLock<T>(cardKey: string, task: () => Promise<T>): Promise<T> {
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

function findLatestEventForQuestion(
  events: ReviewEvent[],
  questionId: string
): ReviewEvent | null {
  let latest: ReviewEvent | null = null
  let latestMs = -Infinity
  for (const ev of events) {
    if (ev.questionId !== questionId) continue
    const ms = Date.parse(ev.reviewedAt)
    if (!Number.isNaN(ms) && ms >= latestMs) {
      latestMs = ms
      latest = ev
    }
  }
  return latest
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

  const [exams, userStates, userEvents] = await Promise.all([
    options?.examId
      ? repos.exams.findByExamId(options.examId).then((e) => (e && e.status === 'published' ? [e] : []))
      : repos.exams.list({ status: 'published' }),
    repos.cardStates.listByUser(userId),
    repos.reviewEvents.listByUser(userId, { limit: 500 }),
  ])

  const stateByQuestion = new Map<string, FsrsCardState>()
  for (const st of userStates) {
    stateByQuestion.set(st.questionId, st)
  }

  // Recover any missing or stale card states from latest ReviewEvent (partial-failure safeguard)
  const latestEventByQuestion = new Map<string, ReviewEvent>()
  for (const ev of userEvents) {
    const prev = latestEventByQuestion.get(ev.questionId)
    if (!prev || Date.parse(ev.reviewedAt) >= Date.parse(prev.reviewedAt)) {
      latestEventByQuestion.set(ev.questionId, ev)
    }
  }
  for (const [questionId, latestEv] of latestEventByQuestion.entries()) {
    const existing = stateByQuestion.get(questionId) || null
    if (isStateStaleRelativeToEvent(existing, latestEv)) {
      stateByQuestion.set(questionId, {
        stateKey: buildCardStateKey(userId, questionId),
        userId,
        questionId,
        card: latestEv.resultingState,
        due: latestEv.resultingState.due,
        lastReview: latestEv.resultingState.lastReview,
        revision: existing?.revision ?? 0,
        schedulerVersion: latestEv.schedulerVersion,
        parametersVersion: latestEv.parametersVersion,
        updatedAt: latestEv.reviewedAt,
      })
    }
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

      const existingState = await repos.cardStates.findByUserAndQuestion(
        input.userId,
        existingEvent.questionId
      )

      // If card state is missing or older than the already-committed ReviewEvent,
      // reconcile card state from existingEvent.resultingState instead of returning stale state.
      if (isStateStaleRelativeToEvent(existingState, existingEvent)) {
        const baseRevision = existingState?.revision ?? 0
        const reconciledState = await repos.cardStates.save(
          {
            stateKey: buildCardStateKey(input.userId, existingEvent.questionId),
            userId: input.userId,
            questionId: existingEvent.questionId,
            card: existingEvent.resultingState,
            due: existingEvent.resultingState.due,
            lastReview: existingEvent.resultingState.lastReview,
            revision: baseRevision + 1,
            schedulerVersion: existingEvent.schedulerVersion,
            parametersVersion: existingEvent.parametersVersion,
            updatedAt: existingEvent.reviewedAt,
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

    // 3. Load current user-scoped card state & recover from ReviewEvents if missing/stale
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

    let previousCard = storedState?.card ?? null
    if (!storedState) {
      const userEvents = await repos.reviewEvents.listByUser(input.userId, { limit: 500 })
      const latestEvent = findLatestEventForQuestion(userEvents, input.questionId)
      if (latestEvent) {
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
