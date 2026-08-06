import { Client } from "@notionhq/client"
import { NotionRenderer, createBlockRenderer } from "@notion-render/client"
import hljsPlugin from "@notion-render/hljs-plugin"

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
      }
      if (block.has_children) {
        block.children = await getChildBlocks(block.id)
      }
      blocks.push(block)
    }
    if (!has_more) break
    cursor = next_cursor
  }
  return blocks
}

export async function getNotionPageHtml(pageId) {
  const blocks = await getChildBlocks(pageId)
  return await renderer.render(...blocks)
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

  let summary = ''
  const sumProp = props.Summary || props.summary
  if (sumProp?.rich_text) {
    summary = sumProp.rich_text.map(t => t.plain_text).join('')
  }

  let cover = page.cover?.external?.url || page.cover?.file?.url || null
  let icon = page.icon?.emoji || page.icon?.external?.url || page.icon?.file?.url || null

  return {
    id: page.id,
    title,
    slug,
    tags,
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
  let post = posts.find(p => p.slug === slug || p.id.replace(/-/g, '') === slug)

  let pageId = post?.id || slug

  try {
    const html = await getNotionPageHtml(pageId)
    return {
      html,
      id: pageId,
      title: post?.title || 'Lesson',
      summary: post?.summary || '',
    }
  } catch (err) {
    console.error(`Failed to fetch page by slug ${slug}:`, err)
    return null
  }
}

export { notion }
