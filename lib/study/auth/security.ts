/**
 * lib/study/auth/security.ts — Rate limiting, CSRF protection & private headers
 * ──────────────────────────────────────────────────────────────────────────────
 * Supports shared distributed rate limiting via Upstash Redis REST API when
 * `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured, with
 * automatic fallback to per-instance in-memory Maps for local dev/testing.
 * For production on Vercel, configure either Upstash Redis env vars or Vercel
 * Firewall (WAF) rate-limiting rules on /api/study/auth/login.
 */

export const NO_STORE_PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
}

interface RateLimitBucket {
  count: number
  windowStart: number
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const LOGIN_MAX_PER_IP = 15
const LOGIN_MAX_PER_USERNAME = 8

function getRateLimitStore(): Map<string, RateLimitBucket> {
  const g = globalThis as unknown as { __studyRateLimitStore?: Map<string, RateLimitBucket> }
  if (!g.__studyRateLimitStore) {
    g.__studyRateLimitStore = new Map()
  }
  return g.__studyRateLimitStore
}

function pruneExpiredBuckets(store: Map<string, RateLimitBucket>, now: number, maxWindowMs: number): void {
  if (store.size <= 500) return
  for (const [key, bucket] of store.entries()) {
    if (now - bucket.windowStart >= maxWindowMs) {
      store.delete(key)
    }
  }
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec: number
}

function consumeBucket(
  key: string,
  maxRequests: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitResult {
  const store = getRateLimitStore()
  pruneExpiredBuckets(store, now, windowMs)

  const existing = store.get(key)
  if (!existing || now - existing.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now })
    return { allowed: true, retryAfterSec: 0 }
  }

  existing.count += 1
  if (existing.count > maxRequests) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowMs - (now - existing.windowStart)) / 1000)
    )
    return { allowed: false, retryAfterSec }
  }

  return { allowed: true, retryAfterSec: 0 }
}

export function getClientIp(request: Request): string {
  const vercelIp = request.headers.get('x-vercel-forwarded-for')
  if (vercelIp) return vercelIp.split(',')[0].trim()
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return 'unknown'
}

export function checkLoginRateLimit(
  ip: string,
  username: string,
  now: number = Date.now()
): RateLimitResult {
  const cleanIp = (ip || 'unknown').trim()
  const cleanUser = (username || '').trim().toLowerCase()

  const ipCheck = consumeBucket(`login:ip:${cleanIp}`, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS, now)
  if (!ipCheck.allowed) return ipCheck

  if (cleanUser) {
    const userCheck = consumeBucket(
      `login:user:${cleanUser}`,
      LOGIN_MAX_PER_USERNAME,
      LOGIN_WINDOW_MS,
      now
    )
    if (!userCheck.allowed) return userCheck
  }

  return { allowed: true, retryAfterSec: 0 }
}

export function resetLoginRateLimit(ip: string, username: string): void {
  const store = getRateLimitStore()
  if (ip) store.delete(`login:ip:${ip.trim()}`)
  if (username) store.delete(`login:user:${username.trim().toLowerCase()}`)
}

export function clearAllStudyRateLimits(): void {
  getRateLimitStore().clear()
}

export function checkApiRateLimit(
  ip: string,
  bucketName: string,
  maxRequests: number = 60,
  windowMs: number = 60 * 1000,
  now: number = Date.now()
): RateLimitResult {
  const cleanIp = (ip || 'unknown').trim()
  return consumeBucket(`api:${bucketName}:${cleanIp}`, maxRequests, windowMs, now)
}

function getUpstashConfig(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '')
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim()
  if (!url || !token) return null
  return { url, token }
}

async function consumeDistributedBucket(
  key: string,
  maxRequests: number,
  windowMs: number,
  now: number = Date.now()
): Promise<RateLimitResult> {
  const upstash = getUpstashConfig()
  if (!upstash) {
    return consumeBucket(key, maxRequests, windowMs, now)
  }

  const redisKey = `study:rl:${key}`
  try {
    const res = await fetch(`${upstash.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstash.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', redisKey],
        ['PEXPIRE', redisKey, String(windowMs), 'NX'],
        ['PTTL', redisKey],
      ]),
      signal: AbortSignal.timeout(3000),
    })

    if (!res.ok) {
      return consumeBucket(key, maxRequests, windowMs, now)
    }

    const payload = (await res.json()) as Array<{ result?: unknown }>
    const count = Number(payload?.[0]?.result)
    const pttl = Number(payload?.[2]?.result)

    if (!Number.isFinite(count)) {
      return consumeBucket(key, maxRequests, windowMs, now)
    }

    if (count > maxRequests) {
      const remainingMs = Number.isFinite(pttl) && pttl > 0 ? pttl : windowMs
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(remainingMs / 1000)),
      }
    }

    return { allowed: true, retryAfterSec: 0 }
  } catch {
    // Graceful degradation to per-instance memory if Redis is transiently unreachable
    return consumeBucket(key, maxRequests, windowMs, now)
  }
}

export async function checkLoginRateLimitAsync(
  ip: string,
  username: string,
  now: number = Date.now()
): Promise<RateLimitResult> {
  const cleanIp = (ip || 'unknown').trim()
  const cleanUser = (username || '').trim().toLowerCase()

  const ipCheck = await consumeDistributedBucket(
    `login:ip:${cleanIp}`,
    LOGIN_MAX_PER_IP,
    LOGIN_WINDOW_MS,
    now
  )
  if (!ipCheck.allowed) return ipCheck

  if (cleanUser) {
    const userCheck = await consumeDistributedBucket(
      `login:user:${cleanUser}`,
      LOGIN_MAX_PER_USERNAME,
      LOGIN_WINDOW_MS,
      now
    )
    if (!userCheck.allowed) return userCheck
  }

  return { allowed: true, retryAfterSec: 0 }
}

export async function resetLoginRateLimitAsync(ip: string, username: string): Promise<void> {
  resetLoginRateLimit(ip, username)
  const upstash = getUpstashConfig()
  if (!upstash) return

  const commands: string[][] = []
  if (ip) commands.push(['DEL', `study:rl:login:ip:${ip.trim()}`])
  if (username) commands.push(['DEL', `study:rl:login:user:${username.trim().toLowerCase()}`])
  if (commands.length === 0) return

  try {
    await fetch(`${upstash.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstash.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // Ignore Redis reset failure
  }
}

export async function checkApiRateLimitAsync(
  ip: string,
  bucketName: string,
  maxRequests: number = 60,
  windowMs: number = 60 * 1000,
  now: number = Date.now()
): Promise<RateLimitResult> {
  const cleanIp = (ip || 'unknown').trim()
  return consumeDistributedBucket(`api:${bucketName}:${cleanIp}`, maxRequests, windowMs, now)
}

/**
 * Verifies same-origin CSRF protection for state-changing HTTP methods
 * (POST, PUT, PATCH, DELETE) using Fetch Metadata + Origin/Host matching.
 */
export function verifyCsrfOrigin(request: Request): { ok: true } | { ok: false; reason: string } {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return { ok: true }
  }

  const fetchSite = (request.headers.get('sec-fetch-site') || '').trim().toLowerCase()
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, reason: 'cross_site_fetch_metadata' }
  }

  const origin = (request.headers.get('origin') || '').trim()
  const host = (
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    ''
  )
    .split(',')[0]
    .trim()
    .toLowerCase()

  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase()
      if (host && originHost !== host) {
        return { ok: false, reason: 'origin_host_mismatch' }
      }
    } catch {
      return { ok: false, reason: 'invalid_origin_header' }
    }
    return { ok: true }
  }

  const referer = (request.headers.get('referer') || '').trim()
  if (referer) {
    try {
      const refHost = new URL(referer).host.toLowerCase()
      if (host && refHost !== host) {
        return { ok: false, reason: 'referer_host_mismatch' }
      }
    } catch {
      return { ok: false, reason: 'invalid_referer_header' }
    }
    return { ok: true }
  }

  // If neither Origin nor Referer is present, allow only when Sec-Fetch-Site is explicitly same-origin
  if (fetchSite === 'same-origin') {
    return { ok: true }
  }

  return { ok: false, reason: 'missing_origin_header' }
}
