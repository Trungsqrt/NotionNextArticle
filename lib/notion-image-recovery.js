/**
 * lib/notion-image-recovery.js — Client-side Notion image URL recovery helper
 * ───────────────────────────────────────────────────────────────────────────
 * Deduplicates concurrent refresh requests for the same Notion block or cover
 * page and caches freshly fetched signed URLs with expiry-aware TTL and
 * explicit invalidation so failed URLs are never repeatedly served from cache.
 */

const DEFAULT_CLIENT_URL_CACHE_TTL = 10 * 60 * 1000 // 10 minutes fallback cap
const EXPIRY_SAFETY_BUFFER_MS = 5 * 60 * 1000 // never serve a URL expiring within 5 minutes
const inFlightRequests = new Map()
const refreshedUrlCache = new Map()

function isValidHttpUrl(url) {
  return typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))
}

function buildCacheKey({ blockId = null, pageId = null } = {}) {
  const cleanBlockId = typeof blockId === 'string' ? blockId.trim() : ''
  const cleanPageId = typeof pageId === 'string' ? pageId.trim() : ''
  if (cleanBlockId) return { cacheKey: `block:${cleanBlockId}`, cleanBlockId, cleanPageId: '' }
  if (cleanPageId) return { cacheKey: `cover:${cleanPageId}`, cleanBlockId: '', cleanPageId }
  return { cacheKey: '', cleanBlockId: '', cleanPageId: '' }
}

function isEntryFresh(entry, failedUrl) {
  if (!entry?.url) return false
  if (failedUrl && entry.url === failedUrl) return false
  const now = Date.now()
  if (now >= entry.validUntil) return false
  return true
}

/**
 * Evicts a cached refreshed URL for a Notion block or page cover (e.g. when
 * the refreshed URL itself fails to load in an <img> element).
 *
 * @param {{ blockId?: string | null, pageId?: string | null }} target
 */
export function invalidateNotionImageUrl(target = {}) {
  const { cacheKey } = buildCacheKey(target)
  if (cacheKey) {
    refreshedUrlCache.delete(cacheKey)
  }
}

/**
 * Fetches a fresh signed URL for a Notion-hosted image block or page cover.
 * Returns the fresh URL string on success, or null if recovery fails.
 *
 * @param {{ blockId?: string | null, pageId?: string | null, failedUrl?: string | null }} target
 * @returns {Promise<string | null>}
 */
export async function refreshNotionImageUrl({ blockId = null, pageId = null, failedUrl = null } = {}) {
  const { cacheKey, cleanBlockId, cleanPageId } = buildCacheKey({ blockId, pageId })
  if (!cacheKey) return null

  // 1. Return recently recovered URL if still fresh and different from the URL that just failed
  const cached = refreshedUrlCache.get(cacheKey)
  if (cached) {
    if (isEntryFresh(cached, failedUrl)) {
      return cached.url
    }
    refreshedUrlCache.delete(cacheKey)
  }

  // 2. Deduplicate concurrent requests for the same image
  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey)
  }

  const endpoint = cleanBlockId
    ? `/api/notion/image?blockId=${encodeURIComponent(cleanBlockId)}`
    : `/api/notion/image?pageId=${encodeURIComponent(cleanPageId)}&kind=cover`

  const promise = (async () => {
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return null
      const data = await res.json()
      const freshUrl = data?.url
      if (!isValidHttpUrl(freshUrl)) return null

      const now = Date.now()
      let validUntil = now + DEFAULT_CLIENT_URL_CACHE_TTL
      if (typeof data?.expiresAt === 'string') {
        const expiryMs = Date.parse(data.expiresAt)
        if (!Number.isNaN(expiryMs)) {
          validUntil = Math.min(validUntil, expiryMs - EXPIRY_SAFETY_BUFFER_MS)
        }
      }

      if (validUntil > now) {
        refreshedUrlCache.set(cacheKey, { url: freshUrl, validUntil })
      }
      return freshUrl
    } catch {
      return null
    } finally {
      inFlightRequests.delete(cacheKey)
    }
  })()

  inFlightRequests.set(cacheKey, promise)
  return promise
}
