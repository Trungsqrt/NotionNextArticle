'use client'

/**
 * ReadingProgress.js
 * ──────────────────
 * • A slim wabi-sabi progress bar pinned immediately below the fixed navbar
 *   (top-14 = 3.5rem, matching Layout's pt-14).
 * • A "back to top" button in the same aesthetic that fades in after 300 px of scroll.
 */

import { useEffect, useState } from 'react'

function LeafUpIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  )
}

export default function ReadingProgress() {
  const [progress, setProgress] = useState(0)
  const [showTop,  setShowTop]  = useState(false)
  const [visible,  setVisible]  = useState(false)

  useEffect(() => {
    function onScroll() {
      const scrollTop = window.scrollY
      const docHeight = document.documentElement.scrollHeight - window.innerHeight
      const pct       = docHeight > 0 ? Math.min(100, (scrollTop / docHeight) * 100) : 0
      setProgress(pct)
      setShowTop(scrollTop > 300)
    }

    onScroll()
    setVisible(true)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <>
      {/* ── Reading progress bar ─────────────────────────────────────────── */}
      <div
        role="progressbar"
        aria-label="Reading progress"
        aria-valuenow={Math.round(progress)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ opacity: visible ? 1 : 0, transition: 'opacity 0.4s ease' }}
        className="fixed top-14 left-0 right-0 z-40 h-[3px] bg-rice-paper-300/60 dark:bg-tea-slate-100/20"
      >
        {/* Matcha gradient fill */}
        <div
          style={{ width: `${progress}%`, transition: 'width 0.1s linear' }}
          className="h-full bg-gradient-to-r from-matcha-400 via-matcha-500 to-matcha-600 dark:from-matcha-500 dark:via-matcha-400 dark:to-matcha-300 rounded-r-full shadow-[0_0_6px_0_rgba(122,139,105,0.5)]"
        />
      </div>

      {/* ── Back-to-top button ───────────────────────────────────────────── */}
      <button
        id="back-to-top"
        type="button"
        onClick={scrollToTop}
        aria-label="Scroll back to top"
        style={{
          opacity:       showTop ? 1 : 0,
          transform:     showTop ? 'translateY(0) scale(1)' : 'translateY(12px) scale(0.88)',
          pointerEvents: showTop ? 'auto' : 'none',
          transition:    'opacity 0.3s ease, transform 0.3s ease',
        }}
        className={[
          'fixed bottom-8 right-5 z-50',
          'flex items-center justify-center',
          'w-10 h-10 rounded-full',
          'bg-rice-paper-100/90 dark:bg-tea-slate-200/90',
          'border border-rice-paper-400/70 dark:border-tea-slate-50/50',
          'shadow-zen backdrop-blur-sm',
          'text-matcha-600 dark:text-matcha-400',
          'hover:bg-matcha-50 dark:hover:bg-matcha-900/30',
          'hover:border-matcha-300 dark:hover:border-matcha-600',
          'hover:shadow-matcha',
          'active:scale-90',
          'transition-colors duration-200',
          'group',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          style={{
            background: 'radial-gradient(circle at 40% 35%, rgba(122,139,105,0.13) 0%, transparent 70%)',
          }}
        />
        <LeafUpIcon />
      </button>
    </>
  )
}
