import { classifyBlock, classifyRichTextRun } from './block-classifier'
import { normalizeTreeNodes, extractBlockPlainText } from './reader'
import {
  findPropertyEntry,
  findTitlePropertyKey,
  getPropertyPlainText,
} from './notion-client'
import type {
  LinkedResourceIssue,
  NotionBlockNode,
  NotionBlockTree,
  NotionPageLike,
  SyncedBlockIssue,
  TranslationItem,
  TranslationManifest,
  UnsupportedBlockIssue,
} from './types'

interface RawRichTextSegment {
  type?: string
  plain_text?: string
  href?: string | null
  annotations?: Record<string, unknown>
  text?: {
    content?: string
    link?: { url?: string } | null
  }
  equation?: {
    expression?: string
  }
  mention?: Record<string, unknown>
}

export function formatRichTextContext(richTextArr: unknown): string {
  if (!Array.isArray(richTextArr)) return ''
  return (richTextArr as RawRichTextSegment[])
    .map((r) => {
      const text =
        r?.text?.content ?? r?.plain_text ?? r?.equation?.expression ?? ''
      if (!text) return ''
      if (r?.type === 'equation') return `$${text}$`
      if (r?.annotations?.code) return `\`${text}\``
      return text
    })
    .join('')
}

export function getLeadingWhitespace(str: string): string {
  const m = String(str || '').match(/^\s+/)
  return m ? m[0] : ''
}

export function getTrailingWhitespace(str: string): string {
  const m = String(str || '').match(/\s+$/)
  return m ? m[0] : ''
}

export interface MermaidLabelSpan {
  index: number
  start: number
  end: number
  text: string
  wasQuoted: boolean
}

const MERMAID_KEYWORD_ONLY = new Set([
  'graph',
  'flowchart',
  'sequencediagram',
  'classdiagram',
  'statediagram',
  'statediagram-v2',
  'erdiagram',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'subgraph',
  'end',
  'direction',
  'tb',
  'td',
  'bt',
  'rl',
  'lr',
  'participant',
  'actor',
  'class',
  'style',
  'classdef',
  'click',
  'linkstyle',
])

/**
 * Extracts safe human-readable display label spans from a Mermaid diagram without
 * touching Mermaid syntax, node IDs, arrows, or styling directives.
 */
export function extractMermaidLabelSpans(
  mermaidCode: string
): MermaidLabelSpan[] {
  if (!mermaidCode || typeof mermaidCode !== 'string') return []
  const rawSpans: Array<Omit<MermaidLabelSpan, 'index'>> = []

  const overlapsExisting = (start: number, end: number): boolean =>
    rawSpans.some((s) => start < s.end && end > s.start)

  const isTranslatableLabelText = (text: string): boolean => {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length < 2) return false
    if (!/\p{L}/u.test(trimmed)) return false
    if (MERMAID_KEYWORD_ONLY.has(trimmed.toLowerCase())) return false
    if (/^(https?:\/\/|#[0-9a-f]{3,8}$)/i.test(trimmed)) return false
    return true
  }

  // 1. Quoted labels inside node shapes, edge labels, subgraph titles, or state aliases:
  //    e.g. A["Label"], B("Label"), C{"Label"}, |"Label"|, subgraph "Label", state "Label" as S1
  const quotedPattern =
    /(?:\[\s*|(\(\s*)|\{\s*|\|\s*|\bsubgraph\s+(?:[A-Za-z0-9_-]+\s+)?|\bstate\s+)"([^"\r\n]+)"/g
  let match: RegExpExecArray | null
  while ((match = quotedPattern.exec(mermaidCode)) !== null) {
    const labelText = match[2]
    if (!labelText || !isTranslatableLabelText(labelText)) continue
    const quoteIdx = match[0].indexOf(`"${labelText}"`)
    if (quoteIdx === -1) continue
    const contentStart = match.index + quoteIdx + 1
    const contentEnd = contentStart + labelText.length
    if (!overlapsExisting(contentStart, contentEnd)) {
      rawSpans.push({
        start: contentStart,
        end: contentEnd,
        text: labelText,
        wasQuoted: true,
      })
    }
  }

  // 2. Unquoted simple node/edge labels:
  //    e.g. A[User Request], B(Process Incident), C{Is Approved?}, -->|Yes|
  const unquotedNodePattern =
    /\b([A-Za-z0-9_]+)\s*(\[|\(|\{)([^[\](){}|"\r\n;]+)(\]|\)|\})/g
  while ((match = unquotedNodePattern.exec(mermaidCode)) !== null) {
    const nodeId = match[1]
    const openChar = match[2]
    const labelText = match[3]
    const closeChar = match[4]
    if (!labelText || !isTranslatableLabelText(labelText)) continue
    if (MERMAID_KEYWORD_ONLY.has(nodeId.toLowerCase())) continue
    const validPair =
      (openChar === '[' && closeChar === ']') ||
      (openChar === '(' && closeChar === ')') ||
      (openChar === '{' && closeChar === '}')
    if (!validPair) continue

    const prefixLen = match[0].indexOf(openChar) + 1
    const contentStart = match.index + prefixLen
    const contentEnd = contentStart + labelText.length
    if (!overlapsExisting(contentStart, contentEnd)) {
      rawSpans.push({
        start: contentStart,
        end: contentEnd,
        text: labelText,
        wasQuoted: false,
      })
    }
  }

  // 3. Unquoted edge labels: -->|Approve Request|
  const unquotedEdgePattern = /\|([^[\](){}|"\r\n;]+)\|/g
  while ((match = unquotedEdgePattern.exec(mermaidCode)) !== null) {
    const labelText = match[1]
    if (!labelText || !isTranslatableLabelText(labelText)) continue
    const contentStart = match.index + 1
    const contentEnd = contentStart + labelText.length
    if (!overlapsExisting(contentStart, contentEnd)) {
      rawSpans.push({
        start: contentStart,
        end: contentEnd,
        text: labelText,
        wasQuoted: false,
      })
    }
  }

  rawSpans.sort((a, b) => a.start - b.start)
  return rawSpans.map((span, index) => ({
    index,
    ...span,
  }))
}

export interface ExtractManifestOptions {
  sourcePage?: NotionPageLike | null
  articleTitle?: string
}

/**
 * Builds a structured translation manifest with stable IDs for every translatable
 * rich_text run across page properties (Title, Summary) and the raw Notion block tree.
 */
export function extractTranslationManifest(
  rawTree: NotionBlockTree | NotionBlockNode[],
  options: ExtractManifestOptions = {}
): TranslationManifest {
  const { sourcePage = null, articleTitle: explicitTitle = '' } = options

  const items: TranslationItem[] = []
  const itemsById = new Map<string, TranslationItem>()
  const unsupportedBlocks: UnsupportedBlockIssue[] = []
  const linkedResources: LinkedResourceIssue[] = []
  const syncedBlocks: SyncedBlockIssue[] = []

  let totalSourceBlocks = 0
  let totalTranslatableBlocks = 0
  let totalPreservedBlocks = 0
  let totalNestedBlocks = 0

  let resolvedArticleTitle = explicitTitle

  function addItem(entry: TranslationItem): void {
    items.push(entry)
    itemsById.set(entry.id, entry)
  }

  // 1. Extract page-level Title & Summary runs if sourcePage is provided
  if (sourcePage && sourcePage.properties) {
    const props = sourcePage.properties as Record<string, Record<string, unknown>>
    const titleKey = findTitlePropertyKey(props)
    const titleProp = props[titleKey]
    if (titleProp && Array.isArray(titleProp.title)) {
      const fullTitle = getPropertyPlainText(titleProp)
      if (!resolvedArticleTitle && fullTitle) {
        resolvedArticleTitle = fullTitle
      }
      ;(titleProp.title as RawRichTextSegment[]).forEach((run, runIndex) => {
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

    const { key: summaryKey, prop: summaryProp } = findPropertyEntry(props, [
      'Summary',
      'Description',
    ])
    if (summaryKey && summaryProp && Array.isArray(summaryProp.rich_text)) {
      const fullSummary = getPropertyPlainText(summaryProp)
      ;(summaryProp.rich_text as RawRichTextSegment[]).forEach(
        (run, runIndex) => {
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
        }
      )
    }
  }

  // 2. Traverse raw block tree in original order
  const rootNodes = normalizeTreeNodes(rawTree)
  let currentHeading = ''

  function extractFromRichTextArray(params: {
    richTextArray: unknown
    blockId: string
    blockType: string
    fieldPath: string
    idPrefix: string
    parentHeading: string
    prevBlockText: string
    nextBlockText: string
  }): number {
    const {
      richTextArray,
      blockId,
      blockType,
      fieldPath,
      idPrefix,
      parentHeading,
      prevBlockText,
      nextBlockText,
    } = params

    if (!Array.isArray(richTextArray) || richTextArray.length === 0) return 0
    const fullBlockText = formatRichTextContext(richTextArray)
    let extractedCount = 0

    ;(richTextArray as RawRichTextSegment[]).forEach((run, runIndex) => {
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

  function walkList(
    nodes: NotionBlockNode[],
    depth = 0,
    inheritedHeading = ''
  ): void {
    let activeHeading = inheritedHeading || currentHeading

    for (let idx = 0; idx < nodes.length; idx++) {
      const node = nodes[idx]
      if (!node) continue

      const raw = (node.raw || node) as Record<string, unknown>
      const blockId =
        node.id || String(raw.id || `pos-${node.position || idx}`)
      const blockType = String(node.type || raw.type || 'unsupported')
      const position = node.position ?? String(idx)

      totalSourceBlocks += 1
      if (depth > 0) {
        totalNestedBlocks += 1
      }

      const prevNode = idx > 0 ? nodes[idx - 1] : null
      const nextNode = idx < nodes.length - 1 ? nodes[idx + 1] : null
      const prevBlockText = prevNode
        ? prevNode.text || extractBlockPlainText(prevNode.raw || prevNode)
        : ''
      const nextBlockText = nextNode
        ? nextNode.text || extractBlockPlainText(nextNode.raw || nextNode)
        : ''

      const classification = classifyBlock(node)

      if (
        !classification.supported ||
        classification.category === 'unsupported'
      ) {
        unsupportedBlocks.push({
          id: blockId,
          type: blockType,
          position,
        })
        continue
      }

      const payload = (raw[blockType] || {}) as Record<string, unknown>

      if (classification.category === 'linked_resource') {
        linkedResources.push({
          id: blockId,
          type: blockType,
          resourceType: classification.resourceType,
          title: String(payload.title || node.text || ''),
          position,
          referencedId:
            blockType === 'link_to_page'
              ? String(payload.page_id || payload.database_id || '') || null
              : blockId,
        })
        totalPreservedBlocks += 1
        continue
      }

      if (classification.category === 'special_synced') {
        const syncedBlockPayload = raw.synced_block as
          | { synced_from?: { block_id?: string } | null }
          | undefined
        const syncedFromId =
          syncedBlockPayload?.synced_from?.block_id ||
          node.syncedFromBlockId ||
          null
        syncedBlocks.push({
          id: blockId,
          position,
          isReference: Boolean(syncedFromId),
          syncedFromBlockId: syncedFromId,
        })
      }

      let extractedInBlock = 0

      if (/^heading_[1-6]$/.test(blockType)) {
        const headingPlain = formatRichTextContext(payload.rich_text)
        if (headingPlain) {
          activeHeading = headingPlain
          currentHeading = headingPlain
        }
      }

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
        } else if (
          field === 'cells' &&
          blockType === 'table_row' &&
          Array.isArray(payload.cells)
        ) {
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

      if (
        blockType === 'code' &&
        classification.isMermaidCodeBlock &&
        Array.isArray(payload.rich_text) &&
        payload.rich_text.length > 0
      ) {
        const fullMermaidCode = formatRichTextContext(payload.rich_text)
        const mermaidSpans = extractMermaidLabelSpans(fullMermaidCode)
        for (const span of mermaidSpans) {
          addItem({
            id: `block:${blockId}:mermaid_label:${span.index}`,
            kind: 'block',
            sourceBlockId: blockId,
            blockType: 'mermaid_label',
            fieldPath: `code.mermaid_label.${span.index}`,
            runIndex: span.index,
            text: span.text,
            leadingSpace: getLeadingWhitespace(span.text),
            trailingSpace: getTrailingWhitespace(span.text),
            annotations: null,
            href: null,
            context: {
              articleTitle: resolvedArticleTitle,
              parentHeading: activeHeading || 'Mermaid Diagram',
              fullBlockText: fullMermaidCode,
            },
          })
          extractedInBlock += 1
        }
      }

      if (extractedInBlock > 0) {
        totalTranslatableBlocks += 1
      } else {
        totalPreservedBlocks += 1
      }

      if (Array.isArray(node.children) && node.children.length > 0) {
        walkList(node.children, depth + 1, activeHeading)
      }
    }
  }

  walkList(rootNodes, 0, '')

  return {
    articleTitle: resolvedArticleTitle,
    sourcePageId:
      sourcePage?.id || (rawTree as NotionBlockTree)?.pageId || null,
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

