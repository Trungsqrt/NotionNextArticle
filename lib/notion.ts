/**
 * lib/notion.ts — Public Knowledge Hub Notion integration entry point
 * ───────────────────────────────────────────────────────────────────
 * Preserves all public exports while delegating to cohesive modules under `lib/notion/`:
 *   - `types.ts`        — internal Notion SDK structural & cache types
 *   - `cache.ts`        — shared `globalThis` cache, TTL constants, and single-flight maps
 *   - `properties.ts`   — pure property extraction, status checks, and rich-text HTML helpers
 *   - `client.ts`       — shared Notion SDK client, data-source resolution, and pagination
 *   - `posts.ts`        — published article catalog (`getAllPosts`)
 *   - `access.ts`       — public page & block authorization checks
 *   - `images.ts`       — on-demand signed image URL refresh (`refreshNotion*Url`)
 *   - `renderer.ts`     — `NotionRenderer`, custom block renderers, and block hydration
 *   - `translations.ts` — bilingual translation lookups and internal link localization
 *   - `navigation.ts`   — lesson & sibling page navigation (`getSiblingPages`)
 *   - `articles.ts`     — slug/UUID lookup and full article assembly (`getPageBySlug`)
 */

export { isValidNotionId } from './notion/client'
export { getAllPosts } from './notion/posts'
export { getPageBySlug } from './notion/articles'
export { getChildBlocks, renderBlocks, getNotionPageData } from './notion/renderer'
export {
  getTranslatedArticle,
  getTranslationMappings,
  getArticleTranslations,
  localizeInternalLinks,
} from './notion/translations'
export { getSiblingPages } from './notion/navigation'
export { refreshNotionBlockImageUrl, refreshNotionPageCoverUrl } from './notion/images'
