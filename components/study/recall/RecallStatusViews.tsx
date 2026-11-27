'use client'

import type { RecallUpcomingReviews } from '../../../lib/study/services/recall-service'
import type {
  RecallBookmarkSyncSummary,
  RecallCounts,
} from '../../../lib/study/recall-removal'
import { StudyLink } from '../StudyNavigationContext'
import { ZenPendingDot } from '../StudySkeletons'

export function BookmarkSyncPendingNotice() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center justify-center gap-2 rounded-zen px-3.5 py-2 bg-rice-paper-50/90 dark:bg-tea-slate-200/70 border border-rice-paper-400/70 dark:border-tea-slate-50/50 text-xs text-ink-500 dark:text-sage-400 animate-study-feedback"
    >
      <ZenPendingDot />
      <span>Syncing bookmark changes…</span>
    </div>
  )
}

export function BookmarkSyncNotice({
  errorMessage,
  isSaving,
  onRetry,
}: {
  errorMessage: string | null
  isSaving: boolean
  onRetry: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2.5 rounded-zen px-3.5 py-2.5 bg-rice-paper-50/90 dark:bg-tea-slate-200/70 border border-earth-rust/35 dark:border-rose-400/35 text-xs text-[#7A4932] dark:text-[#E2BBA2] text-left animate-study-feedback"
    >
      <span className="inline-flex items-center gap-2 min-w-0">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full bg-earth-rust shrink-0"
          aria-hidden="true"
        />
        <span>{errorMessage || 'Bookmark removal not synced yet.'}</span>
      </span>
      <button
        type="button"
        disabled={isSaving}
        onClick={onRetry}
        className="px-2.5 py-1 rounded-zen font-medium bg-rice-paper-50 dark:bg-tea-slate-300/70 text-ink-700 dark:text-sage-100 border border-earth-rust/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none disabled:opacity-50 shrink-0"
      >
        {isSaving ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}

export function RecallBookmarkSyncBanner({
  summary,
  onRetry,
  showPending = false,
}: {
  summary: RecallBookmarkSyncSummary
  onRetry: () => void
  showPending?: boolean
}) {
  if (summary.hasUnsyncedError) {
    return (
      <BookmarkSyncNotice
        errorMessage={summary.errorMessage}
        isSaving={summary.isSaving}
        onRetry={onRetry}
      />
    )
  }

  if (showPending && summary.hasPendingSync) {
    return <BookmarkSyncPendingNotice />
  }

  return null
}

export function UpcomingReviewsSummary({
  upcoming,
}: {
  upcoming: RecallUpcomingReviews
}) {
  const totalUpcoming =
    upcoming.laterToday +
    upcoming.tomorrow +
    upcoming.next3Days +
    upcoming.next7Days +
    upcoming.later

  if (totalUpcoming === 0) return null

  const buckets = [
    ...(upcoming.laterToday > 0
      ? [{ label: 'Later Today', count: upcoming.laterToday }]
      : []),
    { label: 'Tomorrow', count: upcoming.tomorrow },
    { label: 'Next 3 Days', count: upcoming.next3Days },
    { label: 'Next 7 Days', count: upcoming.next7Days },
    { label: 'Later', count: upcoming.later },
  ]

  return (
    <section
      aria-label="Upcoming bookmarked reviews"
      className="rounded-card p-5 bg-rice-paper-50/90 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50 text-left space-y-3"
    >
      <h2 className="font-serif text-base font-medium text-ink-700 dark:text-sage-100 m-0">
        Upcoming Reviews
      </h2>
      <div
        className={`grid grid-cols-2 ${
          buckets.length >= 5 ? 'sm:grid-cols-5' : 'sm:grid-cols-4'
        } gap-2.5 text-center`}
      >
        {buckets.map((b) => (
          <div
            key={b.label}
            className="rounded-zen py-2.5 px-3 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/50 dark:border-tea-slate-50/40"
          >
            <div className="font-serif text-lg font-medium tabular-nums text-ink-700 dark:text-sage-100">
              {b.count}
            </div>
            <div className="text-[0.72rem] text-ink-400 dark:text-sage-500 mt-0.5">
              {b.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function RecallErrorState({
  error,
  onRetry,
}: {
  error: string
  onRetry: () => void
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-14 animate-study-feedback">
      <div
        role="alert"
        className="rounded-card p-6 sm:p-8 bg-rose-50/75 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-center space-y-4"
      >
        <p className="text-sm text-earth-rust dark:text-rose-200 m-0">
          {error || 'Unable to load your active recall queue right now.'}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="px-4 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-150 motion-reduce:transition-none"
          >
            Try Again
          </button>
          <StudyLink
            href="/study"
            className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400 dark:border-tea-slate-50/60 no-underline"
          >
            Return to Dashboard
          </StudyLink>
        </div>
      </div>
    </div>
  )
}

export function RecallEmptyNoBookmarks({
  practiceHref,
  bookmarkSyncSummary,
  onRetryBookmarkSync,
}: {
  practiceHref: string
  bookmarkSyncSummary: RecallBookmarkSyncSummary
  onRetryBookmarkSync: () => void
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-14 text-center space-y-4 animate-study-feedback">
      <RecallBookmarkSyncBanner
        summary={bookmarkSyncSummary}
        onRetry={onRetryBookmarkSync}
        showPending
      />
      <div className="rounded-card p-8 sm:p-10 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm space-y-5">
        <div className="space-y-2">
          <p className="text-[0.7rem] uppercase tracking-[0.2em] font-medium text-matcha-600 dark:text-matcha-400 m-0">
            Bookmark-Based Active Recall
          </p>
          <h1 className="font-serif text-2xl font-medium text-ink-700 dark:text-sage-100 m-0">
            No Bookmarked Questions Yet
          </h1>
          <p className="text-[0.9rem] text-ink-500 dark:text-sage-400 max-w-md mx-auto m-0 leading-relaxed">
            Active Recall is your calm spaced-repetition deck for questions you choose to revisit. Bookmark questions in Practice Mode to add them here.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <StudyLink
            href={practiceHref}
            className="px-5 py-2.5 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500 text-white shadow-zen-sm no-underline transition-colors duration-200 motion-reduce:transition-none"
          >
            Go to Practice
          </StudyLink>
          <StudyLink
            href="/study"
            className="px-4 py-2.5 rounded-zen text-[0.84rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400 dark:border-tea-slate-50/60 no-underline"
          >
            Return to Dashboard
          </StudyLink>
        </div>

        <p className="text-[0.74rem] text-ink-400 dark:text-sage-500 m-0 pt-2">
          Your bookmarks are synchronized across devices for your account.
        </p>
      </div>
    </div>
  )
}

export function RecallEmptyCaughtUp({
  counts,
  completedCount,
  upcomingReviews,
  error,
  isRefreshing,
  practiceHref,
  bookmarkSyncSummary,
  onRetryBookmarkSync,
  onRefreshQueue,
}: {
  counts: RecallCounts
  completedCount: number
  upcomingReviews: RecallUpcomingReviews
  error: string
  isRefreshing: boolean
  practiceHref: string
  bookmarkSyncSummary: RecallBookmarkSyncSummary
  onRetryBookmarkSync: () => void
  onRefreshQueue: () => void
}) {
  const remainingDueOrNew = counts.due + counts.newCards
  const hasRemainingOutsideBatch = remainingDueOrNew > 0

  const heading = hasRemainingOutsideBatch
    ? 'More Cards Remaining'
    : completedCount > 0
      ? 'Session Complete'
      : 'All Caught Up'

  const description = hasRemainingOutsideBatch
    ? `${remainingDueOrNew} additional bookmarked card${remainingDueOrNew === 1 ? ' is' : 's are'} ready outside this batch. Let pending bookmark changes finish syncing, then reload to continue.`
    : completedCount > 0
      ? `You reviewed ${completedCount} bookmarked card${completedCount === 1 ? '' : 's'} with FSRS-6 scheduling. Your next due dates have been saved.`
      : 'None of your bookmarked cards are due right now. Check back when your next scheduled reviews arrive.'

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-12 text-center space-y-6 animate-study-feedback">
      <RecallBookmarkSyncBanner
        summary={bookmarkSyncSummary}
        onRetry={onRetryBookmarkSync}
        showPending
      />
      <div className="rounded-card p-8 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm space-y-5">
        <div className="space-y-2">
          <p className="text-[0.7rem] uppercase tracking-[0.2em] font-medium text-matcha-600 dark:text-matcha-400 m-0">
            {counts.bookmarked} Bookmarked {counts.bookmarked === 1 ? 'Card' : 'Cards'}
          </p>
          <h1 className="font-serif text-2xl font-medium text-ink-700 dark:text-sage-100 m-0">
            {heading}
          </h1>
          <p className="text-[0.9rem] text-ink-500 dark:text-sage-400 m-0">
            {description}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2.5 max-w-sm mx-auto text-center">
          <div className="rounded-zen py-2.5 px-3 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/50 dark:border-tea-slate-50/40">
            <div className="font-serif text-lg font-medium tabular-nums text-matcha-600 dark:text-matcha-300">
              {counts.due}
            </div>
            <div className="text-[0.7rem] text-ink-400 dark:text-sage-500">Due Cards</div>
          </div>
          <div className="rounded-zen py-2.5 px-3 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/50 dark:border-tea-slate-50/40">
            <div className="font-serif text-lg font-medium tabular-nums text-ink-700 dark:text-sage-100">
              {counts.newCards}
            </div>
            <div className="text-[0.7rem] text-ink-400 dark:text-sage-500">New Cards</div>
          </div>
          <div className="rounded-zen py-2.5 px-3 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/50 dark:border-tea-slate-50/40">
            <div className="font-serif text-lg font-medium tabular-nums text-ink-700 dark:text-sage-100">
              {counts.bookmarked}
            </div>
            <div className="text-[0.7rem] text-ink-400 dark:text-sage-500">Bookmarked</div>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-zen px-4 py-2.5 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-xs text-earth-rust dark:text-rose-200"
          >
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <button
            type="button"
            disabled={isRefreshing}
            aria-busy={isRefreshing || undefined}
            onClick={onRefreshQueue}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-200 motion-reduce:transition-none disabled:opacity-60"
          >
            {isRefreshing && <ZenPendingDot />}
            <span>
              {isRefreshing
                ? 'Checking…'
                : hasRemainingOutsideBatch
                  ? 'Load Remaining Cards'
                  : 'Check for Due Cards'}
            </span>
          </button>
          <StudyLink
            href={practiceHref}
            className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400 dark:border-tea-slate-50/60 no-underline"
          >
            Go to Practice
          </StudyLink>
          <StudyLink
            href="/study"
            className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-500 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 no-underline"
          >
            Return to Dashboard
          </StudyLink>
        </div>
      </div>

      <UpcomingReviewsSummary upcoming={upcomingReviews} />
    </div>
  )
}
