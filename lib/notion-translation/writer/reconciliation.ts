import type {
  CompletedBatchRecord,
  NotionRawBlock,
  WorkerLogger,
} from '../types'
import { verifySliceFingerprints } from './fingerprint'
import type { AmbiguousReconciliationError } from './types'

export function createAmbiguousReconciliationError(
  message: string,
  details: Record<string, unknown> = {}
): AmbiguousReconciliationError {
  const err = new Error(message) as AmbiguousReconciliationError
  err.code = 'AMBIGUOUS_APPEND_RECONCILIATION'
  err.needsReview = true
  err.details = details
  return err
}

export interface PreAppendReconciliationResult {
  alreadyWritten: boolean
  returnedBlocks: NotionRawBlock[] | null
  shouldRecordCompletedBatch: boolean
}

/**
 * Inspects existing remote children under `parentBlockId` before executing `blocks.children.append`.
 *
 * Invariants:
 * - Never overwrites or duplicates blocks if remote blocks already exist at `expectedStartIndex`.
 * - Verifies exact structural + text fingerprints before treating a batch as already written.
 * - Throws `AmbiguousReconciliationError` (flagging the job as Needs Review) on any count or
 *   fingerprint mismatch, unexpected trailing blocks, or missing checkpointed batch.
 */
export function reconcileExistingBatchBeforeAppend(params: {
  existingChildren: readonly NotionRawBlock[]
  parentBlockId: string
  parentKey: string
  batchKey: string
  batchLength: number
  isFinalBatch: boolean
  expectedStartIndex: number
  batchFingerprints: readonly string[]
  recordedBatch: CompletedBatchRecord | null
  isPendingThisBatch: boolean
  logger: WorkerLogger
}): PreAppendReconciliationResult {
  const {
    existingChildren,
    parentBlockId,
    parentKey,
    batchKey,
    batchLength,
    isFinalBatch,
    expectedStartIndex,
    batchFingerprints,
    recordedBatch,
    isPendingThisBatch,
    logger,
  } = params

  if (existingChildren.length < expectedStartIndex) {
    throw createAmbiguousReconciliationError(
      `Target block ${parentBlockId} (${batchKey}) has fewer children (${existingChildren.length}) than expected start index (${expectedStartIndex}). Target page may have been manually modified.`,
      {
        parentBlockId,
        batchKey,
        existingCount: existingChildren.length,
        expectedStartIndex,
      }
    )
  }

  if (existingChildren.length >= expectedStartIndex + batchLength) {
    const candidateSlice = existingChildren.slice(
      expectedStartIndex,
      expectedStartIndex + batchLength
    )
    if (!verifySliceFingerprints(candidateSlice, batchFingerprints)) {
      throw createAmbiguousReconciliationError(
        `Existing blocks in target parent ${parentBlockId} at index ${expectedStartIndex}..${expectedStartIndex + batchLength - 1} do not match expected translated batch (${batchKey}). Refusing to overwrite or duplicate content.`,
        {
          parentBlockId,
          batchKey,
          expectedStartIndex,
          batchSize: batchLength,
        }
      )
    }

    const parentHasMoreSegments = parentKey.includes(':seg:')
    if (
      !parentHasMoreSegments &&
      isFinalBatch &&
      existingChildren.length > expectedStartIndex + batchLength
    ) {
      throw createAmbiguousReconciliationError(
        `Target block ${parentBlockId} contains ${existingChildren.length - (expectedStartIndex + batchLength)} unexpected extra block(s) after final batch (${batchKey}).`,
        { parentBlockId, batchKey, existingCount: existingChildren.length }
      )
    }

    logger.info(
      `Reconciled already-written block batch ${batchKey} (${batchLength} blocks) on ${parentBlockId}`
    )

    return {
      alreadyWritten: true,
      returnedBlocks: candidateSlice,
      shouldRecordCompletedBatch: !recordedBatch || isPendingThisBatch,
    }
  }

  if (existingChildren.length > expectedStartIndex) {
    throw createAmbiguousReconciliationError(
      `Target block ${parentBlockId} has a partial or mismatched block count (${existingChildren.length}) for batch ${batchKey} (expected ${expectedStartIndex} or >= ${expectedStartIndex + batchLength}).`,
      {
        parentBlockId,
        batchKey,
        existingCount: existingChildren.length,
        expectedStartIndex,
        batchSize: batchLength,
      }
    )
  }

  if (recordedBatch) {
    throw createAmbiguousReconciliationError(
      `Checkpoint recorded batch ${batchKey} as completed on ${parentBlockId}, but blocks were not found in Notion at index ${expectedStartIndex}.`,
      { parentBlockId, batchKey, expectedStartIndex }
    )
  }

  return {
    alreadyWritten: false,
    returnedBlocks: null,
    shouldRecordCompletedBatch: false,
  }
}

/**
 * Reconciles an uncertain `blocks.children.append` error (e.g. network timeout after server commit)
 * against a fresh listing of remote children under `parentBlockId`.
 *
 * Returns the recovered block slice if Notion committed all expected blocks with matching fingerprints,
 * throws `AmbiguousReconciliationError` if partial or mismatched blocks exist, or returns `null` if
 * nothing was written so the caller can propagate the original append error.
 */
export function reconcileUncertainAppendError(params: {
  latestChildren: readonly NotionRawBlock[] | null
  parentBlockId: string
  batchKey: string
  batchLength: number
  expectedStartIndex: number
  batchFingerprints: readonly string[]
  errMessage: string
  logger: WorkerLogger
}): NotionRawBlock[] | null {
  const {
    latestChildren,
    parentBlockId,
    batchKey,
    batchLength,
    expectedStartIndex,
    batchFingerprints,
    errMessage,
    logger,
  } = params

  if (!Array.isArray(latestChildren)) {
    return null
  }

  if (latestChildren.length >= expectedStartIndex + batchLength) {
    const candidateSlice = latestChildren.slice(
      expectedStartIndex,
      expectedStartIndex + batchLength
    )
    if (verifySliceFingerprints(candidateSlice, batchFingerprints)) {
      logger.warn(
        `Recovered uncertain blocks.children.append for ${batchKey}: Notion already committed all ${batchLength} blocks despite error (${errMessage}).`
      )
      return candidateSlice
    }
    throw createAmbiguousReconciliationError(
      `Uncertain blocks.children.append on ${parentBlockId} (${batchKey}) failed (${errMessage}) and remote blocks do not match expected batch fingerprints.`,
      { parentBlockId, batchKey, originalError: errMessage }
    )
  }

  if (latestChildren.length > expectedStartIndex) {
    throw createAmbiguousReconciliationError(
      `Uncertain blocks.children.append on ${parentBlockId} (${batchKey}) left partial blocks (${latestChildren.length} vs expected ${expectedStartIndex + batchLength}): ${errMessage}`,
      { parentBlockId, batchKey, originalError: errMessage }
    )
  }

  return null
}
