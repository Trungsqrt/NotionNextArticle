import { TRANSLATION_STATUS, getTranslationConfig } from '../config'
import { createNotionClient } from '../notion-client'
import { readRawNotionTree } from '../reader'
import { validateTranslation } from '../validator'
import type {
  NotionPageLike,
  RecoveredJobSummary,
  TranslationStatus,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import { inspectExistingTranslationState } from './existing-translation'
import { processTranslationJob } from './job'
import {
  buildDatabasePageIndices,
  extractPageWorkflowMeta,
  updateSourcePageWorkflowState,
} from './state'
import type { RecoverStaleJobsOptions } from './types'

/**
 * Detects and safely recovers any source pages stuck in `Translation Status = Processing`
 * for longer than `config.staleTimeoutMs` (default 30 minutes).
 */
export async function recoverStaleProcessingPages(
  allDatabasePages: NotionPageLike[],
  options: RecoverStaleJobsOptions = {}
): Promise<RecoveredJobSummary[]> {
  const config = options.config || getTranslationConfig()
  const logger = options.logger || defaultLogger
  const client = options.client || createNotionClient(config)
  const dataSourceInfo = options.dataSourceInfo
  const dryRun = Boolean(options.dryRun ?? config.dryRun)
  const targetLocale = options.targetLocale || config.targetLocale || 'vi'
  const staleTimeoutMs =
    options.staleTimeoutMs ?? config.staleTimeoutMs ?? 30 * 60 * 1000
  const nowMs = options.nowMs ?? Date.now()

  const indices = buildDatabasePageIndices(
    allDatabasePages,
    dataSourceInfo,
    targetLocale
  )
  const recovered: RecoveredJobSummary[] = []

  for (const page of allDatabasePages || []) {
    if (!page || page.in_trash || page.archived) continue
    const meta = extractPageWorkflowMeta(page, dataSourceInfo)
    if (meta.locale !== (config.sourceLocale || 'en')) continue
    if (meta.translationStatus !== TRANSLATION_STATUS.PROCESSING) continue

    const updatedMs = meta.translationUpdatedAt
      ? Date.parse(meta.translationUpdatedAt)
      : NaN
    const ageMs = Number.isNaN(updatedMs)
      ? staleTimeoutMs + 1
      : nowMs - updatedMs

    if (ageMs <= staleTimeoutMs) continue

    logger.warn(
      `Detected stale Processing page "${meta.title}" (${meta.id}), age=${Math.round(ageMs / 1000)}s`
    )

    const existingState = await inspectExistingTranslationState(
      client,
      meta,
      meta.translationGroupId,
      indices,
      targetLocale,
      {
        config,
        dataSourceInfo,
        logger,
        retryOptions: options.retryOptions,
        allowResumeEmptyShell: true,
        allowResumePartial: true,
      }
    )

    if (existingState.action === 'duplicate_exists') {
      const existingPage = existingState.primaryPage
      let finalStatus: TranslationStatus = TRANSLATION_STATUS.NEEDS_REVIEW
      let message = `[Stale Job Recovered] Existing ${targetLocale.toUpperCase()} page found (${existingPage.meta.id}). Please review before publishing.`

      if (existingState.existingTree) {
        try {
          const sourceTree = await readRawNotionTree(meta.id, {
            client,
            config,
            logger,
            retryOptions: options.retryOptions,
          })
          const validation = validateTranslation(
            sourceTree,
            existingState.existingTree
          )
          if (validation.valid && !validation.needsReview) {
            finalStatus = TRANSLATION_STATUS.DRAFT_READY
            message = ''
          } else {
            finalStatus = TRANSLATION_STATUS.NEEDS_REVIEW
            message =
              `[Stale Job Recovered - Needs Review] Target page ${existingPage.meta.id} exists ` +
              `(blocks: ${existingState.existingTree.totalBlocks ?? existingState.existingTree.length} vs source ${sourceTree.totalBlocks ?? sourceTree.length}). ` +
              (validation.validationErrors.join('; ') ||
                validation.warnings.join('; '))
          }
        } catch {
          // Keep Needs Review if comparison could not run
        }
      }

      await updateSourcePageWorkflowState(
        client,
        page,
        dataSourceInfo,
        {
          translationStatus: finalStatus,
          translationTargetPageId: existingPage.meta.id,
          translationError: message,
          translationUpdatedAt: new Date().toISOString(),
        },
        { dryRun, logger, retryOptions: options.retryOptions }
      )

      recovered.push({
        sourcePageId: meta.id,
        action: 'marked_existing',
        status: finalStatus,
        targetPageId: existingPage.meta.id,
      })
    } else {
      const jobResult = await processTranslationJob(page, {
        ...options,
        client,
        config,
        dataSourceInfo,
        allDatabasePages,
      })
      const recoveryAction =
        existingState.action === 'resume_partial'
          ? 'resumed_partial_job'
          : existingState.action === 'resume_empty'
            ? 'resumed_empty_shell'
            : 'reprocessed'
      recovered.push({
        sourcePageId: meta.id,
        action: recoveryAction,
        status: jobResult.status,
        targetPageId: jobResult.targetPageId || '',
      })
    }
  }

  return recovered
}
