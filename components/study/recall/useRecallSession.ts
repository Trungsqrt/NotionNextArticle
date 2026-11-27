'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { StudyRating } from '../../../lib/study/types'
import type {
  RecallQueueItem,
  RecallQueueResponse,
  RecallUpcomingReviews,
  RevealedRecallAnswer,
} from '../../../lib/study/services/recall-service'
import {
  applyOptimisticRecallRemoval,
  computeRecallQueueFetchLimit,
  filterPendingRemovedRecallQueue,
  type RecallBookmarkSyncSummary,
  type RecallCounts,
  type RecallRemovalEntry,
} from '../../../lib/study/recall-removal'
import { useRecallBookmarks } from './useRecallBookmarks'

export type RecallQueueStatus = 'loading' | 'refreshing' | 'error' | 'loaded'

const EMPTY_UPCOMING: RecallUpcomingReviews = {
  laterToday: 0,
  tomorrow: 0,
  next3Days: 0,
  next7Days: 0,
  later: 0,
}

function generateEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `rev-${crypto.randomUUID()}`
  }
  return `rev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export interface UseRecallSessionParams {
  userId: string
  examIdFilter: string
}

export interface RecallSessionState {
  // Queue & session progress
  queue: RecallQueueItem[]
  counts: RecallCounts
  upcomingReviews: RecallUpcomingReviews
  upcomingTotal: number
  currentIdx: number
  currentItem: RecallQueueItem | null
  completedCount: number
  queueStatus: RecallQueueStatus
  isRefreshing: boolean
  practiceHref: string

  // Active card interaction state
  showChoices: boolean
  revealed: RevealedRecallAnswer | null
  loadingReveal: boolean
  submittingRating: StudyRating | null
  error: string

  // Bookmark sync status across exams
  bookmarkSyncSummary: RecallBookmarkSyncSummary

  // Actions
  loadQueue: () => Promise<void>
  toggleChoices: () => void
  handleReveal: () => Promise<void>
  handleRate: (rating: StudyRating) => Promise<void>
  handleRemoveFromRecall: () => void
  retryBookmarkSync: () => void
  dismissError: () => void
}

/**
 * Coordinates the Active Recall review session: queue loading/refreshing with
 * stale-response guards, idempotent FSRS review submission, server answer
 * reveal, optimistic removal, and cross-exam bookmark sync recovery.
 */
export function useRecallSession({
  userId,
  examIdFilter,
}: UseRecallSessionParams): RecallSessionState {
  const [queue, setQueue] = useState<RecallQueueItem[]>([])
  const [counts, setCounts] = useState<RecallCounts>({
    due: 0,
    newCards: 0,
    bookmarked: 0,
  })
  const [upcomingReviews, setUpcomingReviews] =
    useState<RecallUpcomingReviews>(EMPTY_UPCOMING)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [completedCount, setCompletedCount] = useState(0)

  const [showChoices, setShowChoices] = useState(false)
  const [revealed, setRevealed] = useState<RevealedRecallAnswer | null>(null)
  const [queueStatus, setQueueStatus] = useState<RecallQueueStatus>('loading')
  const [loadingReveal, setLoadingReveal] = useState(false)
  const [submittingRating, setSubmittingRating] = useState<StudyRating | null>(null)
  const [error, setError] = useState('')

  // Stable eventId per card view so accidental double-clicks or retries stay idempotent
  const currentEventIdRef = useRef<string>(generateEventId())
  const hasLoadedOnceRef = useRef(false)
  const queueAbortRef = useRef<AbortController | null>(null)
  const queueSeqRef = useRef(0)
  const actionAbortRef = useRef<AbortController | null>(null)
  const actionSeqRef = useRef(0)
  const revealLockRef = useRef(false)
  const rateLockRef = useRef(false)

  const {
    bookmarkSyncSummary,
    recoverPendingBookmarkOps,
    beginQueueRequest,
    getExcludedEntriesForRequest,
    enqueueRemoval,
    retryBookmarkSync,
  } = useRecallBookmarks({ userId, examIdFilter })

  const loadQueue = useCallback(async () => {
    queueAbortRef.current?.abort()
    actionAbortRef.current?.abort()
    revealLockRef.current = false
    rateLockRef.current = false
    setLoadingReveal(false)
    setSubmittingRating(null)

    const controller = new AbortController()
    queueAbortRef.current = controller
    const seq = ++queueSeqRef.current
    const scopeFilter = examIdFilter || undefined

    // Discover & recover any persisted pending bookmark operations independently of the queue batch
    recoverPendingBookmarkOps()

    const requestSeq = beginQueueRequest()
    const excludedBeforeFetch = getExcludedEntriesForRequest(requestSeq, scopeFilter)
    const fetchLimit = computeRecallQueueFetchLimit(excludedBeforeFetch.length)

    setQueueStatus(hasLoadedOnceRef.current ? 'refreshing' : 'loading')
    setError('')

    try {
      const params = new URLSearchParams({ limit: String(fetchLimit) })
      if (examIdFilter) params.set('examId', examIdFilter)
      const res = await fetch(`/api/study/recall/queue?${params.toString()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to load due recall cards.')
      const rawData = (await res.json()) as RecallQueueResponse
      if (seq !== queueSeqRef.current) return

      // Combine tracker exclusions (including removals confirmed after this GET started)
      // with any pending removals currently stored locally across relevant exams.
      const trackerExcluded = getExcludedEntriesForRequest(requestSeq, scopeFilter)
      const latestPersistedRemovals = recoverPendingBookmarkOps()
      const mergedExcluded: RecallRemovalEntry[] = [
        ...latestPersistedRemovals,
        ...trackerExcluded,
      ]
      const data = filterPendingRemovedRecallQueue(rawData, mergedExcluded, {
        examIdFilter: scopeFilter,
      })

      hasLoadedOnceRef.current = true
      setQueue(data.items)
      setCounts({
        due: data.dueCount,
        newCards: data.newCount,
        bookmarked: data.bookmarkedCount,
      })
      setUpcomingReviews(data.upcomingReviews || EMPTY_UPCOMING)
      setCurrentIdx(0)
      setShowChoices(false)
      setRevealed(null)
      currentEventIdRef.current = generateEventId()
      setQueueStatus('loaded')
    } catch (err) {
      if (controller.signal.aborted || seq !== queueSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load recall queue.')
      setQueueStatus(hasLoadedOnceRef.current ? 'loaded' : 'error')
    }
  }, [
    examIdFilter,
    recoverPendingBookmarkOps,
    beginQueueRequest,
    getExcludedEntriesForRequest,
  ])

  useEffect(() => {
    hasLoadedOnceRef.current = false
    loadQueue()
    return () => {
      queueAbortRef.current?.abort()
      actionAbortRef.current?.abort()
      queueSeqRef.current += 1
      actionSeqRef.current += 1
    }
  }, [loadQueue])

  const currentItem = queue[currentIdx] || null

  const handleReveal = useCallback(async () => {
    if (
      !currentItem ||
      revealed ||
      loadingReveal ||
      revealLockRef.current ||
      queueStatus === 'refreshing'
    ) {
      return
    }

    revealLockRef.current = true
    actionAbortRef.current?.abort()
    const controller = new AbortController()
    actionAbortRef.current = controller
    const seq = ++actionSeqRef.current
    const queueSeqAtStart = queueSeqRef.current

    setLoadingReveal(true)
    setError('')

    try {
      const res = await fetch('/api/study/recall/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: currentItem.prompt.questionId }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to reveal answer right now.')
      const data = (await res.json()) as RevealedRecallAnswer
      if (seq !== actionSeqRef.current || queueSeqAtStart !== queueSeqRef.current) return
      setRevealed(data)
      setShowChoices(true)
    } catch (err) {
      if (
        controller.signal.aborted ||
        seq !== actionSeqRef.current ||
        queueSeqAtStart !== queueSeqRef.current
      ) {
        return
      }
      setError(err instanceof Error ? err.message : 'Unable to reveal answer.')
    } finally {
      if (seq === actionSeqRef.current) {
        revealLockRef.current = false
        setLoadingReveal(false)
      }
    }
  }, [currentItem, revealed, loadingReveal, queueStatus])

  const handleRate = useCallback(
    async (rating: StudyRating) => {
      if (
        !currentItem ||
        !revealed ||
        submittingRating ||
        rateLockRef.current ||
        queueStatus === 'refreshing'
      ) {
        return
      }

      rateLockRef.current = true
      actionAbortRef.current?.abort()
      const controller = new AbortController()
      actionAbortRef.current = controller
      const seq = ++actionSeqRef.current
      const queueSeqAtStart = queueSeqRef.current

      setSubmittingRating(rating)
      setError('')

      try {
        const res = await fetch('/api/study/recall/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questionId: currentItem.prompt.questionId,
            rating,
            eventId: currentEventIdRef.current,
            expectedRevision: currentItem.revision,
          }),
          signal: controller.signal,
        })

        if (seq !== actionSeqRef.current || queueSeqAtStart !== queueSeqRef.current) return

        if (res.status === 409) {
          setError(
            'This card was updated on another device or tab. Reloading the latest queue…'
          )
          rateLockRef.current = false
          setSubmittingRating(null)
          await loadQueue()
          return
        }

        if (!res.ok) {
          throw new Error('Could not save your review. Please try again.')
        }

        const nextIdx = currentIdx + 1
        setCompletedCount((c) => c + 1)
        setCounts((prev) => ({
          ...prev,
          due: currentItem.bucket === 'due' ? Math.max(0, prev.due - 1) : prev.due,
          newCards:
            currentItem.bucket === 'new' ? Math.max(0, prev.newCards - 1) : prev.newCards,
        }))
        setShowChoices(false)
        setRevealed(null)
        currentEventIdRef.current = generateEventId()
        setCurrentIdx(nextIdx)

        // Refresh upcoming review counts cleanly when reaching the end of the current batch
        if (nextIdx >= queue.length) {
          rateLockRef.current = false
          setSubmittingRating(null)
          await loadQueue()
          return
        }
      } catch (err) {
        if (
          controller.signal.aborted ||
          seq !== actionSeqRef.current ||
          queueSeqAtStart !== queueSeqRef.current
        ) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to save review.')
      } finally {
        if (seq === actionSeqRef.current) {
          rateLockRef.current = false
          setSubmittingRating(null)
        }
      }
    },
    [
      currentItem,
      currentIdx,
      queue.length,
      revealed,
      submittingRating,
      queueStatus,
      loadQueue,
    ]
  )

  const handleRemoveFromRecall = useCallback(() => {
    if (!currentItem || submittingRating || rateLockRef.current || queueStatus === 'refreshing') {
      return
    }

    // Cancel any in-flight reveal for the removed card without touching FSRS review state
    actionAbortRef.current?.abort()
    actionSeqRef.current += 1
    revealLockRef.current = false
    setLoadingReveal(false)

    const result = applyOptimisticRecallRemoval({ queue, currentIdx, counts })
    if (!result.removedItem) return

    setQueue(result.queue)
    setCurrentIdx(result.currentIdx)
    setCounts(result.counts)
    setShowChoices(false)
    setRevealed(null)
    setError('')
    currentEventIdRef.current = generateEventId()

    const { examId, questionId } = result.removedItem.prompt
    enqueueRemoval(examId, questionId, result.removedItem.bucket)

    if (result.shouldRefreshMoreCards) {
      void loadQueue()
    }
  }, [
    currentItem,
    submittingRating,
    queueStatus,
    queue,
    currentIdx,
    counts,
    enqueueRemoval,
    loadQueue,
  ])

  const toggleChoices = useCallback(() => {
    setShowChoices((v) => !v)
  }, [])

  const dismissError = useCallback(() => {
    setError('')
  }, [])

  const isRefreshing = queueStatus === 'refreshing'
  const practiceHref = examIdFilter
    ? `/study/practice?examId=${encodeURIComponent(examIdFilter)}`
    : '/study/practice'
  const upcomingTotal =
    upcomingReviews.laterToday +
    upcomingReviews.tomorrow +
    upcomingReviews.next3Days +
    upcomingReviews.next7Days +
    upcomingReviews.later

  return {
    queue,
    counts,
    upcomingReviews,
    upcomingTotal,
    currentIdx,
    currentItem,
    completedCount,
    queueStatus,
    isRefreshing,
    practiceHref,
    showChoices,
    revealed,
    loadingReveal,
    submittingRating,
    error,
    bookmarkSyncSummary,
    loadQueue,
    toggleChoices,
    handleReveal,
    handleRate,
    handleRemoveFromRecall,
    retryBookmarkSync,
    dismissError,
  }
}
