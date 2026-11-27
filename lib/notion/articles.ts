/**
 * lib/notion/articles.ts — Article slug resolution & full page assembly
 * ─────────────────────────────────────────────────────────────────────
 * Resolves a public article or nested lesson by slug or Notion UUID, enforces
 * public-content authorization via `access.ts`, determines the active locale
 * (including mapped Vietnamese/English child pages), renders blocks via
 * `renderer.ts`, and localizes internal links via `translations.ts`.
 */

import { cache } from 'react'
import { DEFAULT_LOCALE } from '../locales'
import { normalizeNotionId } from '../notion-datasource-recovery'
import type { NotionArticlePage, NotionArticleSummary } from '../notion-types'
import { isPublicNotionPage } from './access'
import { fetchPage, isValidNotionId, searchNotion } from './client'
import { getAllPosts } from './posts'
import { extractPageProperties, isPageStatusHidden, slugifyText } from './properties'
import { getNotionPageData } from './renderer'
import { getTranslationMappings, localizeInternalLinks } from './translations'
import type { NotionPageLike, NotionParentLike } from './types'

export const getPageBySlug = cache(async function getPageBySlug(
  slug: string
): Promise<NotionArticlePage | null> {
  if (!slug || typeof slug !== 'string') {
    return null
  }

  const posts = await getAllPosts('all')
  const slugIsNotionId = isValidNotionId(slug)
  const slugNormId = slugIsNotionId ? normalizeNotionId(slug) : ''
  let post = posts.find(
    (p) => p.slug === slug || (Boolean(slugNormId) && normalizeNotionId(p.id) === slugNormId)
  )

  // Fallback 1: Direct Notion page retrieval only when slug is a valid Notion UUID
  if (!post && slugIsNotionId) {
    try {
      if (await isPublicNotionPage(slug)) {
        const page = await fetchPage(slug)
        if (page && page.id && !isPageStatusHidden(page)) {
          post = extractPageProperties(page)
        }
      }
    } catch {
      // Ignore retrieve error
    }
  }

  // Fallback 2: Workspace search for nested public pages/embedded database rows (non-UUID slugs only)
  if (!post && !slugIsNotionId) {
    try {
      const searchQuery = slug.replace(/-/g, ' ')
      const searchRes = await searchNotion({
        query: searchQuery,
        filter: { value: 'page', property: 'object' },
      })

      const exactMatches: Array<{ page: NotionPageLike; extracted: NotionArticleSummary }> = []
      const titleMatches: Array<{ page: NotionPageLike; extracted: NotionArticleSummary }> = []

      for (const page of searchRes.results || []) {
        if (!page?.id || isPageStatusHidden(page)) continue
        const extracted = extractPageProperties(page)
        const rawTitle = extracted.title || ''
        const slugifiedTitle = slugifyText(rawTitle)
        const rawSlug = extracted.slug || ''
        const idNoHyphens = page.id.replace(/-/g, '')

        if (
          rawSlug === slug ||
          slugifiedTitle === slug ||
          idNoHyphens === slug ||
          page.id === slug
        ) {
          exactMatches.push({ page, extracted })
        } else if (
          extracted.title &&
          extracted.title.toLowerCase().trim() === searchQuery.toLowerCase().trim()
        ) {
          titleMatches.push({ page, extracted })
        }
      }

      for (const candidate of [...exactMatches, ...titleMatches]) {
        if (await isPublicNotionPage(candidate.page.id)) {
          post = candidate.extracted
          break
        }
      }
    } catch (searchErr: unknown) {
      console.error(`Failed workspace search fallback for slug ${slug}:`, searchErr)
    }
  }

  if (!post || !post.id || !(await isPublicNotionPage(post.id))) {
    return null
  }

  try {
    let locale = post.locale || DEFAULT_LOCALE
    // Resolve child-page locale from Notion Translation Mapping database
    try {
      const mappings = await getTranslationMappings()
      const normId = normalizeNotionId(post.id)
      const parentLike = post.parent as NotionParentLike | null | undefined
      if (mappings.byViId.has(normId)) {
        locale = 'vi'
        post.locale = 'vi'
      } else if (mappings.byEnId.has(normId)) {
        locale = 'en'
        post.locale = 'en'
      } else if (parentLike?.type === 'page_id' && parentLike.page_id) {
        const parentNormId = normalizeNotionId(parentLike.page_id)
        if (mappings.byViId.has(parentNormId)) {
          locale = 'vi'
          post.locale = 'vi'
        }
      }
    } catch {
      // Ignore mapping resolution errors
    }

    const { html: rawHtml, blocks } = await getNotionPageData(post.id, locale)
    let html = rawHtml
    try {
      html = await localizeInternalLinks(rawHtml, locale)
    } catch (linkErr: unknown) {
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
      coverIsNotionHosted: Boolean(post.coverIsNotionHosted),
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
  } catch (err: unknown) {
    console.error(`Failed to fetch page HTML for id ${post?.id} (slug: ${slug}):`, err)
    return null
  }
})
