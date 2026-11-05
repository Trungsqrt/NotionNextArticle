'use strict'

const { classifyBlock, classifyRichTextRun } = require('./block-classifier')
const { normalizeTreeNodes, extractBlockPlainText } = require('./reader')
const { findPropertyEntry, findTitlePropertyKey, getPropertyPlainText } = require('./notion-client')

function formatRichTextContext(richTextArr) {
  if (!Array.isArray(richTextArr)) return ''
  return richTextArr
    .map(r => {
      const text = r?.text?.content ?? r?.plain_text ?? r?.equation?.expression ?? ''
      if (!text) return ''
      if (r?.type === 'equation') return `$${text}$`
      if (r?.annotations?.code) return `\`${text}\``
      return text
    })
    .join('')
}

function getLeadingWhitespace(str) {
  const m = String(str || '').match(/^\s+/)
  return m ? m[0] : ''
}

function getTrailingWhitespace(str) {
  const m = String(str || '').match(/\s+$/)
  return m ? m[0] : ''
}

/**
 * Builds a structured translation manifest with stable IDs for every translatable
 * rich_text run across page properties (Title, Summary) and the raw Notion block tree.
 *
 * Preserves:
 * - Run boundaries & annotations (bold, italic, underline, strikethrough, color)
 * - Inline code (`annotations.code === true`) untouched
 * - Inline equations (`type === 'equation'`) untouched
 * - Mentions (`type === 'mention'`) untouched
 * - Hyperlink URLs (`href` / `text.link.url`) untouched
 */
function extractTranslationManifest(rawTree, options = {}) {
  const {
    sourcePage = null,
    articleTitle: explicitTitle = '',
  } = options

  const items = []
  const itemsById = new Map()
  const unsupportedBlocks = []
  const linkedResources = []
  const syncedBlocks = []

  let totalSourceBlocks = 0
  let totalTranslatableBlocks = 0
  let totalPreservedBlocks = 0
  let totalNestedBlocks = 0

  let resolvedArticleTitle = explicitTitle

  function addItem(entry) {
    items.push(entry)
    itemsById.set(entry.id, entry)
  }

  // 1. Extract page-level Title & Summary runs if sourcePage is provided
  if (sourcePage && sourcePage.properties) {
    const props = sourcePage.properties
    const titleKey = findTitlePropertyKey(props)
    const titleProp = props[titleKey]
    if (titleProp && Array.isArray(titleProp.title)) {
      const fullTitle = getPropertyPlainText(titleProp)
      if (!resolvedArticleTitle && fullTitle) {
        resolvedArticleTitle = fullTitle
      }
      titleProp.title.forEach((run, runIndex) => {
        const check = classifyRichTextRun(run)
        if (!check.translatable) return
        const rawText = run.text?.content ?? run.plain_text ?? ''
        addItem({
          id: `prop:title:run:${runIndex}`,
          kind: 'property',
          propertyName: titleKey,
          propertyType: 'title',
          sourceBlockId: 'page_properties',
          blockType: 'page_title',
          fieldPath: `properties.${titleKey}.title`,
          runIndex,
          text: rawText,
          leadingSpace: getLeadingWhitespace(rawText),
          trailingSpace: getTrailingWhitespace(rawText),
          annotations: run.annotations ? { ...run.annotations } : null,
          href: run.href || run.text?.link?.url || null,
          context: {
            articleTitle: resolvedArticleTitle,
            parentHeading: '',
            fullBlockText: fullTitle,
          },
        })
      })
    }

    const { key: summaryKey, prop: summaryProp } = findPropertyEntry(props, ['Summary', 'Description'])
    if (summaryKey && summaryProp && Array.isArray(summaryProp.rich_text)) {
      const fullSummary = getPropertyPlainText(summaryProp)
      summaryProp.rich_text.forEach((run, runIndex) => {
        const check = classifyRichTextRun(run)
        if (!check.translatable) return
        const rawText = run.text?.content ?? run.plain_text ?? ''
        addItem({
          id: `prop:summary:run:${runIndex}`,
          kind: 'property',
          propertyName: summaryKey,
          propertyType: 'rich_text',
          sourceBlockId: 'page_properties',
          blockType: 'page_summary',
          fieldPath: `properties.${summaryKey}.rich_text`,
          runIndex,
          text: rawText,
          leadingSpace: getLeadingWhitespace(rawText),
          trailingSpace: getTrailingWhitespace(rawText),
          annotations: run.annotations ? { ...run.annotations } : null,
          href: run.href || run.text?.link?.url || null,
          context: {
            articleTitle: resolvedArticleTitle,
            parentHeading: '',
            fullBlockText: fullSummary,
          },
        })
      })
    }
  }

  // 2. Traverse raw block tree in original order
  const rootNodes = normalizeTreeNodes(rawTree)
  let currentHeading = ''

  function extractFromRichTextArray({
    richTextArray,
    blockId,
    blockType,
    fieldPath,
    idPrefix,
    parentHeading,
    prevBlockText,
    nextBlockText,
  }) {
    if (!Array.isArray(richTextArray) || richTextArray.length === 0) return 0
    const fullBlockText = formatRichTextContext(richTextArray)
    let extractedCount = 0

    richTextArray.forEach((run, runIndex) => {
      const check = classifyRichTextRun(run)
      if (!check.translatable) return
      const rawText = run.text?.content ?? run.plain_text ?? ''
      addItem({
        id: `${idPrefix}:run:${runIndex}`,
        kind: 'block',
        sourceBlockId: blockId,
        blockType,
        fieldPath,
        runIndex,
        text: rawText,
        leadingSpace: getLeadingWhitespace(rawText),
        trailingSpace: getTrailingWhitespace(rawText),
        annotations: run.annotations ? { ...run.annotations } : null,
        href: run.href || run.text?.link?.url || null,
        context: {
          articleTitle: resolvedArticleTitle,
          parentHeading: parentHeading || '',
          fullBlockText,
          ...(prevBlockText ? { prevBlockText } : {}),
          ...(nextBlockText ? { nextBlockText } : {}),
        },
      })
      extractedCount += 1
    })

    return extractedCount
  }

  function walkList(nodes, depth = 0, inheritedHeading = '') {
    let activeHeading = inheritedHeading || currentHeading

    for (let idx = 0; idx < nodes.length; idx++) {
      const node = nodes[idx]
      if (!node) continue

      const raw = node.raw || node
      const blockId = node.id || raw.id || `pos-${node.position || idx}`
      const blockType = node.type || raw.type || 'unsupported'
      const position = node.position ?? String(idx)

      totalSourceBlocks += 1
      if (depth > 0) {
        totalNestedBlocks += 1
      }

      const prevNode = idx > 0 ? nodes[idx - 1] : null
      const nextNode = idx < nodes.length - 1 ? nodes[idx + 1] : null
      const prevBlockText = prevNode ? (prevNode.text || extractBlockPlainText(prevNode.raw || prevNode)) : ''
      const nextBlockText = nextNode ? (nextNode.text || extractBlockPlainText(nextNode.raw || nextNode)) : ''

      const classification = classifyBlock(node)

      if (!classification.supported || classification.category === 'unsupported') {
        unsupportedBlocks.push({
          id: blockId,
          type: blockType,
          position,
        })
        continue
      }

      if (classification.category === 'linked_resource') {
        const payload = raw[blockType] || {}
        linkedResources.push({
          id: blockId,
          type: blockType,
          resourceType: classification.resourceType,
          title: payload.title || node.text || '',
          position,
          referencedId:
            blockType === 'link_to_page'
              ? (payload.page_id || payload.database_id || null)
              : blockId,
        })
        totalPreservedBlocks += 1
        continue
      }

      if (classification.category === 'special_synced') {
        const syncedFromId = raw.synced_block?.synced_from?.block_id || node.syncedFromBlockId || null
        syncedBlocks.push({
          id: blockId,
          position,
          isReference: Boolean(syncedFromId),
          syncedFromBlockId: syncedFromId,
        })
      }

      const payload = raw[blockType] || {}
      let extractedInBlock = 0

      // Update active heading context when encountering a heading block
      if (/^heading_[1-6]$/.test(blockType)) {
        const headingPlain = formatRichTextContext(payload.rich_text)
        if (headingPlain) {
          activeHeading = headingPlain
          currentHeading = headingPlain
        }
      }

      // Extract standard rich_text / caption fields
      for (const field of classification.translatableFields) {
        if (field === 'rich_text' && Array.isArray(payload.rich_text)) {
          extractedInBlock += extractFromRichTextArray({
            richTextArray: payload.rich_text,
            blockId,
            blockType,
            fieldPath: `${blockType}.rich_text`,
            idPrefix: `block:${blockId}:rich_text`,
            parentHeading: activeHeading,
            prevBlockText,
            nextBlockText,
          })
        } else if (field === 'caption' && Array.isArray(payload.caption)) {
          extractedInBlock += extractFromRichTextArray({
            richTextArray: payload.caption,
            blockId,
            blockType,
            fieldPath: `${blockType}.caption`,
            idPrefix: `block:${blockId}:caption`,
            parentHeading: activeHeading,
            prevBlockText,
            nextBlockText,
          })
        } else if (field === 'cells' && blockType === 'table_row' && Array.isArray(payload.cells)) {
          payload.cells.forEach((cellRichText, cellIndex) => {
            extractedInBlock += extractFromRichTextArray({
              richTextArray: cellRichText,
              blockId,
              blockType,
              fieldPath: `table_row.cells.${cellIndex}`,
              idPrefix: `block:${blockId}:cells:${cellIndex}`,
              parentHeading: activeHeading,
              prevBlockText,
              nextBlockText,
            })
          })
        }
      }

      if (extractedInBlock > 0) {
        totalTranslatableBlocks += 1
      } else {
        totalPreservedBlocks += 1
      }

      // Recurse into children
      if (Array.isArray(node.children) && node.children.length > 0) {
        walkList(node.children, depth + 1, activeHeading)
      }
    }
  }

  walkList(rootNodes, 0, '')

  return {
    articleTitle: resolvedArticleTitle,
    sourcePageId: sourcePage?.id || rawTree?.pageId || null,
    items,
    itemsById,
    stats: {
      totalSourceBlocks,
      totalTranslatableBlocks,
      totalPreservedBlocks,
      totalNestedBlocks,
      totalTranslatableFields: items.length,
      unsupportedBlockCount: unsupportedBlocks.length,
      linkedResourceCount: linkedResources.length,
      syncedBlockCount: syncedBlocks.length,
    },
    unsupportedBlocks,
    linkedResources,
    syncedBlocks,
  }
}

module.exports = {
  extractTranslationManifest,
  formatRichTextContext,
  getLeadingWhitespace,
  getTrailingWhitespace,
}

