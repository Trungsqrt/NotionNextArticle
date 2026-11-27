'use client'

import { useSearchParams } from 'next/navigation'
import { RecallSessionSkeleton } from './StudySkeletons'
import { useRecallSession } from './recall/useRecallSession'
import { useRecallKeyboardShortcuts } from './recall/useRecallKeyboardShortcuts'
import {
  RecallEmptyCaughtUp,
  RecallEmptyNoBookmarks,
  RecallErrorState,
} from './recall/RecallStatusViews'
import { RecallFlashcard } from './recall/RecallFlashcard'

export default function RecallSessionClient({ userId }: { userId: string }) {
  const searchParams = useSearchParams()
  const examIdFilter = searchParams?.get('examId') || ''

  const session = useRecallSession({ userId, examIdFilter })

  useRecallKeyboardShortcuts({
    enabled: Boolean(session.currentItem) && session.queueStatus === 'loaded',
    isRevealed: Boolean(session.revealed),
    loadingReveal: session.loadingReveal,
    isSubmittingRating: Boolean(session.submittingRating),
    onToggleChoices: session.toggleChoices,
    onReveal: session.handleReveal,
    onRate: session.handleRate,
  })

  if (session.queueStatus === 'loading') {
    return <RecallSessionSkeleton />
  }

  if (session.queueStatus === 'error' && !session.currentItem) {
    return <RecallErrorState error={session.error} onRetry={session.loadQueue} />
  }

  // Empty state 1: No bookmarked questions exist
  if (!session.currentItem && session.counts.bookmarked === 0) {
    return (
      <RecallEmptyNoBookmarks
        practiceHref={session.practiceHref}
        bookmarkSyncSummary={session.bookmarkSyncSummary}
        onRetryBookmarkSync={session.retryBookmarkSync}
      />
    )
  }

  // Empty state 2: Bookmarks exist, but no cards are currently displayed in the active batch
  if (!session.currentItem) {
    return (
      <RecallEmptyCaughtUp
        counts={session.counts}
        completedCount={session.completedCount}
        upcomingReviews={session.upcomingReviews}
        error={session.error}
        isRefreshing={session.isRefreshing}
        practiceHref={session.practiceHref}
        bookmarkSyncSummary={session.bookmarkSyncSummary}
        onRetryBookmarkSync={session.retryBookmarkSync}
        onRefreshQueue={session.loadQueue}
      />
    )
  }

  return (
    <RecallFlashcard
      item={session.currentItem}
      currentIdx={session.currentIdx}
      queueLength={session.queue.length}
      counts={session.counts}
      upcomingTotal={session.upcomingTotal}
      isRefreshing={session.isRefreshing}
      showChoices={session.showChoices}
      revealed={session.revealed}
      loadingReveal={session.loadingReveal}
      submittingRating={session.submittingRating}
      error={session.error}
      bookmarkSyncSummary={session.bookmarkSyncSummary}
      onToggleChoices={session.toggleChoices}
      onReveal={session.handleReveal}
      onRate={session.handleRate}
      onRemoveFromRecall={session.handleRemoveFromRecall}
      onRetryBookmarkSync={session.retryBookmarkSync}
      onDismissError={session.dismissError}
    />
  )
}
