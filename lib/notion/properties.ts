/**
 * lib/notion/properties.ts — Pure Notion property extraction & HTML formatting
 * ────────────────────────────────────────────────────────────────────────────
 * Stateless helpers shared by the article catalog, block renderer, access checks,
 * translations, and navigation. Performs zero Notion API calls so every layer
 * can import it without introducing circular dependencies.
 */

import type { PageObjectResponse, RichTextItemResponse } from '@notionhq/client'
import { normalizeLocale } from '../locales'
import type {
  NotionArticleSummary,
  NotionIcon,
  NotionPageParent,
} from '../notion-types'
import type {
  NotionPageLike,
  NotionPropertiesMap,
  NotionPropertyLike,
  RichTextLike,
} from './types'

export function escapeHtml(str: unknown): string {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function unescapeHtml(str: string): string {
  return String(str)
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

export function slugifyText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
}

/**
 * Formats an ISO date string into a human-readable format, e.g. "06 Aug 2026".
 */
export function formatDate(isoStr: string | null | undefined): string {
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

const NOTION_TEXT_COLORS: Record<string, string> = {
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

export function getNotionTextColorClasses(color: string | null | undefined): string {
  if (!color || color === 'default') return ''
  return NOTION_TEXT_COLORS[color] || ''
}

/**
 * Renders an array of Notion rich_text objects into styled HTML with support
 * for bold, italic, strikethrough, underline, color, code, and links.
 */
export function renderRichText(
  richTextArray: RichTextLike[] | RichTextItemResponse[] | undefined
): string {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return ''
  return richTextArray
    .map((t) => {
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
    })
    .join('')
}

/**
 * Returns a plain-text value for a Notion property.
 * Used for isEmpty checks, property lookups, and fallback rendering.
 */
export function getPropertyPlainText(prop: NotionPropertyLike | null | undefined): string {
  if (!prop) return ''
  const type = prop.type
  switch (type) {
    case 'title':
      return prop.title?.map((t) => t.plain_text || '').join('') || ''
    case 'rich_text':
      return prop.rich_text?.map((t) => t.plain_text || '').join('') || ''
    case 'select':
      return prop.select?.name || ''
    case 'multi_select':
      return prop.multi_select?.map((item) => item.name || '').join(', ') || ''
    case 'number':
      return prop.number !== undefined && prop.number !== null ? String(prop.number) : ''
    case 'date':
      if (!prop.date) return ''
      return prop.date.end ? `${prop.date.start || ''} → ${prop.date.end}` : prop.date.start || ''
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
      if (prop.formula?.type === 'number') {
        return prop.formula.number !== null && prop.formula.number !== undefined
          ? String(prop.formula.number)
          : ''
      }
      if (prop.formula?.type === 'boolean') return prop.formula.boolean ? '✓' : '✗'
      if (prop.formula?.type === 'date') return prop.formula.date?.start || ''
      return ''
    case 'created_time':
      return prop.created_time || ''
    case 'last_edited_time':
      return prop.last_edited_time || ''
    default: {
      if (!type) return ''
      const rawValue = prop[type]
      if (Array.isArray(rawValue)) {
        return rawValue
          .map((item) => {
            if (item && typeof item === 'object') {
              const obj = item as { plain_text?: string; name?: string }
              return obj.plain_text || obj.name || ''
            }
            return ''
          })
          .join(', ')
      }
      if (typeof rawValue === 'object' && rawValue !== null) {
        const obj = rawValue as { name?: string; plain_text?: string }
        return obj.name || obj.plain_text || ''
      }
      return rawValue !== undefined && rawValue !== null ? String(rawValue) : ''
    }
  }
}

export function findPropertyByName(
  props: NotionPropertiesMap | null | undefined,
  candidates: readonly string[]
): NotionPropertyLike | null {
  const normalize = (s: string) => String(s).toLowerCase().replace(/[\s_-]+/g, '')
  const keysByNorm = new Map<string, string>()
  for (const key of Object.keys(props || {})) {
    const norm = normalize(key)
    if (!keysByNorm.has(norm)) keysByNorm.set(norm, key)
  }
  for (const candidate of candidates) {
    const key = keysByNorm.get(normalize(candidate))
    if (key && props?.[key]) return props[key] ?? null
  }
  return null
}

function extractNotionIcon(page: NotionPageLike | null | undefined): NotionIcon {
  if (!page?.icon) return null
  const icon = page.icon
  if (typeof icon === 'string') {
    return icon.startsWith('http') ? { type: 'external', value: icon } : { type: 'emoji', value: icon }
  }
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
  return null
}

function extractParentTitle(props: NotionPropertiesMap | null | undefined): string | null {
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

  const normalizeKey = (s: string) => String(s).toLowerCase().replace(/[\s_-]+/g, '')
  const propEntries = Object.entries(props)

  for (const candidate of candidates) {
    const targetNorm = normalizeKey(candidate)
    const matchedEntry = propEntries.find(([k]) => normalizeKey(k) === targetNorm)
    const p = matchedEntry ? matchedEntry[1] : null
    if (!p) continue

    // ── Rollup property ──────────────────────────────────────────────────────
    if (p.type === 'rollup' && p.rollup) {
      const r = p.rollup
      if (r.type === 'array' && Array.isArray(r.array)) {
        for (const item of r.array) {
          if (item.type === 'title' && item.title && item.title.length > 0) {
            const text = item.title.map((t) => t.plain_text || '').join('').trim()
            if (text) return text
          }
          if (item.type === 'rich_text' && item.rich_text && item.rich_text.length > 0) {
            const text = item.rich_text.map((t) => t.plain_text || '').join('').trim()
            if (text) return text
          }
          if (item.type === 'select' && item.select?.name) {
            return item.select.name.trim()
          }
          if (item.type === 'relation' && item.relation && item.relation.length > 0 && item.relation[0].id) {
            return item.relation[0].id
          }
        }
      }
      if (r.type === 'title' && r.title && r.title.length > 0) {
        return r.title.map((t) => t.plain_text || '').join('').trim() || null
      }
      if (r.type === 'rich_text' && r.rich_text && r.rich_text.length > 0) {
        return r.rich_text.map((t) => t.plain_text || '').join('').trim() || null
      }
    }

    // ── Plain rich_text, select, formula (string), relation ──────────────────
    if (p.type === 'rich_text' && p.rich_text && p.rich_text.length > 0) {
      return p.rich_text.map((t) => t.plain_text || '').join('').trim() || null
    }
    if (p.type === 'select' && p.select?.name) return p.select.name
    if (p.type === 'formula' && p.formula?.type === 'string' && p.formula.string) {
      return p.formula.string.trim() || null
    }
    if (p.type === 'relation' && p.relation && p.relation.length > 0 && p.relation[0].id) {
      return p.relation[0].id
    }
  }

  return null
}

/**
 * Returns true when a Notion page is archived, trashed, or carries a non-Published status.
 * Pages without any Status property (e.g., nested lesson child_page nodes) are allowed
 * when their parent hierarchy is public.
 */
export function isPageStatusHidden(page: NotionPageLike | PageObjectResponse | null | undefined): boolean {
  if (!page) return true
  const pageLike = page as NotionPageLike
  if (pageLike.archived || pageLike.in_trash) return true
  const props = pageLike.properties || {}
  const statusProp = props.Status || props.status || props.type
  if (!statusProp) {
    return false
  }
  if (typeof statusProp.checkbox === 'boolean') {
    return !statusProp.checkbox
  }
  const rawStatus = statusProp?.status?.name ?? statusProp?.select?.name ?? ''
  const normalized = String(rawStatus).trim().toLowerCase()
  if (!normalized) {
    return statusProp.type === 'status' || statusProp.type === 'select'
  }
  return normalized !== 'published'
}

export function extractPageProperties(page: NotionPageLike): NotionArticleSummary {
  const props = page.properties || {}

  let title = 'Untitled'
  for (const key of Object.keys(props)) {
    const prop = props[key]
    if (prop?.type === 'title' && prop.title && prop.title.length > 0) {
      title = prop.title.map((t) => t.plain_text || '').join('')
      break
    }
  }

  let slug = ''
  if (props.Slug?.rich_text) slug = props.Slug.rich_text.map((t) => t.plain_text || '').join('')
  else if (props.slug?.rich_text) slug = props.slug.rich_text.map((t) => t.plain_text || '').join('')
  if (!slug) {
    slug = slugifyText(title) || page.id.replace(/-/g, '')
  }

  let tags: string[] = []
  const tagProp = props.Tags || props.tags
  if (tagProp?.multi_select) {
    tags = tagProp.multi_select.map((item) => item.name || '').filter(Boolean)
  } else if (tagProp?.select?.name) {
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
    category = catProp.rich_text.map((t) => t.plain_text || '').join('')
  }
  if (!category && tags.length > 0) {
    category = tags[0]
  }

  let summary = ''
  const sumProp = props.Summary || props.summary
  if (sumProp?.rich_text) {
    summary = sumProp.rich_text.map((t) => t.plain_text || '').join('')
  }

  const cover = page.cover ? page.cover?.external?.url || page.cover?.file?.url || null : null
  const coverIsNotionHosted = page.cover?.type === 'file'
  const icon = extractNotionIcon(page)
  const parentTitle = extractParentTitle(props)

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

  const locale = normalizeLocale(getPropertyPlainText(findPropertyByName(props, ['Locale'])))

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
    coverIsNotionHosted,
    icon,
    parentTitle,
    parent: (page.parent as NotionPageParent | null) || null,
    order,
    status,
    locale,
    translationGroupId,
    date: page.last_edited_time || page.created_time,
  }
}
