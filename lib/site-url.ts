/**
 * lib/site-url.ts — Canonical Site URL resolution & normalization
 * ─────────────────────────────────────────────────────────────────
 * Preserves `NEXT_PUBLIC_SITE_URL` as the environment-variable override,
 * falls back to the canonical production domain, and strips any trailing
 * slashes to prevent double-slash URLs in canonicals, OG tags, JSON-LD,
 * robots.txt, and sitemap.xml.
 */

export const DEFAULT_SITE_URL = 'https://servicenow-space.vercel.app'

export function normalizeSiteUrl(rawUrl: string | null | undefined): string {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!trimmed) return DEFAULT_SITE_URL

  const withoutTrailingSlash = trimmed.replace(/\/+$/, '')
  try {
    const parsed = new URL(withoutTrailingSlash)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return withoutTrailingSlash
    }
  } catch {
    // Fall back to canonical domain if env var is malformed
  }

  return DEFAULT_SITE_URL
}

export const SITE_URL = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL)
