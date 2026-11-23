export default function StudyLoginLoading() {
  return (
    <div
      className="max-w-md mx-auto px-4 sm:px-6 py-14 sm:py-20 space-y-6 animate-study-feedback"
      role="status"
      aria-busy="true"
      aria-label="Loading sign-in"
    >
      <span className="sr-only">Loading sign-in…</span>
      <div className="space-y-2.5 flex flex-col items-center">
        <div className="h-3.5 w-32 rounded-zen bg-rice-paper-300/80 dark:bg-tea-slate-100/85 animate-zen-skeleton" />
        <div className="h-7 w-40 rounded-zen bg-rice-paper-300/80 dark:bg-tea-slate-100/85 animate-zen-skeleton" />
      </div>
      <div className="rounded-card p-6 sm:p-7 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-5">
        <div className="h-10 w-full rounded-zen bg-rice-paper-300/80 dark:bg-tea-slate-100/85 animate-zen-skeleton" />
        <div className="h-10 w-full rounded-zen bg-rice-paper-300/80 dark:bg-tea-slate-100/85 animate-zen-skeleton" />
        <div className="h-10 w-full rounded-zen bg-rice-paper-300/80 dark:bg-tea-slate-100/85 animate-zen-skeleton" />
      </div>
    </div>
  )
}
