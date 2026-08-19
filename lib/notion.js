import { Client } from "@notionhq/client"
import { NotionRenderer, createBlockRenderer } from "@notion-render/client"
import hljsPlugin from "@notion-render/hljs-plugin"
import hljs from "highlight.js"

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
  gray:              'text-neutral-600 dark:text-neutral-400',
  gray_background:   'text-neutral-600 dark:text-neutral-400',
  brown:             'text-amber-800 dark:text-amber-300',
  brown_background:  'text-amber-800 dark:text-amber-300',
  orange:            'text-orange-700 dark:text-orange-300',
  orange_background: 'text-orange-700 dark:text-orange-300',
  yellow:            'text-yellow-700 dark:text-yellow-300',
  yellow_background: 'text-yellow-700 dark:text-yellow-300',
  green:             'text-green-700 dark:text-green-300',
  green_background:  'text-green-700 dark:text-green-300',
  blue:              'text-blue-700 dark:text-blue-300',
  blue_background:   'text-blue-700 dark:text-blue-300',
  purple:            'text-purple-700 dark:text-purple-300',
  purple_background: 'text-purple-700 dark:text-purple-300',
  pink:              'text-pink-700 dark:text-pink-300',
  pink_background:   'text-pink-700 dark:text-pink-300',
  red:               'text-red-700 dark:text-red-300',
  red_background:    'text-red-700 dark:text-red-300',
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
      content = `<strong class="font-semibold text-neutral-800 dark:text-neutral-100">${content}</strong>`
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
      content = `<code class="text-rose-500 dark:text-rose-400 bg-rose-50/80 dark:bg-rose-900/30 px-1.5 py-0.5 rounded-md font-mono text-[0.9em]">${content}</code>`
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
  default:  'bg-stone-100 text-stone-700 border-stone-200/70 dark:bg-stone-800 dark:text-stone-300 dark:border-stone-700/60',
  gray:     'bg-neutral-100 text-neutral-600 border-neutral-200/70 dark:bg-neutral-800 dark:text-neutral-400 dark:border-neutral-700/60',
  brown:    'bg-amber-50 text-amber-800 border-amber-200/70 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/50',
  orange:   'bg-orange-50 text-orange-700 border-orange-200/70 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700/50',
  yellow:   'bg-yellow-50 text-yellow-700 border-yellow-200/70 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700/50',
  green:    'bg-green-50 text-green-700 border-green-200/70 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700/50',
  blue:     'bg-blue-50 text-blue-700 border-blue-200/70 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/50',
  purple:   'bg-purple-50 text-purple-700 border-purple-200/70 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700/50',
  pink:     'bg-pink-50 text-pink-700 border-pink-200/70 dark:bg-pink-900/30 dark:text-pink-300 dark:border-pink-700/50',
  red:      'bg-red-50 text-red-700 border-red-200/70 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/50',
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
    const safeSlug  = escapeHtml(slug)

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
    const end   = prop.date.end ? formatDate(prop.date.end) : null
    const str   = end ? `${start} → ${end}` : start
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
    const rows    = block.database_rows || []

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
      const t     = firstRowProps[k]?.type
      return t === 'rich_text' && (lower === 'summary' || lower === 'description' || lower === 'desc')
    })

    // ── Build each card — mirrors CourseCard.js exactly ─────────────────
    const cardsHtml = rows.map((row) => {
      const props = row.properties || {}

      // ── Resolve title + slug ──────────────────────────────────────────
      let titleText = ''
      let slug      = ''
      if (titleKey) {
        const titleProp = props[titleKey]
        titleText       = titleProp?.title?.map(t => t.plain_text).join('') || ''
        const slugProp  = props.Slug || props.slug
        slug            = slugProp?.rich_text?.map(t => t.plain_text).join('') || ''
        if (!slug && titleText) {
          slug = titleText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
        }
        if (!slug) slug = row.id.replace(/-/g, '')
      }
      const safeSlug  = escapeHtml(slug)
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
          `<img src="${escapeHtml(coverUrl)}" alt="" loading="lazy" ` +
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
          if (p.type === 'select'  && p.select) return [p.select.name]
          if (p.type === 'status'  && p.status) return [p.status.name]
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
    const pageInfo  = block.page_info ? extractPageProperties(block.page_info) : null
    const titleText = pageInfo?.title || block.child_page?.title || "Untitled Page"

    let slug = pageInfo?.slug
    if (!slug) {
      slug = titleText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || block.id.replace(/-/g, '')
    }

    const safeTitle = escapeHtml(titleText)
    const safeSlug  = escapeHtml(slug)
    const iconEmoji = pageInfo?.icon || block.icon?.emoji || "📄"
    const summary   = pageInfo?.summary ? escapeHtml(pageInfo.summary) : ""

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
    const textHtml  = renderRichText(block.callout?.rich_text)
    const color     = block.callout?.color || "default"
    const textColorCls = getNotionTextColorClasses(color) || "text-ink-700 dark:text-sage-200"

    return (
      `<div class="not-prose my-6 p-4 rounded-r-card border-l-4 border-matcha-500 bg-stone-50/80 dark:bg-stone-800/40 ${textColorCls} flex items-start gap-3.5 shadow-zen-sm">` +
      `<span class="text-xl shrink-0 leading-none select-none mt-0.5">${escapeHtml(iconEmoji)}</span>` +
      `<div class="text-[0.93rem] leading-relaxed flex-1">${textHtml}</div>` +
      `</div>`
    )
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_1", async (block) => {
    const textHtml = renderRichText(block.heading_1?.rich_text)
    return `<h1 class="text-2xl sm:text-3xl font-semibold text-neutral-800 dark:text-neutral-100 mt-12 mb-6 tracking-tight">${textHtml}</h1>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_2", async (block) => {
    const textHtml = renderRichText(block.heading_2?.rich_text)
    return `<h2 class="text-xl sm:text-2xl font-medium text-neutral-800 dark:text-neutral-100 mt-10 mb-4">${textHtml}</h2>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_3", async (block) => {
    const textHtml = renderRichText(block.heading_3?.rich_text)
    return `<h3 class="text-lg sm:text-xl font-medium text-neutral-700 dark:text-neutral-200 mt-8 mb-3">${textHtml}</h3>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_4", async (block) => {
    const textHtml = renderRichText(block.heading_4?.rich_text)
    return `<h4 class="text-base sm:text-lg font-medium text-neutral-700 dark:text-neutral-200 mt-3 mb-1.5">${textHtml}</h4>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_5", async (block) => {
    const textHtml = renderRichText(block.heading_5?.rich_text)
    return `<h5 class="text-sm sm:text-base font-medium text-neutral-700 dark:text-neutral-200 mt-2 mb-1">${textHtml}</h5>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("heading_6", async (block) => {
    const textHtml = renderRichText(block.heading_6?.rich_text)
    return `<h6 class="text-xs sm:text-sm font-medium text-neutral-600 dark:text-neutral-300 mt-2 mb-1">${textHtml}</h6>`
  })
)

renderer.addBlockRenderer(
  createBlockRenderer("image", async (block) => {
    const src = block.image?.type === "external"
      ? block.image.external?.url
      : block.image?.file?.url || ""
    if (!src) return ""

    const captionHtml = block.image?.caption?.length > 0
      ? renderRichText(block.image.caption)
      : ""
    const alt = escapeHtml(block.image?.caption?.map(t => t.plain_text).join("") || "")

    return (
      `<figure class="not-prose my-4 w-full">` +
        `<img` +
          ` src="${escapeHtml(src)}"` +
          ` alt="${alt}"` +
          ` class="w-full h-auto rounded-xl border border-neutral-200/60 dark:border-neutral-800/60 shadow-sm block cursor-zoom-in notion-zoomable"` +
          ` loading="lazy"` +
          ` data-notion-zoom` +
        `/>` +
        (captionHtml
          ? `<figcaption class="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500 italic">${captionHtml}</figcaption>`
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
    <span class="text-neutral-400 dark:text-neutral-500 mt-[2px] select-none text-sm shrink-0">
      •
    </span>
    <div class="flex-1 text-neutral-700 dark:text-neutral-300">
      <span class="whitespace-pre-wrap">${text}</span>
      ${childrenHtml ? `<div class="mt-2 ml-1 border-l border-neutral-200 dark:border-neutral-700 pl-4">${childrenHtml}</div>` : ""}
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
    <span class="text-neutral-400 dark:text-neutral-500 mt-[2px] select-none text-sm shrink-0 min-w-[1.25rem] text-right font-mono">
      ${num}
    </span>
    <div class="flex-1 text-neutral-700 dark:text-neutral-300">
      <span class="whitespace-pre-wrap">${text}</span>
      ${childrenHtml ? `<div class="mt-2 ml-1 border-l border-neutral-200 dark:border-neutral-700 pl-4">${childrenHtml}</div>` : ""}
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
    gray_background:   "bg-gray-100 dark:bg-gray-800/60 border-gray-200 dark:border-gray-700",
    brown_background:  "bg-stone-100 dark:bg-stone-800/60 border-stone-200 dark:border-stone-700",
    orange_background: "bg-orange-50/80 dark:bg-orange-900/30 border-orange-200/60 dark:border-orange-800/50",
    yellow_background: "bg-amber-50/80 dark:bg-amber-900/30 border-amber-200/60 dark:border-amber-800/50",
    green_background:  "bg-emerald-50/80 dark:bg-emerald-900/30 border-emerald-200/60 dark:border-emerald-800/50",
    blue_background:   "bg-blue-50/80 dark:bg-blue-900/30 border-blue-200/60 dark:border-blue-800/50",
    purple_background: "bg-purple-50/80 dark:bg-purple-900/30 border-purple-200/60 dark:border-purple-800/50",
    pink_background:   "bg-rose-50/80 dark:bg-rose-900/30 border-rose-200/60 dark:border-rose-800/50",
    red_background:    "bg-red-50/80 dark:bg-red-900/30 border-red-200/60 dark:border-red-800/50",
    default:           "bg-neutral-50/60 dark:bg-neutral-800/40 border-neutral-200/50 dark:border-neutral-700/60",
  }
  return colorMap[color] || colorMap.default
}

renderer.addBlockRenderer(
  createBlockRenderer("toggle", async (block) => {
    try {
      const titleHtml = renderRichText(block.toggle?.rich_text) || "Toggle"
      let childrenHtml = ""
      if (block.has_children && block.children?.length > 0) {
        childrenHtml = await renderBlocks(block.children)
      }
      const color = block.toggle?.color || "default"
      const dynamicClasses = getToggleColorClasses(color)
      return (
        `<details class="my-3 rounded-lg border p-3 group transition-colors ${dynamicClasses}">` +
        `<summary class="font-medium cursor-pointer select-none text-neutral-800 dark:text-neutral-200 flex items-center gap-2">` +
        `<span class="text-neutral-400 group-open:text-neutral-600 transition-transform group-open:rotate-90">▸</span>` +
        `<span>${titleHtml}</span>` +
        `</summary>` +
        `<div class="mt-3 pl-6 border-l border-neutral-300 dark:border-neutral-600 text-sm text-neutral-700 dark:text-neutral-300">` +
        `${childrenHtml}` +
        `</div>` +
        `</details>`
      )
    } catch (err) {
      console.error("[toggle] render error:", err)
      return ""
    }
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
    return `<blockquote class="my-4 border-l-4 border-matcha-500 pl-4 pr-4 py-3 font-medium italic text-neutral-700 dark:text-neutral-200 bg-stone-50/80 dark:bg-stone-800/40 rounded-r-card">${textHtml}</blockquote>`
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

export async function getChildBlocks(blockId) {
  const blocks = []
  let cursor = undefined
  while (true) {
    const { results, next_cursor, has_more } = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
    })
    for (const block of results) {
      if (block.type === "child_database") {
        try {
          const dbInfo = await notion.databases.retrieve({ database_id: block.id })
          const dataSourceId = dbInfo.data_sources?.[0]?.id || block.id
          const dbRes = typeof notion.dataSources?.query === 'function'
            ? await notion.dataSources.query({ data_source_id: dataSourceId })
            : await notion.databases.query({ database_id: dataSourceId })
          block.database_rows = dbRes.results || []
        } catch (err) {
          console.error(`Failed to fetch child_database ${block.id}:`, err)
          block.database_rows = []
        }
      } else if (block.type === "child_page") {
        try {
          const pageInfo = await notion.pages.retrieve({ page_id: block.id })
          block.page_info = pageInfo
        } catch (err) {
          console.error(`Failed to fetch child_page ${block.id}:`, err)
        }
      }
      const hasChildren = block.has_children || block.type === "column_list" || block.type === "column"
      if (hasChildren) {
        block.children = await getChildBlocks(block.id)
      }
      blocks.push(block)
    }
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
async function renderBlocks(blocks) {
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

export async function getNotionPageHtml(pageId) {
  const blocks = await getChildBlocks(pageId)
  return await renderBlocks(blocks)
}

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

  let cover = page.cover?.external?.url || page.cover?.file?.url || null
  let icon = extractNotionIcon(page)

  return {
    id: page.id,
    title,
    slug,
    tags,
    category,
    summary,
    cover,
    icon,
    date: page.last_edited_time || page.created_time,
  }
}

export async function getAllPosts() {
  const rootId = process.env.NOTION_ROOT_PAGE_ID || process.env.NOTION_DATABASE_ID
  if (!rootId) return []
  try {
    const dbRes = typeof notion.dataSources?.query === 'function'
      ? await notion.dataSources.query({ data_source_id: rootId })
      : typeof notion.databases?.query === 'function'
        ? await notion.databases.query({ database_id: rootId })
        : await notion.request({ path: `databases/${rootId}/query`, method: 'post' })
    return dbRes.results.map(extractPageProperties)
  } catch (err) {
    try {
      const { results } = await notion.blocks.children.list({ block_id: rootId })
      const pageBlocks = results.filter(b => b.type === 'child_page')
      return pageBlocks.map(b => ({
        id: b.id,
        title: b.child_page?.title || 'Lesson',
        slug: b.child_page?.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || b.id.replace(/-/g, ''),
        tags: ['General'],
        summary: '',
        cover: null,
        icon: '📖',
        date: b.last_edited_time || b.created_time,
      }))
    } catch (childErr) {
      console.error('Failed to fetch posts from Notion Official API:', childErr)
      return []
    }
  }
}

export async function getPageBySlug(slug) {
  const posts = await getAllPosts()
  let post = posts.find(p => p.slug === slug || p.id.replace(/-/g, '') === slug || p.id === slug)

  // Fallback 1: Workspace search across all pages in Notion
  if (!post) {
    try {
      const searchQuery = slug.replace(/-/g, ' ')
      const searchRes = await notion.search({
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
      const page = await notion.pages.retrieve({ page_id: slug })
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
    const html = await getNotionPageHtml(post.id)
    return {
      html,
      id: post.id,
      title: post.title || 'Lesson',
      summary: post.summary || '',
      cover: post.cover || null,
      icon: post.icon || null,
      category: (post.tags && post.tags[0]) || 'Documentation',
      tags: post.tags || [],
    }
  } catch (err) {
    console.error(`Failed to fetch page HTML for id ${post?.id} (slug: ${slug}):`, err)
    return null
  }
}

export { notion }
