import crypto from 'node:crypto'
import type { Client } from '@notionhq/client'
import {
  TRANSLATION_STATUS,
  getTranslationConfig,
  type TranslationConfig,
} from '../config'
import {
  createNotionClient,
  normalizeNotionId,
  queryAllPages,
  resolveArticlesDataSource,
  upsertNotionTranslationMappingRecord,
} from '../notion-client'
import { readRawNotionTree } from '../reader'
import { extractTranslationManifest } from '../extractor'
import { isQuotaExhaustedError, translateManifest } from '../translator'
import {
  buildTranslatedBlockTree,
  buildTranslatedPageProperties,
} from '../builder'
import { createTranslatedNotionPage } from '../writer'
import { generateTranslationReport, validateTranslation } from '../validator'
import {
  computeSourceContentFingerprint,
  createCheckpointController,
  readJobCheckpoint,
  recordPageTranslationMapping,
} from '../checkpoint-store'
import { registerResolvedPageInReferenceMap } from '../planner'
import type {
  ArticlesDataSourceInfo,
  CheckpointController,
  DiscoveredPageParentKind,
  ExistingTranslationInspection,
  JobCheckpoint,
  NotionBlockTree,
  NotionPageLike,
  PageWorkflowMeta,
  TranslateManifestResult,
  TranslationFailureStage,
  TranslationJobResult,
  TranslationManifest,
  WorkerLogger,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import {
  ChildTaskTranslationError,
  formatNotionTranslationErrorSummary,
  summarizeShortErrorMessage,
} from './errors'
import { inspectExistingTranslationState } from './existing-translation'
import {
  buildDatabasePageIndices,
  extractPageWorkflowMeta,
  updateSourcePageWorkflowState,
} from './state'
import type { ProcessTranslationJobOptions } from './types'

async function ensureTranslationGroupId(params: {
  client: Client
  sourcePage: NotionPageLike
  sourceMeta: PageWorkflowMeta
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null
  existingCheckpoint: JobCheckpoint | null
  parentKind: DiscoveredPageParentKind
  dryRun: boolean
  logger: WorkerLogger
  options: ProcessTranslationJobOptions
}): Promise<string> {
  const {
    client,
    sourcePage,
    sourceMeta,
    dataSourceInfo,
    existingCheckpoint,
    parentKind,
    dryRun,
    logger,
    options,
  } = params

  let translationGroupId =
    sourceMeta.translationGroupId ||
    existingCheckpoint?.translationGroupId ||
    ''

  if (!translationGroupId) {
    translationGroupId =
      parentKind === 'page'
        ? `child-page-${normalizeNotionId(sourceMeta.id)}`
        : options.generateUuid
          ? options.generateUuid()
          : crypto.randomUUID()
    if (parentKind !== 'page') {
      logger.info(
        `Generated new Translation Group ID "${translationGroupId}" for source page "${sourceMeta.title}" (${sourceMeta.id})`
      )
      await updateSourcePageWorkflowState(
        client,
        sourcePage,
        dataSourceInfo,
        { translationGroupId },
        { dryRun, logger, retryOptions: options.retryOptions }
      )
    }
  } else if (
    parentKind !== 'page' &&
    !sourceMeta.translationGroupId &&
    translationGroupId
  ) {
    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      { translationGroupId },
      { dryRun, logger, retryOptions: options.retryOptions }
    )
  }

  return translationGroupId
}

async function resolveOrExecuteManifestTranslation(params: {
  manifest: TranslationManifest
  sourceMeta: PageWorkflowMeta
  sourceFingerprint: string
  targetLocale: string
  config: TranslationConfig
  checkpointController: CheckpointController
  logger: WorkerLogger
  options: ProcessTranslationJobOptions
}): Promise<TranslateManifestResult> {
  const {
    manifest,
    sourceMeta,
    sourceFingerprint,
    targetLocale,
    config,
    checkpointController,
    logger,
    options,
  } = params

  let partialCachedMap: Map<string, string> | undefined
  const cachedTranslation = checkpointController.getCachedTranslationResult(
    sourceFingerprint,
    targetLocale
  )

  if (cachedTranslation) {
    const translationsMap = new Map<string, string>(
      Object.entries(cachedTranslation.translations || {})
    )
    const allManifestItemsPresent = manifest.items.every((item) =>
      translationsMap.has(item.id)
    )
    if (allManifestItemsPresent) {
      logger.info(
        `Reusing cached AI translation result from local checkpoint for "${sourceMeta.title}" (${translationsMap.size} items)`
      )
      return {
        targetLocale,
        translationsById: translationsMap,
        translations: cachedTranslation.translations,
        stats: {
          totalRequested: manifest.items.length,
          totalTranslated: translationsMap.size,
          batchCount: Number(cachedTranslation.stats?.batchCount ?? 0),
          retryCount: Number(cachedTranslation.stats?.retryCount ?? 0),
          reusedFromCheckpoint: true,
        },
        issues: cachedTranslation.issues || [],
      }
    } else if (translationsMap.size > 0) {
      logger.info(
        `Reusing ${translationsMap.size}/${manifest.items.length} partially cached AI translation items from local checkpoint for "${sourceMeta.title}"`
      )
      partialCachedMap = translationsMap
    }
  }

  const translationResult = await translateManifest(manifest, targetLocale, {
    config,
    logger,
    aiAdapter: options.aiAdapter,
    fetchImpl: options.fetchImpl,
    batchSize: options.batchSize ?? config.batchSize,
    maxBatchChars: options.maxBatchChars ?? config.maxBatchChars,
    concurrency: options.concurrency ?? config.concurrency,
    maxRetries: options.maxAiRetries ?? 2,
    preTranslatedById: partialCachedMap,
    onBatchTranslated: (partialMap) => {
      checkpointController.setCachedTranslationResult(
        {
          targetLocale,
          translationsById: new Map(partialMap),
          translations: Object.fromEntries(partialMap),
          stats: {
            totalRequested: manifest.items.length,
            totalTranslated: partialMap.size,
            batchCount: 0,
            retryCount: 0,
          },
          issues: [],
        },
        sourceFingerprint
      )
      checkpointController.setJobState('translating')
    },
  })

  if (translationResult.stats.usage) {
    const u = translationResult.stats.usage
    logger.info(`AI translation usage summary for "${sourceMeta.title}"`, {
      provider: u.provider,
      model: u.model,
      initialBatchCount: u.plannedBatches,
      actualApiRequests: u.apiRequests,
      successfulRequests: u.successfulRequests,
      failedOrRetriedRequests: u.failedOrRetriedRequests,
      splitBatchCount: u.splitBatchCount,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      avgOutputTokensPerRequest: u.avgOutputTokensPerRequest,
      cachedSegments: u.cachedSegments,
      skippedTechnicalSegments: u.skippedTechnicalSegments,
      translatedSegments: u.translatedSegments,
      failedBatches: u.failedBatches,
      ...(u.excessRequestReasons.length > 0
        ? { excessRequestReasons: u.excessRequestReasons }
        : {}),
      ...(u.estimatedCostUsd !== null
        ? { estimatedCostUsd: u.estimatedCostUsd }
        : {}),
    })
  }

  // Persist AI translations into checkpoint BEFORE any Notion page/block writes begin
  checkpointController.setCachedTranslationResult(
    translationResult,
    sourceFingerprint
  )

  return translationResult
}

function createReconcileCreatedPageCallback(params: {
  client: Client
  parentKind: DiscoveredPageParentKind
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null
  sourceMeta: PageWorkflowMeta
  translationGroupId: string
  targetLocale: string
  config: TranslationConfig
  logger: WorkerLogger
  options: ProcessTranslationJobOptions
}): () => Promise<NotionPageLike | null> {
  const {
    client,
    parentKind,
    dataSourceInfo,
    sourceMeta,
    translationGroupId,
    targetLocale,
    config,
    logger,
    options,
  } = params

  return async (): Promise<NotionPageLike | null> => {
    if (parentKind === 'page') return null
    const refreshedPages = await queryAllPages(
      client,
      dataSourceInfo as ArticlesDataSourceInfo,
      {},
      { config, logger, retryOptions: options.retryOptions }
    )
    const refreshedIndices = buildDatabasePageIndices(
      refreshedPages,
      dataSourceInfo,
      targetLocale
    )
    const groupKey = translationGroupId.trim().toLowerCase()
    const matches =
      refreshedIndices.pagesByGroupAndLocale
        .get(groupKey)
        ?.get(targetLocale) || []
    const draftMatches = matches.filter(
      (m) =>
        normalizeNotionId(m.meta.id) !== normalizeNotionId(sourceMeta.id) &&
        m.meta.status.toLowerCase() === 'draft'
    )
    if (draftMatches.length === 1) {
      return draftMatches[0]!.page
    }
    return null
  }
}

async function handleSingleJobFailure(params: {
  err: unknown
  currentStage: TranslationFailureStage
  client: Client
  sourcePage: NotionPageLike
  sourceMeta: PageWorkflowMeta
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null
  createdOrResumedTargetPageId: string | null
  checkpointController: CheckpointController
  config: TranslationConfig
  dryRun: boolean
  logger: WorkerLogger
  options: ProcessTranslationJobOptions
}): Promise<TranslationJobResult> {
  const {
    err,
    currentStage,
    client,
    sourcePage,
    sourceMeta,
    dataSourceInfo,
    createdOrResumedTargetPageId,
    checkpointController,
    config,
    dryRun,
    logger,
    options,
  } = params

  const failedAt = new Date().toISOString()
  const errorDetail = err instanceof Error ? err.message : String(err)

  if (isQuotaExhaustedError(err)) {
    logger.warn(
      `AI quota exhausted while translating "${sourceMeta.title}" (${sourceMeta.id}); pausing job safely and keeping page resumable: ${errorDetail}`
    )
    checkpointController.setJobState('paused_quota', errorDetail)

    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      {
        translationStatus: TRANSLATION_STATUS.REQUESTED,
        ...(createdOrResumedTargetPageId
          ? { translationTargetPageId: createdOrResumedTargetPageId }
          : {}),
        translationError: `[Quota Paused at ${failedAt}] ${errorDetail}`,
        translationUpdatedAt: failedAt,
      },
      { dryRun, logger, retryOptions: options.retryOptions }
    ).catch((updateErr) => {
      logger.error(
        `Could not record Quota Paused state on source page ${sourceMeta.id}`,
        {
          error:
            updateErr instanceof Error ? updateErr.message : String(updateErr),
        }
      )
    })

    return {
      status: 'paused_quota',
      sourcePageId: sourceMeta.id,
      targetPageId:
        createdOrResumedTargetPageId ||
        sourceMeta.translationTargetPageId ||
        '',
      reason: errorDetail,
      provider: config.aiProvider,
      model: config.aiModel,
      dryRun,
    }
  }

  const needsReviewFlag = Boolean(
    err &&
      typeof err === 'object' &&
      (err as { needsReview?: boolean }).needsReview
  )

  if (needsReviewFlag) {
    logger.warn(
      `Translation job for "${sourceMeta.title}" (${sourceMeta.id}) requires manual review: ${errorDetail}`
    )
    checkpointController.setJobState('needs_review', errorDetail)

    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      {
        translationStatus: TRANSLATION_STATUS.NEEDS_REVIEW,
        ...(createdOrResumedTargetPageId
          ? { translationTargetPageId: createdOrResumedTargetPageId }
          : {}),
        translationError: `[Reconciliation Needs Review] ${errorDetail}`,
        translationUpdatedAt: failedAt,
      },
      { dryRun, logger, retryOptions: options.retryOptions }
    ).catch((updateErr) => {
      logger.error(
        `Could not record Needs Review status on source page ${sourceMeta.id}`,
        {
          error:
            updateErr instanceof Error ? updateErr.message : String(updateErr),
        }
      )
    })

    return {
      status: TRANSLATION_STATUS.NEEDS_REVIEW,
      sourcePageId: sourceMeta.id,
      targetPageId:
        createdOrResumedTargetPageId ||
        sourceMeta.translationTargetPageId ||
        '',
      reason: errorDetail,
      dryRun,
    }
  }

  const isChildFailure = err instanceof ChildTaskTranslationError
  const attachedFailureStage =
    err && typeof err === 'object'
      ? (err as { failureStage?: TranslationFailureStage }).failureStage
      : undefined
  const failureStage: TranslationFailureStage = isChildFailure
    ? err.failureStage
    : attachedFailureStage || currentStage
  const providerName = isChildFailure ? err.provider : config.aiProvider
  const modelName = isChildFailure ? err.model : config.aiModel
  const failedResourceTitle = isChildFailure
    ? err.childPageTitle
    : sourceMeta.title
  const shortError = isChildFailure
    ? err.shortError
    : summarizeShortErrorMessage(errorDetail)

  const formattedNotionError = formatNotionTranslationErrorSummary({
    pageTitle: failedResourceTitle,
    isChildPage: isChildFailure || Boolean(options.isChildTask),
    failureStage,
    provider: providerName,
    model: modelName,
    rawError: shortError,
    failedAt,
  })

  logger.error(
    `Translation job failed for "${sourceMeta.title}" (${sourceMeta.id}) [stage="${failureStage}", resource="${failedResourceTitle}", provider="${providerName}", model="${modelName}"]: ${errorDetail}`
  )
  checkpointController.setJobState('failed', formattedNotionError)

  await updateSourcePageWorkflowState(
    client,
    sourcePage,
    dataSourceInfo,
    {
      translationStatus: TRANSLATION_STATUS.FAILED,
      ...(createdOrResumedTargetPageId
        ? { translationTargetPageId: createdOrResumedTargetPageId }
        : {}),
      translationError: formattedNotionError,
      translationUpdatedAt: failedAt,
    },
    { dryRun, logger, retryOptions: options.retryOptions }
  ).catch((updateErr) => {
    logger.error(
      `Could not record Failed status on source page ${sourceMeta.id}`,
      {
        error:
          updateErr instanceof Error ? updateErr.message : String(updateErr),
      }
    )
  })

  return {
    status: TRANSLATION_STATUS.FAILED,
    sourcePageId: sourceMeta.id,
    targetPageId:
      createdOrResumedTargetPageId || sourceMeta.translationTargetPageId || '',
    error: formattedNotionError,
    shortError,
    failureStage,
    failedResourceTitle,
    provider: providerName,
    model: modelName,
    dryRun,
  }
}

/**
 * Executes the single-page translation lifecycle (Steps 3–13) without triggering
 * recursive hierarchy discovery. Called directly by both `processTranslationJob`
 * and `executeHierarchicalTranslationPlan`.
 */
export async function runSinglePageTranslationJob(
  sourcePage: NotionPageLike,
  options: ProcessTranslationJobOptions = {}
): Promise<TranslationJobResult> {
  const startedAt = new Date().toISOString()
  const config = options.config || getTranslationConfig()
  const logger = options.logger || defaultLogger
  const dryRun = Boolean(options.dryRun ?? config.dryRun)
  const targetLocale = options.targetLocale || config.targetLocale || 'vi'
  const client = options.client || createNotionClient(config)

  const dataSourceInfo =
    options.dataSourceInfo ||
    (await resolveArticlesDataSource(client, config, { logger }))

  const sourceMeta = extractPageWorkflowMeta(sourcePage, dataSourceInfo)

  // Step 1: Only process English source pages (missing Locale defaults to 'en')
  if (sourceMeta.locale !== (config.sourceLocale || 'en')) {
    logger.info(
      `Skipping non-English page "${sourceMeta.title}" (${sourceMeta.id}) with locale="${sourceMeta.locale}"`
    )
    return {
      status: 'skipped_locale',
      sourcePageId: sourceMeta.id,
      locale: sourceMeta.locale,
    }
  }

  const parentKind: DiscoveredPageParentKind =
    options.parentKind ||
    (sourcePage?.parent?.type === 'page_id' ? 'page' : 'database')
  const allDatabasePages =
    parentKind === 'page'
      ? []
      : options.allDatabasePages ||
        (await queryAllPages(
          client,
          dataSourceInfo as ArticlesDataSourceInfo,
          {},
          { config, logger, retryOptions: options.retryOptions }
        ))

  const indices = buildDatabasePageIndices(
    allDatabasePages,
    dataSourceInfo,
    targetLocale
  )
  const existingCheckpoint = dryRun
    ? null
    : readJobCheckpoint(sourceMeta.id, config)

  // Step 3: Ensure source page has a Translation Group ID
  const translationGroupId = await ensureTranslationGroupId({
    client,
    sourcePage,
    sourceMeta,
    dataSourceInfo,
    existingCheckpoint,
    parentKind,
    dryRun,
    logger,
    options,
  })

  // Step 4: Inspect existing translation state & resume eligibility before creating any page
  let existingCheck: ExistingTranslationInspection
  if (options.existingCheckOverride) {
    existingCheck = options.existingCheckOverride
  } else if (parentKind === 'page') {
    existingCheck = { action: 'create_new', checkpoint: existingCheckpoint }
  } else {
    existingCheck = await inspectExistingTranslationState(
      client,
      sourceMeta,
      translationGroupId,
      indices,
      targetLocale,
      {
        config,
        checkpoint: existingCheckpoint,
        dataSourceInfo,
        logger,
        retryOptions: options.retryOptions,
        allowResumeEmptyShell: options.allowResumeEmptyShell,
        allowResumePartial: options.allowResumePartial,
      }
    )
  }

  if (existingCheck.action === 'duplicate_exists') {
    const existingId =
      existingCheck.primaryPage?.meta?.id ||
      sourceMeta.translationTargetPageId ||
      ''
    logger.warn(
      `Duplicate protection triggered for "${sourceMeta.title}" (${sourceMeta.id}): ${existingCheck.reason}`
    )

    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      {
        translationStatus: TRANSLATION_STATUS.NEEDS_REVIEW,
        translationTargetPageId: existingId,
        translationError: `[Duplicate Prevented] ${existingCheck.reason}`,
        translationUpdatedAt: new Date().toISOString(),
      },
      { dryRun, logger, retryOptions: options.retryOptions }
    )

    return {
      status: TRANSLATION_STATUS.NEEDS_REVIEW,
      duplicatePrevented: true,
      sourcePageId: sourceMeta.id,
      targetPageId: existingId,
      reason: existingCheck.reason,
    }
  }

  const isResumingExistingPage =
    existingCheck.action === 'resume_empty' ||
    existingCheck.action === 'resume_partial'
  let createdOrResumedTargetPageId: string | null =
    existingCheck.action === 'resume_empty' ||
    existingCheck.action === 'resume_partial'
      ? existingCheck.targetPageId
      : null

  const checkpointController = createCheckpointController(
    sourceMeta.id,
    existingCheckpoint,
    {
      ...config,
      dryRun,
    }
  )

  if (
    (existingCheck.action === 'resume_empty' ||
      existingCheck.action === 'resume_partial') &&
    indices.existingSlugs &&
    existingCheck.existingPage?.meta?.slug
  ) {
    indices.existingSlugs.delete(
      existingCheck.existingPage.meta.slug.toLowerCase()
    )
  }

  let currentStage: TranslationFailureStage = 'Source Tree Read'

  try {
    // Step 5: Mark source page as Processing
    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      {
        translationStatus: TRANSLATION_STATUS.PROCESSING,
        ...(createdOrResumedTargetPageId
          ? { translationTargetPageId: createdOrResumedTargetPageId }
          : {}),
        translationError: '',
        translationUpdatedAt: new Date().toISOString(),
      },
      { dryRun, logger, retryOptions: options.retryOptions }
    )

    // Step 6: Read raw Notion block tree recursively & compute source content fingerprint
    currentStage = 'Source Tree Read'
    logger.info(
      `Reading raw Notion block tree for "${sourceMeta.title}" (${sourceMeta.id})...`
    )
    const sourceTree =
      options.preloadedSourceTree ||
      (await readRawNotionTree(sourceMeta.id, {
        client,
        config,
        logger,
        retryOptions: options.retryOptions,
      }))

    const sourceFingerprint = computeSourceContentFingerprint(
      sourcePage,
      sourceTree,
      dataSourceInfo
    )

    if (
      existingCheck.action === 'resume_partial' &&
      existingCheckpoint?.sourceFingerprint &&
      existingCheckpoint.sourceFingerprint !== sourceFingerprint
    ) {
      const changedMsg =
        `[Source Changed During Resume] Source article "${sourceMeta.title}" changed since partial target page ` +
        `${existingCheck.targetPageId} was written. Refusing to append mismatched content automatically; please review or delete the draft target page.`
      logger.warn(changedMsg)
      checkpointController.setJobState('needs_review', changedMsg)

      await updateSourcePageWorkflowState(
        client,
        sourcePage,
        dataSourceInfo,
        {
          translationStatus: TRANSLATION_STATUS.NEEDS_REVIEW,
          translationTargetPageId: existingCheck.targetPageId,
          translationError: changedMsg,
          translationUpdatedAt: new Date().toISOString(),
        },
        { dryRun, logger, retryOptions: options.retryOptions }
      )

      return {
        status: TRANSLATION_STATUS.NEEDS_REVIEW,
        sourcePageId: sourceMeta.id,
        targetPageId: existingCheck.targetPageId,
        reason: changedMsg,
        dryRun,
      }
    }

    if (
      existingCheckpoint?.sourceFingerprint &&
      existingCheckpoint.sourceFingerprint !== sourceFingerprint
    ) {
      logger.info(
        `Source content fingerprint changed for "${sourceMeta.title}"; invalidating cached translation in checkpoint.`
      )
      checkpointController.resetForSourceChange(
        sourceFingerprint,
        translationGroupId,
        targetLocale
      )
    } else {
      checkpointController.setMetadata({
        sourceFingerprint,
        translationGroupId,
        targetLocale,
        jobState: 'translating',
      })
    }

    // Step 7: Extract translatable text manifest
    currentStage = 'Manifest Extraction'
    const manifest = extractTranslationManifest(sourceTree, {
      sourcePage,
      articleTitle: sourceMeta.title,
    })

    logger.info(`Extracted translation manifest for "${sourceMeta.title}"`, {
      totalSourceBlocks: manifest.stats.totalSourceBlocks,
      totalTranslatableFields: manifest.stats.totalTranslatableFields,
      unsupportedBlocks: manifest.stats.unsupportedBlockCount,
    })

    // Step 8: Reuse cached AI translation result from checkpoint or call AI provider
    currentStage = 'AI Translation'
    const translationResult = await resolveOrExecuteManifestTranslation({
      manifest,
      sourceMeta,
      sourceFingerprint,
      targetLocale,
      config,
      checkpointController,
      logger,
      options,
    })

    // Step 9: Build translated block tree & target page properties (Status = Draft, Locale = vi)
    currentStage = 'Block Tree Build'
    const referenceMap = options.referenceMap || null
    if (referenceMap) {
      for (const [
        normSrcId,
        meta,
      ] of referenceMap.localizedPageMetaBySourcePageId.entries()) {
        if (!indices.localizedPageMap.has(normSrcId)) {
          indices.localizedPageMap.set(normSrcId, meta)
        }
      }
    }

    const translatedTree = buildTranslatedBlockTree(
      sourceTree,
      translationResult,
      {
        sourcePageId: sourceMeta.id,
        referenceMap,
      }
    )

    const pagePropertiesPayload = buildTranslatedPageProperties(
      sourcePage,
      dataSourceInfo,
      translationResult,
      {
        targetLocale,
        translationGroupId,
        existingSlugs: indices.existingSlugs,
        targetTranslationStatus: TRANSLATION_STATUS.DRAFT_READY,
        parentKind,
        referenceMap,
      }
    )
    indices.existingSlugs.add(pagePropertiesPayload.slug.toLowerCase())

    const reconcileCreatedPage = createReconcileCreatedPageCallback({
      client,
      parentKind,
      dataSourceInfo,
      sourceMeta,
      translationGroupId,
      targetLocale,
      config,
      logger,
      options,
    })

    // Step 10: Create or resume target Vietnamese page and write all blocks in batches
    currentStage = 'Notion Page Write'
    const writeResult = await createTranslatedNotionPage(
      sourcePage,
      translatedTree,
      {
        client,
        config,
        dataSourceInfo,
        parentKind,
        parentTargetPageId: options.parentTargetPageId || null,
        pagePropertiesPayload,
        resumeTargetPageId: createdOrResumedTargetPageId,
        isResuming: isResumingExistingPage,
        checkpoint: checkpointController,
        reconcileCreatedPage,
        localizedPageMap: indices.localizedPageMap,
        translatedDatabaseIds: referenceMap?.translatedDatabaseIds,
        onWriteChildPage: options.onWriteChildPage,
        maxBlocksPerAppend:
          options.maxBlocksPerAppend ?? config.maxBlocksPerAppend ?? 100,
        dryRun,
        logger,
        fetchImpl: options.fetchImpl,
        retryOptions: options.retryOptions,
        onTargetPageCreated: async (targetPage) => {
          createdOrResumedTargetPageId = targetPage.id
          checkpointController.setTargetPageId(targetPage.id)
          if (referenceMap) {
            registerResolvedPageInReferenceMap(referenceMap, {
              sourcePageId: sourceMeta.id,
              targetPageId: targetPage.id,
              sourceSlug: sourceMeta.slug,
              targetSlug: pagePropertiesPayload.slug,
              targetTitle: pagePropertiesPayload.translatedTitle,
              translationGroupId,
              targetLocale,
            })
            const mappedMeta =
              referenceMap.localizedPageMetaBySourcePageId.get(
                normalizeNotionId(sourceMeta.id)
              )
            if (mappedMeta) {
              indices.localizedPageMap.set(
                normalizeNotionId(sourceMeta.id),
                mappedMeta
              )
            }
          }
          recordPageTranslationMapping(
            {
              sourcePageId: sourceMeta.id,
              targetPageId: targetPage.id,
              targetLocale,
              translationGroupId,
              sourceSlug: sourceMeta.slug,
              targetSlug: pagePropertiesPayload.slug,
              sourceTitle: sourceMeta.title,
              targetTitle: pagePropertiesPayload.translatedTitle,
              parentKind,
              parentDatabaseId: dataSourceInfo?.databaseId || null,
              parentTargetPageId: options.parentTargetPageId || null,
            },
            { ...config, dryRun }
          )
          if (config.translationMappingDatabaseId) {
            await upsertNotionTranslationMappingRecord(
              client,
              config.translationMappingDatabaseId,
              {
                name: pagePropertiesPayload.translatedTitle || sourceMeta.title,
                enPageId: sourceMeta.id,
                viPageId: targetPage.id,
                status: 'Draft',
              },
              { config, dryRun, logger, retryOptions: options.retryOptions }
            ).catch((err: unknown) => {
              logger.warn(
                `Failed to upsert Draft mapping into Notion mapping database: ${err instanceof Error ? err.message : String(err)}`,
                { sourcePageId: sourceMeta.id, targetPageId: targetPage.id }
              )
            })
          }
          await updateSourcePageWorkflowState(
            client,
            sourcePage,
            dataSourceInfo,
            {
              translationTargetPageId: targetPage.id,
              translationUpdatedAt: new Date().toISOString(),
            },
            { dryRun, logger, retryOptions: options.retryOptions }
          )
        },
      }
    )

    checkpointController.recordWriteIssues({
      missingMedia: writeResult.missingMedia,
      unsupportedBlocks: writeResult.unsupportedBlocks,
      linkedResources: writeResult.linkedResources,
      syncedBlocks: writeResult.syncedBlocks,
    })

    const targetPage = writeResult.targetPage
    createdOrResumedTargetPageId =
      targetPage?.id || createdOrResumedTargetPageId

    // Step 11: Verify generated structure after writing
    currentStage = 'Post-Write Validation'
    let writtenTargetTree: NotionBlockTree = translatedTree
    if (!dryRun && targetPage?.id) {
      try {
        writtenTargetTree = await readRawNotionTree(targetPage.id, {
          client,
          config,
          logger,
          retryOptions: options.retryOptions,
        })
      } catch (verifyReadErr) {
        logger.warn(
          `Could not re-read target page ${targetPage.id} for post-write tree verification; validating built tree`,
          {
            error:
              verifyReadErr instanceof Error
                ? verifyReadErr.message
                : String(verifyReadErr),
          }
        )
      }
    }

    const combinedWriteIssues = checkpointController.state.writeIssues
    const validation = validateTranslation(sourceTree, writtenTargetTree, {
      unsupportedBlocks: combinedWriteIssues.unsupportedBlocks?.length
        ? combinedWriteIssues.unsupportedBlocks
        : writeResult.unsupportedBlocks,
      missingMedia: combinedWriteIssues.missingMedia?.length
        ? combinedWriteIssues.missingMedia
        : writeResult.missingMedia,
      linkedResources: combinedWriteIssues.linkedResources?.length
        ? combinedWriteIssues.linkedResources
        : writeResult.linkedResources,
      syncedBlocks: combinedWriteIssues.syncedBlocks?.length
        ? combinedWriteIssues.syncedBlocks
        : writeResult.syncedBlocks,
    })

    const completedAt = new Date().toISOString()
    const report = generateTranslationReport({
      sourcePageTitle: sourceMeta.title,
      sourcePageId: sourceMeta.id,
      targetPageId: targetPage?.id || '',
      targetPageUrl: targetPage?.url || '',
      totalSourceBlocks: manifest.stats.totalSourceBlocks,
      totalTranslatedTextFields: translationResult.stats.totalTranslated,
      totalPreservedBlocks: manifest.stats.totalPreservedBlocks,
      totalRecreatedNestedBlocks:
        writeResult.stats.totalRecreatedNestedBlocks ||
        manifest.stats.totalNestedBlocks,
      unsupportedBlocks: validation.unsupportedBlocks,
      missingMedia: validation.missingMedia,
      linkedResources: validation.linkedResources,
      syncedBlocks: validation.syncedBlocks,
      validationErrors: validation.validationErrors,
      warnings: validation.warnings,
      startedAt,
      completedAt,
    })

    const finalTranslationStatus = validation.needsReview
      ? TRANSLATION_STATUS.NEEDS_REVIEW
      : TRANSLATION_STATUS.DRAFT_READY

    if (
      !dryRun &&
      finalTranslationStatus === TRANSLATION_STATUS.NEEDS_REVIEW &&
      targetPage?.id
    ) {
      await updateSourcePageWorkflowState(
        client,
        targetPage.id,
        dataSourceInfo,
        {
          translationStatus: TRANSLATION_STATUS.NEEDS_REVIEW,
          translationUpdatedAt: completedAt,
        },
        { dryRun, logger, retryOptions: options.retryOptions }
      ).catch(() => {})
    }

    // Step 12: Update source page with final workflow status and report summary (unless deferred for hierarchical child aggregation)
    if (!options.deferFinalSourceStatusUpdate) {
      await updateSourcePageWorkflowState(
        client,
        sourcePage,
        dataSourceInfo,
        {
          translationStatus: finalTranslationStatus,
          translationTargetPageId: targetPage?.id || '',
          translationError:
            finalTranslationStatus === TRANSLATION_STATUS.NEEDS_REVIEW
              ? report.concisePropertySummary
              : '',
          translationUpdatedAt: completedAt,
        },
        { dryRun, logger, retryOptions: options.retryOptions }
      )
    }

    // Step 13: Clean up completed local checkpoint file
    checkpointController.remove()

    if (
      config.translationMappingDatabaseId &&
      (targetPage?.id || createdOrResumedTargetPageId)
    ) {
      const resolvedTargetId =
        targetPage?.id || createdOrResumedTargetPageId || ''
      const isReady =
        finalTranslationStatus === TRANSLATION_STATUS.DRAFT_READY
      await upsertNotionTranslationMappingRecord(
        client,
        config.translationMappingDatabaseId,
        {
          name: pagePropertiesPayload.translatedTitle || sourceMeta.title,
          enPageId: sourceMeta.id,
          viPageId: resolvedTargetId,
          status: isReady ? 'Ready' : 'Draft',
        },
        { config, dryRun, logger, retryOptions: options.retryOptions }
      ).catch((err: unknown) => {
        logger.warn(
          `Failed to upsert final translation mapping into Notion mapping database: ${err instanceof Error ? err.message : String(err)}`,
          {
            sourcePageId: sourceMeta.id,
            targetPageId: resolvedTargetId,
            status: isReady ? 'Ready' : 'Draft',
          }
        )
      })
    }

    logger.info(
      `Completed translation job for "${sourceMeta.title}" -> status="${finalTranslationStatus}"`,
      {
        sourcePageId: sourceMeta.id,
        targetPageId: targetPage?.id,
        slug: pagePropertiesPayload.slug,
        resumed: isResumingExistingPage,
        reusedCachedAi: Boolean(translationResult.stats?.reusedFromCheckpoint),
      }
    )

    return {
      status: finalTranslationStatus,
      sourcePageId: sourceMeta.id,
      targetPageId: targetPage?.id || '',
      targetPageUrl: targetPage?.url || '',
      translationGroupId,
      slug: pagePropertiesPayload.slug,
      translatedTitle: pagePropertiesPayload.translatedTitle,
      targetStatus: 'Draft',
      targetLocale,
      resumed: isResumingExistingPage,
      reusedCachedAi: Boolean(translationResult.stats?.reusedFromCheckpoint),
      validation,
      report,
      dryRun,
    }
  } catch (err) {
    return handleSingleJobFailure({
      err,
      currentStage,
      client,
      sourcePage,
      sourceMeta,
      dataSourceInfo,
      createdOrResumedTargetPageId,
      checkpointController,
      config,
      dryRun,
      logger,
      options,
    })
  }
}
