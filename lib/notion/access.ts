/**
 * lib/notion/access.ts — Public Knowledge Hub content authorization
 * ─────────────────────────────────────────────────────────────────
 * Verifies that a requested Notion page or image block belongs to published
 * public Knowledge Hub content under `NOTION_ROOT_PAGE_ID` / `NOTION_DATABASE_ID`
 * before rendering or refreshing signed image URLs. Rejects drafts, archived/trashed
 * items, and pages outside the public Knowledge Hub tree.
 */

import { normalizeNotionId, parsePublicNotionId } from '../notion-datasource-recovery'
import type { NotionArticleSummary } from '../notion-types'
import { PUBLIC_PAGE_CACHE_TTL, getCache, setCache } from './cache'
import {
  fetchDatabase,
  fetchPage,
  getPublicNotionRootId,
  isValidNotionId,
  notion,
} from './client'
import { getAllPosts } from './posts'
import { isPageStatusHidden } from './properties'
import type { NotionBlockLike, NotionPageLike, NotionParentLike } from './types'

const MAX_PARENT_TRAVERSAL_DEPTH = 12

export async function isPublicNotionPage(
  pageId: string,
  visited: Set<string> = new Set(),
  depth = 0
): Promise<boolean> {
  if (!isValidNotionId(pageId) || depth > MAX_PARENT_TRAVERSAL_DEPTH) return false
  const normId = normalizeNotionId(pageId)
  if (visited.has(normId)) return false
  visited.add(normId)

  const cacheKey = `public-page-access-${normId}`
  const cachedAccess = getCache<boolean>(cacheKey, PUBLIC_PAGE_CACHE_TTL)
  if (typeof cachedAccess === 'boolean') return cachedAccess

  const rootId = getPublicNotionRootId()
  const rootNormId = rootId ? normalizeNotionId(parsePublicNotionId(rootId).id) : ''
  if (rootNormId && normId === rootNormId) {
    setCache(cacheKey, true)
    return true
  }

  let posts: NotionArticleSummary[] = []
  try {
    posts = await getAllPosts('all')
  } catch {
    posts = []
  }

  const matchedPost = posts.find((p) => Boolean(p?.id) && normalizeNotionId(p.id) === normId)
  if (matchedPost) {
    const status = String(matchedPost.status || '').trim().toLowerCase()
    const allowed = status === 'published'
    setCache(cacheKey, allowed)
    return allowed
  }

  let page: NotionPageLike
  try {
    page = await fetchPage(pageId)
  } catch {
    return false
  }

  if (isPageStatusHidden(page)) {
    setCache(cacheKey, false)
    return false
  }

  const parent = page.parent
  if (!parent) {
    setCache(cacheKey, false)
    return false
  }

  let allowed = false
  if (parent.type === 'page_id' && parent.page_id) {
    allowed = await isPublicNotionPage(parent.page_id, visited, depth + 1)
  } else if (parent.type === 'block_id' && parent.block_id) {
    allowed = await isBlockInPublicContent(
      { id: parent.block_id, type: 'unknown', parent: null },
      visited,
      depth + 1
    )
  } else if (
    (parent.type === 'database_id' || parent.type === 'data_source_id') &&
    (parent.database_id || parent.data_source_id)
  ) {
    const parentDbNorm = parent.database_id ? normalizeNotionId(parent.database_id) : ''
    const parentDsNorm = parent.data_source_id ? normalizeNotionId(parent.data_source_id) : ''
    if (rootNormId && (parentDbNorm === rootNormId || parentDsNorm === rootNormId)) {
      allowed = true
    } else if (parent.database_id) {
      try {
        const db = await fetchDatabase(parent.database_id)
        if (!db || db.archived || db.in_trash) {
          allowed = false
        } else if (db.parent?.type === 'page_id' && db.parent.page_id) {
          allowed = await isPublicNotionPage(db.parent.page_id, visited, depth + 1)
        } else if (db.parent?.type === 'block_id' && db.parent.block_id) {
          allowed = await isBlockInPublicContent(
            { id: db.parent.block_id, type: 'unknown', parent: null },
            visited,
            depth + 1
          )
        }
      } catch {
        allowed = false
      }
    }
  }

  setCache(cacheKey, allowed)
  return allowed
}

export async function isBlockInPublicContent(
  block: Pick<NotionBlockLike, 'id' | 'archived' | 'in_trash' | 'parent'> & { type?: string },
  visited: Set<string> = new Set(),
  depth = 0
): Promise<boolean> {
  if (!block || depth > MAX_PARENT_TRAVERSAL_DEPTH) return false

  let current: (Pick<NotionBlockLike, 'id' | 'archived' | 'in_trash' | 'parent'> & { type?: string }) | null = block
  for (let step = depth; step <= MAX_PARENT_TRAVERSAL_DEPTH; step++) {
    if (!current) return false
    if (current.archived || current.in_trash) return false

    let parent: NotionParentLike | null | undefined = current.parent
    if (!parent && current.id && isValidNotionId(current.id)) {
      try {
        current = (await notion.blocks.retrieve({ block_id: current.id })) as unknown as NotionBlockLike
        if (!current || current.archived || current.in_trash) return false
        parent = current.parent
      } catch {
        return false
      }
    }

    if (!parent) return false
    if (parent.type === 'page_id' && parent.page_id) {
      return isPublicNotionPage(parent.page_id, visited, step + 1)
    }
    if (parent.type === 'block_id' && parent.block_id) {
      const parentNorm = normalizeNotionId(parent.block_id)
      if (visited.has(`block:${parentNorm}`)) return false
      visited.add(`block:${parentNorm}`)
      current = { id: parent.block_id, parent: null }
      continue
    }
    return false
  }

  return false
}
