'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  StartedExamSession,
  GradedExamResult,
} from '../../lib/study/services/exam-service'
import StudyRichText from './StudyRichText'
import { StudyLink } from './StudyNavigationContext'
import { ExamRunnerSkeleton, ZenPendingDot } from './StudySkeletons'
import { shouldIgnoreStudyShortcut } from '../../lib/study/keyboard'
import { recordMockExamResult } from '../../lib/study/local-progress'

function formatTimer(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export default function ExamRunnerClient({
  examId,
  userId,
}: {
  examId: string
  userId: string
}) {
  const [session, setSession] = useState<StartedExamSession | null>(null)
  const [result, setResult] = useState<GradedExamResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [currentIdx, setCurrentIdx] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [flagged, setFlagged] = useState<Record<string, boolean>>({})
  const [remainingSeconds, setRemainingSeconds] = useState(0)

  const startAbortRef = useRef<AbortController | null>(null)
  const startSeqRef = useRef(0)
  const submitAbortRef = useRef<AbortController | null>(null)
  const submitLockRef = useRef(false)

  const startExam = useCallback(async () => {
    startAbortRef.current?.abort()
    submitAbortRef.current?.abort()
    submitLockRef.current = false
    setSubmitting(false)

    const controller = new AbortController()
    startAbortRef.current = controller
    const seq = ++startSeqRef.current

    setLoading(true)
    setError('')
    setResult(null)
    setAnswers({})
    setFlagged({})
    setCurrentIdx(0)

    try {
      const res = await fetch('/api/study/exams/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to start this exam collection.')
      const started = (await res.json()) as StartedExamSession
      if (seq !== startSeqRef.current) return
      setSession(started)
      const diffSec = Math.max(
        0,
        Math.floor((Date.parse(started.expiresAt) - Date.now()) / 1000)
      )
      setRemainingSeconds(diffSec)
    } catch (err) {
      if (controller.signal.aborted || seq !== startSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to start exam.')
    } finally {
      if (seq === startSeqRef.current) {
        setLoading(false)
      }
    }
  }, [examId])

  useEffect(() => {
    startExam()
    return () => {
      startAbortRef.current?.abort()
      submitAbortRef.current?.abort()
      startSeqRef.current += 1
    }
  }, [startExam])

  const handleSubmit = useCallback(async () => {
    if (!session || submitting || submitLockRef.current || result) return

    submitLockRef.current = true
    submitAbortRef.current?.abort()
    const controller = new AbortController()
    submitAbortRef.current = controller
    const startSeqAtSubmit = startSeqRef.current

    setSubmitting(true)
    setError('')

    try {
      const res = await fetch('/api/study/exams/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          examToken: session.examToken,
          answers,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to grade exam right now.')
      const graded = (await res.json()) as GradedExamResult
      if (startSeqAtSubmit !== startSeqRef.current) return
      recordMockExamResult(userId, examId, graded)
      setResult(graded)
    } catch (err) {
      if (controller.signal.aborted || startSeqAtSubmit !== startSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to submit exam.')
    } finally {
      if (startSeqAtSubmit === startSeqRef.current) {
        submitLockRef.current = false
        setSubmitting(false)
      }
    }
  }, [session, submitting, result, answers, userId, examId])

  // Countdown timer
  useEffect(() => {
    if (!session || result) return
    const id = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(id)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [session, result])

  // Auto-submit when timer hits zero
  useEffect(() => {
    if (session && !result && remainingSeconds === 0 && !submitting && !submitLockRef.current) {
      handleSubmit()
    }
  }, [session, result, remainingSeconds, submitting, handleSubmit])

  const totalQuestions = session?.questions.length ?? 0
  const canGoPrevious = Boolean(session && !submitting && currentIdx > 0)
  const canGoNext = Boolean(session && !submitting && currentIdx < totalQuestions - 1)

  const goPrevious = useCallback(() => {
    if (!canGoPrevious) return
    setCurrentIdx((i) => Math.max(0, i - 1))
  }, [canGoPrevious])

  const goNext = useCallback(() => {
    if (!canGoNext) return
    setCurrentIdx((i) => Math.min(totalQuestions - 1, i + 1))
  }, [canGoNext, totalQuestions])

  // Keyboard shortcuts: ArrowLeft = Previous, ArrowRight / Enter = Next.
  // Never automatically submits the exam.
  useEffect(() => {
    if (loading || !session || result || submitting) return

    function onKeyDown(e: KeyboardEvent) {
      if (shouldIgnoreStudyShortcut(e)) return

      if (e.key === 'ArrowLeft') {
        if (!canGoPrevious) return
        e.preventDefault()
        goPrevious()
        return
      }

      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (!canGoNext) return
        e.preventDefault()
        goNext()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [loading, session, result, submitting, canGoPrevious, canGoNext, goPrevious, goNext])

  function toggleOption(questionId: string, optionId: string, isMulti: boolean) {
    if (submitting) return
    setAnswers((prev) => {
      const curr = prev[questionId] || []
      if (!isMulti) return { ...prev, [questionId]: [optionId] }
      const exists = curr.includes(optionId)
      return {
        ...prev,
        [questionId]: exists ? curr.filter((id) => id !== optionId) : [...curr, optionId],
      }
    })
  }

  if (loading) {
    return <ExamRunnerSkeleton />
  }

  if (error && !session) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 space-y-4 animate-study-feedback">
        <div
          role="alert"
          className="rounded-card p-6 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={startExam}
            className="self-start sm:self-auto px-4 py-2 rounded-zen text-xs font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 dark:border-rose-400/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none shrink-0"
          >
            Try Again
          </button>
        </div>
        <StudyLink href="/study/exams" className="text-sm text-matcha-600 dark:text-matcha-300 no-underline hover:underline">
          ← Back to Mock Exams
        </StudyLink>
      </div>
    )
  }

  // ── Post-Exam Results & Review ──
  if (result) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-8 animate-study-feedback">
        <section className="rounded-card p-6 sm:p-8 bg-rice-paper-50/95 dark:bg-tea-slate-200/70 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="text-[0.72rem] uppercase tracking-[0.2em] font-medium text-matcha-600 dark:text-matcha-400">
                Exam Results
              </span>
              <h1 className="font-serif text-3xl font-medium text-ink-700 dark:text-sage-100 mt-1 mb-1">
                {result.scorePercent}% — {result.passed ? 'Passed' : 'Not Yet Passed'}
              </h1>
              <p className="text-xs text-ink-400 dark:text-sage-500 m-0">
                Pass threshold: {result.passThresholdPercent}% · {result.totalQuestions} questions
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={startExam}
                className="px-4 py-2 rounded-zen text-xs font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-150 motion-reduce:transition-none"
              >
                Retake Exam
              </button>
              <StudyLink
                href="/study/exams"
                className="px-4 py-2 rounded-zen text-xs font-medium border border-rice-paper-400 dark:border-tea-slate-50/60 text-ink-600 dark:text-sage-300 no-underline"
              >
                All Exams
              </StudyLink>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mt-6 text-center">
            <div className="rounded-zen py-3 bg-matcha-50/80 dark:bg-matcha-900/30 border border-matcha-200/70 dark:border-matcha-700/50">
              <div className="font-serif text-xl font-medium text-matcha-700 dark:text-matcha-300">
                {result.correctCount}
              </div>
              <div className="text-xs text-ink-500 dark:text-sage-400">Correct</div>
            </div>
            <div className="rounded-zen py-3 bg-rose-50/60 dark:bg-rose-950/25 border border-earth-rust/30">
              <div className="font-serif text-xl font-medium text-earth-rust dark:text-rose-300">
                {result.incorrectCount}
              </div>
              <div className="text-xs text-ink-500 dark:text-sage-400">Incorrect</div>
            </div>
            <div className="rounded-zen py-3 bg-rice-paper-200/70 dark:bg-tea-slate-300/60 border border-rice-paper-400/60 dark:border-tea-slate-50/40">
              <div className="font-serif text-xl font-medium text-ink-600 dark:text-sage-300">
                {result.skippedCount}
              </div>
              <div className="text-xs text-ink-500 dark:text-sage-400">Skipped</div>
            </div>
          </div>
        </section>

        {/* Topic Breakdown */}
        {result.topicBreakdown.length > 0 && (
          <section className="rounded-card p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50 space-y-3">
            <h2 className="font-serif text-lg font-medium text-ink-700 dark:text-sage-100 mt-0 mb-2">
              Topic Breakdown
            </h2>
            {result.topicBreakdown.map((t) => (
              <div key={t.topic} className="flex items-center justify-between text-sm">
                <span className="text-ink-700 dark:text-sage-200">{t.topic}</span>
                <span className="font-mono text-xs text-ink-500 dark:text-sage-400">
                  {t.correct}/{t.total} ({t.accuracyPercent}%)
                </span>
              </div>
            ))}
          </section>
        )}

        {/* Detailed Post-Exam Review */}
        <section className="space-y-4">
          <h2 className="font-serif text-lg font-medium text-ink-700 dark:text-sage-100 m-0">
            Detailed Review
          </h2>
          {result.reviewItems.map((item, idx) => (
            <article
              key={item.questionId}
              className="rounded-card p-5 sm:p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50 space-y-3"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono text-ink-400 dark:text-sage-500">
                  Q{idx + 1} · {item.prompt.topic}
                </span>
                <span
                  className={`font-medium ${
                    item.isCorrect
                      ? 'text-matcha-600 dark:text-matcha-300'
                      : item.isSkipped
                        ? 'text-ink-400 dark:text-sage-500'
                        : 'text-earth-rust dark:text-rose-300'
                  }`}
                >
                  {item.isCorrect ? 'Correct' : item.isSkipped ? 'Skipped' : 'Incorrect'}
                </span>
              </div>
              <StudyRichText
                text={item.prompt.questionText}
                imageRefs={item.prompt.imageRefs}
                placement="question"
                className="font-serif text-base text-ink-700 dark:text-sage-100"
              />
              <div className="text-xs font-mono text-ink-500 dark:text-sage-400">
                Your answer: {item.selectedOptionIds.join(', ') || 'None'} · Correct:{' '}
                <strong className="text-matcha-700 dark:text-matcha-300">
                  {item.correctOptionIds.join(', ')}
                </strong>
              </div>
              {item.explanation && (
                <div className="rounded-zen p-3.5 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 text-[0.85rem] leading-relaxed text-ink-600 dark:text-sage-300">
                  <StudyRichText
                    text={item.explanation}
                    imageRefs={item.prompt.imageRefs}
                    placement="explanation"
                  />
                </div>
              )}
            </article>
          ))}
        </section>
      </div>
    )
  }

  if (!session) return null
  const currentQ = session.questions[currentIdx]
  const answeredTotal = Object.values(answers).filter((a: string[]) => a.length > 0).length

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6 animate-study-feedback">
      {/* ── Exam Top Bar ── */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-rice-paper-400/70 dark:border-tea-slate-50/50">
        <div>
          <h1 className="font-serif text-xl sm:text-2xl font-medium text-ink-700 dark:text-sage-100 m-0">
            {session.exam.title}
          </h1>
          <p className="text-xs text-ink-400 dark:text-sage-500 mt-1 mb-0">
            Answered {answeredTotal} / {session.questions.length} · Answers are graded server-side upon submission.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div
            aria-label="Remaining time"
            className="px-3 py-1.5 rounded-zen font-mono text-sm bg-rice-paper-200/80 dark:bg-tea-slate-200 border border-rice-paper-400/70 dark:border-tea-slate-50/60 text-ink-700 dark:text-sage-100"
          >
            {formatTimer(remainingSeconds)}
          </div>
          <button
            type="button"
            disabled={submitting}
            aria-busy={submitting || undefined}
            onClick={handleSubmit}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-zen text-xs font-medium bg-matcha-500 hover:bg-matcha-600 text-white disabled:opacity-60 transition-colors duration-150 motion-reduce:transition-none"
          >
            {submitting && <ZenPendingDot />}
            <span>{submitting ? 'Grading…' : 'Submit Exam'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-3 py-1 rounded-zen text-xs font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 dark:border-rose-400/40 disabled:opacity-50 shrink-0"
          >
            Retry Submit
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-6 items-start">
        {/* Active Question */}
        <article
          aria-busy={submitting || undefined}
          className={[
            'rounded-card p-6 sm:p-8 bg-rice-paper-50/95 dark:bg-tea-slate-200/70 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-6',
            'transition-opacity duration-150 motion-reduce:transition-none',
            submitting ? 'opacity-70' : 'opacity-100',
          ].join(' ')}
        >
          <div className="flex items-center justify-between text-xs text-ink-400 dark:text-sage-500">
            <span>
              Question {currentIdx + 1} of {session.questions.length} · {currentQ.topic} ·{' '}
              {currentQ.questionType === 'multi_select' ? 'Multi-select' : 'Single-choice'}
            </span>
            <button
              type="button"
              disabled={submitting}
              onClick={() =>
                setFlagged((p) => ({ ...p, [currentQ.questionId]: !p[currentQ.questionId] }))
              }
              className="px-2.5 py-1 rounded-zen border border-rice-paper-400/70 dark:border-tea-slate-50/60 text-xs disabled:opacity-50"
            >
              {flagged[currentQ.questionId] ? '⚑ Flagged' : '⚐ Flag for Review'}
            </button>
          </div>

          <StudyRichText
            text={currentQ.questionText}
            imageRefs={currentQ.imageRefs}
            placement="question"
            className="font-serif text-lg leading-relaxed text-ink-700 dark:text-sage-100"
          />

          <div className="space-y-2.5">
            {currentQ.options.map((opt) => {
              const selected = (answers[currentQ.questionId] || []).includes(opt.id)
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    toggleOption(
                      currentQ.questionId,
                      opt.id,
                      currentQ.questionType === 'multi_select'
                    )
                  }
                  className={[
                    'w-full text-left rounded-zen px-4 py-3 border text-[0.9rem]',
                    'transition-colors duration-150 motion-reduce:transition-none',
                    selected
                      ? 'bg-matcha-50/80 dark:bg-matcha-900/30 border-matcha-500 text-ink-700 dark:text-sage-100'
                      : 'bg-rice-paper-100/70 dark:bg-tea-slate-300/60 border-rice-paper-400/60 dark:border-tea-slate-50/40 text-ink-600 dark:text-sage-200 hover:border-matcha-400/60',
                  ].join(' ')}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="font-mono text-xs font-semibold px-1.5 py-0.5 rounded bg-rice-paper-200 dark:bg-tea-slate-100 text-ink-600 dark:text-sage-300 shrink-0 mt-0.5">
                      {opt.id}
                    </span>
                    <div className="flex-1 min-w-0">
                      <StudyRichText
                        text={opt.text}
                        imageRefs={currentQ.imageRefs}
                        placement="option"
                        optionId={opt.id}
                      />
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              disabled={!canGoPrevious}
              aria-keyshortcuts="ArrowLeft"
              onClick={goPrevious}
              className="px-3.5 py-2 rounded-zen text-xs font-medium border border-rice-paper-400/80 dark:border-tea-slate-50/60 disabled:opacity-40 transition-colors duration-150 motion-reduce:transition-none"
            >
              ← Previous
            </button>
            <button
              type="button"
              disabled={!canGoNext}
              aria-keyshortcuts="ArrowRight Enter"
              onClick={goNext}
              className="px-3.5 py-2 rounded-zen text-xs font-medium border border-rice-paper-400/80 dark:border-tea-slate-50/60 disabled:opacity-40 transition-colors duration-150 motion-reduce:transition-none"
            >
              Next →
              <span className="hidden sm:inline font-mono text-[0.68rem] opacity-65 ml-1.5">
                (Enter)
              </span>
            </button>
          </div>
        </article>

        {/* Question Navigator Grid */}
        <aside className="rounded-card p-4 bg-rice-paper-50/85 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50 space-y-3">
          <h2 className="text-xs uppercase tracking-wider font-medium text-ink-400 dark:text-sage-500 m-0">
            Navigator
          </h2>
          <div className="grid grid-cols-5 gap-1.5">
            {session.questions.map((q, idx) => {
              const isCurrent = idx === currentIdx
              const isAnswered = (answers[q.questionId] || []).length > 0
              const isFlagged = Boolean(flagged[q.questionId])
              return (
                <button
                  key={q.questionId}
                  type="button"
                  disabled={submitting}
                  onClick={() => setCurrentIdx(idx)}
                  aria-label={`Go to question ${idx + 1}`}
                  className={[
                    'h-8 rounded-[4px] font-mono text-xs border transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50',
                    isCurrent
                      ? 'border-matcha-600 bg-matcha-500 text-white'
                      : isFlagged
                        ? 'border-earth-rust/60 bg-rose-50/80 dark:bg-rose-950/30 text-earth-rust dark:text-rose-200'
                        : isAnswered
                          ? 'border-matcha-300/80 bg-matcha-50/80 dark:bg-matcha-900/30 text-matcha-700 dark:text-matcha-300'
                          : 'border-rice-paper-400/70 dark:border-tea-slate-50/50 text-ink-500 dark:text-sage-400',
                  ].join(' ')}
                >
                  {idx + 1}
                </button>
              )
            })}
          </div>
        </aside>
      </div>
    </div>
  )
}
