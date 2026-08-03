/**
 * CourseCard.js — Wabi-Sabi Minimalist Bento Card
 * ─────────────────────────────────────────────────
 * Displays a single course / lesson as a clean, warm card on the home page.
 * Designed to work with standard NotionNext page props.
 *
 * Props (all optional — component gracefully degrades):
 *   title        — String: lesson/course title
 *   slug         — String: URL slug for the link
 *   tags         — Array<String>: category / tag labels
 *   cover        — String: cover image URL
 *   icon         — String: emoji icon
 *   summary      — String: short description
 *   date         — String | Date: last updated date
 *   difficulty   — 'Beginner' | 'Intermediate' | 'Advanced'
 *   duration     — String: e.g. '45 min'
 *   status       — 'Published' | 'Draft' | 'In Progress'
 *   completedAt  — Date | null: if user has completed it
 *
 * IMPORTANT: Accepts any extra props (spread) without breaking.
 */

import Link from 'next/link'
import Image from 'next/image'

// ── Icon helpers
const ClockIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
)

const StarIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"
    stroke="none" aria-hidden="true">
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z" />
  </svg>
)

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const ArrowIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
)

// ── Difficulty badge
const DIFFICULTY_CONFIG = {
  Beginner:     { color: 'text-matcha-500 dark:text-matcha-300 bg-matcha-50/80 dark:bg-matcha-700/25', dots: 1 },
  Intermediate: { color: 'text-ink-500 dark:text-sage-300 bg-rice-paper-300/80 dark:bg-tea-slate-200/40', dots: 2 },
  Advanced:     { color: 'text-ink-600 dark:text-sage-200 bg-ink-100/50 dark:bg-tea-slate-100/40', dots: 3 },
}

function DifficultyBadge({ level }) {
  const config = DIFFICULTY_CONFIG[level] || DIFFICULTY_CONFIG.Beginner
  return (
    <span className={`flex items-center gap-1 text-[0.68rem] font-medium px-2 py-0.5 rounded-pill ${config.color}`}>
      {Array.from({ length: 3 }).map((_, i) => (
        <span
          key={i}
          className={`inline-block w-1 h-1 rounded-full ${
            i < config.dots ? 'bg-current' : 'bg-current opacity-25'
          }`}
        />
      ))}
      {level}
    </span>
  )
}

// ── Tag chip
function TagChip({ label }) {
  return (
    <span className="inline-block text-[0.68rem] font-medium px-2 py-0.5 rounded-pill bg-matcha-100/70 dark:bg-matcha-700/25 text-matcha-600 dark:text-matcha-300 border border-matcha-200/60 dark:border-matcha-700/40 leading-none">
      {label}
    </span>
  )
}

// ── Date formatter
function formatDate(date) {
  if (!date) return null
  const d = date instanceof Date ? date : new Date(date)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ── Cover image fallback (organic matcha gradient)
function CardCover({ src, icon, title }) {
  if (src) {
    return (
      <div className="aspect-[16/7] overflow-hidden bg-rice-paper-200 dark:bg-tea-slate-200 flex-shrink-0">
        <Image
          src={src}
          alt={`Cover image for ${title || 'lesson'}`}
          fill
          className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        />
      </div>
    )
  }

  return (
    <div
      className="aspect-[16/7] overflow-hidden flex-shrink-0 flex items-center justify-center"
      style={{
        background: 'linear-gradient(135deg, rgba(122,139,105,0.12) 0%, rgba(174,201,163,0.18) 60%, rgba(234,230,223,0.10) 100%)',
      }}
      aria-hidden="true"
    >
      {icon ? (
        <span className="text-4xl select-none transition-transform duration-300 group-hover:scale-110">
          {icon}
        </span>
      ) : (
        /* Wabi-sabi organic blob decoration */
        <svg width="60" height="60" viewBox="0 0 60 60" fill="none" opacity="0.3" aria-hidden="true">
          <path
            d="M30 8 C40 8 52 16 52 30 C52 44 44 52 30 52 C16 52 8 44 8 30 C8 16 20 8 30 8 Z"
            fill="rgba(122,139,105,0.5)"
          />
          <path
            d="M30 16 C36 16 44 22 44 30 C44 38 38 44 30 44 C22 44 16 38 16 30 C16 22 24 16 30 16 Z"
            fill="rgba(175,201,163,0.6)"
          />
        </svg>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
//  CourseCard Component
// ════════════════════════════════════════════════════════════
export default function CourseCard({
  title = 'Untitled Lesson',
  slug = '#',
  tags = [],
  cover = null,
  icon = null,
  summary = '',
  date = null,
  difficulty = null,
  duration = null,
  status = 'Published',
  completedAt = null,
  // Absorb any extra NotionNext props without breaking
  ...rest
}) {
  const href = slug.startsWith('/') ? slug : `/${slug}`
  const isCompleted = Boolean(completedAt)
  const isDraft = status === 'Draft'

  return (
    <article
      className={[
        'group relative flex flex-col rounded-card',
        'bg-rice-paper-100 dark:bg-tea-slate-300',
        'border border-rice-paper-400/70 dark:border-tea-slate-50/60',
        'overflow-hidden',
        'shadow-zen-sm',
        'transition-all duration-300 ease-out',
        'hover:-translate-y-[3px] hover:shadow-zen hover:border-matcha-400/60 dark:hover:border-matcha-700/60',
        isDraft ? 'opacity-70' : 'opacity-100',
        'animate-fade-in',
      ].join(' ')}
    >
      {/* ── Completed ribbon */}
      {isCompleted && (
        <div
          className="absolute top-3 right-3 z-10 flex items-center gap-1 text-[0.65rem] font-semibold px-2 py-1 rounded-pill bg-matcha-500 text-white dark:bg-matcha-700 shadow-matcha"
          aria-label="Lesson completed"
        >
          <CheckIcon />
          Done
        </div>
      )}

      {/* ── Card Cover / Hero */}
      <Link href={href} tabIndex="-1" aria-hidden="true" className="relative block">
        <CardCover src={cover} icon={icon} title={title} />
        {/* Subtle gradient overlay at bottom of cover */}
        <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-rice-paper-100/60 dark:from-tea-slate-300/60 to-transparent" />
      </Link>

      {/* ── Card Body */}
      <div className="flex flex-col flex-1 p-4 gap-2.5">

        {/* Tags row */}
        {tags.length > 0 && (
          <div
            className="flex flex-wrap gap-1.5"
            aria-label="Categories"
          >
            {tags.slice(0, 3).map((tag) => (
              <TagChip key={tag} label={tag} />
            ))}
          </div>
        )}

        {/* Title */}
        <Link
          href={href}
          id={`course-card-${slug}`}
          className="block no-underline group/title"
        >
          <h2
            className={[
              'font-serif font-medium text-[1rem] leading-snug text-balance',
              'text-ink-700 dark:text-sage-100',
              'group-hover/title:text-matcha-600 dark:group-hover/title:text-matcha-300',
              'transition-colors duration-200',
              // Two-line clamp
              'line-clamp-2',
            ].join(' ')}
          >
            {title}
          </h2>
        </Link>

        {/* Summary */}
        {summary && (
          <p className="text-[0.82rem] leading-relaxed text-ink-400 dark:text-sage-500 line-clamp-2 flex-1">
            {summary}
          </p>
        )}

        {/* ── Meta row */}
        <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/30">

          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {/* Difficulty */}
            {difficulty && <DifficultyBadge level={difficulty} />}

            {/* Duration */}
            {duration && (
              <span className="flex items-center gap-1 text-[0.72rem] text-ink-400 dark:text-sage-500">
                <ClockIcon />
                {duration}
              </span>
            )}

            {/* Date */}
            {date && !difficulty && !duration && (
              <time
                dateTime={new Date(date).toISOString()}
                className="text-[0.72rem] text-ink-400 dark:text-sage-600"
              >
                {formatDate(date)}
              </time>
            )}
          </div>

          {/* Read CTA */}
          <Link
            href={href}
            aria-label={`Read ${title}`}
            className={[
              'flex items-center gap-1.5 flex-shrink-0',
              'text-[0.75rem] font-medium',
              'text-matcha-500 dark:text-matcha-400',
              'hover:text-matcha-600 dark:hover:text-matcha-300',
              'transition-colors duration-200',
              'no-underline',
            ].join(' ')}
            tabIndex={0}
          >
            <span>Read</span>
            <span className="transition-transform duration-200 group-hover:translate-x-0.5">
              <ArrowIcon />
            </span>
          </Link>
        </div>
      </div>
    </article>
  )
}
