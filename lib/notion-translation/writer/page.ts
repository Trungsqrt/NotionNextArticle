import type {
  Client,
  CreatePageParameters,
  UpdatePageParameters,
} from '@notionhq/client'
import { withNotionRetry } from '../notion-client'
import { normalizeTreeNodes } from '../reader'
import type {
  LinkedResourceIssue,
  MissingMediaIssue,
  NotionBlockNode,
  NotionBlockTree,
  NotionPageLike,
  SyncedBlockIssue,
  UnsupportedBlockIssue,
  WorkerLogger,
  WriterResult,
  WriterStats,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import { appendTranslatedBlockTree } from './append'
import { resolvePageCoverForWrite, resolvePageIconForWrite } from './assets'
import { buildSingleBlockRequest } from './block-converter'
import type {
  BlockWriteContext,
  CreateTranslatedNotionPageOptions,
  CreatedTargetPage,
} from './types'

async function runDryRunPageWrite(params: {
  client?: Client
  rootNodes: readonly NotionBlockNode[]
  rawProperties: Record<string, unknown>
  options: CreateTranslatedNotionPageOptions
  stats: WriterStats
  missingMedia: MissingMediaIssue[]
  unsupportedBlocks: UnsupportedBlockIssue[]
  linkedResources: LinkedResourceIssue[]
  syncedBlocks: SyncedBlockIssue[]
  logger: WorkerLogger
}): Promise<WriterResult> {
  const {
    client,
    rootNodes,
    rawProperties,
    options,
    stats,
    missingMedia,
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
    logger,
  } = params

  const dryClient = {
    ...(client || {}),
    fileUploads: null,
  } as unknown as Client

  const dryContext: BlockWriteContext = {
    client: dryClient,
    missingMedia: [],
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
    localizedPageMap: options.localizedPageMap || new Map(),
    translatedDatabaseIds: options.translatedDatabaseIds || new Set(),
    maxBlocksPerAppend: options.maxBlocksPerAppend ?? 100,
    depth: 0,
    stats,
    logger,
    options,
  }

  for (const node of rootNodes) {
    const nodeType = String(node?.type || node?.raw?.type || '')
    if (
      nodeType === 'child_page' &&
      typeof options.onWriteChildPage === 'function'
    ) {
      const dryChild = await options.onWriteChildPage({
        sourceChildPageNode: node,
        sourceChildPageId: String(node.id || ''),
        targetParentPageId: 'dry-run-target-page-id',
        expectedStartIndex: stats.totalWrittenTopOrBatchBlocks,
        existingTargetBlock: null,
      })
      if (dryChild?.targetChildPageId) {
        linkedResources.push({
          id: String(node.id || ''),
          type: 'child_page',
          position: node.position || '0',
          title: dryChild.title || node.text || '',
          originalReferencedId: String(node.id || ''),
          resolvedTargetId: dryChild.targetChildPageId,
          usedLocalizedCounterpart: true,
        })
        stats.totalWrittenTopOrBatchBlocks += 1
      }
      continue
    }
    await buildSingleBlockRequest(node, dryContext)
  }

  return {
    targetPage: {
      id: 'dry-run-target-page-id',
      url: 'https://www.notion.so/dry-run-target-page-id',
      properties: rawProperties,
    },
    stats,
    missingMedia,
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
    dryRun: true,
  }
}

async function resumeOrCreateTargetPage(params: {
  client: Client
  rawProperties: Record<string, unknown>
  icon: Record<string, unknown> | undefined
  cover: Record<string, unknown> | undefined
  options: CreateTranslatedNotionPageOptions
  logger: WorkerLogger
}): Promise<CreatedTargetPage> {
  const { client, rawProperties, icon, cover, options, logger } = params
  const {
    dataSourceInfo,
    parentKind = 'database',
    parentTargetPageId = null,
    pagePropertiesPayload,
    reconcileCreatedPage,
    resumeTargetPageId = null,
    checkpoint = null,
  } = options

  let targetPage: CreatedTargetPage | null = null

  if (resumeTargetPageId) {
    if (
      checkpoint?.isPagePropertiesWritten?.(resumeTargetPageId) &&
      typeof client.pages?.retrieve === 'function'
    ) {
      try {
        const retrieved = await withNotionRetry(
          () => client.pages.retrieve({ page_id: resumeTargetPageId }),
          {
            isIdempotent: true,
            label: 'pages.retrieve(resumeTargetPage)',
            logger,
            ...options.retryOptions,
          }
        )
        targetPage = retrieved as unknown as CreatedTargetPage
      } catch {
        targetPage = null
      }
    }
    if (!targetPage) {
      const updated = await withNotionRetry(
        () =>
          client.pages.update({
            page_id: resumeTargetPageId,
            properties: rawProperties,
            ...(icon ? { icon } : {}),
            ...(cover ? { cover } : {}),
          } as unknown as UpdatePageParameters),
        {
          isIdempotent: true,
          label: 'pages.update(resumeTargetPage)',
          logger,
          ...options.retryOptions,
        }
      )
      targetPage = updated as unknown as CreatedTargetPage
      checkpoint?.markPagePropertiesWritten?.(
        targetPage?.id || resumeTargetPageId
      )
    }
  } else {
    const dataSourceId = dataSourceInfo?.dataSourceId
    const databaseId = dataSourceInfo?.databaseId
    const slugVal =
      pagePropertiesPayload &&
      typeof pagePropertiesPayload === 'object' &&
      'slug' in pagePropertiesPayload &&
      typeof pagePropertiesPayload.slug === 'string'
        ? pagePropertiesPayload.slug
        : ''

    // Checkpoint invariant: record pending create_page BEFORE calling Notion API
    checkpoint?.recordPendingOperation?.({
      type: 'create_page',
      slug: slugVal,
      startedAt: new Date().toISOString(),
    })

    try {
      const parentPayload =
        parentKind === 'page' && parentTargetPageId
          ? { type: 'page_id', page_id: parentTargetPageId }
          : dataSourceId
            ? { type: 'data_source_id', data_source_id: dataSourceId }
            : { type: 'database_id', database_id: databaseId! }

      const created = await withNotionRetry(
        () =>
          client.pages.create({
            parent: parentPayload,
            properties: rawProperties,
            ...(icon ? { icon } : {}),
            ...(cover ? { cover } : {}),
          } as unknown as CreatePageParameters),
        {
          isIdempotent: false,
          label:
            parentKind === 'page'
              ? `pages.create(page_id:${parentTargetPageId})`
              : 'pages.create(data_source_id)',
          logger,
          ...options.retryOptions,
        }
      )
      targetPage = created as unknown as CreatedTargetPage
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      if (typeof reconcileCreatedPage === 'function') {
        const reconciledPage = await reconcileCreatedPage().catch(() => null)
        if (reconciledPage?.id) {
          logger.warn(
            `Reconciled uncertain pages.create: target page ${reconciledPage.id} was already created in Notion despite error (${errMessage}).`
          )
          targetPage = reconciledPage as CreatedTargetPage
        }
      }

      if (
        !targetPage &&
        parentKind !== 'page' &&
        databaseId &&
        dataSourceId &&
        dataSourceId !== databaseId
      ) {
        try {
          const fallbackCreated = await withNotionRetry(
            () =>
              client.pages.create({
                parent: { type: 'database_id', database_id: databaseId },
                properties: rawProperties,
                ...(icon ? { icon } : {}),
                ...(cover ? { cover } : {}),
              } as unknown as CreatePageParameters),
            {
              isIdempotent: false,
              label: 'pages.create(database_id)',
              logger,
              ...options.retryOptions,
            }
          )
          targetPage = fallbackCreated as unknown as CreatedTargetPage
        } catch (fallbackErr) {
          if (typeof reconcileCreatedPage === 'function') {
            const reconciledPage = await reconcileCreatedPage().catch(
              () => null
            )
            if (reconciledPage?.id) {
              targetPage = reconciledPage as CreatedTargetPage
            }
          }
          if (!targetPage) throw fallbackErr
        }
      } else if (!targetPage) {
        throw err
      }
    }

    const createdId = (targetPage as CreatedTargetPage | null)?.id
    if (createdId) {
      checkpoint?.markPagePropertiesWritten?.(createdId)
    }
  }

  if (!targetPage?.id) {
    throw new Error('Notion pages.create did not return a valid page ID')
  }

  return targetPage
}

/**
 * Creates (or safely resumes an empty or partially written target page) in the Articles database
 * and writes all translated blocks recursively while respecting Notion API limits.
 */
export async function createTranslatedNotionPage(
  sourcePage: NotionPageLike,
  translatedTree: NotionBlockTree | NotionBlockNode[],
  options: CreateTranslatedNotionPageOptions = {}
): Promise<WriterResult> {
  const {
    client,
    pagePropertiesPayload,
    onTargetPageCreated,
    onWriteChildPage,
    resumeTargetPageId = null,
    isResuming = false,
    checkpoint = null,
    localizedPageMap = new Map(),
    translatedDatabaseIds = new Set(),
    maxBlocksPerAppend = 100,
    dryRun = false,
    logger = defaultLogger,
  } = options

  const rootNodes = normalizeTreeNodes(translatedTree)
  const missingMedia: MissingMediaIssue[] = []
  const unsupportedBlocks: UnsupportedBlockIssue[] = []
  const linkedResources: LinkedResourceIssue[] = []
  const syncedBlocks: SyncedBlockIssue[] = []

  const stats: WriterStats = {
    totalWrittenTopOrBatchBlocks: 0,
    totalRecreatedNestedBlocks: 0,
  }

  const rawProperties =
    pagePropertiesPayload &&
    typeof pagePropertiesPayload === 'object' &&
    'properties' in pagePropertiesPayload &&
    pagePropertiesPayload.properties &&
    typeof pagePropertiesPayload.properties === 'object'
      ? (pagePropertiesPayload.properties as Record<string, unknown>)
      : ((pagePropertiesPayload || {}) as Record<string, unknown>)

  if (dryRun) {
    return runDryRunPageWrite({
      client,
      rootNodes,
      rawProperties,
      options,
      stats,
      missingMedia,
      unsupportedBlocks,
      linkedResources,
      syncedBlocks,
      logger,
    })
  }

  if (!client) {
    throw new Error(
      'createTranslatedNotionPage requires a Notion client instance'
    )
  }

  // 1. Resolve Cover & Icon
  const { cover, issue: coverIssue } = await resolvePageCoverForWrite(
    client,
    sourcePage?.cover,
    options
  )
  if (coverIssue) missingMedia.push(coverIssue)

  const { icon, issue: iconIssue } = await resolvePageIconForWrite(
    client,
    sourcePage?.icon,
    options
  )
  if (iconIssue) missingMedia.push(iconIssue)

  // 2. Create target page (or reuse existing Draft page on safe empty/partial resume)
  const targetPage = await resumeOrCreateTargetPage({
    client,
    rawProperties,
    icon,
    cover,
    options,
    logger,
  })

  // 3. Immediately persist target page ID on the checkpoint and source page before writing blocks
  if (typeof onTargetPageCreated === 'function') {
    await onTargetPageCreated(targetPage)
  }

  // 4. Append all blocks recursively in safe batches with checkpoint reconciliation
  const writeContext: BlockWriteContext = {
    client,
    missingMedia,
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
    localizedPageMap,
    translatedDatabaseIds,
    onWriteChildPage,
    maxBlocksPerAppend,
    depth: 0,
    parentKey: 'root',
    initialExistingChildCount: 0,
    isResuming: Boolean(isResuming || resumeTargetPageId),
    checkpoint,
    stats,
    logger,
    retryOptions: options.retryOptions,
    options,
  }

  await appendTranslatedBlockTree(
    client,
    targetPage.id,
    rootNodes,
    writeContext
  )

  return {
    targetPage,
    stats,
    missingMedia,
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
    dryRun: false,
  }
}
