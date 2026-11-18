import Link from 'next/link'
import { DEFAULT_LOCALE } from '../lib/locales'
import { getContactCopy, resolveContactLocale, sanitizeTextParam, FIELD_LIMITS } from '../lib/contact-i18n'

/**
 * ArticleFeedback.js — Subtle Wabi-Sabi Article Correction & Feedback Prompt
 * ───────────────────────────────────────────────────────────────────────────
 * Rendered near the bottom of dynamic article pages using metadata already
 * fetched by app/[...slug]/page.js (zero extra Notion API requests).
 *
 * Navigates to /contact with validated query parameters so the contact form
 * pre-selects "Article Correction" and pre-fills the related article details.
 */
export default function ArticleFeedback({
  title,
  articleUrl,
  locale = DEFAULT_LOCALE,
}) {
  const uiLocale = resolveContactLocale(locale)
  const copy = getContactCopy(uiLocale).articleFeedback

  const safeTitle = sanitizeTextParam(title || '', FIELD_LIMITS.articleTitleMax)
  const params = new URLSearchParams()
  params.set('subject', 'article-correction')
  if (safeTitle) params.set('title', safeTitle)
  if (articleUrl) params.set('url', articleUrl)
  if (uiLocale !== DEFAULT_LOCALE) params.set('lang', uiLocale)

  const contactHref = `/contact?${params.toString()}`

  return (
    <aside
      aria-label={copy.heading}
      className={[
        'not-prose mt-12 rounded-card px-5 py-5 sm:px-6 sm:py-5',
        'bg-rice-paper-200/70 dark:bg-tea-slate-200/60',
        'border border-rice-paper-400/70 dark:border-tea-slate-50/50',
        'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4',
      ].join(' ')}
    >
      <div className="min-w-0">
        <h2 className="font-serif text-[1.02rem] font-medium text-ink-700 dark:text-sage-100 m-0 leading-snug">
          {copy.heading}
        </h2>
        <p className="text-[0.86rem] leading-relaxed text-ink-500 dark:text-sage-400 mt-1 mb-0">
          {copy.description}
        </p>
      </div>

      <Link
        href={contactHref}
        className={[
          'inline-flex items-center justify-center gap-2 shrink-0',
          'px-4 py-2 rounded-zen text-[0.82rem] font-medium no-underline',
          'bg-rice-paper-50 dark:bg-tea-slate-100',
          'text-matcha-600 dark:text-matcha-300',
          'border border-matcha-300/70 dark:border-matcha-700/60',
          'shadow-zen-sm',
          'hover:bg-matcha-50 dark:hover:bg-matcha-900/40',
          'hover:border-matcha-500/70 dark:hover:border-matcha-500/60',
          'transition-colors duration-200 ease-zen motion-reduce:transition-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matcha-500/60 dark:focus-visible:ring-matcha-400/60',
        ].join(' ')}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        <span>{copy.button}</span>
      </Link>
    </aside>
  )
}
