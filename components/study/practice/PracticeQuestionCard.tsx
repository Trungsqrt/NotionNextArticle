'use client'

import type { StudyQuestionPrompt } from '../../../lib/study/types'
import type {
  BookmarkSyncSnapshot,
  BookmarkTransientFeedbackPhase,
} from '../../../lib/study/bookmark-sync'
import type { PracticeCompletionSummary } from '../../../lib/study/practice-completion'
import StudyRichText from '../StudyRichText'
import { ZenPendingDot } from '../StudySkeletons'
import type { PracticeResultEntry } from './types'

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

interface OptionPresentation {
  cardTone: string
  badgeTone: string
  statusLabel: string | null
  isWrongSelection: boolean
}

function getOptionPresentation(params: {
  selected: boolean
  graded: PracticeResultEntry | undefined
  optionId: string
  isMulti: boolean
}): OptionPresentation {
  const { selected, graded, optionId, isMulti } = params
  const isRestored = Boolean(graded?.restored)
  const isCorrectOption = Boolean(!isRestored && graded?.correctOptionIds.includes(optionId))
  const isCorrectSelection = Boolean(
    graded && selected && (isRestored ? graded.isCorrect : isCorrectOption)
  )
  const isMissedCorrect = Boolean(graded && !isRestored && !selected && isCorrectOption)
  const isWrongSelection = Boolean(
    graded && selected && (isRestored ? !graded.isCorrect : !isCorrectOption)
  )
  const isUnselectedNeutral = Boolean(graded && !selected && (isRestored || !isCorrectOption))

  if (isCorrectSelection) {
    return {
      cardTone:
        'bg-matcha-100/80 dark:bg-matcha-900/55 border-matcha-500 dark:border-matcha-400/85 ring-1 ring-matcha-500/20 dark:ring-matcha-400/20 text-ink-700 dark:text-sage-100',
      badgeTone: 'bg-matcha-600 dark:bg-matcha-500 text-white',
      statusLabel: 'Your answer · Correct',
      isWrongSelection: false,
    }
  }

  if (isMissedCorrect) {
    return {
      cardTone: [
        'bg-matcha-50/90 dark:bg-matcha-900/35 border-matcha-500/85 dark:border-matcha-400/75 text-ink-700 dark:text-sage-100',
        isMulti ? 'border-dashed' : '',
      ].join(' '),
      badgeTone: 'bg-matcha-200/90 dark:bg-matcha-800 text-matcha-800 dark:text-matcha-200',
      statusLabel: isMulti ? 'Missed · Correct answer' : 'Correct answer',
      isWrongSelection: false,
    }
  }

  if (isWrongSelection) {
    return {
      cardTone:
        'bg-earth-rust/[0.10] dark:bg-earth-rust/[0.20] border-earth-rust/80 dark:border-earth-rust/85 ring-1 ring-earth-rust/20 text-ink-700 dark:text-sage-100',
      badgeTone: 'bg-earth-rust text-white',
      statusLabel: 'Your answer · Incorrect',
      isWrongSelection: true,
    }
  }

  if (isUnselectedNeutral) {
    return {
      cardTone:
        'bg-rice-paper-100/50 dark:bg-tea-slate-300/40 border-rice-paper-400/50 dark:border-tea-slate-50/30 text-ink-500/80 dark:text-sage-400/80',
      badgeTone: 'bg-rice-paper-200 dark:bg-tea-slate-100 text-ink-600 dark:text-sage-300',
      statusLabel: null,
      isWrongSelection: false,
    }
  }

  return {
    cardTone: selected
      ? 'bg-matcha-50/70 dark:bg-matcha-900/25 border-matcha-400 text-ink-700 dark:text-sage-100'
      : 'bg-rice-paper-100/70 dark:bg-tea-slate-300/60 border-rice-paper-400/60 dark:border-tea-slate-50/40 text-ink-600 dark:text-sage-200 hover:border-matcha-400/60',
    badgeTone: 'bg-rice-paper-200 dark:bg-tea-slate-100 text-ink-600 dark:text-sage-300',
    statusLabel: null,
    isWrongSelection: false,
  }
}

export interface PracticeQuestionCardProps {
  question: StudyQuestionPrompt
  positionIndex: number
  filteredTotal: number
  selectedOptionIds: string[]
  graded: PracticeResultEntry | undefined
  isChecking: boolean
  isAnyCheckInFlight: boolean
  isSwitching: boolean
  isBookmarked: boolean
  bookmarkSync: BookmarkSyncSnapshot
  bookmarkFeedbackPhase: BookmarkTransientFeedbackPhase
  canGoPrevious: boolean
  canGoNext: boolean
  showFinishPractice: boolean
  canFinishPractice: boolean
  showUnansweredPrompt: boolean
  summary: PracticeCompletionSummary
  onToggleOption: (questionId: string, optionId: string, isMulti: boolean) => void
  onCheckAnswer: (
    questionId: string,
    overrideSelected?: string[],
    options?: { hydrateRestored?: boolean }
  ) => void
  onToggleBookmark: (questionId: string) => void
  onRetryBookmarkSync: () => void
  onPrevious: () => void
  onNext: () => void
  onFinishPractice: () => void
  onGoToFirstUnanswered: () => void
}

/**
 * Renders the active Practice Mode question: metadata header, inline bookmark
 * control & sync feedback, rich-text prompt, answer options, server-graded
 * feedback/explanation panel, unanswered reminder, and footer navigation.
 */
export default function PracticeQuestionCard({
  question,
  positionIndex,
  filteredTotal,
  selectedOptionIds,
  graded,
  isChecking,
  isAnyCheckInFlight,
  isSwitching,
  isBookmarked,
  bookmarkSync,
  bookmarkFeedbackPhase,
  canGoPrevious,
  canGoNext,
  showFinishPractice,
  canFinishPractice,
  showUnansweredPrompt,
  summary,
  onToggleOption,
  onCheckAnswer,
  onToggleBookmark,
  onRetryBookmarkSync,
  onPrevious,
  onNext,
  onFinishPractice,
  onGoToFirstUnanswered,
}: PracticeQuestionCardProps) {
  const isMulti = question.questionType === 'multi_select'
  const currentGraded = Boolean(graded)
  const hasSelection = selectedOptionIds.length > 0

  return (
    <article
      aria-busy={isSwitching || undefined}
      className={[
        'rounded-card p-6 sm:p-8 bg-rice-paper-50/95 dark:bg-tea-slate-200/70 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-6',
        'transition-opacity duration-150 ease-zen motion-reduce:transition-none animate-study-feedback',
        isSwitching ? 'opacity-60' : 'opacity-100',
      ].join(' ')}
    >
      {/* ── Question Metadata & Bookmark Control ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-400 dark:text-sage-500">
        <div className="flex items-center gap-2">
          <span className="font-mono">
            {positionIndex + 1} / {filteredTotal}
          </span>
          <span>·</span>
          <span>{question.topic}</span>
          <span>·</span>
          <span>{isMulti ? 'Multi-select' : 'Single-choice'}</span>
        </div>
        <div className="flex items-center gap-2">
          {bookmarkSync.status === 'not_synced' ? (
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
                onClick={onRetryBookmarkSync}
                className="px-1.5 py-0.5 rounded-[4px] font-medium bg-rice-paper-100 dark:bg-tea-slate-300/70 text-ink-700 dark:text-sage-100 border border-earth-rust/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none"
              >
                Retry
              </button>
            </span>
          ) : (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center justify-center w-4 h-4 shrink-0"
            >
              {bookmarkFeedbackPhase === 'loading' && (
                <>
                  <ZenPendingDot />
                  <span className="sr-only">Saving bookmark</span>
                </>
              )}
              {bookmarkFeedbackPhase === 'success' && (
                <>
                  <FeedbackCheckIcon className="w-3.5 h-3.5 text-matcha-600 dark:text-matcha-400 animate-study-feedback" />
                  <span className="sr-only">Bookmark saved</span>
                </>
              )}
            </span>
          )}
          <button
            type="button"
            disabled={isSwitching}
            onClick={() => onToggleBookmark(question.questionId)}
            aria-pressed={isBookmarked}
            className={[
              'px-2.5 py-1 rounded-zen border text-xs font-medium transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50',
              isBookmarked
                ? 'bg-matcha-100/80 dark:bg-matcha-900/40 border-matcha-400/70 text-matcha-700 dark:text-matcha-300'
                : 'border-rice-paper-400/70 dark:border-tea-slate-50/60 text-ink-500 dark:text-sage-400',
            ].join(' ')}
          >
            {isBookmarked ? '★ Bookmarked' : '☆ Bookmark'}
          </button>
        </div>
      </div>

      {/* ── Question Prompt ── */}
      <StudyRichText
        text={question.questionText}
        imageRefs={question.imageRefs}
        placement="question"
        className="font-serif text-lg leading-relaxed text-ink-700 dark:text-sage-100"
      />

      {/* ── Answer Options ── */}
      <div className="space-y-2.5">
        {question.options.map((opt) => {
          const selected = selectedOptionIds.includes(opt.id)
          const presentation = getOptionPresentation({
            selected,
            graded,
            optionId: opt.id,
            isMulti,
          })
          const fb = graded?.optionFeedback.find((f) => f.optionId === opt.id)

          return (
            <button
              key={opt.id}
              type="button"
              data-study-option="true"
              disabled={currentGraded || isChecking || isSwitching}
              aria-pressed={!currentGraded ? selected : undefined}
              onClick={() => onToggleOption(question.questionId, opt.id, isMulti)}
              className={[
                'w-full text-left rounded-zen px-4 py-3 border text-[0.9rem]',
                'transition-colors duration-150 motion-reduce:transition-none',
                presentation.cardTone,
              ].join(' ')}
            >
              <div className="flex items-start gap-2.5">
                <span
                  className={[
                    'font-mono text-xs font-semibold px-1.5 py-0.5 rounded shrink-0 mt-0.5',
                    'transition-colors duration-150 motion-reduce:transition-none',
                    presentation.badgeTone,
                  ].join(' ')}
                >
                  {opt.id}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex-1 min-w-[12rem]">
                      <StudyRichText
                        text={opt.text}
                        imageRefs={question.imageRefs}
                        placement="option"
                        optionId={opt.id}
                      />
                    </div>
                    {presentation.statusLabel && (
                      <span
                        className={[
                          'inline-flex items-center gap-1 text-[0.72rem] font-medium tracking-wide shrink-0 mt-0.5 animate-study-feedback',
                          presentation.isWrongSelection
                            ? 'text-[#7A4932] dark:text-[#E2BBA2]'
                            : 'text-matcha-700 dark:text-matcha-200',
                        ].join(' ')}
                      >
                        {presentation.isWrongSelection ? (
                          <FeedbackCrossIcon className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <FeedbackCheckIcon className="w-3.5 h-3.5 shrink-0" />
                        )}
                        <span>{presentation.statusLabel}</span>
                      </span>
                    )}
                  </div>
                  {fb && (
                    <div className="mt-2 pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/30 text-xs text-ink-500 dark:text-sage-400 animate-study-feedback">
                      <StudyRichText
                        text={fb.feedback}
                        imageRefs={question.imageRefs}
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

      {/* ── Graded Feedback & Explanation ── */}
      {graded && (
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
                disabled={isAnyCheckInFlight || isSwitching}
                onClick={() =>
                  onCheckAnswer(question.questionId, selectedOptionIds, {
                    hydrateRestored: true,
                  })
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-zen text-xs font-medium text-matcha-700 dark:text-matcha-300 bg-rice-paper-50/90 dark:bg-tea-slate-200/80 border border-matcha-400/50 dark:border-matcha-600/50 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50"
              >
                {isChecking && <ZenPendingDot />}
                <span>{isChecking ? 'Loading…' : 'Load Answer & Explanation'}</span>
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
                imageRefs={question.imageRefs}
                placement="explanation"
              />
            </div>
          )}
        </div>
      )}

      {/* ── Remaining Unanswered Notice on Final Question ── */}
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
            onClick={onGoToFirstUnanswered}
            className="px-3 py-1.5 rounded-zen font-medium text-matcha-700 dark:text-matcha-300 bg-matcha-50/90 dark:bg-matcha-900/35 border border-matcha-400/60 dark:border-matcha-600/50 hover:bg-matcha-100/80 dark:hover:bg-matcha-900/55 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50"
          >
            Go to Q{summary.firstUnansweredIndex + 1} (First Unanswered)
          </button>
        </div>
      )}

      {/* ── Footer Navigation ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <button
          type="button"
          disabled={!canGoPrevious}
          aria-keyshortcuts="ArrowLeft"
          onClick={onPrevious}
          className="px-3.5 py-2 rounded-zen text-[0.82rem] font-medium border border-rice-paper-400/80 dark:border-tea-slate-50/60 text-ink-600 dark:text-sage-300 disabled:opacity-40 transition-colors duration-150 motion-reduce:transition-none"
        >
          ← Previous
        </button>

        <div className="flex items-center gap-2.5">
          {!currentGraded && (
            <button
              type="button"
              aria-busy={isChecking || undefined}
              aria-keyshortcuts="Enter Space"
              disabled={!hasSelection || isAnyCheckInFlight || isSwitching}
              onClick={() => onCheckAnswer(question.questionId)}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 text-white disabled:opacity-55 transition-colors duration-150 motion-reduce:transition-none"
            >
              {isChecking && <ZenPendingDot />}
              <span>
                {isChecking ? (
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
              onClick={onFinishPractice}
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
              onClick={onNext}
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
  )
}
