"use client"

/**
 * ZoomableImage.js — Image with Click-to-Zoom Lightbox
 * ─────────────────────────────────────────────────────
 * Uses a plain <img> tag (never next/image) to avoid domain/dimension
 * restrictions inside the react-medium-image-zoom wrapper.
 *
 * Props:
 *   src     — Image source URL
 *   alt     — Alt text / caption plain-text
 *   caption — Optional caption HTML string (rendered below image)
 */

import Zoom from 'react-medium-image-zoom'
import 'react-medium-image-zoom/dist/styles.css'

export default function ZoomableImage({ src, alt, caption }) {
  if (!src) return null

  return (
    <figure className="not-prose my-6 flex flex-col items-center w-full">
      <div className="w-full overflow-hidden rounded-xl border border-neutral-200/60 dark:border-neutral-800/60 bg-neutral-100/50 dark:bg-neutral-900/50">
        <Zoom zoomMargin={40}>
          <img
            src={src}
            alt={alt || 'Notion image'}
            className="w-full h-auto block cursor-zoom-in"
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
