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
  type NotionOperationOptions,
} from './notion-client'
import { readRawNotionTree } from './reader'
import { extractTranslationManifest } from './extractor'
import { translateManifest } from './translator'
import {
  buildTranslatedBlockTree,
  buildTranslatedPageProperties,
} from './builder'
import { createTranslatedNotionPage } from './writer'
import { validateTranslation, generateTranslationReport } from './validator'
import {
  computeSourceContentFingerprint,
  createCheckpointController,
  deleteJobCheckpoint,
  getJobCheckpointPath,
  readJobCheckpoint,
  writeJobCheckpoint,
} from './checkpoint-store'
import type {
  AiProviderAdapter,
  ArticlesDataSourceInfo,
  DatabasePageIndices,
  ExistingTranslationInspection,
  IndexedDatabasePage,
  JobCheckpoint,
  NotionBlockTree,
  NotionPageLike,
  PageWorkflowMeta,
  RecoveredJobSummary,
  TranslateManifestResult,
  TranslationJobResult,
  TranslationStatus,
} from './types'
import { defaultLogger } from '../../worker/logger'

export {
  computeSourceContentFingerprint,
  createCheckpointController,
  deleteJobCheckpoint,
  getJobCheckpointPath,
  readJobCheckpoint,
  writeJobCheckpoint,
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
  const schemaProps: Record<string, Record<string, unknown>> = {
    ...(dataSourceInfo?.properties || {}),
    ...(pageProps || {}),
  }

  const properties: Record<string, unknown> = {}

  if (updates.translationStatus !== undefined) {
    const key =
      findPropertyKey(schemaProps, [
        'Translation Status',
        'TranslationStatus',
      ]) || 'Translation Status'
    properties[key] = formatTranslationStatusPropertyValue(
      dataSourceInfo?.properties,
      pageProps || undefined,
      key,
      updates.translationStatus
    )
  }

  if (updates.translationError !== undefined) {
    const key =
      findPropertyKey(schemaProps, ['Translation Error', 'TranslationError']) ||
      'Translation Error'
    const text = String(updates.translationError || '').slice(0, 1950)
    properties[key] = {
      rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
    }
  }

  if (updates.translationTargetPageId !== undefined) {
    const key =
      findPropertyKey(schemaProps, [
        'Translation Target Page ID',
        'TranslationTargetPageId',
      ]) || 'Translation Target Page ID'
    const text = String(updates.translationTargetPageId || '').trim()
    properties[key] = {
      rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
    }
  }

  if (updates.translationUpdatedAt !== undefined) {
    const key =
      findPropertyKey(schemaProps, [
        'Translation Updated At',
        'TranslationUpdatedAt',
      ]) || 'Translation Updated At'
    const iso = updates.translationUpdatedAt || new Date().toISOString()
    properties[key] = {
      date: iso ? { start: iso } : null,
    }
  }

  if (updates.translationGroupId !== undefined) {
    const key =
      findPropertyKey(schemaProps, [
        'Translation Group ID',
        'Translation Group',
        'TranslationGroupId',
      ]) || 'Translation Group ID'
    const text = String(updates.translationGroupId || '').trim()
    properties[key] = {
      rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
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

  // 2. Also check explicit Translation Target Page ID on the source page or checkpoint targetPageId
  const explicitTargetIds = [
    sourceMeta.translationTargetPageId,
    checkpoint?.targetPageId,
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
  const allDatabasePages =
    options.allDatabasePages ||
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
  let translationGroupId =
    sourceMeta.translationGroupId ||
    existingCheckpoint?.translationGroupId ||
    ''
  if (!translationGroupId) {
    translationGroupId = options.generateUuid
      ? options.generateUuid()
      : crypto.randomUUID()
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
  } else if (!sourceMeta.translationGroupId && translationGroupId) {
    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      { translationGroupId },
      { dryRun, logger, retryOptions: options.retryOptions }
    )
  }

  // Step 4: Inspect existing translation state & resume eligibility before creating any page
  const existingCheck = await inspectExistingTranslationState(
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
  let createdOrResumedTargetPageId: string | null = isResumingExistingPage
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
    logger.info(
      `Reading raw Notion block tree for "${sourceMeta.title}" (${sourceMeta.id})...`
    )
    const sourceTree = await readRawNotionTree(sourceMeta.id, {
      client,
      config,
      logger,
      retryOptions: options.retryOptions,
    })

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
    let translationResult: TranslateManifestResult | null = null
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
        maxRetries: options.maxAiRetries ?? 3,
      })

      checkpointController.setCachedTranslationResult(
        translationResult,
        sourceFingerprint
      )
    }

    // Step 9: Build translated block tree & target page properties (Status = Draft, Locale = vi)
    const translatedTree = buildTranslatedBlockTree(
      sourceTree,
      translationResult,
      {
        sourcePageId: sourceMeta.id,
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
      }
    )

    const reconcileCreatedPage = async (): Promise<NotionPageLike | null> => {
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
    const writeResult = await createTranslatedNotionPage(
      sourcePage,
      translatedTree,
      {
        client,
        config,
        dataSourceInfo,
        pagePropertiesPayload,
        resumeTargetPageId: createdOrResumedTargetPageId,
        isResuming: isResumingExistingPage,
        checkpoint: checkpointController,
        reconcileCreatedPage,
        localizedPageMap: indices.localizedPageMap,
        maxBlocksPerAppend:
          options.maxBlocksPerAppend ?? config.maxBlocksPerAppend ?? 100,
        dryRun,
        logger,
        fetchImpl: options.fetchImpl,
        retryOptions: options.retryOptions,
        onTargetPageCreated: async (targetPage) => {
          createdOrResumedTargetPageId = targetPage.id
          checkpointController.setTargetPageId(targetPage.id)
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

    // Step 12: Update source page with final workflow status and report summary
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

    // Step 13: Clean up completed local checkpoint file
    checkpointController.remove()

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

    logger.error(
      `Translation job failed for "${sourceMeta.title}" (${sourceMeta.id}): ${errorDetail}`
    )
    checkpointController.setJobState('failed', errorDetail)

    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      {
        translationStatus: TRANSLATION_STATUS.FAILED,
        ...(createdOrResumedTargetPageId
          ? { translationTargetPageId: createdOrResumedTargetPageId }
          : {}),
        translationError: `[Failed at ${failedAt}] ${errorDetail}`,
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
      error: errorDetail,
      dryRun,
    }
  }
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
