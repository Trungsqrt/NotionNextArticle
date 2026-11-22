/**
 * lib/study/services/recall-service.ts — Active Recall + FSRS orchestration
 * ──────────────────────────────────────────────────────────────────────────
 * Coordinates due/new queue selection, explicit answer revelation, idempotent
 * review submission (`eventId`), optimistic concurrency checks (`expectedRevision`),
 * and `ts-fsrs` scheduling. Never exposes answer keys in the initial queue.
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
  const nowIso = input.nowIso || new Date().toISOString()

  // 1. Idempotency check: prevent duplicate review submissions
  const existingEvent = await repos.reviewEvents.findByEventId(input.eventId)
  if (existingEvent) {
    if (existingEvent.userId !== input.userId) {
      throw new Error('Event ID belongs to another user')
    }
    const existingState = await repos.cardStates.findByUserAndQuestion(
      input.userId,
      existingEvent.questionId
    )
    if (existingState) {
      return {
        duplicate: true,
        cardState: existingState,
        event: existingEvent,
        intervalLabel: '',
      }
    }
  }

  // 2. Verify question exists and is published
  const question = await repos.questions.findByQuestionId(input.questionId)
  if (!question || question.status !== 'published') {
    throw new Error('Question not found or unavailable')
  }

  // 3. Load current user-scoped card state & check optimistic concurrency
  const currentState = await repos.cardStates.findByUserAndQuestion(
    input.userId,
    input.questionId
  )
  const currentRevision = currentState?.revision ?? 0

  if (
    typeof input.expectedRevision === 'number' &&
    input.expectedRevision !== currentRevision
  ) {
    throw new ConcurrencyConflictError(
      buildCardStateKey(input.userId, input.questionId),
      input.expectedRevision,
      currentRevision
    )
  }

  // 4. Compute next FSRS-6 state using ts-fsrs
  const scheduled = await scheduleCardReview({
    cardId: input.questionId,
    previous: currentState?.card ?? null,
    rating: input.rating,
    nowIso,
  })

  // 5. Append immutable ReviewEvent FIRST (append-only safeguard)
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

  // 6. Persist updated FSRS card state with incremented revision
  const nextCardState: FsrsCardState = {
    stateKey: buildCardStateKey(input.userId, input.questionId),
    userId: input.userId,
    questionId: input.questionId,
    card: scheduled.resulting,
    due: scheduled.resulting.due,
    lastReview: scheduled.resulting.lastReview,
    revision: currentRevision + 1,
    schedulerVersion: scheduled.schedulerVersion,
    parametersVersion: scheduled.parametersVersion,
    updatedAt: nowIso,
  }

  const savedState = await repos.cardStates.save(nextCardState, {
    expectedRevision: currentRevision,
  })

  return {
    duplicate: !appended.created,
    cardState: savedState,
    event: appended.event,
    intervalLabel: scheduled.intervalLabel,
  }
}
