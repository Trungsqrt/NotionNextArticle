"use client"

/**
 * NotionCodeBlock.js — Interactive Code Block with One Light / One Dark theme
 * ────────────────────────────────────────────────────────────────────────────
 * Uses react-syntax-highlighter (Prism) with oneLight / oneDark themes.
 * All default backgrounds, borders, and paddings from the theme are stripped
 * via customStyle and a scoped <style> injection — the outer Tailwind wrapper
 * owns all visual chrome.
 *
 * If language === 'mermaid', the block is rendered as an SVG diagram using
 * the mermaid npm package (v11 async API).
 *
 * Props:
 *   codeText  — The raw code text string
 *   language  — Language identifier (e.g., "javascript", "python", "mermaid")
 *   caption   — Optional caption HTML string
 */

import { useState, useEffect, useRef, useId } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

// ── Mermaid diagram renderer ───────────────────────────────────────────────
function MermaidChart({ code }) {
  const containerRef = useRef(null)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState(null)
  const chartId = useId().replace(/:/g, '_')

  useEffect(() => {
    if (!code) return
    let cancelled = false

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'neutral',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        })
        const { svg: renderedSvg } = await mermaid.render(`mermaid-${chartId}`, code)
        if (!cancelled) setSvg(renderedSvg)
      } catch (err) {
        if (!cancelled) setError(String(err?.message || err))
      }
    }

    render()
    return () => { cancelled = true }
  // Re-render if code or theme changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, chartId])

  if (error) {
    return (
      <div className="my-8 p-4 rounded-xl border border-red-200/80 dark:border-red-800/60 bg-red-50/80 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm font-mono">
        <span className="font-semibold">Mermaid error: </span>{error}
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-8 flex items-center justify-center py-12 text-neutral-400 dark:text-neutral-600">
        <svg className="animate-spin mr-2" width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span className="text-sm">Rendering diagram…</span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="my-8 flex justify-center items-center p-6 rounded-xl border border-neutral-200/60 dark:border-neutral-700/60 bg-white dark:bg-neutral-900/40 overflow-x-auto shadow-sm"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export default function NotionCodeBlock({ codeText, language, caption }) {
  const [isWrapped, setIsWrapped] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [isDark, setIsDark] = useState(false)

  // Sync with <html class="dark">
  useEffect(() => {
    const checkDark = () =>
      setIsDark(document.documentElement.classList.contains('dark'))
    checkDark()
    const observer = new MutationObserver(checkDark)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])

  const handleCopy = async () => {
    if (!codeText) return
    try {
      await navigator.clipboard.writeText(codeText)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }

  const langLabel = (language || 'plain text').toUpperCase()
  const normalizedLang = (language || 'text').toLowerCase()

  // ── Mermaid: render as diagram ────────────────────────────────────────────
  if (normalizedLang === 'mermaid') {
    return (
      <div className="not-prose my-6">
        <MermaidChart code={codeText || ''} />
        {caption && (
          <div
            className="mt-1 text-center text-xs text-neutral-400 dark:text-neutral-500 italic"
            dangerouslySetInnerHTML={{ __html: caption }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="not-prose my-6 group/code relative rounded-xl border border-neutral-200/80 dark:border-neutral-800/80 bg-neutral-50 dark:bg-[#1d2021] overflow-hidden shadow-sm">

      {/* Nuke every span background injected by the theme — scoped to this block */}
      <style>{`.notion-code-block span { background-color: transparent !important; }`}</style>

      {/* ── Header bar ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-200/80 dark:border-neutral-800/80 bg-neutral-100/90 dark:bg-neutral-800/60">

        {/* Language badge */}
        <span className="text-[0.7rem] font-mono font-semibold text-neutral-500 dark:text-neutral-400 tracking-wider select-none uppercase">
          {langLabel}
        </span>

        {/* Action buttons */}
        <div className="flex items-center gap-2">

          {/* Copy button */}
          <button
            type="button"
            onClick={handleCopy}
            className={[
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.72rem] font-medium transition-all duration-200 border',
              isCopied
                ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700'
                : 'bg-white/80 dark:bg-neutral-700/50 text-neutral-600 dark:text-neutral-300 border-neutral-300/80 dark:border-neutral-700 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/80',
            ].join(' ')}
            aria-label={isCopied ? 'Code copied' : 'Copy code'}
          >
            {isCopied ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Copied!</span>
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>

          {/* Wrap / Unwrap button */}
          <button
            type="button"
            onClick={() => setIsWrapped(prev => !prev)}
            className={[
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.72rem] font-medium transition-all duration-200 border',
              isWrapped
                ? 'bg-matcha-100/80 dark:bg-matcha-700/30 text-matcha-600 dark:text-matcha-300 border-matcha-300/60 dark:border-matcha-700/50'
                : 'bg-white/80 dark:bg-neutral-700/50 text-neutral-600 dark:text-neutral-300 border-neutral-300/80 dark:border-neutral-700 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/80',
            ].join(' ')}
            aria-label={isWrapped ? 'Disable word wrap' : 'Enable word wrap'}
            title={isWrapped ? 'Unwrap long lines' : 'Wrap long lines'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
              <polyline points="13 16 11 18 13 20" />
              <path d="M3 18h4" />
            </svg>
            <span>{isWrapped ? 'Unwrap' : 'Wrap'}</span>
          </button>

        </div>
      </div>

      {/* ── Code body ──────────────────────────────────────────────── */}
      <div className="p-4 notion-code-block text-sm font-mono leading-relaxed overflow-x-auto">
        <SyntaxHighlighter
          language={normalizedLang}
          style={isDark ? oneDark : oneLight}
          PreTag="div"
          wrapLines={true}
          wrapLongLines={isWrapped}
          customStyle={{
            backgroundColor: 'transparent',
            background:      'none',
            border:          'none',
            boxShadow:       'none',
            padding:         0,
            margin:          0,
            fontSize:        'inherit',
            lineHeight:      'inherit',
            fontFamily:      'inherit',
          }}
          codeTagProps={{
            style: {
              backgroundColor: 'transparent',
              background:      'none',
              fontFamily:      'inherit',
              fontSize:        'inherit',
            },
          }}
        >
          {codeText || ''}
        </SyntaxHighlighter>
      </div>

      {/* ── Optional caption ───────────────────────────────────────── */}
      {caption && (
        <div
          className="px-4 pb-3 text-center text-xs text-neutral-400 dark:text-neutral-500 italic"
          dangerouslySetInnerHTML={{ __html: caption }}
        />
      )}

    </div>
  )
}
