/**
 * lib/notion-translation/workflow.ts — Public Translation Worker Workflow entry point
 * ───────────────────────────────────────────────────────────────────────────────────
 * Preserves all public exports while delegating to cohesive modules under
 * `lib/notion-translation/workflow/`:
 *   - `types.ts`                — shared workflow options and state-update interfaces
 *   - `active-jobs.ts`          — single source of truth for active job resource IDs
 *   - `errors.ts`               — `ChildTaskTranslationError` and Notion error summaries
 *   - `state.ts`                — page metadata extraction, Notion status updates & DB indices
 *   - `existing-translation.ts` — duplicate protection & Draft resume inspection
 *   - `single-job.ts`           — single-page translation pipeline (Steps 3–13)
 *   - `hierarchical-plan.ts`    — multi-page hierarchy & child-task orchestration
 *   - `job.ts`                  — `processTranslationJob` entry point & discovery dispatch
 *   - `recovery.ts`             — stale `Processing` job detection and recovery
 */

export {
  computeSourceContentFingerprint,
  createCheckpointController,
  deleteJobCheckpoint,
  getJobCheckpointPath,
  readJobCheckpoint,
  recordPageTranslationMapping,
  writeJobCheckpoint,
} from './checkpoint-store'

export { discoverContentHierarchy } from './discovery'
export { buildTranslationPlan } from './planner'

export {
  isPageInActiveTranslationJob,
  markPageActiveInTranslationJob,
  unmarkPageActiveInTranslationJob,
} from './workflow/active-jobs'

export {
  ChildTaskTranslationError,
  summarizeShortErrorMessage,
  formatNotionTranslationErrorSummary,
} from './workflow/errors'

export {
  extractPageWorkflowMeta,
  updateSourcePageWorkflowState,
  buildDatabasePageIndices,
} from './workflow/state'

export { inspectExistingTranslationState } from './workflow/existing-translation'

export { processTranslationJob } from './workflow/job'

export { recoverStaleProcessingPages } from './workflow/recovery'

export type {
  SourceWorkflowStateUpdates,
  InspectExistingTranslationOptions,
  ProcessTranslationJobOptions,
  RecoverStaleJobsOptions,
} from './workflow/types'
