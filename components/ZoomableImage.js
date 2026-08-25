"use client"

import { useState } from 'react'
import Zoom from 'react-medium-image-zoom'
import 'react-medium-image-zoom/dist/styles.css'

/**
 * ZoomableImage.js — Image with Click-to-Zoom Lightbox
 * ─────────────────────────────────────────────────────
 * Uses a plain <img> tag (never next/image) to avoid domain/dimension
 * restrictions inside the react-medium-image-zoom wrapper and stream
 * directly from Notion S3. Includes stateful onError fallback.
 *
 * Props:
 *   src     — Image source URL
 *   alt     — Alt text / caption plain-text
 *   caption — Optional caption HTML string (rendered below image)
 */
export default function ZoomableImage({ src, alt, caption }) {
  const [hasError, setHasError] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  if (!src) return null

  return (
    <figure className="not-prose my-6 flex flex-col items-center w-full">
      <div className={`w-full overflow-hidden rounded-xl border border-rice-paper-400/60 dark:border-tea-slate-50/40 bg-rice-paper-200 dark:bg-tea-slate-800 ${isLoading ? 'animate-pulse' : ''}`}>
        {hasError ? (
          <div className="w-full py-10 px-4 flex flex-col items-center justify-center text-center text-ink-400 dark:text-sage-400" aria-label="Image failed to load">
            <svg className="w-8 h-8 mb-2 opacity-40 text-matcha-600 dark:text-matcha-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth="1.5" />
              <circle cx="8.5" cy="8.5" r="1.5" strokeWidth="1.5" />
              <path d="m21 15-5-5L5 21" strokeWidth="1.5" />
            </svg>
            <span className="text-xs font-mono opacity-75">{alt || 'Image unavailable'}</span>
          </div>
        ) : (
          <Zoom zoomMargin={40}>
            <img
              src={src}
              alt={alt || 'Notion image'}
              className={`w-full h-auto block cursor-zoom-in transition-all duration-500 ease-out ${isLoading ? 'scale-105 blur-md opacity-0' : 'scale-100 blur-0 opacity-100'}`}
              loading="lazy"
              decoding="async"
              onLoad={() => setIsLoading(false)}
              onError={() => {
                setHasError(true)
                setIsLoading(false)
              }}
            />
          </Zoom>
        )}
      </div>
      {caption && (
        <figcaption
          className="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500 italic"
          dangerouslySetInnerHTML={{ __html: caption }}
        />
      )}
    </figure>
  )
}

