import type { Client } from '@notionhq/client'
import {
  TRANSLATION_STATUS,
  getTranslationConfig,
  type TranslationConfig,
} from '../config'
import {
  normalizeNotionId,
  upsertNotionTranslationMappingRecord,
} from '../notion-client'
import { readRawNotionTree } from '../reader'
import { QuotaExhaustedError } from '../translator'
import { isExistingTargetPrefixValid } from '../writer'
import { generateTranslationReport, validateTranslation } from '../validator'
import {
  readJobCheckpoint,
  recordPageTranslationMapping,
} from '../checkpoint-store'
import { registerResolvedPageInReferenceMap } from '../planner'
import type {
  ChildJobOutcome,
  HierarchicalJobProgress,
  NotionBlockTree,
  NotionPageLike,
  PlannedPageTask,
  TranslationJobResult,
  TranslationPlan,
  WorkerLogger,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import {
  ChildTaskTranslationError,
  summarizeShortErrorMessage,
} from './errors'
import { runSinglePageTranslationJob } from './single-job'
import {
  extractPageWorkflowMeta,
  updateSourcePageWorkflowState,
} from './state'
import type { ProcessTranslationJobOptions } from './types'

/**
 * Evaluates a child resource (depth > 0) that already has a single existing target page.
 *
 * Protection invariants:
 * - Never overwrites Published or manually edited target pages.
 * - Reuses complete/published child pages directly and refreshes reference/mapping records.
 * - Safely upgrades empty Draft shells or valid-prefix partial Drafts to resume actions.
 * - Flags structurally mismatched Draft children as `Needs Review` instead of overwriting.
 */
async function resolveExistingChildDuplicate(params: {
  client: Client
  task: PlannedPageTask
  plan: TranslationPlan
  parentTargetPageId: string | null
  targetLocale: string
  config: TranslationConfig
  dryRun: boolean
  logger: WorkerLogger
  options: ProcessTranslationJobOptions
}): Promise<TranslationJobResult | null> {
  const {
    client,
    task,
    plan,
    parentTargetPageId,
    targetLocale,
    config,
    dryRun,
    logger,
    options,
  } = params

  if (
    task.existingInspection.action !== 'duplicate_exists' ||
    task.existingInspection.existingPages.length !== 1
  ) {
    return null
  }

  const existingTarget = task.existingInspection.primaryPage
  const targetStatusLower = (existingTarget.meta.status || '').toLowerCase()
  const isPublishedOrNonDraft =
    task.node.parentKind === 'database' &&
    Boolean(targetStatusLower) &&
    targetStatusLower !== 'draft'

  const existingTree = task.existingInspection.existingTree || null
  const existingBlockCount = Number(
    existingTree?.totalBlocks ?? existingTree?.length ?? 0
  )
  const sourceBlockCount = Number(
    task.node.blockTree.totalBlocks ?? task.node.blockTree.length ?? 0
  )
  const childCheckpoint = readJobCheckpoint(task.sourcePageId, config)
  const structuralValidation = existingTree
    ? validateTranslation(task.node.blockTree, existingTree)
    : null

  const isStructurallyComplete =
    Boolean(existingTree) &&
    (sourceBlockCount === 0 || existingBlockCount > 0) &&
    Boolean(structuralValidation?.valid) &&
    childCheckpoint?.jobState !== 'failed'

  if (isPublishedOrNonDraft || isStructurallyComplete) {
    logger.info(
      `[Hierarchy Progress] Reusing existing complete/published Vietnamese child page "${existingTarget.meta.title}" (${existingTarget.page.id}) for source "${task.node.meta.title}" (${task.sourcePageId})`
    )
    registerResolvedPageInReferenceMap(plan.referenceMap, {
      sourcePageId: task.sourcePageId,
      targetPageId: existingTarget.page.id,
      sourceSlug: task.node.meta.slug,
      targetSlug: existingTarget.meta.slug,
      targetTitle: existingTarget.meta.title,
      translationGroupId: task.translationGroupId,
      targetLocale,
    })
    recordPageTranslationMapping(
      {
        sourcePageId: task.sourcePageId,
        targetPageId: existingTarget.page.id,
        targetLocale,
        translationGroupId: task.translationGroupId,
        sourceSlug: task.node.meta.slug,
        targetSlug: existingTarget.meta.slug,
        sourceTitle: task.node.meta.title,
        targetTitle: existingTarget.meta.title,
        parentKind: task.node.parentKind,
        parentDatabaseId: task.node.parentDatabaseId,
        parentTargetPageId,
      },
      { ...config, dryRun }
    )

    if (config.translationMappingDatabaseId && existingTarget.page?.id) {
      await upsertNotionTranslationMappingRecord(
        client,
        config.translationMappingDatabaseId,
        {
          name: existingTarget.meta?.title || task.node.meta.title,
          enPageId: task.sourcePageId,
          viPageId: existingTarget.page.id,
          status: 'Ready',
        },
        { config, dryRun, logger, retryOptions: options.retryOptions }
      ).catch((err: unknown) => {
        logger.warn(
          `Failed to upsert Ready mapping for existing child page: ${err instanceof Error ? err.message : String(err)}`,
          {
            sourcePageId: task.sourcePageId,
            targetPageId: existingTarget.page.id,
          }
        )
      })
    }

    const reusedValidation =
      structuralValidation ||
      validateTranslation(
        task.node.blockTree,
        existingTree || task.node.blockTree
      )
    const reusedReport = generateTranslationReport({
      sourcePageTitle: task.node.meta.title,
      sourcePageId: task.sourcePageId,
      targetPageId: existingTarget.page.id,
      targetPageUrl: existingTarget.page.url || '',
      totalSourceBlocks: task.manifest.stats.totalSourceBlocks,
      totalTranslatedTextFields: 0,
      totalPreservedBlocks: task.manifest.stats.totalPreservedBlocks,
      totalRecreatedNestedBlocks: task.manifest.stats.totalNestedBlocks,
    })

    return {
      status: reusedValidation.needsReview
        ? TRANSLATION_STATUS.NEEDS_REVIEW
        : TRANSLATION_STATUS.DRAFT_READY,
      sourcePageId: task.sourcePageId,
      targetPageId: existingTarget.page.id,
      targetPageUrl: existingTarget.page.url || '',
      translationGroupId: task.translationGroupId,
      slug: existingTarget.meta.slug,
      translatedTitle: existingTarget.meta.title,
      targetStatus: 'Draft',
      targetLocale,
      resumed: true,
      reusedCachedAi: true,
      validation: reusedValidation,
      report: reusedReport,
      dryRun,
    }
  }

  if (existingTree && existingBlockCount === 0 && sourceBlockCount > 0) {
    logger.info(
      `[Hierarchy Progress] Existing Vietnamese child page "${existingTarget.meta.title}" (${existingTarget.page.id}) is an empty Draft shell; resuming child translation.`
    )
    task.existingInspection = {
      action: 'resume_empty',
      targetPageId: existingTarget.page.id,
      existingPage: existingTarget,
      checkpoint: childCheckpoint,
    }
    return null
  }

  if (
    existingTree &&
    isExistingTargetPrefixValid(task.node.blockTree, existingTree)
  ) {
    logger.info(
      `[Hierarchy Progress] Existing Vietnamese child page "${existingTarget.meta.title}" (${existingTarget.page.id}) has partial Draft content (${existingBlockCount}/${sourceBlockCount} blocks); resuming child translation safely.`
    )
    task.existingInspection = {
      action: 'resume_partial',
      targetPageId: existingTarget.page.id,
      existingPage: existingTarget,
      existingTree,
      checkpoint: childCheckpoint,
    }
    return null
  }

  const reviewReason =
    `[Incomplete or Modified Draft Child Page] Existing Vietnamese child page "${existingTarget.meta.title}" ` +
    `(${existingTarget.page.id}) does not match expected block structure (${existingBlockCount}/${sourceBlockCount} blocks) and will not be overwritten automatically.`
  logger.warn(reviewReason)
  return {
    status: TRANSLATION_STATUS.NEEDS_REVIEW,
    sourcePageId: task.sourcePageId,
    targetPageId: existingTarget.page.id,
    reason: reviewReason,
    dryRun,
  }
}

function buildNodeOutcome(
  task: PlannedPageTask,
  nodeResult: TranslationJobResult,
  config: TranslationConfig
): ChildJobOutcome {
  return {
    sourcePageId: task.sourcePageId,
    title: task.node.meta.title || task.sourcePageId,
    parentKind: task.node.parentKind,
    status: nodeResult.status,
    targetPageId: nodeResult.targetPageId || '',
    failureStage:
      nodeResult.status === TRANSLATION_STATUS.FAILED
        ? nodeResult.failureStage
        : undefined,
    provider:
      nodeResult.status === TRANSLATION_STATUS.FAILED
        ? nodeResult.provider || config.aiProvider
        : undefined,
    model:
      nodeResult.status === TRANSLATION_STATUS.FAILED
        ? nodeResult.model || config.aiModel
        : undefined,
    error:
      nodeResult.status === TRANSLATION_STATUS.FAILED
        ? nodeResult.shortError || nodeResult.error
        : nodeResult.status === 'paused_quota'
          ? nodeResult.reason
          : nodeResult.status === TRANSLATION_STATUS.NEEDS_REVIEW
            ? nodeResult.reason ||
              nodeResult.report?.concisePropertySummary ||
              ''
            : undefined,
  }
}

async function finalizeHierarchicalRootStatus(params: {
  client: Client
  rootSourcePage: NotionPageLike
  rootTask: PlannedPageTask
  rootResult: TranslationJobResult
  plan: TranslationPlan
  progress: HierarchicalJobProgress
  config: TranslationConfig
  dryRun: boolean
  logger: WorkerLogger
  options: ProcessTranslationJobOptions
}): Promise<TranslationJobResult> {
  const {
    client,
    rootSourcePage,
    rootTask,
    rootResult,
    plan,
    progress,
    config,
    dryRun,
    logger,
    options,
  } = params

  const pausedChild = progress.outcomes.find(
    (o) => o.status === 'paused_quota'
  )
  if (rootResult.status === 'paused_quota' || pausedChild) {
    const pauseReason =
      rootResult.status === 'paused_quota'
        ? rootResult.reason
        : pausedChild?.error || 'AI provider quota exhausted'
    const pausedAt = new Date().toISOString()

    await updateSourcePageWorkflowState(
      client,
      rootSourcePage,
      rootTask.dataSourceInfo,
      {
        translationStatus: TRANSLATION_STATUS.REQUESTED,
        ...(rootResult.targetPageId
          ? { translationTargetPageId: rootResult.targetPageId }
          : {}),
        translationError: `[Quota Paused at ${pausedAt}] Completed ${progress.completedCount}/${progress.discoveredCount} resources before quota limit: ${pauseReason}`,
        translationUpdatedAt: pausedAt,
      },
      { dryRun, logger, retryOptions: options.retryOptions }
    ).catch(() => {})

    return {
      status: 'paused_quota',
      sourcePageId: plan.rootPageId,
      targetPageId: rootResult.targetPageId || '',
      reason: pauseReason,
      dryRun,
    }
  }

  // Aggregate child statuses before finalizing root page status
  const childOutcomes = progress.outcomes.filter(
    (o) =>
      normalizeNotionId(o.sourcePageId) !== normalizeNotionId(plan.rootPageId)
  )
  const failedChildren = childOutcomes.filter(
    (o) => o.status === TRANSLATION_STATUS.FAILED
  )
  const reviewChildren = childOutcomes.filter(
    (o) => o.status === TRANSLATION_STATUS.NEEDS_REVIEW
  )

  if (
    rootResult.status === TRANSLATION_STATUS.DRAFT_READY ||
    rootResult.status === TRANSLATION_STATUS.NEEDS_REVIEW
  ) {
    const hasChildIssues =
      failedChildren.length > 0 || reviewChildren.length > 0
    const aggregatedStatus =
      rootResult.status === TRANSLATION_STATUS.NEEDS_REVIEW || hasChildIssues
        ? TRANSLATION_STATUS.NEEDS_REVIEW
        : TRANSLATION_STATUS.DRAFT_READY

    const summaryParts: string[] = []
    if (
      rootResult.status === TRANSLATION_STATUS.NEEDS_REVIEW &&
      rootResult.report?.concisePropertySummary
    ) {
      summaryParts.push(rootResult.report.concisePropertySummary)
    } else if (
      rootResult.status === TRANSLATION_STATUS.NEEDS_REVIEW &&
      'reason' in rootResult &&
      rootResult.reason
    ) {
      summaryParts.push(rootResult.reason)
    }

    if (failedChildren.length > 0) {
      summaryParts.push(
        `Child failures (${failedChildren.length}/${childOutcomes.length}): ` +
          failedChildren
            .map(
              (c) =>
                `Child page: "${c.title}" | Stage: ${c.failureStage || 'AI Translation'} | Provider/Model: ${c.provider || config.aiProvider}/${c.model || config.aiModel} | Error: ${c.error || 'failed'}`
            )
            .join('; ')
      )
    }
    if (reviewChildren.length > 0) {
      summaryParts.push(
        `Children needing review (${reviewChildren.length}/${childOutcomes.length}): ` +
          reviewChildren
            .map((c) => `"${c.title}" (${c.targetPageId || c.sourcePageId})`)
            .join('; ')
      )
    }

    const finalErrorSummary = summaryParts.join(' | ').slice(0, 1950)
    const completedAt = new Date().toISOString()

    if (
      !dryRun &&
      aggregatedStatus === TRANSLATION_STATUS.NEEDS_REVIEW &&
      rootResult.targetPageId
    ) {
      await updateSourcePageWorkflowState(
        client,
        rootResult.targetPageId,
        rootTask.dataSourceInfo,
        {
          translationStatus: TRANSLATION_STATUS.NEEDS_REVIEW,
          translationUpdatedAt: completedAt,
        },
        { dryRun, logger, retryOptions: options.retryOptions }
      ).catch(() => {})
    }

    await updateSourcePageWorkflowState(
      client,
      rootSourcePage,
      rootTask.dataSourceInfo,
      {
        translationStatus: aggregatedStatus,
        translationTargetPageId: rootResult.targetPageId || '',
        translationError:
          aggregatedStatus === TRANSLATION_STATUS.NEEDS_REVIEW
            ? finalErrorSummary
            : '',
        translationUpdatedAt: completedAt,
      },
      { dryRun, logger, retryOptions: options.retryOptions }
    )

    logger.info('[Hierarchy Summary] Completed hierarchical translation job', {
      rootPageId: plan.rootPageId,
      rootTargetPageId: rootResult.targetPageId,
      finalStatus: aggregatedStatus,
      discoveredCount: progress.discoveredCount,
      completedCount: progress.completedCount,
      failedCount: progress.failedCount,
      needsReviewCount: progress.needsReviewCount,
    })

    if (
      aggregatedStatus === TRANSLATION_STATUS.NEEDS_REVIEW &&
      rootResult.status === TRANSLATION_STATUS.DRAFT_READY
    ) {
      return {
        status: TRANSLATION_STATUS.NEEDS_REVIEW,
        sourcePageId: rootResult.sourcePageId,
        targetPageId: rootResult.targetPageId,
        targetPageUrl: rootResult.targetPageUrl,
        translationGroupId: rootResult.translationGroupId,
        slug: rootResult.slug,
        translatedTitle: rootResult.translatedTitle,
        targetStatus: 'Draft',
        targetLocale: rootResult.targetLocale,
        resumed: rootResult.resumed,
        reusedCachedAi: rootResult.reusedCachedAi,
        reason: finalErrorSummary,
        validation: rootResult.validation,
        report: rootResult.report,
        dryRun,
      }
    }
  }

  return rootResult
}

/**
 * Executes a multi-page hierarchical translation plan covering the root page,
 * inline child pages (positioned via `onWriteChildPage`), nested databases,
 * and `Parent`-related child items, then aggregates final status onto the root page.
 */
export async function executeHierarchicalTranslationPlan(
  client: Client,
  rootSourcePage: NotionPageLike,
  plan: TranslationPlan,
  options: ProcessTranslationJobOptions
): Promise<TranslationJobResult> {
  const config = options.config || getTranslationConfig()
  const logger = options.logger || defaultLogger
  const dryRun = Boolean(options.dryRun ?? config.dryRun)
  const targetLocale = options.targetLocale || config.targetLocale || 'vi'

  const progress: HierarchicalJobProgress = {
    rootPageId: plan.rootPageId,
    discoveredCount: plan.totalDiscoveredPages,
    completedCount: 0,
    failedCount: 0,
    needsReviewCount: 0,
    currentResourceTitle: '',
    currentResourceId: '',
    outcomes: [],
  }

  const executedTaskNormIds = new Set<string>()

  async function executeNodeTask(
    task: PlannedPageTask,
    parentTargetPageId: string | null
  ): Promise<TranslationJobResult> {
    const normTaskId = normalizeNotionId(task.sourcePageId)
    executedTaskNormIds.add(normTaskId)

    progress.currentResourceTitle =
      task.node.meta.title || task.sourcePageId
    progress.currentResourceId = task.sourcePageId

    logger.info('[Hierarchy Progress] Starting resource translation', {
      discovered: progress.discoveredCount,
      completed: progress.completedCount,
      failed: progress.failedCount,
      currentResource: progress.currentResourceTitle,
      currentResourceId: progress.currentResourceId,
      parentKind: task.node.parentKind,
      depth: task.node.depth,
    })

    const isRoot = task.node.depth === 0
    const parentDbNode = task.node.parentDatabaseId
      ? plan.graph.databasesById.get(
          normalizeNotionId(task.node.parentDatabaseId)
        ) || null
      : null

    let nodeResult: TranslationJobResult | null = null

    if (!isRoot) {
      nodeResult = await resolveExistingChildDuplicate({
        client,
        task,
        plan,
        parentTargetPageId,
        targetLocale,
        config,
        dryRun,
        logger,
        options,
      })
    }

    if (!nodeResult) {
      nodeResult = await runSinglePageTranslationJob(task.node.page, {
        ...options,
        client,
        config,
        dataSourceInfo: task.dataSourceInfo,
        allDatabasePages: parentDbNode?.allPages || [],
        targetLocale,
        dryRun,
        logger,
        skipHierarchyDiscovery: true,
        isChildTask: !isRoot,
        parentKind: task.node.parentKind,
        parentTargetPageId,
        referenceMap: plan.referenceMap,
        preloadedSourceTree: task.node.blockTree,
        existingCheckOverride: task.existingInspection,
        deferFinalSourceStatusUpdate: isRoot,
        onWriteChildPage: async ({
          sourceChildPageId,
          targetParentPageId: currentTargetParentId,
          existingTargetBlock,
        }) => {
          const childTask = plan.tasksById.get(
            normalizeNotionId(sourceChildPageId)
          )
          if (!childTask) return null

          if (
            existingTargetBlock?.id &&
            childTask.existingInspection.action === 'create_new'
          ) {
            const childCheckpoint = readJobCheckpoint(
              childTask.sourcePageId,
              config
            )
            const existingPageMeta = extractPageWorkflowMeta(
              { id: existingTargetBlock.id },
              childTask.dataSourceInfo
            )
            let inspectedChildTree: NotionBlockTree | null = null
            if (!dryRun) {
              try {
                inspectedChildTree = await readRawNotionTree(
                  existingTargetBlock.id,
                  {
                    client,
                    config,
                    logger,
                    retryOptions: options.retryOptions,
                  }
                )
              } catch {
                inspectedChildTree = null
              }
            }
            const childExistingBlocks = Number(
              inspectedChildTree?.totalBlocks ?? inspectedChildTree?.length ?? 0
            )
            if (inspectedChildTree && childExistingBlocks > 0) {
              childTask.existingInspection = {
                action: 'resume_partial',
                targetPageId: existingTargetBlock.id,
                existingPage: {
                  page: { id: existingTargetBlock.id },
                  meta: existingPageMeta,
                },
                existingTree: inspectedChildTree,
                checkpoint: childCheckpoint,
              }
            } else {
              childTask.existingInspection = {
                action: 'resume_empty',
                targetPageId: existingTargetBlock.id,
                existingPage: {
                  page: { id: existingTargetBlock.id },
                  meta: existingPageMeta,
                },
                checkpoint: childCheckpoint,
              }
            }
          }

          const childRes = await executeNodeTask(
            childTask,
            currentTargetParentId
          )
          if (childRes.status === 'paused_quota') {
            throw new QuotaExhaustedError(childRes.reason, {
              provider: childRes.provider || config.aiProvider,
              model: childRes.model || config.aiModel,
            })
          }
          if (
            childRes.status === TRANSLATION_STATUS.FAILED ||
            !childRes.targetPageId
          ) {
            throw new ChildTaskTranslationError({
              childPageTitle:
                childRes.status === TRANSLATION_STATUS.FAILED &&
                childRes.failedResourceTitle
                  ? childRes.failedResourceTitle
                  : childTask.node.meta.title || childTask.sourcePageId,
              childSourcePageId: childTask.sourcePageId,
              failureStage:
                childRes.status === TRANSLATION_STATUS.FAILED
                  ? childRes.failureStage || 'AI Translation'
                  : 'Notion Page Write',
              provider:
                childRes.status === TRANSLATION_STATUS.FAILED
                  ? childRes.provider || config.aiProvider
                  : config.aiProvider,
              model:
                childRes.status === TRANSLATION_STATUS.FAILED
                  ? childRes.model || config.aiModel
                  : config.aiModel,
              shortError:
                childRes.status === TRANSLATION_STATUS.FAILED
                  ? childRes.shortError ||
                    summarizeShortErrorMessage(childRes.error)
                  : 'Child page creation did not return a target page ID',
            })
          }
          return {
            targetChildPageId: childRes.targetPageId,
            title:
              'translatedTitle' in childRes
                ? childRes.translatedTitle
                : childTask.node.meta.title,
          }
        },
      })
    }

    const outcome = buildNodeOutcome(task, nodeResult, config)
    progress.outcomes.push(outcome)

    if (nodeResult.status === TRANSLATION_STATUS.FAILED) {
      progress.failedCount += 1
    } else if (nodeResult.status === 'paused_quota') {
      logger.warn(
        `[Hierarchy Progress] Pausing hierarchical translation because AI quota was exhausted on "${outcome.title}" (${outcome.sourcePageId})`
      )
      return nodeResult
    } else if (nodeResult.status === TRANSLATION_STATUS.NEEDS_REVIEW) {
      progress.completedCount += 1
      progress.needsReviewCount += 1
    } else {
      progress.completedCount += 1
    }

    logger.info('[Hierarchy Progress] Finished resource translation', {
      discovered: progress.discoveredCount,
      completed: progress.completedCount,
      failed: progress.failedCount,
      needsReview: progress.needsReviewCount,
      resource: outcome.title,
      sourcePageId: outcome.sourcePageId,
      targetPageId: outcome.targetPageId,
      status: outcome.status,
    })

    const resolvedTargetPageId = nodeResult.targetPageId || null

    // If this node succeeded or needs review (i.e. has a targetPageId), translate its nested database items and related database child items
    if (
      resolvedTargetPageId &&
      nodeResult.status !== TRANSLATION_STATUS.FAILED
    ) {
      // 1. Nested databases inside this page
      for (const childDbId of task.node.childDatabaseIds) {
        const dbNode = plan.graph.databasesById.get(
          normalizeNotionId(childDbId)
        )
        if (!dbNode) continue

        for (const engPageId of dbNode.englishPageIds) {
          const normEngId = normalizeNotionId(engPageId)
          if (executedTaskNormIds.has(normEngId)) continue
          const dbItemTask = plan.tasksById.get(normEngId)
          if (!dbItemTask) continue
          const childOut = await executeNodeTask(
            dbItemTask,
            resolvedTargetPageId
          )
          if (childOut.status === 'paused_quota') {
            return childOut
          }
        }
      }

      // 2. Same-database child items linked via `Parent` relation
      for (const relChildId of task.node.relatedChildPageIds) {
        const normRelId = normalizeNotionId(relChildId)
        if (executedTaskNormIds.has(normRelId)) continue
        const relTask = plan.tasksById.get(normRelId)
        if (!relTask) continue
        const relOut = await executeNodeTask(relTask, resolvedTargetPageId)
        if (relOut.status === 'paused_quota') {
          return relOut
        }
      }
    }

    return nodeResult
  }

  const rootTask = plan.tasksById.get(normalizeNotionId(plan.rootPageId))
  if (!rootTask) {
    throw new Error(
      `Root page task ${plan.rootPageId} not found in translation plan.`
    )
  }

  const rootResult = await executeNodeTask(rootTask, null)

  // Execute any remaining unvisited tasks in plan order
  if (
    rootResult.status !== TRANSLATION_STATUS.FAILED &&
    rootResult.status !== 'paused_quota' &&
    !('duplicatePrevented' in rootResult && rootResult.duplicatePrevented)
  ) {
    for (const taskId of plan.orderedTaskIds) {
      const normId = normalizeNotionId(taskId)
      if (executedTaskNormIds.has(normId)) continue
      const remainingTask = plan.tasksById.get(normId)
      if (!remainingTask) continue
      const remOut = await executeNodeTask(
        remainingTask,
        rootResult.targetPageId || null
      )
      if (remOut.status === 'paused_quota') {
        break
      }
    }
  }

  return finalizeHierarchicalRootStatus({
    client,
    rootSourcePage,
    rootTask,
    rootResult,
    plan,
    progress,
    config,
    dryRun,
    logger,
    options,
  })
}
