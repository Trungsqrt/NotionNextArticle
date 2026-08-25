"use client"

import { useState } from 'react'
import NotionContent from './NotionContent'

export default function NotionToggleBlock({ blockId, titleHtml, color, dynamicClasses, hasChildren }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [childrenHtml, setChildrenHtml] = useState("")
  const [error, setError] = useState(false)

  const handleToggle = async (e) => {
    const currentlyOpen = e.target.open
    setIsOpen(currentlyOpen)

    if (currentlyOpen && hasChildren && !childrenHtml && !isLoading && !error) {
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
    <details 
      className={`my-3 rounded-lg border p-3 group transition-colors ${dynamicClasses || 'bg-neutral-50/60 dark:bg-neutral-800/40 border-neutral-200/50 dark:border-neutral-700/60'}`}
      onToggle={handleToggle}
    >
      <summary className="font-medium cursor-pointer select-none text-neutral-800 dark:text-neutral-200 flex items-center gap-2">
        <span className="text-neutral-400 group-open:text-neutral-600 transition-transform group-open:rotate-90">▸</span>
        <span dangerouslySetInnerHTML={{ __html: titleHtml || "Toggle" }} />
      </summary>
      
      <div className="mt-3 pl-6 border-l border-neutral-300 dark:border-neutral-600 text-sm text-neutral-700 dark:text-neutral-300">
        {!hasChildren ? (
          <div className="italic opacity-50">Empty toggle</div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 py-2 text-neutral-400">
            <svg className="animate-spin h-4 w-4 text-matcha-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
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
    </details>
  )
}
