'use client'

import { useState, type ReactNode } from 'react'
import type { QuestionImagePlacement, QuestionImageRef } from '../../lib/study/types'

function StudyImageFigure({ image }: { image: QuestionImageRef }) {
  const [failed, setFailed] = useState(false)
  const blockId = image.notionBlockId || image.id

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

function isSafeLinkHref(href: string): boolean {
  try {
    const parsed = new URL(href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Renders inline Markdown safely as React nodes (zero dangerouslySetInnerHTML):
 * inline code (`...`), safe links ([label](https://...)), **bold**, and *italic*.
 */
function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const tokenRegex =
    /(`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+)\)|\*\*[^*]+\*\*|\*[^*]+\*)/g
  const nodes: ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(<span key={`${keyPrefix}-t-${lastIdx}`}>{text.slice(lastIdx, match.index)}</span>)
    }

    const token = match[0]
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          key={`${keyPrefix}-c-${match.index}`}
          className="font-mono text-[0.86em] px-1.5 py-0.5 rounded bg-rice-paper-300/70 dark:bg-tea-slate-100 text-matcha-700 dark:text-matcha-300"
        >
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token)
      if (linkMatch && isSafeLinkHref(linkMatch[2])) {
        nodes.push(
          <a
            key={`${keyPrefix}-a-${match.index}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-matcha-600 dark:text-matcha-300 underline underline-offset-2 hover:text-matcha-700 dark:hover:text-matcha-200"
          >
            {linkMatch[1]}
          </a>
        )
      } else {
        nodes.push(<span key={`${keyPrefix}-l-${match.index}`}>{token}</span>)
      }
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${match.index}`} className="font-semibold text-ink-700 dark:text-sage-100">
          {token.slice(2, -2)}
        </strong>
      )
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={`${keyPrefix}-i-${match.index}`} className="italic">
          {token.slice(1, -1)}
        </em>
      )
    }

    lastIdx = match.index + token.length
  }

  if (lastIdx < text.length) {
    nodes.push(<span key={`${keyPrefix}-tail`}>{text.slice(lastIdx)}</span>)
  }
  return nodes
}

const IMAGE_LINE_REGEX = /^\[\[image:(question|option|feedback|explanation)(?::([^:\]]+))?:(\d+)\]\]$/

function renderMarkdownBlocks(
  text: string,
  relevantImages: QuestionImageRef[],
  renderedOrders: Set<number>
): ReactNode[] {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let i = 0

  while (i < lines.length) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    // 1. Fenced code block (```...```)
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1 // consume closing ```
      blocks.push(
        <pre
          key={`code-${i}`}
          className="my-3 p-3.5 rounded-zen overflow-x-auto bg-tea-slate-400 text-sage-100 font-mono text-[0.8rem] leading-relaxed border border-tea-slate-50/40"
        >
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    // 2. Standalone image placement token
    const imgLineMatch = IMAGE_LINE_REGEX.exec(trimmed)
    if (imgLineMatch) {
      const tokenOrder = Number.parseInt(imgLineMatch[3], 10)
      const matchedImg = relevantImages.find((img) => (img.order ?? 0) === tokenOrder)
      if (matchedImg) {
        renderedOrders.add(tokenOrder)
        blocks.push(<StudyImageFigure key={`img-${tokenOrder}-${matchedImg.id}`} image={matchedImg} />)
      }
      i += 1
      continue
    }

    // 3. Markdown headings (#..####)
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      const level = headingMatch[1].length
      const content = renderInlineMarkdown(headingMatch[2], `h-${i}`)
      const headingClass =
        level === 1
          ? 'font-serif text-lg font-medium text-ink-700 dark:text-sage-100 mt-4 mb-2'
          : level === 2
            ? 'font-serif text-base font-medium text-ink-700 dark:text-sage-100 mt-3.5 mb-1.5'
            : 'font-serif text-[0.95rem] font-medium text-ink-700 dark:text-sage-100 mt-3 mb-1'
      blocks.push(
        <h3 key={`h-${i}`} className={headingClass}>
          {content}
        </h3>
      )
      i += 1
      continue
    }

    // 4. Markdown table (| col | col | followed by | --- | --- |)
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())
    ) {
      const parseRow = (line: string) =>
        line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
      const headers = parseRow(trimmed)
      i += 2 // skip header + separator
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseRow(lines[i]))
        i += 1
      }
      blocks.push(
        <div key={`tbl-${i}`} className="my-3 overflow-x-auto">
          <table className="w-full text-left border-collapse text-[0.82rem] border border-rice-paper-400/70 dark:border-tea-slate-50/50">
            <thead>
              <tr className="bg-rice-paper-200/70 dark:bg-tea-slate-100/70">
                {headers.map((h, hIdx) => (
                  <th
                    key={hIdx}
                    className="px-3 py-2 font-medium border-b border-rice-paper-400/70 dark:border-tea-slate-50/50"
                  >
                    {renderInlineMarkdown(h, `th-${i}-${hIdx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-rice-paper-400/50 dark:divide-tea-slate-50/40">
              {rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-3 py-2 align-top">
                      {renderInlineMarkdown(cell, `td-${i}-${rIdx}-${cIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // 5. Unordered list (- item or • item)
    if (/^[-•*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-•*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-•*]\s+/, ''))
        i += 1
      }
      blocks.push(
        <ul key={`ul-${i}`} className="my-2 pl-5 list-disc space-y-1">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item, `uli-${i}-${idx}`)}</li>
          ))}
        </ul>
      )
      continue
    }

    // 6. Ordered list (1. item)
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i += 1
      }
      blocks.push(
        <ol key={`ol-${i}`} className="my-2 pl-5 list-decimal space-y-1">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item, `oli-${i}-${idx}`)}</li>
          ))}
        </ol>
      )
      continue
    }

    // 7. Paragraph (collect consecutive plain lines)
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('```') &&
      !IMAGE_LINE_REGEX.test(lines[i].trim()) &&
      !/^#{1,4}\s+/.test(lines[i].trim()) &&
      !/^[-•*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith('|')
    ) {
      paraLines.push(lines[i].trim())
      i += 1
    }
    blocks.push(
      <p key={`p-${i}`} className="my-2 first:mt-0 last:mb-0">
        {renderInlineMarkdown(paraLines.join(' '), `p-${i}`)}
      </p>
    )
  }

  return blocks
}

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
  const blocks = renderMarkdownBlocks(text || '', relevantImages, renderedOrders)

  for (const img of relevantImages) {
    const ord = img.order ?? 0
    if (!renderedOrders.has(ord)) {
      blocks.push(<StudyImageFigure key={`extra-${ord}-${img.id}`} image={img} />)
    }
  }

  return <div className={className}>{blocks}</div>
}
