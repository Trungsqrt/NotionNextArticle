"use client"

import { useState } from 'react'
import NotionContent from './NotionContent'

export default function NotionToggleBlock({ blockId, titleHtml, color, dynamicClasses, hasChildren }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [childrenHtml, setChildrenHtml] = useState("")
  const [error, setError] = useState(false)

  const handleToggleClick = async () => {
    const nextState = !isOpen
    setIsOpen(nextState)

    if (nextState && hasChildren && !childrenHtml && !isLoading && !error) {
      setIsLoading(true)
      try {
        const res = await fetch(`/api/notion/children?blockId=${blockId}`)
        if (!res.ok) throw new Error('Failed to fetch')
        const data = await res.json()
        if (data.html) {
          setChildrenHtml(data.html)
        } else {
          setError(true)
        }
      } catch (err) {
        console.error("Failed to load toggle children", err)
        setError(true)
      } finally {
        setIsLoading(false)
      }
    }
  }

  return (
    <div 
      className={`my-3.5 rounded-xl border p-3.5 transition-colors duration-200 shadow-2xs ${dynamicClasses || 'bg-rice-paper-100 dark:bg-tea-slate-300 border-rice-paper-400/70 dark:border-tea-slate-50/60'}`}
    >
      <button
        type="button"
        onClick={handleToggleClick}
        className="w-full text-left font-medium cursor-pointer select-none text-ink-800 dark:text-sage-100 flex items-center gap-2.5 group focus:outline-none"
        aria-expanded={isOpen}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-matcha-600 dark:text-matcha-400 transition-transform duration-300 ease-out shrink-0 ${
            isOpen ? 'rotate-90' : 'rotate-0'
          }`}
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="leading-snug" dangerouslySetInnerHTML={{ __html: titleHtml || "Toggle" }} />
      </button>
      
      <div 
        className={`grid transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          isOpen ? 'grid-rows-[1fr] opacity-100 mt-3' : 'grid-rows-[0fr] opacity-0 mt-0 pointer-events-none'
        }`}
      >
        <div className="overflow-hidden">
          <div className="pl-5 border-l-2 border-matcha-400/40 dark:border-matcha-700/40 text-[0.95rem] text-ink-700 dark:text-sage-200">
            {!hasChildren ? (
              <div className="italic opacity-50 text-xs py-1">Empty toggle</div>
            ) : isLoading ? (
              <div className="flex items-center gap-2 py-2 text-ink-400 dark:text-sage-500 text-xs">
                <svg className="animate-spin h-3.5 w-3.5 text-matcha-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Loading...</span>
              </div>
            ) : error ? (
              <div className="text-red-500 py-2 text-xs">Failed to load content.</div>
            ) : (
              childrenHtml && <NotionContent html={childrenHtml} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
