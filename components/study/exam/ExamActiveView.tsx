'use client'

import type { StudyQuestionPrompt } from '../../../lib/study/types'
import type { StartedExamSession } from '../../../lib/study/services/exam-service'
import { getOptionDisplayLabel } from '../../../lib/study/exam-shuffle'
import StudyRichText from '../StudyRichText'
import { ZenPendingDot } from '../StudySkeletons'

function formatTimer(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export interface ExamActiveViewProps {
  session: StartedExamSession
  currentIdx: number
  currentQuestion: StudyQuestionPrompt
  answers: Record<string, string[]>
  flagged: Record<string, boolean>
  answeredTotal: number
  remainingSeconds: number
  submitting: boolean
  error: string
  canGoPrevious: boolean
  canGoNext: boolean
  onSubmit: () => void
  onToggleOption: (questionId: string, optionId: string, isMulti: boolean) => void
  onToggleFlag: (questionId: string) => void
  onSelectQuestion: (index: number) => void
  onPrevious: () => void
  onNext: () => void
}

/**
 * Renders the timed Mock Exam screen: exam top bar (progress, countdown timer,
 * submit button), inline submission error banner, active question card with
 * positional option labels, and the question navigator grid.
 */
export function ExamActiveView({
  session,
  currentIdx,
  currentQuestion,
  answers,
  flagged,
  answeredTotal,
  remainingSeconds,
  submitting,
  error,
  canGoPrevious,
  canGoNext,
  onSubmit,
  onToggleOption,
  onToggleFlag,
  onSelectQuestion,
  onPrevious,
  onNext,
}: ExamActiveViewProps) {
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
            onClick={onSubmit}
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
            onClick={onSubmit}
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
              Question {currentIdx + 1} of {session.questions.length} · {currentQuestion.topic} ·{' '}
              {currentQuestion.questionType === 'multi_select' ? 'Multi-select' : 'Single-choice'}
            </span>
            <button
              type="button"
              disabled={submitting}
              onClick={() => onToggleFlag(currentQuestion.questionId)}
              className="px-2.5 py-1 rounded-zen border border-rice-paper-400/70 dark:border-tea-slate-50/60 text-xs disabled:opacity-50"
            >
              {flagged[currentQuestion.questionId] ? '⚑ Flagged' : '⚐ Flag for Review'}
            </button>
          </div>

          <StudyRichText
            text={currentQuestion.questionText}
            imageRefs={currentQuestion.imageRefs}
            placement="question"
            className="font-serif text-lg leading-relaxed text-ink-700 dark:text-sage-100"
          />

          <div className="space-y-2.5">
            {currentQuestion.options.map((opt, optIdx) => {
              const displayLabel = getOptionDisplayLabel(optIdx)
              const selected = (answers[currentQuestion.questionId] || []).includes(opt.id)
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    onToggleOption(
                      currentQuestion.questionId,
                      opt.id,
                      currentQuestion.questionType === 'multi_select'
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
                      {displayLabel}
                    </span>
                    <div className="flex-1 min-w-0">
                      <StudyRichText
                        text={opt.text}
                        imageRefs={currentQuestion.imageRefs}
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
              onClick={onPrevious}
              className="px-3.5 py-2 rounded-zen text-xs font-medium border border-rice-paper-400/80 dark:border-tea-slate-50/60 disabled:opacity-40 transition-colors duration-150 motion-reduce:transition-none"
            >
              ← Previous
            </button>
            <button
              type="button"
              disabled={!canGoNext}
              aria-keyshortcuts="ArrowRight Enter"
              onClick={onNext}
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
                  onClick={() => onSelectQuestion(idx)}
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
