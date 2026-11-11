import crypto from 'node:crypto'
import type { Client, UpdatePageParameters } from '@notionhq/client'
import {
  TRANSLATION_STATUS,
  getTranslationConfig,
  type TranslationConfig,
} from './config'
import {
  createNotionClient,
  withNotionRetry,
  resolveArticlesDataSource,
  queryAllPages,
  normalizeLocaleCode,
  normalizeNotionId,
  findPropertyKey,
  findTitlePropertyKey,
  getPropertyPlainText,
  upsertNotionTranslationMappingRecord,
  type NotionOperationOptions,
} from './notion-client'
import { normalizeTreeNodes, readRawNotionTree } from './reader'
import { extractTranslationManifest } from './extractor'
import {
  QuotaExhaustedError,
  isQuotaExhaustedError,
  translateManifest,
} from './translator'
import {
  buildTranslatedBlockTree,
  buildTranslatedPageProperties,
} from './builder'
import {
  createTranslatedNotionPage,
  isExistingTargetPrefixValid,
} from './writer'
import { validateTranslation, generateTranslationReport } from './validator'
import {
  computeSourceContentFingerprint,
  createCheckpointController,
  deleteJobCheckpoint,
  getJobCheckpointPath,
  getMappedTargetPage,
  readJobCheckpoint,
  recordPageTranslationMapping,
  writeJobCheckpoint,
} from './checkpoint-store'
import { discoverContentHierarchy } from './discovery'
import {
  buildTranslationPlan,
  registerResolvedPageInReferenceMap,
} from './planner'
import type {
  AiProviderAdapter,
  ArticlesDataSourceInfo,
  ChildJobOutcome,
  DatabasePageIndices,
  DiscoveredPageParentKind,
  ExistingTranslationInspection,
  HierarchicalJobProgress,
  IndexedDatabasePage,
  JobCheckpoint,
  NotionBlockTree,
  NotionPageLike,
  PageWorkflowMeta,
  PlannedPageTask,
  RecoveredJobSummary,
  ReferenceResolutionMap,
  TranslateManifestResult,
  TranslationFailureStage,
  TranslationJobResult,
  TranslationPlan,
  TranslationStatus,
} from './types'
import { defaultLogger } from '../../worker/logger'

export {
  computeSourceContentFingerprint,
  createCheckpointController,
  deleteJobCheckpoint,
  getJobCheckpointPath,
  readJobCheckpoint,
  recordPageTranslationMapping,
  writeJobCheckpoint,
  discoverContentHierarchy,
  buildTranslationPlan,
}

const activeJobResourceIds = new Set<string>()

export function isPageInActiveTranslationJob(pageId: string): boolean {
  const norm = normalizeNotionId(pageId)
  return Boolean(norm && activeJobResourceIds.has(norm))
}

export function markPageActiveInTranslationJob(pageId: string): void {
  const norm = normalizeNotionId(pageId)
  if (norm) activeJobResourceIds.add(norm)
}

export function unmarkPageActiveInTranslationJob(pageId: string): void {
  const norm = normalizeNotionId(pageId)
  if (norm) activeJobResourceIds.delete(norm)
}

export class ChildTaskTranslationError extends Error {
  readonly isChildTaskError = true
  readonly childPageTitle: string
  readonly childSourcePageId: string
  readonly failureStage: TranslationFailureStage
  readonly provider: string
  readonly model: string
  readonly shortError: string

  constructor(params: {
    childPageTitle: string
    childSourcePageId: string
    failureStage: TranslationFailureStage
    provider: string
    model: string
    shortError: string
  }) {
    const cleanShort = String(params.shortError || 'Unknown error')
      .replace(/\s+/g, ' ')
      .trim()
    super(
      `Child page "${params.childPageTitle}" (${params.childSourcePageId}) failed at stage "${params.failureStage}" (${params.provider}/${params.model}): ${cleanShort}`
    )
    this.name = 'ChildTaskTranslationError'
    this.childPageTitle = params.childPageTitle
    this.childSourcePageId = params.childSourcePageId
    this.failureStage = params.failureStage
    this.provider = params.provider
    this.model = params.model
    this.shortError = cleanShort
  }
}

export function summarizeShortErrorMessage(rawError: string): string {
  const oneLine = String(rawError || '')
    .replace(/\s+/g, ' ')
    .trim()
  return oneLine.length > 360 ? `${oneLine.slice(0, 357)}...` : oneLine
}

export function formatNotionTranslationErrorSummary(params: {
  pageTitle: string
  isChildPage?: boolean
  failureStage: TranslationFailureStage
  provider: string
  model: string
  rawError: string
  failedAt: string
}): string {
  const shortMsg = summarizeShortErrorMessage(params.rawError)
  const label = params.isChildPage ? 'Child page' : 'Page'
  return `[Failed at ${params.failedAt}] ${label}: "${params.pageTitle}" | Stage: ${params.failureStage} | Model: ${params.provider}/${params.model} | Error: ${shortMsg}`.slice(
    0,
    1950
  )
}

export function extractPageWorkflowMeta(
  page: NotionPageLike | null | undefined,
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null = null
): PageWorkflowMeta {
  const props = (page?.properties || {}) as Record<
    string,
    Record<string, unknown>
  >
  const schemaProps = { ...(dataSourceInfo?.properties || {}), ...props }

  const titleKey =
    dataSourceInfo?.titlePropertyName || findTitlePropertyKey(schemaProps)
  const slugKey = findPropertyKey(schemaProps, ['Slug', 'slug'])
  const statusKey = findPropertyKey(schemaProps, ['Status', 'status'])
  const localeKey = findPropertyKey(schemaProps, ['Locale'])
  const groupKey = findPropertyKey(schemaProps, [
    'Translation Group ID',
    'Translation Group',
    'TranslationGroupId',
  ])
  const transStatusKey = findPropertyKey(schemaProps, [
    'Translation Status',
    'TranslationStatus',
  ])
  const transErrorKey = findPropertyKey(schemaProps, [
    'Translation Error',
    'TranslationError',
  ])
  const transTargetIdKey = findPropertyKey(schemaProps, [
    'Translation Target Page ID',
    'TranslationTargetPageId',
  ])
  const transUpdatedAtKey = findPropertyKey(schemaProps, [
    'Translation Updated At',
    'TranslationUpdatedAt',
  ])

  const rawLocale = localeKey ? getPropertyPlainText(props[localeKey]) : ''
  const locale = normalizeLocaleCode(rawLocale, 'en')

  return {
    id: page?.id || '',
    url: page?.url || '',
    inTrash: Boolean(page?.in_trash || page?.archived),
    title:
      (titleKey ? getPropertyPlainText(props[titleKey]) : '') || 'Untitled',
    slug: (slugKey ? getPropertyPlainText(props[slugKey]) : '').trim(),
    status:
      (statusKey ? getPropertyPlainText(props[statusKey]) : '').trim() ||
      'Published',
    locale,
    rawLocale: rawLocale.trim(),
    translationGroupId: (groupKey
      ? getPropertyPlainText(props[groupKey])
      : ''
    ).trim(),
    translationStatus: (transStatusKey
      ? getPropertyPlainText(props[transStatusKey])
      : ''
    ).trim(),
    translationError: (transErrorKey
      ? getPropertyPlainText(props[transErrorKey])
      : ''
    ).trim(),
    translationTargetPageId: (transTargetIdKey
      ? getPropertyPlainText(props[transTargetIdKey])
      : ''
    ).trim(),
    translationUpdatedAt:
      (transUpdatedAtKey
        ? getPropertyPlainText(props[transUpdatedAtKey])
        : ''
      ).trim() ||
      page?.last_edited_time ||
      page?.created_time ||
      '',
  }
}

function formatTranslationStatusPropertyValue(
  schemaProps: Record<string, Record<string, unknown>> | undefined,
  pageProps: Record<string, Record<string, unknown>> | undefined,
  propKey: string,
  statusValue: string
): Record<string, unknown> {
  const propType = String(
    schemaProps?.[propKey]?.type || pageProps?.[propKey]?.type || 'select'
  )
  if (propType === 'status') {
    return { status: { name: statusValue } }
  }
  if (propType === 'rich_text') {
    return {
      rich_text: [{ type: 'text', text: { content: statusValue } }],
    }
  }
  return { select: { name: statusValue } }
}

export interface SourceWorkflowStateUpdates {
  translationStatus?: TranslationStatus | string
  translationError?: string
  translationTargetPageId?: string
  translationUpdatedAt?: string
  translationGroupId?: string
}

export async function updateSourcePageWorkflowState(
  client: Client,
  sourcePage: NotionPageLike | string,
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null | undefined,
  updates: SourceWorkflowStateUpdates = {},
  options: NotionOperationOptions = {}
): Promise<unknown> {
  const { dryRun = false, logger = defaultLogger } = options
  const pageId =
    typeof sourcePage === 'string' ? sourcePage : sourcePage?.id || ''
  const pageProps = (
    typeof sourcePage === 'object' && sourcePage !== null
      ? sourcePage.properties
      : null
  ) as Record<string, Record<string, unknown>> | null
  const isChildPageParent =
    typeof sourcePage === 'object' &&
    sourcePage !== null &&
    sourcePage.parent?.type === 'page_id'
  if (isChildPageParent) {
    return null
  }

  const dbSchemaProps = dataSourceInfo?.properties
  const hasExplicitDbSchema =
    Boolean(dbSchemaProps) && Object.keys(dbSchemaProps!).length > 0
  const schemaProps: Record<string, Record<string, unknown>> = hasExplicitDbSchema
    ? { ...dbSchemaProps! }
    : { ...(dbSchemaProps || {}), ...(pageProps || {}) }

  const properties: Record<string, unknown> = {}

  if (updates.translationStatus !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Status',
      'TranslationStatus',
    ])
    const key = foundKey || (!hasExplicitDbSchema ? 'Translation Status' : null)
    if (key) {
      properties[key] = formatTranslationStatusPropertyValue(
        dataSourceInfo?.properties,
        pageProps || undefined,
        key,
        updates.translationStatus
      )
    }
  }

  if (updates.translationError !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Error',
      'TranslationError',
    ])
    const key = foundKey || (!hasExplicitDbSchema ? 'Translation Error' : null)
    if (key) {
      const text = String(updates.translationError || '').slice(0, 1950)
      properties[key] = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      }
    }
  }

  if (updates.translationTargetPageId !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Target Page ID',
      'TranslationTargetPageId',
    ])
    const key =
      foundKey || (!hasExplicitDbSchema ? 'Translation Target Page ID' : null)
    if (key) {
      const text = String(updates.translationTargetPageId || '').trim()
      properties[key] = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      }
    }
  }

  if (updates.translationUpdatedAt !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Updated At',
      'TranslationUpdatedAt',
    ])
    const key =
      foundKey || (!hasExplicitDbSchema ? 'Translation Updated At' : null)
    if (key) {
      const iso = updates.translationUpdatedAt || new Date().toISOString()
      properties[key] = {
        date: iso ? { start: iso } : null,
      }
    }
  }

  if (updates.translationGroupId !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Group ID',
      'Translation Group',
      'TranslationGroupId',
    ])
    const key =
      foundKey || (!hasExplicitDbSchema ? 'Translation Group ID' : null)
    if (key) {
      const text = String(updates.translationGroupId || '').trim()
      properties[key] = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      }
    }
  }

  if (Object.keys(properties).length === 0) {
    return null
  }

  if (dryRun) {
    logger.info(
      `[Dry Run] Would update page ${pageId} workflow properties:`,
      updates as Record<string, unknown>
    )
    return { id: pageId, properties, dryRun: true }
  }

  return withNotionRetry(
    () =>
      client.pages.update({
        page_id: pageId,
        properties,
      } as unknown as UpdatePageParameters),
    {
      isIdempotent: true,
      label: `pages.update(${pageId})`,
      logger,
      ...options.retryOptions,
    }
  )
}

/**
 * Builds helper lookup indices from all pages in the Articles database.
 */
export function buildDatabasePageIndices(
  allPages: readonly NotionPageLike[],
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null = null,
  targetLocale = 'vi'
): DatabasePageIndices {
  const existingSlugs = new Set<string>()
  const pagesByGroupAndLocale = new Map<
    string,
    Map<string, IndexedDatabasePage[]>
  >()
  const metaByPageId = new Map<string, IndexedDatabasePage>()

  for (const page of allPages || []) {
    if (!page || page.in_trash || page.archived) continue
    const meta = extractPageWorkflowMeta(page, dataSourceInfo)
    metaByPageId.set(normalizeNotionId(meta.id), { page, meta })

    if (meta.slug) {
      existingSlugs.add(meta.slug.toLowerCase())
    }

    if (meta.translationGroupId) {
      const groupKey = meta.translationGroupId.trim().toLowerCase()
      if (!pagesByGroupAndLocale.has(groupKey)) {
        pagesByGroupAndLocale.set(groupKey, new Map())
      }
      const byLocale = pagesByGroupAndLocale.get(groupKey)!
      if (!byLocale.has(meta.locale)) {
        byLocale.set(meta.locale, [])
      }
      byLocale.get(meta.locale)!.push({ page, meta })
    }
  }

  const localizedPageMap = new Map<string, PageWorkflowMeta>()
  for (const [, byLocale] of pagesByGroupAndLocale.entries()) {
    const enList = byLocale.get('en') || []
    const targetList = byLocale.get(targetLocale) || []
    if (enList.length > 0 && targetList.length === 1) {
      const targetMeta = targetList[0]!.meta
      for (const enEntry of enList) {
        localizedPageMap.set(normalizeNotionId(enEntry.meta.id), targetMeta)
      }
    }
  }

  return {
    existingSlugs,
    pagesByGroupAndLocale,
    metaByPageId,
    localizedPageMap,
  }
}

export interface InspectExistingTranslationOptions extends NotionOperationOptions {
  checkpoint?: JobCheckpoint | null
  dataSourceInfo?: Partial<ArticlesDataSourceInfo> | null
  allowResumeEmptyShell?: boolean
  allowResumePartial?: boolean
}

/**
 * Inspects whether a target page already exists for the source page and determines
 * whether the job should create a new page, resume an empty Draft page, resume a
 * partially written Draft page with a matching local checkpoint, or stop to prevent duplicates.
 */
export async function inspectExistingTranslationState(
  client: Client,
  sourceMeta: PageWorkflowMeta,
  translationGroupId: string,
  indices: DatabasePageIndices | null | undefined,
  targetLocale = 'vi',
  options: InspectExistingTranslationOptions = {}
): Promise<ExistingTranslationInspection> {
  const config = options.config || getTranslationConfig()
  const checkpoint =
    options.checkpoint !== undefined
      ? options.checkpoint
      : readJobCheckpoint(sourceMeta.id, config)

  const sourceNormId = normalizeNotionId(sourceMeta.id)
  const groupKey = String(translationGroupId || '').trim().toLowerCase()
  const candidatesMap = new Map<string, IndexedDatabasePage>()

  // 1. Check database pages with matching Translation Group ID + targetLocale
  if (groupKey && indices?.pagesByGroupAndLocale?.has(groupKey)) {
    const byLocale = indices.pagesByGroupAndLocale.get(groupKey)
    const matches = byLocale?.get(targetLocale) || []
    for (const entry of matches) {
      const normId = normalizeNotionId(entry.meta.id)
      if (normId && normId !== sourceNormId) {
        candidatesMap.set(normId, entry)
      }
    }
  }

  // 2. Also check explicit Translation Target Page ID on the source page, checkpoint targetPageId, or persistent resource-map
  const mappedTarget = getMappedTargetPage(sourceMeta.id, targetLocale, config)
  const explicitTargetIds = [
    sourceMeta.translationTargetPageId,
    checkpoint?.targetPageId,
    mappedTarget?.targetPageId,
  ].filter((val): val is string => Boolean(val))

  for (const rawTargetId of explicitTargetIds) {
    const targetId = String(rawTargetId).trim()
    const targetNormId = normalizeNotionId(targetId)
    if (
      targetNormId &&
      targetNormId !== sourceNormId &&
      !candidatesMap.has(targetNormId)
    ) {
      const known = indices?.metaByPageId?.get(targetNormId)
      if (known) {
        candidatesMap.set(targetNormId, known)
      } else if (typeof client?.pages?.retrieve === 'function') {
        try {
          const retrieved = (await withNotionRetry(
            () => client.pages.retrieve({ page_id: targetId }),
            {
              isIdempotent: true,
              label: `pages.retrieve(${targetId})`,
              logger: options.logger,
              ...options.retryOptions,
            }
          )) as NotionPageLike
          if (retrieved && !retrieved.in_trash && !retrieved.archived) {
            candidatesMap.set(targetNormId, {
              page: retrieved,
              meta: extractPageWorkflowMeta(retrieved, options.dataSourceInfo),
            })
          }
        } catch {
          // Target page ID no longer exists in Notion
        }
      }
    }
  }

  const candidateList = Array.from(candidatesMap.values())
  if (candidateList.length === 0) {
    return { action: 'create_new', checkpoint }
  }

  if (candidateList.length > 1) {
    const summary = candidateList
      .map(
        (c) =>
          `"${c.meta.title}" (id: ${c.meta.id}, slug: ${c.meta.slug}, status: ${c.meta.status})`
      )
      .join(', ')
    return {
      action: 'duplicate_exists',
      existingPages: candidateList,
      primaryPage: candidateList[0]!,
      reason: `Multiple (${candidateList.length}) ${targetLocale.toUpperCase()} pages already exist for Translation Group ID "${translationGroupId}": ${summary}`,
    }
  }

  const single = candidateList[0]!
  const singleNormId = normalizeNotionId(single.meta.id)
  const isTargetDraft = single.meta.status.toLowerCase() === 'draft'
  const matchesSourceTargetId =
    Boolean(sourceMeta.translationTargetPageId) &&
    normalizeNotionId(sourceMeta.translationTargetPageId) === singleNormId
  const matchesCheckpointTargetId =
    Boolean(checkpoint?.targetPageId) &&
    normalizeNotionId(checkpoint?.targetPageId) === singleNormId
  const matchesGroupId =
    Boolean(groupKey) &&
    single.meta.translationGroupId.trim().toLowerCase() === groupKey

  let existingBlocks: NotionBlockTree
  try {
    existingBlocks = await readRawNotionTree(single.meta.id, {
      client,
      config,
      logger: options.logger,
      retryOptions: options.retryOptions,
    })
  } catch {
    return {
      action: 'duplicate_exists',
      existingPages: [single],
      primaryPage: single,
      reason: `Existing ${targetLocale.toUpperCase()} page found: "${single.meta.title}" (id: ${single.meta.id}, slug: ${single.meta.slug}, status: ${single.meta.status}).`,
    }
  }

  // Never overwrite or resume a Published page
  if (!isTargetDraft) {
    return {
      action: 'duplicate_exists',
      existingPages: [single],
      primaryPage: single,
      existingTree: existingBlocks,
      reason: `Existing ${targetLocale.toUpperCase()} page "${single.meta.title}" (id: ${single.meta.id}) has status "${single.meta.status}" (not Draft) and will not be overwritten.`,
    }
  }

  // Safe resume 1: empty shell (0 blocks) associated with this job
  if (
    existingBlocks.length === 0 &&
    (matchesSourceTargetId || matchesCheckpointTargetId || matchesGroupId) &&
    options.allowResumeEmptyShell !== false
  ) {
    return {
      action: 'resume_empty',
      targetPageId: single.meta.id,
      existingPage: single,
      checkpoint,
    }
  }

  // Safe resume 2: partially written Draft target page with a matching local checkpoint record
  if (
    existingBlocks.length > 0 &&
    checkpoint &&
    matchesCheckpointTargetId &&
    (matchesSourceTargetId || matchesGroupId) &&
    options.allowResumePartial !== false
  ) {
    return {
      action: 'resume_partial',
      targetPageId: single.meta.id,
      existingPage: single,
      existingTree: existingBlocks,
      checkpoint,
    }
  }

  return {
    action: 'duplicate_exists',
    existingPages: [single],
    primaryPage: single,
    existingTree: existingBlocks,
    reason: `Existing ${targetLocale.toUpperCase()} page already exists for Translation Group ID "${translationGroupId}": "${single.meta.title}" (id: ${single.meta.id}, slug: ${single.meta.slug}, status: ${single.meta.status}, blocks: ${existingBlocks.totalBlocks ?? existingBlocks.length}).`,
  }
}

export interface ProcessTranslationJobOptions extends InspectExistingTranslationOptions {
  client?: Client
  config?: TranslationConfig
  allDatabasePages?: NotionPageLike[]
  targetLocale?: string
  aiAdapter?: AiProviderAdapter
  batchSize?: number
  maxBatchChars?: number
  concurrency?: number
  maxAiRetries?: number
  maxBlocksPerAppend?: number
  generateUuid?: () => string
  parentKind?: DiscoveredPageParentKind
  parentTargetPageId?: string | null
  referenceMap?: ReferenceResolutionMap | null
  skipHierarchyDiscovery?: boolean
  isChildTask?: boolean
  preloadedSourceTree?: NotionBlockTree | null
  existingCheckOverride?: ExistingTranslationInspection | null
  deferFinalSourceStatusUpdate?: boolean
  onWriteChildPage?: (params: {
    sourceChildPageNode: NotionBlockTree[number]
    sourceChildPageId: string
    targetParentPageId: string
    expectedStartIndex: number
    existingTargetBlock: { id?: string; type?: string } | null
  }) => Promise<{ targetChildPageId: string; title?: string } | null>
}

/**
 * Executes the end-to-end translation workflow for a single English source page:
 * 1. Validates source locale & ensures `Translation Group ID`.
 * 2. Inspects existing translations & local checkpoints for duplicate protection or partial resume.
 * 3. Reads the complete raw source block tree & computes its SHA-256 content fingerprint.
 * 4. Extracts translatable text & either reuses cached AI translations or calls the AI provider.
 * 5. Persists AI translations in the local checkpoint before Notion writes begin.
 * 6. Creates or resumes the Draft Vietnamese page and writes blocks in checkpointed batches.
 * 7. Validates structural completeness, updates `Translation Status`, and cleans up completed checkpoints.
 */
export async function processTranslationJob(
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
            {
              ...options,
              config,
              dataSourceInfo,
              allDatabasePages,
              targetLocale,
              dryRun,
              logger,
            }
          )
        }

        // Single-page job with referenceMap and preloaded tree from plan
        const rootTask = plan.tasksById.get(normalizeNotionId(sourceMeta.id))
        return await processTranslationJob(sourcePage, {
          ...options,
          client,
          config,
          dataSourceInfo,
          allDatabasePages,
          targetLocale,
          dryRun,
          logger,
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

  const indices = buildDatabasePageIndices(
    allDatabasePages,
    dataSourceInfo,
    targetLocale
  )
  const existingCheckpoint = dryRun
    ? null
    : readJobCheckpoint(sourceMeta.id, config)

  // Step 3: Ensure source page has a Translation Group ID
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
    let translationResult: TranslateManifestResult | null = null
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
        translationResult = {
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

    if (!translationResult) {
      translationResult = await translateManifest(manifest, targetLocale, {
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

      checkpointController.setCachedTranslationResult(
        translationResult,
        sourceFingerprint
      )
    }

    // Step 9: Build translated block tree & target page properties (Status = Draft, Locale = vi)
    currentStage = 'Block Tree Build'
    const referenceMap = options.referenceMap || null
    if (referenceMap) {
      for (const [normSrcId, meta] of referenceMap.localizedPageMetaBySourcePageId.entries()) {
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

    const reconcileCreatedPage = async (): Promise<NotionPageLike | null> => {
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
            ).catch((err: any) => {
              logger.warn(
                `Failed to upsert Draft mapping into Notion mapping database: ${err?.message || err}`,
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
      ).catch((err: any) => {
        logger.warn(
          `Failed to upsert final translation mapping into Notion mapping database: ${err?.message || err}`,
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
              updateErr instanceof Error
                ? updateErr.message
                : String(updateErr),
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
      err && typeof err === 'object' && (err as { needsReview?: boolean }).needsReview
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
              updateErr instanceof Error
                ? updateErr.message
                : String(updateErr),
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
        createdOrResumedTargetPageId ||
        sourceMeta.translationTargetPageId ||
        '',
      error: formattedNotionError,
      shortError,
      failureStage,
      failedResourceTitle,
      provider: providerName,
      model: modelName,
      dryRun,
    }
  }
}

async function executeHierarchicalTranslationPlan(
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

    // If a child resource (depth > 0) already has a single existing Vietnamese page,
    // inspect whether it is published, complete, or an incomplete draft that should be resumed.
    // Never overwrite published or manually edited Vietnamese content, and never mark an
    // incomplete child page as Draft Ready automatically.
    if (
      !isRoot &&
      task.existingInspection.action === 'duplicate_exists' &&
      task.existingInspection.existingPages.length === 1
    ) {
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
          ).catch((err: any) => {
            logger.warn(
              `Failed to upsert Ready mapping for existing child page: ${err?.message || err}`,
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

        nodeResult = {
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
      } else if (existingTree && existingBlockCount === 0 && sourceBlockCount > 0) {
        logger.info(
          `[Hierarchy Progress] Existing Vietnamese child page "${existingTarget.meta.title}" (${existingTarget.page.id}) is an empty Draft shell; resuming child translation.`
        )
        task.existingInspection = {
          action: 'resume_empty',
          targetPageId: existingTarget.page.id,
          existingPage: existingTarget,
          checkpoint: childCheckpoint,
        }
      } else if (
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
      } else {
        const reviewReason =
          `[Incomplete or Modified Draft Child Page] Existing Vietnamese child page "${existingTarget.meta.title}" ` +
          `(${existingTarget.page.id}) does not match expected block structure (${existingBlockCount}/${sourceBlockCount} blocks) and will not be overwritten automatically.`
        logger.warn(reviewReason)
        nodeResult = {
          status: TRANSLATION_STATUS.NEEDS_REVIEW,
          sourcePageId: task.sourcePageId,
          targetPageId: existingTarget.page.id,
          reason: reviewReason,
          dryRun,
        }
      }
    }

    if (!nodeResult) {
      nodeResult = await processTranslationJob(task.node.page, {
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

    // Record outcome for this node
    const outcome: ChildJobOutcome = {
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
    if (resolvedTargetPageId && nodeResult.status !== TRANSLATION_STATUS.FAILED) {
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
    (o) => normalizeNotionId(o.sourcePageId) !== normalizeNotionId(plan.rootPageId)
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

export interface RecoverStaleJobsOptions extends ProcessTranslationJobOptions {
  staleTimeoutMs?: number
  nowMs?: number
}

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
