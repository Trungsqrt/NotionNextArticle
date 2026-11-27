/**
 * lib/study/recall-removal.ts — Pure state helpers for Active Recall card removal
 * ────────────────────────────────────────────────────────────────────────────────
 * Keeps optimistic queue advancement, count updates, pending-removal filtering,
 * and multi-exam bookmark sync aggregation pure, minimal, and Node-testable.
 */

import type { BookmarkSyncSnapshot } from './bookmark-sync'
import type { RecallQueueItem, RecallQueueResponse } from './services/recall-service'

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
 * Filters cards with locally pending `'remove'` bookmark operations out of a
 * freshly loaded server recall queue so unsynced removals never reappear while
 * waiting for retry or background sync confirmation.
 */
export function filterPendingRemovedRecallQueue(
  response: RecallQueueResponse,
  pendingRemoveIdsByExam: ReadonlyMap<string, ReadonlySet<string>>
): RecallQueueResponse {
  if (pendingRemoveIdsByExam.size === 0 || response.items.length === 0) {
    return response
  }

  const keptItems: RecallQueueItem[] = []
  let removedDue = 0
  let removedNew = 0

  for (const item of response.items) {
    const examRemovals = pendingRemoveIdsByExam.get(item.prompt.examId)
    if (examRemovals?.has(item.prompt.questionId)) {
      if (item.bucket === 'due') removedDue += 1
      else removedNew += 1
      continue
    }
    keptItems.push(item)
  }

  const totalRemoved = removedDue + removedNew
  if (totalRemoved === 0) {
    return response
  }

  return {
    ...response,
    items: keptItems,
    dueCount: Math.max(0, response.dueCount - removedDue),
    newCount: Math.max(0, response.newCount - removedNew),
    totalAvailable: Math.max(0, response.totalAvailable - totalRemoved),
    bookmarkedCount: Math.max(0, response.bookmarkedCount - totalRemoved),
  }
}

export interface RecallBookmarkSyncSummary {
  hasUnsyncedError: boolean
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
    isSaving,
    pendingCount,
    errorMessage,
  }
}
