'use client'

import type { PracticeError } from '../../../lib/study/practice-state'
import type { PracticeCompletionSummary } from '../../../lib/study/practice-completion'
import { ZenPendingDot } from '../StudySkeletons'
import type { LegacyBookmarkImportCandidate, PracticeFilter } from './types'

export interface PracticeFilterBarProps {
  filter: PracticeFilter
  totalQuestionCount: number
  summary: PracticeCompletionSummary
  isInitialLoading: boolean
  isSwitching: boolean
  showViewSummary: boolean
  onSelectFilter: (filter: PracticeFilter) => void
  onViewSummary: () => void
}

export function PracticeFilterBar({
  filter,
  totalQuestionCount,
  summary,
  isInitialLoading,
  isSwitching,
  showViewSummary,
  onSelectFilter,
  onViewSummary,
}: PracticeFilterBarProps) {
  const tabs: ReadonlyArray<{ key: PracticeFilter; label: string }> = [
    { key: 'all', label: isInitialLoading ? 'All' : `All (${totalQuestionCount})` },
    {
      key: 'incorrect',
      label: isInitialLoading ? 'Incorrect' : `Incorrect (${summary.incorrectCount})`,
    },
    {
      key: 'bookmarked',
      label: isInitialLoading ? 'Bookmarked' : `Bookmarked (${summary.bookmarkedCount})`,
    },
  ]

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex items-center gap-1 p-1 rounded-zen bg-rice-paper-200/70 dark:bg-tea-slate-200/70 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-xs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            // Prevents Firefox from restoring stale disabled button state on soft reload during hydration
            {...({ autoComplete: 'off' } as Record<string, string>)}
            disabled={isInitialLoading || isSwitching}
            onClick={() => onSelectFilter(tab.key)}
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
            onClick={onViewSummary}
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
  )
}

export interface LegacyBookmarkImportBannerProps {
  candidate: LegacyBookmarkImportCandidate
  importing: boolean
  error: string | null
  onImport: (examId: string, questionIds: string[]) => void
  onDismiss: () => void
}

export function LegacyBookmarkImportBanner({
  candidate,
  importing,
  error,
  onImport,
  onDismiss,
}: LegacyBookmarkImportBannerProps) {
  return (
    <div
      role="region"
      aria-label="Import local bookmarks"
      className="rounded-zen px-4 py-3 bg-rice-paper-200/80 dark:bg-tea-slate-200/80 border border-matcha-400/50 dark:border-matcha-700/50 text-xs text-ink-600 dark:text-sage-200 flex flex-wrap items-center justify-between gap-3 animate-study-feedback"
    >
      <div className="space-y-0.5">
        <div>
          Found {candidate.questionIds.length} local{' '}
          {candidate.questionIds.length === 1 ? 'bookmark' : 'bookmarks'} in this browser for this
          exam. Import to your synced account?
        </div>
        {error && (
          <div className="text-[0.72rem] text-[#7A4932] dark:text-[#E2BBA2]">{error}</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          disabled={importing}
          onClick={() => onImport(candidate.examId, candidate.questionIds)}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-zen font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-150 motion-reduce:transition-none disabled:opacity-60"
        >
          {importing && <ZenPendingDot />}
          <span>
            {importing ? 'Importing…' : error ? 'Retry Import' : 'Import to Account'}
          </span>
        </button>
        <button
          type="button"
          disabled={importing}
          onClick={onDismiss}
          className="px-2.5 py-1 rounded-zen font-medium text-ink-500 dark:text-sage-400 hover:text-ink-700 dark:hover:text-sage-200"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

export function PracticeCompletionSyncNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-end gap-2 text-xs text-[#7A4932] dark:text-[#E2BBA2] animate-study-feedback"
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-earth-rust" aria-hidden="true" />
      <span>Bookmarks not synced</span>
      <button
        type="button"
        onClick={onRetry}
        className="px-2 py-0.5 rounded-zen font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none"
      >
        Retry
      </button>
    </div>
  )
}

export interface PracticeErrorBannerProps {
  error: PracticeError
  retryDisabled: boolean
  onRetry: () => void
  onDismiss: () => void
}

export function PracticeErrorBanner({
  error,
  retryDisabled,
  onRetry,
  onDismiss,
}: PracticeErrorBannerProps) {
  const retryLabel =
    error.kind === 'check_answer'
      ? 'Retry Check'
      : error.isSwitch
        ? 'Retry Switch'
        : 'Try Again'
  const canDismiss = error.kind === 'check_answer' || error.isSwitch

  return (
    <div
      role="alert"
      className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex flex-wrap items-center justify-between gap-3"
    >
      <span>{error.message}</span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onRetry}
          disabled={retryDisabled}
          className="px-3 py-1 rounded-zen text-xs font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 dark:border-rose-400/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50"
        >
          {retryLabel}
        </button>
        {canDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="px-2 py-1 text-xs font-medium text-earth-rust/80 dark:text-rose-200/80 hover:underline"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}
