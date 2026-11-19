/**
 * lib/notion-image-recovery.js — Client-side Notion image URL recovery helper
 * ───────────────────────────────────────────────────────────────────────────
 * Deduplicates concurrent refresh requests for the same Notion block or cover
 * page and caches freshly fetched signed URLs briefly in memory so multiple
 * views (e.g. inline + lightbox or repeated blocks) do not trigger redundant
 * API calls.
 */

const CLIENT_URL_CACHE_TTL = 10 * 60 * 1000 // 10 minutes (Notion signed URLs last 60 min)
const inFlightRequests = new Map()
const refreshedUrlCache = new Map()

function isValidHttpUrl(url) {
  return typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))
}

/**
 * Fetches a fresh signed URL for a Notion-hosted image block or page cover.
 * Returns the fresh URL string on success, or null if recovery fails.
 *
 * @param {{ blockId?: string | null, pageId?: string | null }} target
 * @returns {Promise<string | null>}
 */
export async function refreshNotionImageUrl({ blockId = null, pageId = null } = {}) {
  const cleanBlockId = typeof blockId === 'string' ? blockId.trim() : ''
  const cleanPageId = typeof pageId === 'string' ? pageId.trim() : ''

  if (!cleanBlockId && !cleanPageId) return null

  const cacheKey = cleanBlockId ? `block:${cleanBlockId}` : `cover:${cleanPageId}`

  // 1. Return recently recovered URL if still fresh
  const cached = refreshedUrlCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CLIENT_URL_CACHE_TTL) {
    return cached.url
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

      refreshedUrlCache.set(cacheKey, { url: freshUrl, timestamp: Date.now() })
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
