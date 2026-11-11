import type {
  BlockObjectRequest,
  Client,
  CreatePageParameters,
  UpdatePageParameters,
} from '@notionhq/client'
import {
  withNotionRetry,
  reuploadNotionAsset,
  type NotionOperationOptions,
} from './notion-client'
import { toNotionRichTextRequest } from './builder'
import { normalizeTreeNodes, listAllRawBlockChildren } from './reader'
import type {
  ArticlesDataSourceInfo,
  CheckpointController,
  DiscoveredPageParentKind,
  LinkedResourceIssue,
  MissingMediaIssue,
  NotionBlockNode,
  NotionBlockTree,
  NotionPageLike,
  NotionRawBlock,
  PageWorkflowMeta,
  RetryConfigOptions,
  SyncedBlockIssue,
  TranslatedPagePropertiesPayload,
  UnsupportedBlockIssue,
  WorkerLogger,
  WriterResult,
  WriterStats,
} from './types'
import { defaultLogger } from '../../worker/logger'

const MAX_APPEND_BATCH_BYTES = 400 * 1024 // 400 KB safety ceiling per append request

function extractPlainFromRichTextArray(arr: unknown): string {
  if (!Array.isArray(arr)) return ''
  return arr
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const r = item as {
        plain_text?: string
        text?: { content?: string }
        equation?: { expression?: string }
      }
      return r.plain_text ?? r.text?.content ?? r.equation?.expression ?? ''
    })
    .join('')
}

/**
 * Computes a deterministic structural + text fingerprint for either a prepared
 * Notion `BlockObjectRequest` or a raw Notion `BlockObjectResponse` returned by the API.
 */
export function computeBlockFingerprint(blockObj: unknown): string {
  if (!blockObj || typeof blockObj !== 'object') return 'invalid'
  const candidate = blockObj as {
    raw?: Record<string, unknown>
    type?: string
    [key: string]: unknown
  }
  const raw =
    candidate.raw && typeof candidate.raw === 'object'
      ? candidate.raw
      : candidate
  const type = String(raw.type || candidate.type || 'unsupported')
  const payload = (raw[type] || {}) as Record<string, unknown>

  switch (type) {
    case 'paragraph':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'quote':
    case 'toggle':
    case 'template':
    case 'callout':
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'heading_4':
    case 'heading_5':
    case 'heading_6': {
      const normalizedHeadingType =
        type === 'heading_5' || type === 'heading_6' ? 'heading_4' : type
      return `${normalizedHeadingType}:${extractPlainFromRichTextArray(payload.rich_text)}`
    }
    case 'to_do':
      return `to_do:${Boolean(payload.checked)}:${extractPlainFromRichTextArray(payload.rich_text)}`
    case 'code':
      return `code:${payload.language || 'plain text'}:${extractPlainFromRichTextArray(payload.rich_text)}:${extractPlainFromRichTextArray(payload.caption)}`
    case 'equation':
      return `equation:${payload.expression || ''}`
    case 'divider':
    case 'breadcrumb':
    case 'table_of_contents':
    case 'synced_block':
    case 'column_list':
    case 'column':
      return type
    case 'bookmark':
    case 'embed':
      return `${type}:${payload.url || ''}:${extractPlainFromRichTextArray(payload.caption)}`
    case 'image':
    case 'video':
    case 'file':
    case 'pdf':
    case 'audio':
      return `${type}:${extractPlainFromRichTextArray(payload.caption)}`
    case 'table':
      return `table:${payload.table_width || ''}:${Boolean(payload.has_column_header)}:${Boolean(payload.has_row_header)}`
    case 'table_row': {
      const cells = Array.isArray(payload.cells)
        ? payload.cells
            .map((cell) => extractPlainFromRichTextArray(cell))
            .join('\u001f')
        : ''
      return `table_row:${cells}`
    }
    case 'link_to_page':
    case 'child_page':
    case 'child_database': {
      if (type === 'child_page' && typeof payload.title === 'string') {
        return `child_page:${payload.title}`
      }
      const refId = String(payload.page_id || payload.database_id || '')
        .replace(/-/g, '')
        .toLowerCase()
      return `link_to_page:${refId}`
    }
    default:
      return `${type}:${extractPlainFromRichTextArray(payload.rich_text)}`
  }
}

export function isExistingTargetPrefixValid(
  sourceTree: NotionBlockTree | NotionBlockNode[],
  existingTargetTree: NotionBlockTree | NotionBlockNode[]
): boolean {
  const srcNodes = normalizeTreeNodes(sourceTree)
  const tgtNodes = normalizeTreeNodes(existingTargetTree)
  if (tgtNodes.length === 0) return true
  if (tgtNodes.length > srcNodes.length) return false

  const normType = (t: string): string => {
    if (t === 'child_database') return 'link_to_page'
    if (t === 'heading_5' || t === 'heading_6') return 'heading_4'
    return t
  }

  for (let i = 0; i < tgtNodes.length; i++) {
    const sType = normType(
      String(srcNodes[i]?.type || srcNodes[i]?.raw?.type || '')
    )
    const tType = normType(
      String(tgtNodes[i]?.type || tgtNodes[i]?.raw?.type || '')
    )
    if (sType !== tType && !(sType === 'child_page' && tType === 'link_to_page')) {
      return false
    }
  }
  return true
}

export interface AmbiguousReconciliationError extends Error {
  code: 'AMBIGUOUS_APPEND_RECONCILIATION'
  needsReview: true
  details: Record<string, unknown>
}

export function createAmbiguousReconciliationError(
  message: string,
  details: Record<string, unknown> = {}
): AmbiguousReconciliationError {
  const err = new Error(message) as AmbiguousReconciliationError
  err.code = 'AMBIGUOUS_APPEND_RECONCILIATION'
  err.needsReview = true
  err.details = details
  return err
}

export function sanitizeIconForWrite(
  icon: unknown
): Record<string, unknown> | undefined {
  if (!icon || typeof icon !== 'object') return undefined
  const ic = icon as {
    type?: string
    emoji?: string
    external?: { url?: string }
    custom_emoji?: { id?: string }
    icon?: { name?: string }
    file_upload?: { id?: string }
  }
  if (ic.type === 'emoji' && ic.emoji) {
    return { type: 'emoji', emoji: ic.emoji }
  }
  if (ic.type === 'external' && ic.external?.url) {
    return { type: 'external', external: { url: ic.external.url } }
  }
  if (ic.type === 'custom_emoji' && ic.custom_emoji?.id) {
    return { type: 'custom_emoji', custom_emoji: { id: ic.custom_emoji.id } }
  }
  if (ic.type === 'icon' && ic.icon?.name) {
    return { type: 'icon', icon: ic.icon }
  }
  if (ic.type === 'file_upload' && ic.file_upload?.id) {
    return { type: 'file_upload', file_upload: { id: ic.file_upload.id } }
  }
  return undefined
}

export interface AssetWriteOptions extends NotionOperationOptions {
  checkpoint?: CheckpointController | null
}

export async function resolvePageCoverForWrite(
  client: Client,
  sourceCover: unknown,
  options: AssetWriteOptions = {}
): Promise<{
  cover: Record<string, unknown> | undefined
  issue: MissingMediaIssue | null
}> {
  if (!sourceCover || typeof sourceCover !== 'object') {
    return { cover: undefined, issue: null }
  }
  const sc = sourceCover as {
    type?: string
    external?: { url?: string }
    file?: { url?: string }
  }
  if (sc.type === 'external' && sc.external?.url) {
    return {
      cover: { type: 'external', external: { url: sc.external.url } },
      issue: null,
    }
  }
  if (sc.type === 'file' && sc.file?.url) {
    const cachedUpload = options.checkpoint?.getUploadedAsset?.('page:cover')
    if (cachedUpload?.fileUploadId) {
      return {
        cover: {
          type: 'file_upload',
          file_upload: { id: cachedUpload.fileUploadId },
        },
        issue: null,
      }
    }
    try {
      const uploaded = await reuploadNotionAsset(client, sc.file.url, options)
      options.checkpoint?.recordUploadedAsset?.('page:cover', uploaded)
      return {
        cover: {
          type: 'file_upload',
          file_upload: { id: uploaded.fileUploadId },
        },
        issue: null,
      }
    } catch (err) {
      return {
        cover: undefined,
        issue: {
          id: 'page_cover',
          type: 'cover',
          position: 'page.cover',
          reason: `Could not re-upload Notion-hosted cover image: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
  }
  return { cover: undefined, issue: null }
}

export async function resolvePageIconForWrite(
  client: Client,
  sourceIcon: unknown,
  options: AssetWriteOptions = {}
): Promise<{
  icon: Record<string, unknown> | undefined
  issue: MissingMediaIssue | null
}> {
  if (!sourceIcon || typeof sourceIcon !== 'object') {
    return { icon: undefined, issue: null }
  }
  const si = sourceIcon as {
    type?: string
    file?: { url?: string }
  }
  if (si.type === 'file' && si.file?.url) {
    const cachedUpload = options.checkpoint?.getUploadedAsset?.('page:icon')
    if (cachedUpload?.fileUploadId) {
      return {
        icon: {
          type: 'file_upload',
          file_upload: { id: cachedUpload.fileUploadId },
        },
        issue: null,
      }
    }
    try {
      const uploaded = await reuploadNotionAsset(client, si.file.url, options)
      options.checkpoint?.recordUploadedAsset?.('page:icon', uploaded)
      return {
        icon: {
          type: 'file_upload',
          file_upload: { id: uploaded.fileUploadId },
        },
        issue: null,
      }
    } catch (err) {
      return {
        icon: undefined,
        issue: {
          id: 'page_icon',
          type: 'icon',
          position: 'page.icon',
          reason: `Could not re-upload Notion-hosted icon: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
  }
  return { icon: sanitizeIconForWrite(sourceIcon), issue: null }
}

function buildTableRowBlockRequest(rowNode: NotionBlockNode): Record<string, unknown> {
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

export interface ColumnFollowUp {
  columnIndex: number
  firstChildSourceId?: string
  firstChildInlineCount?: number
  firstChildDeferredChildren: NotionBlockNode[]
  initialColumnChildCount: number
  remainingColumnChildren: NotionBlockNode[]
}

export interface BuiltSingleBlockResult {
  request: Record<string, unknown> | null
  deferredChildren: NotionBlockNode[]
  inlineCreatedCount?: number
  columnFollowUps?: ColumnFollowUp[]
}

export interface ChildPageWriteRequest {
  sourceChildPageNode: NotionBlockNode
  sourceChildPageId: string
  targetParentPageId: string
  expectedStartIndex: number
  existingTargetBlock: NotionRawBlock | null
}

export interface ChildPageWriteResponse {
  targetChildPageId: string
  title?: string
}

export interface BlockWriteContext {
  client: Client
  missingMedia: MissingMediaIssue[]
  unsupportedBlocks: UnsupportedBlockIssue[]
  linkedResources: LinkedResourceIssue[]
  syncedBlocks: SyncedBlockIssue[]
  localizedPageMap?: Map<string, PageWorkflowMeta>
  translatedDatabaseIds?: Set<string>
  onWriteChildPage?: (
    params: ChildPageWriteRequest
  ) => Promise<ChildPageWriteResponse | null>
  maxBlocksPerAppend: number
  depth: number
  parentKey?: string
  initialExistingChildCount?: number
  isResuming?: boolean
  checkpoint?: CheckpointController | null
  stats: WriterStats
  logger: WorkerLogger
  retryOptions?: RetryConfigOptions
  options: AssetWriteOptions
}

/**
 * Converts a single translated AST node into a Notion `BlockObjectRequest` payload.
 */
export async function buildSingleBlockRequest(
  node: NotionBlockNode,
  context: BlockWriteContext
): Promise<BuiltSingleBlockResult> {
  const {
    client,
    missingMedia,
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
    localizedPageMap,
    options,
  } = context

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
        const firstBuilt = await buildSingleBlockRequest(
          firstDeferred,
          context
        )
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

  // 15. Any unsupported block
  unsupportedBlocks.push({
    id: blockId,
    type,
    position,
    reason: `Block type "${type}" cannot be created via the Notion API`,
  })
  return { request: null, deferredChildren: [] }
}

export interface PreparedBlockDescriptor extends BuiltSingleBlockResult {
  sourceNode: NotionBlockNode
  request: Record<string, unknown>
}

export function chunkPreparedBlocks(
  preparedList: readonly PreparedBlockDescriptor[],
  maxBlocksPerAppend = 100,
  maxBytes: number = MAX_APPEND_BATCH_BYTES
): PreparedBlockDescriptor[][] {
  const limit = Math.min(100, Math.max(1, maxBlocksPerAppend))
  const batches: PreparedBlockDescriptor[][] = []
  let current: PreparedBlockDescriptor[] = []
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

function verifySliceFingerprints(
  existingSlice: readonly NotionRawBlock[],
  expectedFingerprints: readonly string[]
): boolean {
  if (
    !Array.isArray(existingSlice) ||
    existingSlice.length !== expectedFingerprints.length
  ) {
    return false
  }
  for (let i = 0; i < expectedFingerprints.length; i++) {
    const actualFp = computeBlockFingerprint(existingSlice[i])
    if (actualFp !== expectedFingerprints[i]) {
      return false
    }
  }
  return true
}

/**
 * Appends a tree of translated blocks recursively to `parentBlockId` in safe batches.
 * Supports durable checkpointing, partial-job resume, and deterministic reconciliation
 * of uncertain `blocks.children.append` operations.
 */
export async function appendTranslatedBlockTree(
  client: Client,
  parentBlockId: string,
  nodes: readonly NotionBlockNode[],
  context: BlockWriteContext
): Promise<void> {
  const logger = context.logger || defaultLogger
  const maxBlocksPerAppend = context.maxBlocksPerAppend || 100
  const checkpoint = context.checkpoint || null
  const parentKey = context.parentKey || 'root'

  // If onWriteChildPage is provided at depth === 0 and there are child_page nodes,
  // write segments in exact positional order so child_page blocks created via
  // pages.create(parent: { page_id }) appear at their exact position.
  if (
    (context.depth || 0) === 0 &&
    typeof context.onWriteChildPage === 'function' &&
    Array.isArray(nodes) &&
    nodes.some((n) => (n?.type || n?.raw?.type) === 'child_page')
  ) {
    let runningExpectedIndex = Number(context.initialExistingChildCount) || 0
    let segmentIndex = 0
    let currentSegment: NotionBlockNode[] = []

    const flushSegment = async (segNodes: NotionBlockNode[], segIdx: number) => {
      if (segNodes.length === 0) return
      await appendTranslatedBlockTree(client, parentBlockId, segNodes, {
        ...context,
        onWriteChildPage: undefined,
        parentKey: `${parentKey}:seg:${segIdx}`,
        initialExistingChildCount: runningExpectedIndex,
      })
      runningExpectedIndex += segNodes.length
    }

    for (const node of nodes) {
      const nodeType = String(node?.type || node?.raw?.type || '')
      if (nodeType !== 'child_page') {
        currentSegment.push(node)
        continue
      }

      await flushSegment(currentSegment, segmentIndex)
      currentSegment = []
      segmentIndex += 1

      const sourceChildPageId = String(node.id || node.raw?.id || '')
      let existingTargetBlock: NotionRawBlock | null = null
      if (
        (context.isResuming ||
          checkpoint?.getChildTargetPageId?.(sourceChildPageId)) &&
        typeof client?.blocks?.children?.list === 'function'
      ) {
        try {
          const currentTargetBlocks = await listAllRawBlockChildren(
            client,
            parentBlockId,
            {
              ...(context.options || {}),
              logger,
              retryOptions: context.retryOptions,
            }
          )
          const blockAtPos = currentTargetBlocks[runningExpectedIndex]
          if (blockAtPos && blockAtPos.type === 'child_page') {
            existingTargetBlock = blockAtPos
          }
        } catch {
          existingTargetBlock = null
        }
      }

      const childResult = await context.onWriteChildPage({
        sourceChildPageNode: node,
        sourceChildPageId,
        targetParentPageId: parentBlockId,
        expectedStartIndex: runningExpectedIndex,
        existingTargetBlock,
      })

      if (childResult?.targetChildPageId) {
        checkpoint?.recordChildTargetPageId?.(
          sourceChildPageId,
          childResult.targetChildPageId
        )
        context.linkedResources.push({
          id: sourceChildPageId,
          type: 'child_page',
          position: node.position || String(runningExpectedIndex),
          title: childResult.title || node.text || '',
          originalReferencedId: sourceChildPageId,
          resolvedTargetId: childResult.targetChildPageId,
          usedLocalizedCounterpart: true,
          note: `Created translated Vietnamese child page (${childResult.targetChildPageId})`,
        })
        context.stats.totalWrittenTopOrBatchBlocks += 1
        runningExpectedIndex += 1
      }
    }

    await flushSegment(currentSegment, segmentIndex)
    return
  }

  const preparedItems: PreparedBlockDescriptor[] = []

  for (const node of nodes || []) {
    const built = await buildSingleBlockRequest(node, context)
    if (built.request) {
      preparedItems.push({
        sourceNode: node,
        ...built,
        request: built.request,
      })
    }
  }

  if (preparedItems.length === 0) {
    return
  }

  const batches = chunkPreparedBlocks(preparedItems, maxBlocksPerAppend)
  const initialExistingChildCount =
    Number(context.initialExistingChildCount) || 0
  let expectedStartIndex = initialExistingChildCount
  let cachedExistingChildren: NotionRawBlock[] | null = null

  async function getExistingParentChildren(
    forceRefresh = false
  ): Promise<NotionRawBlock[]> {
    if (!forceRefresh && Array.isArray(cachedExistingChildren)) {
      return cachedExistingChildren
    }
    cachedExistingChildren = await listAllRawBlockChildren(
      client,
      parentBlockId,
      {
        ...(context.options || {}),
        logger,
        retryOptions: context.retryOptions,
      }
    )
    return cachedExistingChildren
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!
    const batchKey = `${parentKey}:batch:${batchIdx}`
    const childrenPayload = batch.map(
      (item) => item.request as unknown as BlockObjectRequest
    )
    const sourceBlockIds = batch.map(
      (item, idx) =>
        item.sourceNode?.id ||
        item.sourceNode?.position ||
        `${batchKey}:${idx}`
    )
    const batchFingerprints = childrenPayload.map((req) =>
      computeBlockFingerprint(req)
    )

    const recordedBatch = checkpoint?.getCompletedBatch?.(batchKey) || null
    const pendingOp = checkpoint?.getPendingOperation?.() || null
    const isPendingThisBatch =
      pendingOp?.type === 'append_blocks' && pendingOp.batchKey === batchKey
    const shouldInspectExisting =
      Boolean(context.isResuming) ||
      Boolean(recordedBatch) ||
      Boolean(isPendingThisBatch) ||
      Array.isArray(cachedExistingChildren)

    let returnedBlocks: Array<{ id?: string }> | null = null
    let alreadyWritten = false

    if (
      shouldInspectExisting &&
      typeof client?.blocks?.children?.list === 'function'
    ) {
      const existingChildren = await getExistingParentChildren(false)

      if (existingChildren.length < expectedStartIndex) {
        throw createAmbiguousReconciliationError(
          `Target block ${parentBlockId} (${batchKey}) has fewer children (${existingChildren.length}) than expected start index (${expectedStartIndex}). Target page may have been manually modified.`,
          {
            parentBlockId,
            batchKey,
            existingCount: existingChildren.length,
            expectedStartIndex,
          }
        )
      }

      if (existingChildren.length >= expectedStartIndex + batch.length) {
        const candidateSlice = existingChildren.slice(
          expectedStartIndex,
          expectedStartIndex + batch.length
        )
        if (!verifySliceFingerprints(candidateSlice, batchFingerprints)) {
          throw createAmbiguousReconciliationError(
            `Existing blocks in target parent ${parentBlockId} at index ${expectedStartIndex}..${expectedStartIndex + batch.length - 1} do not match expected translated batch (${batchKey}). Refusing to overwrite or duplicate content.`,
            {
              parentBlockId,
              batchKey,
              expectedStartIndex,
              batchSize: batch.length,
            }
          )
        }

  const parentHasMoreSegments = parentKey.includes(':seg:')
        if (
          !parentHasMoreSegments &&
          batchIdx === batches.length - 1 &&
          existingChildren.length > expectedStartIndex + batch.length
        ) {
          throw createAmbiguousReconciliationError(
            `Target block ${parentBlockId} contains ${existingChildren.length - (expectedStartIndex + batch.length)} unexpected extra block(s) after final batch (${batchKey}).`,
            { parentBlockId, batchKey, existingCount: existingChildren.length }
          )
        }

        returnedBlocks = candidateSlice
        alreadyWritten = true
        logger.info(
          `Reconciled already-written block batch ${batchKey} (${batch.length} blocks) on ${parentBlockId}`
        )

        if (!recordedBatch || isPendingThisBatch) {
          checkpoint?.recordCompletedBatch?.({
            batchKey,
            parentBlockId,
            batchIndex: batchIdx,
            expectedStartIndex,
            sourceBlockIds,
            targetBlockIds: returnedBlocks.map(
              (b, idx) => b.id || `${parentBlockId}-child-${batchIdx}-${idx}`
            ),
            blockFingerprints: batchFingerprints,
          })
        }
      } else if (existingChildren.length > expectedStartIndex) {
        throw createAmbiguousReconciliationError(
          `Target block ${parentBlockId} has a partial or mismatched block count (${existingChildren.length}) for batch ${batchKey} (expected ${expectedStartIndex} or >= ${expectedStartIndex + batch.length}).`,
          {
            parentBlockId,
            batchKey,
            existingCount: existingChildren.length,
            expectedStartIndex,
            batchSize: batch.length,
          }
        )
      } else if (recordedBatch) {
        throw createAmbiguousReconciliationError(
          `Checkpoint recorded batch ${batchKey} as completed on ${parentBlockId}, but blocks were not found in Notion at index ${expectedStartIndex}.`,
          { parentBlockId, batchKey, expectedStartIndex }
        )
      }
    } else if (recordedBatch?.targetBlockIds?.length === batch.length) {
      returnedBlocks = recordedBatch.targetBlockIds.map((id) => ({ id }))
      alreadyWritten = true
    }

    if (!alreadyWritten) {
      checkpoint?.recordPendingOperation?.({
        type: 'append_blocks',
        batchKey,
        parentBlockId,
        batchIndex: batchIdx,
        expectedStartIndex,
        sourceBlockIds,
        blockFingerprints: batchFingerprints,
        startedAt: new Date().toISOString(),
      })

      try {
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
        returnedBlocks = appendRes?.results || []
        const currentCache = cachedExistingChildren as NotionRawBlock[] | null
        if (Array.isArray(currentCache)) {
          currentCache.push(...(returnedBlocks as NotionRawBlock[]))
        }
      } catch (appendErr) {
        const errMessage =
          appendErr instanceof Error ? appendErr.message : String(appendErr)

        if (typeof client?.blocks?.children?.list === 'function') {
          let latestChildren: NotionRawBlock[] | null = null
          try {
            latestChildren = await getExistingParentChildren(true)
          } catch {
            latestChildren = null
          }

          if (Array.isArray(latestChildren)) {
            if (latestChildren.length >= expectedStartIndex + batch.length) {
              const candidateSlice = latestChildren.slice(
                expectedStartIndex,
                expectedStartIndex + batch.length
              )
              if (verifySliceFingerprints(candidateSlice, batchFingerprints)) {
                logger.warn(
                  `Recovered uncertain blocks.children.append for ${batchKey}: Notion already committed all ${batch.length} blocks despite error (${errMessage}).`
                )
                returnedBlocks = candidateSlice
              } else {
                throw createAmbiguousReconciliationError(
                  `Uncertain blocks.children.append on ${parentBlockId} (${batchKey}) failed (${errMessage}) and remote blocks do not match expected batch fingerprints.`,
                  { parentBlockId, batchKey, originalError: errMessage }
                )
              }
            } else if (latestChildren.length > expectedStartIndex) {
              throw createAmbiguousReconciliationError(
                `Uncertain blocks.children.append on ${parentBlockId} (${batchKey}) left partial blocks (${latestChildren.length} vs expected ${expectedStartIndex + batch.length}): ${errMessage}`,
                { parentBlockId, batchKey, originalError: errMessage }
              )
            }
          }
        }

        if (!returnedBlocks) {
          throw appendErr
        }
      }

      checkpoint?.recordCompletedBatch?.({
        batchKey,
        parentBlockId,
        batchIndex: batchIdx,
        expectedStartIndex,
        sourceBlockIds,
        targetBlockIds: (returnedBlocks || []).map(
          (b, idx) => b?.id || `${parentBlockId}-child-${batchIdx}-${idx}`
        ),
        blockFingerprints: batchFingerprints,
      })
    }

    expectedStartIndex += batch.length
    context.stats.totalWrittenTopOrBatchBlocks += childrenPayload.length

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!
      const createdBlock = returnedBlocks?.[i]
      const createdBlockId =
        createdBlock?.id ||
        recordedBatch?.targetBlockIds?.[i] ||
        `${parentBlockId}-child-${batchIdx}-${i}`

      if (item.inlineCreatedCount) {
        context.stats.totalRecreatedNestedBlocks += item.inlineCreatedCount
      }

      if (context.depth > 0) {
        context.stats.totalRecreatedNestedBlocks += 1
      }

      const itemSourceKey =
        item.sourceNode?.id ||
        item.sourceNode?.position ||
        `${batchIdx}-${i}`

      if (item.deferredChildren && item.deferredChildren.length > 0) {
        await appendTranslatedBlockTree(
          client,
          createdBlockId,
          item.deferredChildren,
          {
            ...context,
            depth: (context.depth || 0) + 1,
            parentKey: `${parentKey}:node:${itemSourceKey}`,
            initialExistingChildCount: item.inlineCreatedCount || 0,
          }
        )
      }

      if (
        item.columnFollowUps &&
        item.columnFollowUps.length > 0 &&
        createdBlock?.id
      ) {
        const createdColumns = await listAllRawBlockChildren(
          client,
          createdBlock.id,
          {
            ...(context.options || {}),
            logger,
            retryOptions: context.retryOptions,
          }
        )
        for (const followUp of item.columnFollowUps) {
          const targetCol = createdColumns[followUp.columnIndex]
          if (!targetCol?.id) continue
          if (followUp.firstChildDeferredChildren?.length > 0) {
            const colKids = await listAllRawBlockChildren(client, targetCol.id, {
              ...(context.options || {}),
              logger,
              retryOptions: context.retryOptions,
            })
            const firstKid = colKids[0]
            if (firstKid?.id) {
              await appendTranslatedBlockTree(
                client,
                firstKid.id,
                followUp.firstChildDeferredChildren,
                {
                  ...context,
                  depth: (context.depth || 0) + 3,
                  parentKey: `${parentKey}:node:${itemSourceKey}:col:${followUp.columnIndex}:firstKid:${followUp.firstChildSourceId || 0}`,
                  initialExistingChildCount:
                    followUp.firstChildInlineCount || 0,
                }
              )
            }
          }
          if (followUp.remainingColumnChildren?.length > 0) {
            await appendTranslatedBlockTree(
              client,
              targetCol.id,
              followUp.remainingColumnChildren,
              {
                ...context,
                depth: (context.depth || 0) + 2,
                parentKey: `${parentKey}:node:${itemSourceKey}:col:${followUp.columnIndex}`,
                initialExistingChildCount:
                  followUp.initialColumnChildCount || 0,
              }
            )
          }
        }
      }
    }
  }
}

export interface CreateTranslatedNotionPageOptions extends AssetWriteOptions {
  client?: Client
  dataSourceInfo?: Partial<ArticlesDataSourceInfo> | null
  parentKind?: DiscoveredPageParentKind
  parentTargetPageId?: string | null
  pagePropertiesPayload?:
    | TranslatedPagePropertiesPayload
    | Record<string, unknown>
  onTargetPageCreated?: (targetPage: {
    id: string
    url?: string
    properties?: Record<string, unknown>
  }) => Promise<void> | void
  onWriteChildPage?: (
    params: ChildPageWriteRequest
  ) => Promise<ChildPageWriteResponse | null>
  reconcileCreatedPage?: () => Promise<NotionPageLike | null>
  resumeTargetPageId?: string | null
  isResuming?: boolean
  localizedPageMap?: Map<string, PageWorkflowMeta>
  translatedDatabaseIds?: Set<string>
  maxBlocksPerAppend?: number
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
    dataSourceInfo,
    parentKind = 'database',
    parentTargetPageId = null,
    pagePropertiesPayload,
    onTargetPageCreated,
    onWriteChildPage,
    reconcileCreatedPage,
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
      localizedPageMap,
      translatedDatabaseIds,
      maxBlocksPerAppend,
      depth: 0,
      stats,
      logger,
      options,
    }
    for (const node of rootNodes) {
      const nodeType = String(node?.type || node?.raw?.type || '')
      if (nodeType === 'child_page' && typeof onWriteChildPage === 'function') {
        const dryChild = await onWriteChildPage({
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
  type CreatedTargetPage = {
    id: string
    url?: string
    properties?: Record<string, unknown>
  }
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
