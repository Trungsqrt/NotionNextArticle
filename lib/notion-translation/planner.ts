import crypto from 'node:crypto'
import type { Client } from '@notionhq/client'
import {
  computeSourceContentFingerprint,
  getAllResourceMappings,
  getMappedTargetPage,
  readJobCheckpoint,
} from './checkpoint-store'
import { extractPageWorkflowMeta } from './discovery'
import { extractTranslationManifest } from './extractor'
import {
  normalizeLocaleCode,
  normalizeNotionId,
  withNotionRetry,
  type NotionOperationOptions,
} from './notion-client'
import { normalizeTreeNodes, readRawNotionTree } from './reader'
import { isExistingTargetPrefixValid } from './writer'
import type { TranslationConfig } from './config'
import type {
  ArticlesDataSourceInfo,
  DatabasePageIndices,
  DiscoveredContentGraph,
  DiscoveredPageNode,
  ExistingTranslationInspection,
  IndexedDatabasePage,
  JobCheckpoint,
  NotionPageLike,
  PageWorkflowMeta,
  PlannedPageTask,
  ReferenceResolutionMap,
  TranslationPlan,
} from './types'
import { defaultLogger } from '../../worker/logger'

const CHILD_PAGE_DATA_SOURCE_INFO: ArticlesDataSourceInfo = {
  databaseId: '',
  dataSourceId: '',
  properties: {
    title: { type: 'title', title: {} },
  },
  titlePropertyName: 'title',
  rawDatabase: null,
  rawDataSource: null,
}

export function canSafelyResumePartialTarget(params: {
  sourcePage: NotionPageLike
  sourceTree: DiscoveredPageNode['blockTree']
  existingTargetTree: DiscoveredPageNode['blockTree']
  targetPageId: string
  checkpoint: JobCheckpoint | null | undefined
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null
  targetLocale?: string
}): boolean {
  const {
    sourcePage,
    sourceTree,
    existingTargetTree,
    targetPageId,
    checkpoint,
    dataSourceInfo,
    targetLocale = 'vi',
  } = params

  if (!checkpoint) return false
  if (
    normalizeNotionId(checkpoint.sourcePageId) !==
    normalizeNotionId(sourcePage?.id)
  ) {
    return false
  }
  if (
    checkpoint.targetPageId &&
    normalizeNotionId(checkpoint.targetPageId) !==
      normalizeNotionId(targetPageId)
  ) {
    return false
  }

  const currentFingerprint = computeSourceContentFingerprint(
    sourcePage,
    sourceTree,
    dataSourceInfo
  )
  if (
    checkpoint.sourceFingerprint &&
    checkpoint.sourceFingerprint !== currentFingerprint
  ) {
    return false
  }

  const cachedAi =
    checkpoint.cachedTranslationResult &&
    checkpoint.cachedTranslationResult.targetLocale === targetLocale &&
    checkpoint.cachedTranslationResult.translations &&
    typeof checkpoint.cachedTranslationResult.translations === 'object'
      ? checkpoint.cachedTranslationResult
      : null

  if (!cachedAi) {
    return false
  }

  const completedBatchEntries = Object.values(checkpoint.completedBatches || {})
  const hasPendingAppend =
    checkpoint.pendingOperation?.type === 'append_blocks'
  if (completedBatchEntries.length === 0 && !hasPendingAppend) {
    return false
  }

  return isExistingTargetPrefixValid(sourceTree, existingTargetTree)
}

export async function inspectExistingTranslationState(params: {
  client: Client
  sourceMeta: PageWorkflowMeta
  sourcePage?: NotionPageLike | null
  sourceTree?: DiscoveredPageNode['blockTree'] | null
  dataSourceInfo?: Partial<ArticlesDataSourceInfo> | null
  translationGroupId: string
  targetLocale: string
  indices: DatabasePageIndices
  checkpoint?: JobCheckpoint | null
  options?: NotionOperationOptions
}): Promise<ExistingTranslationInspection> {
  const {
    client,
    sourceMeta,
    sourcePage = null,
    sourceTree = null,
    dataSourceInfo = null,
    translationGroupId,
    targetLocale,
    indices,
    checkpoint = null,
    options = {},
  } = params

  const candidatesMap = new Map<string, IndexedDatabasePage>()

  if (translationGroupId) {
    const byLocale = indices.pagesByGroupAndLocale.get(translationGroupId)
    const groupMatches = byLocale?.get(targetLocale) || []
    for (const item of groupMatches) {
      if (!item.meta.inTrash) {
        candidatesMap.set(normalizeNotionId(item.page.id), item)
      }
    }
  }

  if (sourceMeta.translationTargetPageId) {
    const normTargetId = normalizeNotionId(sourceMeta.translationTargetPageId)
    const targetEntry = indices.metaByPageId.get(normTargetId)
    if (
      targetEntry &&
      !targetEntry.meta.inTrash &&
      targetEntry.meta.locale === targetLocale
    ) {
      candidatesMap.set(normTargetId, targetEntry)
    } else if (!targetEntry && typeof client?.pages?.retrieve === 'function') {
      try {
        const retrieved = (await withNotionRetry(
          () =>
            client.pages.retrieve({
              page_id: sourceMeta.translationTargetPageId,
            }),
          {
            isIdempotent: true,
            label: `pages.retrieve(${sourceMeta.translationTargetPageId})`,
            logger: options.logger || defaultLogger,
            ...options.retryOptions,
          }
        )) as NotionPageLike
        if (retrieved && !retrieved.in_trash && !retrieved.archived) {
          const meta = extractPageWorkflowMeta(
            retrieved,
            dataSourceInfo,
            targetLocale
          )
          if (meta.locale === targetLocale) {
            candidatesMap.set(normalizeNotionId(retrieved.id), {
              page: retrieved,
              meta,
            })
          }
        }
      } catch {
        // Target page does not exist or is inaccessible
      }
    }
  }

  if (checkpoint?.targetPageId) {
    const normCpTargetId = normalizeNotionId(checkpoint.targetPageId)
    if (!candidatesMap.has(normCpTargetId)) {
      const targetEntry = indices.metaByPageId.get(normCpTargetId)
      if (
        targetEntry &&
        !targetEntry.meta.inTrash &&
        targetEntry.meta.locale === targetLocale
      ) {
        candidatesMap.set(normCpTargetId, targetEntry)
      } else if (typeof client?.pages?.retrieve === 'function') {
        try {
          const retrieved = (await withNotionRetry(
            () => client.pages.retrieve({ page_id: checkpoint.targetPageId! }),
            {
              isIdempotent: true,
              label: `pages.retrieve(${checkpoint.targetPageId})`,
              logger: options.logger || defaultLogger,
              ...options.retryOptions,
            }
          )) as NotionPageLike
          if (retrieved && !retrieved.in_trash && !retrieved.archived) {
            const meta = extractPageWorkflowMeta(
              retrieved,
              dataSourceInfo,
              targetLocale
            )
            if (meta.locale === targetLocale) {
              candidatesMap.set(normCpTargetId, { page: retrieved, meta })
            }
          }
        } catch {
          // Ignore inaccessible checkpoint target page
        }
      }
    }
  }

  const candidates = Array.from(candidatesMap.values())
  if (candidates.length === 0) {
    return { action: 'create_new', checkpoint }
  }

  if (candidates.length > 1) {
    return {
      action: 'duplicate_exists',
      existingPages: candidates,
      primaryPage: candidates[0],
      reason: `Multiple (${candidates.length}) target pages already exist for Translation Group ID "${translationGroupId}" and locale "${targetLocale}".`,
    }
  }

  const singleCandidate = candidates[0]
  try {
    const existingTree = await readRawNotionTree(
      client,
      singleCandidate.page.id,
      options
    )
    const rootBlocks = normalizeTreeNodes(existingTree)
    if (rootBlocks.length === 0) {
      return {
        action: 'resume_empty',
        targetPageId: singleCandidate.page.id,
        existingPage: singleCandidate,
        checkpoint,
      }
    }

    if (
      sourcePage &&
      sourceTree &&
      canSafelyResumePartialTarget({
        sourcePage,
        sourceTree,
        existingTargetTree: existingTree,
        targetPageId: singleCandidate.page.id,
        checkpoint,
        dataSourceInfo,
        targetLocale,
      }) &&
      checkpoint
    ) {
      return {
        action: 'resume_partial',
        targetPageId: singleCandidate.page.id,
        existingPage: singleCandidate,
        existingTree,
        checkpoint,
      }
    }

    return {
      action: 'duplicate_exists',
      existingPages: [singleCandidate],
      primaryPage: singleCandidate,
      existingTree,
      reason: `Target page ${singleCandidate.page.id} ("${singleCandidate.meta.title}") already exists and contains ${rootBlocks.length} top-level block(s).`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      action: 'duplicate_exists',
      existingPages: [singleCandidate],
      primaryPage: singleCandidate,
      reason: `Target page ${singleCandidate.page.id} already exists (could not verify empty state: ${message}).`,
    }
  }
}

async function inspectExistingChildPageState(params: {
  client: Client
  node: DiscoveredPageNode
  targetLocale: string
  checkpoint: JobCheckpoint | null
  parentCheckpoint: JobCheckpoint | null
  config: Partial<TranslationConfig>
  options: NotionOperationOptions
}): Promise<ExistingTranslationInspection> {
  const {
    client,
    node,
    targetLocale,
    checkpoint,
    parentCheckpoint,
    config,
    options,
  } = params

  const mappedEntry = getMappedTargetPage(node.pageId, targetLocale, config)
  const parentRecordedTargetId =
    parentCheckpoint?.childTargetPageIdsBySourceId?.[
      normalizeNotionId(node.pageId)
    ] || null

  const candidateTargetPageId =
    checkpoint?.targetPageId ||
    parentRecordedTargetId ||
    mappedEntry?.targetPageId ||
    null

  if (!candidateTargetPageId || typeof client?.pages?.retrieve !== 'function') {
    return { action: 'create_new', checkpoint }
  }

  try {
    const retrieved = (await withNotionRetry(
      () => client.pages.retrieve({ page_id: candidateTargetPageId }),
      {
        isIdempotent: true,
        label: `pages.retrieve(childTarget:${candidateTargetPageId})`,
        logger: options.logger || defaultLogger,
        ...options.retryOptions,
      }
    )) as NotionPageLike

    if (!retrieved || retrieved.in_trash || retrieved.archived) {
      return { action: 'create_new', checkpoint }
    }

    const meta = extractPageWorkflowMeta(
      retrieved,
      CHILD_PAGE_DATA_SOURCE_INFO,
      targetLocale
    )
    const indexedPage: IndexedDatabasePage = { page: retrieved, meta }
    const existingTree = await readRawNotionTree(
      client,
      retrieved.id,
      options
    )
    const rootBlocks = normalizeTreeNodes(existingTree)

    if (rootBlocks.length === 0) {
      return {
        action: 'resume_empty',
        targetPageId: retrieved.id,
        existingPage: indexedPage,
        checkpoint,
      }
    }

    if (
      canSafelyResumePartialTarget({
        sourcePage: node.page,
        sourceTree: node.blockTree,
        existingTargetTree: existingTree,
        targetPageId: retrieved.id,
        checkpoint,
        dataSourceInfo: CHILD_PAGE_DATA_SOURCE_INFO,
        targetLocale,
      }) &&
      checkpoint
    ) {
      return {
        action: 'resume_partial',
        targetPageId: retrieved.id,
        existingPage: indexedPage,
        existingTree,
        checkpoint,
      }
    }

    return {
      action: 'duplicate_exists',
      existingPages: [indexedPage],
      primaryPage: indexedPage,
      existingTree,
      reason: `Vietnamese child page ${retrieved.id} ("${meta.title}") already exists with ${rootBlocks.length} top-level block(s).`,
    }
  } catch {
    return { action: 'create_new', checkpoint }
  }
}

export function registerResolvedPageInReferenceMap(
  referenceMap: ReferenceResolutionMap,
  params: {
    sourcePageId: string
    targetPageId: string
    sourceSlug?: string
    targetSlug?: string
    targetTitle?: string
    translationGroupId?: string
    targetLocale?: string
  }
): void {
  const normSourceId = normalizeNotionId(params.sourcePageId)
  if (!normSourceId || !params.targetPageId) return

  referenceMap.targetPageIdBySourcePageId.set(
    normSourceId,
    params.targetPageId
  )
  if (params.targetSlug) {
    referenceMap.targetSlugBySourcePageId.set(normSourceId, params.targetSlug)
    if (params.sourceSlug) {
      referenceMap.targetSlugBySourceSlug.set(
        params.sourceSlug.trim().toLowerCase(),
        params.targetSlug
      )
    }
  }

  const existingMeta =
    referenceMap.localizedPageMetaBySourcePageId.get(normSourceId)
  referenceMap.localizedPageMetaBySourcePageId.set(normSourceId, {
    id: params.targetPageId,
    url: existingMeta?.url || '',
    inTrash: false,
    title: params.targetTitle || existingMeta?.title || '',
    slug: params.targetSlug || existingMeta?.slug || '',
    status: existingMeta?.status || 'Draft',
    locale: params.targetLocale || existingMeta?.locale || 'vi',
    rawLocale: params.targetLocale || existingMeta?.rawLocale || 'vi',
    translationGroupId:
      params.translationGroupId || existingMeta?.translationGroupId || '',
    translationStatus: existingMeta?.translationStatus || 'Draft Ready',
    translationError: '',
    translationTargetPageId: '',
    translationUpdatedAt: new Date().toISOString(),
  })
}

export interface BuildTranslationPlanOptions extends NotionOperationOptions {
  config?: Partial<TranslationConfig>
}

/**
 * Builds a complete hierarchical `TranslationPlan` from a `DiscoveredContentGraph`
 * before creating or mutating any Notion pages.
 */
export async function buildTranslationPlan(
  client: Client,
  graph: DiscoveredContentGraph,
  options: BuildTranslationPlanOptions = {}
): Promise<TranslationPlan> {
  const config = options.config || {}
  const targetLocale = normalizeLocaleCode(config.targetLocale || 'vi', 'vi')

  const referenceMap: ReferenceResolutionMap = {
    targetPageIdBySourcePageId: new Map<string, string>(),
    targetSlugBySourceSlug: new Map<string, string>(),
    targetSlugBySourcePageId: new Map<string, string>(),
    translatedDatabaseIds: new Set<string>(),
    localizedPageMetaBySourcePageId: new Map<string, PageWorkflowMeta>(),
  }

  // 1. Seed reference map from persistent local resource mappings
  const persistedMappings = getAllResourceMappings(targetLocale, config)
  for (const entry of persistedMappings) {
    registerResolvedPageInReferenceMap(referenceMap, {
      sourcePageId: entry.sourcePageId,
      targetPageId: entry.targetPageId,
      sourceSlug: entry.sourceSlug,
      targetSlug: entry.targetSlug,
      targetTitle: entry.targetTitle,
      translationGroupId: entry.translationGroupId,
      targetLocale: entry.targetLocale,
    })
  }

  // 2. Seed reference map from all discovered databases' existing localized page indices
  for (const [, dbNode] of graph.databasesById.entries()) {
    const normDbId = normalizeNotionId(dbNode.databaseId)
    if (normDbId) {
      referenceMap.translatedDatabaseIds.add(normDbId)
    }
    if (dbNode.sourceBlockId) {
      referenceMap.translatedDatabaseIds.add(
        normalizeNotionId(dbNode.sourceBlockId)
      )
    }

    for (const [normSourceId, targetMeta] of dbNode.indices.localizedPageMap.entries()) {
      const sourceEntry = dbNode.indices.metaByPageId.get(normSourceId)
      registerResolvedPageInReferenceMap(referenceMap, {
        sourcePageId: normSourceId,
        targetPageId: targetMeta.id,
        sourceSlug: sourceEntry?.meta.slug || '',
        targetSlug: targetMeta.slug || '',
        targetTitle: targetMeta.title || '',
        translationGroupId: targetMeta.translationGroupId || '',
        targetLocale,
      })
    }
  }

  // 3. Build a PlannedPageTask for each discovered page in hierarchical order
  const tasksById = new Map<string, PlannedPageTask>()
  const orderedTaskIds: string[] = []
  let totalTranslatableBlocks = 0

  for (const rawPageId of graph.orderedPageIds) {
    const normPageId = normalizeNotionId(rawPageId)
    const node = graph.pagesById.get(normPageId)
    if (!node) continue

    const parentDbNode = node.parentDatabaseId
      ? graph.databasesById.get(normalizeNotionId(node.parentDatabaseId)) ||
        null
      : null
    const dataSourceInfo =
      parentDbNode?.dataSourceInfo || CHILD_PAGE_DATA_SOURCE_INFO

    const checkpoint = readJobCheckpoint(node.pageId, config)
    const parentCheckpoint = node.parentPageId
      ? readJobCheckpoint(node.parentPageId, config)
      : null
    const persistedMap = getMappedTargetPage(node.pageId, targetLocale, config)

    let translationGroupId =
      node.meta.translationGroupId ||
      checkpoint?.translationGroupId ||
      persistedMap?.translationGroupId ||
      ''
    let generatedGroupId = false
    if (!translationGroupId) {
      translationGroupId =
        node.parentKind === 'page'
          ? `child-page-${normPageId}`
          : crypto.randomUUID()
      generatedGroupId = node.parentKind === 'database'
    }

    let existingInspection: ExistingTranslationInspection
    if (node.parentKind === 'database' && parentDbNode) {
      existingInspection = await inspectExistingTranslationState({
        client,
        sourceMeta: node.meta,
        sourcePage: node.page,
        sourceTree: node.blockTree,
        dataSourceInfo,
        translationGroupId,
        targetLocale,
        indices: parentDbNode.indices,
        checkpoint,
        options,
      })
    } else {
      existingInspection = await inspectExistingChildPageState({
        client,
        node,
        targetLocale,
        checkpoint,
        parentCheckpoint,
        config,
        options,
      })
    }

    // If an existing target page is already known (resume or duplicate_exists), register it in referenceMap
    if (
      existingInspection.action === 'resume_empty' ||
      existingInspection.action === 'resume_partial'
    ) {
      registerResolvedPageInReferenceMap(referenceMap, {
        sourcePageId: node.pageId,
        targetPageId: existingInspection.targetPageId,
        sourceSlug: node.meta.slug,
        targetSlug: existingInspection.existingPage.meta.slug,
        targetTitle: existingInspection.existingPage.meta.title,
        translationGroupId,
        targetLocale,
      })
    } else if (existingInspection.action === 'duplicate_exists') {
      registerResolvedPageInReferenceMap(referenceMap, {
        sourcePageId: node.pageId,
        targetPageId: existingInspection.primaryPage.page.id,
        sourceSlug: node.meta.slug,
        targetSlug: existingInspection.primaryPage.meta.slug,
        targetTitle: existingInspection.primaryPage.meta.title,
        translationGroupId,
        targetLocale,
      })
    }

    const manifest = extractTranslationManifest(node.blockTree, {
      sourcePage: node.page,
      articleTitle: node.meta.title,
    })
    totalTranslatableBlocks += manifest.stats.totalTranslatableBlocks

    const sourceFingerprint = computeSourceContentFingerprint(
      node.page,
      node.blockTree,
      dataSourceInfo
    )

    const task: PlannedPageTask = {
      sourcePageId: node.pageId,
      node,
      dataSourceInfo,
      translationGroupId,
      generatedGroupId,
      existingInspection,
      manifest,
      sourceFingerprint,
      parentSourcePageId: node.parentPageId,
    }

    tasksById.set(normPageId, task)
    orderedTaskIds.push(node.pageId)
  }

  let nestedDbCount = 0
  for (const [, dbNode] of graph.databasesById.entries()) {
    if (!dbNode.isRootDatabase) {
      nestedDbCount += 1
    }
  }

  return {
    rootPageId: graph.rootPageId,
    targetLocale,
    graph,
    tasksById,
    orderedTaskIds,
    referenceMap,
    totalDiscoveredPages: orderedTaskIds.length,
    totalNestedDatabases: nestedDbCount,
    totalTranslatableBlocks,
  }
}
