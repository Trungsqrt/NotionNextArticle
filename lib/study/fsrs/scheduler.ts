/**
 * lib/study/fsrs/scheduler.ts — Pure FSRS-6 scheduling engine via `ts-fsrs`
 * ─────────────────────────────────────────────────────────────────────────
 * Wraps the maintained `ts-fsrs@6.0.0` `DefaultScheduler({ version: 'FSRS-6',
 * desiredRetention: 0.9 })` API. Kept strictly separate from UI and Notion
 * storage layers, using consistent UTC ISO-8601 timestamps everywhere.
 */

import { DefaultScheduler, Rating, State, type Grade } from 'ts-fsrs'
import type {
  FsrsCardSnapshot,
  FsrsLifecycleState,
  StudyRating,
} from '../types'

export const FSRS_DESIRED_RETENTION = 0.9
export const FSRS_SCHEDULER_VERSION = 'ts-fsrs-6.0.0/FSRS-6'
export const FSRS_PARAMETERS_VERSION = 'fsrs-6-default-r90'

type Fsrs6Scheduler = Awaited<ReturnType<typeof DefaultScheduler<'FSRS-6'>>>

let schedulerPromise: Promise<Fsrs6Scheduler> | null = null

export function getFsrsScheduler(): Promise<Fsrs6Scheduler> {
  if (!schedulerPromise) {
    schedulerPromise = DefaultScheduler({
      version: 'FSRS-6',
      desiredRetention: FSRS_DESIRED_RETENTION,
      enableShortTerm: true,
      enableFuzz: false,
    })
  }
  return schedulerPromise
}

export function studyRatingToGrade(rating: StudyRating): Grade {
  switch (rating) {
    case 'again':
      return Rating.Again
    case 'hard':
      return Rating.Hard
    case 'good':
      return Rating.Good
    case 'easy':
      return Rating.Easy
  }
}

export function fsrsStateNumToLifecycle(state: State): FsrsLifecycleState {
  switch (state) {
    case State.New:
      return 'New'
    case State.Learning:
      return 'Learning'
    case State.Review:
      return 'Review'
    case State.Relearning:
      return 'Relearning'
    default:
      return 'New'
  }
}

export function lifecycleToFsrsStateNum(state: FsrsLifecycleState): State {
  switch (state) {
    case 'New':
      return State.New
    case 'Learning':
      return State.Learning
    case 'Review':
      return State.Review
    case 'Relearning':
      return State.Relearning
  }
}

function toScheduleStatus(state: FsrsLifecycleState): 'new' | 'learning' | 'review' {
  switch (state) {
    case 'New':
      return 'new'
    case 'Learning':
    case 'Relearning':
      return 'learning'
    case 'Review':
      return 'review'
  }
}

function toUtcDate(iso?: string): Date {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid UTC timestamp: ${iso}`)
  }
  return d
}

/**
 * Formats a human-readable interval label (e.g. "1m", "10m", "1d", "2w", "3mo").
 */
export function formatIntervalLabel(nowMs: number, dueMs: number): string {
  const diffMs = Math.max(0, dueMs - nowMs)
  const minutes = Math.round(diffMs / (60 * 1000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(diffMs / (60 * 60 * 1000))
  if (hours < 24) return `${hours}h`
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000))
  if (days < 14) return `${days}d`
  if (days < 60) return `${Math.round(days / 7)}w`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}

/**
 * Initializes a brand-new FSRS card snapshot using `ts-fsrs`.
 */
export async function createInitialCardSnapshot(
  cardId: string,
  nowIso?: string
): Promise<FsrsCardSnapshot> {
  const scheduler = await getFsrsScheduler()
  const now = toUtcDate(nowIso)
  const card = scheduler.newCard({ now, cardId })
  return {
    state: fsrsStateNumToLifecycle(card.state),
    due: card.dueAt.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: 0,
    scheduledDays: card.scheduledDays,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.lastReviewAt ? card.lastReviewAt.toISOString() : null,
    learningSteps: card.learningStep,
  }
}

function snapshotToLibraryCard(snapshot: FsrsCardSnapshot, cardId: string) {
  return {
    cardId,
    state: lifecycleToFsrsStateNum(snapshot.state),
    scheduleStatus: toScheduleStatus(snapshot.state),
    dueAt: new Date(snapshot.due),
    lastReviewAt: snapshot.lastReview ? new Date(snapshot.lastReview) : null,
    stability: snapshot.stability,
    difficulty: snapshot.difficulty,
    scheduledDays: snapshot.scheduledDays,
    reps: snapshot.reps,
    lapses: snapshot.lapses,
    learningStep: snapshot.learningSteps ?? 0,
  }
}

export interface ScheduledReviewOutput {
  previous: FsrsCardSnapshot
  resulting: FsrsCardSnapshot
  intervalLabel: string
  schedulerVersion: string
  parametersVersion: string
}

/**
 * Computes the next FSRS-6 card state for a given rating (`again` | `hard` | `good` | `easy`).
 */
export async function scheduleCardReview(input: {
  cardId: string
  previous: FsrsCardSnapshot | null
  rating: StudyRating
  nowIso?: string
}): Promise<ScheduledReviewOutput> {
  const scheduler = await getFsrsScheduler()
  const now = toUtcDate(input.nowIso)
  const previous =
    input.previous ?? (await createInitialCardSnapshot(input.cardId, now.toISOString()))

  const libCard = snapshotToLibraryCard(previous, input.cardId)
  const grade = studyRatingToGrade(input.rating)
  const result = scheduler.review({
    card: libCard,
    grade,
    now,
  })

  const elapsedDays = previous.lastReview
    ? Math.max(0, (now.getTime() - Date.parse(previous.lastReview)) / (24 * 60 * 60 * 1000))
    : 0

  const resulting: FsrsCardSnapshot = {
    state: fsrsStateNumToLifecycle(result.card.state),
    due: result.card.dueAt.toISOString(),
    stability: result.card.stability,
    difficulty: result.card.difficulty,
    elapsedDays: Number(elapsedDays.toFixed(4)),
    scheduledDays: result.card.scheduledDays,
    reps: result.card.reps,
    lapses: result.card.lapses,
    lastReview: result.card.lastReviewAt
      ? result.card.lastReviewAt.toISOString()
      : now.toISOString(),
    learningSteps: result.card.learningStep,
  }

  return {
    previous,
    resulting,
    intervalLabel: formatIntervalLabel(now.getTime(), result.card.dueAt.getTime()),
    schedulerVersion: FSRS_SCHEDULER_VERSION,
    parametersVersion: FSRS_PARAMETERS_VERSION,
  }
}

export type RatingPreviewMap = Record<
  StudyRating,
  { due: string; intervalLabel: string; state: FsrsLifecycleState }
>

/**
 * Previews the next due date and interval label for all 4 ratings without mutating state.
 */
export async function previewAllRatings(input: {
  cardId: string
  current: FsrsCardSnapshot | null
  nowIso?: string
}): Promise<RatingPreviewMap> {
  const ratings: StudyRating[] = ['again', 'hard', 'good', 'easy']
  const entries = await Promise.all(
    ratings.map(async (rating) => {
      const out = await scheduleCardReview({
        cardId: input.cardId,
        previous: input.current,
        rating,
        nowIso: input.nowIso,
      })
      return [
        rating,
        {
          due: out.resulting.due,
          intervalLabel: out.intervalLabel,
          state: out.resulting.state,
        },
      ] as const
    })
  )
  return Object.fromEntries(entries) as RatingPreviewMap
}
