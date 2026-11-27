/**
 * lib/study/recall-removal.ts — Pure state helpers for Active Recall card removal
 * ────────────────────────────────────────────────────────────────────────────────
 * Keeps optimistic queue advancement, stale-queue removal protection, count
 * adjustments, batch-limit sizing, and multi-exam bookmark sync aggregation pure,
 * minimal, and Node-testable.
 */

import type { BookmarkSyncSnapshot } from './bookmark-sync'
import type { RecallQueueItem, RecallQueueResponse } from './services/recall-service'

export const DEFAULT_RECALL_QUEUE_LIMIT = 25
export const MAX_RECALL_QUEUE_LIMIT = 100

export interface RecallCounts {
  due: number
  newCards: number
  bookmarked: number
}

export interface OptimisticRecallRemovalInput {
  queue: readonly RecallQueueItem[]
  currentIdx: number
  counts: RecallCounts
}

export interface OptimisticRecallRemovalResult {
  removedItem: RecallQueueItem | null
  queue: RecallQueueItem[]
  currentIdx: number
  counts: RecallCounts
  reachedEndOfBatch: boolean
  /** True only when the current batch ended and additional due/new cards exist on the server */
  shouldRefreshMoreCards: boolean
}

/**
 * Optimistically removes the card at `currentIdx` from the Active Recall queue
 * and updates remaining counts without incrementing completed review counts or
 * submitting an FSRS rating.
 */
export function applyOptimisticRecallRemoval(
  input: OptimisticRecallRemovalInput
): OptimisticRecallRemovalResult {
  const { queue, currentIdx, counts } = input
  if (currentIdx < 0 || currentIdx >= queue.length) {
    return {
      removedItem: null,
      queue: [...queue],
      currentIdx,
      counts: { ...counts },
      reachedEndOfBatch: currentIdx >= queue.length,
      shouldRefreshMoreCards: false,
    }
  }

  const removedItem = queue[currentIdx]
  const nextQueue = [...queue.slice(0, currentIdx), ...queue.slice(currentIdx + 1)]
  const nextIdx = currentIdx < nextQueue.length ? currentIdx : nextQueue.length

  const nextCounts: RecallCounts = {
    due: removedItem.bucket === 'due' ? Math.max(0, counts.due - 1) : counts.due,
    newCards:
      removedItem.bucket === 'new' ? Math.max(0, counts.newCards - 1) : counts.newCards,
    bookmarked: Math.max(0, counts.bookmarked - 1),
  }

  const reachedEndOfBatch = nextIdx >= nextQueue.length
  const shouldRefreshMoreCards =
    reachedEndOfBatch && nextCounts.due + nextCounts.newCards > 0

  return {
    removedItem,
    queue: nextQueue,
    currentIdx: nextIdx,
    counts: nextCounts,
    reachedEndOfBatch,
    shouldRefreshMoreCards,
  }
}

/**
 * Sizes the `/api/study/recall/queue` `limit` parameter so that when pending or
 * recently-removed cards are excluded client-side, additional cards beyond the
 * standard 25-card batch are still fetched in the same single GET request.
 */
export function computeRecallQueueFetchLimit(
  excludedCount: number,
  baseLimit: number = DEFAULT_RECALL_QUEUE_LIMIT
): number {
  const safeBase = Math.max(1, Math.min(MAX_RECALL_QUEUE_LIMIT, Math.floor(baseLimit)))
  const safeExcluded = Math.max(0, Math.floor(excludedCount))
  return Math.min(MAX_RECALL_QUEUE_LIMIT, safeBase + safeExcluded)
}

export interface RecallRemovalEntry {
  examId: string
  questionId: string
  /** Known queue bucket when removed during this Active Recall session */
  bucket?: 'due' | 'new'
  /** True when the removal originated from a visible card in the current session */
  fromCurrentSession?: boolean
}

interface TrackedRemovalState extends RecallRemovalEntry {
  /** Monotonic sequence when Notion persistence was confirmed; null while still pending */
  confirmedAtSeq: number | null
}

export interface RecallRemovalTracker {
  /** Starts a recall queue GET request and returns its monotonic start sequence */
  beginQueueRequest(): number
  /** Records an optimistic or hydrated removal until confirmed and no older GETs remain */
  recordRemoval(
    examId: string,
    questionId: string,
    options?: { bucket?: 'due' | 'new'; fromCurrentSession?: boolean }
  ): void
  /** Advances confirmation sequence when a bookmark sync snapshot confirms removal */
  reconcileSyncSnapshot(examId: string, snapshot: BookmarkSyncSnapshot): void
  /**
   * Returns all cards that must be excluded from a queue response started at `requestStartSeq`:
   * - any still-pending removal (`confirmedAtSeq === null`), AND
   * - any recently-confirmed removal whose confirmation happened AFTER `requestStartSeq`
   *   so a stale in-flight GET can never reintroduce a removed card.
   */
  getExcludedEntriesForRequest(
    requestStartSeq: number,
    examIdFilter?: string
  ): RecallRemovalEntry[]
  /** Clears all tracked removals (e.g. on user account change) */
  reset(): void
}

function buildCardKey(examId: string, questionId: string): string {
  return `${examId}::${questionId}`
}

export function createRecallRemovalTracker(): RecallRemovalTracker {
  let seq = 0
  const tracked = new Map<string, TrackedRemovalState>()

  return {
    beginQueueRequest(): number {
      seq += 1
      return seq
    },

    recordRemoval(
      examId: string,
      questionId: string,
      options?: { bucket?: 'due' | 'new'; fromCurrentSession?: boolean }
    ): void {
      const cleanExam = examId.trim()
      const cleanQ = questionId.trim()
      if (!cleanExam || !cleanQ) return
      const key = buildCardKey(cleanExam, cleanQ)
      const existing = tracked.get(key)
      tracked.set(key, {
        examId: cleanExam,
        questionId: cleanQ,
        bucket: options?.bucket ?? existing?.bucket,
        fromCurrentSession: Boolean(options?.fromCurrentSession || existing?.fromCurrentSession),
        confirmedAtSeq: null,
      })
    },

    reconcileSyncSnapshot(examId: string, snapshot: BookmarkSyncSnapshot): void {
      const cleanExam = examId.trim()
      if (!cleanExam) return

      const savingSet = new Set(snapshot.savingQuestionIds)
      let confirmedBatchSeq: number | null = null

      for (const [key, entry] of tracked.entries()) {
        if (entry.examId !== cleanExam) continue

        // If the card was re-bookmarked in this controller, stop excluding it
        if (snapshot.bookmarks[entry.questionId]) {
          tracked.delete(key)
          continue
        }

        // Once server persistence confirms the card is no longer bookmarked and no op is pending,
        // stamp the confirmation sequence so older in-flight GETs still exclude it while newer
        // GETs started after confirmation see authoritative server state.
        if (
          entry.confirmedAtSeq === null &&
          snapshot.loadedFromServer &&
          !snapshot.serverBookmarks[entry.questionId] &&
          !savingSet.has(entry.questionId)
        ) {
          if (confirmedBatchSeq === null) {
            seq += 1
            confirmedBatchSeq = seq
          }
          entry.confirmedAtSeq = confirmedBatchSeq
        }
      }
    },

    getExcludedEntriesForRequest(
      requestStartSeq: number,
      examIdFilter?: string
    ): RecallRemovalEntry[] {
      const cleanFilter = examIdFilter?.trim() || ''
      const result: RecallRemovalEntry[] = []

      for (const entry of tracked.values()) {
        if (cleanFilter && entry.examId !== cleanFilter) continue
        if (entry.confirmedAtSeq === null || requestStartSeq < entry.confirmedAtSeq) {
          result.push({
            examId: entry.examId,
            questionId: entry.questionId,
            bucket: entry.bucket,
            fromCurrentSession: entry.fromCurrentSession,
          })
        }
      }

      return result
    },

    reset(): void {
      seq = 0
      tracked.clear()
    },
  }
}

/**
 * Filters cards with pending or stale-unseen removals out of a loaded server
 * recall queue and adjusts remaining counts accurately (including accounting for
 * in-session unconfirmed removals when the server response is truncated by `limit`).
 */
export function filterPendingRemovedRecallQueue(
  response: RecallQueueResponse,
  excludedRemovals:
    | ReadonlyMap<string, ReadonlySet<string>>
    | readonly RecallRemovalEntry[],
  options?: { examIdFilter?: string }
): RecallQueueResponse {
  const cleanFilter = options?.examIdFilter?.trim() || ''
  const excludedByExam = new Map<string, Map<string, RecallRemovalEntry>>()

  if (!Array.isArray(excludedRemovals)) {
    for (const [examId, qIds] of (excludedRemovals as ReadonlyMap<string, ReadonlySet<string>>).entries()) {
      if (cleanFilter && examId !== cleanFilter) continue
      if (qIds.size === 0) continue
      const inner = new Map<string, RecallRemovalEntry>()
      for (const qId of qIds) {
        inner.set(qId, { examId, questionId: qId })
      }
      excludedByExam.set(examId, inner)
    }
  } else {
    for (const entry of excludedRemovals as readonly RecallRemovalEntry[]) {
      if (cleanFilter && entry.examId !== cleanFilter) continue
      let inner = excludedByExam.get(entry.examId)
      if (!inner) {
        inner = new Map<string, RecallRemovalEntry>()
        excludedByExam.set(entry.examId, inner)
      }
      const prev = inner.get(entry.questionId)
      inner.set(entry.questionId, {
        examId: entry.examId,
        questionId: entry.questionId,
        bucket: entry.bucket ?? prev?.bucket,
        fromCurrentSession: Boolean(entry.fromCurrentSession || prev?.fromCurrentSession),
      })
    }
  }

  if (excludedByExam.size === 0) {
    return response
  }

  const keptItems: RecallQueueItem[] = []
  const matchedKeys = new Set<string>()
  let removedDue = 0
  let removedNew = 0

  for (const item of response.items) {
    const entry = excludedByExam.get(item.prompt.examId)?.get(item.prompt.questionId)
    if (entry) {
      matchedKeys.add(buildCardKey(item.prompt.examId, item.prompt.questionId))
      if (item.bucket === 'due') removedDue += 1
      else removedNew += 1
      continue
    }
    keptItems.push(item)
  }

  // If the server response was truncated by `limit` (more due/new cards exist beyond `items`),
  // also subtract any in-session unconfirmed/stale removals whose bucket we know and that
  // fell outside the returned `items` window.
  const isTruncatedBatch = response.items.length < response.totalAvailable
  if (isTruncatedBatch) {
    for (const inner of excludedByExam.values()) {
      for (const entry of inner.values()) {
        if (!entry.fromCurrentSession || !entry.bucket) continue
        if (matchedKeys.has(buildCardKey(entry.examId, entry.questionId))) continue
        if (entry.bucket === 'due') removedDue += 1
        else removedNew += 1
      }
    }
  }

  const totalRemoved = removedDue + removedNew
  if (totalRemoved === 0) {
    return response
  }

  const nextDue = Math.max(0, response.dueCount - removedDue)
  const nextNew = Math.max(0, response.newCount - removedNew)
  const nextTotalAvailable = Math.max(0, response.totalAvailable - totalRemoved)
  const nextBookmarked = Math.max(0, response.bookmarkedCount - totalRemoved)

  return {
    ...response,
    items: keptItems,
    dueCount: nextDue,
    newCount: nextNew,
    totalAvailable: nextTotalAvailable,
    bookmarkedCount: nextBookmarked,
  }
}

export interface RecallBookmarkSyncSummary {
  hasUnsyncedError: boolean
  /** True when at least one bookmark mutation is queued or in flight without an active failure */
  hasPendingSync: boolean
  isSaving: boolean
  pendingCount: number
  errorMessage: string | null
}

/**
 * Aggregates per-exam bookmark sync snapshots in Active Recall (where cards in a
 * single recall queue may belong to multiple exam collections).
 */
export function summarizeRecallBookmarkSync(
  snapshots: Iterable<BookmarkSyncSnapshot>
): RecallBookmarkSyncSummary {
  let hasUnsyncedError = false
  let isSaving = false
  let pendingCount = 0
  let errorMessage: string | null = null

  for (const snap of snapshots) {
    pendingCount += snap.pendingCount
    if (snap.status === 'saving') {
      isSaving = true
    }
    if (snap.status === 'not_synced') {
      hasUnsyncedError = true
      if (!errorMessage && snap.errorMessage) {
        errorMessage = snap.errorMessage
      }
    }
  }

  return {
    hasUnsyncedError,
    hasPendingSync: !hasUnsyncedError && (isSaving || pendingCount > 0),
    isSaving,
    pendingCount,
    errorMessage,
  }
}
