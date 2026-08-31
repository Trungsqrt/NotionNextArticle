"use client"

/**
 * NotionCodeBlock.js — Interactive Code Block with Independent Light / Dark theme toggle
 * ──────────────────────────────────────────────────────────────────────────────────────
 * Uses react-syntax-highlighter (Prism) with oneLight / oneDark themes.
 * Supports independent light / dark toggling separate from the main page theme,
 * line wrapping toggle, and one-click copy to clipboard.
 *
 * If language === 'mermaid', the block is rendered as an SVG diagram using
 * the mermaid npm package (v11 async API).
 */

import { useState, useEffect, useRef, useId, useCallback } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import MermaidDiagram from './MermaidDiagram'

export default function NotionCodeBlock({ codeText, language, caption }) {
  const [isWrapped, setIsWrapped] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [contentHeight, setContentHeight] = useState(300)
  const contentRef = useRef(null)
  
  const lineCount = (codeText || '').split('\n').length
  const isLong = lineCount > 10

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight)
    }
  }, [codeText, isWrapped, isExpanded])
  
  // Independent theme state: null = follow site theme, 'dark' | 'light' = user manual choice for this block
  const [localTheme, setLocalTheme] = useState(null)
  const [globalDark, setGlobalDark] = useState(false)

  // Sync with main site <html class="dark">
  useEffect(() => {
    const checkDark = () =>
      setGlobalDark(document.documentElement.classList.contains('dark'))
    checkDark()
    const observer = new MutationObserver(checkDark)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])

  // Effective theme for this code block
  const isDark = localTheme !== null ? localTheme === 'dark' : globalDark

  const toggleTheme = useCallback(() => {
    setLocalTheme(isDark ? 'light' : 'dark')
  }, [isDark])

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
        <MermaidDiagram code={codeText || ''} isDark={isDark} />
        {caption && (
          <div
            className="mt-1 text-center text-xs text-neutral-400 dark:text-neutral-500 italic"
            dangerouslySetInnerHTML={{ __html: caption }}
          />
        )}
      </div>
    )
  }

  const buttonBase = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.72rem] font-medium transition-all duration-200 border select-none'

  return (
    <div 
      className={`not-prose my-6 group/code relative rounded-xl border overflow-hidden shadow-sm transition-colors duration-200 ${
        isDark
          ? 'bg-[#1d2021] border-neutral-800 text-neutral-200'
          : 'bg-[#fafafa] border-neutral-200 text-neutral-800'
      }`}
    >
      {/* Nuke every span background injected by the theme — scoped to this block */}
      <style>{`.notion-code-block span { background-color: transparent !important; }`}</style>

      {/* ── Header bar ─────────────────────────────────────────────── */}
      <div 
        className={`flex items-center justify-between px-4 py-2 border-b transition-colors duration-200 select-none ${
          isDark
            ? 'bg-[#282828] border-neutral-800 text-neutral-300'
            : 'bg-[#f4f4f5] border-neutral-200 text-neutral-600'
        }`}
      >
        {/* Language badge */}
        <span 
          className={`text-[0.7rem] font-mono font-semibold tracking-wider select-none uppercase ${
            isDark ? 'text-neutral-400' : 'text-neutral-500'
          }`}
        >
          {langLabel}
        </span>

        {/* Action buttons */}
        <div className="flex items-center gap-2">

          {/* Independent Theme Toggle button */}
          <button
            type="button"
            onClick={toggleTheme}
            className={`${buttonBase} ${
              isDark
                ? 'bg-neutral-700/60 text-neutral-300 border-neutral-600/70 hover:bg-neutral-600/70 hover:text-white'
                : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-100 hover:text-neutral-900 shadow-2xs'
            }`}
            aria-label={isDark ? 'Switch code to light theme' : 'Switch code to dark theme'}
            title={isDark ? 'Switch code to light theme' : 'Switch code to dark theme'}
          >
            {isDark ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
                <span>Light</span>
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
                <span>Dark</span>
              </>
            )}
          </button>

          {/* Copy button */}
          <button
            type="button"
            onClick={handleCopy}
            className={`${buttonBase} ${
              isCopied
                ? isDark
                  ? 'bg-green-900/50 text-green-300 border-green-700'
                  : 'bg-green-100 text-green-700 border-green-300'
                : isDark
                  ? 'bg-neutral-700/60 text-neutral-300 border-neutral-600/70 hover:bg-neutral-600/70 hover:text-white'
                  : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-100 hover:text-neutral-900 shadow-2xs'
            }`}
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
            className={`${buttonBase} ${
              isWrapped
                ? isDark
                  ? 'bg-matcha-700/40 text-matcha-300 border-matcha-600/60'
                  : 'bg-matcha-100 text-matcha-700 border-matcha-300'
                : isDark
                  ? 'bg-neutral-700/60 text-neutral-300 border-neutral-600/70 hover:bg-neutral-600/70 hover:text-white'
                  : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-100 hover:text-neutral-900 shadow-2xs'
            }`}
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
      <div 
        ref={contentRef}
        className="relative overflow-hidden transition-[max-height] duration-700 ease-in-out"
        style={{ maxHeight: isLong && !isExpanded ? 300 : (contentHeight > 300 ? contentHeight : 5000) }}
      >
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

        {/* ── Expand Overlay (Fades out smoothly) ───────────────────── */}
        {isLong && (
          <div className={`absolute bottom-0 left-0 w-full h-32 flex items-end justify-center pb-4 bg-gradient-to-t transition-opacity duration-700 ease-in-out ${
            isExpanded ? 'opacity-0 pointer-events-none' : 'opacity-100'
          } ${
            isDark 
              ? 'from-[#1d2021]/95 via-[#1d2021]/60 to-transparent' 
              : 'from-[#fafafa]/95 via-[#fafafa]/60 to-transparent'
          }`}>
            <button
              type="button"
              onClick={() => setIsExpanded(true)}
              className={`group flex items-center gap-2 px-5 py-2 rounded-full text-xs font-serif italic tracking-wider transition-all duration-300 ease-out backdrop-blur-sm hover:-translate-y-0.5 hover:shadow-sm ${
                isDark
                  ? 'text-neutral-400 hover:text-matcha-300 bg-[#282828]/50 border border-neutral-700/50 hover:border-matcha-700/50 hover:bg-[#282828]/80'
                  : 'text-neutral-500 hover:text-matcha-700 bg-white/50 border border-neutral-200/60 hover:border-matcha-300/60 hover:bg-white/80'
              }`}
            >
              <span>Expand code</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-300 group-hover:translate-y-0.5 opacity-70">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* ── Optional caption ───────────────────────────────────────── */}
      {caption && (
        <div
          className={`px-4 pb-3 text-center text-xs italic ${
            isDark ? 'text-neutral-400' : 'text-neutral-500'
          }`}
          dangerouslySetInnerHTML={{ __html: caption }}
        />
      )}

    </div>
  )
}
