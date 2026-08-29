"use client"

/**
 * ImageSlider.js — Wabi-Sabi image carousel component
 * ─────────────────────────────────────────────────────
 * Renders a series of images sourced from a Notion [slider] toggle block.
 * Designed with a "wabi-sabi" aesthetic: muted palette, imperfect grain
 * texture, minimal chrome, and slow crossfade transitions.
 *
 * Props:
 *   images — Array<{ url: string, caption: string }>
 */

import { useState, useCallback, useEffect } from 'react'
import Image from 'next/image'

export default function ImageSlider({ images = [] }) {
  // Track which image is currently displayed
  const [currentIndex, setCurrentIndex] = useState(0)

  // --- Navigation helpers ---

  /**
   * Move to the previous image, wrapping around to the last if at the start.
   */
  const prev = useCallback(() => {
    setCurrentIndex(i => (i === 0 ? images.length - 1 : i - 1))
  }, [images.length])

  /**
   * Move to the next image, wrapping around to the first if at the end.
   */
  const next = useCallback(() => {
    setCurrentIndex(i => (i === images.length - 1 ? 0 : i + 1))
  }, [images.length])

  /**
   * Keyboard navigation: arrow-left = prev, arrow-right = next.
   * Attached globally while the component is mounted.
   */
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [prev, next])

  // Guard: nothing to render if no valid images were passed
  if (!images || images.length === 0) return null

  const current = images[currentIndex]

  return (
    /**
     * Outer wrapper — rice-paper background with a soft, irregular border.
     * "not-prose" prevents Tailwind typography plugin from overriding styles.
     */
    <figure
      className="not-prose my-10 w-full select-none"
      aria-label={`Image slider, ${images.length} images`}
      role="region"
    >
      {/* ── Image stage ──────────────────────────────────────────────────── */}
      <div className="relative w-full overflow-hidden rounded-2xl border border-rice-paper-400/60 dark:border-tea-slate-50/20 bg-rice-paper-200 dark:bg-tea-slate-300 shadow-zen">

        {/* Wabi-sabi grain texture overlay — subtle SVG noise filter adds an
            organic, aged-paper feel without any external image asset. */}
        <div
          className="absolute inset-0 z-10 pointer-events-none rounded-2xl opacity-[0.035] mix-blend-multiply dark:mix-blend-screen"
          aria-hidden="true"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
            backgroundSize: '200px 200px',
          }}
        />

        {/* Image cross-fade stack — each image is absolutely positioned;
            opacity switches between 0 and 1 for a gentle crossfade effect. */}
        <div className="relative w-full aspect-[4/3]">
          {images.map((img, idx) => (
            <div
              key={idx}
              className={`absolute inset-0 transition-opacity duration-500 ease-in-out ${
                idx === currentIndex ? 'opacity-100' : 'opacity-0'
              }`}
              aria-hidden={idx !== currentIndex}
            >
              {/* Use a regular <img> tag to avoid Next.js Image config
                  requirements for unknown external Notion S3 domains. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.caption || `Slide ${idx + 1} of ${images.length}`}
                className="w-full h-full object-cover"
                loading={idx === 0 ? 'eager' : 'lazy'}
                decoding="async"
              />
            </div>
          ))}
        </div>

        {/* ── Previous button ─────────────────────────────────────────────
             Only shown when there are multiple images. Ghost style: no fill,
             thin border that barely whispers its presence. Hover reveals a
             soft matcha wash — the only color signal. */}
        {images.length > 1 && (
          <button
            type="button"
            onClick={prev}
            aria-label="Previous image"
            className={[
              'absolute left-3 top-1/2 -translate-y-1/2 z-20',
              'w-9 h-9 rounded-full',
              'flex items-center justify-center',
              // Ghost appearance — barely visible in idle state
              'bg-rice-paper-100/40 dark:bg-tea-slate-300/40',
              'border border-rice-paper-400/40 dark:border-tea-slate-50/20',
              'text-ink-500/60 dark:text-sage-300/60',
              'backdrop-blur-sm',
              // Hover: matcha tint appears, opacity lifts
              'hover:bg-matcha-50/70 dark:hover:bg-matcha-900/40',
              'hover:border-matcha-300/60 dark:hover:border-matcha-700/50',
              'hover:text-matcha-700 dark:hover:text-matcha-300',
              'transition-all duration-300 ease-out',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-matcha-400/60',
            ].join(' ')}
          >
            {/* Left chevron SVG — thin stroke, no fill, wabi-minimalist */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}

        {/* ── Next button ─────────────────────────────────────────────────
             Mirror of the previous button, positioned on the right edge. */}
        {images.length > 1 && (
          <button
            type="button"
            onClick={next}
            aria-label="Next image"
            className={[
              'absolute right-3 top-1/2 -translate-y-1/2 z-20',
              'w-9 h-9 rounded-full',
              'flex items-center justify-center',
              'bg-rice-paper-100/40 dark:bg-tea-slate-300/40',
              'border border-rice-paper-400/40 dark:border-tea-slate-50/20',
              'text-ink-500/60 dark:text-sage-300/60',
              'backdrop-blur-sm',
              'hover:bg-matcha-50/70 dark:hover:bg-matcha-900/40',
              'hover:border-matcha-300/60 dark:hover:border-matcha-700/50',
              'hover:text-matcha-700 dark:hover:text-matcha-300',
              'transition-all duration-300 ease-out',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-matcha-400/60',
            ].join(' ')}
          >
            {/* Right chevron SVG */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}

        {/* ── Slide counter — top-right corner ────────────────────────────
             Monospaced numerals, very faint — a quiet acknowledgement of
             position. Wabi-sabi: information without decoration. */}
        {images.length > 1 && (
          <div
            className="absolute top-3 right-3 z-20 text-[0.65rem] font-mono tabular-nums text-sage-300/70 dark:text-sage-400/60 bg-tea-slate-300/50 dark:bg-tea-slate-200/60 backdrop-blur-sm px-1.5 py-0.5 rounded-md"
            aria-hidden="true"
          >
            {currentIndex + 1} / {images.length}
          </div>
        )}
      </div>

      {/* ── Caption ──────────────────────────────────────────────────────── */}
      {/* min-h prevents layout shift when switching between captioned and
          uncaptioned images. Italic serif text keeps it understated. */}
      <figcaption className="mt-3 min-h-[1.5em] text-center font-serif italic text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed px-4 transition-opacity duration-300">
        {current.caption || ''}
      </figcaption>

      {/* ── Dot indicators ──────────────────────────────────────────────── */}
      {/* Rendered below the caption so they feel like a page-count rather
          than a navigation control — subtle, subordinate. */}
      {images.length > 1 && (
        <div
          className="mt-3 flex items-center justify-center gap-1.5"
          role="tablist"
          aria-label="Slide indicators"
        >
          {images.map((_, idx) => (
            <button
              key={idx}
              type="button"
              role="tab"
              aria-selected={idx === currentIndex}
              aria-label={`Go to slide ${idx + 1}`}
              onClick={() => setCurrentIndex(idx)}
              className={[
                // Active dot: matcha/emerald green — ServiceNow-inspired, subdued
                // Inactive: muted paper-slate pebble
                'rounded-full transition-all duration-300 ease-out',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-matcha-400/60',
                idx === currentIndex
                  ? 'w-4 h-1.5 bg-emerald-600 dark:bg-emerald-500'  // pill-shape for active
                  : 'w-1.5 h-1.5 bg-stone-300 dark:bg-stone-600 hover:bg-stone-400 dark:hover:bg-stone-500',
              ].join(' ')}
            />
          ))}
        </div>
      )}
    </figure>
  )
}
