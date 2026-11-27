'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PracticeExamPayload } from '../../../lib/study/services/practice-service'
import {
  clearLegacyLocalBookmarks,
  readLegacyLocalBookmarksForImport,
} from '../../../lib/study/local-progress'
import {
  createBookmarkSyncController,
  createQuestionBookmarkFeedback,
  type BookmarkSyncController,
  type BookmarkSyncSnapshot,
  type BookmarkTransientFeedbackPhase,
  type QuestionBookmarkFeedbackController,
} from '../../../lib/study/bookmark-sync'
import type { LegacyBookmarkImportCandidate } from './types'

export const INITIAL_BOOKMARK_SYNC_SNAPSHOT: BookmarkSyncSnapshot = {
  bookmarks: {},
  serverBookmarks: {},
  loadedFromServer: false,
  isInitialLoadPending: false,
  status: 'idle',
  pendingCount: 0,
  savingQuestionIds: [],
  lastConfirmedEvent: null,
  loadFailed: false,
  errorMessage: null,
}

export interface UsePracticeBookmarksParams {
  userId: string
  activeExamId: string
  payload: PracticeExamPayload | null
  isCurrentSession: (sessionVersion: number, examId: string) => boolean
  getCurrentSessionVersion: () => number
}

export interface PracticeBookmarksHandle {
  bookmarkSync: BookmarkSyncSnapshot
  bookmarks: Record<string, boolean>
  bookmarkFeedbackPhase: BookmarkTransientFeedbackPhase
  legacyImportCandidate: LegacyBookmarkImportCandidate | null
  importingLegacy: boolean
  legacyImportError: string | null
  /**
   * Tears down any previous exam's controller (flushing debounced ops in the
   * background), creates a new controller for `examId`, and returns its
   * immediate optimistic snapshot so exam restoration stays atomic.
   */
  initializeForExam: (params: {
    examId: string
    validQuestionIds: ReadonlySet<string>
    sessionVersion: number
  }) => {
    controller: BookmarkSyncController
    initialSnapshot: BookmarkSyncSnapshot
  }
  setActiveQuestion: (questionId: string | null) => void
  toggleBookmark: (questionId: string) => void
  retryBookmarkSync: () => void
  importLegacyBookmarks: (examId: string, questionIds: string[]) => Promise<void>
  dismissLegacyImport: () => void
  destroy: () => void
}

/**
 * Coordinates Practice Mode's non-blocking bookmark synchronization,
 * question-scoped transient save feedback, passive online retry, and one-time
 * legacy browser-local bookmark import.
 *
 * Delegates all coalescing, retry, and localStorage pending-op mechanics to
 * `createBookmarkSyncController` and `createQuestionBookmarkFeedback`.
 */
export function usePracticeBookmarks({
  userId,
  activeExamId,
  payload,
  isCurrentSession,
  getCurrentSessionVersion,
}: UsePracticeBookmarksParams): PracticeBookmarksHandle {
  const [bookmarkSync, setBookmarkSync] = useState<BookmarkSyncSnapshot>(
    INITIAL_BOOKMARK_SYNC_SNAPSHOT
  )
  const [bookmarkFeedbackPhase, setBookmarkFeedbackPhase] =
    useState<BookmarkTransientFeedbackPhase>('hidden')
  const [legacyImportCandidate, setLegacyImportCandidate] =
    useState<LegacyBookmarkImportCandidate | null>(null)
  const [importingLegacy, setImportingLegacy] = useState(false)
  const [legacyImportError, setLegacyImportError] = useState<string | null>(null)

  const bookmarkSyncRef = useRef<BookmarkSyncController | null>(null)
  const bookmarkFeedbackRef = useRef<QuestionBookmarkFeedbackController | null>(null)
  const checkedLegacyImportExamRef = useRef<string>('')

  // Initialize question-scoped bookmark feedback controller on mount
  useEffect(() => {
    const feedbackCtrl = createQuestionBookmarkFeedback({
      onPhaseChange: setBookmarkFeedbackPhase,
      loadingDelayMs: 400,
      successDurationMs: 600,
    })
    bookmarkFeedbackRef.current = feedbackCtrl

    return () => {
      bookmarkSyncRef.current?.destroy()
      bookmarkSyncRef.current = null
      feedbackCtrl.destroy()
      bookmarkFeedbackRef.current = null
    }
  }, [])

  // Passive online recovery (no polling): retry unsynced bookmarks once connectivity returns
  useEffect(() => {
    if (typeof window === 'undefined') return
    function handleOnline() {
      const ctrl = bookmarkSyncRef.current
      if (!ctrl) return
      const snap = ctrl.getSnapshot()
      if (snap.status === 'not_synced' || snap.pendingCount > 0 || snap.loadFailed) {
        void ctrl.retry()
      }
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  // Offer explicit one-time import of legacy browser-local bookmarks once server state loads
  useEffect(() => {
    if (
      !payload ||
      !bookmarkSync.loadedFromServer ||
      payload.exam.examId !== activeExamId ||
      checkedLegacyImportExamRef.current === activeExamId
    ) {
      return
    }
    checkedLegacyImportExamRef.current = activeExamId
    const validIds = new Set(payload.questions.map((q) => q.questionId))
    const legacyIds = readLegacyLocalBookmarksForImport(userId, activeExamId).filter(
      (qId) =>
        validIds.has(qId) && !bookmarkSync.serverBookmarks[qId] && !bookmarkSync.bookmarks[qId]
    )
    if (legacyIds.length > 0) {
      setLegacyImportCandidate({ examId: activeExamId, questionIds: legacyIds })
    }
  }, [
    payload,
    activeExamId,
    userId,
    bookmarkSync.loadedFromServer,
    bookmarkSync.serverBookmarks,
    bookmarkSync.bookmarks,
  ])

  const initializeForExam = useCallback(
    ({
      examId,
      validQuestionIds,
      sessionVersion,
    }: {
      examId: string
      validQuestionIds: ReadonlySet<string>
      sessionVersion: number
    }) => {
      // Tear down any previous exam's sync controller (flushes pending debounced ops in background)
      bookmarkSyncRef.current?.destroy()

      const controller = createBookmarkSyncController({
        userId,
        examId,
        validQuestionIds,
        onStateChange: (snapshot) => {
          // Ignore late callbacks from a superseded exam session
          if (!isCurrentSession(sessionVersion, examId)) {
            return
          }
          setBookmarkSync(snapshot)
          bookmarkFeedbackRef.current?.onSyncSnapshot(snapshot)
        },
      })
      bookmarkSyncRef.current = controller
      checkedLegacyImportExamRef.current = ''

      const initialSnapshot = controller.getSnapshot()
      setBookmarkSync(initialSnapshot)
      setLegacyImportCandidate(null)
      setLegacyImportError(null)

      return { controller, initialSnapshot }
    },
    [userId, isCurrentSession]
  )

  const setActiveQuestion = useCallback((questionId: string | null) => {
    bookmarkFeedbackRef.current?.setActiveQuestion(questionId)
  }, [])

  const toggleBookmark = useCallback((questionId: string) => {
    bookmarkFeedbackRef.current?.onBookmarkTriggered(questionId)
    bookmarkSyncRef.current?.toggle(questionId)
  }, [])

  const retryBookmarkSync = useCallback(() => {
    void bookmarkSyncRef.current?.retry()
  }, [])

  const importLegacyBookmarks = useCallback(
    async (examId: string, questionIds: string[]) => {
      if (importingLegacy || questionIds.length === 0) return
      const sessionAtStart = getCurrentSessionVersion()
      setImportingLegacy(true)
      setLegacyImportError(null)
      try {
        const res = await fetch('/api/study/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'import',
            examId,
            questionIds,
            expectedUserId: userId,
          }),
          cache: 'no-store',
        })
        if (!res.ok) throw new Error('Unable to import local bookmarks right now.')
        const data = (await res.json()) as { questionIds?: string[] }
        if (!isCurrentSession(sessionAtStart, examId)) {
          return
        }
        bookmarkSyncRef.current?.applyServerSnapshot(
          Array.isArray(data.questionIds) ? data.questionIds : []
        )
        clearLegacyLocalBookmarks(userId, examId)
        setLegacyImportCandidate(null)
        setLegacyImportError(null)
      } catch (err) {
        if (sessionAtStart !== getCurrentSessionVersion()) return
        setLegacyImportError(
          err instanceof Error
            ? err.message
            : 'Unable to import local bookmarks right now.'
        )
      } finally {
        setImportingLegacy(false)
      }
    },
    [importingLegacy, userId, getCurrentSessionVersion, isCurrentSession]
  )

  const dismissLegacyImport = useCallback(() => {
    if (!legacyImportCandidate) return
    clearLegacyLocalBookmarks(userId, legacyImportCandidate.examId)
    setLegacyImportCandidate(null)
    setLegacyImportError(null)
  }, [legacyImportCandidate, userId])

  const destroy = useCallback(() => {
    bookmarkSyncRef.current?.destroy()
    bookmarkSyncRef.current = null
  }, [])

  return {
    bookmarkSync,
    bookmarks: bookmarkSync.bookmarks,
    bookmarkFeedbackPhase,
    legacyImportCandidate,
    importingLegacy,
    legacyImportError,
    initializeForExam,
    setActiveQuestion,
    toggleBookmark,
    retryBookmarkSync,
    importLegacyBookmarks,
    dismissLegacyImport,
    destroy,
  }
}
