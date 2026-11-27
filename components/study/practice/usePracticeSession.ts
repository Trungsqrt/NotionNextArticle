'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { ExamCollection, StudyQuestionPrompt } from '../../../lib/study/types'
import type { PracticeExamPayload } from '../../../lib/study/services/practice-service'
import type { GradedQuestionResult } from '../../../lib/study/services/grading'
import {
  computePracticeCompletionSummary,
  shouldShowFinishPractice,
  shouldShowUnansweredPrompt,
  type PracticeCompletionSummary,
} from '../../../lib/study/practice-completion'
import {
  buildPracticeExamUrl,
  resolveExternalParamExamSwitch,
  resolvePracticeRetryAction,
  resolveValidExamId,
  shouldShowViewSummaryButton,
  type PracticeError,
} from '../../../lib/study/practice-state'
import {
  clearPracticeAttempt,
  readPracticeAttempt,
  writePracticeAttempt,
  writePracticeSummary,
} from '../../../lib/study/local-progress'
import type {
  BookmarkSyncSnapshot,
  BookmarkTransientFeedbackPhase,
} from '../../../lib/study/bookmark-sync'
import { usePracticeBookmarks } from './usePracticeBookmarks'
import type {
  LegacyBookmarkImportCandidate,
  PracticeFetchStatus,
  PracticeFilter,
  PracticeResultEntry,
} from './types'

export interface UsePracticeSessionParams {
  exams: ExamCollection[]
  userId: string
  paramExamId: string
}

export interface PracticeSessionState {
  // Exam selection & fetch status
  activeExamId: string
  displayedExamId: string
  currentExamTitle: string
  payload: PracticeExamPayload | null
  fetchStatus: PracticeFetchStatus
  isInitialLoading: boolean
  isSwitching: boolean
  isInitialError: boolean
  practiceError: PracticeError | null

  // Questions, filters & navigation
  allQuestions: StudyQuestionPrompt[]
  filteredQuestions: StudyQuestionPrompt[]
  filter: PracticeFilter
  safeIndex: number
  currentQ: StudyQuestionPrompt | null
  currentGraded: boolean
  hasCurrentSelection: boolean
  canGoPrevious: boolean
  canGoNext: boolean

  // Answers, grading & completion
  selections: Record<string, string[]>
  results: Record<string, PracticeResultEntry>
  checkingId: string | null
  isCompleted: boolean
  summary: PracticeCompletionSummary
  showViewSummary: boolean
  showFinishPractice: boolean
  canFinishPractice: boolean
  showUnansweredPrompt: boolean

  // Bookmarks & legacy import
  bookmarks: Record<string, boolean>
  bookmarkSync: BookmarkSyncSnapshot
  bookmarkFeedbackPhase: BookmarkTransientFeedbackPhase
  legacyImportCandidate: LegacyBookmarkImportCandidate | null
  importingLegacy: boolean
  legacyImportError: string | null

  // Actions
  selectExam: (examId: string) => void
  retryLoadActiveExam: () => void
  retryError: () => void
  dismissError: () => void
  selectFilter: (nextFilter: PracticeFilter) => void
  openSummary: () => void
  toggleOption: (questionId: string, optionId: string, isMulti: boolean) => void
  checkAnswer: (
    questionId: string,
    overrideSelected?: string[],
    options?: { hydrateRestored?: boolean }
  ) => Promise<void>
  goPrevious: () => void
  goNext: () => void
  finishPractice: () => void
  goToFirstUnanswered: () => void
  reviewIncorrect: () => void
  reviewBookmarked: () => void
  restartPractice: () => void
  toggleBookmark: (questionId: string) => void
  retryBookmarkSync: () => void
  importLegacyBookmarks: (examId: string, questionIds: string[]) => Promise<void>
  dismissLegacyImport: () => void
}

/**
 * Restores a locally persisted Practice attempt into component state without
 * ever reading answer keys or explanations from localStorage.
 */
function restoreLocalPracticeAttempt(
  userId: string,
  examId: string,
  questions: StudyQuestionPrompt[],
  initialBookmarks: Readonly<Record<string, boolean>>
) {
  const questionById = new Map(questions.map((q) => [q.questionId, q]))
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
  const restoredFilteredLen = questions.filter((q) => {
    if (restoredFilter === 'incorrect') return restoredResults[q.questionId]?.isCorrect === false
    if (restoredFilter === 'bookmarked') return Boolean(initialBookmarks[q.questionId])
    return true
  }).length
  const restoredIndex = savedAttempt
    ? Math.min(savedAttempt.currentIndex, Math.max(0, restoredFilteredLen - 1))
    : 0
  const restoredSummary = computePracticeCompletionSummary(
    questions,
    restoredResults,
    initialBookmarks
  )
  const restoredCompleted = Boolean(savedAttempt?.completed && restoredSummary.allGraded)

  return {
    restoredSelections,
    restoredResults,
    restoredFilter,
    restoredIndex,
    restoredCompleted,
  }
}

/**
 * Coordinates Practice Mode's exam loading/switching, local progress
 * persistence, answer grading, filtering, navigation, and bookmark sync.
 */
export function usePracticeSession({
  exams,
  userId,
  paramExamId,
}: UsePracticeSessionParams): PracticeSessionState {
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
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [isCompleted, setIsCompleted] = useState(false)

  // Mirrors & monotonic concurrency guards preventing stale responses from
  // clobbering newer exam switches or Check Answer requests.
  const activeExamIdRef = useRef(initialExamId)
  const pendingExamIdRef = useRef<string | null>(null)
  const lastHandledParamExamIdRef = useRef(paramExamId.trim())
  const payloadRef = useRef<PracticeExamPayload | null>(null)
  const hydratedExamIdRef = useRef<string>('')
  const examAbortRef = useRef<AbortController | null>(null)
  const examLoadSeqRef = useRef(0)
  const sessionVersionRef = useRef(0)
  const checkAbortRef = useRef<AbortController | null>(null)
  const checkSeqRef = useRef(0)
  const checkLockRef = useRef(false)

  const isCurrentSession = useCallback((sessionVersion: number, examId: string) => {
    return sessionVersionRef.current === sessionVersion && activeExamIdRef.current === examId
  }, [])

  const getCurrentSessionVersion = useCallback(() => sessionVersionRef.current, [])

  const bookmarksApi = usePracticeBookmarks({
    userId,
    activeExamId,
    payload,
    isCurrentSession,
    getCurrentSessionVersion,
  })
  const { bookmarks, initializeForExam, setActiveQuestion, destroy: destroyBookmarks } =
    bookmarksApi

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

        // Commit the new exam atomically and cancel any in-flight Check Answer request
        checkAbortRef.current?.abort()
        checkLockRef.current = false
        setCheckingId(null)
        sessionVersionRef.current += 1

        const validQuestionIds = new Set(data.questions.map((q) => q.questionId))
        const controllerSession = sessionVersionRef.current

        const { controller: syncController, initialSnapshot } = initializeForExam({
          examId,
          validQuestionIds,
          sessionVersion: controllerSession,
        })

        const restored = restoreLocalPracticeAttempt(
          userId,
          examId,
          data.questions,
          initialSnapshot.bookmarks
        )

        activeExamIdRef.current = examId
        pendingExamIdRef.current = null
        payloadRef.current = data
        hydratedExamIdRef.current = examId

        setActiveExamId(examId)
        setPendingExamId(null)
        setPayload(data)
        setSelections(restored.restoredSelections)
        setResults(restored.restoredResults)
        setFilter(restored.restoredFilter)
        setCurrentIndex(restored.restoredIndex)
        setIsCompleted(restored.restoredCompleted)
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
    [exams, userId, initializeForExam]
  )

  // Initial exam load on mount + abort/cleanup on unmount
  useEffect(() => {
    if (initialExamId) {
      void loadExam(initialExamId, { syncUrlOnSuccess: false })
    }
    return () => {
      examAbortRef.current?.abort()
      checkAbortRef.current?.abort()
      destroyBookmarks()
      examLoadSeqRef.current += 1
      checkSeqRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      void loadExam(externalTarget, { syncUrlOnSuccess: false })
    }
  }, [paramExamId, exams, loadExam])

  const selectExam = useCallback(
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

      void loadExam(nextExamId, { syncUrlOnSuccess: true })
    },
    [exams, loadExam]
  )

  const toggleOption = useCallback(
    (questionId: string, optionId: string, isMulti: boolean) => {
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
    },
    [results, checkingId, fetchStatus]
  )

  const checkAnswer = useCallback(
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
        if (
          currentPayload &&
          currentPayload.exam.examId === activeExamIdRef.current &&
          !options?.hydrateRestored
        ) {
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

  const retryError = useCallback(() => {
    const action = resolvePracticeRetryAction(practiceError, selections)
    if (!action) return
    if (action.type === 'check_answer') {
      void checkAnswer(action.questionId, action.selectedOptionIds)
    } else {
      void loadExam(action.examId, { syncUrlOnSuccess: action.isSwitch })
    }
  }, [practiceError, selections, checkAnswer, loadExam])

  const retryLoadActiveExam = useCallback(() => {
    void loadExam(activeExamId, { syncUrlOnSuccess: false })
  }, [activeExamId, loadExam])

  const dismissError = useCallback(() => {
    setPracticeError(null)
  }, [])

  // Derived view state
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
  const currentQuestionId = currentQ?.questionId ?? null

  // Immediately hide transient bookmark feedback when navigating to another question
  // without canceling any pending background synchronization.
  useEffect(() => {
    setActiveQuestion(currentQuestionId)
  }, [currentQuestionId, setActiveQuestion])

  const currentGraded = currentQ ? Boolean(results[currentQ.questionId]) : false
  const hasCurrentSelection = currentQ ? (selections[currentQ.questionId] || []).length > 0 : false
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

  const showViewSummary = shouldShowViewSummaryButton({
    allGraded: summary.allGraded,
    isCompleted,
    isInitialLoading,
  })

  const selectFilter = useCallback((nextFilter: PracticeFilter) => {
    setIsCompleted(false)
    setFilter(nextFilter)
    setCurrentIndex(0)
  }, [])

  const openSummary = useCallback(() => {
    setIsCompleted(true)
  }, [])

  const goPrevious = useCallback(() => {
    if (!canGoPrevious) return
    setCurrentIndex((i) => Math.max(0, i - 1))
  }, [canGoPrevious])

  const goNext = useCallback(() => {
    if (!canGoNext) return
    setCurrentIndex((i) => Math.min(filteredQuestions.length - 1, i + 1))
  }, [canGoNext, filteredQuestions.length])

  const finishPractice = useCallback(() => {
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

  const goToFirstUnanswered = useCallback(() => {
    if (summary.firstUnansweredIndex < 0 || isSwitching) return
    setFilter('all')
    setCurrentIndex(summary.firstUnansweredIndex)
  }, [summary.firstUnansweredIndex, isSwitching])

  const reviewIncorrect = useCallback(() => {
    if (summary.incorrectCount === 0 || isSwitching) return
    setIsCompleted(false)
    setFilter('incorrect')
    setCurrentIndex(0)
  }, [summary.incorrectCount, isSwitching])

  const reviewBookmarked = useCallback(() => {
    if (summary.bookmarkedCount === 0 || isSwitching) return
    setIsCompleted(false)
    setFilter('bookmarked')
    setCurrentIndex(0)
  }, [summary.bookmarkedCount, isSwitching])

  const restartPractice = useCallback(() => {
    if (isSwitching) return
    // Cancel any in-flight Check Answer request; intentionally keep the
    // bookmark sync controller alive so pending/synced bookmarks are preserved.
    checkAbortRef.current?.abort()
    checkLockRef.current = false
    checkSeqRef.current += 1
    if (activeExamIdRef.current) {
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

  const displayedExamId = pendingExamId || activeExamId
  const currentExamTitle =
    payload?.exam.title ||
    exams.find((ex) => ex.examId === activeExamId)?.title ||
    'Practice Set'

  return {
    activeExamId,
    displayedExamId,
    currentExamTitle,
    payload,
    fetchStatus,
    isInitialLoading,
    isSwitching,
    isInitialError,
    practiceError,
    allQuestions,
    filteredQuestions,
    filter,
    safeIndex,
    currentQ,
    currentGraded,
    hasCurrentSelection,
    canGoPrevious,
    canGoNext,
    selections,
    results,
    checkingId,
    isCompleted,
    summary,
    showViewSummary,
    showFinishPractice,
    canFinishPractice,
    showUnansweredPrompt,
    bookmarks,
    bookmarkSync: bookmarksApi.bookmarkSync,
    bookmarkFeedbackPhase: bookmarksApi.bookmarkFeedbackPhase,
    legacyImportCandidate: bookmarksApi.legacyImportCandidate,
    importingLegacy: bookmarksApi.importingLegacy,
    legacyImportError: bookmarksApi.legacyImportError,
    selectExam,
    retryLoadActiveExam,
    retryError,
    dismissError,
    selectFilter,
    openSummary,
    toggleOption,
    checkAnswer,
    goPrevious,
    goNext,
    finishPractice,
    goToFirstUnanswered,
    reviewIncorrect,
    reviewBookmarked,
    restartPractice,
    toggleBookmark: bookmarksApi.toggleBookmark,
    retryBookmarkSync: bookmarksApi.retryBookmarkSync,
    importLegacyBookmarks: bookmarksApi.importLegacyBookmarks,
    dismissLegacyImport: bookmarksApi.dismissLegacyImport,
  }
}
