/**
 * lib/locales.js — Article content locale configuration
 * ──────────────────────────────────────────────────────────────────────────
 * Isomorphic (safe for server and client components). This only describes
 * the languages that *article content* can be written in. The website UI
 * itself stays in English.
 *
 * To add a new content locale later (e.g. Japanese):
 *   1. Add its code to SUPPORTED_LOCALES.
 *   2. Add an entry to LOCALE_META.
 *   3. (Optional) Add free-text aliases to LOCALE_ALIASES.
 * No other code needs to change — the data layer, switcher, hreflang and
 * sitemap all iterate over SUPPORTED_LOCALES.
 */

export const DEFAULT_LOCALE = 'en'

export const SUPPORTED_LOCALES = ['en', 'vi']

export const LOCALE_META = {
  en: {
    code: 'en',
    short: 'EN',
    label: 'English',
    hreflang: 'en',
    bcp47: 'en-US',
    ogLocale: 'en_US',
  },
  vi: {
    code: 'vi',
    short: 'VI',
    label: 'Vietnamese',
    hreflang: 'vi',
    bcp47: 'vi-VN',
    ogLocale: 'vi_VN',
  },
}

// Free-text values an author might type into a Notion "Locale" property.
const LOCALE_ALIASES = {
  english: 'en',
  vietnamese: 'vi',
  'tiếng việt': 'vi',
  'tieng viet': 'vi',
}

/**
 * Normalises a raw Locale value from Notion into a locale code.
 *   - Empty / missing            → DEFAULT_LOCALE ('en')  (backward compatible)
 *   - 'EN', 'en-US', 'English'   → 'en'
 *   - 'VI', 'vi-VN', 'Vietnamese'→ 'vi'
 *   - Any other 2–3 letter code  → kept as-is (e.g. 'fr'), so pages written in
 *     a not-yet-supported language never leak into the English listing.
 */
export function normalizeLocale(raw) {
  if (raw === null || raw === undefined) return DEFAULT_LOCALE
  const value = String(raw).trim().toLowerCase()
  if (!value) return DEFAULT_LOCALE
  if (LOCALE_ALIASES[value]) return LOCALE_ALIASES[value]
  const primary = value.split(/[-_]/)[0]
  if (/^[a-z]{2,3}$/.test(primary)) return primary
  return DEFAULT_LOCALE
}

export function isSupportedLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale)
}

export function getLocaleMeta(locale) {
  return LOCALE_META[locale] || {
    code: locale,
    short: String(locale || '').toUpperCase(),
    label: String(locale || '').toUpperCase(),
    hreflang: locale,
    bcp47: locale,
    ogLocale: locale,
  }
}
