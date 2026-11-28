import { toNotionRichTextRequest } from '../builder'
import { reuploadNotionAsset } from '../notion-client'
import type { NotionBlockNode } from '../types'
import { sanitizeIconForWrite } from './assets'
import type {
  BlockWriteContext,
  BuiltSingleBlockResult,
  ColumnFollowUp,
} from './types'

function buildTableRowBlockRequest(
  rowNode: NotionBlockNode
): Record<string, unknown> {
  const raw = (rowNode?.raw || rowNode) as {
    table_row?: { cells?: unknown[] }
  }
  const cells = raw?.table_row?.cells || []
  return {
    object: 'block',
    type: 'table_row',
    table_row: {
      cells: cells.map((cell) => toNotionRichTextRequest(cell)),
    },
  }
}

async function buildMediaBlockRequest(
  type: 'image' | 'video' | 'file' | 'pdf' | 'audio',
  blockId: string,
  position: string,
  payload: Record<string, unknown>,
  context: BlockWriteContext
): Promise<BuiltSingleBlockResult> {
  const { client, missingMedia, options } = context
  const caption = Array.isArray(payload.caption)
    ? toNotionRichTextRequest(payload.caption)
    : []
  const externalObj = payload.external as { url?: string } | undefined
  const fileObj = payload.file as { url?: string } | undefined
  const fileUploadObj = payload.file_upload as { id?: string } | undefined
  const mediaType =
    payload.type ||
    (externalObj
      ? 'external'
      : fileObj
        ? 'file'
        : fileUploadObj
          ? 'file_upload'
          : null)

  if (mediaType === 'external' && externalObj?.url) {
    const mediaObj = {
      type: 'external',
      external: { url: externalObj.url },
      ...(caption.length > 0 ? { caption } : {}),
      ...(type === 'file' && payload.name ? { name: payload.name } : {}),
    }
    return {
      request: { object: 'block', type, [type]: mediaObj },
      deferredChildren: [],
    }
  }

  if (mediaType === 'file_upload' && fileUploadObj?.id) {
    const mediaObj = {
      type: 'file_upload',
      file_upload: { id: fileUploadObj.id },
      ...(caption.length > 0 ? { caption } : {}),
      ...(type === 'file' && payload.name ? { name: payload.name } : {}),
    }
    return {
      request: { object: 'block', type, [type]: mediaObj },
      deferredChildren: [],
    }
  }

  if (mediaType === 'file' && fileObj?.url) {
    const assetKey = `block:${blockId}`
    const cachedUpload = context.checkpoint?.getUploadedAsset?.(assetKey)
    if (cachedUpload?.fileUploadId) {
      const mediaObj = {
        type: 'file_upload',
        file_upload: { id: cachedUpload.fileUploadId },
        ...(caption.length > 0 ? { caption } : {}),
        ...(type === 'file' && (payload.name || cachedUpload.filename)
          ? { name: payload.name || cachedUpload.filename }
          : {}),
      }
      return {
        request: { object: 'block', type, [type]: mediaObj },
        deferredChildren: [],
      }
    }
    try {
      const uploaded = await reuploadNotionAsset(client, fileObj.url, {
        ...options,
        filename: typeof payload.name === 'string' ? payload.name : undefined,
      })
      context.checkpoint?.recordUploadedAsset?.(assetKey, uploaded)
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
        url: fileObj.url,
        reason: `Notion-hosted ${type} re-upload failed: ${err instanceof Error ? err.message : String(err)}`,
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

async function buildColumnListBlockRequest(
  node: NotionBlockNode,
  context: BlockWriteContext
): Promise<BuiltSingleBlockResult> {
  const columnNodes = (node.children || []).filter(
    (c) => (c.type || c.raw?.type) === 'column'
  )
  const columnRequests: Record<string, unknown>[] = []
  const columnFollowUps: ColumnFollowUp[] = []
  let inlineNestedCount = 0

  for (let colIdx = 0; colIdx < columnNodes.length; colIdx++) {
    const colNode = columnNodes[colIdx]
    const colRaw = (colNode.raw || colNode) as {
      column?: { width_ratio?: number }
    }
    const widthRatio = colRaw.column?.width_ratio
    const colChildren = colNode.children || []

    const builtColChildren: Record<string, unknown>[] = []
    const deferredForColumn: NotionBlockNode[] = []

    for (let childIdx = 0; childIdx < colChildren.length; childIdx++) {
      const childNode = colChildren[childIdx]
      const builtChild = await buildSingleBlockRequest(childNode, context)
      if (!builtChild.request) continue

      if (
        builtColChildren.length < (context.maxBlocksPerAppend || 100) &&
        (!builtChild.deferredChildren ||
          builtChild.deferredChildren.length === 0)
      ) {
        builtColChildren.push(builtChild.request)
        inlineNestedCount += 1 + (builtChild.inlineCreatedCount || 0)
      } else {
        deferredForColumn.push(...colChildren.slice(childIdx))
        break
      }
    }

    if (builtColChildren.length === 0 && deferredForColumn.length > 0) {
      const firstDeferred = deferredForColumn.shift()!
      const firstBuilt = await buildSingleBlockRequest(firstDeferred, context)
      if (firstBuilt.request) {
        builtColChildren.push(firstBuilt.request)
        inlineNestedCount += 1 + (firstBuilt.inlineCreatedCount || 0)
        if (
          firstBuilt.deferredChildren &&
          firstBuilt.deferredChildren.length > 0
        ) {
          columnFollowUps.push({
            columnIndex: colIdx,
            firstChildSourceId:
              firstDeferred.id || firstDeferred.position || `${colIdx}-0`,
            firstChildInlineCount: firstBuilt.inlineCreatedCount || 0,
            firstChildDeferredChildren: firstBuilt.deferredChildren,
            initialColumnChildCount: builtColChildren.length,
            remainingColumnChildren: deferredForColumn,
          })
        } else if (deferredForColumn.length > 0) {
          columnFollowUps.push({
            columnIndex: colIdx,
            firstChildDeferredChildren: [],
            initialColumnChildCount: builtColChildren.length,
            remainingColumnChildren: deferredForColumn,
          })
        }
      }
    } else if (deferredForColumn.length > 0) {
      columnFollowUps.push({
        columnIndex: colIdx,
        firstChildDeferredChildren: [],
        initialColumnChildCount: builtColChildren.length,
        remainingColumnChildren: deferredForColumn,
      })
    }

    inlineNestedCount += 1
    columnRequests.push({
      object: 'block',
      type: 'column',
      column: {
        ...(typeof widthRatio === 'number'
          ? { width_ratio: widthRatio }
          : {}),
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

function buildLinkedResourceBlockRequest(
  type: 'child_page' | 'child_database' | 'link_to_page',
  blockId: string,
  position: string,
  node: NotionBlockNode,
  payload: Record<string, unknown>,
  context: BlockWriteContext
): BuiltSingleBlockResult {
  const { linkedResources, localizedPageMap } = context
  const refId =
    type === 'link_to_page'
      ? String(payload.page_id || payload.database_id || blockId)
      : blockId
  const normRefId = refId.replace(/-/g, '').toLowerCase()
  const localizedCounterpart = localizedPageMap?.get(normRefId) || null
  const isTranslatedDatabase =
    (type === 'child_database' ||
      (type === 'link_to_page' && Boolean(payload.database_id))) &&
    Boolean(context.translatedDatabaseIds?.has(normRefId))
  const targetRefId = localizedCounterpart?.id || refId
  const usedLocalizedCounterpart =
    Boolean(localizedCounterpart) || isTranslatedDatabase

  linkedResources.push({
    id: blockId,
    type,
    position,
    title: String(payload.title || node.text || ''),
    originalReferencedId: refId,
    resolvedTargetId: targetRefId,
    usedLocalizedCounterpart,
    note: localizedCounterpart
      ? `Linked to localized counterpart page (${localizedCounterpart.id})`
      : isTranslatedDatabase
        ? `Linked to shared nested database (${targetRefId}) containing translated Vietnamese entries`
        : `Preserved reference to original ${type} (${refId}); linked resource itself was not duplicated/translated.`,
  })

  if (
    type === 'child_database' ||
    (type === 'link_to_page' && payload.database_id)
  ) {
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

/**
 * Converts a single translated AST node into a Notion `BlockObjectRequest` payload.
 */
export async function buildSingleBlockRequest(
  node: NotionBlockNode,
  context: BlockWriteContext
): Promise<BuiltSingleBlockResult> {
  const { missingMedia, unsupportedBlocks, syncedBlocks } = context

  const raw = (node.raw || node) as Record<string, unknown>
  const type = String(node.type || raw.type || 'unsupported')
  const blockId =
    node.id || String(raw.id || `pos-${node.position || '0'}`)
  const position = node.position || '0'
  const payload = (raw[type] || {}) as Record<string, unknown>

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

  // 2. Headings
  if (/^heading_[1-6]$/.test(type)) {
    const effectiveType =
      type === 'heading_5' || type === 'heading_6' ? 'heading_4' : type
    const blockData = {
      rich_text: toNotionRichTextRequest(payload.rich_text || []),
      ...(payload.color ? { color: payload.color } : {}),
      ...(typeof payload.is_toggleable === 'boolean'
        ? { is_toggleable: payload.is_toggleable }
        : {}),
    }
    return {
      request: {
        object: 'block',
        type: effectiveType,
        [effectiveType]: blockData,
      },
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

  // 6. Code (preserved verbatim)
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

  // 7. Equation (preserved verbatim)
  if (type === 'equation') {
    return {
      request: {
        object: 'block',
        type: 'equation',
        equation: { expression: String(payload.expression || '') },
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
  if (
    type === 'image' ||
    type === 'video' ||
    type === 'file' ||
    type === 'pdf' ||
    type === 'audio'
  ) {
    return buildMediaBlockRequest(type, blockId, position, payload, context)
  }

  // 11. Table block
  if (type === 'table') {
    const rowNodes = (node.children || []).filter(
      (c) => (c.type || c.raw?.type) === 'table_row'
    )
    const maxBatch = context.maxBlocksPerAppend || 100
    const initialRowNodes = rowNodes.slice(0, maxBatch)
    const remainingRowNodes = rowNodes.slice(maxBatch)

    const initialRowRequests = initialRowNodes.map(buildTableRowBlockRequest)
    const firstRowCells = (
      initialRowRequests[0]?.table_row as { cells?: unknown[] } | undefined
    )?.cells
    const inferredWidth =
      Number(payload.table_width) || firstRowCells?.length || 1

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
    return buildColumnListBlockRequest(node, context)
  }

  // 13. Synced block
  if (type === 'synced_block') {
    const syncedPayload = raw.synced_block as
      | { synced_from?: { block_id?: string } | null }
      | undefined
    const syncedFromId =
      syncedPayload?.synced_from?.block_id || node.syncedFromBlockId || null
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
  if (
    type === 'child_page' ||
    type === 'child_database' ||
    type === 'link_to_page'
  ) {
    return buildLinkedResourceBlockRequest(
      type,
      blockId,
      position,
      node,
      payload,
      context
    )
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
