"use client"

/**
 * NotionContent.js — Client-side Notion content renderer using html-react-parser
 * ──────────────────────────────────────────────────────────────────────────────
 * Parses server-generated HTML into a clean React virtual DOM tree.
 * Replaces <div data-notion-component="NotionCodeBlock" data-props="..."></div>
 * with the fully interactive <NotionCodeBlock> component seamlessly, everywhere
 * (including inside Notion Toggles / <details>, columns, and tables).
 */

import { useEffect, useRef } from 'react'
import parse from 'html-react-parser'
import NotionCodeBlock from './NotionCodeBlock'

// ── Lightweight zoom lightbox ──────────────────────────────────────────────
function useLightbox(containerRef) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let overlay = document.getElementById('notion-zoom-overlay')
    let zoomed = null

    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'notion-zoom-overlay'
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:9999',
        'background:rgba(0,0,0,0.82)', 'display:none',
        'align-items:center', 'justify-content:center',
        'cursor:zoom-out', 'padding:2rem',
      ].join(';')

      zoomed = document.createElement('img')
      zoomed.style.cssText = [
        'max-width:100%', 'max-height:90vh',
        'object-fit:contain', 'border-radius:0.75rem',
        'box-shadow:0 25px 60px rgba(0,0,0,0.5)',
      ].join(';')

      overlay.appendChild(zoomed)
      document.body.appendChild(overlay)
    } else {
      zoomed = overlay.querySelector('img')
    }

    function open(img) {
      if (!zoomed) return
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
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)

    return () => {
      container.removeEventListener('click', handleClick)
      overlay.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [containerRef])
}

// ── Main component ─────────────────────────────────────────────────────────
export default function NotionContent({ html, className }) {
  const containerRef = useRef(null)
  useLightbox(containerRef)

  if (!html) return null

  const parseOptions = {
    replace: (domNode) => {
      if (
        domNode.attribs &&
        domNode.attribs['data-notion-component'] === 'NotionCodeBlock'
      ) {
        try {
          const rawProps = domNode.attribs['data-props']
          if (rawProps) {
            const props = JSON.parse(rawProps)
            return (
              <NotionCodeBlock
                codeText={props.codeText}
                language={props.language}
                caption={props.caption}
              />
            )
          }
        } catch (err) {
          console.error('Failed to parse NotionCodeBlock props:', err)
        }
      }
    },
  }

  return (
    <div ref={containerRef} className={className}>
      {parse(html, parseOptions)}
    </div>
  )
}
