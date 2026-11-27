'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { ExamCollection } from '../../lib/study/types'
import { PracticeQuestionCardSkeleton } from './StudySkeletons'
import PracticeCompletion from './PracticeCompletion'
import PracticeExamSelector from './practice/PracticeExamSelector'
import {
  LegacyBookmarkImportBanner,
  PracticeCompletionSyncNotice,
  PracticeErrorBanner,
  PracticeFilterBar,
} from './practice/PracticeBanners'
import PracticeQuestionCard from './practice/PracticeQuestionCard'
import { usePracticeSession } from './practice/usePracticeSession'
import { usePracticeKeyboardShortcuts } from './practice/usePracticeKeyboardShortcuts'

/**
 * Top-level coordinator for Study Room Practice Mode.
 * Connects URL exam selection, practice session state, bookmark sync, and
 * keyboard shortcuts to the Practice Mode UI sections.
 */
export default function PracticeModeClient({
  exams,
  userId,
}: {
  exams: ExamCollection[]
  userId: string
}) {
  const searchParams = useSearchParams()
  const paramExamId = searchParams?.get('examId') || ''
  const [examMenuOpen, setExamMenuOpen] = useState(false)

  const session = usePracticeSession({ exams, userId, paramExamId })

  usePracticeKeyboardShortcuts({
    enabled:
      exams.length > 0 &&
      !session.isInitialLoading &&
      !session.isInitialError &&
      !session.isSwitching &&
      !session.isCompleted &&
      !examMenuOpen &&
      session.currentQ !== null,
    currentQuestionId: session.currentQ?.questionId ?? null,
    currentGraded: session.currentGraded,
    hasCurrentSelection: session.hasCurrentSelection,
    isChecking: session.checkingId !== null,
    canGoPrevious: session.canGoPrevious,
    canGoNext: session.canGoNext,
    canFinishPractice: session.canFinishPractice,
    onPrevious: session.goPrevious,
    onNext: session.goNext,
    onCheckAnswer: (questionId) => {
      void session.checkAnswer(questionId)
    },
    onFinishPractice: session.finishPractice,
  })

  if (exams.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 text-center text-sm text-ink-500 dark:text-sage-400">
        No published exam collections are available for practice yet.
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      {/* ── Top Bar: Title & Exam Selector ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-medium text-ink-700 dark:text-sage-100 m-0">
            Practice Mode
          </h1>
          <p className="text-[0.82rem] text-ink-400 dark:text-sage-500 mt-1 mb-0">
            Immediate feedback and explanations. Practice checks remain separate from FSRS memory ratings.
          </p>
        </div>

        <PracticeExamSelector
          exams={exams}
          displayedExamId={session.displayedExamId}
          isSwitching={session.isSwitching}
          isOpen={examMenuOpen}
          onOpenChange={setExamMenuOpen}
          onSelectExam={session.selectExam}
        />
      </div>

      {/* ── Filter Tabs & Progress ── */}
      {!session.isCompleted && (
        <PracticeFilterBar
          filter={session.filter}
          totalQuestionCount={session.allQuestions.length}
          summary={session.summary}
          isInitialLoading={session.isInitialLoading}
          isSwitching={session.isSwitching}
          showViewSummary={session.showViewSummary}
          onSelectFilter={session.selectFilter}
          onViewSummary={session.openSummary}
        />
      )}

      {/* ── One-time Legacy Browser Bookmark Import Banner ── */}
      {session.legacyImportCandidate && !session.isInitialLoading && (
        <LegacyBookmarkImportBanner
          candidate={session.legacyImportCandidate}
          importing={session.importingLegacy}
          error={session.legacyImportError}
          onImport={(examId, questionIds) => {
            void session.importLegacyBookmarks(examId, questionIds)
          }}
          onDismiss={session.dismissLegacyImport}
        />
      )}

      {/* ── Bookmark Sync Warning on Completion Screen ── */}
      {session.isCompleted && session.bookmarkSync.status === 'not_synced' && (
        <PracticeCompletionSyncNotice onRetry={session.retryBookmarkSync} />
      )}

      {/* ── Exam Load / Switch / Check Answer Error Banner ── */}
      {session.practiceError && (
        <PracticeErrorBanner
          error={session.practiceError}
          retryDisabled={
            session.isInitialLoading || session.isSwitching || session.checkingId !== null
          }
          onRetry={session.retryError}
          onDismiss={session.dismissError}
        />
      )}

      {/* ── Main Content Body ── */}
      {session.isInitialLoading ? (
        <PracticeQuestionCardSkeleton />
      ) : session.isInitialError ? (
        <div className="rounded-card p-8 text-center bg-rice-paper-50/80 dark:bg-tea-slate-200/50 border border-rice-paper-400/60 dark:border-tea-slate-50/40 space-y-3 animate-study-feedback">
          <p className="text-sm text-ink-500 dark:text-sage-400 m-0">
            Could not load questions for this exam collection.
          </p>
          <button
            type="button"
            onClick={session.retryLoadActiveExam}
            className="px-4 py-2 rounded-zen text-xs font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-150 motion-reduce:transition-none"
          >
            Retry Loading Questions
          </button>
        </div>
      ) : session.isCompleted && session.payload ? (
        <PracticeCompletion
          examTitle={session.currentExamTitle}
          accuracyPercent={session.summary.accuracyPercent}
          completedCount={session.summary.completedCount}
          totalQuestions={session.summary.totalQuestions}
          correctCount={session.summary.correctCount}
          incorrectCount={session.summary.incorrectCount}
          bookmarkedCount={session.summary.bookmarkedCount}
          onReviewIncorrect={session.reviewIncorrect}
          onReviewBookmarked={session.reviewBookmarked}
          onRestart={session.restartPractice}
          disabled={session.isSwitching}
        />
      ) : !session.currentQ ? (
        <div className="rounded-card p-8 text-center bg-rice-paper-50/80 dark:bg-tea-slate-200/50 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-sm text-ink-400 dark:text-sage-500 animate-study-feedback">
          No questions match the current filter.
        </div>
      ) : (
        <PracticeQuestionCard
          question={session.currentQ}
          positionIndex={session.safeIndex}
          filteredTotal={session.filteredQuestions.length}
          selectedOptionIds={session.selections[session.currentQ.questionId] || []}
          graded={session.results[session.currentQ.questionId]}
          isChecking={session.checkingId === session.currentQ.questionId}
          isAnyCheckInFlight={session.checkingId !== null}
          isSwitching={session.isSwitching}
          isBookmarked={Boolean(session.bookmarks[session.currentQ.questionId])}
          bookmarkSync={session.bookmarkSync}
          bookmarkFeedbackPhase={session.bookmarkFeedbackPhase}
          canGoPrevious={session.canGoPrevious}
          canGoNext={session.canGoNext}
          showFinishPractice={session.showFinishPractice}
          canFinishPractice={session.canFinishPractice}
          showUnansweredPrompt={session.showUnansweredPrompt}
          summary={session.summary}
          onToggleOption={session.toggleOption}
          onCheckAnswer={(questionId, overrideSelected, options) => {
            void session.checkAnswer(questionId, overrideSelected, options)
          }}
          onToggleBookmark={session.toggleBookmark}
          onRetryBookmarkSync={session.retryBookmarkSync}
          onPrevious={session.goPrevious}
          onNext={session.goNext}
          onFinishPractice={session.finishPractice}
          onGoToFirstUnanswered={session.goToFirstUnanswered}
        />
      )}
    </div>
  )
}
