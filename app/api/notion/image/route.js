import { NextResponse } from 'next/server'
import {
  isValidNotionId,
  refreshNotionBlockImageUrl,
  refreshNotionPageCoverUrl,
} from '../../../../lib/notion'

export const dynamic = 'force-dynamic'

// Lightweight in-memory sliding-window rate limiter per IP
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 60
const rateLimitStore = new Map()

function getClientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-real-ip') || 'unknown'
}

function checkRateLimit(ip) {
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

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
}

export async function GET(request) {
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
      return NextResponse.json({ url: result.url }, { status: 200, headers: NO_STORE_HEADERS })
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
      return NextResponse.json({ url: result.url }, { status: 200, headers: NO_STORE_HEADERS })
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
