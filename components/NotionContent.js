"use client"

/**
 * NotionContent.js — Client-side Notion content renderer
 * ──────────────────────────────────────────────────────
 * Replaces interactive placeholder divs (data-notion-component) with
 * real React components (NotionCodeBlock, ZoomableImage) on the client.
 *
 * Strategy to avoid SSR/CSR hydration mismatch:
 *   1. On the server (or before mount), render a single dangerouslySetInnerHTML
 *      div so the server HTML and initial client HTML are identical.
 *   2. After mount (useEffect), parse the rendered DOM, find placeholder divs,
 *      and re-render as a React tree with real components swapped in.
 *
 * This means interactive features (zoom, wrap toggle) are progressive
 * enhancements — the raw HTML is visible immediately and components
 * take over after hydration.
 */

import { useState, useEffect, useMemo } from 'react'
import NotionCodeBlock from './NotionCodeBlock'
import ZoomableImage from './ZoomableImage'

/** Parse the HTML string for data-notion-component markers, splitting it into
 *  alternating chunks of raw HTML and component descriptors. */
function parseHtmlParts(html) {
  if (!html) return []

  const parts = []
  // Match <div data-notion-component="..." data-props="..."></div>
  const regex = /<div data-notion-component="([^"]+)" data-props="([^"]*)">\s*<\/div>/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'html', content: html.slice(lastIndex, match.index) })
    }

    try {
      // data-props is HTML-escaped, so we need to unescape it before parsing
      const rawJson = match[2]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
      const props = JSON.parse(rawJson)
      parts.push({ type: 'component', component: match[1], props })
    } catch {
      // If parsing fails, treat the whole match as raw HTML
      parts.push({ type: 'html', content: match[0] })
    }

    lastIndex = regex.lastIndex
  }

  if (lastIndex < html.length) {
    parts.push({ type: 'html', content: html.slice(lastIndex) })
  }

  return parts
}

export default function NotionContent({ html, className }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const parts = useMemo(() => parseHtmlParts(html), [html])
  const hasComponents = parts.some(p => p.type === 'component')

  // ── Before mount (SSR + initial client render) ──────────────────────────
  // Render raw HTML — identical on server and client → no hydration mismatch.
  if (!mounted || !hasComponents) {
    return (
      <div
        className={className}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  // ── After mount (client only) ───────────────────────────────────────────
  // Replace placeholder divs with real React components.
  return (
    <div className={className}>
      {parts.map((part, i) => {
        if (part.type === 'html') {
          return (
            <div
              key={i}
              className="contents"
              dangerouslySetInnerHTML={{ __html: part.content }}
            />
          )
        }

        if (part.type === 'component') {
          if (part.component === 'NotionCodeBlock') {
            return (
              <NotionCodeBlock
                key={i}
                codeText={part.props.codeText}
                language={part.props.language}
                caption={part.props.caption}
              />
            )
          }

          if (part.component === 'ZoomableImage') {
            return (
              <ZoomableImage
                key={i}
                src={part.props.src}
                alt={part.props.alt}
                caption={part.props.caption}
              />
            )
          }
        }

        return null
      })}
    </div>
  )
}
