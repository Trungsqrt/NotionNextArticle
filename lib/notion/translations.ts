/**
 * lib/notion/translations.ts — Bilingual translation mappings & localized links
 * ─────────────────────────────────────────────────────────────────────────────
 * Resolves English/Vietnamese article counterparts via both `Translation Group ID`
 * (root and nested databases) and the dynamic Notion Translation Mapping database,
 * and rewrites internal article links in rendered HTML to point at the active locale.
 */

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale } from '../locales'
import { normalizeNotionId } from '../notion-datasource-recovery'
import type {
  ArticleTranslationsMap,
  NotionArticleSummary,
  NotionTranslationMeta,
  TranslationMappingEntry,
  TranslationMappingsResult,
} from '../notion-types'
import { isPublicNotionPage } from './access'
import {
  MAPPINGS_CACHE_KEY,
  MAPPINGS_CACHE_TTL,
  getCache,
  setCache,
  warnOnce,
  withRequestCache,
} from './cache'
import { fetchPage, isValidNotionId, queryDatabaseAll } from './client'
import { getAllPublishedPosts } from './posts'
import {
  escapeHtml,
  extractPageProperties,
  findPropertyByName,
  getPropertyPlainText,
  isPageStatusHidden,
  unescapeHtml,
} from './properties'
import type { NotionParentLike, QueryDatabaseOptions } from './types'

const DEFAULT_MAPPING_DB_ID = '415ac39b-0efb-8050-9ab4-ecb760e41cc5'

function normalizeGroupKey(groupId: string | null | undefined): string {
  return String(groupId || '').trim().toLowerCase()
}

/**
 * Resolves the canonical URL segment for an authorized translation target:
 * - Reuses the published catalog slug (including `-vi` disambiguation) for
 *   top-level articles whenever that slug resolves unambiguously to `pageId`.
 * - Falls back to the compact Notion UUID for authorized nested pages outside
 *   the published catalog (or rare ambiguous catalog slugs) so `getPageBySlug`
 *   resolves deterministically via Fallback 1 without relying on workspace search.
 */
function resolveCanonicalTranslationSlug(
  pageId: string,
  catalogPosts: readonly NotionArticleSummary[]
): string {
  const normId = normalizeNotionId(pageId)
  const catalogPost = catalogPosts.find(
    (p) => Boolean(p?.id) && normalizeNotionId(p.id) === normId
  )

  if (catalogPost?.slug) {
    const matchingBySlug = catalogPosts.filter((p) => p.slug === catalogPost.slug)
    if (
      matchingBySlug.length === 1 &&
      normalizeNotionId(matchingBySlug[0].id) === normId
    ) {
      return catalogPost.slug
    }
  }

  return normId
}

function toTranslationMeta(
  post: NotionArticleSummary,
  canonicalSlug?: string
): NotionTranslationMeta {
  return {
    id: post.id,
    slug: canonicalSlug || post.slug || normalizeNotionId(post.id),
    title: post.title,
    summary: post.summary || '',
    icon: post.icon || null,
    locale: post.locale || DEFAULT_LOCALE,
    translationGroupId: post.translationGroupId || '',
    date: post.date || null,
  }
}

const getTranslationIndex = withRequestCache(async function getTranslationIndex(): Promise<
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

export const getTranslatedArticle = withRequestCache(async function getTranslatedArticle(
  translationGroupId: string | null | undefined,
  targetLocale: string | null | undefined
): Promise<NotionTranslationMeta | null> {
  const key = normalizeGroupKey(translationGroupId)
  if (!key || !targetLocale) return null
  const locale = normalizeLocale(targetLocale)

  const [index, catalogPosts] = await Promise.all([
    getTranslationIndex(),
    getAllPublishedPosts(),
  ])
  const candidates = index.get(key)?.get(locale) || []
  if (candidates.length !== 1) return null
  const candidate = candidates[0]
  return toTranslationMeta(candidate, resolveCanonicalTranslationSlug(candidate.id, catalogPosts))
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
  const currentLocale = normalizeLocale(article?.locale || DEFAULT_LOCALE)
  const result: ArticleTranslationsMap = {}
  for (const locale of SUPPORTED_LOCALES) {
    if (locale !== currentLocale) result[locale] = null
  }
  if (!article?.id) return result

  const normId = normalizeNotionId(article.id)
  const catalogPosts = await getAllPublishedPosts().catch(() => [] as NotionArticleSummary[])

  let hasGroupTranslation = false
  if (article.translationGroupId) {
    const self = await getTranslatedArticle(article.translationGroupId, currentLocale)
    if (self && normalizeNotionId(self.id) === normId) {
      for (const locale of Object.keys(result)) {
        const found = await getTranslatedArticle(article.translationGroupId, locale)
        if (found && normalizeNotionId(found.id) !== normId) {
          result[locale] = found
          hasGroupTranslation = true
        }
      }
      if (hasGroupTranslation) return result
    }

    const parentLike = article.parent as NotionParentLike | null | undefined
    const queryTargetId = parentLike?.data_source_id || parentLike?.database_id
    if (queryTargetId) {
      try {
        const queryOpts: QueryDatabaseOptions = parentLike?.data_source_id
          ? {
              __isDataSourceId: true,
              ...(parentLike.database_id ? { __databaseId: parentLike.database_id } : {}),
            }
          : {}
        const dbRes = await queryDatabaseAll(queryTargetId, queryOpts)
        const rows = (dbRes?.results || [])
          .filter((rawPage) => Boolean(rawPage?.id) && !isPageStatusHidden(rawPage))
          .map(extractPageProperties)
          .filter((p) => Boolean(p && p.title && p.title !== 'Untitled'))
        const targetGroupKey = normalizeGroupKey(article.translationGroupId)
        const groupRows = rows.filter(
          (r) => normalizeGroupKey(r.translationGroupId) === targetGroupKey
        )
        const selfMatches = groupRows.filter(
          (r) => (r.locale || DEFAULT_LOCALE) === currentLocale
        )
        if (
          selfMatches.length === 1 &&
          normalizeNotionId(selfMatches[0].id) === normId
        ) {
          for (const locale of Object.keys(result)) {
            const candidates = groupRows.filter(
              (r) =>
                (r.locale || DEFAULT_LOCALE) === locale &&
                normalizeNotionId(r.id) !== normId
            )
            if (candidates.length === 1) {
              const candidate = candidates[0]
              if (await isPublicNotionPage(candidate.id)) {
                result[locale] = toTranslationMeta(
                  candidate,
                  resolveCanonicalTranslationSlug(candidate.id, catalogPosts)
                )
                hasGroupTranslation = true
              }
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
  // A Ready mapping never grants public access by itself: each target must pass
  // `!isPageStatusHidden()` and `isPublicNotionPage()` before being exposed.
  try {
    const mappings = await getTranslationMappings()

    const resolveAuthorizedMappedTarget = async (
      targetPageId: string,
      targetLocale: 'en' | 'vi'
    ): Promise<NotionTranslationMeta | null> => {
      if (!targetPageId || !isValidNotionId(targetPageId)) return null
      const targetNormId = normalizeNotionId(targetPageId)
      if (!targetNormId || targetNormId === normId) return null

      // Prevent conflicting mappings where getPageBySlug() would resolve targetLocale to 'vi'
      if (targetLocale === 'en' && mappings.byViId.has(targetNormId)) {
        return null
      }

      const targetPage = await fetchPage(targetPageId)
      if (!targetPage || !targetPage.id || isPageStatusHidden(targetPage)) {
        return null
      }
      if (!(await isPublicNotionPage(targetPage.id))) {
        return null
      }

      const targetExtracted = extractPageProperties(targetPage)
      const canonicalSlug = resolveCanonicalTranslationSlug(targetPage.id, catalogPosts)
      return toTranslationMeta(
        {
          ...targetExtracted,
          locale: targetLocale,
        },
        canonicalSlug
      )
    }

    if ('vi' in result) {
      const mapping = mappings.byEnId.get(normId)
      if (mapping && mapping.isReady && mapping.viPageId) {
        try {
          result.vi = await resolveAuthorizedMappedTarget(mapping.viPageId, 'vi')
        } catch (fetchErr: unknown) {
          console.error(`Failed to fetch VI translated page ${mapping.viPageId}:`, fetchErr)
        }
      }
    }

    if ('en' in result) {
      const mapping = mappings.byViId.get(normId)
      if (mapping && mapping.isReady && mapping.enPageId) {
        try {
          result.en = await resolveAuthorizedMappedTarget(mapping.enPageId, 'en')
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

const getLocalizedLinkMap = withRequestCache(async function getLocalizedLinkMap(
  locale: string
): Promise<Map<string, string>> {
  const targetLocale = normalizeLocale(locale)
  const posts = await getAllPublishedPosts()
  const map = new Map<string, string>()

  const catalogByNormId = new Map<string, NotionArticleSummary>()
  const slugCounts = new Map<string, number>()
  for (const post of posts) {
    if (post.id) catalogByNormId.set(normalizeNotionId(post.id), post)
    if (post.slug) slugCounts.set(post.slug, (slugCounts.get(post.slug) || 0) + 1)
  }

  for (const post of posts) {
    if (!post.translationGroupId || (post.locale || DEFAULT_LOCALE) === targetLocale) continue
    const self = await getTranslatedArticle(post.translationGroupId, post.locale)
    if (!self || normalizeNotionId(self.id) !== normalizeNotionId(post.id)) continue
    const target = await getTranslatedArticle(post.translationGroupId, targetLocale)
    if (!target?.slug || normalizeNotionId(target.id) === normalizeNotionId(post.id)) continue
    if (post.slug && slugCounts.get(post.slug) === 1) {
      map.set(post.slug, target.slug)
    }
    map.set(normalizeNotionId(post.id), target.slug)
  }

  try {
    const mappings = await getTranslationMappings()
    for (const entry of mappings.all) {
      if (!entry.isReady) continue

      const sourceNormId = targetLocale === 'vi' ? entry.normEnId : entry.normViId
      const targetPageId = targetLocale === 'vi' ? entry.viPageId : entry.enPageId
      if (!sourceNormId || !targetPageId || !isValidNotionId(targetPageId)) continue

      const targetNormId = normalizeNotionId(targetPageId)
      if (!targetNormId || targetNormId === sourceNormId) continue
      if (targetLocale === 'en' && mappings.byViId.has(targetNormId)) continue
      if (map.has(sourceNormId)) continue

      // Authorize target before rewriting internal links so Draft/private targets are never exposed
      const isCatalogPublished = catalogByNormId.has(targetNormId)
      const isAuthorized = isCatalogPublished || (await isPublicNotionPage(targetPageId))
      if (!isAuthorized) continue

      const targetSlug = resolveCanonicalTranslationSlug(targetPageId, posts)
      map.set(sourceNormId, targetSlug)

      const sourcePost = catalogByNormId.get(sourceNormId)
      if (sourcePost?.slug && slugCounts.get(sourcePost.slug) === 1 && !map.has(sourcePost.slug)) {
        map.set(sourcePost.slug, targetSlug)
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
