import type { Client } from '@notionhq/client'
import {
  extractDatabaseTitle,
  findPropertyKey,
  findTitlePropertyKey,
  getPropertyPlainText,
  normalizeLocaleCode,
  normalizeNotionId,
  queryAllPages,
  resolveDatabaseById,
  withNotionRetry,
  type NotionOperationOptions,
} from './notion-client'
import { normalizeTreeNodes, readRawNotionTree } from './reader'
import type { TranslationConfig } from './config'
import type {
  ArticlesDataSourceInfo,
  DatabasePageIndices,
  DiscoveredContentGraph,
  DiscoveredDatabaseNode,
  DiscoveredPageNode,
  DiscoveredPageParentKind,
  DiscoveredReference,
  IndexedDatabasePage,
  NotionBlockNode,
  NotionPageLike,
  PageWorkflowMeta,
} from './types'
import { defaultLogger } from '../../worker/logger'

export function extractPageWorkflowMeta(
  page: NotionPageLike,
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null = null,
  defaultSourceLocale = 'en'
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
  const localeKey = findPropertyKey(schemaProps, ['Locale', 'locale'])
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
  const transTargetKey = findPropertyKey(schemaProps, [
    'Translation Target Page ID',
    'TranslationTargetPageId',
  ])
  const transUpdatedKey = findPropertyKey(schemaProps, [
    'Translation Updated At',
    'TranslationUpdatedAt',
  ])

  const rawLocale = localeKey
    ? getPropertyPlainText(props[localeKey]).trim()
    : ''
  const locale = normalizeLocaleCode(rawLocale, defaultSourceLocale)

  return {
    id: page?.id || '',
    url: page?.url || '',
    inTrash: Boolean(page?.in_trash || page?.archived),
    title: titleKey ? getPropertyPlainText(props[titleKey]).trim() : '',
    slug: slugKey ? getPropertyPlainText(props[slugKey]).trim() : '',
    status: statusKey ? getPropertyPlainText(props[statusKey]).trim() : '',
    locale,
    rawLocale,
    translationGroupId: groupKey
      ? getPropertyPlainText(props[groupKey]).trim()
      : '',
    translationStatus: transStatusKey
      ? getPropertyPlainText(props[transStatusKey]).trim()
      : '',
    translationError: transErrorKey
      ? getPropertyPlainText(props[transErrorKey]).trim()
      : '',
    translationTargetPageId: transTargetKey
      ? getPropertyPlainText(props[transTargetKey]).trim()
      : '',
    translationUpdatedAt: transUpdatedKey
      ? getPropertyPlainText(props[transUpdatedKey]).trim()
      : '',
  }
}

export function buildDatabaseIndices(
  allPages: NotionPageLike[],
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null = null,
  sourceLocale = 'en',
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
    const meta = extractPageWorkflowMeta(page, dataSourceInfo, sourceLocale)
    metaByPageId.set(normalizeNotionId(page.id), { page, meta })

    if (meta.slug) {
      existingSlugs.add(meta.slug.toLowerCase())
    }
    if (meta.translationGroupId) {
      if (!pagesByGroupAndLocale.has(meta.translationGroupId)) {
        pagesByGroupAndLocale.set(meta.translationGroupId, new Map())
      }
      const byLocale = pagesByGroupAndLocale.get(meta.translationGroupId)!
      const list = byLocale.get(meta.locale) || []
      list.push({ page, meta })
      byLocale.set(meta.locale, list)
    }
  }

  const localizedPageMap = new Map<string, PageWorkflowMeta>()
  for (const [, byLocale] of pagesByGroupAndLocale.entries()) {
    const srcEntries = byLocale.get(sourceLocale) || []
    const tgtEntries = byLocale.get(targetLocale) || []
    if (srcEntries.length > 0 && tgtEntries.length > 0) {
      const targetMeta = tgtEntries[0].meta
      for (const src of srcEntries) {
        localizedPageMap.set(normalizeNotionId(src.page.id), targetMeta)
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

export function extractParentRelationIds(
  page: NotionPageLike,
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null = null
): string[] {
  const props = (page?.properties || {}) as Record<
    string,
    Record<string, unknown>
  >
  const schemaProps = { ...(dataSourceInfo?.properties || {}), ...props }
  const parentKey = findPropertyKey(schemaProps, [
    'Parent Course',
    'Parent',
    'parent',
    'Parent Item',
    'Course',
  ])
  if (!parentKey || !props[parentKey]) return []
  const prop = props[parentKey]
  if (prop.type === 'relation' && Array.isArray(prop.relation)) {
    return (prop.relation as Array<{ id?: string }>)
      .map((r) => String(r?.id || '').trim())
      .filter(Boolean)
  }
  return []
}

function scanRichTextReferences(params: {
  richTextArray: unknown
  sourcePageId: string
  blockId: string
  position: string
  outReferences: DiscoveredReference[]
}): void {
  const { richTextArray, sourcePageId, blockId, position, outReferences } =
    params
  if (!Array.isArray(richTextArray)) return

  for (const rawItem of richTextArray) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>

    if (item.type === 'mention' && item.mention && typeof item.mention === 'object') {
      const mention = item.mention as {
        type?: string
        page?: { id?: string }
        database?: { id?: string }
      }
      if (mention.type === 'page' && mention.page?.id) {
        outReferences.push({
          sourcePageId,
          blockId,
          position,
          referenceKind: 'mention_page',
          targetKind: 'page',
          targetIdOrSlug: mention.page.id,
        })
      } else if (mention.type === 'database' && mention.database?.id) {
        outReferences.push({
          sourcePageId,
          blockId,
          position,
          referenceKind: 'mention_page',
          targetKind: 'database',
          targetIdOrSlug: mention.database.id,
        })
      }
    }

    const textObj = item.text as { link?: { url?: string } | null } | undefined
    const rawHref =
      textObj?.link?.url || (typeof item.href === 'string' ? item.href : '')
    if (!rawHref) continue

    const trimmed = rawHref.trim()
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      const slugPart = trimmed.split('#')[0].replace(/^\/+|\/+$/g, '').trim()
      if (slugPart) {
        outReferences.push({
          sourcePageId,
          blockId,
          position,
          referenceKind: 'internal_url',
          targetKind: 'slug',
          targetIdOrSlug: slugPart,
          rawHref: trimmed,
        })
      }
      continue
    }

    const notionMatch = trimmed.match(
      /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    )
    if (
      notionMatch &&
      (trimmed.includes('notion.so/') || trimmed.includes('notion.site/'))
    ) {
      outReferences.push({
        sourcePageId,
        blockId,
        position,
        referenceKind: 'internal_url',
        targetKind: 'page',
        targetIdOrSlug: notionMatch[1],
        rawHref: trimmed,
      })
    }
  }
}

function scanTreeForNestedResources(
  nodes: NotionBlockNode[],
  sourcePageId: string,
  outChildPageBlocks: Array<{ id: string; title: string; position: string }>,
  outChildDatabaseBlocks: Array<{ id: string; title: string; position: string }>,
  outReferences: DiscoveredReference[]
): void {
  for (const node of nodes) {
    if (!node) continue
    const raw = (node.raw || node) as Record<string, unknown>
    const blockType = String(node.type || raw.type || '')
    const blockId = String(node.id || raw.id || '')
    const position = String(node.position || '0')
    const payload = (raw[blockType] || {}) as Record<string, unknown>

    if (blockType === 'child_page' && blockId) {
      outChildPageBlocks.push({
        id: blockId,
        title: String(payload.title || node.text || 'Untitled'),
        position,
      })
    } else if (blockType === 'child_database' && blockId) {
      outChildDatabaseBlocks.push({
        id: blockId,
        title: String(payload.title || node.text || 'Nested Database'),
        position,
      })
    } else if (blockType === 'link_to_page') {
      const refPageId =
        typeof payload.page_id === 'string' ? payload.page_id : ''
      const refDbId =
        typeof payload.database_id === 'string' ? payload.database_id : ''
      if (refPageId) {
        outReferences.push({
          sourcePageId,
          blockId,
          position,
          referenceKind: 'link_to_page',
          targetKind: 'page',
          targetIdOrSlug: refPageId,
        })
      } else if (refDbId) {
        outReferences.push({
          sourcePageId,
          blockId,
          position,
          referenceKind: 'link_to_page',
          targetKind: 'database',
          targetIdOrSlug: refDbId,
        })
      }
    }

    if (Array.isArray(payload.rich_text)) {
      scanRichTextReferences({
        richTextArray: payload.rich_text,
        sourcePageId,
        blockId,
        position,
        outReferences,
      })
    }
    if (Array.isArray(payload.caption)) {
      scanRichTextReferences({
        richTextArray: payload.caption,
        sourcePageId,
        blockId,
        position,
        outReferences,
      })
    }
    if (blockType === 'table_row' && Array.isArray(payload.cells)) {
      for (const cell of payload.cells) {
        scanRichTextReferences({
          richTextArray: cell,
          sourcePageId,
          blockId,
          position,
          outReferences,
        })
      }
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      scanTreeForNestedResources(
        node.children,
        sourcePageId,
        outChildPageBlocks,
        outChildDatabaseBlocks,
        outReferences
      )
    }
  }
}

export interface DiscoverContentHierarchyOptions extends NotionOperationOptions {
  rootDataSourceInfo: ArticlesDataSourceInfo
  rootAllPages?: NotionPageLike[]
  config?: Partial<TranslationConfig>
}

/**
 * Recursively discovers the root English Notion page, all its blocks, nested child pages,
 * nested databases (`child_database`), English items inside nested databases, and same-database
 * child items linked via `parent` relations.
 * Prevents infinite recursion by tracking visited pages and databases.
 */
export async function discoverContentHierarchy(
  client: Client,
  rootSourcePageOrId: NotionPageLike | string,
  options: DiscoverContentHierarchyOptions
): Promise<DiscoveredContentGraph> {
  const logger = options.logger || defaultLogger
  const config = options.config || {}
  const sourceLocale = normalizeLocaleCode(config.sourceLocale || 'en', 'en')
  const targetLocale = normalizeLocaleCode(config.targetLocale || 'vi', 'vi')
  const rootDataSourceInfo = options.rootDataSourceInfo

  const pagesById = new Map<string, DiscoveredPageNode>()
  const databasesById = new Map<string, DiscoveredDatabaseNode>()
  const orderedPageIds: string[] = []
  const allReferences: DiscoveredReference[] = []

  const visitedPageIds = new Set<string>()
  const visitedDatabaseIds = new Set<string>()

  // 1. Register root database and its pages
  const rootDbNormId = normalizeNotionId(rootDataSourceInfo.databaseId)
  const rootAllPages =
    options.rootAllPages ||
    (await queryAllPages(client, rootDataSourceInfo, {}, options))
  const rootIndices = buildDatabaseIndices(
    rootAllPages,
    rootDataSourceInfo,
    sourceLocale,
    targetLocale
  )
  const rootEnglishPageIds = rootAllPages
    .filter((p) => !p.in_trash && !p.archived)
    .filter(
      (p) =>
        extractPageWorkflowMeta(p, rootDataSourceInfo, sourceLocale).locale ===
        sourceLocale
    )
    .map((p) => p.id)

  const rootDbNode: DiscoveredDatabaseNode = {
    databaseId: rootDataSourceInfo.databaseId,
    dataSourceInfo: rootDataSourceInfo,
    parentPageId: null,
    sourceBlockId: null,
    title: extractDatabaseTitle(
      rootDataSourceInfo.rawDatabase,
      rootDataSourceInfo.rawDataSource,
      'ServiceNow Wiki'
    ),
    isRootDatabase: true,
    allPages: rootAllPages,
    englishPageIds: rootEnglishPageIds,
    indices: rootIndices,
  }
  databasesById.set(rootDbNormId, rootDbNode)
  visitedDatabaseIds.add(rootDbNormId)

  // 2. Resolve root source page object
  let rootPage: NotionPageLike
  if (typeof rootSourcePageOrId === 'string') {
    const cachedInRoot = rootIndices.metaByPageId.get(
      normalizeNotionId(rootSourcePageOrId)
    )
    if (cachedInRoot) {
      rootPage = cachedInRoot.page
    } else {
      rootPage = (await withNotionRetry(
        () => client.pages.retrieve({ page_id: rootSourcePageOrId }),
        {
          isIdempotent: true,
          label: `pages.retrieve(${rootSourcePageOrId})`,
          logger,
          ...options.retryOptions,
        }
      )) as NotionPageLike
    }
  } else {
    rootPage = rootSourcePageOrId
  }

  async function ensureDatabaseDiscovered(
    databaseId: string,
    parentPageId: string | null,
    sourceBlockId: string | null,
    fallbackTitle = 'Nested Database'
  ): Promise<DiscoveredDatabaseNode> {
    const normDbId = normalizeNotionId(databaseId)
    if (databasesById.has(normDbId)) {
      return databasesById.get(normDbId)!
    }

    const dsInfo = await resolveDatabaseById(client, databaseId, options)
    const resolvedNormId = normalizeNotionId(dsInfo.databaseId || databaseId)
    if (databasesById.has(resolvedNormId)) {
      return databasesById.get(resolvedNormId)!
    }

    const dbPages = await queryAllPages(client, dsInfo, {}, options)
    const indices = buildDatabaseIndices(
      dbPages,
      dsInfo,
      sourceLocale,
      targetLocale
    )
    const englishPageIds: string[] = []
    for (const p of dbPages) {
      if (!p || p.in_trash || p.archived) continue
      const meta = extractPageWorkflowMeta(p, dsInfo, sourceLocale)
      if (meta.locale === sourceLocale) {
        englishPageIds.push(p.id)
      }
    }

    const dbNode: DiscoveredDatabaseNode = {
      databaseId: dsInfo.databaseId || databaseId,
      dataSourceInfo: dsInfo,
      parentPageId,
      sourceBlockId,
      title: extractDatabaseTitle(
        dsInfo.rawDatabase,
        dsInfo.rawDataSource,
        fallbackTitle
      ),
      isRootDatabase: false,
      allPages: dbPages,
      englishPageIds,
      indices,
    }

    databasesById.set(normDbId, dbNode)
    databasesById.set(resolvedNormId, dbNode)
    return dbNode
  }

  async function discoverPageRecursive(params: {
    page: NotionPageLike
    parentKind: DiscoveredPageParentKind
    parentDatabaseNode: DiscoveredDatabaseNode | null
    parentPageId: string | null
    sourceChildPageBlockId: string | null
    depth: number
  }): Promise<void> {
    const {
      page,
      parentKind,
      parentDatabaseNode,
      parentPageId,
      sourceChildPageBlockId,
      depth,
    } = params

    const normPageId = normalizeNotionId(page?.id)
    if (!normPageId || visitedPageIds.has(normPageId)) {
      return
    }
    visitedPageIds.add(normPageId)

    const dsInfo = parentDatabaseNode?.dataSourceInfo || null
    const meta = extractPageWorkflowMeta(page, dsInfo, sourceLocale)

    logger.debug('Discovering Notion page content hierarchy', {
      pageId: page.id,
      title: meta.title || 'Untitled',
      parentKind,
      depth,
    })

    const blockTree = await readRawNotionTree(client, page.id, {
      ...options,
      config,
    })
    const rootNodes = normalizeTreeNodes(blockTree)

    const childPageBlocks: Array<{
      id: string
      title: string
      position: string
    }> = []
    const childDatabaseBlocks: Array<{
      id: string
      title: string
      position: string
    }> = []
    const pageReferences: DiscoveredReference[] = []

    scanTreeForNestedResources(
      rootNodes,
      page.id,
      childPageBlocks,
      childDatabaseBlocks,
      pageReferences
    )

    // Check parent relation references on this page
    const parentRelationIds = extractParentRelationIds(page, dsInfo)
    for (const relId of parentRelationIds) {
      pageReferences.push({
        sourcePageId: page.id,
        blockId: 'page_properties',
        position: 'properties.parent',
        referenceKind: 'relation',
        targetKind: 'page',
        targetIdOrSlug: relId,
      })
    }

    // Check if any English pages in the same database have a `Parent` relation pointing to this page
    const relatedChildPages: NotionPageLike[] = []
    if (parentDatabaseNode) {
      for (const candidatePage of parentDatabaseNode.allPages) {
        if (!candidatePage || candidatePage.in_trash || candidatePage.archived) {
          continue
        }
        const candidateNormId = normalizeNotionId(candidatePage.id)
        if (
          candidateNormId === normPageId ||
          visitedPageIds.has(candidateNormId)
        ) {
          continue
        }
        const candidateMeta = extractPageWorkflowMeta(
          candidatePage,
          parentDatabaseNode.dataSourceInfo,
          sourceLocale
        )
        if (candidateMeta.locale !== sourceLocale) continue

        const candidateParentIds = extractParentRelationIds(
          candidatePage,
          parentDatabaseNode.dataSourceInfo
        ).map(normalizeNotionId)

        if (candidateParentIds.includes(normPageId)) {
          relatedChildPages.push(candidatePage)
        }
      }
    }

    const node: DiscoveredPageNode = {
      pageId: page.id,
      page,
      meta,
      parentKind,
      parentDatabaseId: parentDatabaseNode?.databaseId || null,
      parentDataSourceId:
        parentDatabaseNode?.dataSourceInfo.dataSourceId || null,
      parentPageId,
      sourceChildPageBlockId,
      depth,
      blockTree,
      childPageIds: childPageBlocks.map((b) => b.id),
      childDatabaseIds: childDatabaseBlocks.map((b) => b.id),
      relatedChildPageIds: relatedChildPages.map((p) => p.id),
      references: pageReferences,
    }

    pagesById.set(normPageId, node)
    orderedPageIds.push(page.id)
    allReferences.push(...pageReferences)

    // 3a. Recursively discover nested `child_page` blocks
    for (const childPageBlock of childPageBlocks) {
      const childNormId = normalizeNotionId(childPageBlock.id)
      if (visitedPageIds.has(childNormId)) continue

      let childPageObj: NotionPageLike = {
        id: childPageBlock.id,
        parent: { type: 'page_id', page_id: page.id },
        properties: {
          title: {
            type: 'title',
            title: [
              {
                type: 'text',
                plain_text: childPageBlock.title,
                text: { content: childPageBlock.title },
              },
            ],
          },
        },
      }

      if (typeof client.pages?.retrieve === 'function') {
        try {
          const retrieved = (await withNotionRetry(
            () => client.pages.retrieve({ page_id: childPageBlock.id }),
            {
              isIdempotent: true,
              label: `pages.retrieve(child_page:${childPageBlock.id})`,
              logger,
              ...options.retryOptions,
            }
          )) as NotionPageLike
          if (retrieved && retrieved.id) {
            childPageObj = retrieved
          }
        } catch {
          // Use synthesized child_page object from block title if pages.retrieve fails
        }
      }

      await discoverPageRecursive({
        page: childPageObj,
        parentKind: 'page',
        parentDatabaseNode: null,
        parentPageId: page.id,
        sourceChildPageBlockId: childPageBlock.id,
        depth: depth + 1,
      })
    }

    // 3b. Recursively discover nested `child_database` blocks and their English items
    for (const childDbBlock of childDatabaseBlocks) {
      const normChildDbId = normalizeNotionId(childDbBlock.id)
      if (visitedDatabaseIds.has(normChildDbId)) continue
      visitedDatabaseIds.add(normChildDbId)

      const nestedDbNode = await ensureDatabaseDiscovered(
        childDbBlock.id,
        page.id,
        childDbBlock.id,
        childDbBlock.title
      )

      logger.info('Discovered nested database inside page', {
        parentPageId: page.id,
        databaseId: nestedDbNode.databaseId,
        databaseTitle: nestedDbNode.title,
        totalRows: nestedDbNode.allPages.length,
        englishRows: nestedDbNode.englishPageIds.length,
      })

      for (const dbPage of nestedDbNode.allPages) {
        if (!dbPage || dbPage.in_trash || dbPage.archived) continue
        const rowMeta = extractPageWorkflowMeta(
          dbPage,
          nestedDbNode.dataSourceInfo,
          sourceLocale
        )
        if (rowMeta.locale !== sourceLocale) continue

        await discoverPageRecursive({
          page: dbPage,
          parentKind: 'database',
          parentDatabaseNode: nestedDbNode,
          parentPageId: page.id,
          sourceChildPageBlockId: null,
          depth: depth + 1,
        })
      }
    }

    // 3c. Recursively discover same-database child items linked via `Parent` relation
    for (const relatedChild of relatedChildPages) {
      await discoverPageRecursive({
        page: relatedChild,
        parentKind: 'database',
        parentDatabaseNode,
        parentPageId: page.id,
        sourceChildPageBlockId: null,
        depth: depth + 1,
      })
    }
  }

  // Determine if rootPage belongs to rootDbNode or another database or is a standalone page
  let initialParentDbNode: DiscoveredDatabaseNode | null = rootDbNode
  let initialParentKind: DiscoveredPageParentKind = 'database'
  let initialParentPageId: string | null = null

  if (rootPage.parent?.type === 'page_id' && rootPage.parent.page_id) {
    initialParentKind = 'page'
    initialParentDbNode = null
    initialParentPageId = rootPage.parent.page_id
  } else if (
    rootPage.parent?.database_id &&
    normalizeNotionId(rootPage.parent.database_id) !== rootDbNormId
  ) {
    initialParentDbNode = await ensureDatabaseDiscovered(
      rootPage.parent.database_id,
      null,
      null,
      'Parent Database'
    )
  }

  await discoverPageRecursive({
    page: rootPage,
    parentKind: initialParentKind,
    parentDatabaseNode: initialParentDbNode,
    parentPageId: initialParentPageId,
    sourceChildPageBlockId:
      initialParentKind === 'page' ? rootPage.id : null,
    depth: 0,
  })

  return {
    rootPageId: rootPage.id,
    rootDatabaseId: rootDataSourceInfo.databaseId,
    pagesById,
    databasesById,
    orderedPageIds,
    references: allReferences,
  }
}

