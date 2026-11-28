import { normalizeTreeNodes } from '../reader'
import type {
  NotionBlockNode,
  NotionBlockTree,
  NotionRawBlock,
} from '../types'

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

/**
 * Verifies that an already-partially-written target page starts with a valid structural
 * block-type prefix of the English source tree before allowing a resume.
 */
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

/**
 * Compares a slice of remote Notion blocks against the expected deterministic fingerprints
 * of a prepared write batch.
 */
export function verifySliceFingerprints(
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
