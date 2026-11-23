'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import type { ExamCollection } from '../../lib/study/types'
import type { PracticeExamPayload } from '../../lib/study/services/practice-service'
import type { GradedQuestionResult } from '../../lib/study/services/grading'
import StudyRichText from './StudyRichText'
import { PracticeQuestionCardSkeleton, ZenPendingDot } from './StudySkeletons'

type PracticeFilter = 'all' | 'incorrect' | 'bookmarked'
type PracticeFetchStatus = 'idle' | 'loading' | 'switching' | 'error' | 'loaded'

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

export default function PracticeModeClient({ exams }: { exams: ExamCollection[] }) {
  const searchParams = useSearchParams()
  const paramExamId = searchParams?.get('examId') || ''
  const initialExamId = paramExamId || exams[0]?.examId || ''

  const [selectedExamId, setSelectedExamId] = useState(initialExamId)
  const [payload, setPayload] = useState<PracticeExamPayload | null>(null)
  const [fetchStatus, setFetchStatus] = useState<PracticeFetchStatus>(
    initialExamId ? 'loading' : 'idle'
  )
  const [error, setError] = useState('')

  const [filter, setFilter] = useState<PracticeFilter>('all')
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [results, setResults] = useState<Record<string, GradedQuestionResult>>({})
  const [bookmarks, setBookmarks] = useState<Record<string, boolean>>({})
  const [checkingId, setCheckingId] = useState<string | null>(null)

  const payloadRef = useRef<PracticeExamPayload | null>(null)
  const examAbortRef = useRef<AbortController | null>(null)
  const examSeqRef = useRef(0)
  const checkAbortRef = useRef<AbortController | null>(null)
  const checkSeqRef = useRef(0)
  const checkLockRef = useRef(false)

  // Keep selectedExamId aligned if URL query param changes
  useEffect(() => {
    if (paramExamId && paramExamId !== selectedExamId && exams.some((e) => e.examId === paramExamId)) {
      setSelectedExamId(paramExamId)
    }
  }, [paramExamId, selectedExamId, exams])

  // Restore bookmarks per exam from localStorage
  useEffect(() => {
    if (!selectedExamId) return
    try {
      const saved = localStorage.getItem(`study-bookmarks:${selectedExamId}`)
      if (saved) setBookmarks(JSON.parse(saved) as Record<string, boolean>)
      else setBookmarks({})
    } catch {
      setBookmarks({})
    }
  }, [selectedExamId])

  const loadExam = useCallback(async (examId: string) => {
    if (!examId) return

    // Abort any obsolete exam or answer-check requests before starting a new load
    examAbortRef.current?.abort()
    checkAbortRef.current?.abort()
    checkLockRef.current = false
    setCheckingId(null)

    const controller = new AbortController()
    examAbortRef.current = controller
    const seq = ++examSeqRef.current

    const hasExisting = payloadRef.current !== null
    setFetchStatus(hasExisting ? 'switching' : 'loading')
    setError('')

    try {
      const res = await fetch(`/api/study/practice/${encodeURIComponent(examId)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to load practice questions.')
      const data = (await res.json()) as PracticeExamPayload
      if (seq !== examSeqRef.current) return

      payloadRef.current = data
      setPayload(data)
      setCurrentIndex(0)
      setFilter('all')
      setSelections({})
      setResults({})
      setFetchStatus('loaded')
    } catch (err) {
      if (controller.signal.aborted || seq !== examSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load practice set.')
      setFetchStatus(payloadRef.current ? 'loaded' : 'error')
    }
  }, [])

  useEffect(() => {
    if (selectedExamId) {
      loadExam(selectedExamId)
    }
    return () => {
      examAbortRef.current?.abort()
      checkAbortRef.current?.abort()
      examSeqRef.current += 1
      checkSeqRef.current += 1
    }
  }, [selectedExamId, loadExam])

  function toggleBookmark(questionId: string) {
    setBookmarks((prev) => {
      const next = { ...prev, [questionId]: !prev[questionId] }
      if (!next[questionId]) delete next[questionId]
      try {
        localStorage.setItem(`study-bookmarks:${selectedExamId}`, JSON.stringify(next))
      } catch {
        // Ignore storage quota issues
      }
      return next
    })
  }

  function toggleOption(questionId: string, optionId: string, isMulti: boolean) {
    if (results[questionId] || checkingId === questionId || fetchStatus === 'switching') return
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

  async function handleCheck(questionId: string) {
    const selected = selections[questionId] || []
    if (
      selected.length === 0 ||
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
    const examSeqAtStart = examSeqRef.current

    setCheckingId(questionId)
    setError('')

    try {
      const res = await fetch('/api/study/practice/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, selectedOptionIds: selected }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to check answer right now.')
      const graded = (await res.json()) as GradedQuestionResult
      if (seq !== checkSeqRef.current || examSeqAtStart !== examSeqRef.current) return
      setResults((prev) => ({ ...prev, [questionId]: graded }))
    } catch (err) {
      if (controller.signal.aborted || seq !== checkSeqRef.current || examSeqAtStart !== examSeqRef.current) {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to check answer.')
    } finally {
      if (seq === checkSeqRef.current) {
        checkLockRef.current = false
        setCheckingId(null)
      }
    }
  }

  if (exams.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 text-center text-sm text-ink-500 dark:text-sage-400">
        No published exam collections are available for practice yet.
      </div>
    )
  }

  const isInitialLoading = fetchStatus === 'loading'
  const isSwitching = fetchStatus === 'switching'
  const isInitialError = fetchStatus === 'error' && !payload

  const allQuestions = payload?.questions || []
  const filteredQuestions = allQuestions.filter((q) => {
    if (filter === 'incorrect') return results[q.questionId]?.isCorrect === false
    if (filter === 'bookmarked') return Boolean(bookmarks[q.questionId])
    return true
  })

  const safeIndex = Math.min(currentIndex, Math.max(0, filteredQuestions.length - 1))
  const currentQ = filteredQuestions[safeIndex] || null
  const answeredCount = Object.keys(results).length
  const incorrectCount = Object.values(results).filter((r: GradedQuestionResult) => !r.isCorrect).length
  const bookmarkedCount = Object.keys(bookmarks).length

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      {/* ── Top Bar: Exam Selector & Filter ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-medium text-ink-700 dark:text-sage-100 m-0">
            Practice Mode
          </h1>
          <p className="text-[0.82rem] text-ink-400 dark:text-sage-500 mt-1 mb-0">
            Immediate feedback and explanations. Practice checks remain separate from FSRS memory ratings.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
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
          <select
            aria-label="Select exam collection"
            aria-busy={isSwitching || undefined}
            value={selectedExamId}
            onChange={(e) => setSelectedExamId(e.target.value)}
            className="rounded-zen px-3.5 py-2 text-[0.84rem] bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-rice-paper-400/90 dark:border-tea-slate-50/70 transition-colors duration-150 motion-reduce:transition-none"
          >
            {exams.map((ex) => (
              <option key={ex.examId} value={ex.examId}>
                {ex.title} ({ex.questionCount})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Filter Tabs + Progress ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 rounded-zen bg-rice-paper-200/70 dark:bg-tea-slate-200/70 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-xs">
          {(
            [
              { key: 'all', label: isInitialLoading ? 'All' : `All (${allQuestions.length})` },
              { key: 'incorrect', label: isInitialLoading ? 'Incorrect' : `Incorrect (${incorrectCount})` },
              { key: 'bookmarked', label: isInitialLoading ? 'Bookmarked' : `Bookmarked (${bookmarkedCount})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              disabled={isInitialLoading || isSwitching}
              onClick={() => {
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
        <span className="text-xs font-mono text-ink-500 dark:text-sage-400">
          {isInitialLoading ? 'Loading set…' : `Checked: ${answeredCount}/${allQuestions.length}`}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => loadExam(selectedExamId)}
            disabled={isInitialLoading || isSwitching}
            className="px-3 py-1 rounded-zen text-xs font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 dark:border-rose-400/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50 shrink-0"
          >
            Try Again
          </button>
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
            onClick={() => loadExam(selectedExamId)}
            className="px-4 py-2 rounded-zen text-xs font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-150 motion-reduce:transition-none"
          >
            Retry Loading Questions
          </button>
        </div>
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
              const isCorrectOption = Boolean(graded?.correctOptionIds.includes(opt.id))
              const isCorrectSelection = Boolean(graded && selected && isCorrectOption)
              const isMissedCorrect = Boolean(graded && !selected && isCorrectOption)
              const isWrongSelection = Boolean(graded && selected && !isCorrectOption)
              const isUnselectedNeutral = Boolean(graded && !selected && !isCorrectOption)
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
                  {!graded.isCorrect && (
                    <span className="text-xs font-medium text-ink-600 dark:text-sage-200">
                      Correct answer:{' '}
                      <span className="font-mono font-semibold text-matcha-700 dark:text-matcha-200">
                        {graded.correctOptionIds.join(', ')}
                      </span>
                    </span>
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

          {/* Footer Navigation */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button
              type="button"
              disabled={safeIndex === 0 || isSwitching}
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              className="px-3.5 py-2 rounded-zen text-[0.82rem] font-medium border border-rice-paper-400/80 dark:border-tea-slate-50/60 text-ink-600 dark:text-sage-300 disabled:opacity-40 transition-colors duration-150 motion-reduce:transition-none"
            >
              ← Previous
            </button>

            <div className="flex items-center gap-2.5">
              {!results[currentQ.questionId] && (
                <button
                  type="button"
                  aria-busy={checkingId === currentQ.questionId || undefined}
                  disabled={
                    (selections[currentQ.questionId] || []).length === 0 ||
                    checkingId !== null ||
                    isSwitching
                  }
                  onClick={() => handleCheck(currentQ.questionId)}
                  className="inline-flex items-center gap-2 px-5 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 text-white disabled:opacity-55 transition-colors duration-150 motion-reduce:transition-none"
                >
                  {checkingId === currentQ.questionId && <ZenPendingDot />}
                  <span>
                    {checkingId === currentQ.questionId ? 'Checking…' : 'Check Answer'}
                  </span>
                </button>
              )}
              <button
                type="button"
                disabled={safeIndex >= filteredQuestions.length - 1 || isSwitching}
                onClick={() =>
                  setCurrentIndex((i) => Math.min(filteredQuestions.length - 1, i + 1))
                }
                className="px-3.5 py-2 rounded-zen text-[0.82rem] font-medium border border-rice-paper-400/80 dark:border-tea-slate-50/60 text-ink-600 dark:text-sage-300 disabled:opacity-40 transition-colors duration-150 motion-reduce:transition-none"
              >
                Next →
              </button>
            </div>
          </div>
        </article>
      )}
    </div>
  )
}
