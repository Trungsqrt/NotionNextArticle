/**
 * lib/notion/renderer.ts — Notion block hydration & HTML rendering
 * ────────────────────────────────────────────────────────────────
 * Owns the shared `NotionRenderer` instance (configured with `@notion-render/hljs-plugin`
 * and custom Wabi-Sabi block renderers), recursive child block hydration (`getChildBlocks`
 * for nested blocks, embedded databases, child pages, and `[slider]` toggles), list-grouped
 * HTML rendering (`renderBlocks`), and the cached page-content loader (`getNotionPageData`).
 */

import { NotionRenderer, createBlockRenderer } from '@notion-render/client'
import type { Block as NotionRenderClientBlock } from '@notion-render/client/dist/types'
import hljsPlugin from '@notion-render/hljs-plugin'
import { DEFAULT_LOCALE, normalizeLocale } from '../locales'
import type { NotionRenderBlock, NotionSliderImage } from '../notion-types'
import { withRequestCache } from './cache'
import {
  fetchChildrenList,
  fetchDatabase,
  fetchPage,
  notion,
  queryDatabaseAll,
} from './client'
import {
  escapeHtml,
  extractPageProperties,
  findPropertyByName,
  formatDate,
  getNotionTextColorClasses,
  getPropertyPlainText,
  renderRichText,
  slugifyText,
} from './properties'
import type {
  NotionBlockLike,
  NotionHeadingPayloadLike,
  NotionPageLike,
  QueryDatabaseOptions,
} from './types'

type RendererBlock<T extends string> = NotionRenderClientBlock<T, unknown> & NotionBlockLike

const renderer = new NotionRenderer({
  client: notion,
})
renderer.use(hljsPlugin({}))

function renderToggleHeadingPlaceholder(
  block: NotionBlockLike,
  level: 1 | 2 | 3 | 4,
  heading: NotionHeadingPayloadLike | undefined,
  textHtml: string,
  anchorId: string
): string {
  const color = heading?.color || 'default'
  const colorClass = getNotionTextColorClasses(color)
  const props = {
    blockId: block.id,
    level,
    titleHtml: textHtml,
    anchorId,
    color,
    colorClass,
    hasChildren: Boolean(block.has_children),
  }
  return `<div data-notion-component="NotionToggleHeading" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
}

/**
 * Maps a Notion toggle color string to Tailwind CSS classes (Wabi-Sabi style).
 * Falls back to a neutral style for unknown or default colors.
 */
function getToggleColorClasses(color: string | undefined): string {
  const colorMap: Record<string, string> = {
    gray_background: 'bg-neutral-100/70 dark:bg-neutral-800/50 border-neutral-200/60 dark:border-neutral-700/50',
    brown_background: 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-200/50 dark:border-amber-800/40 text-amber-900 dark:text-amber-200',
    orange_background: 'bg-orange-50/70 dark:bg-orange-950/30 border-orange-200/50 dark:border-orange-800/40 text-orange-900 dark:text-orange-200',
    yellow_background: 'bg-amber-50/60 dark:bg-amber-900/25 border-amber-200/50 dark:border-amber-700/40 text-amber-900 dark:text-amber-200',
    green_background: 'bg-matcha-50/80 dark:bg-matcha-900/30 border-matcha-200/60 dark:border-matcha-800/50 text-matcha-900 dark:text-matcha-200',
    blue_background: 'bg-sky-50/70 dark:bg-sky-950/30 border-sky-200/50 dark:border-sky-800/40 text-sky-900 dark:text-sky-200',
    purple_background: 'bg-purple-50/70 dark:bg-purple-950/30 border-purple-200/50 dark:border-purple-800/40 text-purple-900 dark:text-purple-200',
    pink_background: 'bg-rose-50/70 dark:bg-rose-950/30 border-rose-200/50 dark:border-rose-800/40 text-rose-900 dark:text-rose-200',
    red_background: 'bg-red-50/70 dark:bg-red-950/30 border-red-200/50 dark:border-red-800/40 text-red-900 dark:text-red-200',
    default: 'bg-rice-paper-100 dark:bg-tea-slate-300 border-rice-paper-400/70 dark:border-tea-slate-50/60',
  }
  return (color && colorMap[color]) || colorMap.default
}

// ── Custom Block Renderers ───────────────────────────────────────────────────

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'child_database'>>('child_database', async (block) => {
    const dbTitle = escapeHtml(block.child_database?.title || 'Database')
    const rawRows = block.database_rows || []

    // Sort child items by the 'Order' property (ascending: 0, 1, 2...)
    // Items without an 'Order' value will default to a high number to appear last
    const rows = [...rawRows].sort((a, b) => {
      const orderA = a.properties?.Order?.number ?? a.properties?.order?.number ?? 999
      const orderB = b.properties?.Order?.number ?? b.properties?.order?.number ?? 999
      return orderA - orderB
    })

    // ── Empty state ──────────────────────────────────────────────────────
    if (rows.length === 0) {
      return (
        `<div class="not-prose my-6 p-5 rounded-card border border-neutral-200/80 dark:border-neutral-800 bg-rice-paper-100 dark:bg-tea-slate-300 shadow-zen-sm">` +
        `<div class="flex items-center gap-2 mb-1">` +
        `<svg class="w-4 h-4 inline-block shrink-0 text-neutral-400 dark:text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" stroke-width="2"/><path d="M3 9h18" stroke-width="2"/></svg>` +
        `<span class="text-sm font-medium text-ink-700 dark:text-sage-200 tracking-tight">${dbTitle}</span>` +
        `</div>` +
        `<p class="text-xs text-neutral-400 dark:text-neutral-600 italic pl-6">No entries found.</p>` +
        `</div>`
      )
    }

    // ── Identify property keys by type for card rendering ────────────────
    const firstRowProps = rows[0]?.properties || {}
    const titleKey = Object.keys(firstRowProps).find((k) => firstRowProps[k]?.type === 'title')

    // Collect select/multi_select/status keys that have at least one non-empty value
    const badgeKeys = Object.keys(firstRowProps).filter((k) => {
      const t = firstRowProps[k]?.type
      if (t !== 'select' && t !== 'multi_select' && t !== 'status') return false
      return rows.some((r) => getPropertyPlainText((r.properties || {})[k]).trim() !== '')
    })

    // Collect date keys that have at least one non-empty value
    const dateKeys = Object.keys(firstRowProps).filter((k) => {
      const t = firstRowProps[k]?.type
      if (t !== 'date' && t !== 'created_time' && t !== 'last_edited_time') return false
      return rows.some((r) => getPropertyPlainText((r.properties || {})[k]).trim() !== '')
    })

    // Summary / description rich_text key (named "Summary", "Description", or "Desc")
    const summaryKey = Object.keys(firstRowProps).find((k) => {
      const lower = k.toLowerCase()
      const t = firstRowProps[k]?.type
      return t === 'rich_text' && (lower === 'summary' || lower === 'description' || lower === 'desc')
    })

    // ── Build each card — mirrors CourseCard.tsx exactly ─────────────────
    const cardsHtml = rows
      .map((row) => {
        const props = row.properties || {}

        // ── Resolve title + slug ──────────────────────────────────────────
        let titleText = ''
        let slug = ''
        if (titleKey) {
          const titleProp = props[titleKey]
          titleText = titleProp?.title?.map((t) => t.plain_text || '').join('') || ''
          const slugProp = props.Slug || props.slug
          slug = slugProp?.rich_text?.map((t) => t.plain_text || '').join('') || ''
          if (!slug && titleText) {
            slug = slugifyText(titleText)
          }
          if (!slug) slug = row.id.replace(/-/g, '')
        }
        const safeSlug = escapeHtml(slug)
        const safeTitle = escapeHtml(titleText) || '—'

        // ── Icon emoji ────────────────────────────────────────────────────
        const rowEmoji = typeof row.icon === 'object' && row.icon !== null ? row.icon.emoji : undefined
        const iconEmoji = rowEmoji ? escapeHtml(rowEmoji) : ''

        // ── Cover — mirrors CardCover in CourseCard.tsx ────────────────────
        const coverUrl = row.cover?.external?.url || row.cover?.file?.url || null
        const coverIsNotionHosted = row.cover?.type === 'file'
        let coverHtml: string
        if (coverUrl) {
          coverHtml =
            `<div class="aspect-[16/7] overflow-hidden bg-rice-paper-200 dark:bg-tea-slate-200 flex-shrink-0 relative">` +
            `<img src="${escapeHtml(coverUrl)}" alt="" loading="lazy" decoding="async" ` +
            (coverIsNotionHosted && row.id ? `data-notion-cover-page-id="${escapeHtml(row.id)}" ` : '') +
            `class="object-cover w-full h-full transition-transform duration-500 group-hover:scale-[1.03]" />` +
            `</div>`
        } else {
          const inner = iconEmoji
            ? `<span class="text-4xl select-none transition-transform duration-300 group-hover:scale-110" aria-hidden="true">${iconEmoji}</span>`
            : `<svg width="60" height="60" viewBox="0 0 60 60" fill="none" style="opacity:0.3" aria-hidden="true">` +
              `<path d="M30 8 C40 8 52 16 52 30 C52 44 44 52 30 52 C16 52 8 44 8 30 C8 16 20 8 30 8 Z" fill="rgba(122,139,105,0.5)"/>` +
              `<path d="M30 16 C36 16 44 22 44 30 C44 38 38 44 30 44 C22 44 16 38 16 30 C16 22 24 16 30 16 Z" fill="rgba(175,201,163,0.6)"/>` +
              `</svg>`
          coverHtml =
            `<div class="aspect-[16/7] overflow-hidden flex-shrink-0 flex items-center justify-center" ` +
            `style="background:linear-gradient(135deg,rgba(122,139,105,0.12) 0%,rgba(174,201,163,0.18) 60%,rgba(234,230,223,0.10) 100%)" aria-hidden="true">` +
            inner +
            `</div>`
        }

        // ── Tag chips — mirrors TagChip in CourseCard.tsx ──────────────────
        let tagsHtml = ''
        if (badgeKeys.length > 0) {
          const allBadges = badgeKeys
            .flatMap((k) => {
              const p = props[k]
              if (!p) return []
              if (p.type === 'multi_select') return (p.multi_select || []).map((item) => item.name || '')
              if (p.type === 'select' && p.select?.name) return [p.select.name]
              if (p.type === 'status' && p.status?.name) return [p.status.name]
              return []
            })
            .filter(Boolean)

          if (allBadges.length > 0) {
            const chips = allBadges
              .slice(0, 3)
              .map((name) => {
                return `<span class="inline-block text-[0.68rem] font-medium px-2 py-0.5 rounded-pill bg-matcha-100/70 dark:bg-matcha-700/25 text-matcha-600 dark:text-matcha-300 border border-matcha-200/60 dark:border-matcha-700/40 leading-none">${escapeHtml(name)}</span>`
              })
              .join('')
            tagsHtml = `<div class="flex flex-wrap gap-1.5" aria-label="Categories">${chips}</div>`
          }
        }

        // ── Summary snippet ───────────────────────────────────────────────
        let summaryHtml = ''
        if (summaryKey) {
          const raw = getPropertyPlainText(props[summaryKey])
          if (raw) {
            summaryHtml =
              `<p class="text-[0.82rem] leading-relaxed text-ink-400 dark:text-sage-500 line-clamp-2 flex-1">` +
              escapeHtml(raw) +
              `</p>`
          }
        }

        // ── Date (first date key) ─────────────────────────────────────────
        let dateHtml = ''
        if (dateKeys.length > 0) {
          const plain = getPropertyPlainText(props[dateKeys[0]])
          if (plain) {
            const iso = plain.split(' → ')[0]
            dateHtml = `<time class="text-[0.72rem] text-ink-400 dark:text-sage-600">${escapeHtml(formatDate(iso))}</time>`
          }
        }

        // ── Title link ────────────────────────────────────────────────────
        const titleLinkContent = slug
          ? `<a href="/${safeSlug}" id="course-card-${safeSlug}" class="block no-underline group/title">` +
            `<h2 class="font-serif font-medium text-[1rem] leading-snug text-balance text-ink-700 dark:text-sage-100 group-hover/title:text-matcha-600 dark:group-hover/title:text-matcha-300 transition-colors duration-200 line-clamp-2">` +
            safeTitle +
            `</h2></a>`
          : `<h2 class="font-serif font-medium text-[1rem] leading-snug text-balance text-ink-700 dark:text-sage-100 line-clamp-2">${safeTitle}</h2>`

        // ── Read CTA — mirrors CourseCard "Read →" ────────────────────────
        const readCta = slug
          ? `<a href="/${safeSlug}" aria-label="Read ${safeTitle}" ` +
            `class="flex items-center gap-1.5 flex-shrink-0 text-[0.75rem] font-medium text-matcha-500 dark:text-matcha-400 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-200 no-underline" tabindex="0">` +
            `<span>Read</span>` +
            `<span class="transition-transform duration-200 group-hover:translate-x-0.5">` +
            `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>` +
            `</span>` +
            `</a>`
          : ''

        // ── Assemble card — DOM mirrors CourseCard.tsx ────────────────────
        return (
          `<article class="group relative flex flex-col rounded-card ` +
          `bg-rice-paper-100 dark:bg-tea-slate-300 ` +
          `border border-rice-paper-400/70 dark:border-tea-slate-50/60 ` +
          `overflow-hidden shadow-zen-sm ` +
          `transition-all duration-300 ease-out ` +
          `hover:-translate-y-[3px] hover:shadow-zen hover:border-matcha-400/60 dark:hover:border-matcha-700/60 animate-fade-in">` +
          (slug
            ? `<a href="/${safeSlug}" tabindex="-1" aria-hidden="true" class="relative block">${coverHtml}</a>`
            : `<div class="relative">${coverHtml}</div>`) +
          `<div class="flex flex-col flex-1 p-4 gap-2.5">` +
          tagsHtml +
          titleLinkContent +
          summaryHtml +
          `<div class="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/30">` +
          `<div class="flex items-center gap-2 flex-wrap min-w-0">${dateHtml}</div>` +
          readCta +
          `</div>` +
          `</div>` +
          `</article>`
        )
      })
      .join('')

    // ── Section header + responsive grid ─────────────────────────────────
    return (
      `<div class="not-prose my-8">` +
      `<div class="flex items-center gap-2 mb-5">` +
      `<svg class="w-4 h-4 shrink-0 text-matcha-400 dark:text-matcha-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">` +
      `<rect x="3" y="3" width="18" height="18" rx="3" stroke-width="2"/><path d="M3 9h18" stroke-width="2"/>` +
      `</svg>` +
      `<span class="text-sm font-semibold text-ink-700 dark:text-sage-200 tracking-tight">${dbTitle}</span>` +
      `<span class="ml-auto text-[0.68rem] text-ink-400 dark:text-sage-500 tabular-nums">${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</span>` +
      `</div>` +
      `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">` +
      cardsHtml +
      `</div>` +
      `</div>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'child_page'>>('child_page', async (block) => {
    const pageInfo = block.page_info ? extractPageProperties(block.page_info) : null
    const titleText = pageInfo?.title || block.child_page?.title || 'Untitled Page'

    let slug = pageInfo?.slug
    if (!slug) {
      slug = slugifyText(titleText) || block.id.replace(/-/g, '')
    }

    const safeTitle = escapeHtml(titleText)
    const safeSlug = escapeHtml(slug)
    const iconEmoji = pageInfo?.icon || block.icon?.emoji || '📄'
    const summary = pageInfo?.summary ? escapeHtml(pageInfo.summary) : ''

    return (
      `<div class="not-prose my-4">` +
      `<a href="/${safeSlug}" class="group flex items-center gap-3.5 p-4 rounded-card ` +
      `bg-rice-paper-100 dark:bg-tea-slate-300 ` +
      `border border-rice-paper-400/70 dark:border-tea-slate-50/60 ` +
      `shadow-zen-sm transition-all duration-300 ease-out ` +
      `hover:-translate-y-[2px] hover:shadow-zen hover:border-matcha-400/60 dark:hover:border-matcha-700/60 no-underline">` +
      `<div class="w-10 h-10 rounded-pill bg-matcha-100/70 dark:bg-matcha-700/25 border border-matcha-200/60 dark:border-matcha-700/40 flex items-center justify-center shrink-0 text-xl transition-transform duration-300 group-hover:scale-110">` +
      `${escapeHtml(iconEmoji)}` +
      `</div>` +
      `<div class="flex-1 min-w-0">` +
      `<h4 class="font-serif font-medium text-[0.98rem] leading-snug text-ink-700 dark:text-sage-100 group-hover:text-matcha-600 dark:group-hover:text-matcha-300 transition-colors duration-200 truncate mb-0.5">` +
      `${safeTitle}` +
      `</h4>` +
      (summary ? `<p class="text-[0.8rem] text-ink-400 dark:text-sage-500 line-clamp-1 m-0">${summary}</p>` : '') +
      `</div>` +
      `<div class="flex items-center gap-1.5 text-[0.75rem] font-medium text-matcha-500 dark:text-matcha-400 group-hover:text-matcha-600 dark:group-hover:text-matcha-300 shrink-0">` +
      `<span>Open</span>` +
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>` +
      `</div>` +
      `</a>` +
      `</div>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'callout'>>('callout', async (block) => {
    const iconEmoji = block.callout?.icon?.emoji || block.callout?.icon?.external?.url || '💡'
    const textHtml = renderRichText(block.callout?.rich_text)
    const color = block.callout?.color || 'default'
    const textColorCls = getNotionTextColorClasses(color) || 'text-ink-700 dark:text-sage-200'

    let childrenHtml = ''
    if (block.has_children && block.children && block.children.length > 0) {
      childrenHtml = await renderBlocks(block.children as NotionRenderBlock[])
    }

    return (
      `<div class="not-prose my-6 p-4 rounded-r-card border-l-4 border-matcha-500 bg-stone-50/80 dark:bg-stone-800/40 ${textColorCls} flex items-start gap-3.5 shadow-zen-sm">` +
      `<span class="text-xl shrink-0 leading-none select-none mt-0.5">${escapeHtml(iconEmoji)}</span>` +
      `<div class="text-[0.93rem] leading-relaxed flex-1">${textHtml}${childrenHtml ? `<div class="mt-3">${childrenHtml}</div>` : ''}</div>` +
      `</div>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'heading_1'>>('heading_1', async (block) => {
    const textHtml = renderRichText(block.heading_1?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    if (block.heading_1?.is_toggleable) {
      return renderToggleHeadingPlaceholder(block, 1, block.heading_1, textHtml, anchorId)
    }
    return `<h1 id="${anchorId}" class="text-2xl sm:text-3xl font-semibold text-neutral-800 dark:text-neutral-100 mt-12 mb-6 tracking-tight">${textHtml}</h1>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'heading_2'>>('heading_2', async (block) => {
    const textHtml = renderRichText(block.heading_2?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    if (block.heading_2?.is_toggleable) {
      return renderToggleHeadingPlaceholder(block, 2, block.heading_2, textHtml, anchorId)
    }
    return `<h2 id="${anchorId}" class="text-xl sm:text-2xl font-medium text-neutral-800 dark:text-neutral-100 mt-10 mb-4">${textHtml}</h2>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'heading_3'>>('heading_3', async (block) => {
    const textHtml = renderRichText(block.heading_3?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    if (block.heading_3?.is_toggleable) {
      return renderToggleHeadingPlaceholder(block, 3, block.heading_3, textHtml, anchorId)
    }
    return `<h3 id="${anchorId}" class="text-lg sm:text-xl font-medium text-neutral-700 dark:text-neutral-200 mt-8 mb-3">${textHtml}</h3>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'heading_4'>>('heading_4', async (block) => {
    const textHtml = renderRichText(block.heading_4?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    if (block.heading_4?.is_toggleable) {
      return renderToggleHeadingPlaceholder(block, 4, block.heading_4, textHtml, anchorId)
    }
    return `<h4 id="${anchorId}" class="text-base sm:text-lg font-medium text-neutral-700 dark:text-neutral-200 mt-3 mb-1.5">${textHtml}</h4>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'heading_5'>>('heading_5', async (block) => {
    const textHtml = renderRichText(block.heading_5?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    return `<h5 id="${anchorId}" class="text-sm sm:text-base font-medium text-neutral-700 dark:text-neutral-200 mt-2 mb-1">${textHtml}</h5>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'heading_6'>>('heading_6', async (block) => {
    const textHtml = renderRichText(block.heading_6?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    return `<h6 id="${anchorId}" class="text-xs sm:text-sm font-medium text-neutral-600 dark:text-neutral-300 mt-2 mb-1">${textHtml}</h6>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'image'>>('image', async (block) => {
    const image = block.image
    const isNotionHosted = image?.type === 'file' || (!image?.type && Boolean(image?.file?.url))
    const src =
      image?.type === 'file'
        ? image.file?.url || ''
        : image?.type === 'external'
          ? image.external?.url || ''
          : image?.file?.url || image?.external?.url || ''
    if (!src) return ''
    const captionPlain = image?.caption?.map((t) => t.plain_text || '').join('') || ''
    const captionHtml = image?.caption && image.caption.length > 0 ? renderRichText(image.caption) : ''
    const alt = escapeHtml(captionPlain)
    const imageIdAttr = isNotionHosted && block.id ? ` data-notion-image-id="${escapeHtml(block.id)}"` : ''

    return (
      `<figure class="not-prose my-10 flex flex-col items-center w-full">` +
      `<img` +
      ` src="${escapeHtml(src)}"` +
      imageIdAttr +
      ` alt="${alt || 'Image'}"` +
      ` class="rounded-2xl border border-rice-paper-400/50 dark:border-tea-slate-50/20 max-w-full h-auto shadow-sm block cursor-zoom-in notion-zoomable"` +
      ` loading="lazy"` +
      ` decoding="async"` +
      ` data-notion-zoom` +
      `/>` +
      (captionHtml
        ? `<figcaption class="mt-3 text-sm italic text-neutral-500 dark:text-neutral-400 text-center max-w-2xl">${captionHtml}</figcaption>`
        : '') +
      `</figure>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'video'>>('video', async (block) => {
    const video = block.video
    if (!video) return ''

    const type = video.type
    const url = type === 'external' ? video.external?.url : video.file?.url
    if (!url) return ''

    const captionHtml = video.caption && video.caption.length > 0 ? renderRichText(video.caption) : ''
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be')

    if (isYouTube) {
      const videoId = url.split('v=')[1]?.split('&')[0] || url.split('youtu.be/')[1]?.split('?')[0]
      const embedUrl = escapeHtml(`https://www.youtube.com/embed/${videoId}`)
      const title = escapeHtml(video.caption?.map((t) => t.plain_text || '').join('') || 'YouTube video player')

      return (
        `<figure class="not-prose my-6 w-full flex flex-col items-center">` +
        `<div class="relative w-full" style="padding-bottom:56.25%">` +
        `<iframe` +
        ` src="${embedUrl}"` +
        ` title="${title}"` +
        ` allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"` +
        ` allowfullscreen` +
        ` class="absolute inset-0 w-full h-full rounded-xl border border-neutral-200/60 dark:border-neutral-800/60 shadow-sm"` +
        `></iframe>` +
        `</div>` +
        (captionHtml ? `<figcaption class="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500 italic">${captionHtml}</figcaption>` : '') +
        `</figure>`
      )
    }

    // Direct Notion file upload
    const safeSrc = escapeHtml(url)
    return (
      `<figure class="not-prose my-6 w-full">` +
      `<video controls class="w-full rounded-xl border border-neutral-200/60 dark:border-neutral-800/60 shadow-sm">` +
      `<source src="${safeSrc}" type="video/mp4" />` +
      `Your browser does not support the video tag.` +
      `</video>` +
      (captionHtml ? `<figcaption class="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500 italic">${captionHtml}</figcaption>` : '') +
      `</figure>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'bulleted_list_item'>>('bulleted_list_item', async (block) => {
    const text = renderRichText(block.bulleted_list_item?.rich_text)
    let childrenHtml = ''
    if (block.has_children && block.children && block.children.length > 0) {
      childrenHtml = await renderBlocks(block.children as NotionRenderBlock[])
    }
    return `<li class="flex items-start gap-2.5 my-1.5 group">
    <span class="text-matcha-500/70 dark:text-matcha-400/60 mt-[3px] select-none text-xs shrink-0">
      •
    </span>
    <div class="flex-1 text-ink-700 dark:text-sage-200 leading-relaxed">
      <span class="whitespace-pre-wrap">${text}</span>
      ${childrenHtml ? `<div class="mt-2 ml-1 border-l border-rice-paper-400/60 dark:border-tea-slate-50/40 pl-4">${childrenHtml}</div>` : ''}
    </div>
  </li>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'numbered_list_item'>>('numbered_list_item', async (block) => {
    const text = renderRichText(block.numbered_list_item?.rich_text)
    let childrenHtml = ''
    if (block.has_children && block.children && block.children.length > 0) {
      childrenHtml = await renderBlocks(block.children as NotionRenderBlock[])
    }
    const num = block.list_index ? `${block.list_index}.` : '1.'
    return `<li class="flex items-start gap-2.5 my-1.5 group">
    <span class="text-ink-400 dark:text-sage-500 mt-[2px] select-none text-sm shrink-0 min-w-[1.25rem] text-right font-mono">
      ${num}
    </span>
    <div class="flex-1 text-ink-700 dark:text-sage-200 leading-relaxed">
      <span class="whitespace-pre-wrap">${text}</span>
      ${childrenHtml ? `<div class="mt-2 ml-1 border-l border-rice-paper-400/60 dark:border-tea-slate-50/40 pl-4">${childrenHtml}</div>` : ''}
    </div>
  </li>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'toggle'>>('toggle', async (block) => {
    try {
      const togglePlainText = (block.toggle?.rich_text || [])
        .map((t) => t.plain_text || '')
        .join('')
        .trim()
      if (togglePlainText === '[slider]') return ''

      const titleHtml = renderRichText(block.toggle?.rich_text) || 'Toggle'
      const color = block.toggle?.color || 'default'
      const dynamicClasses = getToggleColorClasses(color)

      const props = {
        blockId: block.id,
        titleHtml,
        color,
        dynamicClasses,
        hasChildren: Boolean(block.has_children),
      }

      return `<div data-notion-component="NotionToggleBlock" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
    } catch (err: unknown) {
      console.error('[toggle] render error:', err)
      return ''
    }
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'custom_slider'>>('custom_slider', async (block) => {
    const images = block.images || []
    if (images.length === 0) return ''

    const props = { images }
    return `<div data-notion-component="ImageSlider" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'paragraph'>>('paragraph', async (block) => {
    const textHtml = renderRichText(block.paragraph?.rich_text)
    if (!textHtml) return ''
    return `<p class="mb-4 text-[0.98rem] leading-relaxed text-neutral-700 dark:text-neutral-300">${textHtml}</p>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'quote'>>('quote', async (block) => {
    const textHtml = renderRichText(block.quote?.rich_text)
    let childrenHtml = ''
    if (block.has_children && block.children && block.children.length > 0) {
      childrenHtml = await renderBlocks(block.children as NotionRenderBlock[])
    }
    return `<blockquote class="my-5 border-l-2 border-matcha-500 dark:border-matcha-400 pl-5 pr-4 py-3.5 font-serif italic text-[0.96rem] leading-[1.8] text-ink-700 dark:text-sage-100 bg-rice-paper-200/60 dark:bg-tea-slate-200/50 rounded-r-[6px] border-y border-r border-transparent dark:border-tea-slate-50/30">
      ${textHtml}
      ${childrenHtml ? `<div class="mt-3 not-italic font-sans text-[0.88rem] text-ink-500 dark:text-sage-400 font-normal">${childrenHtml}</div>` : ''}
    </blockquote>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'column_list'>>('column_list', async (block) => {
    let childrenHtml = ''
    if (
      (block.has_children || (block.children && block.children.length > 0)) &&
      block.children &&
      block.children.length > 0
    ) {
      childrenHtml = await renderBlocks(block.children as NotionRenderBlock[])
    }
    return `<div class="flex flex-col md:flex-row gap-4 md:gap-6 my-6 w-full items-start">${childrenHtml}</div>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'column'>>('column', async (block) => {
    let childrenHtml = ''
    if (
      (block.has_children || (block.children && block.children.length > 0)) &&
      block.children &&
      block.children.length > 0
    ) {
      childrenHtml = await renderBlocks(block.children as NotionRenderBlock[])
    }
    return `<div class="flex-1 min-w-0 w-full">${childrenHtml}</div>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'code'>>('code', async (block) => {
    const codeText = block.code?.rich_text?.map((t) => t.plain_text || '').join('') || ''
    const language = block.code?.language || ''
    const captionHtml =
      block.code?.caption && block.code.caption.length > 0 ? renderRichText(block.code.caption) : ''

    const props = { codeText, language, caption: captionHtml }
    return `<div data-notion-component="NotionCodeBlock" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'table_row'>>('table_row', async (block) => {
    const cells = block.table_row?.cells || []
    const cellsHtml = cells
      .map((cell) => {
        const cellText = renderRichText(cell)
        return `<td class="px-4 py-2.5 text-sm text-neutral-700 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700">${cellText}</td>`
      })
      .join('')
    return `<tr class="border-b border-neutral-200 dark:border-neutral-700">${cellsHtml}</tr>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer<RendererBlock<'table'>>('table', async (block) => {
    let rowsHtml = ''
    if (block.has_children && block.children && block.children.length > 0) {
      rowsHtml = await renderBlocks(block.children as NotionRenderBlock[])
    }
    const hasHeader = block.table?.has_column_header || false
    if (hasHeader && rowsHtml) {
      rowsHtml = rowsHtml.replace(
        /^<tr([^>]*)>([\s\S]*?)<\/tr>/,
        (_match, trAttrs: string, innerTd: string) => {
          const thInner = innerTd.replace(
            /<td([^>]*)>([\s\S]*?)<\/td>/g,
            '<th$1 class="px-4 py-2.5 text-left text-sm font-semibold text-neutral-800 dark:text-neutral-100 bg-neutral-100/80 dark:bg-neutral-800/80 border border-neutral-200 dark:border-neutral-700">$2</th>'
          )
          return `<tr${trAttrs} class="bg-neutral-100/80 dark:bg-neutral-800/80 font-semibold">${thInner}</tr>`
        }
      )
    }
    return `<div class="not-prose my-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700 shadow-zen-sm"><table class="w-full border-collapse text-left min-w-full divide-y divide-neutral-200 dark:divide-neutral-700"><tbody class="divide-y divide-neutral-200 dark:divide-neutral-700 bg-white dark:bg-neutral-900/40">${rowsHtml}</tbody></table></div>`
  })
)

// ── Block Hydration & Rendering API ──────────────────────────────────────────

export async function getChildBlocks(
  blockId: string,
  locale: string = DEFAULT_LOCALE
): Promise<NotionRenderBlock[]> {
  const targetLocale = normalizeLocale(locale)
  const blocks: NotionBlockLike[] = []
  let cursor: string | undefined = undefined
  while (true) {
    const { results, next_cursor, has_more } = await fetchChildrenList(blockId, cursor)
    const rawBlocks = results as unknown as NotionBlockLike[]

    const processedBlocks = await Promise.all(
      rawBlocks.map(async (block): Promise<NotionBlockLike> => {
        const isLinkedDb =
          block.type === 'link_to_page' &&
          block.link_to_page?.type === 'database_id' &&
          Boolean(block.link_to_page?.database_id)
        const isLinkedPage =
          block.type === 'link_to_page' &&
          block.link_to_page?.type === 'page_id' &&
          Boolean(block.link_to_page?.page_id)

        if (block.type === 'child_database' || isLinkedDb) {
          const targetDbId =
            isLinkedDb && block.link_to_page?.database_id ? block.link_to_page.database_id : block.id
          try {
            const dbInfo = await fetchDatabase(targetDbId)
            const resolvedDsId = dbInfo.data_sources?.[0]?.id || null
            const queryTargetId = resolvedDsId || targetDbId
            const dsFlag: QueryDatabaseOptions = resolvedDsId
              ? { __isDataSourceId: true, __databaseId: targetDbId }
              : {}
            const dbTitlePlain = Array.isArray(dbInfo?.title)
              ? dbInfo.title.map((t) => t.plain_text || '').join('').trim()
              : ''
            if (isLinkedDb) {
              block.type = 'child_database'
              block.child_database = {
                title: dbTitlePlain || 'Course Modules',
              }
            } else if (!block.child_database?.title && dbTitlePlain) {
              block.child_database = { title: dbTitlePlain }
            }

            let dbRes: { results: NotionPageLike[] }
            try {
              dbRes = await queryDatabaseAll(queryTargetId, {
                ...dsFlag,
                sorts: [{ property: 'Order', direction: 'ascending' }],
              })
            } catch {
              dbRes = await queryDatabaseAll(queryTargetId, dsFlag)
            }

            const rawRows = dbRes.results || []
            const publishedRows = rawRows.filter((row) => {
              const props = row.properties || {}
              const statusProp = props.Status || props.status || props.State || props.state
              if (!statusProp) return true
              const val =
                statusProp.status?.name ||
                statusProp.select?.name ||
                (typeof statusProp.checkbox === 'boolean'
                  ? statusProp.checkbox
                    ? 'Published'
                    : 'Draft'
                  : '')
              if (!val) return true
              const s = val.toLowerCase()
              return s !== 'draft' && s !== 'archived' && s !== 'hidden'
            })

            const hasAnyLocaleProp = publishedRows.some((row) =>
              Boolean(findPropertyByName(row.properties || {}, ['Locale', 'locale']))
            )
            const localeFilteredRows = hasAnyLocaleProp
              ? publishedRows.filter((row) => {
                  const rowLocaleProp = findPropertyByName(row.properties || {}, ['Locale', 'locale'])
                  const rowLocale = normalizeLocale(getPropertyPlainText(rowLocaleProp))
                  return rowLocale === targetLocale
                })
              : publishedRows

            block.database_rows = localeFilteredRows.sort((a, b) => {
              const orderA = a.properties?.Order?.number ?? a.properties?.order?.number ?? 999
              const orderB = b.properties?.Order?.number ?? b.properties?.order?.number ?? 999
              return orderA - orderB
            })
          } catch (err: unknown) {
            console.error(`Failed to fetch child_database ${targetDbId}:`, err)
            if (isLinkedDb) {
              block.type = 'child_database'
              block.child_database = { title: 'Database' }
            }
            block.database_rows = []
          }
        } else if (block.type === 'child_page' || isLinkedPage) {
          const targetPageId =
            isLinkedPage && block.link_to_page?.page_id ? block.link_to_page.page_id : block.id
          try {
            const pageInfo = await fetchPage(targetPageId)
            block.page_info = pageInfo
            if (isLinkedPage) {
              const extracted = extractPageProperties(pageInfo)
              block.type = 'child_page'
              block.id = targetPageId
              block.child_page = { title: extracted.title || 'Untitled Page' }
            }
          } catch (err: unknown) {
            console.error(`Failed to fetch child_page ${targetPageId}:`, err)
          }
        }

        const hasChildren =
          Boolean(block.has_children) ||
          block.type === 'column_list' ||
          block.type === 'column' ||
          block.type === 'quote' ||
          block.type === 'callout'

        if (block.type === 'toggle') {
          const togglePlainText = (block.toggle?.rich_text || [])
            .map((t) => t.plain_text || '')
            .join('')
            .trim()

          if (togglePlainText === '[slider]') {
            const childBlocks = (await getChildBlocks(block.id, targetLocale)) as unknown as NotionBlockLike[]

            const images: NotionSliderImage[] = childBlocks
              .filter((child) => child.type === 'image')
              .map((child) => {
                const img = child.image
                const isNotionHosted = img?.type === 'file' || (!img?.type && Boolean(img?.file?.url))
                const url =
                  img?.type === 'file'
                    ? img.file?.url || ''
                    : img?.type === 'external'
                      ? img.external?.url || ''
                      : img?.file?.url || img?.external?.url || ''

                const caption = (img?.caption || []).map((t) => t.plain_text || '').join('')

                return {
                  url,
                  caption,
                  blockId: isNotionHosted && child.id ? child.id : null,
                }
              })
              .filter((img) => Boolean(img.url))

            block.type = 'custom_slider'
            block.images = images

            return block
          }
        }

        const headingPayload = block.type?.startsWith('heading_') ? block[block.type] : undefined
        const isToggleHeading = Boolean(
          headingPayload &&
            typeof headingPayload === 'object' &&
            'is_toggleable' in headingPayload &&
            (headingPayload as { is_toggleable?: boolean }).is_toggleable
        )

        if (
          hasChildren &&
          block.type !== 'toggle' &&
          !isToggleHeading &&
          block.type !== 'child_page' &&
          block.type !== 'child_database'
        ) {
          block.children = (await getChildBlocks(block.id, targetLocale)) as unknown as NotionBlockLike[]
        }
        return block
      })
    )

    blocks.push(...processedBlocks)

    if (!has_more || !next_cursor) break
    cursor = next_cursor
  }
  return blocks as unknown as NotionRenderBlock[]
}

/**
 * Renders an array of Notion blocks to HTML, correctly grouping consecutive
 * list items. Works around the @notion-render/client extension bug where
 * non-list blocks following a list group are silently dropped.
 */
export async function renderBlocks(blocks: NotionRenderBlock[]): Promise<string> {
  const parts: string[] = []
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i] as unknown as NotionBlockLike

    // Group consecutive bulleted_list_item blocks
    if (block.type === 'bulleted_list_item') {
      const group: NotionBlockLike[] = []
      while (
        i < blocks.length &&
        (blocks[i] as unknown as NotionBlockLike).type === 'bulleted_list_item'
      ) {
        group.push(blocks[i] as unknown as NotionBlockLike)
        i++
      }
      const itemsHtml = await Promise.all(
        group.map((b) => renderer.render(b as unknown as NotionRenderClientBlock))
      )
      parts.push(`<ul class="pl-2 sm:pl-4 space-y-2 my-5">${itemsHtml.join('')}</ul>`)
      continue
    }

    // Group consecutive numbered_list_item blocks
    if (block.type === 'numbered_list_item') {
      const group: NotionBlockLike[] = []
      while (
        i < blocks.length &&
        (blocks[i] as unknown as NotionBlockLike).type === 'numbered_list_item'
      ) {
        group.push(blocks[i] as unknown as NotionBlockLike)
        i++
      }
      const itemsHtml = await Promise.all(
        group.map((b, index) => {
          b.list_index = index + 1
          return renderer.render(b as unknown as NotionRenderClientBlock)
        })
      )
      parts.push(`<ol class="pl-2 sm:pl-4 space-y-2 my-5">${itemsHtml.join('')}</ol>`)
      continue
    }

    // All other blocks rendered individually via the registered renderer
    parts.push(await renderer.render(block as unknown as NotionRenderClientBlock))
    i++
  }
  return parts.join('')
}

export const getNotionPageData = withRequestCache(async function getNotionPageData(
  pageId: string,
  locale: string = DEFAULT_LOCALE
): Promise<{ html: string; blocks: NotionRenderBlock[] }> {
  const blocks = await getChildBlocks(pageId, locale)
  const html = await renderBlocks(blocks)
  return { html, blocks }
})
