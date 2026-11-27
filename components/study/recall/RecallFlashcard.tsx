'use client'

import type { StudyRating } from '../../../lib/study/types'
import type {
  RecallQueueItem,
  RevealedRecallAnswer,
} from '../../../lib/study/services/recall-service'
import type {
  RecallBookmarkSyncSummary,
  RecallCounts,
} from '../../../lib/study/recall-removal'
import StudyRichText from '../StudyRichText'
import { ZenPendingDot } from '../StudySkeletons'
import { RecallBookmarkSyncBanner } from './RecallStatusViews'

const RATING_BUTTONS: Array<{
  rating: StudyRating
  label: string
  shortcut: string
  className: string
}> = [
  {
    rating: 'again',
    label: 'Again',
    shortcut: '1',
    className:
      'border-earth-rust/50 text-earth-rust dark:text-rose-300 hover:bg-rose-50/70 dark:hover:bg-rose-950/30',
  },
  {
    rating: 'hard',
    label: 'Hard',
    shortcut: '2',
    className:
      'border-earth-beige text-ink-600 dark:text-sage-300 hover:bg-rice-paper-200/80 dark:hover:bg-tea-slate-100/60',
  },
  {
    rating: 'good',
    label: 'Good',
    shortcut: '3',
    className:
      'border-matcha-400/80 text-matcha-700 dark:text-matcha-300 bg-matcha-50/70 dark:bg-matcha-900/30 hover:bg-matcha-100/80 dark:hover:bg-matcha-900/50',
  },
  {
    rating: 'easy',
    label: 'Easy',
    shortcut: '4',
    className:
      'border-matcha-500/70 text-matcha-700 dark:text-matcha-200 hover:bg-matcha-100/60 dark:hover:bg-matcha-900/40',
  },
]

export interface RecallFlashcardProps {
  item: RecallQueueItem
  currentIdx: number
  queueLength: number
  counts: RecallCounts
  upcomingTotal: number
  isRefreshing: boolean
  showChoices: boolean
  revealed: RevealedRecallAnswer | null
  loadingReveal: boolean
  submittingRating: StudyRating | null
  error: string
  bookmarkSyncSummary: RecallBookmarkSyncSummary
  onToggleChoices: () => void
  onReveal: () => void
  onRate: (rating: StudyRating) => void
  onRemoveFromRecall: () => void
  onRetryBookmarkSync: () => void
  onDismissError: () => void
}

/**
 * Renders the active Active Recall flashcard screen: progress header, bookmark
 * sync / inline error banners, free-recall card surface, optional multiple-choice
 * cues, revealed answer/explanation, and FSRS rating buttons with interval previews.
 */
export function RecallFlashcard({
  item,
  currentIdx,
  queueLength,
  counts,
  upcomingTotal,
  isRefreshing,
  showChoices,
  revealed,
  loadingReveal,
  submittingRating,
  error,
  bookmarkSyncSummary,
  onToggleChoices,
  onReveal,
  onRate,
  onRemoveFromRecall,
  onRetryBookmarkSync,
  onDismissError,
}: RecallFlashcardProps) {
  const { prompt } = item
  const correctSet = new Set(revealed?.correctOptionIds || [])

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6 animate-study-feedback">
      {/* ── Progress Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-[0.8rem] text-ink-500 dark:text-sage-400">
        <div className="flex items-center gap-2.5">
          <span className="px-2.5 py-0.5 rounded-pill text-[0.7rem] font-medium uppercase tracking-wider bg-matcha-100/80 dark:bg-matcha-900/40 text-matcha-700 dark:text-matcha-300 border border-matcha-200/70 dark:border-matcha-700/50">
            {item.bucket === 'due' ? item.state : 'New Card'}
          </span>
          <span>{prompt.topic}</span>
          {isRefreshing && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1.5 text-xs text-matcha-600 dark:text-matcha-400"
            >
              <ZenPendingDot />
              Syncing…
            </span>
          )}
        </div>
        <span className="font-mono text-xs tabular-nums">
          Card {currentIdx + 1}/{queueLength} · Due: {counts.due} · New: {counts.newCards}
          {upcomingTotal > 0 ? ` · Upcoming: ${upcomingTotal}` : ''}
        </span>
      </div>

      <RecallBookmarkSyncBanner
        summary={bookmarkSyncSummary}
        onRetry={onRetryBookmarkSync}
      />

      {error && (
        <div
          role="alert"
          className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="text-xs font-medium underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Flashcard Surface ── */}
      <article
        aria-busy={isRefreshing || undefined}
        className={[
          'rounded-card p-6 sm:p-8 bg-rice-paper-50/95 dark:bg-tea-slate-200/70 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-6',
          'transition-opacity duration-150 ease-zen motion-reduce:transition-none',
          isRefreshing ? 'opacity-65' : 'opacity-100',
        ].join(' ')}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-400 dark:text-sage-500">
          <div className="flex items-center gap-2">
            <span className="font-mono">{prompt.questionId}</span>
            <span>·</span>
            <span>
              {prompt.questionType === 'multi_select' ? 'Multi-select' : 'Single-choice'}
            </span>
          </div>
          <button
            type="button"
            disabled={Boolean(submittingRating) || isRefreshing}
            onClick={onRemoveFromRecall}
            title="Remove this question from Active Recall without deleting its review history"
            className="px-2.5 py-1 rounded-zen border border-rice-paper-400/70 dark:border-tea-slate-50/60 text-xs font-medium text-ink-500 dark:text-sage-400 hover:border-earth-rust/50 hover:text-[#7A4932] dark:hover:border-rose-400/50 dark:hover:text-[#E2BBA2] transition-colors duration-150 motion-reduce:transition-none disabled:opacity-45"
          >
            Remove from Recall
          </button>
        </div>

        <StudyRichText
          text={prompt.questionText}
          imageRefs={prompt.imageRefs}
          placement="question"
          className="font-serif text-lg sm:text-[1.15rem] leading-relaxed text-ink-700 dark:text-sage-100"
        />

        {/* Free-recall guidance before revealing choices */}
        {!showChoices && !revealed && (
          <div className="rounded-zen p-4 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/50 dark:border-tea-slate-50/40 text-[0.84rem] text-ink-500 dark:text-sage-400">
            Pause and recall the answer from memory first. Reveal choices only if you need a cue, then assess your recall honestly.
          </div>
        )}

        {/* Optional Multiple-Choice Options */}
        {showChoices && (
          <ul className="space-y-2.5 list-none p-0 m-0 animate-study-feedback">
            {prompt.options.map((opt) => {
              const isCorrect = revealed ? correctSet.has(opt.id) : false
              const fb = revealed?.optionFeedback.find((f) => f.optionId === opt.id)
              return (
                <li
                  key={opt.id}
                  className={[
                    'rounded-zen px-4 py-3 border text-[0.9rem]',
                    isCorrect
                      ? 'bg-matcha-50/90 dark:bg-matcha-900/35 border-matcha-400/80 dark:border-matcha-600/70 text-ink-700 dark:text-sage-100'
                      : 'bg-rice-paper-100/80 dark:bg-tea-slate-300/60 border-rice-paper-400/60 dark:border-tea-slate-50/40 text-ink-600 dark:text-sage-200',
                  ].join(' ')}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="font-mono text-xs font-semibold px-1.5 py-0.5 rounded bg-rice-paper-200 dark:bg-tea-slate-100 text-ink-600 dark:text-sage-300 shrink-0 mt-0.5">
                      {opt.id}
                    </span>
                    <div className="flex-1 min-w-0">
                      <StudyRichText
                        text={opt.text}
                        imageRefs={prompt.imageRefs}
                        placement="option"
                        optionId={opt.id}
                      />
                      {fb && (
                        <div className="mt-2 pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/30 text-xs text-ink-500 dark:text-sage-400">
                          <StudyRichText
                            text={fb.feedback}
                            imageRefs={prompt.imageRefs}
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
        )}

        {/* Revealed Answer & Explanation */}
        {revealed && (
          <div className="pt-5 border-t border-rice-paper-400/70 dark:border-tea-slate-50/50 space-y-4 animate-study-feedback">
            <div className="flex items-center gap-2 text-sm font-medium text-matcha-700 dark:text-matcha-300">
              <span>Correct Answer:</span>
              <span className="font-mono">{revealed.correctOptionIds.join(', ')}</span>
            </div>
            {revealed.explanation && (
              <div className="rounded-zen p-4 bg-rice-paper-200/55 dark:bg-tea-slate-300/55 border border-rice-paper-400/50 dark:border-tea-slate-50/40 text-[0.9rem] leading-relaxed text-ink-700 dark:text-sage-200">
                <StudyRichText
                  text={revealed.explanation}
                  imageRefs={prompt.imageRefs}
                  placement="explanation"
                />
              </div>
            )}
          </div>
        )}

        {/* Action Controls */}
        {!revealed ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button
              type="button"
              disabled={isRefreshing}
              onClick={onToggleChoices}
              className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400/80 dark:border-tea-slate-50/60 hover:border-matcha-400/70 transition-colors duration-200 motion-reduce:transition-none disabled:opacity-50"
            >
              {showChoices ? 'Hide Choices (O)' : 'Show Choices (O)'}
            </button>

            <button
              type="button"
              onClick={onReveal}
              disabled={loadingReveal || isRefreshing}
              aria-busy={loadingReveal || undefined}
              aria-keyshortcuts="Enter Space"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-zen text-[0.88rem] font-medium bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500 text-white shadow-zen-sm transition-colors duration-200 motion-reduce:transition-none disabled:opacity-60"
            >
              {loadingReveal && <ZenPendingDot />}
              <span>
                {loadingReveal ? (
                  'Revealing Answer…'
                ) : (
                  <>
                    Reveal Answer
                    <span className="hidden sm:inline font-mono text-[0.72rem] opacity-75 ml-1.5">
                      (Enter / Space)
                    </span>
                  </>
                )}
              </span>
            </button>
          </div>
        ) : (
          <div className="space-y-3 pt-2">
            <p className="text-xs text-ink-400 dark:text-sage-500 m-0">
              How well did you recall the concept from memory? (A lucky guess does not equal Easy.)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {RATING_BUTTONS.map((btn) => {
                const preview = item.ratingPreviews[btn.rating]
                const isThisSubmitting = submittingRating === btn.rating
                return (
                  <button
                    key={btn.rating}
                    type="button"
                    disabled={Boolean(submittingRating) || isRefreshing}
                    aria-busy={isThisSubmitting || undefined}
                    onClick={() => onRate(btn.rating)}
                    className={[
                      'rounded-zen px-3 py-2.5 border text-center',
                      'transition-all duration-150 motion-reduce:transition-none',
                      isThisSubmitting
                        ? 'ring-1 ring-matcha-500/40 dark:ring-matcha-400/40 opacity-100'
                        : 'disabled:opacity-45',
                      btn.className,
                    ].join(' ')}
                  >
                    <div className="text-[0.86rem] font-medium">
                      {btn.label}{' '}
                      <span className="font-mono text-[0.72rem] opacity-65">({btn.shortcut})</span>
                    </div>
                    <div className="text-[0.72rem] font-mono opacity-80 mt-0.5 inline-flex items-center justify-center gap-1.5">
                      {isThisSubmitting ? (
                        <>
                          <ZenPendingDot />
                          <span>Saving…</span>
                        </>
                      ) : (
                        <span>{preview?.intervalLabel || '—'}</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </article>
    </div>
  )
}
