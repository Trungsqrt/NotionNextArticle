'use client'

import type { GradedExamResult } from '../../../lib/study/services/exam-service'
import {
  formatOptionDisplayLabels,
  getOptionDisplayLabel,
} from '../../../lib/study/exam-shuffle'
import StudyRichText from '../StudyRichText'
import { StudyLink } from '../StudyNavigationContext'

function getReviewOptionStyle(isCorrectOpt: boolean, isWrongSelection: boolean): {
  optionTone: string
  badgeTone: string
} {
  if (isCorrectOpt) {
    return {
      optionTone:
        'bg-matcha-50/85 dark:bg-matcha-900/35 border-matcha-400/80 dark:border-matcha-600/70 text-ink-700 dark:text-sage-100',
      badgeTone: 'bg-matcha-600 dark:bg-matcha-500 text-white',
    }
  }
  if (isWrongSelection) {
    return {
      optionTone:
        'bg-earth-rust/[0.09] dark:bg-earth-rust/[0.18] border-earth-rust/70 dark:border-earth-rust/75 text-ink-700 dark:text-sage-100',
      badgeTone: 'bg-earth-rust text-white',
    }
  }
  return {
    optionTone:
      'bg-rice-paper-100/60 dark:bg-tea-slate-300/45 border-rice-paper-400/50 dark:border-tea-slate-50/35 text-ink-500 dark:text-sage-400',
    badgeTone: 'bg-rice-paper-200 dark:bg-tea-slate-100 text-ink-600 dark:text-sage-300',
  }
}

export interface ExamResultsReviewProps {
  result: GradedExamResult
  onRetake: () => void
}

/**
 * Renders server-graded Mock Exam results: overall score summary, topic
 * accuracy breakdown, and per-question detailed review preserving the exact
 * randomized question and option order from the exam session.
 */
export function ExamResultsReview({ result, onRetake }: ExamResultsReviewProps) {
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
              onClick={onRetake}
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
        {result.reviewItems.map((item, idx) => {
          const selectedSet = new Set(item.selectedOptionIds)
          const correctSet = new Set(item.correctOptionIds)
          const selectedLabels = formatOptionDisplayLabels(
            item.prompt.options,
            item.selectedOptionIds
          )
          const correctLabels = formatOptionDisplayLabels(
            item.prompt.options,
            item.correctOptionIds
          )
          const feedbackByOptionId = new Map<string, string>(
            item.optionFeedback.map((fb) => [fb.optionId, fb.feedback])
          )

          return (
            <article
              key={item.questionId}
              className="rounded-card p-5 sm:p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50 space-y-3.5"
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
              <ul className="space-y-2 list-none p-0 m-0">
                {item.prompt.options.map((opt, optIdx) => {
                  const displayLabel = getOptionDisplayLabel(optIdx)
                  const isSelected = selectedSet.has(opt.id)
                  const isCorrectOpt = correctSet.has(opt.id)
                  const isWrongSelection = isSelected && !isCorrectOpt
                  const fbText = feedbackByOptionId.get(opt.id)
                  const { optionTone, badgeTone } = getReviewOptionStyle(
                    isCorrectOpt,
                    isWrongSelection
                  )

                  return (
                    <li
                      key={opt.id}
                      className={`rounded-zen px-3.5 py-2.5 border text-[0.86rem] ${optionTone}`}
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className={`font-mono text-xs font-semibold px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${badgeTone}`}
                        >
                          {displayLabel}
                        </span>
                        <div className="flex-1 min-w-0">
                          <StudyRichText
                            text={opt.text}
                            imageRefs={item.prompt.imageRefs}
                            placement="option"
                            optionId={opt.id}
                          />
                          {fbText && (
                            <div className="mt-2 pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/30 text-xs text-ink-500 dark:text-sage-400">
                              <StudyRichText
                                text={fbText}
                                imageRefs={item.prompt.imageRefs}
                                placement="feedback"
                                optionId={opt.id}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              <div className="text-xs font-mono text-ink-500 dark:text-sage-400">
                Your answer: {selectedLabels.join(', ') || 'None'} · Correct:{' '}
                <strong className="text-matcha-700 dark:text-matcha-300">
                  {correctLabels.join(', ')}
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
          )
        })}
      </section>
    </div>
  )
}
