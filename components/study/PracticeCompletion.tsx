'use client'

import { StudyLink } from './StudyNavigationContext'

interface PracticeCompletionProps {
  examTitle: string
  accuracyPercent: number
  completedCount: number
  totalQuestions: number
  correctCount: number
  incorrectCount: number
  bookmarkedCount: number
  onReviewIncorrect: () => void
  onReviewBookmarked: () => void
  onRestart: () => void
  disabled?: boolean
}

const RING_SIZE = 120
const RING_STROKE = 7
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export default function PracticeCompletion({
  examTitle,
  accuracyPercent,
  completedCount,
  totalQuestions,
  correctCount,
  incorrectCount,
  bookmarkedCount,
  onReviewIncorrect,
  onReviewBookmarked,
  onRestart,
  disabled = false,
}: PracticeCompletionProps) {
  const clampedAccuracy = Math.max(0, Math.min(100, accuracyPercent))
  const strokeDashoffset =
    RING_CIRCUMFERENCE - (clampedAccuracy / 100) * RING_CIRCUMFERENCE

  return (
    <section
      aria-label="Practice completed summary"
      aria-busy={disabled || undefined}
      className={[
        'rounded-card p-6 sm:p-10 bg-rice-paper-50/95 dark:bg-tea-slate-200/70',
        'border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm',
        'space-y-8 animate-study-feedback transition-opacity duration-150 ease-zen motion-reduce:transition-none',
        disabled ? 'opacity-60' : 'opacity-100',
      ].join(' ')}
    >
      {/* ── Calm Header ── */}
      <header className="text-center space-y-2 max-w-lg mx-auto">
        <p className="text-[0.72rem] uppercase tracking-[0.18em] font-medium text-matcha-600 dark:text-matcha-400 m-0">
          {examTitle}
        </p>
        <h2 className="font-serif text-2xl sm:text-3xl font-medium text-ink-700 dark:text-sage-100 m-0">
          Practice Completed
        </h2>
        <p className="font-serif italic text-[0.95rem] text-ink-500 dark:text-sage-400 m-0">
          Small steps, lasting knowledge.
        </p>
      </header>

      {/* ── Circular Accuracy Indicator ── */}
      <div className="flex justify-center">
        <div
          role="img"
          aria-label={`Practice accuracy: ${clampedAccuracy}%`}
          className="relative w-32 h-32 flex items-center justify-center"
        >
          <svg
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            className="w-full h-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={RING_STROKE}
              className="stroke-rice-paper-300 dark:stroke-tea-slate-100"
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={strokeDashoffset}
              className="stroke-matcha-500 dark:stroke-matcha-400 transition-[stroke-dashoffset] duration-500 ease-zen motion-reduce:transition-none"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="font-serif text-3xl font-medium tabular-nums text-ink-700 dark:text-sage-100 leading-none">
              {clampedAccuracy}%
            </span>
            <span className="text-[0.68rem] uppercase tracking-[0.16em] text-ink-400 dark:text-sage-500 mt-1.5">
              Accuracy
            </span>
          </div>
        </div>
      </div>

      {/* ── Summary Metrics ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
        <div className="rounded-zen py-3.5 px-3 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/55 dark:border-tea-slate-50/40">
          <div className="font-serif text-xl font-medium tabular-nums text-ink-700 dark:text-sage-100">
            {completedCount}
            <span className="text-xs font-mono text-ink-400 dark:text-sage-500 font-normal">
              /{totalQuestions}
            </span>
          </div>
          <div className="text-[0.74rem] text-ink-500 dark:text-sage-400 mt-0.5">
            Completed
          </div>
        </div>

        <div className="rounded-zen py-3.5 px-3 bg-matcha-50/85 dark:bg-matcha-900/30 border border-matcha-200/75 dark:border-matcha-700/50">
          <div className="font-serif text-xl font-medium tabular-nums text-matcha-700 dark:text-matcha-300">
            {correctCount}
          </div>
          <div className="text-[0.74rem] text-ink-500 dark:text-sage-400 mt-0.5">
            Correct
          </div>
        </div>

        <div className="rounded-zen py-3.5 px-3 bg-earth-rust/[0.07] dark:bg-earth-rust/[0.16] border border-earth-rust/30 dark:border-earth-rust/45">
          <div className="font-serif text-xl font-medium tabular-nums text-[#7A4932] dark:text-[#E2BBA2]">
            {incorrectCount}
          </div>
          <div className="text-[0.74rem] text-ink-500 dark:text-sage-400 mt-0.5">
            Incorrect
          </div>
        </div>

        <div className="rounded-zen py-3.5 px-3 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/55 dark:border-tea-slate-50/40">
          <div className="font-serif text-xl font-medium tabular-nums text-ink-700 dark:text-sage-100">
            {bookmarkedCount}
          </div>
          <div className="text-[0.74rem] text-ink-500 dark:text-sage-400 mt-0.5">
            Bookmarked
          </div>
        </div>
      </div>

      {/* ── Actions ── */}
      <div className="pt-2 border-t border-rice-paper-400/60 dark:border-tea-slate-50/40 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <button
            type="button"
            disabled={disabled || incorrectCount === 0}
            onClick={onReviewIncorrect}
            className="px-4 py-2.5 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500 text-white shadow-zen-sm transition-colors duration-150 motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-matcha-500 dark:disabled:hover:bg-matcha-600"
          >
            Review Incorrect Answers{incorrectCount > 0 ? ` (${incorrectCount})` : ''}
          </button>

          <button
            type="button"
            disabled={disabled || bookmarkedCount === 0}
            onClick={onReviewBookmarked}
            className="px-4 py-2.5 rounded-zen text-[0.84rem] font-medium text-ink-700 dark:text-sage-200 bg-rice-paper-100 dark:bg-tea-slate-300/70 border border-rice-paper-400/80 dark:border-tea-slate-50/60 hover:border-matcha-400/70 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Review Bookmarked Questions{bookmarkedCount > 0 ? ` (${bookmarkedCount})` : ''}
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <button
            type="button"
            disabled={disabled}
            onClick={onRestart}
            className="px-4 py-2 rounded-zen text-[0.82rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400/80 dark:border-tea-slate-50/60 hover:border-matcha-400/70 hover:text-ink-700 dark:hover:text-sage-100 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-40"
          >
            Restart Practice
          </button>

          <StudyLink
            href="/study"
            className="px-4 py-2 rounded-zen text-[0.82rem] font-medium text-ink-500 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 no-underline transition-colors duration-150 motion-reduce:transition-none"
          >
            Return to Dashboard
          </StudyLink>
        </div>
      </div>
    </section>
  )
}
