/**
 * lib/notion/cache.ts — Shared in-memory cache, TTL constants, and deduplication maps
 * ───────────────────────────────────────────────────────────────────────────────────
 * Preserves the existing `globalThis.__notionCache`, `globalThis.__notionI18nWarnings`,
 * and `globalThis.__notionImageRefreshInFlight` stores so warm server instances and
 * HMR reloads keep consistent cache keys, TTLs, and single-flight tracking.
 */

import * as React from 'react'
import type { RefreshedImageUrl } from '../notion-types'
import './types'

/**
 * Wraps a function with React's per-request `cache()` in Next.js RSC runtimes,
 * falling back to the plain function in standalone Node test environments where
 * React 18's CJS entrypoint does not expose `React.cache`.
 */
export function withRequestCache<T extends (...args: never[]) => unknown>(fn: T): T {
  const reactCache = (
    React as { cache?: <F extends (...args: never[]) => unknown>(wrapped: F) => F }
  ).cache
  return typeof reactCache === 'function' ? reactCache(fn) : fn
}

export const CACHE_TTL = 50 * 60 * 1000 // 50 minutes to safely avoid Notion's 1-hour S3 expiration
export const DS_MAPPING_TTL = 15 * 60 * 1000 // 15 minutes for verified database -> data_source mappings
export const MAPPINGS_CACHE_TTL = 10 * 60 * 1000 // 10 minutes cache for dynamic translation mappings
export const MAPPINGS_CACHE_KEY = 'translation-mapping-db'
export const IMAGE_REFRESH_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
export const IMAGE_EXPIRY_SAFETY_BUFFER_MS = 5 * 60 * 1000 // never serve URL expiring within 5 minutes
export const PUBLIC_PAGE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export function getCache<T>(key: string, maxAge: number = CACHE_TTL): T | null {
  if (!globalThis.__notionCache) globalThis.__notionCache = new Map()
  const cached = globalThis.__notionCache.get(key)
  if (cached && Date.now() - cached.timestamp < maxAge) {
    return cached.data as T
  }
  return null
}

export function setCache<T>(key: string, data: T): void {
  if (!globalThis.__notionCache) globalThis.__notionCache = new Map()
  globalThis.__notionCache.set(key, { timestamp: Date.now(), data })
}

export function deleteCacheKeys(keys: readonly string[]): void {
  if (!globalThis.__notionCache) return
  for (const key of keys) {
    globalThis.__notionCache.delete(key)
  }
}

export function getImageRefreshInFlight(): Map<string, Promise<RefreshedImageUrl | null>> {
  if (!globalThis.__notionImageRefreshInFlight) {
    globalThis.__notionImageRefreshInFlight = new Map()
  }
  return globalThis.__notionImageRefreshInFlight
}

export function warnOnce(key: string, message: string): void {
  if (!globalThis.__notionI18nWarnings) globalThis.__notionI18nWarnings = new Set()
  if (globalThis.__notionI18nWarnings.has(key)) return
  globalThis.__notionI18nWarnings.add(key)
  console.warn(message)
}
