import { cache } from 'react'
import { Client } from "@notionhq/client"
import { NotionRenderer, createBlockRenderer } from "@notion-render/client"
import hljsPlugin from "@notion-render/hljs-plugin"
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale } from './locales'

const CACHE_TTL = 50 * 60 * 1000 // 50 minutes to safely avoid Notion's 1-hour S3 expiration
const MAPPINGS_CACHE_TTL = 10 * 60 * 1000 // 10 minutes cache for dynamic translation mappings
const MAPPINGS_CACHE_KEY = 'translation-mapping-db'
const DEFAULT_MAPPING_DB_ID = '415ac39b-0efb-8050-9ab4-ecb760e41cc5'

function getCache(key, maxAge = CACHE_TTL) {
  if (!globalThis.__notionCache) globalThis.__notionCache = new Map()
  const cached = globalThis.__notionCache.get(key)
  if (cached && Date.now() - cached.timestamp < maxAge) {
    return cached.data
  }
  return null
}

function setCache(key, data) {
  if (!globalThis.__notionCache) globalThis.__notionCache = new Map()
  globalThis.__notionCache.set(key, { timestamp: Date.now(), data })
}

const notion = new Client({
  auth: process.env.NOTION_API_SECRET || process.env.NOTION_TOKEN || process.env.NOTION_TOKEN_V2,
})

const renderer = new NotionRenderer({
  client: notion,
})
renderer.use(hljsPlugin({}))

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Formats an ISO date string into a human-readable format, e.g. "06 Aug 2026".
 */
function formatDate(isoStr) {
  if (!isoStr) return ''
  try {
    return new Date(isoStr).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return isoStr
  }
}

const NOTION_TEXT_COLORS = {
  gray: 'text-neutral-600 dark:text-neutral-400',
  gray_background: 'text-neutral-600 dark:text-neutral-400',
  brown: 'text-amber-800 dark:text-amber-300',
  brown_background: 'text-amber-800 dark:text-amber-300',
  orange: 'text-orange-700 dark:text-orange-300',
  orange_background: 'text-orange-700 dark:text-orange-300',
  yellow: 'text-yellow-700 dark:text-yellow-300',
  yellow_background: 'text-yellow-700 dark:text-yellow-300',
  green: 'text-green-700 dark:text-green-300',
  green_background: 'text-green-700 dark:text-green-300',
  blue: 'text-blue-700 dark:text-blue-300',
  blue_background: 'text-blue-700 dark:text-blue-300',
  purple: 'text-purple-700 dark:text-purple-300',
  purple_background: 'text-purple-700 dark:text-purple-300',
  pink: 'text-pink-700 dark:text-pink-300',
  pink_background: 'text-pink-700 dark:text-pink-300',
  red: 'text-red-700 dark:text-red-300',
  red_background: 'text-red-700 dark:text-red-300',
}

function getNotionTextColorClasses(color) {
  if (!color || color === 'default') return ''
  return NOTION_TEXT_COLORS[color] || ''
}

/**
 * Renders an array of Notion rich_text objects into styled HTML string with support
 * for bold, italic, strikethrough, underline, code, and links.
 */
function renderRichText(richTextArray) {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return ''
  return richTextArray.map(t => {
    let content = escapeHtml(t.plain_text || '')
    if (!content) return ''
    content = content.replace(/\r\n|\n/g, '<br />')
    if (t.href) {
      content = `<a href="${escapeHtml(t.href)}" target="_blank" rel="noopener noreferrer" class="text-matcha-600 dark:text-matcha-300 hover:underline">${content}</a>`
    }
    if (t.annotations?.bold) {
      content = `<strong class="font-semibold">${content}</strong>`
    }
    if (t.annotations?.italic) {
      content = `<em class="italic">${content}</em>`
    }
    if (t.annotations?.strikethrough) {
      content = `<s class="line-through">${content}</s>`
    }
    if (t.annotations?.underline) {
      content = `<u class="underline">${content}</u>`
    }
    if (t.annotations?.color && t.annotations.color !== 'default') {
      const textColor = getNotionTextColorClasses(t.annotations.color)
      if (textColor) {
        content = `<span class="${textColor}">${content}</span>`
      }
    }
    if (t.annotations?.code) {
      content = `<code class="text-rose-500 bg-rose-50/80 dark:text-matcha-300 dark:bg-tea-slate-50/80 dark:border dark:border-tea-slate-50/50 px-1.5 py-0.5 rounded-md font-mono text-[0.9em]">${content}</code>`
    }
    return content
  }).join('')
}

/**
 * Returns a plain-text value for a Notion property.
 * Used for isEmpty checks and fallback rendering.
 */
function getPropertyPlainText(prop) {
  if (!prop) return ''
  const type = prop.type
  switch (type) {
    case 'title':
      return prop.title?.map(t => t.plain_text).join('') || ''
    case 'rich_text':
      return prop.rich_text?.map(t => t.plain_text).join('') || ''
    case 'select':
      return prop.select?.name || ''
    case 'multi_select':
      return prop.multi_select?.map(item => item.name).join(', ') || ''
    case 'number':
      return prop.number !== undefined && prop.number !== null ? String(prop.number) : ''
    case 'date':
      if (!prop.date) return ''
      return prop.date.end ? `${prop.date.start} → ${prop.date.end}` : prop.date.start
    case 'url':
      return prop.url || ''
    case 'checkbox':
      return prop.checkbox !== undefined ? (prop.checkbox ? '✓' : '✗') : ''
    case 'status':
      return prop.status?.name || ''
    case 'email':
      return prop.email || ''
    case 'phone_number':
      return prop.phone_number || ''
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string || ''
      if (prop.formula?.type === 'number') return prop.formula.number !== null ? String(prop.formula.number) : ''
      if (prop.formula?.type === 'boolean') return prop.formula.boolean ? '✓' : '✗'
      if (prop.formula?.type === 'date') return prop.formula.date?.start || ''
      return ''
    case 'created_time':
      return prop.created_time || ''
    case 'last_edited_time':
      return prop.last_edited_time || ''
    default:
      if (Array.isArray(prop[type])) {
        return prop[type].map(t => t.plain_text || t.name || '').join(', ')
      }
      if (typeof prop[type] === 'object' && prop[type] !== null) {
        return prop[type].name || prop[type].plain_text || ''
      }
      return prop[type] !== undefined && prop[type] !== null ? String(prop[type]) : ''
  }
}

/**
 * Notion color name → Tailwind badge colour classes.
 * Falls back to a neutral stone style if the color is unknown.
 */
const NOTION_BADGE_COLORS = {
  default: 'bg-stone-100 text-stone-700 border-stone-200/70 dark:bg-stone-800 dark:text-stone-300 dark:border-stone-700/60',
  gray: 'bg-neutral-100 text-neutral-600 border-neutral-200/70 dark:bg-neutral-800 dark:text-neutral-400 dark:border-neutral-700/60',
  brown: 'bg-amber-50 text-amber-800 border-amber-200/70 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/50',
  orange: 'bg-orange-50 text-orange-700 border-orange-200/70 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700/50',
  yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200/70 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700/50',
  green: 'bg-green-50 text-green-700 border-green-200/70 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700/50',
  blue: 'bg-blue-50 text-blue-700 border-blue-200/70 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/50',
  purple: 'bg-purple-50 text-purple-700 border-purple-200/70 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700/50',
  pink: 'bg-pink-50 text-pink-700 border-pink-200/70 dark:bg-pink-900/30 dark:text-pink-300 dark:border-pink-700/50',
  red: 'bg-red-50 text-red-700 border-red-200/70 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/50',
}

function badgeClasses(color) {
  return NOTION_BADGE_COLORS[color] || NOTION_BADGE_COLORS.default
}


/**
 * Renders a single Notion property value as an HTML string.
 * @param {object} prop     - The Notion property object.
 * @param {object} row      - The full Notion page object (used for title slug resolution).
 * @returns {string}        - An HTML string for the table cell content.
 */
function renderCellContent(prop, row) {
  if (!prop) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'

  const type = prop.type

  // ── Title: interactive link ──────────────────────────────────────────────
  if (type === 'title') {
    const titleText = prop.title?.map(t => t.plain_text).join('') || ''
    if (!titleText) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'

    // Resolve slug: explicit Slug prop → slugified title → page id
    const props = row.properties || {}
    const slugProp = props.Slug || props.slug
    let slug = slugProp?.rich_text?.map(t => t.plain_text).join('') || ''
    if (!slug) {
      slug = titleText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || row.id.replace(/-/g, '')
    }

    const icon = row.icon?.emoji ? `<span class="mr-1.5" aria-hidden="true">${escapeHtml(row.icon.emoji)}</span>` : ''
    const safeTitle = escapeHtml(titleText)
    const safeSlug = escapeHtml(slug)

    return (
      `<a href="/${safeSlug}" class="inline-flex items-center gap-0.5 font-medium text-ink-700 dark:text-sage-200 hover:text-matcha-500 dark:hover:text-matcha-300 hover:underline underline-offset-2 transition-colors duration-150">` +
      `${icon}<span>${safeTitle}</span>` +
      `</a>`
    )
  }

  // ── Multi-select: pill badges ────────────────────────────────────────────
  if (type === 'multi_select') {
    const items = prop.multi_select || []
    if (!items.length) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
    return items
      .map(item => {
        const cls = badgeClasses(item.color)
        return `<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-md border mr-1 last:mr-0 ${cls}">${escapeHtml(item.name)}</span>`
      })
      .join('')
  }

  // ── Select: single pill badge ────────────────────────────────────────────
  if (type === 'select') {
    const item = prop.select
    if (!item) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
    const cls = badgeClasses(item.color)
    return `<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-md border ${cls}">${escapeHtml(item.name)}</span>`
  }

  // ── Status: single pill badge (same treatment as select) ─────────────────
  if (type === 'status') {
    const item = prop.status
    if (!item) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
    const cls = badgeClasses(item.color)
    return `<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-md border ${cls}">${escapeHtml(item.name)}</span>`
  }

  // ── Dates: human-friendly ────────────────────────────────────────────────
  if (type === 'date') {
    if (!prop.date) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
    const start = formatDate(prop.date.start)
    const end = prop.date.end ? formatDate(prop.date.end) : null
    const str = end ? `${start} → ${end}` : start
    return `<span class="text-sm text-neutral-600 dark:text-neutral-400 tabular-nums">${escapeHtml(str)}</span>`
  }

  if (type === 'created_time') {
    if (!prop.created_time) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
    return `<span class="text-sm text-neutral-600 dark:text-neutral-400 tabular-nums">${escapeHtml(formatDate(prop.created_time))}</span>`
  }

  if (type === 'last_edited_time') {
    if (!prop.last_edited_time) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
    return `<span class="text-sm text-neutral-600 dark:text-neutral-400 tabular-nums">${escapeHtml(formatDate(prop.last_edited_time))}</span>`
  }

  // ── URL ─────────────────────────────────────────────────────────────────
  if (type === 'url') {
    if (!prop.url) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
    const safe = escapeHtml(prop.url)
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="text-matcha-500 dark:text-matcha-300 hover:underline underline-offset-2 text-sm transition-colors duration-150">${safe}</a>`
  }

  // ── Checkbox ────────────────────────────────────────────────────────────
  if (type === 'checkbox') {
    if (prop.checkbox === undefined) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
    return prop.checkbox
      ? `<span class="inline-flex items-center justify-center w-4.5 h-4.5 rounded border-2 border-matcha-400 bg-matcha-400 text-white text-xs" title="Yes">✓</span>`
      : `<span class="inline-flex items-center justify-center w-4.5 h-4.5 rounded border-2 border-neutral-300 dark:border-neutral-600 text-neutral-300 dark:text-neutral-600 text-xs" title="No">✗</span>`
  }

  // ── Fallback: plain text ─────────────────────────────────────────────────
  const plainText = getPropertyPlainText(prop)
  if (!plainText) return '<span class="text-neutral-300 dark:text-neutral-600 select-none">—</span>'
  return `<span>${escapeHtml(plainText)}</span>`
}

renderer.addBlockRenderer(
  createBlockRenderer("child_database", async (block) => {
    const dbTitle = escapeHtml(block.child_database?.title || "Database")
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

    // ── Build each card — mirrors CourseCard.js exactly ─────────────────
    const cardsHtml = rows.map((row) => {
      const props = row.properties || {}

      // ── Resolve title + slug ──────────────────────────────────────────
      let titleText = ''
      let slug = ''
      if (titleKey) {
        const titleProp = props[titleKey]
        titleText = titleProp?.title?.map(t => t.plain_text).join('') || ''
        const slugProp = props.Slug || props.slug
        slug = slugProp?.rich_text?.map(t => t.plain_text).join('') || ''
        if (!slug && titleText) {
          slug = titleText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
        }
        if (!slug) slug = row.id.replace(/-/g, '')
      }
      const safeSlug = escapeHtml(slug)
      const safeTitle = escapeHtml(titleText) || '—'

      // ── Icon emoji ────────────────────────────────────────────────────
      const iconEmoji = row.icon?.emoji ? escapeHtml(row.icon.emoji) : ''

      // ── Cover — mirrors CardCover in CourseCard.js ────────────────────
      //   aspect-[16/7], overflow-hidden, group-hover:scale-[1.03]
      //   Fallback: organic matcha gradient + emoji or wabi-sabi blob SVG
      const coverUrl = row.cover?.external?.url || row.cover?.file?.url || null
      let coverHtml
      if (coverUrl) {
        coverHtml = (
          `<div class="aspect-[16/7] overflow-hidden bg-rice-paper-200 dark:bg-tea-slate-200 flex-shrink-0 relative">` +
          `<img src="${escapeHtml(coverUrl)}" alt="" loading="lazy" decoding="async" ` +
          `class="object-cover w-full h-full transition-transform duration-500 group-hover:scale-[1.03]" />` +
          `</div>`
        )
      } else {
        const inner = iconEmoji
          ? `<span class="text-4xl select-none transition-transform duration-300 group-hover:scale-110" aria-hidden="true">${iconEmoji}</span>`
          : (
            `<svg width="60" height="60" viewBox="0 0 60 60" fill="none" style="opacity:0.3" aria-hidden="true">` +
            `<path d="M30 8 C40 8 52 16 52 30 C52 44 44 52 30 52 C16 52 8 44 8 30 C8 16 20 8 30 8 Z" fill="rgba(122,139,105,0.5)"/>` +
            `<path d="M30 16 C36 16 44 22 44 30 C44 38 38 44 30 44 C22 44 16 38 16 30 C16 22 24 16 30 16 Z" fill="rgba(175,201,163,0.6)"/>` +
            `</svg>`
          )
        coverHtml = (
          `<div class="aspect-[16/7] overflow-hidden flex-shrink-0 flex items-center justify-center" ` +
          `style="background:linear-gradient(135deg,rgba(122,139,105,0.12) 0%,rgba(174,201,163,0.18) 60%,rgba(234,230,223,0.10) 100%)" aria-hidden="true">` +
          inner + `</div>`
        )
      }

      // ── Tag chips — mirrors TagChip in CourseCard.js ──────────────────
      //   inline-block text-[0.68rem] font-medium px-2 py-0.5 rounded-pill bg-matcha-100/70 dark:bg-matcha-700/25 text-matcha-600 dark:text-matcha-300 border border-matcha-200/60 dark:border-matcha-700/40 leading-none
      let tagsHtml = ''
      if (badgeKeys.length > 0) {
        const allBadges = badgeKeys.flatMap((k) => {
          const p = props[k]
          if (!p) return []
          if (p.type === 'multi_select') return (p.multi_select || []).map(item => item.name)
          if (p.type === 'select' && p.select) return [p.select.name]
          if (p.type === 'status' && p.status) return [p.status.name]
          return []
        }).filter(Boolean)

        if (allBadges.length > 0) {
          const chips = allBadges.slice(0, 3).map((name) => {
            return `<span class="inline-block text-[0.68rem] font-medium px-2 py-0.5 rounded-pill bg-matcha-100/70 dark:bg-matcha-700/25 text-matcha-600 dark:text-matcha-300 border border-matcha-200/60 dark:border-matcha-700/40 leading-none">${escapeHtml(name)}</span>`
          }).join('')
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
            escapeHtml(raw) + `</p>`
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
        ? (
          `<a href="/${safeSlug}" id="course-card-${safeSlug}" class="block no-underline group/title">` +
          `<h2 class="font-serif font-medium text-[1rem] leading-snug text-balance text-ink-700 dark:text-sage-100 group-hover/title:text-matcha-600 dark:group-hover/title:text-matcha-300 transition-colors duration-200 line-clamp-2">` +
          safeTitle + `</h2></a>`
        )
        : `<h2 class="font-serif font-medium text-[1rem] leading-snug text-balance text-ink-700 dark:text-sage-100 line-clamp-2">${safeTitle}</h2>`

      // ── Read CTA — mirrors CourseCard "Read →" ────────────────────────
      const readCta = slug
        ? (
          `<a href="/${safeSlug}" aria-label="Read ${safeTitle}" ` +
          `class="flex items-center gap-1.5 flex-shrink-0 text-[0.75rem] font-medium text-matcha-500 dark:text-matcha-400 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-200 no-underline" tabindex="0">` +
          `<span>Read</span>` +
          `<span class="transition-transform duration-200 group-hover:translate-x-0.5">` +
          `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>` +
          `</span>` +
          `</a>`
        )
        : ''

      // ── Assemble card — DOM mirrors CourseCard.js ─────────────────────
      return (
        `<article class="group relative flex flex-col rounded-card ` +
        `bg-rice-paper-100 dark:bg-tea-slate-300 ` +
        `border border-rice-paper-400/70 dark:border-tea-slate-50/60 ` +
        `overflow-hidden shadow-zen-sm ` +
        `transition-all duration-300 ease-out ` +
        `hover:-translate-y-[3px] hover:shadow-zen hover:border-matcha-400/60 dark:hover:border-matcha-700/60 animate-fade-in">` +

        (slug
          ? `<a href="/${safeSlug}" tabindex="-1" aria-hidden="true" class="relative block">${coverHtml}</a>`
          : `<div class="relative">${coverHtml}</div>`
        ) +

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
    }).join('')

    // ── Section header + responsive grid ─────────────────────────────────
    //   grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 my-8 not-prose
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
  createBlockRenderer("child_page", async (block) => {
    const pageInfo = block.page_info ? extractPageProperties(block.page_info) : null
    const titleText = pageInfo?.title || block.child_page?.title || "Untitled Page"

    let slug = pageInfo?.slug
    if (!slug) {
      slug = titleText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || block.id.replace(/-/g, '')
    }

    const safeTitle = escapeHtml(titleText)
    const safeSlug = escapeHtml(slug)
    const iconEmoji = pageInfo?.icon || block.icon?.emoji || "📄"
    const summary = pageInfo?.summary ? escapeHtml(pageInfo.summary) : ""

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
  createBlockRenderer("callout", async (block) => {
    const iconEmoji = block.callout?.icon?.emoji || block.callout?.icon?.external?.url || "💡"
    const textHtml = renderRichText(block.callout?.rich_text)
    const color = block.callout?.color || "default"
    const textColorCls = getNotionTextColorClasses(color) || "text-ink-700 dark:text-sage-200"

    let childrenHtml = ""
    if (block.has_children && block.children?.length > 0) {
      childrenHtml = await renderBlocks(block.children)
    }

    return (
      `<div class="not-prose my-6 p-4 rounded-r-card border-l-4 border-matcha-500 bg-stone-50/80 dark:bg-stone-800/40 ${textColorCls} flex items-start gap-3.5 shadow-zen-sm">` +
      `<span class="text-xl shrink-0 leading-none select-none mt-0.5">${escapeHtml(iconEmoji)}</span>` +
      `<div class="text-[0.93rem] leading-relaxed flex-1">${textHtml}${childrenHtml ? `<div class="mt-3">${childrenHtml}</div>` : ""}</div>` +
      `</div>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_1", async (block) => {
    const textHtml = renderRichText(block.heading_1?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    if (block.heading_1?.is_toggleable) {
      const color = block.heading_1?.color || 'default'
      const colorClass = getNotionTextColorClasses(color)
      const props = {
        blockId: block.id,
        level: 1,
        titleHtml: textHtml,
        anchorId,
        color,
        colorClass,
        hasChildren: Boolean(block.has_children),
      }
      return `<div data-notion-component="NotionToggleHeading" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
    }
    return `<h1 id="${anchorId}" class="text-2xl sm:text-3xl font-semibold text-neutral-800 dark:text-neutral-100 mt-12 mb-6 tracking-tight">${textHtml}</h1>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_2", async (block) => {
    const textHtml = renderRichText(block.heading_2?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    if (block.heading_2?.is_toggleable) {
      const color = block.heading_2?.color || 'default'
      const colorClass = getNotionTextColorClasses(color)
      const props = {
        blockId: block.id,
        level: 2,
        titleHtml: textHtml,
        anchorId,
        color,
        colorClass,
        hasChildren: Boolean(block.has_children),
      }
      return `<div data-notion-component="NotionToggleHeading" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
    }
    return `<h2 id="${anchorId}" class="text-xl sm:text-2xl font-medium text-neutral-800 dark:text-neutral-100 mt-10 mb-4">${textHtml}</h2>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_3", async (block) => {
    const textHtml = renderRichText(block.heading_3?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    if (block.heading_3?.is_toggleable) {
      const color = block.heading_3?.color || 'default'
      const colorClass = getNotionTextColorClasses(color)
      const props = {
        blockId: block.id,
        level: 3,
        titleHtml: textHtml,
        anchorId,
        color,
        colorClass,
        hasChildren: Boolean(block.has_children),
      }
      return `<div data-notion-component="NotionToggleHeading" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
    }
    return `<h3 id="${anchorId}" class="text-lg sm:text-xl font-medium text-neutral-700 dark:text-neutral-200 mt-8 mb-3">${textHtml}</h3>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_4", async (block) => {
    const textHtml = renderRichText(block.heading_4?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    if (block.heading_4?.is_toggleable) {
      const color = block.heading_4?.color || 'default'
      const colorClass = getNotionTextColorClasses(color)
      const props = {
        blockId: block.id,
        level: 4,
        titleHtml: textHtml,
        anchorId,
        color,
        colorClass,
        hasChildren: Boolean(block.has_children),
      }
      return `<div data-notion-component="NotionToggleHeading" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
    }
    return `<h4 id="${anchorId}" class="text-base sm:text-lg font-medium text-neutral-700 dark:text-neutral-200 mt-3 mb-1.5">${textHtml}</h4>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_5", async (block) => {
    const textHtml = renderRichText(block.heading_5?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    return `<h5 id="${anchorId}" class="text-sm sm:text-base font-medium text-neutral-700 dark:text-neutral-200 mt-2 mb-1">${textHtml}</h5>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_6", async (block) => {
    const textHtml = renderRichText(block.heading_6?.rich_text)
    const anchorId = block.id.replace(/-/g, '')
    return `<h6 id="${anchorId}" class="text-xs sm:text-sm font-medium text-neutral-600 dark:text-neutral-300 mt-2 mb-1">${textHtml}</h6>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("image", async (block) => {
    const image = block.image
    const src = image?.type === "file"
      ? (image.file?.url || "")
      : image?.type === "external"
        ? (image.external?.url || "")
        : (image?.file?.url || image?.external?.url || "")
    if (!src) return ""
    const captionPlain = image?.caption?.map(t => t.plain_text).join("") || ""
    const captionHtml = image?.caption?.length > 0 ? renderRichText(image.caption) : ""
    const alt = escapeHtml(captionPlain)

    return (
      `<figure class="not-prose my-10 flex flex-col items-center w-full">` +
      `<img` +
      ` src="${escapeHtml(src)}"` +
      ` alt="${alt || "Image"}"` +
      ` class="rounded-2xl border border-rice-paper-400/50 dark:border-tea-slate-50/20 max-w-full h-auto shadow-sm block cursor-zoom-in notion-zoomable"` +
      ` loading="lazy"` +
      ` decoding="async"` +
      ` data-notion-zoom` +
      `/>` +
      (captionHtml
        ? `<figcaption class="mt-3 text-sm italic text-neutral-500 dark:text-neutral-400 text-center max-w-2xl">${captionHtml}</figcaption>`
        : "") +
      `</figure>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("video", async (block) => {
    const video = block.video
    if (!video) return ""

    const type = video.type
    const url = type === "external" ? video.external?.url : video.file?.url
    if (!url) return ""

    const captionHtml = video.caption?.length > 0
      ? renderRichText(video.caption)
      : ""

    const isYouTube = url.includes("youtube.com") || url.includes("youtu.be")

    if (isYouTube) {
      const videoId = url.split("v=")[1]?.split("&")[0] || url.split("youtu.be/")[1]?.split("?")[0]
      const embedUrl = escapeHtml(`https://www.youtube.com/embed/${videoId}`)
      const title = escapeHtml(video.caption?.map(t => t.plain_text).join("") || "YouTube video player")

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
        (captionHtml ? `<figcaption class="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500 italic">${captionHtml}</figcaption>` : "") +
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
      (captionHtml ? `<figcaption class="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500 italic">${captionHtml}</figcaption>` : "") +
      `</figure>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("bulleted_list_item", async (block) => {
    const text = renderRichText(block.bulleted_list_item?.rich_text)
    let childrenHtml = ""
    if (block.has_children && block.children?.length > 0) {
      childrenHtml = await renderBlocks(block.children)
    }
    return `<li class="flex items-start gap-2.5 my-1.5 group">
    <span class="text-matcha-500/70 dark:text-matcha-400/60 mt-[3px] select-none text-xs shrink-0">
      •
    </span>
    <div class="flex-1 text-ink-700 dark:text-sage-200 leading-relaxed">
      <span class="whitespace-pre-wrap">${text}</span>
      ${childrenHtml ? `<div class="mt-2 ml-1 border-l border-rice-paper-400/60 dark:border-tea-slate-50/40 pl-4">${childrenHtml}</div>` : ""}
    </div>
  </li>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("numbered_list_item", async (block) => {
    const text = renderRichText(block.numbered_list_item?.rich_text)
    let childrenHtml = ""
    if (block.has_children && block.children?.length > 0) {
      childrenHtml = await renderBlocks(block.children)
    }
    const num = block.list_index ? `${block.list_index}.` : "1."
    return `<li class="flex items-start gap-2.5 my-1.5 group">
    <span class="text-ink-400 dark:text-sage-500 mt-[2px] select-none text-sm shrink-0 min-w-[1.25rem] text-right font-mono">
      ${num}
    </span>
    <div class="flex-1 text-ink-700 dark:text-sage-200 leading-relaxed">
      <span class="whitespace-pre-wrap">${text}</span>
      ${childrenHtml ? `<div class="mt-2 ml-1 border-l border-rice-paper-400/60 dark:border-tea-slate-50/40 pl-4">${childrenHtml}</div>` : ""}
    </div>
  </li>`
  })
)

/**
 * Maps a Notion toggle color string to Tailwind CSS classes (Wabi-Sabi style).
 * Falls back to a neutral style for unknown or default colors.
 */
function getToggleColorClasses(color) {
  const colorMap = {
    gray_background: "bg-neutral-100/70 dark:bg-neutral-800/50 border-neutral-200/60 dark:border-neutral-700/50",
    brown_background: "bg-amber-50/70 dark:bg-amber-950/30 border-amber-200/50 dark:border-amber-800/40 text-amber-900 dark:text-amber-200",
    orange_background: "bg-orange-50/70 dark:bg-orange-950/30 border-orange-200/50 dark:border-orange-800/40 text-orange-900 dark:text-orange-200",
    yellow_background: "bg-amber-50/60 dark:bg-amber-900/25 border-amber-200/50 dark:border-amber-700/40 text-amber-900 dark:text-amber-200",
    green_background: "bg-matcha-50/80 dark:bg-matcha-900/30 border-matcha-200/60 dark:border-matcha-800/50 text-matcha-900 dark:text-matcha-200",
    blue_background: "bg-sky-50/70 dark:bg-sky-950/30 border-sky-200/50 dark:border-sky-800/40 text-sky-900 dark:text-sky-200",
    purple_background: "bg-purple-50/70 dark:bg-purple-950/30 border-purple-200/50 dark:border-purple-800/40 text-purple-900 dark:text-purple-200",
    pink_background: "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200/50 dark:border-rose-800/40 text-rose-900 dark:text-rose-200",
    red_background: "bg-red-50/70 dark:bg-red-950/30 border-red-200/50 dark:border-red-800/40 text-red-900 dark:text-red-200",
    default: "bg-rice-paper-100 dark:bg-tea-slate-300 border-rice-paper-400/70 dark:border-tea-slate-50/60",
  }
  return colorMap[color] || colorMap.default
}

renderer.addBlockRenderer(
  createBlockRenderer("toggle", async (block) => {
    try {
      // Guard: [slider] toggles are converted to custom_slider blocks in
      // getChildBlocks before they ever reach this renderer. This early-return
      // is a safety net in case the block somehow bypasses that path.
      const togglePlainText = (block.toggle?.rich_text || [])
        .map(t => t.plain_text)
        .join('')
        .trim()
      if (togglePlainText === '[slider]') return ''

      const titleHtml = renderRichText(block.toggle?.rich_text) || "Toggle"
      const color = block.toggle?.color || "default"
      const dynamicClasses = getToggleColorClasses(color)

      const props = {
        blockId: block.id,
        titleHtml,
        color,
        dynamicClasses,
        hasChildren: block.has_children
      }

      return `<div data-notion-component="NotionToggleBlock" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
    } catch (err) {
      console.error("[toggle] render error:", err)
      return ""
    }
  })
)

// ── custom_slider renderer ─────────────────────────────────────────────────
// Emits a sentinel <div> that NotionContent.js replaces client-side with the
// <ImageSlider> React component. The images array (url + caption pairs) is
// serialised into the data-props attribute, mirroring NotionCodeBlock.
renderer.addBlockRenderer(
  createBlockRenderer("custom_slider", async (block) => {
    // block.images was attached in getChildBlocks when we detected [slider]
    const images = block.images || []
    if (images.length === 0) return '' // nothing to show if no images

    const props = { images }
    return `<div data-notion-component="ImageSlider" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("paragraph", async (block) => {
    const textHtml = renderRichText(block.paragraph?.rich_text)
    if (!textHtml) return ""
    return `<p class="mb-4 text-[0.98rem] leading-relaxed text-neutral-700 dark:text-neutral-300">${textHtml}</p>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("quote", async (block) => {
    const textHtml = renderRichText(block.quote?.rich_text)
    let childrenHtml = ""
    if (block.has_children && block.children?.length > 0) {
      childrenHtml = await renderBlocks(block.children)
    }
    return `<blockquote class="my-5 border-l-2 border-matcha-500 dark:border-matcha-400 pl-5 pr-4 py-3.5 font-serif italic text-[0.96rem] leading-[1.8] text-ink-700 dark:text-sage-100 bg-rice-paper-200/60 dark:bg-tea-slate-200/50 rounded-r-[6px] border-y border-r border-transparent dark:border-tea-slate-50/30">
      ${textHtml}
      ${childrenHtml ? `<div class="mt-3 not-italic font-sans text-[0.88rem] text-ink-500 dark:text-sage-400 font-normal">${childrenHtml}</div>` : ""}
    </blockquote>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("column_list", async (block) => {
    let childrenHtml = ""
    if ((block.has_children || block.children?.length > 0) && block.children?.length > 0) {
      childrenHtml = await renderBlocks(block.children)
    }
    return `<div class="flex flex-col md:flex-row gap-4 md:gap-6 my-6 w-full items-start">${childrenHtml}</div>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("column", async (block) => {
    let childrenHtml = ""
    if ((block.has_children || block.children?.length > 0) && block.children?.length > 0) {
      childrenHtml = await renderBlocks(block.children)
    }
    return `<div class="flex-1 min-w-0 w-full">${childrenHtml}</div>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("code", async (block) => {
    const codeText = block.code?.rich_text?.map(t => t.plain_text).join("") || ""
    const language = block.code?.language || ""
    const captionHtml = block.code?.caption?.length > 0 ? renderRichText(block.code.caption) : ""

    const props = { codeText, language, caption: captionHtml }
    return `<div data-notion-component="NotionCodeBlock" data-props="${escapeHtml(JSON.stringify(props))}"></div>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("table_row", async (block) => {
    const cells = block.table_row?.cells || []
    const cellsHtml = cells.map(cell => {
      const cellText = renderRichText(cell)
      return `<td class="px-4 py-2.5 text-sm text-neutral-700 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700">${cellText}</td>`
    }).join("")
    return `<tr class="border-b border-neutral-200 dark:border-neutral-700">${cellsHtml}</tr>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("table", async (block) => {
    let rowsHtml = ""
    if (block.has_children && block.children?.length > 0) {
      rowsHtml = await renderBlocks(block.children)
    }
    const hasHeader = block.table?.has_column_header || false
    if (hasHeader && rowsHtml) {
      rowsHtml = rowsHtml.replace(/^<tr([^>]*)>(.*?)<\/tr>/s, (match, trAttrs, innerTd) => {
        const thInner = innerTd.replace(/<td([^>]*)>(.*?)<\/td>/g, '<th$1 class="px-4 py-2.5 text-left text-sm font-semibold text-neutral-800 dark:text-neutral-100 bg-neutral-100/80 dark:bg-neutral-800/80 border border-neutral-200 dark:border-neutral-700">$2</th>')
        return `<tr${trAttrs} class="bg-neutral-100/80 dark:bg-neutral-800/80 font-semibold">${thInner}</tr>`
      })
    }
    return `<div class="not-prose my-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700 shadow-zen-sm"><table class="w-full border-collapse text-left min-w-full divide-y divide-neutral-200 dark:divide-neutral-700"><tbody class="divide-y divide-neutral-200 dark:divide-neutral-700 bg-white dark:bg-neutral-900/40">${rowsHtml}</tbody></table></div>`
  })
)

async function fetchChildrenList(blockId, startCursor) {
  const key = `children-${blockId}-${startCursor || 'first'}`
  const cached = getCache(key)
  if (cached) return cached
  const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: startCursor })
  setCache(key, res)
  return res
}

async function fetchDatabase(dbId) {
  const key = `db-${dbId}`
  const cached = getCache(key)
  if (cached) return cached
  const res = await notion.databases.retrieve({ database_id: dbId })
  setCache(key, res)
  return res
}

async function queryDatabase(dbId, options = {}) {
  const cleanId = String(dbId || '').trim()
  const { __ttl, ...queryOptions } = options
  const ttl = __ttl || CACHE_TTL
  const key = `db-query-${cleanId}-${JSON.stringify(queryOptions)}`
  const cached = getCache(key, ttl)
  if (cached) return cached

  let res
  if (typeof notion.dataSources?.query === 'function') {
    let dataSourceId = cleanId
    try {
      const dbInfo = await fetchDatabase(cleanId)
      if (dbInfo?.data_sources?.[0]?.id) {
        dataSourceId = dbInfo.data_sources[0].id
      }
    } catch {
      // cleanId may already be a data_source_id rather than a database_id
    }
    res = await notion.dataSources.query({ data_source_id: dataSourceId, ...queryOptions })
  } else {
    res = await notion.databases.query({ database_id: cleanId, ...queryOptions })
  }

  setCache(key, res)
  return res
}

async function fetchPage(pageId) {
  const key = `page-${pageId}`
  const cached = getCache(key)
  if (cached) return cached
  const res = await notion.pages.retrieve({ page_id: pageId })
  setCache(key, res)
  return res
}

async function searchNotion(options = {}) {
  const key = `search-${JSON.stringify(options)}`
  const cached = getCache(key)
  if (cached) return cached
  const res = await notion.search(options)
  setCache(key, res)
  return res
}

// ── Cursor pagination helpers ────────────────────────────────────────────────
// Notion returns at most 100 records per request. These helpers follow
// `next_cursor` until `has_more` is false so no records are silently dropped.
// Each page is still cached individually through the functions above.
const MAX_PAGINATION_PAGES = 100 // safety guard (10,000 records)

async function queryDatabaseAll(dbId, options = {}) {
  const results = []
  let cursor = undefined
  let pages = 0
  do {
    const res = await queryDatabase(dbId, {
      ...options,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    results.push(...(res?.results || []))
    cursor = res?.has_more ? res.next_cursor : undefined
    pages++
  } while (cursor && pages < MAX_PAGINATION_PAGES)
  return { results }
}

async function listAllChildren(blockId) {
  const results = []
  let cursor = undefined
  let pages = 0
  do {
    const res = await fetchChildrenList(blockId, cursor)
    results.push(...(res?.results || []))
    cursor = res?.has_more ? res.next_cursor : undefined
    pages++
  } while (cursor && pages < MAX_PAGINATION_PAGES)
  return results
}

async function searchAll(options = {}) {
  const results = []
  let cursor = undefined
  let pages = 0
  do {
    const res = await searchNotion({
      ...options,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    results.push(...(res?.results || []))
    cursor = res?.has_more ? res.next_cursor : undefined
    pages++
  } while (cursor && pages < MAX_PAGINATION_PAGES)
  return { results }
}

export async function getChildBlocks(blockId, locale = DEFAULT_LOCALE) {
  const targetLocale = normalizeLocale(locale)
  const blocks = []
  let cursor = undefined
  while (true) {
    const { results, next_cursor, has_more } = await fetchChildrenList(blockId, cursor)

    const processedBlocks = await Promise.all(results.map(async (block) => {
      const isLinkedDb =
        block.type === "link_to_page" &&
        block.link_to_page?.type === "database_id" &&
        block.link_to_page?.database_id
      const isLinkedPage =
        block.type === "link_to_page" &&
        block.link_to_page?.type === "page_id" &&
        block.link_to_page?.page_id

      if (block.type === "child_database" || isLinkedDb) {
        const targetDbId = isLinkedDb ? block.link_to_page.database_id : block.id
        try {
          const dbInfo = await fetchDatabase(targetDbId)
          const dataSourceId = dbInfo.data_sources?.[0]?.id || targetDbId
          const dbTitlePlain = Array.isArray(dbInfo?.title)
            ? dbInfo.title.map(t => t.plain_text || '').join('').trim()
            : ''
          if (isLinkedDb) {
            block.type = "child_database"
            block.child_database = {
              title: dbTitlePlain || "Course Modules",
            }
          } else if (!block.child_database?.title && dbTitlePlain) {
            block.child_database = { title: dbTitlePlain }
          }

          let dbRes
          try {
            // Query nested child database with sorts by 'Order' ascending
            dbRes = await queryDatabaseAll(dataSourceId, {
              sorts: [{ property: 'Order', direction: 'ascending' }],
            })
          } catch (sortErr) {
            // Fallback query if child database schema doesn't have 'Order' property
            dbRes = await queryDatabaseAll(dataSourceId)
          }

          const rawRows = dbRes.results || []
          // Filter only Published rows (or rows without status property)
          const publishedRows = rawRows.filter(row => {
            const props = row.properties || {}
            const statusProp = props.Status || props.status || props.State || props.state
            if (!statusProp) return true
            const val = statusProp.status?.name || statusProp.select?.name || (typeof statusProp.checkbox === 'boolean' ? (statusProp.checkbox ? 'Published' : 'Draft') : '')
            if (!val) return true
            const s = val.toLowerCase()
            return s !== 'draft' && s !== 'archived' && s !== 'hidden'
          })

          // Filter rows by the current page's locale when the database rows define a Locale property
          const hasAnyLocaleProp = publishedRows.some(row =>
            Boolean(findPropertyByName(row.properties || {}, ['Locale', 'locale']))
          )
          const localeFilteredRows = hasAnyLocaleProp
            ? publishedRows.filter(row => {
                const rowLocaleProp = findPropertyByName(row.properties || {}, ['Locale', 'locale'])
                const rowLocale = normalizeLocale(getPropertyPlainText(rowLocaleProp))
                return rowLocale === targetLocale
              })
            : publishedRows

          // Sort child items by 'Order' property (ascending: 0, 1, 2...)
          // Items without 'Order' default to 999 to appear last
          block.database_rows = localeFilteredRows.sort((a, b) => {
            const orderA = a.properties?.Order?.number ?? a.properties?.order?.number ?? 999
            const orderB = b.properties?.Order?.number ?? b.properties?.order?.number ?? 999
            return orderA - orderB
          })
        } catch (err) {
          console.error(`Failed to fetch child_database ${targetDbId}:`, err)
          if (isLinkedDb) {
            block.type = "child_database"
            block.child_database = { title: "Database" }
          }
          block.database_rows = []
        }
      } else if (block.type === "child_page" || isLinkedPage) {
        const targetPageId = isLinkedPage ? block.link_to_page.page_id : block.id
        try {
          const pageInfo = await fetchPage(targetPageId)
          block.page_info = pageInfo
          if (isLinkedPage) {
            const extracted = extractPageProperties(pageInfo)
            block.type = "child_page"
            block.id = targetPageId
            block.child_page = { title: extracted.title || "Untitled Page" }
          }
        } catch (err) {
          console.error(`Failed to fetch child_page ${targetPageId}:`, err)
        }
      }
      const hasChildren = block.has_children || block.type === "column_list" || block.type === "column" || block.type === "quote" || block.type === "callout"

      // ── [slider] toggle — special eager-fetch path ──────────────────────
      // When a toggle block's plain-text title is exactly "[slider]", we treat
      // it as an image carousel rather than a standard collapsible toggle.
      // We eagerly fetch all children here (SSR time) instead of lazily on
      // the client, then mutate the block into a 'custom_slider' shape so the
      // dedicated ImageSlider renderer picks it up.
      if (block.type === "toggle") {
        const togglePlainText = (block.toggle?.rich_text || [])
          .map(t => t.plain_text)
          .join('')
          .trim()

        if (togglePlainText === '[slider]') {
          // Fetch all child blocks of this toggle
          const childBlocks = await getChildBlocks(block.id, targetLocale)

          // Keep only image blocks and extract url + caption from each
          const images = childBlocks
            .filter(child => child.type === 'image')
            .map(child => {
              const img = child.image
              // Resolve URL — prefer S3 file URL, fall back to external
              const url =
                img?.type === 'file'
                  ? (img.file?.url || '')
                  : img?.type === 'external'
                    ? (img.external?.url || '')
                    : (img?.file?.url || img?.external?.url || '')

              // Join all caption rich_text segments into a plain string
              const caption = (img?.caption || []).map(t => t.plain_text).join('')

              return { url, caption }
            })
            .filter(img => img.url) // drop any image blocks with no resolvable URL

          // Mutate the block into a custom shape the renderer understands
          block.type = 'custom_slider'
          block.images = images

          // No further child processing needed — fall through to renderer
          return block
        }
      }

      const isToggleHeading = Boolean(
        block.type?.startsWith("heading_") && block[block.type]?.is_toggleable
      )

      if (
        hasChildren &&
        block.type !== "toggle" &&
        !isToggleHeading &&
        block.type !== "child_page" &&
        block.type !== "child_database"
      ) {
        block.children = await getChildBlocks(block.id, targetLocale)
      }
      return block
    }))

    blocks.push(...processedBlocks)

    if (!has_more) break
    cursor = next_cursor
  }
  return blocks
}

/**
 * Renders an array of Notion blocks to HTML, correctly grouping consecutive
 * list items. Works around the @notion-render/client extension bug where
 * non-list blocks following a list group are silently dropped.
 */
export async function renderBlocks(blocks) {
  const parts = []
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]

    // Group consecutive bulleted_list_item blocks
    if (block.type === "bulleted_list_item") {
      const group = []
      while (i < blocks.length && blocks[i].type === "bulleted_list_item") {
        group.push(blocks[i])
        i++
      }
      const itemsHtml = await Promise.all(group.map(b => renderer.render(b)))
      parts.push(`<ul class="pl-2 sm:pl-4 space-y-2 my-5">${itemsHtml.join("")}</ul>`)
      continue
    }

    // Group consecutive numbered_list_item blocks
    if (block.type === "numbered_list_item") {
      const group = []
      while (i < blocks.length && blocks[i].type === "numbered_list_item") {
        group.push(blocks[i])
        i++
      }
      const itemsHtml = await Promise.all(group.map((b, index) => {
        b.list_index = index + 1
        return renderer.render(b)
      }))
      parts.push(`<ol class="pl-2 sm:pl-4 space-y-2 my-5">${itemsHtml.join("")}</ol>`)
      continue
    }

    // All other blocks rendered individually via the registered renderer
    parts.push(await renderer.render(block))
    i++
  }
  return parts.join("")
}

export const getNotionPageData = cache(async function getNotionPageData(pageId, locale = DEFAULT_LOCALE) {
  const blocks = await getChildBlocks(pageId, locale)
  const html = await renderBlocks(blocks)
  return { html, blocks }
})

function extractNotionIcon(page) {
  if (!page?.icon) return null
  const icon = page.icon
  if (icon.type === 'emoji') {
    return { type: 'emoji', value: icon.emoji }
  }
  if (icon.type === 'file') {
    return { type: 'file', value: icon.file?.url }
  }
  if (icon.type === 'external') {
    return { type: 'external', value: icon.external?.url }
  }
  if (icon.emoji) return { type: 'emoji', value: icon.emoji }
  if (icon.file?.url) return { type: 'file', value: icon.file.url }
  if (icon.external?.url) return { type: 'external', value: icon.external.url }
  if (typeof icon === 'string') {
    return icon.startsWith('http') ? { type: 'external', value: icon } : { type: 'emoji', value: icon }
  }
  return null
}

/**
 * Reads the Rollup (or plain text/select) property that holds the parent
 * course name. Notion exposes Rollup values in several shapes depending on
 * what the rolled-up column type is:
 *
 *   rollup.type === 'array'    → rollup.array[] each with .type + value
 *   rollup.type === 'title'    → same shape as a title prop
 *   rollup.type === 'rich_text'→ same shape as a rich_text prop
 *
 * We probe a prioritised list of property names the user may have chosen.
 */
function extractParentTitle(props) {
  if (!props || typeof props !== 'object') return null

  const candidates = [
    'parent name',
    'parent course name',
    'parent course',
    'parent item',
    'parentname',
    'parent',
    'course',
    'course name',
  ]

  const normalizeKey = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '')
  const propEntries = Object.entries(props)

  for (const candidate of candidates) {
    const targetNorm = normalizeKey(candidate)
    const matchedEntry = propEntries.find(([k]) => normalizeKey(k) === targetNorm)
    const p = matchedEntry ? matchedEntry[1] : null
    if (!p) continue

    // ── Rollup property ──────────────────────────────────────────────────────
    if (p.type === 'rollup' && p.rollup) {
      const r = p.rollup
      // array rollup: each element is a full Notion property object
      if (r.type === 'array' && Array.isArray(r.array)) {
        for (const item of r.array) {
          if (item.type === 'title' && item.title?.length > 0) {
            const text = item.title.map(t => t.plain_text).join('').trim()
            if (text) return text
          }
          if (item.type === 'rich_text' && item.rich_text?.length > 0) {
            const text = item.rich_text.map(t => t.plain_text).join('').trim()
            if (text) return text
          }
          if (item.type === 'select' && item.select?.name) {
            return item.select.name.trim()
          }
          if (item.type === 'relation' && item.relation?.length > 0) {
            return item.relation[0].id
          }
        }
      }
      // scalar rollup types
      if (r.type === 'title' && r.title?.length > 0) {
        return r.title.map(t => t.plain_text).join('').trim() || null
      }
      if (r.type === 'rich_text' && r.rich_text?.length > 0) {
        return r.rich_text.map(t => t.plain_text).join('').trim() || null
      }
    }

    // ── Plain rich_text, select, formula (string), relation ──────────────────
    if (p.type === 'rich_text' && p.rich_text?.length > 0) {
      return p.rich_text.map(t => t.plain_text).join('').trim() || null
    }
    if (p.type === 'select' && p.select?.name) return p.select.name
    if (p.type === 'formula' && p.formula?.type === 'string' && p.formula.string) {
      return p.formula.string.trim() || null
    }
    if (p.type === 'relation' && p.relation?.length > 0) {
      return p.relation[0].id
    }
  }

  return null
}

/**
 * Finds a Notion property by name, ignoring case, spaces, underscores and
 * hyphens ("Translation Group ID" === "translation_group_id" === "translationGroupId").
 * Candidates are checked in priority order.
 */
function findPropertyByName(props, candidates) {
  const normalize = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '')
  const keysByNorm = new Map()
  for (const key of Object.keys(props || {})) {
    const norm = normalize(key)
    if (!keysByNorm.has(norm)) keysByNorm.set(norm, key)
  }
  for (const candidate of candidates) {
    const key = keysByNorm.get(normalize(candidate))
    if (key) return props[key]
  }
  return null
}

function extractPageProperties(page) {
  const props = page.properties || {}

  let title = 'Untitled'
  for (const key of Object.keys(props)) {
    if (props[key].type === 'title' && props[key].title?.length > 0) {
      title = props[key].title.map(t => t.plain_text).join('')
      break
    }
  }

  let slug = ''
  if (props.Slug?.rich_text) slug = props.Slug.rich_text.map(t => t.plain_text).join('')
  else if (props.slug?.rich_text) slug = props.slug.rich_text.map(t => t.plain_text).join('')
  if (!slug) {
    slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || page.id.replace(/-/g, '')
  }

  let tags = []
  const tagProp = props.Tags || props.tags
  if (tagProp?.multi_select) {
    tags = tagProp.multi_select.map(item => item.name)
  } else if (tagProp?.select) {
    tags = [tagProp.select.name]
  }

  // Category — check dedicated property, fall back to first tag
  let category = ''
  const catProp = props.Category || props.category
  if (catProp?.select?.name) {
    category = catProp.select.name
  } else if (catProp?.multi_select?.[0]?.name) {
    category = catProp.multi_select[0].name
  } else if (catProp?.status?.name) {
    category = catProp.status.name
  } else if (catProp?.rich_text) {
    category = catProp.rich_text.map(t => t.plain_text).join('')
  }
  // Fallback: use first tag as implicit category
  if (!category && tags.length > 0) {
    category = tags[0]
  }

  let summary = ''
  const sumProp = props.Summary || props.summary
  if (sumProp?.rich_text) {
    summary = sumProp.rich_text.map(t => t.plain_text).join('')
  }

  let cover = page.cover
    ? (page.cover?.external?.url || page.cover?.file?.url || null)
    : null
  let icon = extractNotionIcon(page)
  let parentTitle = extractParentTitle(props)

  // Order — number property used for manual sort (0-based ascending)
  const orderProp = props.Order || props.order
  const order = typeof orderProp?.number === 'number' ? orderProp.number : null

  let status = 'Published'
  const statusProp = props.Status || props.status || props.type
  if (statusProp?.status?.name) {
    status = statusProp.status.name
  } else if (statusProp?.select?.name) {
    status = statusProp.select.name
  } else if (typeof statusProp?.checkbox === 'boolean') {
    status = statusProp.checkbox ? 'Published' : 'Draft'
  }

  // Locale — Select (preferred) or Rich Text. Missing/empty → 'en' so that
  // existing articles keep working without any Notion migration.
  const locale = normalizeLocale(getPropertyPlainText(findPropertyByName(props, ['Locale'])))

  // Translation Group ID — stable identifier shared by all language versions
  // of the same article. Optional; empty string when not set.
  const translationGroupId = getPropertyPlainText(
    findPropertyByName(props, ['Translation Group ID', 'Translation Group', 'TranslationGroupId'])
  ).trim()

  return {
    id: page.id,
    title,
    slug,
    tags,
    category,
    summary,
    cover,
    icon,
    parentTitle,
    parent: page.parent || null,
    order,
    status,
    locale,
    translationGroupId,
    date: page.last_edited_time || page.created_time,
  }
}

/**
 * Fetches every published post from Notion, regardless of locale.
 * Internal: use getAllPosts(locale) from application code.
 */
const getAllPublishedPosts = cache(async function getAllPublishedPosts() {
  const rootId = (process.env.NOTION_ROOT_PAGE_ID || process.env.NOTION_DATABASE_ID || '').trim()
  if (!rootId) return []

  let allPosts = []

  // 1. Try querying as a database (all pages, cursor-paginated)
  try {
    const dbRes = await queryDatabaseAll(rootId)
    if (dbRes?.results?.length > 0) {
      allPosts = dbRes.results.map(extractPageProperties)
    }
  } catch (err) {
    // Not queryable as database
  }

  // 2. Try listing child pages or child databases under root page
  if (allPosts.length === 0) {
    try {
      const results = await listAllChildren(rootId)
      const dbBlocks = results.filter(b => b.type === 'child_database')
      const pageBlocks = results.filter(b => b.type === 'child_page')

      if (dbBlocks.length > 0) {
        const dbPostsNested = await Promise.all(
          dbBlocks.map(async (dbBlock) => {
            try {
              const dbRes = await queryDatabaseAll(dbBlock.id)
              return (dbRes?.results || []).map(extractPageProperties)
            } catch {
              return []
            }
          })
        )
        allPosts.push(...dbPostsNested.flat())
      }

      if (pageBlocks.length > 0) {
        const childPages = await Promise.all(
          pageBlocks.map(async (b) => {
            try {
              const p = await fetchPage(b.id)
              return extractPageProperties(p)
            } catch {
              return {
                id: b.id,
                title: b.child_page?.title || 'Lesson',
                slug: b.child_page?.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || b.id.replace(/-/g, ''),
                tags: ['General'],
                summary: '',
                cover: null,
                icon: '📖',
                status: 'Published',
                locale: DEFAULT_LOCALE,
                translationGroupId: '',
                date: null,
              }
            }
          })
        )
        allPosts.push(...childPages.filter(Boolean))
      }
    } catch (childErr) {
      // Root page not listable as block
    }
  }

  // 3. Fallback: Search all pages shared with integration
  if (allPosts.length === 0) {
    try {
      const searchRes = await searchAll({
        filter: { value: 'page', property: 'object' },
      })
      if (searchRes?.results?.length > 0) {
        allPosts = searchRes.results.map(extractPageProperties)
      }
    } catch (searchErr) {
      console.error('Failed to fetch posts from Notion Official API:', searchErr)
    }
  }

  // Filter only Published posts (exclude Draft, Archived, Hidden)
  const published = allPosts.filter(p => {
    if (!p || !p.title || p.title === 'Untitled') return false
    const s = (p.status || '').toLowerCase()
    return s !== 'draft' && s !== 'archived' && s !== 'hidden'
  })

  // Disambiguate duplicate slugs automatically based on locale:
  // If a cloned post has the exact same slug as the English/default post,
  // automatically suffix it with `-${locale}` (e.g. `-vi`) so URLs never collide
  // and the language switcher works out-of-the-box.
  const slugCounts = new Map()
  for (const post of published) {
    if (!post.slug) continue
    slugCounts.set(post.slug, (slugCounts.get(post.slug) || 0) + 1)
  }

  for (const post of published) {
    if (post.slug && slugCounts.get(post.slug) > 1) {
      const loc = post.locale || DEFAULT_LOCALE
      if (loc !== DEFAULT_LOCALE && !post.slug.endsWith(`-${loc}`)) {
        post.slug = `${post.slug}-${loc}`
      }
    }
  }

  return published
})

/**
 * Returns published posts for a locale.
 *   getAllPosts('en')  → English articles (homepage)
 *   getAllPosts('vi')  → Vietnamese articles
 *   getAllPosts('all') → every published article (routing, sitemap, translations)
 * Notion is only queried once per request; the locale filter runs in memory.
 * Defaults to 'all' to preserve the original "every published post" semantics.
 */
export const getAllPosts = cache(async function getAllPosts(locale = 'all') {
  const posts = await getAllPublishedPosts()
  if (!locale || locale === 'all') return posts
  const target = normalizeLocale(locale)
  return posts.filter(p => (p.locale || DEFAULT_LOCALE) === target)
})

// ── Translation helpers ─────────────────────────────────────────────────────

function normalizeNotionId(id) {
  return id ? String(id).replace(/-/g, '').toLowerCase() : ''
}

function normalizeGroupKey(groupId) {
  return String(groupId || '').trim().toLowerCase()
}

function warnOnce(key, message) {
  if (!globalThis.__notionI18nWarnings) globalThis.__notionI18nWarnings = new Set()
  if (globalThis.__notionI18nWarnings.has(key)) return
  globalThis.__notionI18nWarnings.add(key)
  console.warn(message)
}

function toTranslationMeta(post) {
  return {
    id: post.id,
    slug: post.slug || normalizeNotionId(post.id),
    title: post.title,
    summary: post.summary || '',
    icon: post.icon || null,
    locale: post.locale || DEFAULT_LOCALE,
    translationGroupId: post.translationGroupId || '',
    date: post.date || null,
  }
}

/**
 * Builds Map<groupKey, Map<locale, post[]>> from published posts only, and
 * reports duplicate (Translation Group ID + Locale) combinations and slug
 * collisions between published posts.
 */
const getTranslationIndex = cache(async function getTranslationIndex() {
  const posts = await getAllPublishedPosts()
  const groups = new Map()
  const slugs = new Map()

  for (const post of posts) {
    if (post.slug) {
      if (!slugs.has(post.slug)) slugs.set(post.slug, [])
      slugs.get(post.slug).push(post)
    }

    const key = normalizeGroupKey(post.translationGroupId)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, new Map())
    const byLocale = groups.get(key)
    const locale = post.locale || DEFAULT_LOCALE
    if (!byLocale.has(locale)) byLocale.set(locale, [])
    byLocale.get(locale).push(post)
  }

  for (const [key, byLocale] of groups) {
    for (const [locale, list] of byLocale) {
      if (list.length > 1) {
        const details = list.map(p => `"${p.title}" (slug: ${p.slug}, id: ${p.id})`).join(', ')
        warnOnce(
          `dup-${key}-${locale}-${list.map(p => p.id).sort().join(',')}`,
          `[i18n] Duplicate translation: Translation Group ID "${list[0].translationGroupId}" has ${list.length} published "${locale}" articles: ${details}. ` +
          `The language switcher and hreflang links for this group/locale are disabled until only one remains.`
        )
      }
    }
  }

  for (const [slug, list] of slugs) {
    if (list.length > 1) {
      warnOnce(
        `slug-${slug}-${list.map(p => p.id).sort().join(',')}`,
        `[i18n] Slug collision: ${list.length} published articles share the slug "${slug}" (${list.map(p => `${p.locale}: ${p.id}`).join(', ')}). Give each language version its own Slug.`
      )
    }
  }

  return groups
})

/**
 * Resolves the published article in `targetLocale` that shares the given
 * Translation Group ID. Uses article metadata only (no page blocks fetched).
 * Returns null when no published translation exists, or when the
 * group/locale combination is ambiguous (duplicates are reported via warning).
 */
export const getTranslatedArticle = cache(async function getTranslatedArticle(translationGroupId, targetLocale) {
  const key = normalizeGroupKey(translationGroupId)
  if (!key || !targetLocale) return null
  const locale = normalizeLocale(targetLocale)

  const index = await getTranslationIndex()
  const candidates = index.get(key)?.get(locale) || []
  if (candidates.length !== 1) return null
  return toTranslationMeta(candidates[0])
})

/**
 * Resolves all child-page translation mappings from the dedicated Notion
 * `Translation Mapping` database.
 * Cached in memory for ~10 minutes (MAPPINGS_CACHE_TTL) so it is fetched once
 * per cache refresh rather than on every page render.
 *
 * Returns indexed lookup maps:
 * - byEnId: Map<normalizedEnPageId, mappingEntry>
 * - byViId: Map<normalizedViPageId, mappingEntry>
 * - all: Array<mappingEntry>
 */
export async function getTranslationMappings() {
  const cached = getCache(MAPPINGS_CACHE_KEY, MAPPINGS_CACHE_TTL)
  if (cached) return cached

  const mappingDbId = (
    process.env.NOTION_TRANSLATION_MAPPING_DATABASE_ID ||
    DEFAULT_MAPPING_DB_ID
  ).trim()

  const byEnId = new Map()
  const byViId = new Map()
  const all = []

  if (!mappingDbId) {
    const empty = { byEnId, byViId, all }
    setCache(MAPPINGS_CACHE_KEY, empty)
    return empty
  }

  try {
    const dbRes = await queryDatabaseAll(mappingDbId, { __ttl: MAPPINGS_CACHE_TTL })
    const rows = dbRes?.results || []

    for (const page of rows) {
      const props = page.properties || {}

      // 1. Name / Title
      let name = 'Untitled'
      for (const key of Object.keys(props)) {
        if (props[key].type === 'title' && props[key].title?.length > 0) {
          name = props[key].title.map(t => t.plain_text).join('')
          break
        }
      }

      // 2. EN Page ID
      const enProp = findPropertyByName(props, ['EN Page ID', 'EN Page Id', 'English Page ID', 'EN ID', 'EnPageId'])
      const enPageId = getPropertyPlainText(enProp).trim()

      // 3. VI Page ID
      const viProp = findPropertyByName(props, ['VI Page ID', 'VI Page Id', 'Vietnamese Page ID', 'VI ID', 'ViPageId'])
      const viPageId = getPropertyPlainText(viProp).trim()

      // 4. Status (Draft / Ready)
      const statusProp = findPropertyByName(props, ['Status', 'Translation Status', 'State'])
      let statusVal = 'Draft'
      if (statusProp?.status?.name) {
        statusVal = statusProp.status.name
      } else if (statusProp?.select?.name) {
        statusVal = statusProp.select.name
      } else if (statusProp) {
        statusVal = getPropertyPlainText(statusProp) || 'Draft'
      }

      const isReady = statusVal.trim().toLowerCase() === 'ready'
      const normEnId = normalizeNotionId(enPageId)
      const normViId = normalizeNotionId(viPageId)

      const entry = {
        rowId: page.id,
        name,
        enPageId,
        viPageId,
        normEnId,
        normViId,
        status: statusVal.trim(),
        isReady,
      }

      if (normEnId) {
        byEnId.set(normEnId, entry)
      }
      if (normViId) {
        byViId.set(normViId, entry)
      }
      all.push(entry)
    }
  } catch (err) {
    console.error(`[Translation Mapping] Failed to query mapping database ${mappingDbId}:`, err)
  }

  const result = { byEnId, byViId, all }
  setCache(MAPPINGS_CACHE_KEY, result)
  return result
}

/**
 * Returns { [locale]: translationMeta | null } for every supported locale other
 * than the article's own. Translations are only exposed when the relationship
 * is reciprocal, i.e. the current article is itself the unique published
 * record for its own locale in the group. This guarantees hreflang pairs
 * always point at each other.
 */
export async function getArticleTranslations(article) {
  const currentLocale = article?.locale || DEFAULT_LOCALE
  const result = {}
  for (const locale of SUPPORTED_LOCALES) {
    if (locale !== currentLocale) result[locale] = null
  }
  if (!article?.id) return result

  let hasGroupTranslation = false
  if (article.translationGroupId) {
    const self = await getTranslatedArticle(article.translationGroupId, currentLocale)
    if (self && normalizeNotionId(self.id) === normalizeNotionId(article.id)) {
      for (const locale of Object.keys(result)) {
        const found = await getTranslatedArticle(article.translationGroupId, locale)
        if (found) {
          result[locale] = found
          hasGroupTranslation = true
        }
      }
      if (hasGroupTranslation) return result
    }

    // Fallback for pages belonging to a nested database (not in the root database index)
    const parentDbId = article.parent?.database_id || article.parent?.data_source_id
    if (parentDbId) {
      try {
        const dbRes = await queryDatabaseAll(parentDbId)
        const rows = (dbRes?.results || []).map(extractPageProperties).filter(p => {
          if (!p || !p.title || p.title === 'Untitled') return false
          const s = (p.status || '').toLowerCase()
          return s !== 'draft' && s !== 'archived' && s !== 'hidden'
        })
        const targetGroupKey = normalizeGroupKey(article.translationGroupId)
        const groupRows = rows.filter(r => normalizeGroupKey(r.translationGroupId) === targetGroupKey)
        const selfMatches = groupRows.filter(r => (r.locale || DEFAULT_LOCALE) === currentLocale)
        if (selfMatches.length === 1 && normalizeNotionId(selfMatches[0].id) === normalizeNotionId(article.id)) {
          for (const locale of Object.keys(result)) {
            const candidates = groupRows.filter(r => (r.locale || DEFAULT_LOCALE) === locale)
            if (candidates.length === 1) {
              result[locale] = toTranslationMeta(candidates[0])
              hasGroupTranslation = true
            }
          }
          if (hasGroupTranslation) return result
        }
      } catch {
        // Ignore nested database translation lookup errors
      }
    }
  }

  // ── Dynamic Notion Translation Mapping lookup (child pages & manual pairs) ──
  try {
    const normId = normalizeNotionId(article.id)
    const mappings = await getTranslationMappings()

    // Case A: EN article looking for VI translation
    if (currentLocale === 'en' || mappings.byEnId.has(normId)) {
      const mapping = mappings.byEnId.get(normId)
      if (mapping && mapping.isReady && mapping.viPageId) {
        try {
          const viPage = await fetchPage(mapping.viPageId)
          if (viPage && viPage.id) {
            const viExtracted = extractPageProperties(viPage)
            result.vi = toTranslationMeta({
              ...viExtracted,
              locale: 'vi',
              slug: viExtracted.slug || normalizeNotionId(viPage.id),
            })
          }
        } catch (fetchErr) {
          console.error(`Failed to fetch VI translated page ${mapping.viPageId}:`, fetchErr)
        }
      }
    }

    // Case B: VI article looking for EN translation
    if (currentLocale === 'vi' || mappings.byViId.has(normId)) {
      const mapping = mappings.byViId.get(normId)
      if (mapping && mapping.isReady && mapping.enPageId) {
        try {
          const enPage = await fetchPage(mapping.enPageId)
          if (enPage && enPage.id) {
            const enExtracted = extractPageProperties(enPage)
            result.en = toTranslationMeta({
              ...enExtracted,
              locale: 'en',
              slug: enExtracted.slug || normalizeNotionId(enPage.id),
            })
          }
        } catch (fetchErr) {
          console.error(`Failed to fetch EN translated page ${mapping.enPageId}:`, fetchErr)
        }
      }
    }
  } catch (mapErr) {
    console.error('Failed to resolve translations from dynamic mapping database:', mapErr)
  }

  return result
}

function unescapeHtml(str) {
  return String(str)
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/**
 * Map of { slug | compact page id → slug of its translation in `locale` } for
 * every published article written in another locale that has an unambiguous
 * published translation in `locale`.
 */
const getLocalizedLinkMap = cache(async function getLocalizedLinkMap(locale) {
  const posts = await getAllPublishedPosts()
  const map = new Map()
  for (const post of posts) {
    if (!post.translationGroupId || (post.locale || DEFAULT_LOCALE) === locale) continue
    const self = await getTranslatedArticle(post.translationGroupId, post.locale)
    if (!self || normalizeNotionId(self.id) !== normalizeNotionId(post.id)) continue
    const target = await getTranslatedArticle(post.translationGroupId, locale)
    if (!target?.slug) continue
    if (post.slug) map.set(post.slug, target.slug)
    map.set(normalizeNotionId(post.id), target.slug)
  }

  // Populate dynamic translation mappings for child pages & manual pairings
  try {
    const mappings = await getTranslationMappings()
    for (const entry of mappings.all) {
      if (!entry.isReady) continue
      if (locale === 'vi' && entry.normEnId && entry.normViId) {
        const targetSlug = entry.viPageId.replace(/-/g, '')
        map.set(entry.normEnId, targetSlug)
      } else if (locale === 'en' && entry.normViId && entry.normEnId) {
        const targetSlug = entry.enPageId.replace(/-/g, '')
        map.set(entry.normViId, targetSlug)
      }
    }
  } catch {
    // Ignore mapping errors
  }

  return map
})

/**
 * Rewrites root-relative internal article links (child_page cards, embedded
 * database cards, Notion page mentions) inside rendered HTML so that they point
 * to the version of the target article written in `locale`, when one exists.
 * Links without a translation are left untouched. Source blocks are never
 * modified — only the generated HTML string.
 */
export async function localizeInternalLinks(html, locale) {
  if (!html || !locale) return html
  const map = await getLocalizedLinkMap(normalizeLocale(locale))
  if (map.size === 0) return html

  return html.replace(/href="\/([^"\/?#]+)([^"]*)"/g, (match, segment, rest) => {
    let key = unescapeHtml(segment)
    try { key = decodeURIComponent(key) } catch { /* keep raw */ }
    let target = map.get(key)
    if (!target) {
      const compact = key.replace(/-/g, '').toLowerCase()
      if (/^[0-9a-f]{32}$/.test(compact)) target = map.get(compact)
    }
    return target ? `href="/${escapeHtml(target)}${rest}"` : match
  })
}

export const getPageBySlug = cache(async function getPageBySlug(slug) {
  const posts = await getAllPosts('all')
  let post = posts.find(p => p.slug === slug || p.id.replace(/-/g, '') === slug || p.id === slug)

  // Fallback 1: Workspace search across all pages in Notion
  if (!post) {
    try {
      const searchQuery = slug.replace(/-/g, ' ')
      const searchRes = await searchNotion({
        query: searchQuery,
        filter: { value: 'page', property: 'object' },
      })

      for (const page of searchRes.results || []) {
        const extracted = extractPageProperties(page)
        const rawTitle = extracted.title || ''
        const slugifiedTitle = rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
        const rawSlug = extracted.slug || ''
        const idNoHyphens = page.id.replace(/-/g, '')

        if (
          rawSlug === slug ||
          slugifiedTitle === slug ||
          idNoHyphens === slug ||
          page.id === slug
        ) {
          post = extracted
          break
        }
      }

      // If no exact slug match, but search returned results, try matching the first result if query matches title
      if (!post && searchRes.results?.length > 0) {
        for (const page of searchRes.results) {
          const extracted = extractPageProperties(page)
          if (extracted.title && extracted.title.toLowerCase().trim() === searchQuery.toLowerCase().trim()) {
            post = extracted
            break
          }
        }
      }
    } catch (searchErr) {
      console.error(`Failed workspace search fallback for slug ${slug}:`, searchErr)
    }
  }

  // Fallback 2: Direct Notion page retrieval if slug is a Notion Page ID / UUID
  if (!post) {
    try {
      const page = await fetchPage(slug)
      if (page && page.id) {
        post = extractPageProperties(page)
      }
    } catch (retrieveErr) {
      // Ignore retrieve error
    }
  }

  if (!post) {
    return null
  }

  try {
    let locale = post.locale || DEFAULT_LOCALE
    // Resolve child-page locale from Notion Translation Mapping database
    try {
      const mappings = await getTranslationMappings()
      const normId = normalizeNotionId(post.id)
      if (mappings.byViId.has(normId)) {
        locale = 'vi'
        post.locale = 'vi'
      } else if (mappings.byEnId.has(normId)) {
        locale = 'en'
        post.locale = 'en'
      } else if (post.parent?.type === 'page_id') {
        const parentNormId = normalizeNotionId(post.parent.page_id)
        if (mappings.byViId.has(parentNormId)) {
          locale = 'vi'
          post.locale = 'vi'
        }
      }
    } catch {
      // Ignore mapping resolution errors
    }

    const { html: rawHtml, blocks } = await getNotionPageData(post.id, locale)
    // Point child-page / embedded-database / mention links at the version of
    // the target article written in this article's locale, when one exists.
    let html = rawHtml
    try {
      html = await localizeInternalLinks(rawHtml, locale)
    } catch (linkErr) {
      console.error(`Failed to localize internal links for ${post.id}:`, linkErr)
    }
    return {
      html,
      blocks,
      id: post.id,
      slug: post.slug || '',
      title: post.title || 'Lesson',
      summary: post.summary || '',
      cover: post.cover || null,
      icon: post.icon || null,
      order: post.order ?? null,
      parentTitle: post.parentTitle || null,
      parent: post.parent || null,
      category: (post.tags && post.tags[0]) || 'Documentation',
      tags: post.tags || [],
      status: post.status || 'Published',
      locale,
      translationGroupId: post.translationGroupId || '',
      date: post.date || null,
    }
  } catch (err) {
    console.error(`Failed to fetch page HTML for id ${post?.id} (slug: ${slug}):`, err)
    return null
  }
})

/**
 * Resolves previous and next sibling pages for nested child pages using Notion's Block API.
 * Sibling navigation natively maintains the exact visual order from the Notion editor.
 *
 * 1. Checks if the current page's parent type is 'page_id' or 'workspace' (or 'block_id').
 *    Direct database items (parent.type === 'database_id') do not have nested sibling navigation.
 * 2. Uses Notion's Block API (notion.blocks.children.list) to fetch blocks of the parent page.
 * 3. Filters returned blocks where `type === 'child_page'`.
 * 4. Extracts page IDs and titles from `block.child_page.title`.
 * 5. Uses `findIndex` with the current page ID to determine `prevPage` and `nextPage`.
 * 6. Maps IDs to the existing slug routing structure so `<SiblingNavigation />` renders valid href links.
 *
 * @param {object} currentPage - Current page object containing { id, slug, parent, ... }
 * @returns {Promise<{ prevPage: object|null, nextPage: object|null }>}
 */
export const getSiblingPages = cache(async function getSiblingPages(currentPage) {
  if (!currentPage || !currentPage.id) {
    return { prevPage: null, nextPage: null }
  }

  // 1. Resolve parent metadata of the current page
  let parent = currentPage.parent
  if (!parent) {
    try {
      const pageDetails = await fetchPage(currentPage.id)
      parent = pageDetails?.parent || null
    } catch (err) {
      console.error(`Failed to retrieve parent information for page ${currentPage.id}:`, err)
      return { prevPage: null, nextPage: null }
    }
  }

  if (!parent || !parent.type) {
    return { prevPage: null, nextPage: null }
  }

  const normalizeId = (id) => (id ? String(id).replace(/-/g, '').toLowerCase() : '')
  const currentNormId = normalizeId(currentPage.id)
  const currentLocale = currentPage.locale || DEFAULT_LOCALE
  const rootId = (process.env.NOTION_ROOT_PAGE_ID || process.env.NOTION_DATABASE_ID || '').trim()

  // Case A: Database item (either in a nested course database or a child lesson in the main database)
  if (parent.type === 'database_id' || parent.type === 'data_source_id') {
    const parentDbId = parent.database_id || parent.data_source_id
    const isRootDb = rootId && normalizeId(parentDbId) === normalizeId(rootId)

    if (!isRootDb && parentDbId) {
      // Nested database item: siblings are published rows in the same nested database and locale
      try {
        const dbRes = await queryDatabaseAll(parentDbId)
        const rows = (dbRes?.results || [])
          .map(extractPageProperties)
          .filter(p => {
            if (!p || !p.title || p.title === 'Untitled') return false
            const s = (p.status || '').toLowerCase()
            if (s === 'draft' || s === 'archived' || s === 'hidden') return false
            return (p.locale || DEFAULT_LOCALE) === currentLocale
          })
          .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

        const idx = rows.findIndex(r => normalizeId(r.id) === currentNormId)
        if (idx === -1 || rows.length <= 1) return { prevPage: null, nextPage: null }
        const toNav = (r) => r ? ({ id: r.id, title: r.title, slug: r.slug, icon: r.icon || null }) : null
        return {
          prevPage: idx > 0 ? toNav(rows[idx - 1]) : null,
          nextPage: idx < rows.length - 1 ? toNav(rows[idx + 1]) : null,
        }
      } catch {
        return { prevPage: null, nextPage: null }
      }
    }

    if (currentPage.parentTitle) {
      // Main database lesson with a Parent Course: siblings share the same parentTitle and locale
      try {
        const localePosts = await getAllPosts(currentLocale)
        const siblings = localePosts
          .filter(p => p.parentTitle && p.parentTitle.trim() === currentPage.parentTitle.trim())
          .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

        const idx = siblings.findIndex(r => normalizeId(r.id) === currentNormId)
        if (idx === -1 || siblings.length <= 1) return { prevPage: null, nextPage: null }
        const toNav = (r) => r ? ({ id: r.id, title: r.title, slug: r.slug, icon: r.icon || null }) : null
        return {
          prevPage: idx > 0 ? toNav(siblings[idx - 1]) : null,
          nextPage: idx < siblings.length - 1 ? toNav(siblings[idx + 1]) : null,
        }
      } catch {
        return { prevPage: null, nextPage: null }
      }
    }

    return { prevPage: null, nextPage: null }
  }

  // Case B: Current page's parent type is 'page_id' or 'workspace' (or 'block_id')
  const isNestedPage = parent.type === 'page_id' || parent.type === 'workspace' || parent.type === 'block_id'
  if (!isNestedPage) {
    return { prevPage: null, nextPage: null }
  }

  // Determine parent page or block ID
  let parentId = null
  if (parent.type === 'page_id') {
    parentId = parent.page_id
  } else if (parent.type === 'block_id') {
    parentId = parent.block_id
  } else if (parent.type === 'workspace') {
    parentId = (process.env.NOTION_ROOT_PAGE_ID || process.env.NOTION_DATABASE_ID || '').trim() || null
  }

  if (!parentId) {
    return { prevPage: null, nextPage: null }
  }

  // 2. Fetch blocks of the parent page via Notion Block API
  let parentBlocks = []
  try {
    let cursor = undefined
    while (true) {
      const res = await fetchChildrenList(parentId, cursor)
      if (!res || !res.results) break
      parentBlocks.push(...res.results)
      if (!res.has_more || !res.next_cursor) break
      cursor = res.next_cursor
    }
  } catch (err) {
    console.error(`Failed to fetch child blocks for parent ${parentId}:`, err)
    return { prevPage: null, nextPage: null }
  }

  // 3. Filter returned blocks to only include child_page blocks (maintains Notion visual order)
  const childPageBlocks = parentBlocks.filter(block => block.type === 'child_page')
  if (childPageBlocks.length <= 1) {
    return { prevPage: null, nextPage: null }
  }

  // 4. Map array to extract page IDs and titles
  const rawChildPages = childPageBlocks.map(block => ({
    id: block.id,
    title: block.child_page?.title || 'Untitled Page',
  }))

  const allPosts = await getAllPosts('all').catch(() => [])
  const findPost = (id) => allPosts.find(post => normalizeId(post.id) === normalizeId(id))

  // 4b. Locale-aware sibling list (keeps Notion visual order).
  //     A sibling written in another locale is swapped for its translation in
  //     the current locale when one exists, otherwise skipped, so readers never
  //     jump from a Vietnamese article to an English sibling (or vice versa).
  //     Siblings that are not known posts (no locale metadata) are kept as-is.
  const childPages = []
  const seenIds = new Set()
  const mappings = await getTranslationMappings().catch(() => null)

  for (const sibling of rawChildPages) {
    let entry = sibling
    const isCurrent = normalizeId(sibling.id) === currentNormId
    const post = findPost(sibling.id)
    if (!isCurrent && post && (post.locale || DEFAULT_LOCALE) !== currentLocale) {
      const translated = post.translationGroupId
        ? await getTranslatedArticle(post.translationGroupId, currentLocale).catch(() => null)
        : null
      if (!translated) continue
      entry = { id: translated.id, title: translated.title }
    } else if (!isCurrent && mappings) {
      const sibNorm = normalizeId(sibling.id)
      if (currentLocale === 'vi' && mappings.byEnId.has(sibNorm)) {
        const m = mappings.byEnId.get(sibNorm)
        if (m?.isReady && m.viPageId) {
          entry = { id: m.viPageId, title: m.name || sibling.title }
        }
      } else if (currentLocale === 'en' && mappings.byViId.has(sibNorm)) {
        const m = mappings.byViId.get(sibNorm)
        if (m?.isReady && m.enPageId) {
          entry = { id: m.enPageId, title: m.name || sibling.title }
        }
      }
    }
    const key = normalizeId(entry.id)
    if (seenIds.has(key)) continue
    seenIds.add(key)
    childPages.push(entry)
  }

  // 5. Use findIndex with current page ID to determine prevPage and nextPage
  const currentIndex = childPages.findIndex(page => normalizeId(page.id) === currentNormId)
  if (currentIndex === -1) {
    return { prevPage: null, nextPage: null }
  }

  const rawPrev = currentIndex > 0 ? childPages[currentIndex - 1] : null
  const rawNext = currentIndex < childPages.length - 1 ? childPages[currentIndex + 1] : null

  // 6. Routing mapping: Map sibling IDs to existing slug structure
  const mapSiblingToNavPage = (sibling) => {
    if (!sibling) return null
    const matched = findPost(sibling.id)

    if (matched) {
      return {
        id: matched.id || sibling.id,
        title: matched.title || sibling.title || 'Untitled Page',
        slug: matched.slug || (matched.title ? matched.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') : sibling.id.replace(/-/g, '')),
        icon: matched.icon || null,
      }
    }

    // Fallback: Generate clean URL slug from block title or stripped ID
    const title = sibling.title || 'Untitled Page'
    const fallbackSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || sibling.id.replace(/-/g, '')
    return {
      id: sibling.id,
      title,
      slug: fallbackSlug,
      icon: null,
    }
  }

  return {
    prevPage: mapSiblingToNavPage(rawPrev),
    nextPage: mapSiblingToNavPage(rawNext),
  }
})


