/**
 * lib/notion/navigation.ts — Lesson & sibling page navigation
 * ───────────────────────────────────────────────────────────
 * Resolves previous/next sibling articles for both embedded/course database
 * items (ordered by `Order` and scoped by locale / `parentTitle`) and nested
 * child pages (preserving Notion block order and mapping translated siblings).
 */

import { cache } from 'react'
import { DEFAULT_LOCALE } from '../locales'
import { normalizeNotionId } from '../notion-datasource-recovery'
import type {
  NotionArticleSummary,
  SiblingNavPage,
  SiblingPagesResult,
} from '../notion-types'
import {
  fetchChildrenList,
  fetchPage,
  getPublicNotionRootId,
  queryDatabaseAll,
} from './client'
import { getAllPosts } from './posts'
import { extractPageProperties, slugifyText } from './properties'
import { getTranslatedArticle, getTranslationMappings } from './translations'
import type { NotionBlockLike, NotionParentLike } from './types'

interface RawChildPageRef {
  id: string
  title: string
}

function toNavPage(r: NotionArticleSummary | undefined): SiblingNavPage | null {
  return r ? { id: r.id, title: r.title, slug: r.slug, icon: r.icon || null } : null
}

export const getSiblingPages = cache(async function getSiblingPages(
  currentPage:
    | Pick<NotionArticleSummary, 'id' | 'slug' | 'parent' | 'locale' | 'parentTitle'>
    | null
    | undefined
): Promise<SiblingPagesResult> {
  if (!currentPage || !currentPage.id) {
    return { prevPage: null, nextPage: null }
  }

  let parent: NotionParentLike | null | undefined =
    currentPage.parent as NotionParentLike | null | undefined
  if (!parent) {
    try {
      const pageDetails = await fetchPage(currentPage.id)
      parent = pageDetails?.parent || null
    } catch (err: unknown) {
      console.error(`Failed to retrieve parent information for page ${currentPage.id}:`, err)
      return { prevPage: null, nextPage: null }
    }
  }

  if (!parent || !parent.type) {
    return { prevPage: null, nextPage: null }
  }

  const currentNormId = normalizeNotionId(currentPage.id)
  const currentLocale = currentPage.locale || DEFAULT_LOCALE
  const rootId = getPublicNotionRootId()

  // Case A: Database item
  if (parent.type === 'database_id' || parent.type === 'data_source_id') {
    const parentDbId = parent.database_id || parent.data_source_id
    const isRootDb = Boolean(rootId) && normalizeNotionId(parentDbId) === normalizeNotionId(rootId)

    if (!isRootDb && parentDbId) {
      try {
        const dbRes = await queryDatabaseAll(parentDbId)
        const rows = (dbRes?.results || [])
          .map(extractPageProperties)
          .filter((p) => {
            if (!p || !p.title || p.title === 'Untitled') return false
            const s = (p.status || '').toLowerCase()
            if (s === 'draft' || s === 'archived' || s === 'hidden') return false
            return (p.locale || DEFAULT_LOCALE) === currentLocale
          })
          .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

        const idx = rows.findIndex((r) => normalizeNotionId(r.id) === currentNormId)
        if (idx === -1 || rows.length <= 1) return { prevPage: null, nextPage: null }
        return {
          prevPage: idx > 0 ? toNavPage(rows[idx - 1]) : null,
          nextPage: idx < rows.length - 1 ? toNavPage(rows[idx + 1]) : null,
        }
      } catch {
        return { prevPage: null, nextPage: null }
      }
    }

    if (currentPage.parentTitle) {
      const targetParentTitle = currentPage.parentTitle.trim()
      try {
        const localePosts = await getAllPosts(currentLocale)
        const siblings = localePosts
          .filter((p) => Boolean(p.parentTitle) && p.parentTitle!.trim() === targetParentTitle)
          .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

        const idx = siblings.findIndex((r) => normalizeNotionId(r.id) === currentNormId)
        if (idx === -1 || siblings.length <= 1) return { prevPage: null, nextPage: null }
        return {
          prevPage: idx > 0 ? toNavPage(siblings[idx - 1]) : null,
          nextPage: idx < siblings.length - 1 ? toNavPage(siblings[idx + 1]) : null,
        }
      } catch {
        return { prevPage: null, nextPage: null }
      }
    }

    return { prevPage: null, nextPage: null }
  }

  // Case B: Current page's parent type is 'page_id' or 'workspace' (or 'block_id')
  const isNestedPage =
    parent.type === 'page_id' || parent.type === 'workspace' || parent.type === 'block_id'
  if (!isNestedPage) {
    return { prevPage: null, nextPage: null }
  }

  let parentId: string | null = null
  if (parent.type === 'page_id') {
    parentId = parent.page_id || null
  } else if (parent.type === 'block_id') {
    parentId = parent.block_id || null
  } else if (parent.type === 'workspace') {
    parentId = rootId || null
  }

  if (!parentId) {
    return { prevPage: null, nextPage: null }
  }

  const parentBlocks: NotionBlockLike[] = []
  try {
    let cursor: string | undefined = undefined
    while (true) {
      const res = await fetchChildrenList(parentId, cursor)
      if (!res || !res.results) break
      parentBlocks.push(...(res.results as unknown as NotionBlockLike[]))
      if (!res.has_more || !res.next_cursor) break
      cursor = res.next_cursor
    }
  } catch (err: unknown) {
    console.error(`Failed to fetch child blocks for parent ${parentId}:`, err)
    return { prevPage: null, nextPage: null }
  }

  const childPageBlocks = parentBlocks.filter((block) => block.type === 'child_page')
  if (childPageBlocks.length <= 1) {
    return { prevPage: null, nextPage: null }
  }

  const rawChildPages: RawChildPageRef[] = childPageBlocks.map((block) => ({
    id: block.id,
    title: block.child_page?.title || 'Untitled Page',
  }))

  const allPosts = await getAllPosts('all').catch(() => [] as NotionArticleSummary[])
  const findPost = (id: string) =>
    allPosts.find((post) => normalizeNotionId(post.id) === normalizeNotionId(id))

  const childPages: RawChildPageRef[] = []
  const seenIds = new Set<string>()
  const mappings = await getTranslationMappings().catch(() => null)

  for (const sibling of rawChildPages) {
    let entry: RawChildPageRef = sibling
    const isCurrent = normalizeNotionId(sibling.id) === currentNormId
    const post = findPost(sibling.id)
    if (!isCurrent && post && (post.locale || DEFAULT_LOCALE) !== currentLocale) {
      const translated = post.translationGroupId
        ? await getTranslatedArticle(post.translationGroupId, currentLocale).catch(() => null)
        : null
      if (!translated) continue
      entry = { id: translated.id, title: translated.title }
    } else if (!isCurrent && mappings) {
      const sibNorm = normalizeNotionId(sibling.id)
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
    const key = normalizeNotionId(entry.id)
    if (seenIds.has(key)) continue
    seenIds.add(key)
    childPages.push(entry)
  }

  const currentIndex = childPages.findIndex((page) => normalizeNotionId(page.id) === currentNormId)
  if (currentIndex === -1) {
    return { prevPage: null, nextPage: null }
  }

  const rawPrev = currentIndex > 0 ? childPages[currentIndex - 1] : null
  const rawNext = currentIndex < childPages.length - 1 ? childPages[currentIndex + 1] : null

  const mapSiblingToNavPage = (sibling: RawChildPageRef | null): SiblingNavPage | null => {
    if (!sibling) return null
    const matched = findPost(sibling.id)

    if (matched) {
      return {
        id: matched.id || sibling.id,
        title: matched.title || sibling.title || 'Untitled Page',
        slug:
          matched.slug ||
          (matched.title ? slugifyText(matched.title) : sibling.id.replace(/-/g, '')),
        icon: matched.icon || null,
      }
    }

    const title = sibling.title || 'Untitled Page'
    const fallbackSlug = slugifyText(title) || sibling.id.replace(/-/g, '')
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
