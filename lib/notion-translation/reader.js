'use strict'

const { createNotionClient, withNotionRetry } = require('./notion-client')
const { getTranslationConfig } = require('./config')
const { defaultLogger } = require('../../worker/logger')

function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    return structuredClone(obj)
  }
  return JSON.parse(JSON.stringify(obj))
}

function richTextToPlain(richTextArr) {
  if (!Array.isArray(richTextArr)) return ''
  return richTextArr
    .map(r => r?.plain_text ?? r?.text?.content ?? r?.equation?.expression ?? '')
    .join('')
}

function extractBlockPlainText(block) {
  if (!block || !block.type) return ''
  const payload = block[block.type]
  if (!payload || typeof payload !== 'object') return ''

  if (Array.isArray(payload.rich_text)) {
    return richTextToPlain(payload.rich_text)
  }
  if (block.type === 'equation' && typeof payload.expression === 'string') {
    return payload.expression
  }
  if (block.type === 'child_page' && typeof payload.title === 'string') {
    return payload.title
  }
  if (block.type === 'child_database' && typeof payload.title === 'string') {
    return payload.title
  }
  if (block.type === 'table_row' && Array.isArray(payload.cells)) {
    return payload.cells.map(cell => richTextToPlain(cell)).join(' | ')
  }
  if (Array.isArray(payload.caption) && payload.caption.length > 0) {
    return richTextToPlain(payload.caption)
  }
  return ''
}

function attachTreeMeta(nodes, meta = {}) {
  Object.defineProperties(nodes, {
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
  return nodes
}

function countTreeBlocks(nodes) {
  const list = Array.isArray(nodes) ? nodes : (nodes?.blocks || [])
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

function normalizeTreeNodes(treeOrNodes) {
  if (!treeOrNodes) return []
  if (Array.isArray(treeOrNodes)) return treeOrNodes
  if (Array.isArray(treeOrNodes.blocks)) return treeOrNodes.blocks
  if (treeOrNodes.type && Array.isArray(treeOrNodes.children)) return [treeOrNodes]
  return []
}

async function fetchRawChildrenPage(client, blockId, startCursor, options = {}) {
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

async function listAllRawBlockChildren(client, blockId, options = {}) {
  const results = []
  let cursor = undefined
  let pageCount = 0
  const maxPages = options.maxPaginationPages || 200

  while (pageCount < maxPages) {
    const response = await fetchRawChildrenPage(client, blockId, cursor, options)
    const batch = Array.isArray(response?.results) ? response.results : []
    for (const item of batch) {
      results.push(deepClone(item))
    }
    pageCount += 1
    if (!response?.has_more || !response?.next_cursor) {
      break
    }
    cursor = response.next_cursor
  }

  return results
}

/**
 * Recursively retrieves the original raw Notion block structure for a page or block.
 * Independent from `getChildBlocks()` and `getNotionPageData()` in `lib/notion.js` —
 * never mutates `[slider]` toggles or embedded databases.
 *
 * Supports both:
 *   readRawNotionTree(pageId, options)
 *   readRawNotionTree(notionClient, pageId, options)
 */
async function readRawNotionTree(arg1, arg2 = {}, arg3 = {}) {
  let pageId
  let options
  if (typeof arg1 === 'string') {
    pageId = arg1
    options = arg2 || {}
  } else if (arg1 && typeof arg1 === 'object' && typeof arg2 === 'string') {
    pageId = arg2
    options = { ...arg3, client: arg1 }
  } else {
    throw new Error('readRawNotionTree requires a valid pageId string')
  }

  const config = options.config || getTranslationConfig()
  const client = options.client || options.notion || createNotionClient(config)
  const visitedBlockIds = new Set()

  async function readBranch(parentBlockId, parentPositionPrefix = '', depth = 0) {
    const rawBlocks = await listAllRawBlockChildren(client, parentBlockId, options)
    const nodes = []

    for (let index = 0; index < rawBlocks.length; index++) {
      const rawBlock = rawBlocks[index]
      const position = parentPositionPrefix ? `${parentPositionPrefix}.${index}` : `${index}`
      const blockId = rawBlock.id || `anon-${position}`

      const node = {
        id: blockId,
        type: rawBlock.type || 'unsupported',
        position,
        depth,
        has_children: Boolean(rawBlock.has_children),
        text: extractBlockPlainText(rawBlock),
        raw: deepClone(rawBlock),
        children: [],
      }

      const shouldFetchChildren = Boolean(rawBlock.has_children) && rawBlock.id && !visitedBlockIds.has(rawBlock.id)
      if (shouldFetchChildren) {
        visitedBlockIds.add(rawBlock.id)
        node.children = await readBranch(rawBlock.id, position, depth + 1)
      } else if (
        rawBlock.type === 'synced_block' &&
        !rawBlock.has_children &&
        rawBlock.synced_block?.synced_from?.block_id &&
        !visitedBlockIds.has(rawBlock.synced_block.synced_from.block_id)
      ) {
        const refId = rawBlock.synced_block.synced_from.block_id
        visitedBlockIds.add(refId)
        try {
          node.children = await readBranch(refId, position, depth + 1)
          node.syncedFromBlockId = refId
        } catch {
          // Reference block may not be shared with integration; leave children empty and report later
          node.syncedFromBlockId = refId
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

module.exports = {
  readRawNotionTree,
  listAllRawBlockChildren,
  extractBlockPlainText,
  countTreeBlocks,
  normalizeTreeNodes,
  attachTreeMeta,
  deepClone,
}

