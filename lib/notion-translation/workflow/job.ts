import { getTranslationConfig } from '../config'
import {
  createNotionClient,
  normalizeNotionId,
  queryAllPages,
  resolveArticlesDataSource,
} from '../notion-client'
import { discoverContentHierarchy } from '../discovery'
import { buildTranslationPlan } from '../planner'
import type {
  ArticlesDataSourceInfo,
  DiscoveredPageParentKind,
  NotionPageLike,
  TranslationJobResult,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import {
  markPageActiveInTranslationJob,
  unmarkPageActiveInTranslationJob,
} from './active-jobs'
import { executeHierarchicalTranslationPlan } from './hierarchical-plan'
import { runSinglePageTranslationJob } from './single-job'
import { extractPageWorkflowMeta } from './state'
import type { ProcessTranslationJobOptions } from './types'

/**
 * Executes the end-to-end translation workflow for a single English source page:
 * 1. Validates source locale & queries database context for duplicate/slug protection.
 * 2. Performs recursive hierarchical discovery & planning on root jobs (tracking active IDs
 *    in a `try/finally` block so the poller never double-starts child pages).
 * 3. Dispatches multi-page plans to `executeHierarchicalTranslationPlan` or single-page jobs
 *    to `runSinglePageTranslationJob`.
 */
export async function processTranslationJob(
  sourcePage: NotionPageLike,
  options: ProcessTranslationJobOptions = {}
): Promise<TranslationJobResult> {
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

  // Step 2: Fetch all database pages (published + draft) for duplicate protection and slug collision checks
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

  const resolvedOptions: ProcessTranslationJobOptions = {
    ...options,
    client,
    config,
    dataSourceInfo,
    allDatabasePages,
    targetLocale,
    dryRun,
    logger,
    parentKind,
  }

  // Step 2b: Perform recursive hierarchical discovery & planning on root jobs
  if (!options.skipHierarchyDiscovery) {
    let graph: Awaited<ReturnType<typeof discoverContentHierarchy>> | null =
      null
    try {
      graph = await discoverContentHierarchy(client, sourcePage, {
        rootDataSourceInfo: dataSourceInfo as ArticlesDataSourceInfo,
        rootAllPages: allDatabasePages,
        config,
        logger,
        retryOptions: options.retryOptions,
      })
    } catch (discErr) {
      logger.warn(
        `Hierarchical discovery fallback to single-page mode for "${sourceMeta.title}" (${sourceMeta.id})`,
        {
          error: discErr instanceof Error ? discErr.message : String(discErr),
        }
      )
      graph = null
    }

    if (graph && graph.orderedPageIds.length > 0) {
      for (const id of graph.orderedPageIds) {
        markPageActiveInTranslationJob(id)
      }

      try {
        const plan = await buildTranslationPlan(client, graph, {
          config,
          logger,
          retryOptions: options.retryOptions,
        })

        const hasChildResources = plan.orderedTaskIds.length > 1
        logger.info('Prepared translation plan', {
          rootPageId: sourceMeta.id,
          rootTitle: sourceMeta.title,
          totalDiscoveredPages: plan.totalDiscoveredPages,
          totalNestedDatabases: plan.totalNestedDatabases,
          totalTranslatableBlocks: plan.totalTranslatableBlocks,
          hierarchicalMode: hasChildResources,
        })

        if (hasChildResources) {
          return await executeHierarchicalTranslationPlan(
            client,
            sourcePage,
            plan,
            resolvedOptions
          )
        }

        // Single-page job with referenceMap and preloaded tree from plan
        const rootTask = plan.tasksById.get(normalizeNotionId(sourceMeta.id))
        return await runSinglePageTranslationJob(sourcePage, {
          ...resolvedOptions,
          skipHierarchyDiscovery: true,
          referenceMap: plan.referenceMap,
          preloadedSourceTree: rootTask?.node.blockTree || null,
        })
      } finally {
        for (const id of graph.orderedPageIds) {
          unmarkPageActiveInTranslationJob(id)
        }
      }
    }
  }

  return runSinglePageTranslationJob(sourcePage, {
    ...resolvedOptions,
    skipHierarchyDiscovery: true,
  })
}
