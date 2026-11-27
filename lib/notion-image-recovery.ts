/**
 * lib/notion-image-recovery.ts — Client-side Notion image URL recovery helper
 * ───────────────────────────────────────────────────────────────────────────
 * Deduplicates concurrent refresh requests for the same Notion block or cover
 * page and caches freshly fetched signed URLs with expiry-aware TTL and
 * explicit invalidation so failed URLs are never repeatedly served from cache.
 */

export interface NotionImageTarget {
  blockId?: string | null
  pageId?: string | null
}

export interface RefreshNotionImageOptions extends NotionImageTarget {
  failedUrl?: string | null
}

interface RefreshedUrlCacheEntry {
  url: string
  validUntil: number
}

interface BuiltCacheKey {
  cacheKey: string
  cleanBlockId: string
  cleanPageId: string
}

const DEFAULT_CLIENT_URL_CACHE_TTL = 10 * 60 * 1000 // 10 minutes fallback cap
const EXPIRY_SAFETY_BUFFER_MS = 5 * 60 * 1000 // never serve a URL expiring within 5 minutes
const inFlightRequests = new Map<string, Promise<string | null>>()
const refreshedUrlCache = new Map<string, RefreshedUrlCacheEntry>()

function isValidHttpUrl(url: unknown): url is string {
  return typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))
}

function buildCacheKey({ blockId = null, pageId = null }: NotionImageTarget = {}): BuiltCacheKey {
  const cleanBlockId = typeof blockId === 'string' ? blockId.trim() : ''
  const cleanPageId = typeof pageId === 'string' ? pageId.trim() : ''
  if (cleanBlockId) return { cacheKey: `block:${cleanBlockId}`, cleanBlockId, cleanPageId: '' }
  if (cleanPageId) return { cacheKey: `cover:${cleanPageId}`, cleanBlockId: '', cleanPageId }
  return { cacheKey: '', cleanBlockId: '', cleanPageId: '' }
}

function isEntryFresh(entry: RefreshedUrlCacheEntry | undefined, failedUrl: string | null | undefined): boolean {
  if (!entry?.url) return false
  if (failedUrl && entry.url === failedUrl) return false
  const now = Date.now()
  if (now >= entry.validUntil) return false
  return true
}

/**
 * Evicts a cached refreshed URL for a Notion block or page cover (e.g. when
 * the refreshed URL itself fails to load in an <img> element).
 */
export function invalidateNotionImageUrl(target: NotionImageTarget = {}): void {
  const { cacheKey } = buildCacheKey(target)
  if (cacheKey) {
    refreshedUrlCache.delete(cacheKey)
  }
}

/**
 * Fetches a fresh signed URL for a Notion-hosted image block or page cover.
 * Returns the fresh URL string on success, or null if recovery fails.
 */
export async function refreshNotionImageUrl({
  blockId = null,
  pageId = null,
  failedUrl = null,
}: RefreshNotionImageOptions = {}): Promise<string | null> {
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
  const existingRequest = inFlightRequests.get(cacheKey)
  if (existingRequest) {
    return existingRequest
  }

  const endpoint = cleanBlockId
    ? `/api/notion/image?blockId=${encodeURIComponent(cleanBlockId)}`
    : `/api/notion/image?pageId=${encodeURIComponent(cleanPageId)}&kind=cover`

  const promise: Promise<string | null> = (async () => {
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return null
      const data: unknown = await res.json()
      const record = data && typeof data === 'object' ? (data as { url?: unknown; expiresAt?: unknown }) : null
      const freshUrl = record?.url
      if (!isValidHttpUrl(freshUrl)) return null

      const now = Date.now()
      let validUntil = now + DEFAULT_CLIENT_URL_CACHE_TTL
      if (typeof record?.expiresAt === 'string') {
        const expiryMs = Date.parse(record.expiresAt)
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
