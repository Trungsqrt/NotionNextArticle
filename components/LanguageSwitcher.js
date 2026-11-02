import Link from 'next/link'
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, getLocaleMeta } from '../lib/locales'

/**
 * LanguageSwitcher.js — Wabi-Sabi EN / VI article language control
 * ──────────────────────────────────────────────────────────────────
 * Compact segmented pill rendered under the article description. Each option
 * navigates to the *actual slug* of that language version (real Next.js
 * routing, not UI state).
 *
 *   - Current locale   → highlighted, aria-current="true", not a link
 *   - Translation found → <Link href="/{translated-slug}" hrefLang lang>
 *   - No translation    → visually muted, aria-disabled, not focusable,
 *                         never navigates anywhere
 *
 * Props:
 *   currentLocale — locale code of the article being read ('en' | 'vi' | …)
 *   translations  — { [locale]: { slug, title } | null } for the other locales
 */

const segmentBase = [
  'relative inline-flex items-center justify-center gap-1.5',
  'min-w-[3rem] h-7 px-3 rounded-pill',
  'text-[0.72rem] font-semibold tracking-[0.12em] leading-none select-none',
  'transition-all duration-200 ease-zen',
].join(' ')

const segmentActive = [
  'bg-rice-paper-50 dark:bg-tea-slate-50',
  'text-matcha-600 dark:text-matcha-300',
  'border border-matcha-300/60 dark:border-matcha-700/60',
  'shadow-zen-sm',
].join(' ')

const segmentAvailable = [
  'border border-transparent no-underline',
  'text-ink-500 dark:text-sage-400',
  'hover:text-matcha-600 dark:hover:text-matcha-300',
  'hover:bg-rice-paper-100/80 dark:hover:bg-tea-slate-100/80',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matcha-400/60 dark:focus-visible:ring-matcha-600/60',
  'focus-visible:ring-offset-1 focus-visible:ring-offset-rice-paper-200 dark:focus-visible:ring-offset-tea-slate-200',
].join(' ')

const segmentUnavailable = [
  'border border-transparent cursor-not-allowed',
  'text-ink-300 dark:text-sage-600',
].join(' ')

export default function LanguageSwitcher({ currentLocale = DEFAULT_LOCALE, translations = {} }) {
  const locales = SUPPORTED_LOCALES.includes(currentLocale)
    ? SUPPORTED_LOCALES
    : [...SUPPORTED_LOCALES, currentLocale]

  return (
    <nav
      aria-label="Article language"
      className="not-prose mt-5 flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      <span
        className="text-[0.68rem] uppercase tracking-[0.2em] font-medium text-ink-400 dark:text-sage-500 select-none"
        aria-hidden="true"
      >
        Language
      </span>

      <ul
        role="list"
        className={[
          'inline-flex items-center gap-0.5 p-0.5 m-0 list-none rounded-pill',
          'bg-rice-paper-200/80 dark:bg-tea-slate-200/70',
          'border border-rice-paper-400/70 dark:border-tea-slate-50/50',
        ].join(' ')}
      >
        {locales.map((locale) => {
          const meta = getLocaleMeta(locale)
          const isCurrent = locale === currentLocale
          const translation = isCurrent ? null : translations?.[locale]

          if (isCurrent) {
            return (
              <li key={locale} className="m-0 p-0">
                <span
                  aria-current="true"
                  lang={meta.hreflang}
                  title={`${meta.label} (current)`}
                  className={`${segmentBase} ${segmentActive}`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400"
                    aria-hidden="true"
                  />
                  {meta.short}
                  <span className="sr-only">{` — ${meta.label}, current language`}</span>
                </span>
              </li>
            )
          }

          if (translation?.slug) {
            return (
              <li key={locale} className="m-0 p-0">
                <Link
                  href={`/${translation.slug}`}
                  hrefLang={meta.hreflang}
                  lang={meta.hreflang}
                  title={`Read in ${meta.label}${translation.title ? `: ${translation.title}` : ''}`}
                  className={`${segmentBase} ${segmentAvailable}`}
                >
                  {meta.short}
                  <span className="sr-only">{` — Read this article in ${meta.label}`}</span>
                </Link>
              </li>
            )
          }

          return (
            <li key={locale} className="m-0 p-0">
              <span
                aria-disabled="true"
                lang={meta.hreflang}
                title={`${meta.label} version not available yet`}
                className={`${segmentBase} ${segmentUnavailable}`}
              >
                <span className="line-through decoration-1 decoration-ink-300/70 dark:decoration-sage-600/70">
                  {meta.short}
                </span>
                <span className="sr-only">{` — ${meta.label} version not available`}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
