/**
 * lib/notion-translation/notion-client.ts — Public Translation Worker Notion Client entry point
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Preserves all public exports while delegating to cohesive modules under
 * `lib/notion-translation/notion-client/`:
 *   - `properties.ts` — pure locale, Notion ID, property key & plain-text helpers
 *   - `client.ts`     — Notion SDK client creation, `withNotionRetry`, strict pagination
 *   - `database.ts`   — database/data-source resolution, page querying & schema checks
 *   - `assets.ts`     — streaming byte-limited download & Notion File Upload API
 *   - `mapping.ts`    — Translation Mapping database row upsert without duplicates
 */

export {
  normalizeLocaleCode,
  normalizeNotionId,
  normalizePropKey,
  findPropertyKey,
  findPropertyEntry,
  findTitlePropertyKey,
  getPropertyPlainText,
  extractDatabaseTitle,
} from './notion-client/properties'

export {
  withNotionRetry,
  createNotionClient,
  paginateNotionList,
  type PaginatedListResponse,
  type NotionOperationOptions,
} from './notion-client/client'

export {
  queryDataSourceOrDatabase,
  queryAllPages,
  resolveDatabaseById,
  resolveArticlesDataSource,
  ensureTranslationSchema,
} from './notion-client/database'

export { reuploadNotionAsset } from './notion-client/assets'

export {
  upsertNotionTranslationMappingRecord,
  type TranslationMappingRecordInput,
  type TranslationMappingRecordResult,
} from './notion-client/mapping'
