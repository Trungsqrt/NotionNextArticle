'use client'

import { useState, useEffect, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import type { ExamCollection } from '../../lib/study/types'
import type { PracticeExamPayload } from '../../lib/study/services/practice-service'
import type { GradedQuestionResult } from '../../lib/study/services/grading'
import StudyRichText from './StudyRichText'
import { PracticeQuestionCardSkeleton, ZenPendingDot } from './StudySkeletons'
import PracticeCompletion from './PracticeCompletion'
import { shouldIgnoreStudyShortcut } from '../../lib/study/keyboard'
import {
  computePracticeCompletionSummary,
  shouldShowFinishPractice,
  shouldShowUnansweredPrompt,
} from '../../lib/study/practice-completion'
import {
  buildPracticeExamUrl,
  resolveExternalParamExamSwitch,
  resolvePracticeRetryAction,
  resolveValidExamId,
  shouldShowViewSummaryButton,
  type PracticeError,
} from '../../lib/study/practice-state'
import {
  clearLegacyLocalBookmarks,
  clearPracticeAttempt,
  readLegacyLocalBookmarksForImport,
  readPracticeAttempt,
  writePracticeAttempt,
  writePracticeSummary,
} from '../../lib/study/local-progress'
import {
  createBookmarkSyncController,
  type BookmarkSyncController,
  type BookmarkSyncSnapshot,
} from '../../lib/study/bookmark-sync'

type PracticeFilter = 'all' | 'incorrect' | 'bookmarked'
type PracticeFetchStatus = 'idle' | 'loading' | 'switching' | 'error' | 'loaded'
type PracticeResultEntry = GradedQuestionResult & {
  /** True when restored from localStorage (verdict + user selection only; no stored answer key/explanation) */
  restored?: boolean
}

const INITIAL_BOOKMARK_SYNC_SNAPSHOT: BookmarkSyncSnapshot = {
  bookmarks: {},
  serverBookmarks: {},
  loadedFromServer: false,
  isInitialLoadPending: false,
  status: 'idle',
  pendingCount: 0,
  loadFailed: false,
  errorMessage: null,
}

function FeedbackCheckIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
    </svg>
  )
}

function FeedbackCrossIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" />
    </svg>
  )
}

export default function PracticeModeClient({
  exams,
  userId,
}: {
  exams: ExamCollection[]
  userId: string
}) {
  const searchParams = useSearchParams()
  const paramExamId = searchParams?.get('examId') || ''
  const initialExamId = resolveValidExamId(paramExamId, exams)

  // activeExamId always matches the committed loaded payload & bookmarks.
  // pendingExamId is only set while an exam switch request is in flight.
  const [activeExamId, setActiveExamId] = useState(initialExamId)
  const [pendingExamId, setPendingExamId] = useState<string | null>(null)
  const [payload, setPayload] = useState<PracticeExamPayload | null>(null)
  const [fetchStatus, setFetchStatus] = useState<PracticeFetchStatus>(
    initialExamId ? 'loading' : 'idle'
  )
  const [practiceError, setPracticeError] = useState<PracticeError | null>(null)

  const [filter, setFilter] = useState<PracticeFilter>('all')
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [results, setResults] = useState<Record<string, PracticeResultEntry>>({})
  const [bookmarkSync, setBookmarkSync] = useState<BookmarkSyncSnapshot>(
    INITIAL_BOOKMARK_SYNC_SNAPSHOT
  )
  const [legacyImportCandidate, setLegacyImportCandidate] = useState<{
    examId: string
    questionIds: string[]
  } | null>(null)
  const [importingLegacy, setImportingLegacy] = useState(false)
  const [legacyImportError, setLegacyImportError] = useState<string | null>(null)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [isCompleted, setIsCompleted] = useState(false)
  const [examMenuOpen, setExamMenuOpen] = useState(false)

  const examDropdownRef = useRef<HTMLDivElement | null>(null)
  const examTriggerRef = useRef<HTMLButtonElement | null>(null)
  const examOptionRefs = useRef<Array<HTMLLIElement | null>>([])

  const activeExamIdRef = useRef(initialExamId)
  const pendingExamIdRef = useRef<string | null>(null)
  const lastHandledParamExamIdRef = useRef(paramExamId.trim())
  const payloadRef = useRef<PracticeExamPayload | null>(null)
  const hydratedExamIdRef = useRef<string>('')
  const bookmarkSyncRef = useRef<BookmarkSyncController | null>(null)
  const checkedLegacyImportExamRef = useRef<string>('')
  const examAbortRef = useRef<AbortController | null>(null)
  const examLoadSeqRef = useRef(0)
  const sessionVersionRef = useRef(0)
  const checkAbortRef = useRef<AbortController | null>(null)
  const checkSeqRef = useRef(0)
  const checkLockRef = useRef(false)

  const bookmarks = bookmarkSync.bookmarks

  const loadExam = useCallback(
    async (examId: string, options?: { syncUrlOnSuccess?: boolean }) => {
      if (!examId || !exams.some((ex) => ex.examId === examId)) return

      // Abort any previous in-flight exam request
      examAbortRef.current?.abort()

      const controller = new AbortController()
      examAbortRef.current = controller
      const seq = ++examLoadSeqRef.current
      const hasExisting = payloadRef.current !== null

      if (hasExisting) {
        pendingExamIdRef.current = examId
        setPendingExamId(examId)
        setFetchStatus('switching')
      } else {
        activeExamIdRef.current = examId
        pendingExamIdRef.current = null
        setActiveExamId(examId)
        setPendingExamId(null)
        setFetchStatus('loading')
      }
      setPracticeError(null)

      try {
        // Load Practice questions independently — bookmarks sync asynchronously
        // so slow or temporarily unavailable bookmark storage never delays studying.
        const practiceRes = await fetch(`/api/study/practice/${encodeURIComponent(examId)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })

        if (!practiceRes.ok) throw new Error('Unable to load practice questions.')
        const data = (await practiceRes.json()) as PracticeExamPayload
        if (seq !== examLoadSeqRef.current) return

        // Commit the new exam atomically and initialize non-blocking bookmark sync
        checkAbortRef.current?.abort()
        checkLockRef.current = false
        setCheckingId(null)
        sessionVersionRef.current += 1

        // Tear down any previous exam's sync controller (flushes pending debounced ops in background)
        bookmarkSyncRef.current?.destroy()

        const questionById = new Map(data.questions.map((q) => [q.questionId, q]))
        const validQuestionIds = new Set(questionById.keys())
        const controllerSession = sessionVersionRef.current

        const syncController = createBookmarkSyncController({
          userId,
          examId,
          validQuestionIds,
          onStateChange: (snapshot) => {
            if (
              sessionVersionRef.current !== controllerSession ||
              activeExamIdRef.current !== examId
            ) {
              return
            }
            setBookmarkSync(snapshot)
          },
        })
        bookmarkSyncRef.current = syncController
        checkedLegacyImportExamRef.current = ''

        const initialBookmarkSnapshot = syncController.getSnapshot()
        const initialBookmarks = initialBookmarkSnapshot.bookmarks
        const savedAttempt = readPracticeAttempt(userId, examId)

        const restoredSelections: Record<string, string[]> = {}
        const restoredResults: Record<string, PracticeResultEntry> = {}

        if (savedAttempt) {
          for (const [qId, opts] of Object.entries(savedAttempt.selections)) {
            if (questionById.has(qId) && opts.length > 0) {
              restoredSelections[qId] = opts
            }
          }
          for (const [qId, isCorrect] of Object.entries(savedAttempt.checkedResults)) {
            const q = questionById.get(qId)
            if (!q) continue
            restoredResults[qId] = {
              questionId: qId,
              questionType: q.questionType,
              isCorrect,
              isSkipped: false,
              selectedOptionIds: restoredSelections[qId] || [],
              correctOptionIds: [],
              explanation: '',
              optionFeedback: [],
              restored: true,
            }
          }
        }

        const restoredFilter: PracticeFilter = savedAttempt?.filter || 'all'
        const restoredFilteredLen = data.questions.filter((q) => {
          if (restoredFilter === 'incorrect') return restoredResults[q.questionId]?.isCorrect === false
          if (restoredFilter === 'bookmarked') return Boolean(initialBookmarks[q.questionId])
          return true
        }).length
        const restoredIndex = savedAttempt
          ? Math.min(savedAttempt.currentIndex, Math.max(0, restoredFilteredLen - 1))
          : 0
        const restoredSummary = computePracticeCompletionSummary(
          data.questions,
          restoredResults,
          initialBookmarks
        )
        const restoredCompleted = Boolean(savedAttempt?.completed && restoredSummary.allGraded)

        activeExamIdRef.current = examId
        pendingExamIdRef.current = null
        payloadRef.current = data
        hydratedExamIdRef.current = examId

        setActiveExamId(examId)
        setPendingExamId(null)
        setPayload(data)
        setBookmarkSync(initialBookmarkSnapshot)
        setLegacyImportCandidate(null)
        setLegacyImportError(null)
        setSelections(restoredSelections)
        setResults(restoredResults)
        setFilter(restoredFilter)
        setCurrentIndex(restoredIndex)
        setIsCompleted(restoredCompleted)
        setPracticeError(null)
        setFetchStatus('loaded')

        // Independently hydrate server bookmarks (and replay any locally persisted pending ops)
        void syncController.loadFromServer()

        if (options?.syncUrlOnSuccess && typeof window !== 'undefined') {
          lastHandledParamExamIdRef.current = examId
          const nextUrl = buildPracticeExamUrl(window.location.href, examId)
          window.history.replaceState(window.history.state, '', nextUrl)
        }
      } catch (err) {
        if (controller.signal.aborted || seq !== examLoadSeqRef.current) return

        pendingExamIdRef.current = null
        setPendingExamId(null)

        if (hasExisting) {
          const targetTitle = exams.find((ex) => ex.examId === examId)?.title
          const message = targetTitle
            ? `Unable to switch to "${targetTitle}". Your current practice progress was preserved.`
            : 'Unable to switch exams right now. Your current practice progress was preserved.'
          setPracticeError({
            kind: 'load_exam',
            examId,
            isSwitch: true,
            message,
          })
          setFetchStatus('loaded')
        } else {
          setPracticeError({
            kind: 'load_exam',
            examId,
            isSwitch: false,
            message: err instanceof Error ? err.message : 'Failed to load practice set.',
          })
          setFetchStatus('error')
        }
      }
    },
    [exams, userId]
  )

  // Initial exam load on mount
  useEffect(() => {
    if (initialExamId) {
      loadExam(initialExamId, { syncUrlOnSuccess: false })
    }
    return () => {
      examAbortRef.current?.abort()
      checkAbortRef.current?.abort()
      bookmarkSyncRef.current?.destroy()
      bookmarkSyncRef.current = null
      examLoadSeqRef.current += 1
      checkSeqRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      (qId) => validIds.has(qId) && !bookmarkSync.serverBookmarks[qId] && !bookmarkSync.bookmarks[qId]
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

  // Persist ongoing Practice attempt locally (without answer keys or explanations)
  useEffect(() => {
    if (
      !payload ||
      fetchStatus !== 'loaded' ||
      hydratedExamIdRef.current !== activeExamId ||
      payload.exam.examId !== activeExamId
    ) {
      return
    }
    const checkedResults: Record<string, boolean> = {}
    for (const [qId, res] of Object.entries(results) as Array<[string, PracticeResultEntry]>) {
      checkedResults[qId] = res.isCorrect
    }
    const hasAnyProgress =
      Object.keys(checkedResults).length > 0 ||
      Object.keys(selections).length > 0 ||
      currentIndex > 0 ||
      filter !== 'all' ||
      isCompleted

    if (!hasAnyProgress) return

    writePracticeAttempt(userId, activeExamId, {
      currentIndex,
      filter,
      checkedResults,
      selections,
      completed: isCompleted,
    })
  }, [userId, activeExamId, payload, fetchStatus, results, selections, currentIndex, filter, isCompleted])

  // React only to external URL examId changes (direct links / navigation / history),
  // never overriding an intentional dropdown selection.
  useEffect(() => {
    const externalTarget = resolveExternalParamExamSwitch({
      paramExamId,
      lastHandledParamExamId: lastHandledParamExamIdRef.current,
      activeExamId: activeExamIdRef.current,
      pendingExamId: pendingExamIdRef.current,
      exams,
    })
    lastHandledParamExamIdRef.current = paramExamId.trim()
    if (externalTarget) {
      loadExam(externalTarget, { syncUrlOnSuccess: false })
    }
  }, [paramExamId, exams, loadExam])

  const handleSelectExam = useCallback(
    (nextExamId: string) => {
      if (!nextExamId || !exams.some((ex) => ex.examId === nextExamId)) return

      // Selecting the currently active exam cancels any in-flight switch or stale switch error
      if (nextExamId === activeExamIdRef.current && payloadRef.current !== null) {
        if (pendingExamIdRef.current !== null) {
          examAbortRef.current?.abort()
          examLoadSeqRef.current += 1
          pendingExamIdRef.current = null
          setPendingExamId(null)
          setFetchStatus('loaded')
        }
        setPracticeError((prev) => (prev?.kind === 'load_exam' ? null : prev))
        return
      }

      loadExam(nextExamId, { syncUrlOnSuccess: true })
    },
    [exams, loadExam]
  )

  function toggleBookmark(questionId: string) {
    bookmarkSyncRef.current?.toggle(questionId)
  }

  const handleImportLegacyBookmarks = useCallback(
    async (examId: string, questionIds: string[]) => {
      if (importingLegacy || questionIds.length === 0) return
      const sessionAtStart = sessionVersionRef.current
      setImportingLegacy(true)
      setLegacyImportError(null)
      try {
        const res = await fetch('/api/study/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'import', examId, questionIds }),
          cache: 'no-store',
        })
        if (!res.ok) throw new Error('Unable to import local bookmarks right now.')
        const data = (await res.json()) as { questionIds?: string[] }
        if (
          sessionAtStart !== sessionVersionRef.current ||
          activeExamIdRef.current !== examId
        ) {
          return
        }
        bookmarkSyncRef.current?.applyServerSnapshot(
          Array.isArray(data.questionIds) ? data.questionIds : []
        )
        clearLegacyLocalBookmarks(userId, examId)
        setLegacyImportCandidate(null)
        setLegacyImportError(null)
      } catch (err) {
        if (sessionAtStart !== sessionVersionRef.current) return
        setLegacyImportError(
          err instanceof Error
            ? err.message
            : 'Unable to import local bookmarks right now.'
        )
      } finally {
        setImportingLegacy(false)
      }
    },
    [importingLegacy, userId]
  )

  const handleDismissLegacyImport = useCallback(() => {
    if (!legacyImportCandidate) return
    clearLegacyLocalBookmarks(userId, legacyImportCandidate.examId)
    setLegacyImportCandidate(null)
    setLegacyImportError(null)
  }, [legacyImportCandidate, userId])

  const handleRetryBookmarkSync = useCallback(() => {
    void bookmarkSyncRef.current?.retry()
  }, [])

  function toggleOption(questionId: string, optionId: string, isMulti: boolean) {
    if (results[questionId] || checkingId === questionId || fetchStatus === 'switching') return
    setPracticeError((prev) =>
      prev?.kind === 'check_answer' && prev.questionId === questionId ? null : prev
    )
    setSelections((prev) => {
      const curr = prev[questionId] || []
      if (!isMulti) return { ...prev, [questionId]: [optionId] }
      const exists = curr.includes(optionId)
      return {
        ...prev,
        [questionId]: exists ? curr.filter((id) => id !== optionId) : [...curr, optionId],
      }
    })
  }

  const handleCheck = useCallback(
    async (
      questionId: string,
      overrideSelected?: string[],
      options?: { hydrateRestored?: boolean }
    ) => {
      const selected = overrideSelected ?? selections[questionId] ?? []
      const existing = results[questionId]
      const alreadyGraded = Boolean(existing && !(options?.hydrateRestored && existing.restored))
      if (
        selected.length === 0 ||
        alreadyGraded ||
        checkLockRef.current ||
        checkingId !== null ||
        fetchStatus === 'switching'
      ) {
        return
      }

      checkLockRef.current = true
      checkAbortRef.current?.abort()
      const controller = new AbortController()
      checkAbortRef.current = controller
      const seq = ++checkSeqRef.current
      const sessionAtStart = sessionVersionRef.current

      setCheckingId(questionId)
      setPracticeError(null)

      try {
        const res = await fetch('/api/study/practice/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionId, selectedOptionIds: selected }),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('Unable to check answer right now.')
        const graded = (await res.json()) as GradedQuestionResult
        if (seq !== checkSeqRef.current || sessionAtStart !== sessionVersionRef.current) return

        const nextResults: Record<string, PracticeResultEntry> = {
          ...results,
          [questionId]: { ...graded, restored: false },
        }
        setResults(nextResults)

        // When this check completes all questions in the exam, persist latest completed Practice summary
        const currentPayload = payloadRef.current
        if (currentPayload && currentPayload.exam.examId === activeExamIdRef.current && !options?.hydrateRestored) {
          const nextSummary = computePracticeCompletionSummary(
            currentPayload.questions,
            nextResults,
            bookmarks
          )
          if (nextSummary.allGraded) {
            writePracticeSummary(userId, activeExamIdRef.current, {
              totalQuestions: nextSummary.totalQuestions,
              completedCount: nextSummary.completedCount,
              correctCount: nextSummary.correctCount,
              incorrectCount: nextSummary.incorrectCount,
              accuracyPercent: nextSummary.accuracyPercent,
            })
          }
        }
      } catch (err) {
        if (
          controller.signal.aborted ||
          seq !== checkSeqRef.current ||
          sessionAtStart !== sessionVersionRef.current
        ) {
          return
        }
        setPracticeError({
          kind: 'check_answer',
          questionId,
          selectedOptionIds: [...selected],
          message: err instanceof Error ? err.message : 'Failed to check answer.',
        })
      } finally {
        if (seq === checkSeqRef.current) {
          checkLockRef.current = false
          setCheckingId(null)
        }
      }
    },
    [selections, results, bookmarks, checkingId, fetchStatus, userId]
  )

  const handleRetryError = useCallback(() => {
    const action = resolvePracticeRetryAction(practiceError, selections)
    if (!action) return
    if (action.type === 'check_answer') {
      handleCheck(action.questionId, action.selectedOptionIds)
    } else {
      loadExam(action.examId, { syncUrlOnSuccess: action.isSwitch })
    }
  }, [practiceError, selections, handleCheck, loadExam])

  const isInitialLoading = fetchStatus === 'loading'
  const isSwitching = fetchStatus === 'switching'
  const isInitialError = fetchStatus === 'error' && !payload

  const allQuestions = payload?.questions || []
  const summary = computePracticeCompletionSummary(allQuestions, results, bookmarks)

  const filteredQuestions = allQuestions.filter((q) => {
    if (filter === 'incorrect') return results[q.questionId]?.isCorrect === false
    if (filter === 'bookmarked') return Boolean(bookmarks[q.questionId])
    return true
  })

  const safeIndex = Math.min(currentIndex, Math.max(0, filteredQuestions.length - 1))
  const currentQ = filteredQuestions[safeIndex] || null
  const currentGraded = currentQ ? Boolean(results[currentQ.questionId]) : false
  const hasCurrentSelection = currentQ
    ? (selections[currentQ.questionId] || []).length > 0
    : false
  const canGoPrevious = safeIndex > 0 && !isSwitching
  const canGoNext = safeIndex < filteredQuestions.length - 1 && !isSwitching

  const showFinishPractice = shouldShowFinishPractice({
    filter,
    safeIndex,
    filteredLength: filteredQuestions.length,
    allGraded: summary.allGraded,
  })
  const canFinishPractice = showFinishPractice && !isSwitching

  const showUnansweredPrompt = shouldShowUnansweredPrompt({
    filter,
    safeIndex,
    filteredLength: filteredQuestions.length,
    remainingUnansweredCount: summary.remainingUnansweredCount,
    firstUnansweredIndex: summary.firstUnansweredIndex,
  })

  const goPrevious = useCallback(() => {
    if (!canGoPrevious) return
    setCurrentIndex((i) => Math.max(0, i - 1))
  }, [canGoPrevious])

  const goNext = useCallback(() => {
    if (!canGoNext) return
    setCurrentIndex((i) => Math.min(filteredQuestions.length - 1, i + 1))
  }, [canGoNext, filteredQuestions.length])

  const handleFinishPractice = useCallback(() => {
    if (!canFinishPractice) return
    if (activeExamIdRef.current && summary.allGraded) {
      writePracticeSummary(userId, activeExamIdRef.current, {
        totalQuestions: summary.totalQuestions,
        completedCount: summary.completedCount,
        correctCount: summary.correctCount,
        incorrectCount: summary.incorrectCount,
        accuracyPercent: summary.accuracyPercent,
      })
    }
    setIsCompleted(true)
  }, [canFinishPractice, userId, summary])

  const handleGoToFirstUnanswered = useCallback(() => {
    if (summary.firstUnansweredIndex < 0 || isSwitching) return
    setFilter('all')
    setCurrentIndex(summary.firstUnansweredIndex)
  }, [summary.firstUnansweredIndex, isSwitching])

  const handleReviewIncorrect = useCallback(() => {
    if (summary.incorrectCount === 0 || isSwitching) return
    setIsCompleted(false)
    setFilter('incorrect')
    setCurrentIndex(0)
  }, [summary.incorrectCount, isSwitching])

  const handleReviewBookmarked = useCallback(() => {
    if (summary.bookmarkedCount === 0 || isSwitching) return
    setIsCompleted(false)
    setFilter('bookmarked')
    setCurrentIndex(0)
  }, [summary.bookmarkedCount, isSwitching])

  const handleRestartPractice = useCallback(() => {
    if (isSwitching) return
    checkAbortRef.current?.abort()
    checkLockRef.current = false
    sessionVersionRef.current += 1
    if (activeExamIdRef.current) {
      // Resets ongoing attempt only; preserves bookmarks and previous completed summary
      clearPracticeAttempt(userId, activeExamIdRef.current)
    }
    setCheckingId(null)
    setPracticeError(null)
    setSelections({})
    setResults({})
    setFilter('all')
    setCurrentIndex(0)
    setIsCompleted(false)
  }, [isSwitching, userId])

  // Close custom exam dropdown on outside click or Escape
  useEffect(() => {
    if (!examMenuOpen) return

    function handleClickOutside(e: MouseEvent) {
      if (examDropdownRef.current && !examDropdownRef.current.contains(e.target as Node)) {
        setExamMenuOpen(false)
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setExamMenuOpen(false)
        examTriggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [examMenuOpen])

  // Keyboard shortcuts: ArrowLeft = Previous, ArrowRight = Next,
  // Enter = Check Answer (if ungraded with selection), Next (if graded), or Finish Practice (on final graded All question),
  // Space = Check Answer
  useEffect(() => {
    if (
      exams.length === 0 ||
      isInitialLoading ||
      isInitialError ||
      isSwitching ||
      isCompleted ||
      examMenuOpen ||
      !currentQ
    ) {
      return
    }

    function onKeyDown(e: KeyboardEvent) {
      if (shouldIgnoreStudyShortcut(e)) return

      if (e.key === 'ArrowLeft') {
        if (!canGoPrevious) return
        e.preventDefault()
        goPrevious()
        return
      }

      if (e.key === 'ArrowRight') {
        if (!canGoNext) return
        e.preventDefault()
        goNext()
        return
      }

      if (e.key === 'Enter') {
        if (!currentGraded) {
          if (hasCurrentSelection && checkingId === null) {
            e.preventDefault()
            handleCheck(currentQ.questionId)
          }
        } else if (canGoNext) {
          e.preventDefault()
          goNext()
        } else if (canFinishPractice) {
          e.preventDefault()
          handleFinishPractice()
        }
        return
      }

      if (e.key === ' ') {
        if (!currentGraded && hasCurrentSelection && checkingId === null) {
          e.preventDefault()
          handleCheck(currentQ.questionId)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    exams.length,
    isInitialLoading,
    isInitialError,
    isSwitching,
    isCompleted,
    examMenuOpen,
    currentQ,
    currentGraded,
    hasCurrentSelection,
    checkingId,
    canGoPrevious,
    canGoNext,
    canFinishPractice,
    goPrevious,
    goNext,
    handleCheck,
    handleFinishPractice,
  ])

  if (exams.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 text-center text-sm text-ink-500 dark:text-sage-400">
        No published exam collections are available for practice yet.
      </div>
    )
  }

  const displayedExamId = pendingExamId || activeExamId
  const displayedExam =
    exams.find((ex) => ex.examId === displayedExamId) || exams[0]
  const displayedExamLabel = displayedExam
    ? `${displayedExam.title} (${displayedExam.questionCount})`
    : 'Select exam'
  const currentExamTitle =
    payload?.exam.title ||
    exams.find((ex) => ex.examId === activeExamId)?.title ||
    'Practice Set'
  const showViewSummary = shouldShowViewSummaryButton({
    allGraded: summary.allGraded,
    isCompleted,
    isInitialLoading,
  })

  function focusExamOption(index: number) {
    if (exams.length === 0) return
    const clamped = Math.max(0, Math.min(exams.length - 1, index))
    examOptionRefs.current[clamped]?.focus()
  }

  function handleSelectExamOption(examId: string) {
    setExamMenuOpen(false)
    handleSelectExam(examId)
    examTriggerRef.current?.focus()
  }

  function handleExamTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const currentIdx = Math.max(
        0,
        exams.findIndex((ex) => ex.examId === displayedExamId)
      )
      setExamMenuOpen(true)
      requestAnimationFrame(() => focusExamOption(currentIdx))
    }
  }

  function handleExamOptionKeyDown(
    e: ReactKeyboardEvent<HTMLLIElement>,
    index: number,
    examId: string
  ) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusExamOption((index + 1) % exams.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusExamOption((index - 1 + exams.length) % exams.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusExamOption(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusExamOption(exams.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleSelectExamOption(examId)
    } else if (e.key === 'Tab') {
      setExamMenuOpen(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      {/* ── Top Bar: Exam Selector & Filter ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-medium text-ink-700 dark:text-sage-100 m-0">
            Practice Mode
          </h1>
          <p className="text-[0.82rem] text-ink-400 dark:text-sage-500 mt-1 mb-0">
            Immediate feedback and explanations. Practice checks remain separate from FSRS memory ratings.
          </p>
        </div>

        <div className="flex items-center gap-2.5 w-full sm:w-auto shrink-0">
          {isSwitching && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-matcha-600 dark:text-matcha-400 shrink-0"
            >
              <ZenPendingDot />
              Switching…
            </span>
          )}
          <div className="relative w-full sm:w-auto" ref={examDropdownRef}>
            <button
              ref={examTriggerRef}
              type="button"
              id="practice-exam-selector"
              aria-label="Select exam collection"
              aria-haspopup="listbox"
              aria-expanded={examMenuOpen}
              aria-controls="practice-exam-listbox"
              aria-busy={isSwitching || undefined}
              title={displayedExamLabel}
              onClick={() => setExamMenuOpen((open) => !open)}
              onKeyDown={handleExamTriggerKeyDown}
              className={[
                'flex items-center justify-between w-full sm:w-64 md:w-72 pl-3.5 pr-2.5 py-2 rounded-[6px]',
                'text-[0.83rem] font-medium transition-all duration-200 ease-out motion-reduce:transition-none outline-none select-none cursor-pointer',
                'focus-visible:ring-2 focus-visible:ring-matcha-500/50 dark:focus-visible:ring-matcha-400/60',
                examMenuOpen
                  ? 'bg-matcha-100/90 text-matcha-700 border border-matcha-400/70 shadow-sm dark:bg-matcha-700/25 dark:text-matcha-300 dark:border-matcha-600/50 dark:shadow-none'
                  : 'bg-rice-paper-200/70 text-ink-600 border border-rice-paper-400/80 hover:bg-rice-paper-300/80 hover:text-ink-700 dark:bg-tea-slate-200 dark:text-sage-200 dark:border-tea-slate-50/50 dark:hover:bg-tea-slate-100/70 dark:hover:border-tea-slate-50/70 dark:hover:text-sage-100',
              ].join(' ')}
            >
              <span className="truncate">{displayedExamLabel}</span>
              <svg
                className={[
                  'w-3.5 h-3.5 ml-2 shrink-0 transition-transform duration-250 ease-out motion-reduce:transition-none text-ink-400 dark:text-sage-400',
                  examMenuOpen ? 'rotate-180 text-matcha-500 dark:text-matcha-400' : '',
                ].join(' ')}
                fill="none"
                strokeWidth="2"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {examMenuOpen && (
              <ul
                id="practice-exam-listbox"
                role="listbox"
                aria-label="Exam collection"
                className="animate-dropdown absolute top-full left-0 sm:left-auto sm:right-0 mt-1.5 w-full sm:w-80 md:w-96 max-h-72 overflow-y-auto bg-rice-paper-100 dark:bg-tea-slate-50 border border-rice-paper-400/80 dark:border-tea-slate-50/60 rounded-[6px] shadow-zen dark:shadow-[0_4px_16px_rgba(18,19,16,0.5)] z-50 py-1 list-none m-0"
              >
                {exams.map((ex, index) => {
                  const isSelected = ex.examId === displayedExamId
                  return (
                    <li
                      key={ex.examId}
                      ref={(el) => {
                        examOptionRefs.current[index] = el
                      }}
                      role="option"
                      tabIndex={-1}
                      aria-selected={isSelected}
                      onClick={() => handleSelectExamOption(ex.examId)}
                      onKeyDown={(e) => handleExamOptionKeyDown(e, index, ex.examId)}
                      className={[
                        'px-3.5 py-2 text-[0.82rem] leading-snug cursor-pointer transition-colors duration-150 ease-out motion-reduce:transition-none flex items-start justify-between gap-2.5 outline-none',
                        isSelected
                          ? 'bg-matcha-100/70 dark:bg-matcha-700/25 font-medium text-matcha-700 dark:text-matcha-300'
                          : 'text-ink-600 dark:text-sage-300 hover:bg-rice-paper-300/60 dark:hover:bg-tea-slate-200/70 hover:text-ink-700 dark:hover:text-sage-100 focus-visible:bg-rice-paper-300/60 dark:focus-visible:bg-tea-slate-200/70 focus-visible:text-ink-700 dark:focus-visible:text-sage-100',
                      ].join(' ')}
                    >
                      <span className="break-words">{ex.title}</span>
                      <span className="inline-flex items-center gap-2 shrink-0 pt-0.5">
                        <span className="text-[0.74rem] font-mono tabular-nums opacity-70">
                          ({ex.questionCount})
                        </span>
                        {isSelected && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* ── Filter Tabs + Progress ── */}
      {!isCompleted && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center gap-1 p-1 rounded-zen bg-rice-paper-200/70 dark:bg-tea-slate-200/70 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-xs">
            {(
              [
                { key: 'all', label: isInitialLoading ? 'All' : `All (${allQuestions.length})` },
                {
                  key: 'incorrect',
                  label: isInitialLoading ? 'Incorrect' : `Incorrect (${summary.incorrectCount})`,
                },
                {
                  key: 'bookmarked',
                  label: isInitialLoading ? 'Bookmarked' : `Bookmarked (${summary.bookmarkedCount})`,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                disabled={isInitialLoading || isSwitching}
                onClick={() => {
                  setIsCompleted(false)
                  setFilter(tab.key)
                  setCurrentIndex(0)
                }}
                className={[
                  'px-3 py-1 rounded-[4px] font-medium transition-colors duration-150 motion-reduce:transition-none disabled:opacity-60',
                  filter === tab.key
                    ? 'bg-rice-paper-50 dark:bg-tea-slate-50 text-matcha-700 dark:text-matcha-300 shadow-zen-sm'
                    : 'text-ink-500 dark:text-sage-400 hover:text-ink-700 dark:hover:text-sage-200',
                ].join(' ')}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {showViewSummary && (
              <button
                type="button"
                disabled={isSwitching}
                onClick={() => setIsCompleted(true)}
                className="px-3 py-1 rounded-zen text-xs font-medium text-matcha-700 dark:text-matcha-300 bg-matcha-50/90 dark:bg-matcha-900/35 border border-matcha-400/60 dark:border-matcha-600/50 hover:bg-matcha-100/80 dark:hover:bg-matcha-900/55 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50"
              >
                View Summary
              </button>
            )}
            <span className="text-xs font-mono text-ink-500 dark:text-sage-400">
              {isInitialLoading
                ? 'Loading set…'
                : `Checked: ${summary.completedCount}/${summary.totalQuestions}`}
            </span>
          </div>
        </div>
      )}

      {legacyImportCandidate && !isInitialLoading && (
        <div
          role="region"
          aria-label="Import local bookmarks"
          className="rounded-zen px-4 py-3 bg-rice-paper-200/80 dark:bg-tea-slate-200/80 border border-matcha-400/50 dark:border-matcha-700/50 text-xs text-ink-600 dark:text-sage-200 flex flex-wrap items-center justify-between gap-3 animate-study-feedback"
        >
          <div className="space-y-0.5">
            <div>
              Found {legacyImportCandidate.questionIds.length} local{' '}
              {legacyImportCandidate.questionIds.length === 1 ? 'bookmark' : 'bookmarks'} in this
              browser for this exam. Import to your synced account?
            </div>
            {legacyImportError && (
              <div className="text-[0.72rem] text-[#7A4932] dark:text-[#E2BBA2]">
                {legacyImportError}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={importingLegacy}
              onClick={() =>
                handleImportLegacyBookmarks(
                  legacyImportCandidate.examId,
                  legacyImportCandidate.questionIds
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-zen font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-150 motion-reduce:transition-none disabled:opacity-60"
            >
              {importingLegacy && <ZenPendingDot />}
              <span>
                {importingLegacy
                  ? 'Importing…'
                  : legacyImportError
                    ? 'Retry Import'
                    : 'Import to Account'}
              </span>
            </button>
            <button
              type="button"
              disabled={importingLegacy}
              onClick={handleDismissLegacyImport}
              className="px-2.5 py-1 rounded-zen font-medium text-ink-500 dark:text-sage-400 hover:text-ink-700 dark:hover:text-sage-200"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {isCompleted && bookmarkSync.status === 'not_synced' && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-end gap-2 text-xs text-[#7A4932] dark:text-[#E2BBA2] animate-study-feedback"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-earth-rust" aria-hidden="true" />
          <span>Bookmarks not synced</span>
          <button
            type="button"
            onClick={handleRetryBookmarkSync}
            className="px-2 py-0.5 rounded-zen font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none"
          >
            Retry
          </button>
        </div>
      )}

      {practiceError && (
        <div
          role="alert"
          className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex flex-wrap items-center justify-between gap-3"
        >
          <span>{practiceError.message}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleRetryError}
              disabled={isInitialLoading || isSwitching || checkingId !== null}
              className="px-3 py-1 rounded-zen text-xs font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 dark:border-rose-400/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50"
            >
              {practiceError.kind === 'check_answer'
                ? 'Retry Check'
                : practiceError.isSwitch
                  ? 'Retry Switch'
                  : 'Try Again'}
            </button>
            {(practiceError.kind === 'check_answer' || practiceError.isSwitch) && (
              <button
                type="button"
                onClick={() => setPracticeError(null)}
                className="px-2 py-1 text-xs font-medium text-earth-rust/80 dark:text-rose-200/80 hover:underline"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {isInitialLoading ? (
        <PracticeQuestionCardSkeleton />
      ) : isInitialError ? (
        <div className="rounded-card p-8 text-center bg-rice-paper-50/80 dark:bg-tea-slate-200/50 border border-rice-paper-400/60 dark:border-tea-slate-50/40 space-y-3 animate-study-feedback">
          <p className="text-sm text-ink-500 dark:text-sage-400 m-0">
            Could not load questions for this exam collection.
          </p>
          <button
            type="button"
            onClick={() => loadExam(activeExamId, { syncUrlOnSuccess: false })}
            className="px-4 py-2 rounded-zen text-xs font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-150 motion-reduce:transition-none"
          >
            Retry Loading Questions
          </button>
        </div>
      ) : isCompleted && payload ? (
        <PracticeCompletion
          examTitle={currentExamTitle}
          accuracyPercent={summary.accuracyPercent}
          completedCount={summary.completedCount}
          totalQuestions={summary.totalQuestions}
          correctCount={summary.correctCount}
          incorrectCount={summary.incorrectCount}
          bookmarkedCount={summary.bookmarkedCount}
          onReviewIncorrect={handleReviewIncorrect}
          onReviewBookmarked={handleReviewBookmarked}
          onRestart={handleRestartPractice}
          disabled={isSwitching}
        />
      ) : !currentQ ? (
        <div className="rounded-card p-8 text-center bg-rice-paper-50/80 dark:bg-tea-slate-200/50 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-sm text-ink-400 dark:text-sage-500 animate-study-feedback">
          No questions match the current filter.
        </div>
      ) : (
        <article
          aria-busy={isSwitching || undefined}
          className={[
            'rounded-card p-6 sm:p-8 bg-rice-paper-50/95 dark:bg-tea-slate-200/70 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-6',
            'transition-opacity duration-150 ease-zen motion-reduce:transition-none animate-study-feedback',
            isSwitching ? 'opacity-60' : 'opacity-100',
          ].join(' ')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-400 dark:text-sage-500">
            <div className="flex items-center gap-2">
              <span className="font-mono">
                {safeIndex + 1} / {filteredQuestions.length}
              </span>
              <span>·</span>
              <span>{currentQ.topic}</span>
              <span>·</span>
              <span>{currentQ.questionType === 'multi_select' ? 'Multi-select' : 'Single-choice'}</span>
            </div>
            <div className="flex items-center gap-2">
              {bookmarkSync.status === 'saving' && (
                <span
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-1 text-[0.7rem] text-ink-400 dark:text-sage-400 animate-study-feedback"
                >
                  <ZenPendingDot />
                  <span>Saving…</span>
                </span>
              )}
              {bookmarkSync.status === 'saved' && (
                <span
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-1 text-[0.7rem] text-matcha-600 dark:text-matcha-400 animate-study-feedback"
                >
                  <FeedbackCheckIcon className="w-3 h-3" />
                  <span>Saved</span>
                </span>
              )}
              {bookmarkSync.status === 'not_synced' && (
                <span
                  role="status"
                  aria-live="polite"
                  title={bookmarkSync.errorMessage || 'Bookmarks not synced'}
                  className="inline-flex items-center gap-1.5 text-[0.7rem] text-[#7A4932] dark:text-[#E2BBA2] animate-study-feedback"
                >
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full bg-earth-rust shrink-0"
                    aria-hidden="true"
                  />
                  <span>Not synced</span>
                  <button
                    type="button"
                    onClick={handleRetryBookmarkSync}
                    className="px-1.5 py-0.5 rounded-[4px] font-medium bg-rice-paper-100 dark:bg-tea-slate-300/70 text-ink-700 dark:text-sage-100 border border-earth-rust/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none"
                  >
                    Retry
                  </button>
                </span>
              )}
              <button
                type="button"
                disabled={isSwitching}
                onClick={() => toggleBookmark(currentQ.questionId)}
                aria-pressed={Boolean(bookmarks[currentQ.questionId])}
                className={[
                  'px-2.5 py-1 rounded-zen border text-xs font-medium transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50',
                  bookmarks[currentQ.questionId]
                    ? 'bg-matcha-100/80 dark:bg-matcha-900/40 border-matcha-400/70 text-matcha-700 dark:text-matcha-300'
                    : 'border-rice-paper-400/70 dark:border-tea-slate-50/60 text-ink-500 dark:text-sage-400',
                ].join(' ')}
              >
                {bookmarks[currentQ.questionId] ? '★ Bookmarked' : '☆ Bookmark'}
              </button>
            </div>
          </div>

          <StudyRichText
            text={currentQ.questionText}
            imageRefs={currentQ.imageRefs}
            placement="question"
            className="font-serif text-lg leading-relaxed text-ink-700 dark:text-sage-100"
          />

          {/* Options */}
          <div className="space-y-2.5">
            {currentQ.options.map((opt) => {
              const selected = (selections[currentQ.questionId] || []).includes(opt.id)
              const graded = results[currentQ.questionId]
              const isCheckingCurrent = checkingId === currentQ.questionId
              const isMulti = currentQ.questionType === 'multi_select'
              const isRestored = Boolean(graded?.restored)
              const isCorrectOption = Boolean(!isRestored && graded?.correctOptionIds.includes(opt.id))
              const isCorrectSelection = Boolean(
                graded && selected && (isRestored ? graded.isCorrect : isCorrectOption)
              )
              const isMissedCorrect = Boolean(graded && !isRestored && !selected && isCorrectOption)
              const isWrongSelection = Boolean(
                graded && selected && (isRestored ? !graded.isCorrect : !isCorrectOption)
              )
              const isUnselectedNeutral = Boolean(
                graded && !selected && (isRestored || !isCorrectOption)
              )
              const fb = graded?.optionFeedback.find((f) => f.optionId === opt.id)

              const cardTone = isCorrectSelection
                ? 'bg-matcha-100/80 dark:bg-matcha-900/55 border-matcha-500 dark:border-matcha-400/85 ring-1 ring-matcha-500/20 dark:ring-matcha-400/20 text-ink-700 dark:text-sage-100'
                : isMissedCorrect
                  ? [
                      'bg-matcha-50/90 dark:bg-matcha-900/35 border-matcha-500/85 dark:border-matcha-400/75 text-ink-700 dark:text-sage-100',
                      isMulti ? 'border-dashed' : '',
                    ].join(' ')
                  : isWrongSelection
                    ? 'bg-earth-rust/[0.10] dark:bg-earth-rust/[0.20] border-earth-rust/80 dark:border-earth-rust/85 ring-1 ring-earth-rust/20 text-ink-700 dark:text-sage-100'
                    : isUnselectedNeutral
                      ? 'bg-rice-paper-100/50 dark:bg-tea-slate-300/40 border-rice-paper-400/50 dark:border-tea-slate-50/30 text-ink-500/80 dark:text-sage-400/80'
                      : selected
                        ? 'bg-matcha-50/70 dark:bg-matcha-900/25 border-matcha-400 text-ink-700 dark:text-sage-100'
                        : 'bg-rice-paper-100/70 dark:bg-tea-slate-300/60 border-rice-paper-400/60 dark:border-tea-slate-50/40 text-ink-600 dark:text-sage-200 hover:border-matcha-400/60'

              const badgeTone = isCorrectSelection
                ? 'bg-matcha-600 dark:bg-matcha-500 text-white'
                : isMissedCorrect
                  ? 'bg-matcha-200/90 dark:bg-matcha-800 text-matcha-800 dark:text-matcha-200'
                  : isWrongSelection
                    ? 'bg-earth-rust text-white'
                    : 'bg-rice-paper-200 dark:bg-tea-slate-100 text-ink-600 dark:text-sage-300'

              const statusLabel = isCorrectSelection
                ? 'Your answer · Correct'
                : isMissedCorrect
                  ? isMulti
                    ? 'Missed · Correct answer'
                    : 'Correct answer'
                  : isWrongSelection
                    ? 'Your answer · Incorrect'
                    : null

              return (
                <button
                  key={opt.id}
                  type="button"
                  data-study-option="true"
                  disabled={Boolean(graded) || isCheckingCurrent || isSwitching}
                  aria-pressed={!graded ? selected : undefined}
                  onClick={() => toggleOption(currentQ.questionId, opt.id, isMulti)}
                  className={[
                    'w-full text-left rounded-zen px-4 py-3 border text-[0.9rem]',
                    'transition-colors duration-150 motion-reduce:transition-none',
                    cardTone,
                  ].join(' ')}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      className={[
                        'font-mono text-xs font-semibold px-1.5 py-0.5 rounded shrink-0 mt-0.5',
                        'transition-colors duration-150 motion-reduce:transition-none',
                        badgeTone,
                      ].join(' ')}
                    >
                      {opt.id}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex-1 min-w-[12rem]">
                          <StudyRichText
                            text={opt.text}
                            imageRefs={currentQ.imageRefs}
                            placement="option"
                            optionId={opt.id}
                          />
                        </div>
                        {statusLabel && (
                          <span
                            className={[
                              'inline-flex items-center gap-1 text-[0.72rem] font-medium tracking-wide shrink-0 mt-0.5 animate-study-feedback',
                              isWrongSelection
                                ? 'text-[#7A4932] dark:text-[#E2BBA2]'
                                : 'text-matcha-700 dark:text-matcha-200',
                            ].join(' ')}
                          >
                            {isWrongSelection ? (
                              <FeedbackCrossIcon className="w-3.5 h-3.5 shrink-0" />
                            ) : (
                              <FeedbackCheckIcon className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <span>{statusLabel}</span>
                          </span>
                        )}
                      </div>
                      {fb && (
                        <div className="mt-2 pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/30 text-xs text-ink-500 dark:text-sage-400 animate-study-feedback">
                          <StudyRichText
                            text={fb.feedback}
                            imageRefs={currentQ.imageRefs}
                            placement="feedback"
                            optionId={opt.id}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Feedback & Explanation */}
          {results[currentQ.questionId] && (() => {
            const graded = results[currentQ.questionId]
            return (
              <div
                aria-live="polite"
                className={[
                  'rounded-zen border border-l-[3px] p-4 sm:p-5 space-y-3 animate-study-feedback',
                  graded.isCorrect
                    ? 'bg-matcha-50/90 dark:bg-matcha-900/30 border-matcha-400/60 dark:border-matcha-600/50 border-l-matcha-500 dark:border-l-matcha-400'
                    : 'bg-earth-rust/[0.07] dark:bg-earth-rust/[0.15] border-earth-rust/40 dark:border-earth-rust/50 border-l-earth-rust',
                ].join(' ')}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div
                    className={[
                      'inline-flex items-center gap-1.5 text-sm font-semibold',
                      graded.isCorrect
                        ? 'text-matcha-700 dark:text-matcha-200'
                        : 'text-[#7A4932] dark:text-[#E2BBA2]',
                    ].join(' ')}
                  >
                    {graded.isCorrect ? (
                      <FeedbackCheckIcon className="w-4 h-4 shrink-0" />
                    ) : (
                      <FeedbackCrossIcon className="w-4 h-4 shrink-0" />
                    )}
                    <span>{graded.isCorrect ? 'Correct' : 'Incorrect'}</span>
                  </div>
                  {!graded.isCorrect && graded.correctOptionIds.length > 0 && (
                    <span className="text-xs font-medium text-ink-600 dark:text-sage-200">
                      Correct answer:{' '}
                      <span className="font-mono font-semibold text-matcha-700 dark:text-matcha-200">
                        {graded.correctOptionIds.join(', ')}
                      </span>
                    </span>
                  )}
                  {graded.restored && (
                    <button
                      type="button"
                      disabled={checkingId !== null || isSwitching}
                      onClick={() =>
                        handleCheck(currentQ.questionId, selections[currentQ.questionId], {
                          hydrateRestored: true,
                        })
                      }
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-zen text-xs font-medium text-matcha-700 dark:text-matcha-300 bg-rice-paper-50/90 dark:bg-tea-slate-200/80 border border-matcha-400/50 dark:border-matcha-600/50 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50"
                    >
                      {checkingId === currentQ.questionId && <ZenPendingDot />}
                      <span>
                        {checkingId === currentQ.questionId
                          ? 'Loading…'
                          : 'Load Answer & Explanation'}
                      </span>
                    </button>
                  )}
                </div>

                {graded.explanation && (
                  <div className="pt-3 border-t border-rice-paper-400/70 dark:border-tea-slate-50/40 text-[0.88rem] leading-relaxed text-ink-700 dark:text-sage-200">
                    <p className="text-[0.72rem] uppercase tracking-wider font-medium text-ink-400 dark:text-sage-400 mt-0 mb-2">
                      Explanation
                    </p>
                    <StudyRichText
                      text={graded.explanation}
                      imageRefs={currentQ.imageRefs}
                      placement="explanation"
                    />
                  </div>
                )}
              </div>
            )
          })()}

          {/* Remaining Unanswered Notice on Final Question */}
          {showUnansweredPrompt && (
            <div className="rounded-zen px-4 py-3 bg-rice-paper-200/70 dark:bg-tea-slate-300/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50 flex flex-wrap items-center justify-between gap-3 text-xs animate-study-feedback">
              <span className="text-ink-600 dark:text-sage-300">
                {summary.remainingUnansweredCount}{' '}
                {summary.remainingUnansweredCount === 1
                  ? 'unanswered question'
                  : 'unanswered questions'}{' '}
                remaining before finishing.
              </span>
              <button
                type="button"
                disabled={isSwitching}
                onClick={handleGoToFirstUnanswered}
                className="px-3 py-1.5 rounded-zen font-medium text-matcha-700 dark:text-matcha-300 bg-matcha-50/90 dark:bg-matcha-900/35 border border-matcha-400/60 dark:border-matcha-600/50 hover:bg-matcha-100/80 dark:hover:bg-matcha-900/55 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50"
              >
                Go to Q{summary.firstUnansweredIndex + 1} (First Unanswered)
              </button>
            </div>
          )}

          {/* Footer Navigation */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button
              type="button"
              disabled={!canGoPrevious}
              aria-keyshortcuts="ArrowLeft"
              onClick={goPrevious}
              className="px-3.5 py-2 rounded-zen text-[0.82rem] font-medium border border-rice-paper-400/80 dark:border-tea-slate-50/60 text-ink-600 dark:text-sage-300 disabled:opacity-40 transition-colors duration-150 motion-reduce:transition-none"
            >
              ← Previous
            </button>

            <div className="flex items-center gap-2.5">
              {!currentGraded && (
                <button
                  type="button"
                  aria-busy={checkingId === currentQ.questionId || undefined}
                  aria-keyshortcuts="Enter Space"
                  disabled={!hasCurrentSelection || checkingId !== null || isSwitching}
                  onClick={() => handleCheck(currentQ.questionId)}
                  className="inline-flex items-center gap-2 px-5 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 text-white disabled:opacity-55 transition-colors duration-150 motion-reduce:transition-none"
                >
                  {checkingId === currentQ.questionId && <ZenPendingDot />}
                  <span>
                    {checkingId === currentQ.questionId ? (
                      'Checking…'
                    ) : (
                      <>
                        Check Answer
                        <span className="hidden sm:inline font-mono text-[0.72rem] opacity-75 ml-1.5">
                          (Enter / Space)
                        </span>
                      </>
                    )}
                  </span>
                </button>
              )}
              {showFinishPractice ? (
                <button
                  type="button"
                  disabled={!canFinishPractice}
                  aria-keyshortcuts="Enter"
                  onClick={handleFinishPractice}
                  className="px-5 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500 text-white shadow-zen-sm disabled:opacity-55 transition-colors duration-150 motion-reduce:transition-none"
                >
                  Finish Practice
                  <span className="hidden sm:inline font-mono text-[0.72rem] opacity-75 ml-1.5">
                    (Enter)
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canGoNext}
                  aria-keyshortcuts={currentGraded ? 'ArrowRight Enter' : 'ArrowRight'}
                  onClick={goNext}
                  className="px-3.5 py-2 rounded-zen text-[0.82rem] font-medium border border-rice-paper-400/80 dark:border-tea-slate-50/60 text-ink-600 dark:text-sage-300 disabled:opacity-40 transition-colors duration-150 motion-reduce:transition-none"
                >
                  Next →
                  {currentGraded && canGoNext && (
                    <span className="hidden sm:inline font-mono text-[0.7rem] opacity-65 ml-1.5">
                      (Enter)
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
        </article>
      )}
    </div>
  )
}
