/**
 * lib/notion/translations.ts — Bilingual translation mappings & localized links
 * ─────────────────────────────────────────────────────────────────────────────
 * Resolves English/Vietnamese article counterparts via both `Translation Group ID`
 * (root and nested databases) and the dynamic Notion Translation Mapping database,
 * and rewrites internal article links in rendered HTML to point at the active locale.
 */

import { cache } from 'react'
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale } from '../locales'
import { normalizeNotionId } from '../notion-datasource-recovery'
import type {
  ArticleTranslationsMap,
  NotionArticleSummary,
  NotionTranslationMeta,
  TranslationMappingEntry,
  TranslationMappingsResult,
} from '../notion-types'
import {
  MAPPINGS_CACHE_KEY,
  MAPPINGS_CACHE_TTL,
  getCache,
  setCache,
  warnOnce,
} from './cache'
import { fetchPage, queryDatabaseAll } from './client'
import { getAllPublishedPosts } from './posts'
import {
  escapeHtml,
  extractPageProperties,
  findPropertyByName,
  getPropertyPlainText,
  unescapeHtml,
} from './properties'
import type { NotionParentLike } from './types'

const DEFAULT_MAPPING_DB_ID = '415ac39b-0efb-8050-9ab4-ecb760e41cc5'

function normalizeGroupKey(groupId: string | null | undefined): string {
  return String(groupId || '').trim().toLowerCase()
}

function toTranslationMeta(post: NotionArticleSummary): NotionTranslationMeta {
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

const getTranslationIndex = cache(async function getTranslationIndex(): Promise<
  Map<string, Map<string, NotionArticleSummary[]>>
> {
  const posts = await getAllPublishedPosts()
  const groups = new Map<string, Map<string, NotionArticleSummary[]>>()
  const slugs = new Map<string, NotionArticleSummary[]>()

  for (const post of posts) {
    if (post.slug) {
      let slugList = slugs.get(post.slug)
      if (!slugList) {
        slugList = []
        slugs.set(post.slug, slugList)
      }
      slugList.push(post)
    }

    const key = normalizeGroupKey(post.translationGroupId)
    if (!key) continue
    let byLocale = groups.get(key)
    if (!byLocale) {
      byLocale = new Map<string, NotionArticleSummary[]>()
      groups.set(key, byLocale)
    }
    const locale = post.locale || DEFAULT_LOCALE
    let localeList = byLocale.get(locale)
    if (!localeList) {
      localeList = []
      byLocale.set(locale, localeList)
    }
    localeList.push(post)
  }

  for (const [key, byLocale] of groups) {
    for (const [locale, list] of byLocale) {
      if (list.length > 1) {
        const details = list.map((p) => `"${p.title}" (slug: ${p.slug}, id: ${p.id})`).join(', ')
        warnOnce(
          `dup-${key}-${locale}-${list.map((p) => p.id).sort().join(',')}`,
          `[i18n] Duplicate translation: Translation Group ID "${list[0].translationGroupId}" has ${list.length} published "${locale}" articles: ${details}. ` +
            `The language switcher and hreflang links for this group/locale are disabled until only one remains.`
        )
      }
    }
  }

  for (const [slug, list] of slugs) {
    if (list.length > 1) {
      warnOnce(
        `slug-${slug}-${list.map((p) => p.id).sort().join(',')}`,
        `[i18n] Slug collision: ${list.length} published articles share the slug "${slug}" (${list.map((p) => `${p.locale}: ${p.id}`).join(', ')}). Give each language version its own Slug.`
      )
    }
  }

  return groups
})

export const getTranslatedArticle = cache(async function getTranslatedArticle(
  translationGroupId: string | null | undefined,
  targetLocale: string | null | undefined
): Promise<NotionTranslationMeta | null> {
  const key = normalizeGroupKey(translationGroupId)
  if (!key || !targetLocale) return null
  const locale = normalizeLocale(targetLocale)

  const index = await getTranslationIndex()
  const candidates = index.get(key)?.get(locale) || []
  if (candidates.length !== 1) return null
  return toTranslationMeta(candidates[0])
})

export async function getTranslationMappings(): Promise<TranslationMappingsResult> {
  const cached = getCache<TranslationMappingsResult>(MAPPINGS_CACHE_KEY, MAPPINGS_CACHE_TTL)
  if (cached) return cached

  const mappingDbId = (
    process.env.NOTION_TRANSLATION_MAPPING_DATABASE_ID || DEFAULT_MAPPING_DB_ID
  ).trim()

  const byEnId = new Map<string, TranslationMappingEntry>()
  const byViId = new Map<string, TranslationMappingEntry>()
  const all: TranslationMappingEntry[] = []

  if (!mappingDbId) {
    const empty: TranslationMappingsResult = { byEnId, byViId, all }
    setCache(MAPPINGS_CACHE_KEY, empty)
    return empty
  }

  try {
    const dbRes = await queryDatabaseAll(mappingDbId, { __ttl: MAPPINGS_CACHE_TTL })
    const rows = dbRes?.results || []

    for (const page of rows) {
      const props = page.properties || {}

      let name = 'Untitled'
      for (const key of Object.keys(props)) {
        const prop = props[key]
        if (prop?.type === 'title' && prop.title && prop.title.length > 0) {
          name = prop.title.map((t) => t.plain_text || '').join('')
          break
        }
      }

      const enProp = findPropertyByName(props, [
        'EN Page ID',
        'EN Page Id',
        'English Page ID',
        'EN ID',
        'EnPageId',
      ])
      const enPageId = getPropertyPlainText(enProp).trim()

      const viProp = findPropertyByName(props, [
        'VI Page ID',
        'VI Page Id',
        'Vietnamese Page ID',
        'VI ID',
        'ViPageId',
      ])
      const viPageId = getPropertyPlainText(viProp).trim()

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

      const entry: TranslationMappingEntry = {
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
  } catch (err: unknown) {
    console.error(`[Translation Mapping] Failed to query mapping database ${mappingDbId}:`, err)
  }

  const result: TranslationMappingsResult = { byEnId, byViId, all }
  setCache(MAPPINGS_CACHE_KEY, result)
  return result
}

export async function getArticleTranslations(
  article:
    | Pick<NotionArticleSummary, 'id' | 'locale' | 'translationGroupId' | 'parent'>
    | null
    | undefined
): Promise<ArticleTranslationsMap> {
  const currentLocale = article?.locale || DEFAULT_LOCALE
  const result: ArticleTranslationsMap = {}
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

    const parentLike = article.parent as NotionParentLike | null | undefined
    const parentDbId = parentLike?.database_id || parentLike?.data_source_id
    if (parentDbId) {
      try {
        const dbRes = await queryDatabaseAll(parentDbId)
        const rows = (dbRes?.results || []).map(extractPageProperties).filter((p) => {
          if (!p || !p.title || p.title === 'Untitled') return false
          const s = (p.status || '').toLowerCase()
          return s !== 'draft' && s !== 'archived' && s !== 'hidden'
        })
        const targetGroupKey = normalizeGroupKey(article.translationGroupId)
        const groupRows = rows.filter(
          (r) => normalizeGroupKey(r.translationGroupId) === targetGroupKey
        )
        const selfMatches = groupRows.filter(
          (r) => (r.locale || DEFAULT_LOCALE) === currentLocale
        )
        if (
          selfMatches.length === 1 &&
          normalizeNotionId(selfMatches[0].id) === normalizeNotionId(article.id)
        ) {
          for (const locale of Object.keys(result)) {
            const candidates = groupRows.filter((r) => (r.locale || DEFAULT_LOCALE) === locale)
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
        } catch (fetchErr: unknown) {
          console.error(`Failed to fetch VI translated page ${mapping.viPageId}:`, fetchErr)
        }
      }
    }

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
        } catch (fetchErr: unknown) {
          console.error(`Failed to fetch EN translated page ${mapping.enPageId}:`, fetchErr)
        }
      }
    }
  } catch (mapErr: unknown) {
    console.error('Failed to resolve translations from dynamic mapping database:', mapErr)
  }

  return result
}

const getLocalizedLinkMap = cache(async function getLocalizedLinkMap(
  locale: string
): Promise<Map<string, string>> {
  const posts = await getAllPublishedPosts()
  const map = new Map<string, string>()
  for (const post of posts) {
    if (!post.translationGroupId || (post.locale || DEFAULT_LOCALE) === locale) continue
    const self = await getTranslatedArticle(post.translationGroupId, post.locale)
    if (!self || normalizeNotionId(self.id) !== normalizeNotionId(post.id)) continue
    const target = await getTranslatedArticle(post.translationGroupId, locale)
    if (!target?.slug) continue
    if (post.slug) map.set(post.slug, target.slug)
    map.set(normalizeNotionId(post.id), target.slug)
  }

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

export async function localizeInternalLinks(html: string, locale: string): Promise<string> {
  if (!html || !locale) return html
  const map = await getLocalizedLinkMap(normalizeLocale(locale))
  if (map.size === 0) return html

  return html.replace(
    /href="\/([^"\/?#]+)([^"]*)"/g,
    (match: string, segment: string, rest: string) => {
      let key = unescapeHtml(segment)
      try {
        key = decodeURIComponent(key)
      } catch {
        /* keep raw */
      }
      let target = map.get(key)
      if (!target) {
        const compact = key.replace(/-/g, '').toLowerCase()
        if (/^[0-9a-f]{32}$/.test(compact)) target = map.get(compact)
      }
      return target ? `href="/${escapeHtml(target)}${rest}"` : match
    }
  )
}
