'use strict'

const crypto = require('node:crypto')
const { TRANSLATION_STATUS, getTranslationConfig } = require('./config')
const {
  createNotionClient,
  withNotionRetry,
  resolveArticlesDataSource,
  ensureTranslationSchema,
  queryAllPages,
  normalizeLocaleCode,
  normalizeNotionId,
  findPropertyKey,
  findTitlePropertyKey,
  getPropertyPlainText,
} = require('./notion-client')
const { readRawNotionTree } = require('./reader')
const { extractTranslationManifest } = require('./extractor')
const { translateManifest } = require('./translator')
const {
  buildTranslatedBlockTree,
  buildTranslatedPageProperties,
} = require('./builder')
const { createTranslatedNotionPage } = require('./writer')
const { validateTranslation, generateTranslationReport } = require('./validator')
const { defaultLogger } = require('../../worker/logger')

function extractPageWorkflowMeta(page, dataSourceInfo = null) {
  const props = page?.properties || {}
  const schemaProps = { ...(dataSourceInfo?.properties || {}), ...props }

  const titleKey = dataSourceInfo?.titlePropertyName || findTitlePropertyKey(schemaProps)
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
    title: (titleKey ? getPropertyPlainText(props[titleKey]) : '') || 'Untitled',
    slug: (slugKey ? getPropertyPlainText(props[slugKey]) : '').trim(),
    status: (statusKey ? getPropertyPlainText(props[statusKey]) : '').trim() || 'Published',
    locale,
    rawLocale: rawLocale.trim(),
    translationGroupId: (groupKey ? getPropertyPlainText(props[groupKey]) : '').trim(),
    translationStatus: (transStatusKey ? getPropertyPlainText(props[transStatusKey]) : '').trim(),
    translationError: (transErrorKey ? getPropertyPlainText(props[transErrorKey]) : '').trim(),
    translationTargetPageId: (transTargetIdKey ? getPropertyPlainText(props[transTargetIdKey]) : '').trim(),
    translationUpdatedAt:
      (transUpdatedAtKey ? getPropertyPlainText(props[transUpdatedAtKey]) : '').trim() ||
      page?.last_edited_time ||
      page?.created_time ||
      '',
  }
}

function formatTranslationStatusPropertyValue(schemaProps, pageProps, propKey, statusValue) {
  const propType = schemaProps?.[propKey]?.type || pageProps?.[propKey]?.type || 'select'
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

async function updateSourcePageWorkflowState(client, sourcePage, dataSourceInfo, updates = {}, options = {}) {
  const { dryRun = false, logger = defaultLogger } = options
  const pageId = typeof sourcePage === 'string' ? sourcePage : sourcePage?.id
  const pageProps = (typeof sourcePage === 'object' ? sourcePage?.properties : null) || {}
  const schemaProps = { ...(dataSourceInfo?.properties || {}), ...pageProps }

  const properties = {}

  if (updates.translationStatus !== undefined) {
    const key =
      findPropertyKey(schemaProps, ['Translation Status', 'TranslationStatus']) ||
      'Translation Status'
    properties[key] = formatTranslationStatusPropertyValue(
      dataSourceInfo?.properties,
      pageProps,
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
      findPropertyKey(schemaProps, ['Translation Target Page ID', 'TranslationTargetPageId']) ||
      'Translation Target Page ID'
    const text = String(updates.translationTargetPageId || '').trim()
    properties[key] = {
      rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
    }
  }

  if (updates.translationUpdatedAt !== undefined) {
    const key =
      findPropertyKey(schemaProps, ['Translation Updated At', 'TranslationUpdatedAt']) ||
      'Translation Updated At'
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
    logger.info(`[Dry Run] Would update page ${pageId} workflow properties:`, updates)
    return { id: pageId, properties, dryRun: true }
  }

  return withNotionRetry(
    () =>
      client.pages.update({
        page_id: pageId,
        properties,
      }),
    {
      isIdempotent: true,
      label: `pages.update(${pageId})`,
      logger,
      ...options.retryOptions,
    }
  )
}

/**
 * Builds helper lookup indices from all pages in the Articles database:
 * - `existingSlugs`: Set of all existing slugs
 * - `localizedPageMap`: Map<normalizedEnglishPageId, localizedTargetPageMeta>
 * - `pagesByGroupAndLocale`: Map<normalizedGroupId, Map<locale, page[]>>
 */
function buildDatabasePageIndices(allPages, dataSourceInfo, targetLocale = 'vi') {
  const existingSlugs = new Set()
  const pagesByGroupAndLocale = new Map()
  const metaByPageId = new Map()

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
      const byLocale = pagesByGroupAndLocale.get(groupKey)
      if (!byLocale.has(meta.locale)) {
        byLocale.set(meta.locale, [])
      }
      byLocale.get(meta.locale).push({ page, meta })
    }
  }

  // Map English page ID -> its existing targetLocale counterpart (if any) for child_page link resolution
  const localizedPageMap = new Map()
  for (const [, byLocale] of pagesByGroupAndLocale.entries()) {
    const enList = byLocale.get('en') || []
    const targetList = byLocale.get(targetLocale) || []
    if (enList.length > 0 && targetList.length === 1) {
      const targetMeta = targetList[0].meta
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

/**
 * Checks whether a Vietnamese translation page already exists for the source page
 * (either via Translation Group ID match in the database or via Translation Target Page ID).
 *
 * Returns:
 * - `{ action: 'create_new' }` when no target page exists
 * - `{ action: 'resume_empty', targetPageId, existingPage }` when a previous failed attempt created an empty page (0 blocks)
 * - `{ action: 'duplicate_exists', existingPages, reason }` when a populated target page already exists
 */
async function inspectExistingTranslationState(
  client,
  sourceMeta,
  translationGroupId,
  indices,
  targetLocale = 'vi',
  options = {}
) {
  const sourceNormId = normalizeNotionId(sourceMeta.id)
  const groupKey = String(translationGroupId || '').trim().toLowerCase()
  const candidatesMap = new Map()

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

  // 2. Also check explicit Translation Target Page ID on the source page if set
  if (sourceMeta.translationTargetPageId) {
    const targetId = sourceMeta.translationTargetPageId.trim()
    const targetNormId = normalizeNotionId(targetId)
    if (targetNormId && targetNormId !== sourceNormId && !candidatesMap.has(targetNormId)) {
      const known = indices?.metaByPageId?.get(targetNormId)
      if (known) {
        candidatesMap.set(targetNormId, known)
      } else if (typeof client?.pages?.retrieve === 'function') {
        try {
          const retrieved = await withNotionRetry(
            () => client.pages.retrieve({ page_id: targetId }),
            { isIdempotent: true, label: `pages.retrieve(${targetId})`, ...options }
          )
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
    return { action: 'create_new' }
  }

  // If multiple target pages already exist for this group, never touch them — mark Needs Review
  if (candidateList.length > 1) {
    const summary = candidateList
      .map(c => `"${c.meta.title}" (id: ${c.meta.id}, slug: ${c.meta.slug}, status: ${c.meta.status})`)
      .join(', ')
    return {
      action: 'duplicate_exists',
      existingPages: candidateList,
      primaryPage: candidateList[0],
      reason: `Multiple (${candidateList.length}) ${targetLocale.toUpperCase()} pages already exist for Translation Group ID "${translationGroupId}": ${summary}`,
    }
  }

  // Exactly 1 existing page found: inspect whether it is an empty shell from a previously interrupted job
  const single = candidateList[0]
  const matchesRecordedTarget =
    sourceMeta.translationTargetPageId &&
    normalizeNotionId(sourceMeta.translationTargetPageId) === normalizeNotionId(single.meta.id)

  let existingBlocks = []
  try {
    existingBlocks = await readRawNotionTree(single.meta.id, {
      client,
      config: options.config,
      logger: options.logger,
      retryOptions: options.retryOptions,
    })
  } catch {
    // If we cannot read blocks, treat as existing page to avoid duplicate creation
    return {
      action: 'duplicate_exists',
      existingPages: [single],
      primaryPage: single,
      reason: `Existing ${targetLocale.toUpperCase()} page found: "${single.meta.title}" (id: ${single.meta.id}, slug: ${single.meta.slug}, status: ${single.meta.status}).`,
    }
  }

  // Safe resume: if a previous run created the page shell and recorded Translation Target Page ID
  // (or matching Translation Group ID with Draft status) but crashed before writing any blocks (0 blocks)
  if (
    existingBlocks.length === 0 &&
    (matchesRecordedTarget || single.meta.status.toLowerCase() === 'draft') &&
    options.allowResumeEmptyShell !== false
  ) {
    return {
      action: 'resume_empty',
      targetPageId: single.meta.id,
      existingPage: single,
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

/**
 * Executes the end-to-end translation workflow for a single English source page.
 */
async function processTranslationJob(sourcePage, options = {}) {
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

  // 1. Only process English source pages (missing Locale defaults to 'en')
  if (sourceMeta.locale !== (config.sourceLocale || 'en')) {
    logger.info(`Skipping non-English page "${sourceMeta.title}" (${sourceMeta.id}) with locale="${sourceMeta.locale}"`)
    return {
      status: 'skipped_locale',
      sourcePageId: sourceMeta.id,
      locale: sourceMeta.locale,
    }
  }

  // 2. Fetch all database pages (published + draft) for duplicate protection and slug collision checks
  const allDatabasePages =
    options.allDatabasePages ||
    (await queryAllPages(client, dataSourceInfo, {}, { logger, retryOptions: options.retryOptions }))

  const indices = buildDatabasePageIndices(allDatabasePages, dataSourceInfo, targetLocale)

  // 3. Ensure source page has a Translation Group ID
  let translationGroupId = sourceMeta.translationGroupId
  if (!translationGroupId) {
    translationGroupId = options.generateUuid ? options.generateUuid() : crypto.randomUUID()
    logger.info(`Generated new Translation Group ID "${translationGroupId}" for source page "${sourceMeta.title}" (${sourceMeta.id})`)
    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      { translationGroupId },
      { dryRun, logger, retryOptions: options.retryOptions }
    )
  }

  // 4. Idempotency & Duplicate Protection check BEFORE creating any page
  const existingCheck = await inspectExistingTranslationState(
    client,
    sourceMeta,
    translationGroupId,
    indices,
    targetLocale,
    {
      config,
      dataSourceInfo,
      logger,
      retryOptions: options.retryOptions,
      allowResumeEmptyShell: options.allowResumeEmptyShell,
    }
  )

  if (existingCheck.action === 'duplicate_exists') {
    const existingId = existingCheck.primaryPage?.meta?.id || sourceMeta.translationTargetPageId || ''
    logger.warn(`Duplicate protection triggered for "${sourceMeta.title}" (${sourceMeta.id}): ${existingCheck.reason}`)

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

  let createdOrResumedTargetPageId = existingCheck.action === 'resume_empty' ? existingCheck.targetPageId : null

  try {
    // 5. Mark source page as Processing
    await updateSourcePageWorkflowState(
      client,
      sourcePage,
      dataSourceInfo,
      {
        translationStatus: TRANSLATION_STATUS.PROCESSING,
        translationError: '',
        translationUpdatedAt: new Date().toISOString(),
      },
      { dryRun, logger, retryOptions: options.retryOptions }
    )

    // 6. Read raw Notion block tree recursively
    logger.info(`Reading raw Notion block tree for "${sourceMeta.title}" (${sourceMeta.id})...`)
    const sourceTree = await readRawNotionTree(sourceMeta.id, {
      client,
      config,
      logger,
      retryOptions: options.retryOptions,
    })

    // 7. Extract translatable text manifest
    const manifest = extractTranslationManifest(sourceTree, {
      sourcePage,
      articleTitle: sourceMeta.title,
    })

    logger.info(`Extracted translation manifest for "${sourceMeta.title}"`, {
      totalSourceBlocks: manifest.stats.totalSourceBlocks,
      totalTranslatableFields: manifest.stats.totalTranslatableFields,
      unsupportedBlocks: manifest.stats.unsupportedBlockCount,
    })

    // 8. Translate manifest via AI provider adapter
    const translationResult = await translateManifest(manifest, targetLocale, {
      config,
      logger,
      aiAdapter: options.aiAdapter,
      fetchImpl: options.fetchImpl,
      batchSize: options.batchSize ?? config.batchSize,
      maxBatchChars: options.maxBatchChars ?? config.maxBatchChars,
      concurrency: options.concurrency ?? config.concurrency,
      maxRetries: options.maxAiRetries ?? 3,
      sleepFn: options.sleepFn,
    })

    // 9. Reconstruct translated block tree & target page properties (Status = Draft, Locale = vi)
    const translatedTree = buildTranslatedBlockTree(sourceTree, translationResult, {
      sourcePageId: sourceMeta.id,
    })

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

    // 10. Create (or resume) target Vietnamese page and write all blocks in batches
    const writeResult = await createTranslatedNotionPage(sourcePage, translatedTree, {
      client,
      dataSourceInfo,
      pagePropertiesPayload,
      resumeTargetPageId: createdOrResumedTargetPageId,
      localizedPageMap: indices.localizedPageMap,
      maxBlocksPerAppend: options.maxBlocksPerAppend ?? config.maxBlocksPerAppend ?? 100,
      dryRun,
      logger,
      fetchImpl: options.fetchImpl,
      retryOptions: options.retryOptions,
      onTargetPageCreated: async (targetPage) => {
        createdOrResumedTargetPageId = targetPage.id
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
    })

    const targetPage = writeResult.targetPage
    createdOrResumedTargetPageId = targetPage?.id || createdOrResumedTargetPageId

    // 11. Verify the generated structure after writing
    let writtenTargetTree = translatedTree
    if (!dryRun && targetPage?.id) {
      try {
        writtenTargetTree = await readRawNotionTree(targetPage.id, {
          client,
          config,
          logger,
          retryOptions: options.retryOptions,
        })
      } catch (verifyReadErr) {
        logger.warn(`Could not re-read target page ${targetPage.id} for post-write tree verification; validating built tree`, {
          error: verifyReadErr.message,
        })
      }
    }

    const validation = validateTranslation(sourceTree, writtenTargetTree, {
      unsupportedBlocks: writeResult.unsupportedBlocks,
      missingMedia: writeResult.missingMedia,
      linkedResources: writeResult.linkedResources,
      syncedBlocks: writeResult.syncedBlocks,
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
      totalRecreatedNestedBlocks: writeResult.stats.totalRecreatedNestedBlocks || manifest.stats.totalNestedBlocks,
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

    // If target page needs review, also update target page's Translation Status property if present
    if (!dryRun && finalTranslationStatus === TRANSLATION_STATUS.NEEDS_REVIEW && targetPage?.id) {
      await updateSourcePageWorkflowState(
        client,
        targetPage,
        dataSourceInfo,
        {
          translationStatus: TRANSLATION_STATUS.NEEDS_REVIEW,
          translationUpdatedAt: completedAt,
        },
        { dryRun, logger, retryOptions: options.retryOptions }
      ).catch(() => {})
    }

    // 12. Update source page with final workflow status and report summary
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

    logger.info(`Completed translation job for "${sourceMeta.title}" -> status="${finalTranslationStatus}"`, {
      sourcePageId: sourceMeta.id,
      targetPageId: targetPage?.id,
      slug: pagePropertiesPayload.slug,
    })

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
      validation,
      report,
      dryRun,
    }
  } catch (err) {
    const failedAt = new Date().toISOString()
    const errorDetail = err?.message || String(err)
    logger.error(`Translation job failed for "${sourceMeta.title}" (${sourceMeta.id}): ${errorDetail}`)

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
    ).catch(updateErr => {
      logger.error(`Could not record Failed status on source page ${sourceMeta.id}`, {
        error: updateErr?.message,
      })
    })

    return {
      status: TRANSLATION_STATUS.FAILED,
      sourcePageId: sourceMeta.id,
      targetPageId: createdOrResumedTargetPageId || sourceMeta.translationTargetPageId || '',
      error: errorDetail,
      dryRun,
    }
  }
}

/**
 * Detects and safely recovers any source pages stuck in `Translation Status = Processing`
 * for longer than `config.staleTimeoutMs` (default 30 minutes).
 * Never blindly resets or creates duplicate pages.
 */
async function recoverStaleProcessingPages(allDatabasePages, options = {}) {
  const config = options.config || getTranslationConfig()
  const logger = options.logger || defaultLogger
  const client = options.client || createNotionClient(config)
  const dataSourceInfo = options.dataSourceInfo
  const dryRun = Boolean(options.dryRun ?? config.dryRun)
  const targetLocale = options.targetLocale || config.targetLocale || 'vi'
  const staleTimeoutMs = options.staleTimeoutMs ?? config.staleTimeoutMs ?? 30 * 60 * 1000
  const nowMs = options.nowMs ?? Date.now()

  const indices = buildDatabasePageIndices(allDatabasePages, dataSourceInfo, targetLocale)
  const recovered = []

  for (const page of allDatabasePages || []) {
    if (!page || page.in_trash || page.archived) continue
    const meta = extractPageWorkflowMeta(page, dataSourceInfo)
    if (meta.locale !== (config.sourceLocale || 'en')) continue
    if (meta.translationStatus !== TRANSLATION_STATUS.PROCESSING) continue

    const updatedMs = meta.translationUpdatedAt ? Date.parse(meta.translationUpdatedAt) : NaN
    const ageMs = Number.isNaN(updatedMs) ? staleTimeoutMs + 1 : nowMs - updatedMs

    if (ageMs <= staleTimeoutMs) continue

    logger.warn(`Detected stale Processing page "${meta.title}" (${meta.id}), age=${Math.round(ageMs / 1000)}s`)

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
      }
    )

    if (existingState.action === 'duplicate_exists') {
      // A populated target page already exists! Check if it matches source structure or is partial.
      const existingPage = existingState.primaryPage
      let finalStatus = TRANSLATION_STATUS.NEEDS_REVIEW
      let message = `[Stale Job Recovered] Existing ${targetLocale.toUpperCase()} page found (${existingPage.meta.id}). Please review before publishing.`

      if (existingState.existingTree) {
        try {
          const sourceTree = await readRawNotionTree(meta.id, {
            client,
            config,
            logger,
            retryOptions: options.retryOptions,
          })
          const validation = validateTranslation(sourceTree, existingState.existingTree)
          if (validation.valid && !validation.needsReview) {
            finalStatus = TRANSLATION_STATUS.DRAFT_READY
            message = ''
          } else {
            finalStatus = TRANSLATION_STATUS.NEEDS_REVIEW
            message =
              `[Stale Job Recovered - Needs Review] Target page ${existingPage.meta.id} exists ` +
              `(blocks: ${existingState.existingTree.totalBlocks ?? existingState.existingTree.length} vs source ${sourceTree.totalBlocks ?? sourceTree.length}). ` +
              (validation.validationErrors.join('; ') || validation.warnings.join('; '))
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
      // Either no target page was created yet, or only an empty shell (0 blocks) exists -> safe to resume!
      const jobResult = await processTranslationJob(page, {
        ...options,
        client,
        config,
        dataSourceInfo,
        allDatabasePages,
      })
      recovered.push({
        sourcePageId: meta.id,
        action: existingState.action === 'resume_empty' ? 'resumed_empty_shell' : 'reprocessed',
        status: jobResult.status,
        targetPageId: jobResult.targetPageId,
      })
    }
  }

  return recovered
}

module.exports = {
  extractPageWorkflowMeta,
  updateSourcePageWorkflowState,
  buildDatabasePageIndices,
  inspectExistingTranslationState,
  processTranslationJob,
  recoverStaleProcessingPages,
}

