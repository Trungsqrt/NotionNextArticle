/**
 * lib/notion/images.ts — On-demand Notion signed image URL recovery
 * ─────────────────────────────────────────────────────────────────
 * Refreshes expiring Notion-hosted S3 URLs for image blocks and page covers
 * using 5-minute TTL caching, single-flight request deduplication, expiry
 * safety buffers, and strict public-content authorization via `access.ts`.
 */

import { normalizeNotionId } from '../notion-datasource-recovery'
import type { RefreshedImageUrl } from '../notion-types'
import { isBlockInPublicContent, isPublicNotionPage } from './access'
import {
  IMAGE_EXPIRY_SAFETY_BUFFER_MS,
  IMAGE_REFRESH_CACHE_TTL,
  getCache,
  getImageRefreshInFlight,
  setCache,
} from './cache'
import { getNotionErrorStatusOrCode, isValidNotionId, notion } from './client'
import { isPageStatusHidden } from './properties'
import type { ImageRefreshCacheEntry, NotionBlockLike, NotionPageLike } from './types'

function isUrlStillFresh(
  entry: ImageRefreshCacheEntry | null | undefined
): entry is ImageRefreshCacheEntry {
  if (!entry?.url) return false
  if (Date.now() - entry.timestamp >= IMAGE_REFRESH_CACHE_TTL) return false
  if (entry.expiryTime) {
    const expiryMs = Date.parse(entry.expiryTime)
    if (!Number.isNaN(expiryMs) && expiryMs - Date.now() <= IMAGE_EXPIRY_SAFETY_BUFFER_MS) {
      return false
    }
  }
  return true
}

/**
 * Retrieves a fresh signed URL for a Notion-hosted image block.
 * Returns { url, expiryTime } or null when unavailable/inaccessible/non-image.
 */
export async function refreshNotionBlockImageUrl(
  blockId: string
): Promise<RefreshedImageUrl | null> {
  if (!isValidNotionId(blockId)) return null
  const normId = normalizeNotionId(blockId)
  const cacheKey = `fresh-image-block-${normId}`

  const cached = getCache<ImageRefreshCacheEntry>(cacheKey, IMAGE_REFRESH_CACHE_TTL)
  if (isUrlStillFresh(cached)) {
    return { url: cached.url, expiryTime: cached.expiryTime }
  }

  const inFlight = getImageRefreshInFlight()
  const existingFlight = inFlight.get(cacheKey)
  if (existingFlight) {
    return existingFlight
  }

  const promise: Promise<RefreshedImageUrl | null> = (async () => {
    try {
      const block = (await notion.blocks.retrieve({ block_id: blockId })) as unknown as NotionBlockLike
      if (!block || block.archived || block.in_trash) return null
      if (block.type !== 'image' || block.image?.type !== 'file') return null

      const freshUrl = block.image?.file?.url || ''
      const expiryTime = block.image?.file?.expiry_time || null
      if (!freshUrl) return null

      const isPublic = await isBlockInPublicContent(block)
      if (!isPublic) return null

      const entry: ImageRefreshCacheEntry = { url: freshUrl, expiryTime, timestamp: Date.now() }
      setCache(cacheKey, entry)
      return { url: freshUrl, expiryTime }
    } catch (err: unknown) {
      const status = getNotionErrorStatusOrCode(err)
      if (
        status === 404 ||
        status === 'object_not_found' ||
        status === 400 ||
        status === 'validation_error'
      ) {
        return null
      }
      throw err
    } finally {
      inFlight.delete(cacheKey)
    }
  })()

  inFlight.set(cacheKey, promise)
  return promise
}

/**
 * Retrieves a fresh signed URL for a Notion-hosted page cover image.
 * Returns { url, expiryTime } or null when unavailable/inaccessible/external.
 */
export async function refreshNotionPageCoverUrl(pageId: string): Promise<RefreshedImageUrl | null> {
  if (!isValidNotionId(pageId)) return null
  const normId = normalizeNotionId(pageId)
  const cacheKey = `fresh-cover-page-${normId}`

  const cached = getCache<ImageRefreshCacheEntry>(cacheKey, IMAGE_REFRESH_CACHE_TTL)
  if (isUrlStillFresh(cached)) {
    return { url: cached.url, expiryTime: cached.expiryTime }
  }

  const inFlight = getImageRefreshInFlight()
  const existingFlight = inFlight.get(cacheKey)
  if (existingFlight) {
    return existingFlight
  }

  const promise: Promise<RefreshedImageUrl | null> = (async () => {
    try {
      // Bypass 50-min page cache to get a freshly signed cover URL directly from Notion
      const page = (await notion.pages.retrieve({ page_id: pageId })) as unknown as NotionPageLike
      if (!page || isPageStatusHidden(page)) return null
      if (page.cover?.type !== 'file') return null

      const freshUrl = page.cover?.file?.url || ''
      const expiryTime = page.cover?.file?.expiry_time || null
      if (!freshUrl) return null

      const isPublic = await isPublicNotionPage(page.id)
      if (!isPublic) return null

      const entry: ImageRefreshCacheEntry = { url: freshUrl, expiryTime, timestamp: Date.now() }
      setCache(cacheKey, entry)
      return { url: freshUrl, expiryTime }
    } catch (err: unknown) {
      const status = getNotionErrorStatusOrCode(err)
      if (
        status === 404 ||
        status === 'object_not_found' ||
        status === 400 ||
        status === 'validation_error'
      ) {
        return null
      }
      throw err
    } finally {
      inFlight.delete(cacheKey)
    }
  })()

  inFlight.set(cacheKey, promise)
  return promise
}
