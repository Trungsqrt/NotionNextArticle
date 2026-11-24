/**
 * components/study/StudySkeletons.tsx
 * ────────────────────────────────────────────────────────────────────────
 * Expressive Zen route & data skeletons matching the exact structure of
 * each Private Study Room view. Warm ivory / tea-slate surfaces with calm
 * opacity breathing (no shimmer sweeps, no layout shifts, reduced-motion safe).
 */

function Bone({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={[
        'rounded-zen bg-rice-paper-300/80 dark:bg-tea-slate-100/85 animate-zen-skeleton',
        className,
      ].join(' ')}
    />
  )
}

export function ZenPendingDot({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'inline-block w-1.5 h-1.5 rounded-full bg-current animate-zen-breathe shrink-0',
        className,
      ].join(' ')}
    />
  )
}

/**
 * Matches redesigned StudyDashboardClient layout:
 * Heading + 2 CTAs, 4 summary metric cards, and 2-column Exam Collection cards
 * with Practice Progress & Mock Exam Progress blocks.
 */
export function StudyDashboardSkeleton() {
  return (
    <div
      className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-10 animate-study-feedback"
      role="status"
      aria-busy="true"
      aria-label="Loading study overview"
    >
      <span className="sr-only">Loading study overview…</span>

      {/* Top Heading + Primary CTAs */}
      <section className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-2.5">
          <Bone className="h-8 w-48" />
          <Bone className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex items-center gap-2.5">
          <Bone className="h-9 w-36" />
          <Bone className="h-9 w-32" />
        </div>
      </section>

      {/* Core Metrics (4 cards) */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((idx) => (
          <div
            key={idx}
            className="rounded-card p-5 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm space-y-3"
          >
            <Bone className="h-3 w-24" />
            <Bone className="h-8 w-16" />
            <Bone className="h-3 w-28" />
          </div>
        ))}
      </section>

      {/* Exam Collections */}
      <section className="space-y-4">
        <Bone className="h-5 w-40" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((idx) => (
            <div
              key={idx}
              className="rounded-card p-5 sm:p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm space-y-5"
            >
              <div className="space-y-2">
                <Bone className="h-3 w-28" />
                <Bone className="h-5 w-52 max-w-full" />
              </div>

              <div className="space-y-2.5 pt-3 border-t border-rice-paper-400/50 dark:border-tea-slate-50/40">
                <div className="flex items-center justify-between">
                  <Bone className="h-3 w-28" />
                  <Bone className="h-5 w-20 rounded-pill" />
                </div>
                <Bone className="h-1.5 w-full rounded-pill" />
                <div className="flex items-center justify-between">
                  <Bone className="h-3 w-36" />
                  <Bone className="h-3 w-24" />
                </div>
              </div>

              <div className="space-y-2.5 pt-3 border-t border-rice-paper-400/50 dark:border-tea-slate-50/40">
                <div className="flex items-center justify-between">
                  <Bone className="h-3 w-32" />
                  <Bone className="h-5 w-24 rounded-pill" />
                </div>
                <div className="flex items-center justify-between">
                  <Bone className="h-3 w-36" />
                  <Bone className="h-3 w-20" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

/**
 * Matches the question card inside PracticeModeClient.
 * Used for both initial Practice data load and route loading.
 */
export function PracticeQuestionCardSkeleton() {
  return (
    <div
      className="rounded-card p-6 sm:p-8 bg-rice-paper-50/95 dark:bg-tea-slate-200/70 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-6 animate-study-feedback"
      role="status"
      aria-busy="true"
      aria-label="Loading practice questions"
    >
      <span className="sr-only">Loading practice questions…</span>

      {/* Meta row + Bookmark button */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bone className="h-3.5 w-12" />
          <Bone className="h-3.5 w-28" />
          <Bone className="h-3.5 w-20" />
        </div>
        <Bone className="h-7 w-24" />
      </div>

      {/* Question stem */}
      <div className="space-y-2.5">
        <Bone className="h-5 w-full" />
        <Bone className="h-5 w-5/6" />
      </div>

      {/* 4 Option rows */}
      <div className="space-y-2.5">
        {[0, 1, 2, 3].map((idx) => (
          <div
            key={idx}
            className="rounded-zen px-4 py-3.5 bg-rice-paper-100/70 dark:bg-tea-slate-300/60 border border-rice-paper-400/60 dark:border-tea-slate-50/40 flex items-center gap-3"
          >
            <Bone className="h-5 w-6 shrink-0" />
            <Bone className={`h-4 ${idx % 2 === 0 ? 'w-3/4' : 'w-2/3'}`} />
          </div>
        ))}
      </div>

      {/* Footer navigation */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <Bone className="h-9 w-24" />
        <div className="flex items-center gap-2.5">
          <Bone className="h-9 w-32" />
          <Bone className="h-9 w-20" />
        </div>
      </div>
    </div>
  )
}

/**
 * Matches full PracticeModeClient page layout (header + selector + filters + card).
 */
export function PracticeModeSkeleton() {
  return (
    <div
      className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6 animate-study-feedback"
      role="status"
      aria-busy="true"
      aria-label="Loading practice mode"
    >
      <span className="sr-only">Loading practice mode…</span>

      {/* Top Bar: Heading & Exam Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-2">
          <Bone className="h-7 w-40" />
          <Bone className="h-4 w-80 max-w-full" />
        </div>
        <Bone className="h-10 w-56" />
      </div>

      {/* Filter Tabs + Progress */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1.5 p-1 rounded-zen bg-rice-paper-200/70 dark:bg-tea-slate-200/70 border border-rice-paper-400/60 dark:border-tea-slate-50/40">
          <Bone className="h-6 w-16" />
          <Bone className="h-6 w-20" />
          <Bone className="h-6 w-24" />
        </div>
        <Bone className="h-4 w-24" />
      </div>

      <PracticeQuestionCardSkeleton />
    </div>
  )
}

/**
 * Matches RecallSessionClient layout:
 * Progress header + Flashcard surface (meta, stem, guidance box, action buttons).
 */
export function RecallSessionSkeleton() {
  return (
    <div
      className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6 animate-study-feedback"
      role="status"
      aria-busy="true"
      aria-label="Loading active recall session"
    >
      <span className="sr-only">Loading active recall session…</span>

      {/* Progress Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Bone className="h-5 w-20 rounded-pill" />
          <Bone className="h-4 w-32" />
        </div>
        <Bone className="h-4 w-44" />
      </div>

      {/* Flashcard Surface */}
      <article className="rounded-card p-6 sm:p-8 bg-rice-paper-50/95 dark:bg-tea-slate-200/70 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-6">
        <div className="flex items-center justify-between">
          <Bone className="h-3.5 w-24" />
          <Bone className="h-3.5 w-20" />
        </div>

        <div className="space-y-2.5">
          <Bone className="h-5 w-full" />
          <Bone className="h-5 w-11/12" />
          <Bone className="h-5 w-2/3" />
        </div>

        {/* Free-recall guidance box */}
        <div className="rounded-zen p-4 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/50 dark:border-tea-slate-50/40 space-y-2">
          <Bone className="h-3.5 w-5/6" />
          <Bone className="h-3.5 w-2/3" />
        </div>

        {/* Action controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <Bone className="h-9 w-36" />
          <Bone className="h-10 w-44" />
        </div>
      </article>
    </div>
  )
}

/**
 * Matches app/study/exams/page.tsx layout:
 * Heading + 2-column grid of exam cards.
 */
export function MockExamsSkeleton() {
  return (
    <div
      className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-6 animate-study-feedback"
      role="status"
      aria-busy="true"
      aria-label="Loading mock exams"
    >
      <span className="sr-only">Loading mock exams…</span>

      <div className="space-y-2">
        <Bone className="h-8 w-52" />
        <Bone className="h-4 w-96 max-w-full" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[0, 1, 2, 3].map((idx) => (
          <div
            key={idx}
            className="rounded-card p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm flex flex-col justify-between gap-5"
          >
            <div className="space-y-2.5">
              <Bone className="h-3 w-36" />
              <Bone className="h-5 w-56 max-w-full" />
              <Bone className="h-3.5 w-full" />
              <Bone className="h-3.5 w-4/5" />
            </div>
            <div className="flex items-center gap-3 pt-3 border-t border-rice-paper-400/50 dark:border-tea-slate-50/40">
              <Bone className="h-8 w-32" />
              <Bone className="h-4 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Matches ExamRunnerClient layout:
 * Exam top bar + 2-column question card & navigator grid.
 */
export function ExamRunnerSkeleton() {
  return (
    <div
      className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6 animate-study-feedback"
      role="status"
      aria-busy="true"
      aria-label="Loading timed exam"
    >
      <span className="sr-only">Loading timed exam…</span>

      {/* Exam Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-rice-paper-400/70 dark:border-tea-slate-50/50">
        <div className="space-y-2">
          <Bone className="h-7 w-64 max-w-full" />
          <Bone className="h-3.5 w-72 max-w-full" />
        </div>
        <div className="flex items-center gap-3">
          <Bone className="h-9 w-20" />
          <Bone className="h-9 w-28" />
        </div>
      </div>

      {/* Main Question + Navigator */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-6 items-start">
        <PracticeQuestionCardSkeleton />

        <aside className="rounded-card p-4 bg-rice-paper-50/85 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50 space-y-3">
          <Bone className="h-3.5 w-20" />
          <div className="grid grid-cols-5 gap-1.5">
            {Array.from({ length: 15 }).map((_, idx) => (
              <Bone key={idx} className="h-8 w-full rounded-[4px]" />
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
