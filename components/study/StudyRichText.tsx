'use client'

import { useState } from 'react'
import type { QuestionImagePlacement, QuestionImageRef } from '../../lib/study/types'

function StudyImageFigure({ image }: { image: QuestionImageRef }) {
  const [failed, setFailed] = useState(false)
  const blockId = image.notionBlockId || image.id

  // Only stream permanent Notion block IDs via the authenticated private image API
  const isUuid =
    /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(
      blockId || ''
    )

  if (!isUuid || failed) {
    return (
      <figure className="my-4 rounded-zen p-4 bg-rice-paper-200/60 dark:bg-tea-slate-200/60 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-center">
        <span className="text-xs font-mono text-ink-400 dark:text-sage-500">
          Image unavailable{image.originalFilename ? ` (${image.originalFilename})` : ''}
        </span>
      </figure>
    )
  }

  return (
    <figure className="my-4 flex flex-col items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/study/images/${encodeURIComponent(blockId)}`}
        alt={image.alt || image.originalFilename || 'Study reference diagram'}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="max-w-full h-auto rounded-card border border-rice-paper-400/70 dark:border-tea-slate-50/40 shadow-zen-sm"
      />
      {(image.caption || image.alt) && (
        <figcaption className="mt-2 text-xs italic text-ink-400 dark:text-sage-400 text-center max-w-prose">
          {image.caption || image.alt}
        </figcaption>
      )}
    </figure>
  )
}

function renderTextWithInlineCode(segment: string, keyPrefix: string) {
  const codeParts = segment.split(/(`[^`]+`)/g)
  return codeParts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={`${keyPrefix}-c-${idx}`}
          className="font-mono text-[0.86em] px-1.5 py-0.5 rounded bg-rice-paper-300/70 dark:bg-tea-slate-100 text-matcha-700 dark:text-matcha-300"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={`${keyPrefix}-t-${idx}`}>{part}</span>
  })
}

const IMAGE_TOKEN_REGEX = /\[\[image:(question|option|feedback|explanation)(?::([^:\]]+))?:(\d+)\]\]/g

export default function StudyRichText({
  text,
  imageRefs = [],
  placement,
  optionId,
  className = '',
}: {
  text: string
  imageRefs?: QuestionImageRef[]
  placement: QuestionImagePlacement
  optionId?: string
  className?: string
}) {
  const relevantImages = imageRefs
    .filter(
      (img) =>
        img.placement === placement &&
        (optionId ? img.optionId === optionId : !img.optionId)
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  const renderedOrders = new Set<number>()
  const nodes: React.ReactNode[] = []

  let lastIndex = 0
  let match: RegExpExecArray | null
  const regex = new RegExp(IMAGE_TOKEN_REGEX.source, 'g')

  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index)
    if (before) {
      nodes.push(
        <span key={`seg-${lastIndex}`} className="whitespace-pre-line">
          {renderTextWithInlineCode(before, `seg-${lastIndex}`)}
        </span>
      )
    }

    const tokenOrder = Number.parseInt(match[3], 10)
    const matchedImg = relevantImages.find((img) => (img.order ?? 0) === tokenOrder)
    if (matchedImg) {
      renderedOrders.add(tokenOrder)
      nodes.push(<StudyImageFigure key={`img-${tokenOrder}-${matchedImg.id}`} image={matchedImg} />)
    }

    lastIndex = match.index + match[0].length
  }

  const tail = text.slice(lastIndex)
  if (tail) {
    nodes.push(
      <span key={`tail-${lastIndex}`} className="whitespace-pre-line">
        {renderTextWithInlineCode(tail, `tail-${lastIndex}`)}
      </span>
    )
  }

  // Render any remaining images for this placement that did not have an explicit token
  for (const img of relevantImages) {
    const ord = img.order ?? 0
    if (!renderedOrders.has(ord)) {
      nodes.push(<StudyImageFigure key={`extra-${ord}-${img.id}`} image={img} />)
    }
  }

  return <div className={className}>{nodes}</div>
}
