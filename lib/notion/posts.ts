/**
 * lib/notion/posts.ts — Published Knowledge Hub article catalog
 * ─────────────────────────────────────────────────────────────
 * Lists all published top-level articles from the configured Notion root
 * database or root page (with locale-based slug disambiguation).
 * Kept separate from `articles.ts` (`getPageBySlug`) so `access.ts`,
 * `translations.ts`, and `navigation.ts` can read the published catalog
 * without creating circular dependencies.
 */

import { DEFAULT_LOCALE, normalizeLocale } from '../locales'
import type { NotionArticleSummary } from '../notion-types'
import { withRequestCache } from './cache'
import {
  fetchPage,
  getPublicNotionRootId,
  listAllChildren,
  queryDatabaseAll,
} from './client'
import { extractPageProperties, isPageStatusHidden } from './properties'

export const getAllPublishedPosts = withRequestCache(async function getAllPublishedPosts(): Promise<
  NotionArticleSummary[]
> {
  const rootId = getPublicNotionRootId()
  if (!rootId) return []

  let allPosts: NotionArticleSummary[] = []

  // 1. Try querying as a database (all pages, cursor-paginated)
  try {
    const dbRes = await queryDatabaseAll(rootId)
    if (dbRes?.results?.length > 0) {
      allPosts = dbRes.results.filter((p) => !isPageStatusHidden(p)).map(extractPageProperties)
    }
  } catch {
    // Not queryable as database
  }

  // 2. Try listing child pages or child databases under root page
  if (allPosts.length === 0) {
    try {
      const results = await listAllChildren(rootId)
      const dbBlocks = results.filter((b) => b.type === 'child_database')
      const pageBlocks = results.filter((b) => b.type === 'child_page')

      if (dbBlocks.length > 0) {
        const dbPostsNested = await Promise.all(
          dbBlocks.map(async (dbBlock) => {
            try {
              const dbRes = await queryDatabaseAll(dbBlock.id)
              return (dbRes?.results || [])
                .filter((p) => !isPageStatusHidden(p))
                .map(extractPageProperties)
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
              if (isPageStatusHidden(p)) return null
              return extractPageProperties(p)
            } catch {
              return null
            }
          })
        )
        for (const childPage of childPages) {
          if (childPage) allPosts.push(childPage)
        }
      }
    } catch {
      // Root page not listable as block
    }
  }

  // Filter only Published posts (exclude Draft, Archived, Hidden, and non-Published statuses)
  const published = allPosts.filter((p) => {
    if (!p || !p.title || p.title === 'Untitled') return false
    const s = String(p.status || '').trim().toLowerCase()
    return s === 'published'
  })

  // Disambiguate duplicate slugs automatically based on locale
  const slugCounts = new Map<string, number>()
  for (const post of published) {
    if (!post.slug) continue
    slugCounts.set(post.slug, (slugCounts.get(post.slug) || 0) + 1)
  }

  for (const post of published) {
    if (post.slug && (slugCounts.get(post.slug) || 0) > 1) {
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
 */
export const getAllPosts = withRequestCache(async function getAllPosts(
  locale: string = 'all'
): Promise<NotionArticleSummary[]> {
  const posts = await getAllPublishedPosts()
  if (!locale || locale === 'all') return posts
  const target = normalizeLocale(locale)
  return posts.filter((p) => (p.locale || DEFAULT_LOCALE) === target)
})
