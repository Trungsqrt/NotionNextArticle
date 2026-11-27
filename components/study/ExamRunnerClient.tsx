'use client'

import { StudyLink } from './StudyNavigationContext'
import { ExamRunnerSkeleton } from './StudySkeletons'
import { useMockExamSession } from './exam/useMockExamSession'
import { useMockExamKeyboardShortcuts } from './exam/useMockExamKeyboardShortcuts'
import { ExamActiveView } from './exam/ExamActiveView'
import { ExamResultsReview } from './exam/ExamResultsReview'

export default function ExamRunnerClient({
  examId,
  userId,
}: {
  examId: string
  userId: string
}) {
  const exam = useMockExamSession({ examId, userId })

  useMockExamKeyboardShortcuts({
    enabled: !exam.loading && Boolean(exam.session) && !exam.result && !exam.submitting,
    canGoPrevious: exam.canGoPrevious,
    canGoNext: exam.canGoNext,
    onPrevious: exam.goPrevious,
    onNext: exam.goNext,
  })

  if (exam.loading) {
    return <ExamRunnerSkeleton />
  }

  if (exam.error && !exam.session) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 space-y-4 animate-study-feedback">
        <div
          role="alert"
          className="rounded-card p-6 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <span>{exam.error}</span>
          <button
            type="button"
            onClick={exam.startExam}
            className="self-start sm:self-auto px-4 py-2 rounded-zen text-xs font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 dark:border-rose-400/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none shrink-0"
          >
            Try Again
          </button>
        </div>
        <StudyLink
          href="/study/exams"
          className="text-sm text-matcha-600 dark:text-matcha-300 no-underline hover:underline"
        >
          ← Back to Mock Exams
        </StudyLink>
      </div>
    )
  }

  if (exam.result) {
    return <ExamResultsReview result={exam.result} onRetake={exam.startExam} />
  }

  if (!exam.session || !exam.currentQuestion) {
    return null
  }

  return (
    <ExamActiveView
      session={exam.session}
      currentIdx={exam.currentIdx}
      currentQuestion={exam.currentQuestion}
      answers={exam.answers}
      flagged={exam.flagged}
      answeredTotal={exam.answeredTotal}
      remainingSeconds={exam.remainingSeconds}
      submitting={exam.submitting}
      error={exam.error}
      canGoPrevious={exam.canGoPrevious}
      canGoNext={exam.canGoNext}
      onSubmit={exam.handleSubmit}
      onToggleOption={exam.toggleOption}
      onToggleFlag={exam.toggleFlag}
      onSelectQuestion={exam.selectQuestion}
      onPrevious={exam.goPrevious}
      onNext={exam.goNext}
    />
  )
}
