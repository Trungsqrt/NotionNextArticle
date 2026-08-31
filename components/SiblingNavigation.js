import Link from 'next/link'

/**
 * SiblingNavigation.js — Wabi-Sabi Previous / Next Article Navigation
 * ──────────────────────────────────────────────────────────────────
 * Renders understated navigation cards at the bottom of dynamic article pages
 * for lessons/articles belonging to the same parent module or course.
 *
 * Props:
 *   prevPage — { title: string, slug: string, id: string, icon?: object|string } | null
 *   nextPage — { title: string, slug: string, id: string, icon?: object|string } | null
 */
export default function SiblingNavigation({ prevPage, nextPage }) {
  // Do not render anything if there are no sibling pages to navigate to
  if (!prevPage && !nextPage) {
    return null
  }

  return (
    <nav
      aria-label="Sibling article navigation"
      className="not-prose mt-14 pt-8 border-t border-rice-paper-400/60 dark:border-tea-slate-50/40"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* ── Left Column: Previous Article Card ─────────────────────────── */}
        {prevPage ? (
          <Link
            href={`/${prevPage.slug || prevPage.id}`}
            className={[
              'group relative flex items-center gap-3.5 p-4 rounded-xl text-left no-underline',
              'bg-rice-paper-100 dark:bg-tea-slate-300',
              'border border-rice-paper-400/70 dark:border-tea-slate-50/60',
              'shadow-zen-sm transition-all duration-300 ease-out',
              'hover:-translate-y-0.5 hover:shadow-zen',
              'hover:border-matcha-400/60 dark:hover:border-matcha-700/60',
            ].join(' ')}
          >
            {/* Left Chevron Capsule */}
            <div
              className={[
                'w-9 h-9 rounded-full shrink-0 flex items-center justify-center',
                'bg-rice-paper-200/80 dark:bg-tea-slate-200/70',
                'border border-rice-paper-400/50 dark:border-tea-slate-50/30',
                'text-ink-400 dark:text-sage-400',
                'group-hover:text-matcha-600 dark:group-hover:text-matcha-300',
                'group-hover:border-matcha-300/60 dark:group-hover:border-matcha-700/50',
                'transition-all duration-300 ease-out',
              ].join(' ')}
              aria-hidden="true"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-transform duration-300 ease-out group-hover:-translate-x-0.5"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </div>

            {/* Article Meta & Title */}
            <div className="flex-1 min-w-0">
              <span className="block text-[0.7rem] uppercase tracking-wider font-semibold text-ink-400 dark:text-sage-500 group-hover:text-matcha-600 dark:group-hover:text-matcha-400 transition-colors duration-200 mb-0.5">
                Previous
              </span>
              <h4 className="font-serif text-[0.95rem] font-medium text-ink-700 dark:text-sage-100 group-hover:text-matcha-600 dark:group-hover:text-matcha-300 transition-colors duration-200 line-clamp-2 leading-snug m-0">
                {prevPage.title || 'Previous Article'}
              </h4>
            </div>
          </Link>
        ) : (
          /* Empty placeholder to preserve 2-column grid placement when prev is absent */
          <div className="hidden sm:block" aria-hidden="true" />
        )}

        {/* ── Right Column: Next Article Card ────────────────────────────── */}
        {nextPage ? (
          <Link
            href={`/${nextPage.slug || nextPage.id}`}
            className={[
              'group relative flex items-center justify-end text-right gap-3.5 p-4 rounded-xl no-underline',
              'bg-rice-paper-100 dark:bg-tea-slate-300',
              'border border-rice-paper-400/70 dark:border-tea-slate-50/60',
              'shadow-zen-sm transition-all duration-300 ease-out',
              'hover:-translate-y-0.5 hover:shadow-zen',
              'hover:border-matcha-400/60 dark:hover:border-matcha-700/60',
              !prevPage ? 'sm:col-start-2' : '',
            ].join(' ')}
          >
            {/* Article Meta & Title */}
            <div className="flex-1 min-w-0">
              <span className="block text-[0.7rem] uppercase tracking-wider font-semibold text-ink-400 dark:text-sage-500 group-hover:text-matcha-600 dark:group-hover:text-matcha-400 transition-colors duration-200 mb-0.5">
                Next
              </span>
              <h4 className="font-serif text-[0.95rem] font-medium text-ink-700 dark:text-sage-100 group-hover:text-matcha-600 dark:group-hover:text-matcha-300 transition-colors duration-200 line-clamp-2 leading-snug m-0">
                {nextPage.title || 'Next Article'}
              </h4>
            </div>

            {/* Right Chevron Capsule */}
            <div
              className={[
                'w-9 h-9 rounded-full shrink-0 flex items-center justify-center',
                'bg-rice-paper-200/80 dark:bg-tea-slate-200/70',
                'border border-rice-paper-400/50 dark:border-tea-slate-50/30',
                'text-ink-400 dark:text-sage-400',
                'group-hover:text-matcha-600 dark:group-hover:text-matcha-300',
                'group-hover:border-matcha-300/60 dark:group-hover:border-matcha-700/50',
                'transition-all duration-300 ease-out',
              ].join(' ')}
              aria-hidden="true"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-transform duration-300 ease-out group-hover:translate-x-0.5"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          </Link>
        ) : (
          /* Empty placeholder to preserve 2-column grid placement when next is absent */
          <div className="hidden sm:block" aria-hidden="true" />
        )}
      </div>
    </nav>
  )
}
