import { NextResponse, type NextRequest } from 'next/server'
import {
  isValidNotionId,
  refreshNotionBlockImageUrl,
  refreshNotionPageCoverUrl,
} from '../../../../lib/notion'
import type { NotionImageApiResponse } from '../../../../lib/notion-types'

export const dynamic = 'force-dynamic'

interface RateLimitEntry {
  count: number
  windowStart: number
}

interface RateLimitCheckResult {
  allowed: boolean
  retryAfterSec: number
}

// Best-effort per-instance sliding-window limiter.
// Note: On Vercel Serverless, in-memory Maps are scoped to individual warm
// instances and are not a global rate limit. Pair with Vercel Firewall (WAF)
// rate-limiting rules on /api/notion/image for true global edge enforcement.
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 60
const rateLimitStore = new Map<string, RateLimitEntry>()

function getClientIp(request: NextRequest): string {
  const vercelIp = request.headers.get('x-vercel-forwarded-for')
  if (vercelIp) return vercelIp.split(',')[0].trim()
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return 'unknown'
}

function isCrossSiteRequest(request: NextRequest): boolean {
  const fetchSite = (request.headers.get('sec-fetch-site') || '').trim().toLowerCase()
  return fetchSite === 'cross-site'
}

function checkRateLimit(ip: string): RateLimitCheckResult {
  const now = Date.now()

  // Periodically prune stale IP entries to keep memory bounded
  if (rateLimitStore.size > 500) {
    for (const [key, entry] of rateLimitStore.entries()) {
      if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
        rateLimitStore.delete(key)
      }
    }
  }

  const entry = rateLimitStore.get(ip)
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now })
    return { allowed: true, retryAfterSec: 0 }
  }

  entry.count += 1
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000)
    )
    return { allowed: false, retryAfterSec }
  }

  return { allowed: true, retryAfterSec: 0 }
}

const NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store, max-age=0',
}

export async function GET(request: NextRequest): Promise<NextResponse<NotionImageApiResponse>> {
  if (isCrossSiteRequest(request)) {
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403, headers: NO_STORE_HEADERS }
    )
  }

  const ip = getClientIp(request)
  const { allowed, retryAfterSec } = checkRateLimit(ip)
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: {
          ...NO_STORE_HEADERS,
          'Retry-After': String(retryAfterSec),
        },
      }
    )
  }

  const { searchParams } = new URL(request.url)
  const blockId = (searchParams.get('blockId') || '').trim()
  const pageId = (searchParams.get('pageId') || '').trim()
  const kind = (searchParams.get('kind') || '').trim().toLowerCase()

  const isCoverRequest = Boolean(pageId) && (!kind || kind === 'cover')
  const isBlockRequest = Boolean(blockId) && !isCoverRequest

  if (isBlockRequest) {
    if (!isValidNotionId(blockId)) {
      return NextResponse.json(
        { error: 'Invalid image identifier' },
        { status: 400, headers: NO_STORE_HEADERS }
      )
    }

    try {
      const result = await refreshNotionBlockImageUrl(blockId)
      if (!result?.url) {
        return NextResponse.json(
          { error: 'Image not available' },
          { status: 404, headers: NO_STORE_HEADERS }
        )
      }
      return NextResponse.json(
        {
          url: result.url,
          ...(result.expiryTime ? { expiresAt: result.expiryTime } : {}),
        },
        { status: 200, headers: NO_STORE_HEADERS }
      )
    } catch {
      return NextResponse.json(
        { error: 'Unable to refresh image' },
        { status: 502, headers: NO_STORE_HEADERS }
      )
    }
  }

  if (isCoverRequest) {
    if (!isValidNotionId(pageId)) {
      return NextResponse.json(
        { error: 'Invalid image identifier' },
        { status: 400, headers: NO_STORE_HEADERS }
      )
    }

    try {
      const result = await refreshNotionPageCoverUrl(pageId)
      if (!result?.url) {
        return NextResponse.json(
          { error: 'Image not available' },
          { status: 404, headers: NO_STORE_HEADERS }
        )
      }
      return NextResponse.json(
        {
          url: result.url,
          ...(result.expiryTime ? { expiresAt: result.expiryTime } : {}),
        },
        { status: 200, headers: NO_STORE_HEADERS }
      )
    } catch {
      return NextResponse.json(
        { error: 'Unable to refresh image' },
        { status: 502, headers: NO_STORE_HEADERS }
      )
    }
  }

  return NextResponse.json(
    { error: 'Missing image identifier' },
    { status: 400, headers: NO_STORE_HEADERS }
  )
}
