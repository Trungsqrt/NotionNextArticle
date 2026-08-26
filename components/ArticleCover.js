'use client'

import { useState } from 'react'

/**
 * ArticleCover.js — Hero Cover Image for Lesson & Article Pages
 * ─────────────────────────────────────────────────────────────
 * Renders the top cover banner for article pages.
 * Uses direct native <img> streaming to bypass Next.js image proxy
 * bottlenecks with Notion AWS S3 signed URLs, with stateful onError fallback
 * to prevent layout shifts or broken image icons.
 *
 * Props:
 *   src   — String: Cover image URL (from Notion S3 or external)
 *   title — String: Lesson / Page title for alt text
 *   icon  — String: Optional emoji icon for fallback state
 */
function renderArticleIcon(icon) {
  if (!icon) return null
  if (typeof icon === 'string') {
    if (icon.startsWith('http') || icon.startsWith('/')) {
      return <img src={icon} alt="" className="w-14 h-14 object-contain" />
    }
    return <span className="text-5xl select-none opacity-80">{icon}</span>
  }
  if (typeof icon === 'object') {
    if (icon.type === 'emoji' && icon.value) {
      return <span className="text-5xl select-none opacity-80">{icon.value}</span>
    }
    if ((icon.type === 'file' || icon.type === 'external') && icon.value) {
      return <img src={icon.value} alt="" className="w-14 h-14 object-contain" />
    }
    if (icon.value && typeof icon.value === 'string') {
      return <span className="text-5xl select-none opacity-80">{icon.value}</span>
    }
  }
  return null
}

export default function ArticleCover({ src, title = 'Cover Image', icon = null }) {
  const [imgError, setImgError] = useState(false)

  if (!src && !icon) return null

  const renderedIcon = renderArticleIcon(icon)

  return (
    <div className="w-full h-[30vh] min-h-[250px] max-h-[380px] overflow-hidden relative bg-rice-paper-200 dark:bg-tea-slate-200">
      {src && !imgError ? (
        <img
          src={src}
          alt={title || 'Cover Image'}
          loading="eager"
          decoding="async"
          onError={() => setImgError(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, rgba(122,139,105,0.18) 0%, rgba(174,201,163,0.22) 50%, rgba(234,230,223,0.15) 100%)',
          }}
          aria-hidden="true"
        >
          {renderedIcon ? (
            renderedIcon
          ) : (
            <svg width="80" height="80" viewBox="0 0 60 60" fill="none" opacity="0.35" aria-hidden="true">
              <path
                d="M30 8 C40 8 52 16 52 30 C52 44 44 52 30 52 C16 52 8 44 8 30 C8 16 20 8 30 8 Z"
                fill="rgba(122,139,105,0.6)"
              />
              <path
                d="M30 16 C36 16 44 22 44 30 C44 38 38 44 30 44 C22 44 16 38 16 30 C16 22 24 16 30 16 Z"
                fill="rgba(175,201,163,0.7)"
              />
            </svg>
          )}
        </div>
      )}
    </div>
  )
}
