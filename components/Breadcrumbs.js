"use client"

import Link from 'next/link'

/**
 * Breadcrumbs.js — Dynamic Breadcrumbs with Notion Icon and Back Link
 * ─────────────────────────────────────────────────────────────────
 * Renders `Home / [Category /] {icon} {pageTitle}` with interactive link to home.
 *
 * Props:
 *   pageTitle - Title of the Notion page
 *   category  - Optional category string
 *   icon      - Notion page icon object: { type: 'emoji'|'file'|'external', value: string } or raw icon string/obj
 */
export default function Breadcrumbs({ pageTitle, category, icon }) {
  const renderIcon = () => {
    if (!icon) return null

    // Case 1: icon object produced by extractNotionIcon ({ type: 'emoji'|'file'|'external', value: string })
    if (typeof icon === 'object' && icon !== null) {
      if (icon.type === 'emoji' || icon.emoji) {
        const emojiVal = icon.value || icon.emoji
        return <span className="text-base leading-none select-none shrink-0" aria-hidden="true">{emojiVal}</span>
      }
      if (icon.type === 'file' || icon.type === 'external' || icon.file || icon.external) {
        const urlVal = icon.value || icon.file?.url || icon.external?.url
        if (!urlVal) return null
        return (
          <img
            src={urlVal}
            alt=""
            className="w-4 h-4 object-contain rounded shrink-0"
            aria-hidden="true"
          />
        )
      }
    }

    // Case 2: icon is a string (URL or Emoji)
    if (typeof icon === 'string') {
      if (icon.startsWith('http://') || icon.startsWith('https://')) {
        return (
          <img
            src={icon}
            alt=""
            className="w-4 h-4 object-contain rounded shrink-0"
            aria-hidden="true"
          />
        )
      }
      return <span className="text-base leading-none select-none shrink-0" aria-hidden="true">{icon}</span>
    }

    return null
  }

  return (
    <nav aria-label="Breadcrumb" className="text-sm text-neutral-400 dark:text-neutral-500 mb-6 flex items-center gap-2 flex-wrap">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors font-medium"
      >
        <span>Home</span>
      </Link>

      <span>/</span>

      {category && (
        <>
          <span className="hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors">
            {category}
          </span>
          <span>/</span>
        </>
      )}

      <span className="text-neutral-700 dark:text-neutral-200 font-medium truncate max-w-[320px] inline-flex items-center gap-1.5">
        {renderIcon()}
        <span>{pageTitle || 'Untitled'}</span>
      </span>
    </nav>
  )
}
