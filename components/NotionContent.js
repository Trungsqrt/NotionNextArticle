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
import NotionToggleBlock from './NotionToggleBlock'
import ImageSlider from './ImageSlider'

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

// ── Image error fallback handler ──────────────────────────────────────────
function useImageErrorFallback(containerRef) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function handleError(e) {
      if (e.target && e.target.tagName === 'IMG') {
        const img = e.target
        img.style.display = 'none'
        const figure = img.closest('figure')
        if (figure && !figure.querySelector('.notion-img-fallback')) {
          const fallback = document.createElement('div')
          fallback.className = 'notion-img-fallback w-full py-8 px-4 flex flex-col items-center justify-center text-center text-ink-400 dark:text-sage-400 bg-rice-paper-200/50 dark:bg-tea-slate-200/50 rounded-xl border border-rice-paper-400/40 dark:border-tea-slate-50/20'
          fallback.innerHTML = `
            <svg class="w-7 h-7 mb-2 opacity-40 text-matcha-600 dark:text-matcha-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" stroke-width="1.5" />
              <circle cx="8.5" cy="8.5" r="1.5" stroke-width="1.5" />
              <path d="m21 15-5-5L5 21" stroke-width="1.5" />
            </svg>
            <span class="text-xs font-mono opacity-70">Image unavailable</span>
          `
          figure.insertBefore(fallback, img)
        }
      }
    }

    container.addEventListener('error', handleError, true)
    return () => {
      container.removeEventListener('error', handleError, true)
    }
  }, [containerRef])
}

// ── Main component ─────────────────────────────────────────────────────────
export default function NotionContent({ html, className }) {
  const containerRef = useRef(null)
  useLightbox(containerRef)
  useImageErrorFallback(containerRef)

  if (!html) return null

  const parseOptions = {
    replace: (domNode) => {
      if (!domNode.attribs) return

      if (domNode.attribs['data-notion-component'] === 'NotionCodeBlock') {
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
      } else if (domNode.attribs['data-notion-component'] === 'NotionToggleBlock') {
        try {
          const rawProps = domNode.attribs['data-props']
          if (rawProps) {
            const props = JSON.parse(rawProps)
            return (
              <NotionToggleBlock
                blockId={props.blockId}
                titleHtml={props.titleHtml}
                color={props.color}
                dynamicClasses={props.dynamicClasses}
                hasChildren={props.hasChildren}
              />
            )
          }
        } catch (err) {
          console.error('Failed to parse NotionToggleBlock props:', err)
        }
      } else if (domNode.attribs['data-notion-component'] === 'ImageSlider') {
        // Replace the sentinel div emitted by the custom_slider renderer
        // with the interactive ImageSlider client component.
        try {
          const rawProps = domNode.attribs['data-props']
          if (rawProps) {
            const props = JSON.parse(rawProps)
            return <ImageSlider images={props.images} />
          }
        } catch (err) {
          console.error('Failed to parse ImageSlider props:', err)
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

