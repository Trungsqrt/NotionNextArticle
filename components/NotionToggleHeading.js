"use client"

import { useState } from 'react'
import NotionContent from './NotionContent'

/**
 * Heading level configuration matching existing static heading typography in lib/notion.js
 */
const HEADING_CONFIG = {
  1: {
    tag: 'h1',
    typography: 'text-2xl sm:text-3xl font-semibold text-neutral-800 dark:text-neutral-100 tracking-tight',
    margins: 'mt-12 mb-4',
    chevronSize: 22,
    chevronOffset: 'mt-1 sm:mt-1.5',
  },
  2: {
    tag: 'h2',
    typography: 'text-xl sm:text-2xl font-medium text-neutral-800 dark:text-neutral-100',
    margins: 'mt-10 mb-3',
    chevronSize: 20,
    chevronOffset: 'mt-1',
  },
  3: {
    tag: 'h3',
    typography: 'text-lg sm:text-xl font-medium text-neutral-700 dark:text-neutral-200',
    margins: 'mt-8 mb-2.5',
    chevronSize: 18,
    chevronOffset: 'mt-0.5',
  },
  4: {
    tag: 'h4',
    typography: 'text-base sm:text-lg font-medium text-neutral-700 dark:text-neutral-200',
    margins: 'mt-4 mb-2',
    chevronSize: 16,
    chevronOffset: 'mt-0.5',
  },
}

export default function NotionToggleHeading({
  blockId,
  level = 1,
  titleHtml,
  anchorId,
  color,
  colorClass = '',
  hasChildren,
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [childrenHtml, setChildrenHtml] = useState('')
  const [error, setError] = useState(false)

  const config = HEADING_CONFIG[level] || HEADING_CONFIG[1]
  const Tag = config.tag

  const handleToggleClick = async (e) => {
    // If user clicked an inline link inside the heading text, follow link without toggling
    if (e?.target && typeof e.target.closest === 'function' && e.target.closest('a')) {
      return
    }

    const nextState = !isOpen
    setIsOpen(nextState)

    // Lazy load nested content only upon expansion, and cache within component state
    if (nextState && hasChildren && !childrenHtml && !isLoading) {
      setIsLoading(true)
      setError(false)
      try {
        const res = await fetch(`/api/notion/children?blockId=${blockId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (data.html) {
          setChildrenHtml(data.html)
        } else if (data.html === '') {
          setChildrenHtml('<div class="italic opacity-50 text-xs py-1">Empty toggle heading</div>')
        } else {
          setError(true)
        }
      } catch (err) {
        console.error('Failed to load toggle heading children:', err)
        setError(true)
      } finally {
        setIsLoading(false)
      }
    }
  }

  const contentId = `toggle-heading-content-${anchorId || blockId}`

  return (
    <div className="notion-toggle-heading">
      <Tag
        id={anchorId}
        className={`${config.margins} ${config.typography} ${colorClass} scroll-mt-24`}
      >
        <button
          type="button"
          onClick={handleToggleClick}
          aria-expanded={isOpen}
          aria-controls={contentId}
          className="group/btn w-full text-left flex items-start gap-2.5 cursor-pointer select-none focus:outline-none rounded-md transition-colors duration-150 group-hover/btn:text-matcha-600 dark:group-hover/btn:text-matcha-400"
        >
          <svg
            width={config.chevronSize}
            height={config.chevronSize}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-matcha-600 dark:text-matcha-400 transition-transform duration-300 ease-out shrink-0 ${config.chevronOffset} ${
              isOpen ? 'rotate-90' : 'rotate-0'
            }`}
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span
            className="flex-1 min-w-0 leading-snug"
            dangerouslySetInnerHTML={{ __html: titleHtml || `Heading ${level}` }}
          />
        </button>
      </Tag>

      <div
        id={contentId}
        className={`grid transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          isOpen
            ? 'grid-rows-[1fr] opacity-100 mt-2 mb-6'
            : 'grid-rows-[0fr] opacity-0 mt-0 mb-0 pointer-events-none'
        }`}
      >
        <div className="overflow-hidden">
          <div className="pl-4 sm:pl-5 border-l-2 border-matcha-400/40 dark:border-matcha-700/40 text-[0.95rem] text-ink-700 dark:text-sage-200">
            {!hasChildren ? (
              <div className="italic opacity-50 text-xs py-1">Empty toggle heading</div>
            ) : isLoading ? (
              <div className="flex items-center gap-2 py-2 text-ink-400 dark:text-sage-500 text-xs">
                <svg
                  className="animate-spin h-3.5 w-3.5 text-matcha-500"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span>Loading...</span>
              </div>
            ) : error ? (
              <div className="text-red-500 py-2 text-xs flex items-center gap-2">
                <span>Failed to load content.</span>
                <button
                  type="button"
                  onClick={handleToggleClick}
                  className="underline hover:text-red-600 font-medium cursor-pointer"
                >
                  Retry
                </button>
              </div>
            ) : (
              childrenHtml && <NotionContent html={childrenHtml} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

