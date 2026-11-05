'use strict'

const {
  withNotionRetry,
  reuploadNotionAsset,
  listAllPages,
} = require('./notion-client')
const { toNotionRichTextRequest } = require('./builder')
const { normalizeTreeNodes, listAllRawBlockChildren } = require('./reader')
const { defaultLogger } = require('../../worker/logger')

const MAX_APPEND_BATCH_BYTES = 400 * 1024 // 400 KB safety ceiling per append request

function sanitizeIconForWrite(icon) {
  if (!icon || typeof icon !== 'object') return undefined
  if (icon.type === 'emoji' && icon.emoji) {
    return { type: 'emoji', emoji: icon.emoji }
  }
  if (icon.type === 'external' && icon.external?.url) {
    return { type: 'external', external: { url: icon.external.url } }
  }
  if (icon.type === 'custom_emoji' && icon.custom_emoji?.id) {
    return { type: 'custom_emoji', custom_emoji: { id: icon.custom_emoji.id } }
  }
  if (icon.type === 'icon' && icon.icon?.name) {
    return { type: 'icon', icon: icon.icon }
  }
  if (icon.type === 'file_upload' && icon.file_upload?.id) {
    return { type: 'file_upload', file_upload: { id: icon.file_upload.id } }
  }
  return undefined
}

async function resolvePageCoverForWrite(client, sourceCover, options = {}) {
  if (!sourceCover || typeof sourceCover !== 'object') return { cover: undefined, issue: null }
  if (sourceCover.type === 'external' && sourceCover.external?.url) {
    return {
      cover: { type: 'external', external: { url: sourceCover.external.url } },
      issue: null,
    }
  }
  if (sourceCover.type === 'file' && sourceCover.file?.url) {
    try {
      const uploaded = await reuploadNotionAsset(client, sourceCover.file.url, options)
      return {
        cover: { type: 'file_upload', file_upload: { id: uploaded.fileUploadId } },
        issue: null,
      }
    } catch (err) {
      return {
        cover: undefined,
        issue: {
          id: 'page_cover',
          type: 'cover',
          position: 'page.cover',
          reason: `Could not re-upload Notion-hosted cover image: ${err.message}`,
        },
      }
    }
  }
  return { cover: undefined, issue: null }
}

async function resolvePageIconForWrite(client, sourceIcon, options = {}) {
  if (!sourceIcon || typeof sourceIcon !== 'object') return { icon: undefined, issue: null }
  if (sourceIcon.type === 'file' && sourceIcon.file?.url) {
    try {
      const uploaded = await reuploadNotionAsset(client, sourceIcon.file.url, options)
      return {
        icon: { type: 'file_upload', file_upload: { id: uploaded.fileUploadId } },
        issue: null,
      }
    } catch (err) {
      return {
        icon: undefined,
        issue: {
          id: 'page_icon',
          type: 'icon',
          position: 'page.icon',
          reason: `Could not re-upload Notion-hosted icon: ${err.message}`,
        },
      }
    }
  }
  return { icon: sanitizeIconForWrite(sourceIcon), issue: null }
}

function buildTableRowBlockRequest(rowNode) {
  const raw = rowNode?.raw || rowNode
  const cells = raw?.table_row?.cells || []
  return {
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: cells.map(cell => toNotionRichTextRequest(cell)),
    },
  }
}

/**
 * Converts a single translated AST node into a Notion `BlockObjectRequest` payload
 * (without nested children, except where Notion API requires inline children like `table` and `column_list`).
 */
async function buildSingleBlockRequest(node, context) {
  const {
    client,
    missingMedia,
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
    localizedPageMap,
    options,
  } = context

  const raw = node.raw || node
  const type = node.type || raw.type || 'unsupported'
  const blockId = node.id || raw.id || `pos-${node.position || '0'}`
  const position = node.position || '0'
  const payload = raw[type] || {}

  // 1. Standard rich_text blocks
  if (
    type === 'paragraph' ||
    type === 'bulleted_list_item' ||
    type === 'numbered_list_item' ||
    type === 'quote' ||
    type === 'toggle'
  ) {
    const blockData = {
      rich_text: toNotionRichTextRequest(payload.rich_text || []),
      ...(payload.color ? { color: payload.color } : {}),
    }
    return {
      request: { object: 'block', type, [type]: blockData },
      deferredChildren: node.children || [],
    }
  }

  // 2. Headings (Notion API supports heading_1..heading_4; map heading_5/6 if needed)
  if (/^heading_[1-6]$/.test(type)) {
    const effectiveType = type === 'heading_5' || type === 'heading_6' ? 'heading_4' : type
    const blockData = {
      rich_text: toNotionRichTextRequest(payload.rich_text || []),
      ...(payload.color ? { color: payload.color } : {}),
      ...(typeof payload.is_toggleable === 'boolean' ? { is_toggleable: payload.is_toggleable } : {}),
    }
    return {
      request: { object: 'block', type: effectiveType, [effectiveType]: blockData },
      deferredChildren: node.children || [],
    }
  }

  // 3. To-do
  if (type === 'to_do') {
    const blockData = {
      rich_text: toNotionRichTextRequest(payload.rich_text || []),
      checked: Boolean(payload.checked),
      ...(payload.color ? { color: payload.color } : {}),
    }
    return {
      request: { object: 'block', type: 'to_do', to_do: blockData },
      deferredChildren: node.children || [],
    }
  }

  // 4. Callout
  if (type === 'callout') {
    const icon = sanitizeIconForWrite(payload.icon)
    const blockData = {
      rich_text: toNotionRichTextRequest(payload.rich_text || []),
      ...(payload.color ? { color: payload.color } : {}),
      ...(icon ? { icon } : {}),
    }
    return {
      request: { object: 'block', type: 'callout', callout: blockData },
      deferredChildren: node.children || [],
    }
  }

  // 5. Template
  if (type === 'template') {
    return {
      request: {
        object: 'block',
        type: 'template',
        template: {
          rich_text: toNotionRichTextRequest(payload.rich_text || []),
        },
      },
      deferredChildren: node.children || [],
    }
  }

  // 6. Code (never translated, preserved verbatim)
  if (type === 'code') {
    const blockData = {
      rich_text: toNotionRichTextRequest(payload.rich_text || []),
      language: payload.language || 'plain text',
      ...(Array.isArray(payload.caption) && payload.caption.length > 0
        ? { caption: toNotionRichTextRequest(payload.caption) }
        : {}),
    }
    return {
      request: { object: 'block', type: 'code', code: blockData },
      deferredChildren: [],
    }
  }

  // 7. Equation (never translated, preserved verbatim)
  if (type === 'equation') {
    return {
      request: {
        object: 'block',
        type: 'equation',
        equation: { expression: payload.expression || '' },
      },
      deferredChildren: [],
    }
  }

  // 8. Divider & Breadcrumb & Table of Contents
  if (type === 'divider') {
    return {
      request: { object: 'block', type: 'divider', divider: {} },
      deferredChildren: [],
    }
  }
  if (type === 'breadcrumb') {
    return {
      request: { object: 'block', type: 'breadcrumb', breadcrumb: {} },
      deferredChildren: [],
    }
  }
  if (type === 'table_of_contents') {
    return {
      request: {
        object: 'block',
        type: 'table_of_contents',
        table_of_contents: payload.color ? { color: payload.color } : {},
      },
      deferredChildren: [],
    }
  }

  // 9. Bookmark & Embed
  if (type === 'bookmark') {
    if (!payload.url) {
      missingMedia.push({
        id: blockId,
        type,
        position,
        reason: 'Bookmark block has no URL',
      })
      return { request: null, deferredChildren: [] }
    }
    return {
      request: {
        object: 'block',
        type: 'bookmark',
        bookmark: {
          url: payload.url,
          ...(Array.isArray(payload.caption)
            ? { caption: toNotionRichTextRequest(payload.caption) }
            : {}),
        },
      },
      deferredChildren: [],
    }
  }

  if (type === 'embed') {
    if (!payload.url) {
      missingMedia.push({
        id: blockId,
        type,
        position,
        reason: 'Embed block has no URL',
      })
      return { request: null, deferredChildren: [] }
    }
    return {
      request: {
        object: 'block',
        type: 'embed',
        embed: {
          url: payload.url,
          ...(Array.isArray(payload.caption)
            ? { caption: toNotionRichTextRequest(payload.caption) }
            : {}),
        },
      },
      deferredChildren: [],
    }
  }

  // 10. Media blocks: image, video, file, pdf, audio
  if (type === 'image' || type === 'video' || type === 'file' || type === 'pdf' || type === 'audio') {
    const caption = Array.isArray(payload.caption) ? toNotionRichTextRequest(payload.caption) : []
    const mediaType = payload.type || (payload.external ? 'external' : payload.file ? 'file' : payload.file_upload ? 'file_upload' : null)

    if (mediaType === 'external' && payload.external?.url) {
      const mediaObj = {
        type: 'external',
        external: { url: payload.external.url },
        ...(caption.length > 0 ? { caption } : {}),
        ...(type === 'file' && payload.name ? { name: payload.name } : {}),
      }
      return {
        request: { object: 'block', type, [type]: mediaObj },
        deferredChildren: [],
      }
    }

    if (mediaType === 'file_upload' && payload.file_upload?.id) {
      const mediaObj = {
        type: 'file_upload',
        file_upload: { id: payload.file_upload.id },
        ...(caption.length > 0 ? { caption } : {}),
        ...(type === 'file' && payload.name ? { name: payload.name } : {}),
      }
      return {
        request: { object: 'block', type, [type]: mediaObj },
        deferredChildren: [],
      }
    }

    if (mediaType === 'file' && payload.file?.url) {
      try {
        const uploaded = await reuploadNotionAsset(client, payload.file.url, {
          ...options,
          filename: payload.name,
        })
        const mediaObj = {
          type: 'file_upload',
          file_upload: { id: uploaded.fileUploadId },
          ...(caption.length > 0 ? { caption } : {}),
          ...(type === 'file' && (payload.name || uploaded.filename)
            ? { name: payload.name || uploaded.filename }
            : {}),
        }
        return {
          request: { object: 'block', type, [type]: mediaObj },
          deferredChildren: [],
        }
      } catch (err) {
        missingMedia.push({
          id: blockId,
          type,
          position,
          url: payload.file.url,
          reason: `Notion-hosted ${type} re-upload failed: ${err.message}`,
        })
        return { request: null, deferredChildren: [] }
      }
    }

    missingMedia.push({
      id: blockId,
      type,
      position,
      reason: `Media block (${type}) has no valid external or file URL`,
    })
    return { request: null, deferredChildren: [] }
  }

  // 11. Table block (requires initial table_row children in creation call)
  if (type === 'table') {
    const rowNodes = (node.children || []).filter(c => (c.type || c.raw?.type) === 'table_row')
    const maxBatch = context.maxBlocksPerAppend || 100
    const initialRowNodes = rowNodes.slice(0, maxBatch)
    const remainingRowNodes = rowNodes.slice(maxBatch)

    const initialRowRequests = initialRowNodes.map(buildTableRowBlockRequest)
    const inferredWidth =
      payload.table_width ||
      initialRowRequests[0]?.table_row?.cells?.length ||
      1

    return {
      request: {
        object: 'block',
        type: 'table',
        table: {
          table_width: inferredWidth,
          has_column_header: Boolean(payload.has_column_header),
          has_row_header: Boolean(payload.has_row_header),
          children: initialRowRequests,
        },
      },
      inlineCreatedCount: initialRowRequests.length,
      deferredChildren: remainingRowNodes,
    }
  }

  if (type === 'table_row') {
    return {
      request: buildTableRowBlockRequest(node),
      deferredChildren: [],
    }
  }

  // 12. Column list & Columns
  if (type === 'column_list') {
    const columnNodes = (node.children || []).filter(c => (c.type || c.raw?.type) === 'column')
    const columnRequests = []
    const columnFollowUps = []
    let inlineNestedCount = 0

    for (let colIdx = 0; colIdx < columnNodes.length; colIdx++) {
      const colNode = columnNodes[colIdx]
      const colRaw = colNode.raw || colNode
      const widthRatio = colRaw.column?.width_ratio
      const colChildren = colNode.children || []

      const builtColChildren = []
      const deferredForColumn = []

      for (let childIdx = 0; childIdx < colChildren.length; childIdx++) {
        const childNode = colChildren[childIdx]
        const builtChild = await buildSingleBlockRequest(childNode, context)
        if (!builtChild.request) continue

        if (
          builtColChildren.length < (context.maxBlocksPerAppend || 100) &&
          (!builtChild.deferredChildren || builtChild.deferredChildren.length === 0)
        ) {
          builtColChildren.push(builtChild.request)
          inlineNestedCount += 1 + (builtChild.inlineCreatedCount || 0)
        } else {
          deferredForColumn.push(...colChildren.slice(childIdx))
          break
        }
      }

      // Notion requires column.children to be present when creating column_list
      if (builtColChildren.length === 0 && deferredForColumn.length > 0) {
        const firstDeferred = deferredForColumn.shift()
        const firstBuilt = await buildSingleBlockRequest(firstDeferred, context)
        if (firstBuilt.request) {
          builtColChildren.push(firstBuilt.request)
          inlineNestedCount += 1 + (firstBuilt.inlineCreatedCount || 0)
          if (firstBuilt.deferredChildren?.length > 0) {
            columnFollowUps.push({
              columnIndex: colIdx,
              firstChildDeferredChildren: firstBuilt.deferredChildren,
              remainingColumnChildren: deferredForColumn,
            })
          } else if (deferredForColumn.length > 0) {
            columnFollowUps.push({
              columnIndex: colIdx,
              firstChildDeferredChildren: [],
              remainingColumnChildren: deferredForColumn,
            })
          }
        }
      } else if (deferredForColumn.length > 0) {
        columnFollowUps.push({
          columnIndex: colIdx,
          firstChildDeferredChildren: [],
          remainingColumnChildren: deferredForColumn,
        })
      }

      inlineNestedCount += 1 // count the column block itself
      columnRequests.push({
        object: 'block',
        type: 'column',
        column: {
          ...(typeof widthRatio === 'number' ? { width_ratio: widthRatio } : {}),
          children: builtColChildren,
        },
      })
    }

    return {
      request: {
        object: 'block',
        type: 'column_list',
        column_list: {
          children: columnRequests,
        },
      },
      inlineCreatedCount: inlineNestedCount,
      columnFollowUps,
      deferredChildren: [],
    }
  }

  // 13. Synced block (recreated as independent synced_block, reported clearly)
  if (type === 'synced_block') {
    const syncedFromId = raw.synced_block?.synced_from?.block_id || node.syncedFromBlockId || null
    syncedBlocks.push({
      id: blockId,
      position,
      syncedFromBlockId: syncedFromId,
      note: 'Recreated as independent synced_block; synchronization with the English source block is not retained.',
    })
    return {
      request: {
        object: 'block',
        type: 'synced_block',
        synced_block: {
          synced_from: null,
        },
      },
      deferredChildren: node.children || [],
    }
  }

  // 14. Linked resources: child_page, child_database, link_to_page
  if (type === 'child_page' || type === 'child_database' || type === 'link_to_page') {
    const refId =
      type === 'link_to_page'
        ? (payload.page_id || payload.database_id || blockId)
        : blockId
    const localizedCounterpart = localizedPageMap?.get(refId.replace(/-/g, '').toLowerCase()) || null
    const targetRefId = localizedCounterpart?.id || refId

    linkedResources.push({
      id: blockId,
      type,
      position,
      title: payload.title || node.text || '',
      originalReferencedId: refId,
      resolvedTargetId: targetRefId,
      usedLocalizedCounterpart: Boolean(localizedCounterpart),
      note: localizedCounterpart
        ? `Linked to localized counterpart page (${localizedCounterpart.id})`
        : `Preserved reference to original ${type} (${refId}); linked resource itself was not duplicated/translated.`,
    })

    if (type === 'child_database' || (type === 'link_to_page' && payload.database_id)) {
      return {
        request: {
          object: 'block',
          type: 'link_to_page',
          link_to_page: {
            type: 'database_id',
            database_id: targetRefId,
          },
        },
        deferredChildren: [],
      }
    }

    return {
      request: {
        object: 'block',
        type: 'link_to_page',
        link_to_page: {
          type: 'page_id',
          page_id: targetRefId,
        },
      },
      deferredChildren: [],
    }
  }

  // 15. Any unsupported block
  unsupportedBlocks.push({
    id: blockId,
    type,
    position,
    reason: `Block type "${type}" cannot be created via the Notion API`,
  })
  return { request: null, deferredChildren: [] }
}

/**
 * Splits an array of prepared block write descriptors into safe batches
 * respecting both Notion's 100-block limit and payload byte size limit.
 */
function chunkPreparedBlocks(preparedList, maxBlocksPerAppend = 100, maxBytes = MAX_APPEND_BATCH_BYTES) {
  const limit = Math.min(100, Math.max(1, maxBlocksPerAppend))
  const batches = []
  let current = []
  let currentBytes = 0

  for (const item of preparedList) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item.request), 'utf8')
    if (
      current.length > 0 &&
      (current.length >= limit || currentBytes + itemBytes > maxBytes)
    ) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(item)
    currentBytes += itemBytes
  }

  if (current.length > 0) {
    batches.push(current)
  }

  return batches
}

/**
 * Appends a tree of translated blocks recursively to `parentBlockId` in safe batches.
 */
async function appendTranslatedBlockTree(client, parentBlockId, nodes, context) {
  const logger = context.logger || defaultLogger
  const maxBlocksPerAppend = context.maxBlocksPerAppend || 100
  const preparedItems = []

  for (const node of nodes || []) {
    const built = await buildSingleBlockRequest(node, context)
    if (built.request) {
      preparedItems.push({
        sourceNode: node,
        ...built,
      })
    }
  }

  if (preparedItems.length === 0) {
    return
  }

  const batches = chunkPreparedBlocks(preparedItems, maxBlocksPerAppend)

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]
    const childrenPayload = batch.map(item => item.request)

    const appendRes = await withNotionRetry(
      () =>
        client.blocks.children.append({
          block_id: parentBlockId,
          children: childrenPayload,
        }),
      {
        isIdempotent: false,
        label: `blocks.children.append(${parentBlockId} batch ${batchIdx + 1}/${batches.length})`,
        logger,
        ...context.retryOptions,
      }
    )

    const returnedBlocks = appendRes?.results || []
    context.stats.totalWrittenTopOrBatchBlocks += childrenPayload.length

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]
      const createdBlock = returnedBlocks[i]
      const createdBlockId = createdBlock?.id || `${parentBlockId}-child-${batchIdx}-${i}`

      if (item.inlineCreatedCount) {
        context.stats.totalRecreatedNestedBlocks += item.inlineCreatedCount
      }

      if (context.depth > 0) {
        context.stats.totalRecreatedNestedBlocks += 1
      }

      // Recursively append deferred children (nested blocks or table rows > 100)
      if (item.deferredChildren && item.deferredChildren.length > 0) {
        await appendTranslatedBlockTree(client, createdBlockId, item.deferredChildren, {
          ...context,
          depth: (context.depth || 0) + 1,
        })
      }

      // Handle column_list follow-ups if any column had deeply nested blocks or > 100 blocks
      if (item.columnFollowUps && item.columnFollowUps.length > 0 && createdBlock?.id) {
        const createdColumns = await listAllRawBlockChildren(client, createdBlock.id, context.options)
        for (const followUp of item.columnFollowUps) {
          const targetCol = createdColumns[followUp.columnIndex]
          if (!targetCol?.id) continue
          if (followUp.firstChildDeferredChildren?.length > 0) {
            const colKids = await listAllRawBlockChildren(client, targetCol.id, context.options)
            const firstKid = colKids[0]
            if (firstKid?.id) {
              await appendTranslatedBlockTree(
                client,
                firstKid.id,
                followUp.firstChildDeferredChildren,
                { ...context, depth: (context.depth || 0) + 3 }
              )
            }
          }
          if (followUp.remainingColumnChildren?.length > 0) {
            await appendTranslatedBlockTree(
              client,
              targetCol.id,
              followUp.remainingColumnChildren,
              { ...context, depth: (context.depth || 0) + 2 }
            )
          }
        }
      }
    }
  }
}

/**
 * Creates (or safely resumes an empty target page) in the Articles database and writes
 * all translated blocks recursively while respecting Notion API limits.
 */
async function createTranslatedNotionPage(sourcePage, translatedTree, options = {}) {
  const {
    client,
    dataSourceInfo,
    pagePropertiesPayload,
    onTargetPageCreated,
    resumeTargetPageId = null,
    localizedPageMap = new Map(),
    maxBlocksPerAppend = 100,
    dryRun = false,
    logger = defaultLogger,
  } = options

  const rootNodes = normalizeTreeNodes(translatedTree)
  const missingMedia = []
  const unsupportedBlocks = []
  const linkedResources = []
  const syncedBlocks = []

  const stats = {
    totalWrittenTopOrBatchBlocks: 0,
    totalRecreatedNestedBlocks: 0,
  }

  if (dryRun) {
    // Still run block request builder in dryRun (without uploading files) to verify structure
    const dryClient = {
      ...client,
      fileUploads: null,
    }
    const dryContext = {
      client: dryClient,
      missingMedia: [],
      unsupportedBlocks,
      linkedResources,
      syncedBlocks,
      localizedPageMap,
      maxBlocksPerAppend,
      depth: 0,
      stats,
      logger,
      options,
    }
    for (const node of rootNodes) {
      await buildSingleBlockRequest(node, dryContext)
    }

    return {
      targetPage: {
        id: 'dry-run-target-page-id',
        url: 'https://www.notion.so/dry-run-target-page-id',
        properties: pagePropertiesPayload?.properties || {},
      },
      stats,
      missingMedia,
      unsupportedBlocks,
      linkedResources,
      syncedBlocks,
      dryRun: true,
    }
  }

  if (!client) {
    throw new Error('createTranslatedNotionPage requires a Notion client instance')
  }

  // 1. Resolve Cover & Icon
  const { cover, issue: coverIssue } = await resolvePageCoverForWrite(client, sourcePage?.cover, options)
  if (coverIssue) missingMedia.push(coverIssue)

  const { icon, issue: iconIssue } = await resolvePageIconForWrite(client, sourcePage?.icon, options)
  if (iconIssue) missingMedia.push(iconIssue)

  const properties = pagePropertiesPayload?.properties || pagePropertiesPayload || {}

  // 2. Create target page (or reuse empty shell page on safe resume)
  let targetPage = null
  if (resumeTargetPageId) {
    targetPage = await withNotionRetry(
      () =>
        client.pages.update({
          page_id: resumeTargetPageId,
          properties,
          ...(icon ? { icon } : {}),
          ...(cover ? { cover } : {}),
        }),
      { isIdempotent: true, label: 'pages.update(resumeTargetPage)', logger, ...options.retryOptions }
    )
  } else {
    const dataSourceId = dataSourceInfo?.dataSourceId
    const databaseId = dataSourceInfo?.databaseId

    try {
      targetPage = await withNotionRetry(
        () =>
          client.pages.create({
            parent: dataSourceId
              ? { type: 'data_source_id', data_source_id: dataSourceId }
              : { type: 'database_id', database_id: databaseId },
            properties,
            ...(icon ? { icon } : {}),
            ...(cover ? { cover } : {}),
          }),
        { isIdempotent: false, label: 'pages.create(data_source_id)', logger, ...options.retryOptions }
      )
    } catch (err) {
      // Fallback if mock or older database endpoint expects database_id parent
      if (databaseId && dataSourceId && dataSourceId !== databaseId) {
        targetPage = await withNotionRetry(
          () =>
            client.pages.create({
              parent: { type: 'database_id', database_id: databaseId },
              properties,
              ...(icon ? { icon } : {}),
              ...(cover ? { cover } : {}),
            }),
          { isIdempotent: false, label: 'pages.create(database_id)', logger, ...options.retryOptions }
        )
      } else {
        throw err
      }
    }
  }

  if (!targetPage?.id) {
    throw new Error('Notion pages.create did not return a valid page ID')
  }

  // 3. Immediately persist target page ID on the source page before writing blocks
  if (typeof onTargetPageCreated === 'function') {
    await onTargetPageCreated(targetPage)
  }

  // 4. Append all blocks recursively in safe batches
  const writeContext = {
    client,
    missingMedia,
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
    localizedPageMap,
    maxBlocksPerAppend,
    depth: 0,
    stats,
    logger,
    retryOptions: options.retryOptions,
    options,
  }

  await appendTranslatedBlockTree(client, targetPage.id, rootNodes, writeContext)

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

module.exports = {
  createTranslatedNotionPage,
  appendTranslatedBlockTree,
  buildSingleBlockRequest,
  chunkPreparedBlocks,
  sanitizeIconForWrite,
  resolvePageCoverForWrite,
  resolvePageIconForWrite,
}

