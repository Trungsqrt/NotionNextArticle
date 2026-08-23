"use client"

/**
 * TableOfContents.js - Sticky right-sidebar Table of Contents
 * --------------------------------------------------------------
 * Accepts the raw Notion `blocks` array as a prop and derives
 * anchor links from heading_1 / heading_2 / heading_3 blocks.
 *
 * The anchor IDs must match what lib/notion.js writes into the
 * rendered HTML: `id="${block.id.replace(/-/g, '')}"`.
 *
 * Active-section highlighting is done via IntersectionObserver.
 */

import { useState, useEffect, useRef } from "react"

export default function TableOfContents({ blocks }) {
  const [activeId, setActiveId] = useState(null)
  const observerRef = useRef(null)

  if (!blocks || blocks.length === 0) return null

  const headings = blocks.filter(
    (block) =>
      block.type === "heading_1" ||
      block.type === "heading_2" ||
      block.type === "heading_3"
  )

  if (headings.length === 0) return null

  const items = headings.map((block) => {
    const type = block.type
    const richText = block[type]?.rich_text || []
    const text = richText.map((t) => t.plain_text).join("")
    const id = block.id.replace(/-/g, "")
    return { id, text, type }
  })

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const targets = items
      .map((item) => document.getElementById(item.id))
      .filter(Boolean)

    if (targets.length === 0) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length > 0) {
          setActiveId(visible[0].target.id)
        }
      },
      { rootMargin: "0px 0px -60% 0px", threshold: 0 }
    )

    targets.forEach((el) => observerRef.current.observe(el))
    return () => observerRef.current?.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  return (
    <nav
      aria-label="Table of contents"
      className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2 pb-8"
    >
      <div className="flex items-center gap-2 mb-4 ml-1">
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
          className="text-matcha-500 dark:text-matcha-400 shrink-0"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="15" y2="12" />
          <line x1="3" y1="18" x2="18" y2="18" />
        </svg>
        <h3 className="text-[0.68rem] font-bold uppercase tracking-widest text-neutral-400 dark:text-neutral-500 select-none">
          On this page
        </h3>
      </div>

      <ul className="space-y-0.5 text-[0.82rem] leading-snug">
        {items.map(({ id, text, type }) => {
          const isActive = activeId === id
          let pl = 0
          if (type === "heading_2") pl = 12
          if (type === "heading_3") pl = 24

          return (
            <li key={id} style={{ paddingLeft: `${pl}px` }}>
              <a
                href={`#${id}`}
                onClick={(e) => {
                  e.preventDefault()
                  const el = document.getElementById(id)
                  if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "start" })
                    setActiveId(id)
                  }
                }}
                className={[
                  "block py-1 px-2 rounded-md text-[0.82rem] leading-snug line-clamp-2",
                  "transition-all duration-200 no-underline border-l-2",
                  isActive
                    ? "border-matcha-500 dark:border-matcha-400 text-matcha-700 dark:text-matcha-300 bg-matcha-50/60 dark:bg-matcha-900/20 font-medium"
                    : "border-transparent text-neutral-500 dark:text-neutral-400 hover:text-matcha-600 dark:hover:text-matcha-300 hover:border-matcha-300 dark:hover:border-matcha-600 hover:bg-neutral-50/60 dark:hover:bg-neutral-800/30",
                ].join(" ")}
              >
                {text}
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}