import type { Client } from '@notionhq/client'
import {
  createNotionClient,
  paginateNotionList,
  withNotionRetry,
  type NotionOperationOptions,
} from './notion-client'
import { getTranslationConfig } from './config'
import type {
  NotionBlockNode,
  NotionBlockTree,
  NotionRawBlock,
} from './types'
import { defaultLogger } from '../../worker/logger'

export function deepClone<T>(obj: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(obj)
  }
  return JSON.parse(JSON.stringify(obj)) as T
}

function richTextToPlain(richTextArr: unknown): string {
  if (!Array.isArray(richTextArr)) return ''
  return richTextArr
    .map((r) => {
      if (!r || typeof r !== 'object') return ''
      const item = r as Record<string, unknown>
      if (typeof item.plain_text === 'string') return item.plain_text
      const text = item.text as Record<string, unknown> | undefined
      if (typeof text?.content === 'string') return text.content
      const eq = item.equation as Record<string, unknown> | undefined
      if (typeof eq?.expression === 'string') return eq.expression
      return ''
    })
    .join('')
}

export function extractBlockPlainText(block: unknown): string {
  if (!block || typeof block !== 'object') return ''
  const record = block as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (!type) return ''

  const payload = record[type] as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return ''

  if (Array.isArray(payload.rich_text)) {
    return richTextToPlain(payload.rich_text)
  }
  if (type === 'equation' && typeof payload.expression === 'string') {
    return payload.expression
  }
  if (type === 'child_page' && typeof payload.title === 'string') {
    return payload.title
  }
  if (type === 'child_database' && typeof payload.title === 'string') {
    return payload.title
  }
  if (type === 'table_row' && Array.isArray(payload.cells)) {
    return payload.cells.map((cell) => richTextToPlain(cell)).join(' | ')
  }
  if (Array.isArray(payload.caption) && payload.caption.length > 0) {
    return richTextToPlain(payload.caption)
  }
  return ''
}

export function countTreeBlocks(
  nodes: NotionBlockNode[] | NotionBlockTree | null | undefined
): number {
  const list = Array.isArray(nodes)
    ? nodes
    : nodes && typeof nodes === 'object' && Array.isArray((nodes as NotionBlockTree).blocks)
      ? (nodes as NotionBlockTree).blocks!
      : []

  let count = 0
  for (const node of list) {
    if (!node) continue
    count += 1
    if (Array.isArray(node.children) && node.children.length > 0) {
      count += countTreeBlocks(node.children)
    }
  }
  return count
}

export function attachTreeMeta(
  nodes: NotionBlockNode[],
  meta: { pageId?: string | null; totalBlocks?: number } = {}
): NotionBlockTree {
  const tree = nodes as NotionBlockTree
  Object.defineProperties(tree, {
    blocks: {
      value: nodes,
      enumerable: false,
      configurable: true,
    },
    pageId: {
      value: meta.pageId || null,
      enumerable: false,
      configurable: true,
    },
    totalBlocks: {
      value: meta.totalBlocks ?? countTreeBlocks(nodes),
      enumerable: false,
      configurable: true,
    },
  })
  return tree
}

export function normalizeTreeNodes(treeOrNodes: unknown): NotionBlockNode[] {
  if (!treeOrNodes) return []
  if (Array.isArray(treeOrNodes)) return treeOrNodes as NotionBlockNode[]
  if (typeof treeOrNodes === 'object') {
    const obj = treeOrNodes as {
      blocks?: NotionBlockNode[]
      type?: string
      children?: NotionBlockNode[]
    }
    if (Array.isArray(obj.blocks)) return obj.blocks
    if (obj.type && Array.isArray(obj.children)) {
      return [treeOrNodes as NotionBlockNode]
    }
  }
  return []
}

async function fetchRawChildrenPage(
  client: Client,
  blockId: string,
  startCursor: string | undefined,
  options: NotionOperationOptions = {}
) {
  const logger = options.logger || defaultLogger
  return withNotionRetry(
    () =>
      client.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(startCursor ? { start_cursor: startCursor } : {}),
      }),
    {
      isIdempotent: true,
      label: `blocks.children.list(${blockId})`,
      logger,
      ...options.retryOptions,
    }
  )
}

export async function listAllRawBlockChildren(
  client: Client,
  blockId: string,
  options: NotionOperationOptions = {}
): Promise<NotionRawBlock[]> {
  const rawItems = await paginateNotionList(
    (cursor) => fetchRawChildrenPage(client, blockId, cursor, options),
    {
      label: `listAllRawBlockChildren(${blockId})`,
      maxPaginationPages: options.maxPaginationPages,
      config: options.config,
    }
  )

  return rawItems.map((item) => deepClone(item as NotionRawBlock))
}

export interface ReadRawNotionTreeOptions extends NotionOperationOptions {
  client?: Client
  notion?: Client
}

/**
 * Recursively retrieves the original raw Notion block structure for a page or block.
 * Independent from `lib/notion.js` — never mutates `[slider]` toggles or embedded databases.
 */
export async function readRawNotionTree(
  arg1: string | Client,
  arg2: ReadRawNotionTreeOptions | string = {},
  arg3: ReadRawNotionTreeOptions = {}
): Promise<NotionBlockTree> {
  let pageId: string
  let options: ReadRawNotionTreeOptions

  if (typeof arg1 === 'string') {
    pageId = arg1
    options = (typeof arg2 === 'object' && arg2 !== null ? arg2 : {}) as ReadRawNotionTreeOptions
  } else if (arg1 && typeof arg1 === 'object' && typeof arg2 === 'string') {
    pageId = arg2
    options = { ...arg3, client: arg1 }
  } else {
    throw new Error('readRawNotionTree requires a valid pageId string')
  }

  const config = options.config || getTranslationConfig()
  const client = options.client || options.notion || createNotionClient(config)
  const visitedBlockIds = new Set<string>()

  async function readBranch(
    parentBlockId: string,
    parentPositionPrefix = '',
    depth = 0
  ): Promise<NotionBlockNode[]> {
    const rawBlocks = await listAllRawBlockChildren(client, parentBlockId, options)
    const nodes: NotionBlockNode[] = []

    for (let index = 0; index < rawBlocks.length; index++) {
      const rawBlock = rawBlocks[index]
      const position = parentPositionPrefix
        ? `${parentPositionPrefix}.${index}`
        : `${index}`
      const blockId = rawBlock.id || `anon-${position}`

      const isSeparateResourceBlock =
        rawBlock.type === 'child_page' || rawBlock.type === 'child_database'

      const node: NotionBlockNode = {
        id: blockId,
        type: rawBlock.type || 'unsupported',
        position,
        depth,
        has_children: isSeparateResourceBlock
          ? false
          : Boolean(rawBlock.has_children),
        text: extractBlockPlainText(rawBlock),
        raw: deepClone(rawBlock),
        children: [],
      }

      const shouldFetchChildren =
        !isSeparateResourceBlock &&
        Boolean(rawBlock.has_children) &&
        Boolean(rawBlock.id) &&
        !visitedBlockIds.has(rawBlock.id!)

      if (shouldFetchChildren && rawBlock.id) {
        visitedBlockIds.add(rawBlock.id)
        node.children = await readBranch(rawBlock.id, position, depth + 1)
      } else {
        const syncedBlockPayload = (rawBlock as Record<string, unknown>)
          .synced_block as
          | { synced_from?: { block_id?: string } | null }
          | undefined
        const refId = syncedBlockPayload?.synced_from?.block_id
        if (
          rawBlock.type === 'synced_block' &&
          !rawBlock.has_children &&
          refId &&
          !visitedBlockIds.has(refId)
        ) {
          visitedBlockIds.add(refId)
          try {
            node.children = await readBranch(refId, position, depth + 1)
            node.syncedFromBlockId = refId
          } catch {
            // Reference block may not be shared with integration; leave children empty and report later
            node.syncedFromBlockId = refId
          }
        }
      }

      nodes.push(node)
    }

    return nodes
  }

  const rootNodes = await readBranch(pageId, '', 0)
  const totalBlocks = countTreeBlocks(rootNodes)
  return attachTreeMeta(rootNodes, { pageId, totalBlocks })
}

