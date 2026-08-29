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
 *
 * Fixes applied (v2):
 *   - Inactive image layers now have pointer-events-none so they do not
 *     block clicks on the navigation chevron buttons below them.
 *   - Slide counter moved to top-LEFT so it doesn't collide with the
 *     next-image button on the top-right.
 *   - Aspect ratio changed to 16/10 for a compact cinematic feel.
 *   - Click-to-zoom lightbox added: clicking the current image opens a
 *     full-screen overlay so users can inspect fine details.
 */

import { useState, useCallback, useEffect, useRef } from 'react'

export default function ImageSlider({ images = [] }) {
  // Index of the currently visible slide
  const [currentIndex, setCurrentIndex] = useState(0)

  // Controls the full-screen zoom lightbox
  const [zoomed, setZoomed] = useState(false)

  // --- Navigation helpers ---

  /**
   * Advance to the previous image, wrapping from first → last.
   */
  const prev = useCallback(() => {
    setCurrentIndex(i => (i === 0 ? images.length - 1 : i - 1))
  }, [images.length])

  /**
   * Advance to the next image, wrapping from last → first.
   */
  const next = useCallback(() => {
    setCurrentIndex(i => (i === images.length - 1 ? 0 : i + 1))
  }, [images.length])

  /**
   * Keyboard navigation:
   *   ← / → — previous / next slide
   *   Escape  — close zoom lightbox
   */
  useEffect(() => {
    function handleKey(e) {
      if (zoomed && e.key === 'Escape') { setZoomed(false); return }
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [prev, next, zoomed])

  // Lock body scroll while the lightbox is open
  useEffect(() => {
    document.body.style.overflow = zoomed ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [zoomed])

  // Guard: nothing to render when no valid images were passed
  if (!images || images.length === 0) return null

  const current = images[currentIndex]

  return (
    <>
      {/* ── Main slider figure ────────────────────────────────────────────── */}
      <figure
        className="not-prose my-8 w-full select-none"
        aria-label={`Image slider, ${images.length} image${images.length !== 1 ? 's' : ''}`}
        role="region"
      >
        {/* ── Image stage ─────────────────────────────────────────────────── */}
        {/*
          max-w-xl centres the slider on wider screens so it feels like a
          focused gallery rather than a full-bleed hero. mx-auto centres it.
        */}
        <div className="relative mx-auto max-w-xl overflow-hidden rounded-xl border border-rice-paper-400/60 dark:border-tea-slate-50/20 bg-rice-paper-200 dark:bg-tea-slate-300 shadow-zen-sm">

          {/* Wabi-sabi grain texture overlay.
              pointer-events-none ensures it never intercepts clicks. */}
          <div
            className="absolute inset-0 z-10 pointer-events-none rounded-xl opacity-[0.03] mix-blend-multiply dark:mix-blend-screen"
            aria-hidden="true"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
              backgroundSize: '200px 200px',
            }}
          />

          {/* Image crossfade stack.
              BUG FIX: inactive slides get pointer-events-none so they
              cannot intercept clicks destined for the chevron buttons. */}
          <div className="relative w-full aspect-[16/10]">
            {images.map((img, idx) => (
              <div
                key={idx}
                className={[
                  'absolute inset-0 transition-opacity duration-500 ease-in-out',
                  idx === currentIndex
                    ? 'opacity-100 pointer-events-auto'    // active: receives clicks
                    : 'opacity-0 pointer-events-none',     // inactive: fully inert
                ].join(' ')}
                aria-hidden={idx !== currentIndex}
              >
                {/* Click the image itself to open the zoom lightbox */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.caption || `Slide ${idx + 1} of ${images.length}`}
                  className="w-full h-full object-cover cursor-zoom-in"
                  loading={idx === 0 ? 'eager' : 'lazy'}
                  decoding="async"
                  onClick={() => setZoomed(true)}
                  title="Click to enlarge"
                />
              </div>
            ))}
          </div>

          {/* ── Previous chevron button ──────────────────────────────────────
               Ghost style — barely visible at rest, matcha wash on hover.
               z-30 ensures it sits above the image layers (z-0 for images,
               z-10 for the grain overlay). */}
          {images.length > 1 && (
            <button
              type="button"
              onClick={prev}
              aria-label="Previous image"
              className="absolute left-2 top-1/2 -translate-y-1/2 z-30 w-8 h-8 rounded-full flex items-center justify-center bg-white/50 dark:bg-black/30 border border-white/60 dark:border-white/10 text-neutral-600 dark:text-neutral-300 backdrop-blur-sm hover:bg-matcha-50/80 dark:hover:bg-matcha-900/50 hover:border-matcha-300/60 hover:text-matcha-700 dark:hover:text-matcha-300 transition-all duration-250 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-matcha-400/60"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}

          {/* ── Next chevron button ──────────────────────────────────────────
               Mirror of the previous button on the right edge. */}
          {images.length > 1 && (
            <button
              type="button"
              onClick={next}
              aria-label="Next image"
              className="absolute right-2 top-1/2 -translate-y-1/2 z-30 w-8 h-8 rounded-full flex items-center justify-center bg-white/50 dark:bg-black/30 border border-white/60 dark:border-white/10 text-neutral-600 dark:text-neutral-300 backdrop-blur-sm hover:bg-matcha-50/80 dark:hover:bg-matcha-900/50 hover:border-matcha-300/60 hover:text-matcha-700 dark:hover:text-matcha-300 transition-all duration-250 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-matcha-400/60"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}

          {/* ── Slide counter — top-LEFT ─────────────────────────────────────
               Moved from top-right so it doesn't overlap the next button.
               Monospaced numerals, very faint — a quiet position marker. */}
          {images.length > 1 && (
            <div
              className="absolute top-2 left-2 z-30 text-[0.6rem] font-mono tabular-nums text-white/70 dark:text-white/50 bg-black/25 dark:bg-black/40 backdrop-blur-sm px-1.5 py-0.5 rounded"
              aria-hidden="true"
            >
              {currentIndex + 1} / {images.length}
            </div>
          )}

          {/* ── Zoom hint icon — bottom-right corner ────────────────────────
               Tiny magnifier icon signals that the image is clickable. */}
          <div
            className="absolute bottom-2 right-2 z-30 pointer-events-none text-white/50 dark:text-white/35"
            aria-hidden="true"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </div>
        </div>

        {/* ── Caption ───────────────────────────────────────────────────────
             min-h prevents layout shift when toggling between captioned and
             uncaptioned slides. Italic serif text, centred, understated. */}
        <figcaption className="mt-2.5 mx-auto max-w-xl min-h-[1.4em] text-center font-serif italic text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed px-4 transition-opacity duration-300">
          {current.caption || ''}
        </figcaption>

        {/* ── Dot indicators ──────────────────────────────────────────────── */}
        {images.length > 1 && (
          <div
            className="mt-2.5 flex items-center justify-center gap-1.5"
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
                  // Active dot: elongated emerald pill (ServiceNow-inspired green)
                  // Inactive: round muted-stone pebble
                  'rounded-full transition-all duration-300 ease-out',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-matcha-400/60',
                  idx === currentIndex
                    ? 'w-4 h-1.5 bg-emerald-600 dark:bg-emerald-500'
                    : 'w-1.5 h-1.5 bg-stone-300 dark:bg-stone-600 hover:bg-stone-400 dark:hover:bg-stone-500',
                ].join(' ')}
              />
            ))}
          </div>
        )}
      </figure>

      {/* ── Full-screen zoom lightbox ──────────────────────────────────────── */}
      {/*
        Rendered as a portal-like overlay outside the <figure> so it can
        escape any overflow:hidden ancestors and cover the full viewport.
        Click anywhere (image or backdrop) to dismiss.
      */}
      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Zoomed image"
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-sm cursor-zoom-out p-4"
          onClick={() => setZoomed(false)}
        >
          {/* Close button — top-right corner */}
          <button
            type="button"
            aria-label="Close zoom"
            className="absolute top-4 right-4 z-10 w-9 h-9 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 border border-white/20 text-white/80 hover:text-white transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            onClick={() => setZoomed(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          {/* Zoomed image — max 90vw × 90vh, natural proportions */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.url}
            alt={current.caption || `Slide ${currentIndex + 1} of ${images.length}`}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl cursor-default"
            onClick={e => e.stopPropagation()} // prevent backdrop click from closing when clicking the image
          />

          {/* Caption inside lightbox */}
          {current.caption && (
            <p className="absolute bottom-6 left-1/2 -translate-x-1/2 text-center font-serif italic text-sm text-white/70 max-w-[70ch] px-4">
              {current.caption}
            </p>
          )}
        </div>
      )}
    </>
  )
}
