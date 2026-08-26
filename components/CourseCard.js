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

'use client'

import { useState } from 'react'
import Link from 'next/link'

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

// ── Icon renderer helper
function renderCardIcon(icon) {
  if (!icon) return null
  if (typeof icon === 'string') {
    if (icon.startsWith('http') || icon.startsWith('/')) {
      return <img src={icon} alt="" className="w-10 h-10 object-contain" />
    }
    return (
      <span className="text-4xl select-none transition-transform duration-300 group-hover:scale-110">
        {icon}
      </span>
    )
  }
  if (typeof icon === 'object') {
    if (icon.type === 'emoji' && icon.value) {
      return (
        <span className="text-4xl select-none transition-transform duration-300 group-hover:scale-110">
          {icon.value}
        </span>
      )
    }
    if ((icon.type === 'file' || icon.type === 'external') && icon.value) {
      return <img src={icon.value} alt="" className="w-10 h-10 object-contain" />
    }
    if (icon.value && typeof icon.value === 'string') {
      return (
        <span className="text-4xl select-none transition-transform duration-300 group-hover:scale-110">
          {icon.value}
        </span>
      )
    }
  }
  return null
}

// ── Cover image fallback (organic matcha gradient)
function CardCover({ src, icon, title }) {
  const [imgError, setImgError] = useState(false)

  if (src && !imgError) {
    return (
      <div className="relative aspect-[16/7] overflow-hidden flex-shrink-0 bg-rice-paper-200 dark:bg-tea-slate-800">
        <img
          src={src}
          alt={`Cover image for ${title || 'lesson'}`}
          loading="lazy"
          decoding="async"
          onError={() => setImgError(true)}
          className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
        />
      </div>
    )
  }

  const renderedIcon = renderCardIcon(icon)

  return (
    <div
      className="aspect-[16/7] overflow-hidden flex-shrink-0 flex items-center justify-center bg-rice-paper-200 dark:bg-tea-slate-200"
      style={{
        background: 'linear-gradient(135deg, rgba(122,139,105,0.14) 0%, rgba(174,201,163,0.20) 60%, rgba(234,230,223,0.12) 100%)',
      }}
      aria-hidden="true"
    >
      {renderedIcon ? (
        renderedIcon
      ) : (
        <div className="flex flex-col items-center justify-center transition-transform duration-300 group-hover:scale-110">
          <div className="w-11 h-11 rounded-full bg-matcha-500/15 dark:bg-matcha-400/20 flex items-center justify-center text-matcha-600 dark:text-matcha-300 shadow-sm">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
              <path d="M6 6h10" />
              <path d="M6 10h10" />
            </svg>
          </div>
        </div>
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
