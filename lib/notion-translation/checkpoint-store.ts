/**
 * lib/notion-translation/checkpoint-store.ts — Public Translation Worker State & Checkpoint entry point
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Preserves all public exports while delegating to cohesive persistence modules under
 * `lib/notion-translation/checkpoint-store/`:
 *   - `storage.ts`           — state directory resolution, secret stripping & atomic JSON writes
 *   - `job-checkpoint.ts`    — per-job checkpoints (`job-<id>.json`), source fingerprints & controller
 *   - `resource-mappings.ts` — persistent cross-job page mapping store (`resource-map.json`)
 *   - `segment-cache.ts`     — persistent segment-level translation cache (`segment-cache.json`)
 */

export { getStateDirectoryPath } from './checkpoint-store/storage'

export {
  getJobCheckpointPath,
  readJobCheckpoint,
  writeJobCheckpoint,
  deleteJobCheckpoint,
  computeSourceContentFingerprint,
  createCheckpointController,
} from './checkpoint-store/job-checkpoint'

export {
  getResourceMappingStorePath,
  buildResourceMappingKey,
  readResourceMappingStore,
  writeResourceMappingStore,
  recordPageTranslationMapping,
  getMappedTargetPage,
  getAllResourceMappings,
} from './checkpoint-store/resource-mappings'

export {
  getSegmentCacheStorePath,
  computeSegmentCacheKey,
  readSegmentCacheStore,
  writeSegmentCacheStore,
  getCachedSegmentTranslation,
  recordCachedSegmentTranslations,
} from './checkpoint-store/segment-cache'
