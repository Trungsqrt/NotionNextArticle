/**
 * lib/notion-translation/writer.ts — Public Translation Worker Notion Writer entry point
 * ──────────────────────────────────────────────────────────────────────────────────────
 * Preserves all public exports while delegating to cohesive modules under
 * `lib/notion-translation/writer/`:
 *   - `types.ts`           — shared writer options, context, and descriptor interfaces
 *   - `fingerprint.ts`     — deterministic block fingerprinting & target prefix validation
 *   - `assets.ts`          — page icon sanitization and cover/icon media re-upload helpers
 *   - `reconciliation.ts`  — pre-append & uncertain-append reconciliation invariants
 *   - `block-converter.ts` — translated AST node -> Notion `BlockObjectRequest` conversion
 *   - `append.ts`          — 400 KB batch chunking, positional child pages & recursive appends
 *   - `page.ts`            — `createTranslatedNotionPage` dry-run, resume, and creation flow
 */

export {
  computeBlockFingerprint,
  isExistingTargetPrefixValid,
} from './writer/fingerprint'

export { createAmbiguousReconciliationError } from './writer/reconciliation'

export {
  sanitizeIconForWrite,
  resolvePageCoverForWrite,
  resolvePageIconForWrite,
} from './writer/assets'

export { buildSingleBlockRequest } from './writer/block-converter'

export {
  chunkPreparedBlocks,
  appendTranslatedBlockTree,
} from './writer/append'

export { createTranslatedNotionPage } from './writer/page'

export type {
  AmbiguousReconciliationError,
  AssetWriteOptions,
  ColumnFollowUp,
  BuiltSingleBlockResult,
  ChildPageWriteRequest,
  ChildPageWriteResponse,
  BlockWriteContext,
  PreparedBlockDescriptor,
  CreateTranslatedNotionPageOptions,
} from './writer/types'
