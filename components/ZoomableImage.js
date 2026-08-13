"use client"

/**
 * ZoomableImage.js — Image with Click-to-Zoom Lightbox
 * ─────────────────────────────────────────────────────
 * Client component that wraps an image in a react-medium-image-zoom
 * container for smooth, native Notion-style zoom expansion.
 *
 * Props:
 *   src     — Image source URL
 *   alt     — Alt text for accessibility
 *   caption — Optional caption HTML string
 */

import Zoom from 'react-medium-image-zoom'
import 'react-medium-image-zoom/dist/styles.css'

export default function ZoomableImage({ src, alt, caption }) {
  if (!src) return null

  return (
    <figure className="not-prose my-6 flex flex-col items-center w-full">
      <div className="w-full overflow-hidden rounded-2xl shadow-sm border border-neutral-200/60 dark:border-neutral-800 bg-neutral-100/50 dark:bg-neutral-900/50 [&_[data-rmiz]]:w-full [&_[data-rmiz-content]]:w-full">
        <Zoom zoomMargin={40}>
          <img
            src={src}
            alt={alt || ''}
            className="w-full h-auto object-cover rounded-2xl block cursor-zoom-in"
            loading="lazy"
          />
        </Zoom>
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
