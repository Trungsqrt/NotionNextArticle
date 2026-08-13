"use client"

/**
 * NotionCodeBlock.js — Interactive Code Block with Prism Gruvbox & Copy Button
 * ──────────────────────────────────────────────────────────────────────────
 * Render code with SyntaxHighlighter (Prism), gruvboxLight/gruvboxDark theme,
 * copy-to-clipboard button, and wrap/unwrap toggle.
 *
 * Props:
 *   codeText  — The raw code text string
 *   language  — Language identifier (e.g., "javascript", "python", "css")
 *   caption   — Optional caption HTML string
 */

import { useState, useEffect } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { gruvboxLight, gruvboxDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'

export default function NotionCodeBlock({ codeText, language, caption }) {
  const [isWrapped, setIsWrapped] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [isDark, setIsDark] = useState(false)

  // Sync dark mode class on <html> element
  useEffect(() => {
    const checkDark = () => {
      setIsDark(document.documentElement.classList.contains('dark'))
    }
    checkDark()
    const observer = new MutationObserver(checkDark)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const handleCopy = async () => {
    if (!codeText) return
    try {
      await navigator.clipboard.writeText(codeText)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code text:', err)
    }
  }

  const langLabel = (language || 'plain text').toUpperCase()
  const normalizedLang = language ? language.toLowerCase() : 'text'

  return (
    <div className="not-prose my-6 group/code">
      {/* Top Bar Header */}
      <div className="flex items-center justify-between px-4 py-2 rounded-t-xl border border-neutral-200/80 dark:border-neutral-800 bg-neutral-100/90 dark:bg-neutral-800/80">
        {/* Language Badge */}
        <span className="text-[0.7rem] font-mono font-semibold text-neutral-600 dark:text-neutral-400 tracking-wider select-none">
          {langLabel}
        </span>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* Copy Button */}
          <button
            type="button"
            onClick={handleCopy}
            className={[
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.72rem] font-medium transition-all duration-200 border',
              isCopied
                ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700'
                : 'bg-white/80 dark:bg-neutral-700/50 text-neutral-600 dark:text-neutral-300 border-neutral-300/80 dark:border-neutral-700 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/80',
            ].join(' ')}
            aria-label={isCopied ? 'Code copied to clipboard' : 'Copy code to clipboard'}
          >
            {isCopied ? (
              <>
                <svg
                  width="13" height="13" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Copied!</span>
              </>
            ) : (
              <>
                <svg
                  width="13" height="13" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>

          {/* Wrap / Unwrap Button */}
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
            <svg
              width="13" height="13" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6h18" />
              <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
              <polyline points="13 16 11 18 13 20" />
              <path d="M3 18h4" />
            </svg>
            <span>{isWrapped ? 'Unwrap' : 'Wrap'}</span>
          </button>
        </div>
      </div>

      {/* Code Block Container */}
      <div className="rounded-b-xl border border-t-0 border-neutral-200/80 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-4 text-sm leading-relaxed overflow-x-auto shadow-sm">
        <SyntaxHighlighter
          language={normalizedLang}
          style={isDark ? gruvboxDark : gruvboxLight}
          PreTag="div"
          wrapLongLines={isWrapped}
          customStyle={{
            backgroundColor: 'transparent',
            padding: 0,
            margin: 0,
            fontSize: '0.875rem',
            lineHeight: '1.6',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          }}
        >
          {codeText || ''}
        </SyntaxHighlighter>
      </div>

      {/* Optional Caption */}
      {caption && (
        <div
          className="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500 italic"
          dangerouslySetInnerHTML={{ __html: caption }}
        />
      )}
    </div>
  )
}
