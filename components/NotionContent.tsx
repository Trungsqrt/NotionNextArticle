'use client'

/**
 * NotionContent.tsx — Client-side Notion content renderer using html-react-parser
 * ───────────────────────────────────────────────────────────────────────────────
 * Parses server-generated HTML into a clean React virtual DOM tree.
 * Replaces <div data-notion-component="..." data-props="..."></div> sentinels
 * with interactive client components seamlessly.
 */

import { useEffect, useRef, type RefObject } from 'react'
import parse, { Element, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser'
import NotionCodeBlock, { type NotionCodeBlockProps } from './NotionCodeBlock'
import NotionToggleBlock, { type NotionToggleBlockProps } from './NotionToggleBlock'
import NotionToggleHeading, { type NotionToggleHeadingProps, type ToggleHeadingLevel } from './NotionToggleHeading'
import ImageSlider, { type ImageSliderProps } from './ImageSlider'
import { refreshNotionImageUrl, invalidateNotionImageUrl } from '../lib/notion-image-recovery'
import type { NotionSliderImage } from '../lib/notion-types'

export interface NotionContentProps {
  html?: string | null
  className?: string
  locale?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function parseCodeBlockProps(raw: unknown): NotionCodeBlockProps {
  const obj = asRecord(raw)
  return {
    codeText: typeof obj?.codeText === 'string' ? obj.codeText : '',
    language: typeof obj?.language === 'string' ? obj.language : '',
    caption: typeof obj?.caption === 'string' ? obj.caption : '',
  }
}

function parseToggleBlockProps(raw: unknown): NotionToggleBlockProps {
  const obj = asRecord(raw)
  return {
    blockId: typeof obj?.blockId === 'string' ? obj.blockId : '',
    titleHtml: typeof obj?.titleHtml === 'string' ? obj.titleHtml : '',
    color: typeof obj?.color === 'string' ? obj.color : undefined,
    dynamicClasses: typeof obj?.dynamicClasses === 'string' ? obj.dynamicClasses : undefined,
    hasChildren: Boolean(obj?.hasChildren),
  }
}

function parseHeadingLevel(val: unknown): ToggleHeadingLevel {
  if (val === 1 || val === 2 || val === 3 || val === 4) return val
  return 1
}

function parseToggleHeadingProps(raw: unknown): NotionToggleHeadingProps {
  const obj = asRecord(raw)
  return {
    blockId: typeof obj?.blockId === 'string' ? obj.blockId : '',
    level: parseHeadingLevel(obj?.level),
    titleHtml: typeof obj?.titleHtml === 'string' ? obj.titleHtml : '',
    anchorId: typeof obj?.anchorId === 'string' ? obj.anchorId : undefined,
    color: typeof obj?.color === 'string' ? obj.color : undefined,
    colorClass: typeof obj?.colorClass === 'string' ? obj.colorClass : '',
    hasChildren: Boolean(obj?.hasChildren),
  }
}

function parseImageSliderProps(raw: unknown): ImageSliderProps {
  const obj = asRecord(raw)
  const rawImages = Array.isArray(obj?.images) ? obj.images : []
  const images: NotionSliderImage[] = rawImages
    .map((item): NotionSliderImage | null => {
      const rec = asRecord(item)
      if (!rec || typeof rec.url !== 'string') return null
      return {
        url: rec.url,
        caption: typeof rec.caption === 'string' ? rec.caption : '',
        blockId: typeof rec.blockId === 'string' ? rec.blockId : null,
      }
    })
    .filter((item): item is NotionSliderImage => item !== null)
  return { images }
}

// ── Lightweight zoom lightbox ──────────────────────────────────────────────
function useLightbox(containerRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let overlay = document.getElementById('notion-zoom-overlay') as HTMLDivElement | null
    let zoomed: HTMLImageElement | null = null

    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'notion-zoom-overlay'
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:9999',
        'background:rgba(0,0,0,0.82)',
        'display:none',
        'align-items:center',
        'justify-content:center',
        'cursor:zoom-out',
        'padding:2rem',
      ].join(';')

      zoomed = document.createElement('img')
      zoomed.style.cssText = [
        'max-width:100%',
        'max-height:90vh',
        'object-fit:contain',
        'border-radius:0.75rem',
        'box-shadow:0 25px 60px rgba(0,0,0,0.5)',
      ].join(';')

      overlay.appendChild(zoomed)
      document.body.appendChild(overlay)
    } else {
      zoomed = overlay.querySelector('img')
    }

    const activeOverlay = overlay

    function open(img: HTMLImageElement) {
      if (!zoomed) return
      zoomed.src = img.src
      zoomed.alt = img.alt
      activeOverlay.style.display = 'flex'
      document.body.style.overflow = 'hidden'
    }
    function close() {
      activeOverlay.style.display = 'none'
      document.body.style.overflow = ''
    }

    function handleClick(e: MouseEvent) {
      const target = e.target instanceof globalThis.Element ? e.target : null
      const img = target?.closest('[data-notion-zoom]')
      if (img instanceof HTMLImageElement) open(img)
    }

    container.addEventListener('click', handleClick)
    activeOverlay.addEventListener('click', close)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)

    return () => {
      container.removeEventListener('click', handleClick)
      activeOverlay.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [containerRef])
}

// ── Image error recovery & fallback handler ────────────────────────────────
function showImageFallback(img: HTMLImageElement) {
  img.style.display = 'none'
  const figure = img.closest('figure')
  if (figure && !figure.querySelector('.notion-img-fallback')) {
    const fallback = document.createElement('div')
    fallback.className =
      'notion-img-fallback w-full py-8 px-4 flex flex-col items-center justify-center text-center text-ink-400 dark:text-sage-400 bg-rice-paper-200/50 dark:bg-tea-slate-200/50 rounded-xl border border-rice-paper-400/40 dark:border-tea-slate-50/20'
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

function useImageErrorFallback(containerRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let active = true

    async function recoverOrFallback(img: HTMLImageElement) {
      if (!img || img.tagName !== 'IMG') return
      if (img.dataset.notionRecoveryManaged === 'true') return

      const recoveryState = img.dataset.notionRecoveryState
      if (recoveryState === 'recovering') return

      const blockId = img.getAttribute('data-notion-image-id')
      const coverPageId = img.getAttribute('data-notion-cover-page-id')
      const recoveryTarget = {
        blockId: blockId || null,
        pageId: !blockId ? coverPageId : null,
      }

      if (recoveryState === 'recovered') {
        img.dataset.notionRecoveryState = 'failed'
        if (blockId || coverPageId) {
          invalidateNotionImageUrl(recoveryTarget)
        }
        showImageFallback(img)
        return
      }

      if ((blockId || coverPageId) && recoveryState !== 'failed') {
        img.dataset.notionRecoveryState = 'recovering'

        const freshUrl = await refreshNotionImageUrl({
          ...recoveryTarget,
          failedUrl: img.currentSrc || img.src || null,
        })

        if (!active || !img.isConnected) return

        if (freshUrl) {
          img.dataset.notionRecoveryState = 'recovered'
          const figure = img.closest('figure')
          const existingFallback = figure?.querySelector('.notion-img-fallback')
          if (existingFallback) existingFallback.remove()
          img.style.display = ''
          img.src = freshUrl
          return
        }

        img.dataset.notionRecoveryState = 'failed'
      }

      showImageFallback(img)
    }

    function handleError(e: Event) {
      if (e.target instanceof HTMLImageElement) {
        void recoverOrFallback(e.target)
      }
    }

    container.addEventListener('error', handleError, true)

    const preFailed = container.querySelectorAll<HTMLImageElement>(
      'img[data-notion-image-id], img[data-notion-cover-page-id]'
    )
    preFailed.forEach((img) => {
      if (img.complete && img.naturalWidth === 0 && !img.dataset.notionRecoveryState) {
        void recoverOrFallback(img)
      }
    })

    return () => {
      active = false
      container.removeEventListener('error', handleError, true)
    }
  }, [containerRef])
}

// ── Main component ─────────────────────────────────────────────────────────
export default function NotionContent({ html, className }: NotionContentProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useLightbox(containerRef)
  useImageErrorFallback(containerRef)

  if (!html) return null

  const parseOptions: HTMLReactParserOptions = {
    replace: (domNode: DOMNode) => {
      if (!(domNode instanceof Element)) return

      if (domNode.attribs['data-notion-component'] === 'NotionCodeBlock') {
        try {
          const rawProps = domNode.attribs['data-props']
          if (rawProps) {
            const props = parseCodeBlockProps(JSON.parse(rawProps))
            return <NotionCodeBlock codeText={props.codeText} language={props.language} caption={props.caption} />
          }
        } catch (err: unknown) {
          console.error('Failed to parse NotionCodeBlock props:', err)
        }
      } else if (domNode.attribs['data-notion-component'] === 'NotionToggleBlock') {
        try {
          const rawProps = domNode.attribs['data-props']
          if (rawProps) {
            const props = parseToggleBlockProps(JSON.parse(rawProps))
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
        } catch (err: unknown) {
          console.error('Failed to parse NotionToggleBlock props:', err)
        }
      } else if (domNode.attribs['data-notion-component'] === 'NotionToggleHeading') {
        try {
          const rawProps = domNode.attribs['data-props']
          if (rawProps) {
            const props = parseToggleHeadingProps(JSON.parse(rawProps))
            return (
              <NotionToggleHeading
                blockId={props.blockId}
                level={props.level}
                titleHtml={props.titleHtml}
                anchorId={props.anchorId}
                color={props.color}
                colorClass={props.colorClass}
                hasChildren={props.hasChildren}
              />
            )
          }
        } catch (err: unknown) {
          console.error('Failed to parse NotionToggleHeading props:', err)
        }
      } else if (domNode.attribs['data-notion-component'] === 'ImageSlider') {
        try {
          const rawProps = domNode.attribs['data-props']
          if (rawProps) {
            const props = parseImageSliderProps(JSON.parse(rawProps))
            return <ImageSlider images={props.images} />
          }
        } catch (err: unknown) {
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
