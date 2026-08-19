"use client"

/**
 * NotionContent.js — Client-side Notion content renderer
 * ──────────────────────────────────────────────────────
 *
 * Architecture (why this works the way it does):
 *
 * Images are now rendered as plain <figure><img/></figure> HTML by notion.js,
 * so they appear immediately — no component swap, no structure-breaking splits.
 *
 * Only `NotionCodeBlock` uses the data-notion-component placeholder pattern,
 * and code blocks are always top-level blocks (never nested inside column/flex
 * containers), so splitting the HTML string on them is safe — no open tags are
 * ever broken mid-structure.
 *
 * Zoom is handled by a lightweight CSS-only lightbox triggered via event
 * delegation on [data-notion-zoom] images after mount.
 */

import { useState, useEffect, useMemo } from 'react'
import NotionCodeBlock from './NotionCodeBlock'

// ── Regex that matches ONLY NotionCodeBlock placeholders ───────────────────
const CODE_PLACEHOLDER_RE = /<div data-notion-component="NotionCodeBlock" data-props="([^"]*)"><\/div>/g

/** Split HTML on NotionCodeBlock placeholders only. */
function parseHtmlParts(html) {
  if (!html) return []

  const parts = []
  let lastIndex = 0
  let match

  CODE_PLACEHOLDER_RE.lastIndex = 0
  while ((match = CODE_PLACEHOLDER_RE.exec(html)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'html', content: html.slice(lastIndex, match.index) })
    }
    try {
      const raw = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
      const props = JSON.parse(raw)
      parts.push({ type: 'code', props })
    } catch {
      parts.push({ type: 'html', content: match[0] })
    }
    lastIndex = CODE_PLACEHOLDER_RE.lastIndex
  }

  if (lastIndex < html.length) {
    parts.push({ type: 'html', content: html.slice(lastIndex) })
  }

  return parts
}

// ── Lightweight zoom lightbox ──────────────────────────────────────────────
function useLightbox(containerRef) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Create overlay once
    const overlay = document.createElement('div')
    overlay.id = 'notion-zoom-overlay'
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      'background:rgba(0,0,0,0.82)', 'display:none',
      'align-items:center', 'justify-content:center',
      'cursor:zoom-out', 'padding:2rem',
    ].join(';')

    const zoomed = document.createElement('img')
    zoomed.style.cssText = [
      'max-width:100%', 'max-height:90vh',
      'object-fit:contain', 'border-radius:0.75rem',
      'box-shadow:0 25px 60px rgba(0,0,0,0.5)',
    ].join(';')

    overlay.appendChild(zoomed)
    document.body.appendChild(overlay)

    function open(img) {
      zoomed.src = img.src
      zoomed.alt = img.alt
      overlay.style.display = 'flex'
      document.body.style.overflow = 'hidden'
    }
    function close() {
      overlay.style.display = 'none'
      document.body.style.overflow = ''
    }

    function handleClick(e) {
      const img = e.target.closest('[data-notion-zoom]')
      if (img) open(img)
    }

    container.addEventListener('click', handleClick)
    overlay.addEventListener('click', close)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close()
    })

    return () => {
      container.removeEventListener('click', handleClick)
      overlay.removeEventListener('click', close)
      document.body.removeChild(overlay)
    }
  }, [containerRef])
}

// ── Main component ─────────────────────────────────────────────────────────
export default function NotionContent({ html, className }) {
  const [mounted, setMounted] = useState(false)
  const containerRef = useMemo(() => ({ current: null }), [])
  const setRef = (el) => { containerRef.current = el }

  useEffect(() => { setMounted(true) }, [])
  useLightbox(containerRef)

  const parts = useMemo(() => parseHtmlParts(html), [html])
  const hasCode = parts.some(p => p.type === 'code')

  // ── SSR + pre-mount: identical server/client output, no hydration mismatch
  if (!mounted || !hasCode) {
    return (
      <div
        ref={setRef}
        className={className}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  // ── After mount: swap NotionCodeBlock placeholders with real component
  return (
    <div ref={setRef} className={className}>
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
        if (part.type === 'code') {
          return (
            <NotionCodeBlock
              key={i}
              codeText={part.props.codeText}
              language={part.props.language}
              caption={part.props.caption}
            />
          )
        }
        return null
      })}
    </div>
  )
}
