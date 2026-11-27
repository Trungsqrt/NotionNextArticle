'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  createBookmarkSyncController,
  type BookmarkSyncController,
  type BookmarkSyncSnapshot,
} from '../../../lib/study/bookmark-sync'
import { listPendingBookmarkExams } from '../../../lib/study/local-progress'
import {
  createRecallRemovalTracker,
  summarizeRecallBookmarkSync,
  type RecallBookmarkSyncSummary,
  type RecallRemovalEntry,
  type RecallRemovalTracker,
} from '../../../lib/study/recall-removal'

export interface UseRecallBookmarksParams {
  userId: string
  examIdFilter: string
}

export interface RecallBookmarksApi {
  bookmarkSyncSummary: RecallBookmarkSyncSummary
  /** Discovers persisted pending ops across relevant exams and flushes idle controllers */
  recoverPendingBookmarkOps: () => RecallRemovalEntry[]
  /** Marks the start of a recall queue GET so stale responses cannot reintroduce removed cards */
  beginQueueRequest: () => number
  /** Returns pending or newly-confirmed removals that must be filtered from a queue GET */
  getExcludedEntriesForRequest: (
    requestStartSeq: number,
    scopeFilter?: string
  ) => RecallRemovalEntry[]
  /** Records an optimistic Active Recall card removal and enqueues the server unbookmark */
  enqueueRemoval: (
    examId: string,
    questionId: string,
    bucket: 'due' | 'new'
  ) => void
  /** Retries any per-exam bookmark controller currently in a failed or pending state */
  retryBookmarkSync: () => void
}

/**
 * Manages per-exam BookmarkSyncController instances and the RecallRemovalTracker
 * for Active Recall (where a single review queue may span multiple exams).
 */
export function useRecallBookmarks({
  userId,
  examIdFilter,
}: UseRecallBookmarksParams): RecallBookmarksApi {
  const [bookmarkSyncByExam, setBookmarkSyncByExam] = useState<
    Record<string, BookmarkSyncSnapshot>
  >({})

  // Per-exam synchronized bookmark controllers (cards in Active Recall may span multiple exams)
  const bookmarkControllersRef = useRef<Map<string, BookmarkSyncController>>(new Map())
  const removalTrackerRef = useRef<RecallRemovalTracker>(createRecallRemovalTracker())

  const getOrCreateBookmarkController = useCallback(
    (examId: string): BookmarkSyncController => {
      const existing = bookmarkControllersRef.current.get(examId)
      if (existing) return existing

      const controller = createBookmarkSyncController({
        userId,
        examId,
        onStateChange: (snapshot) => {
          removalTrackerRef.current.reconcileSyncSnapshot(examId, snapshot)
          setBookmarkSyncByExam((prev) => ({
            ...prev,
            [examId]: snapshot,
          }))
        },
      })
      bookmarkControllersRef.current.set(examId, controller)
      const initialSnapshot = controller.getSnapshot()
      removalTrackerRef.current.reconcileSyncSnapshot(examId, initialSnapshot)
      setBookmarkSyncByExam((prev) => ({
        ...prev,
        [examId]: initialSnapshot,
      }))
      return controller
    },
    [userId]
  )

  const recoverPendingBookmarkOps = useCallback((): RecallRemovalEntry[] => {
    const scopeFilter = examIdFilter || undefined
    const persistedExams = listPendingBookmarkExams(userId, undefined, {
      examIdFilter: scopeFilter,
    })
    const discoveredRemovals: RecallRemovalEntry[] = []

    for (const { examId, ops } of persistedExams) {
      for (const [qId, op] of Object.entries(ops)) {
        if (op.action === 'remove') {
          removalTrackerRef.current.recordRemoval(examId, qId)
          discoveredRemovals.push({ examId, questionId: qId })
        }
      }
      const controller = getOrCreateBookmarkController(examId)
      const snap = controller.getSnapshot()
      if (snap.status === 'idle' && snap.pendingCount > 0) {
        void controller.flushNow()
      }
    }

    return discoveredRemovals
  }, [userId, examIdFilter, getOrCreateBookmarkController])

  // Clean up per-exam bookmark controllers and removal tracker on unmount or user change
  useEffect(() => {
    const controllers = bookmarkControllersRef.current
    const tracker = removalTrackerRef.current
    return () => {
      for (const ctrl of controllers.values()) {
        ctrl.destroy()
      }
      controllers.clear()
      tracker.reset()
      setBookmarkSyncByExam({})
    }
  }, [userId])

  // Recover pending bookmark operations across all relevant exams independently of the recall queue
  useEffect(() => {
    recoverPendingBookmarkOps()
  }, [recoverPendingBookmarkOps])

  // Passive online recovery (no polling): retry unsynced bookmark operations once connectivity returns
  useEffect(() => {
    if (typeof window === 'undefined') return
    function handleOnline() {
      recoverPendingBookmarkOps()
      for (const ctrl of bookmarkControllersRef.current.values()) {
        const snap = ctrl.getSnapshot()
        if (snap.status === 'not_synced' || snap.pendingCount > 0) {
          void ctrl.retry()
        }
      }
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [recoverPendingBookmarkOps])

  const beginQueueRequest = useCallback(
    () => removalTrackerRef.current.beginQueueRequest(),
    []
  )

  const getExcludedEntriesForRequest = useCallback(
    (requestStartSeq: number, scopeFilter?: string) =>
      removalTrackerRef.current.getExcludedEntriesForRequest(requestStartSeq, scopeFilter),
    []
  )

  const enqueueRemoval = useCallback(
    (examId: string, questionId: string, bucket: 'due' | 'new') => {
      removalTrackerRef.current.recordRemoval(examId, questionId, {
        bucket,
        fromCurrentSession: true,
      })
      const syncController = getOrCreateBookmarkController(examId)
      syncController.enqueue(questionId, 'remove')
    },
    [getOrCreateBookmarkController]
  )

  const retryBookmarkSync = useCallback(() => {
    for (const ctrl of bookmarkControllersRef.current.values()) {
      const snap = ctrl.getSnapshot()
      if (snap.status === 'not_synced' || snap.pendingCount > 0) {
        void ctrl.retry()
      }
    }
  }, [])

  const bookmarkSyncSummary = useMemo(
    () => summarizeRecallBookmarkSync(Object.values(bookmarkSyncByExam)),
    [bookmarkSyncByExam]
  )

  return {
    bookmarkSyncSummary,
    recoverPendingBookmarkOps,
    beginQueueRequest,
    getExcludedEntriesForRequest,
    enqueueRemoval,
    retryBookmarkSync,
  }
}
