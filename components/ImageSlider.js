"use client"

/**
 * ImageSlider.js — Wabi-Sabi image carousel component (v3)
 * ──────────────────────────────────────────────────────────
 * Renders a series of images sourced from a Notion [slider] toggle block.
 *
 * v3 fix — interaction completely broken inside prose wrapper:
 *   - Root element changed from <figure> to <div> to escape Tailwind
 *     Typography's `.prose figure` pointer-events / margin resets.
 *   - Removed `select-none` from wrapper (was blocking interactions in
 *     some browsers when combined with prose styles).
 *   - All interactive descendants explicitly carry `pointer-events-auto`
 *     so they can never be silently disabled by an ancestor rule.
 *   - Lightbox rendered with React portal pattern (appended to body via
 *     useEffect) so it fully escapes overflow:hidden / z-index ancestors.
 *
 * Props:
 *   images — Array<{ url: string, caption: string }>
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export default function ImageSlider({ images = [] }) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [zoomed, setZoomed]             = useState(false)
  // Track whether we are mounted (needed for createPortal on SSR)
  const [mounted, setMounted]           = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // --- Navigation ---

  const prev = useCallback(() => {
    setCurrentIndex(i => (i === 0 ? images.length - 1 : i - 1))
  }, [images.length])

  const next = useCallback(() => {
    setCurrentIndex(i => (i === images.length - 1 ? 0 : i + 1))
  }, [images.length])

  // Keyboard: ←/→ navigate, Escape closes lightbox
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { setZoomed(false); return }
      if (e.key === 'ArrowLeft')  prev()
      if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next])

  // Lock body scroll while lightbox is open
  useEffect(() => {
    document.body.style.overflow = zoomed ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [zoomed])

  if (!images || images.length === 0) return null
  const current = images[currentIndex]

  // ── Lightbox (portal to <body>) ──────────────────────────────────────────
  // Rendered via createPortal so it escapes every overflow/z-index ancestor.
  const lightbox = zoomed && mounted && createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Zoomed image"
      // Fixed overlay covers full viewport, sits above everything (z-[9999])
      style={{ position: 'fixed', inset: 0, zIndex: 9999,
               background: 'rgba(0,0,0,0.88)', display: 'flex',
               alignItems: 'center', justifyContent: 'center',
               padding: '1.5rem', backdropFilter: 'blur(4px)',
               cursor: 'zoom-out', pointerEvents: 'auto' }}
      onClick={() => setZoomed(false)}
    >
      {/* Close button */}
      <button
        type="button"
        aria-label="Close zoom"
        onClick={() => setZoomed(false)}
        style={{ position: 'absolute', top: '1rem', right: '1rem',
                 width: '2.25rem', height: '2.25rem', borderRadius: '50%',
                 display: 'flex', alignItems: 'center', justifyContent: 'center',
                 background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)',
                 color: 'rgba(255,255,255,0.85)', cursor: 'pointer',
                 transition: 'background 0.2s', zIndex: 10,
                 pointerEvents: 'auto' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6"  x2="6"  y2="18" />
          <line x1="6"  y1="6"  x2="18" y2="18" />
        </svg>
      </button>

      {/* Full-resolution image — click stops propagation so it doesn't close */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={current.url}
        alt={current.caption || `Slide ${currentIndex + 1} of ${images.length}`}
        style={{ maxWidth: '90vw', maxHeight: '88vh', objectFit: 'contain',
                 borderRadius: '0.75rem', boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
                 cursor: 'default', pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()}
      />

      {/* Caption in lightbox */}
      {current.caption && (
        <p style={{ position: 'absolute', bottom: '1.25rem', left: '50%',
                    transform: 'translateX(-50%)', fontStyle: 'italic',
                    fontSize: '0.8rem', color: 'rgba(255,255,255,0.65)',
                    textAlign: 'center', maxWidth: '60ch', padding: '0 1rem',
                    pointerEvents: 'none' }}>
          {current.caption}
        </p>
      )}
    </div>,
    document.body
  )

  // ── Main slider ──────────────────────────────────────────────────────────
  return (
    <>
      {/*
        Root: <div> not <figure> — avoids Tailwind Typography's `.prose figure`
        resets (margin, pointer-events side effects).
        not-prose: prevents prose typography from cascading into slider children.
        pointer-events-auto: explicitly re-enables interaction (prose may have
        set a parent to pointer-events:none or similar).
      */}
      <div
        className="not-prose my-8 w-full pointer-events-auto"
        aria-label={`Image slider, ${images.length} image${images.length !== 1 ? 's' : ''}`}
        role="region"
      >

        {/* ── Image stage ────────────────────────────────────────────────── */}
        <div
          className="relative mx-auto overflow-hidden rounded-xl border border-rice-paper-400/60 dark:border-tea-slate-50/20 bg-rice-paper-200 dark:bg-tea-slate-300 shadow-zen-sm"
          style={{ maxWidth: '36rem' }} // ~576px — compact gallery width
        >

          {/* Grain texture overlay — pointer-events-none so it never blocks */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0, zIndex: 10,
              pointerEvents: 'none', borderRadius: 'inherit',
              opacity: 0.03,
              mixBlendMode: 'multiply',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
              backgroundSize: '200px 200px',
            }}
          />

          {/* Image crossfade stack.
              Inactive slides: pointer-events-none so they never intercept
              clicks meant for the navigation buttons behind them. */}
          <div style={{ position: 'relative', width: '100%', aspectRatio: '16/10' }}>
            {images.map((img, idx) => (
              <div
                key={idx}
                aria-hidden={idx !== currentIndex}
                style={{
                  position: 'absolute', inset: 0,
                  transition: 'opacity 0.5s ease-in-out',
                  opacity: idx === currentIndex ? 1 : 0,
                  // CRITICAL: inactive slides must not intercept pointer events
                  pointerEvents: idx === currentIndex ? 'auto' : 'none',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.caption || `Slide ${idx + 1} of ${images.length}`}
                  style={{ width: '100%', height: '100%', objectFit: 'cover',
                           cursor: 'zoom-in', display: 'block' }}
                  loading={idx === 0 ? 'eager' : 'lazy'}
                  decoding="async"
                  onClick={() => setZoomed(true)}
                  title="Click to enlarge"
                />
              </div>
            ))}
          </div>

          {/* ── Previous button ─────────────────────────────────────────────
               z-index 30 sits above image layers (z auto) and grain (z 10).
               All styles via inline style to fully bypass prose/Tailwind
               specificity issues. */}
          {images.length > 1 && (
            <button
              type="button"
              aria-label="Previous image"
              onClick={prev}
              style={{
                position: 'absolute', left: '0.5rem', top: '50%',
                transform: 'translateY(-50%)', zIndex: 30,
                width: '2rem', height: '2rem', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.55)',
                border: '1px solid rgba(255,255,255,0.7)',
                color: 'rgba(44,42,41,0.75)',
                backdropFilter: 'blur(4px)',
                cursor: 'pointer', pointerEvents: 'auto',
                transition: 'background 0.2s, color 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(122,139,105,0.25)'; e.currentTarget.style.color = '#4A6741' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.55)'; e.currentTarget.style.color = 'rgba(44,42,41,0.75)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}

          {/* ── Next button ──────────────────────────────────────────────── */}
          {images.length > 1 && (
            <button
              type="button"
              aria-label="Next image"
              onClick={next}
              style={{
                position: 'absolute', right: '0.5rem', top: '50%',
                transform: 'translateY(-50%)', zIndex: 30,
                width: '2rem', height: '2rem', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.55)',
                border: '1px solid rgba(255,255,255,0.7)',
                color: 'rgba(44,42,41,0.75)',
                backdropFilter: 'blur(4px)',
                cursor: 'pointer', pointerEvents: 'auto',
                transition: 'background 0.2s, color 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(122,139,105,0.25)'; e.currentTarget.style.color = '#4A6741' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.55)'; e.currentTarget.style.color = 'rgba(44,42,41,0.75)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}

          {/* ── Slide counter — top-left ──────────────────────────────────── */}
          {images.length > 1 && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute', top: '0.5rem', left: '0.5rem', zIndex: 30,
                fontSize: '0.6rem', fontFamily: 'monospace', tabularNums: true,
                color: 'rgba(255,255,255,0.75)',
                background: 'rgba(0,0,0,0.3)',
                backdropFilter: 'blur(4px)',
                padding: '0.15rem 0.4rem', borderRadius: '0.25rem',
                pointerEvents: 'none',
              }}
            >
              {currentIndex + 1} / {images.length}
            </div>
          )}

          {/* ── Zoom hint — bottom-right ─────────────────────────────────── */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', bottom: '0.5rem', right: '0.5rem', zIndex: 30,
              color: 'rgba(255,255,255,0.5)', pointerEvents: 'none',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11"  y1="8"  x2="11"   y2="14"   />
              <line x1="8"   y1="11" x2="14"   y2="11"   />
            </svg>
          </div>
        </div>

        {/* ── Caption ──────────────────────────────────────────────────────── */}
        <p
          style={{
            marginTop: '0.6rem', textAlign: 'center',
            fontStyle: 'italic', fontSize: '0.78rem',
            color: 'var(--ws-text-tertiary, #7A756E)',
            minHeight: '1.4em', lineHeight: 1.6,
            padding: '0 1rem',
            transition: 'opacity 0.3s',
            pointerEvents: 'none',
          }}
        >
          {current.caption || ''}
        </p>

        {/* ── Dot indicators ───────────────────────────────────────────────── */}
        {images.length > 1 && (
          <div
            role="tablist"
            aria-label="Slide indicators"
            style={{ marginTop: '0.6rem', display: 'flex',
                     alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
                     pointerEvents: 'auto' }}
          >
            {images.map((_, idx) => (
              <button
                key={idx}
                type="button"
                role="tab"
                aria-selected={idx === currentIndex}
                aria-label={`Go to slide ${idx + 1}`}
                onClick={() => setCurrentIndex(idx)}
                style={{
                  borderRadius: '9999px',
                  border: 'none', padding: 0,
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                  // Active: elongated emerald pill; inactive: round stone pebble
                  width:  idx === currentIndex ? '1rem' : '0.375rem',
                  height: '0.375rem',
                  background: idx === currentIndex
                    ? '#059669'              // emerald-600
                    : 'rgba(168,162,158,0.5)', // stone-400/50
                  transition: 'width 0.3s ease, background 0.3s ease',
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Portal lightbox — mounted outside the article DOM tree */}
      {lightbox}
    </>
  )
}
