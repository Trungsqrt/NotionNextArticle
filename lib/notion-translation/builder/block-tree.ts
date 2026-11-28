import { classifyBlock } from '../block-classifier'
import {
  attachTreeMeta,
  deepClone,
  extractBlockPlainText,
  normalizeTreeNodes,
} from '../reader'
import { normalizeNotionId } from '../notion-client'
import type {
  NotionBlockNode,
  NotionBlockTree,
  ReferenceResolutionMap,
} from '../types'
import {
  rebuildRichTextArray,
  type TranslationLookupInput,
} from './rich-text'

/**
 * Reconstructs the Notion block tree with translated text while preserving
 * all original block types, hierarchy, annotations, code, formulas, links, and metadata.
 */
export function buildTranslatedBlockTree(
  rawTree: NotionBlockTree | NotionBlockNode[],
  translationResult: TranslationLookupInput,
  options: {
    sourcePageId?: string
    referenceMap?: ReferenceResolutionMap | null
  } = {}
): NotionBlockTree {
  const rootNodes = normalizeTreeNodes(rawTree)
  const referenceMap = options.referenceMap || null

  function buildNode(node: NotionBlockNode): NotionBlockNode {
    const clonedRaw = deepClone(node.raw || node) as Record<string, unknown>
    const blockId =
      node.id || String(clonedRaw.id || `pos-${node.position || '0'}`)
    const blockType = String(node.type || clonedRaw.type || 'unsupported')
    const classification = classifyBlock(node)
    const payload = clonedRaw[blockType]
      ? deepClone(clonedRaw[blockType] as Record<string, unknown>)
      : {}

    if (classification.supported) {
      for (const field of classification.translatableFields) {
        if (field === 'rich_text' && Array.isArray(payload.rich_text)) {
          payload.rich_text = rebuildRichTextArray(
            payload.rich_text,
            `block:${blockId}:rich_text`,
            translationResult,
            referenceMap
          )
        } else if (field === 'caption' && Array.isArray(payload.caption)) {
          payload.caption = rebuildRichTextArray(
            payload.caption,
            `block:${blockId}:caption`,
            translationResult,
            referenceMap
          )
        } else if (
          field === 'cells' &&
          blockType === 'table_row' &&
          Array.isArray(payload.cells)
        ) {
          payload.cells = payload.cells.map((cellRichText, cellIndex) =>
            rebuildRichTextArray(
              cellRichText,
              `block:${blockId}:cells:${cellIndex}`,
              translationResult,
              referenceMap
            )
          )
        }
      }

      if (blockType === 'child_page' && referenceMap) {
        const localizedMeta =
          referenceMap.localizedPageMetaBySourcePageId.get(
            normalizeNotionId(blockId)
          )
        if (localizedMeta?.title) {
          payload.title = localizedMeta.title
        }
      }
    }

    if (blockType === 'synced_block') {
      payload.synced_from = null
    }

    clonedRaw[blockType] = payload

    const builtChildren = Array.isArray(node.children)
      ? node.children.map((child) => buildNode(child))
      : []

    return {
      id: blockId,
      sourceBlockId: blockId,
      type: blockType,
      position: node.position,
      depth: node.depth ?? 0,
      has_children: builtChildren.length > 0 || Boolean(node.has_children),
      classification,
      text: extractBlockPlainText(clonedRaw),
      raw: clonedRaw as NotionBlockNode['raw'],
      children: builtChildren,
    }
  }

  const translatedNodes = rootNodes.map((node) => buildNode(node))
  return attachTreeMeta(translatedNodes, {
    pageId:
      (rawTree as NotionBlockTree)?.pageId || options.sourcePageId || null,
  })
}
