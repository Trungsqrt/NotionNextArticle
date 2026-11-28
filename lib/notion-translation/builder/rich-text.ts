import { extractMermaidLabelSpans } from '../extractor'
import { deepClone } from '../reader'
import { normalizeNotionId } from '../notion-client'
import type { ReferenceResolutionMap, TranslateManifestResult } from '../types'

export const NOTION_MAX_RICH_TEXT_LENGTH = 2000

export type TranslationLookupInput =
  | Map<string, string>
  | TranslateManifestResult
  | Record<string, string>
  | null
  | undefined

export function getTranslationValue(
  translationsMapOrResult: TranslationLookupInput,
  id: string
): string | undefined {
  if (!translationsMapOrResult) return undefined
  if (translationsMapOrResult instanceof Map) {
    return translationsMapOrResult.get(id)
  }
  if (
    'translationsById' in translationsMapOrResult &&
    translationsMapOrResult.translationsById instanceof Map
  ) {
    return translationsMapOrResult.translationsById.get(id)
  }
  if (
    'translations' in translationsMapOrResult &&
    translationsMapOrResult.translations &&
    typeof translationsMapOrResult.translations === 'object'
  ) {
    return (translationsMapOrResult.translations as Record<string, string>)[id]
  }
  if (typeof translationsMapOrResult === 'object') {
    return (translationsMapOrResult as Record<string, string>)[id]
  }
  return undefined
}

export function sanitizeAnnotations(
  annotations: unknown
): Record<string, unknown> | undefined {
  if (!annotations || typeof annotations !== 'object') return undefined
  const a = annotations as Record<string, unknown>
  return {
    bold: Boolean(a.bold),
    italic: Boolean(a.italic),
    strikethrough: Boolean(a.strikethrough),
    underline: Boolean(a.underline),
    code: Boolean(a.code),
    color: typeof a.color === 'string' ? a.color : 'default',
  }
}

function sanitizeMention(
  mention: unknown,
  referenceMap?: ReferenceResolutionMap | null
): unknown {
  if (!mention || typeof mention !== 'object') return mention
  const m = mention as Record<string, unknown>
  const type = m.type
  if (type === 'page' && (m.page as { id?: string } | undefined)?.id) {
    const rawPageId = (m.page as { id: string }).id
    const localizedPageId =
      referenceMap?.targetPageIdBySourcePageId?.get(
        normalizeNotionId(rawPageId)
      ) || rawPageId
    return { type: 'page', page: { id: localizedPageId } }
  }
  if (type === 'database' && (m.database as { id?: string } | undefined)?.id) {
    return {
      type: 'database',
      database: { id: (m.database as { id: string }).id },
    }
  }
  if (type === 'date' && m.date) {
    return { type: 'date', date: m.date }
  }
  if (type === 'user' && (m.user as { id?: string } | undefined)?.id) {
    return { type: 'user', user: { id: (m.user as { id: string }).id } }
  }
  if (type === 'template_mention' && m.template_mention) {
    return {
      type: 'template_mention',
      template_mention: m.template_mention,
    }
  }
  if (
    type === 'custom_emoji' &&
    (m.custom_emoji as { id?: string } | undefined)?.id
  ) {
    return {
      type: 'custom_emoji',
      custom_emoji: { id: (m.custom_emoji as { id: string }).id },
    }
  }
  return deepClone(mention)
}

export function localizeInternalUrl(
  rawUrl: string | null | undefined,
  referenceMap?: ReferenceResolutionMap | null
): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  if (!referenceMap) return rawUrl

  const trimmed = rawUrl.trim()
  if (!trimmed) return rawUrl

  // 1. Relative internal path: /some-slug or /some-slug#section
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    const [pathPart, hashPart] = trimmed.split('#')
    const slugCandidate = pathPart.replace(/^\/+|\/+$/g, '').trim()
    if (slugCandidate) {
      const mappedSlug =
        referenceMap.targetSlugBySourceSlug.get(slugCandidate.toLowerCase()) ||
        referenceMap.targetSlugBySourcePageId.get(
          normalizeNotionId(slugCandidate)
        )
      if (mappedSlug) {
        return `/${mappedSlug}${hashPart ? `#${hashPart}` : ''}`
      }
    }
    return rawUrl
  }

  // 2. Notion URL pointing to a known source page ID
  const notionIdMatch = trimmed.match(
    /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  )
  if (
    notionIdMatch &&
    (trimmed.includes('notion.so/') ||
      trimmed.includes('notion.site/') ||
      /^\/?[0-9a-f-]{32,36}$/i.test(trimmed))
  ) {
    const matchedRawId = notionIdMatch[1]
    const normId = normalizeNotionId(matchedRawId)
    const mappedPageId = referenceMap.targetPageIdBySourcePageId.get(normId)
    if (mappedPageId) {
      const cleanTargetHex = normalizeNotionId(mappedPageId)
      if (trimmed.includes('notion.so/') || trimmed.includes('notion.site/')) {
        return `https://www.notion.so/${cleanTargetHex}`
      }
      return `/${cleanTargetHex}`
    }
  }

  return rawUrl
}

export function rebuildMermaidCode(
  mermaidCode: string,
  blockId: string,
  translationsInput: TranslationLookupInput
): string {
  if (!mermaidCode || typeof mermaidCode !== 'string') return mermaidCode
  const spans = extractMermaidLabelSpans(mermaidCode)
  if (spans.length === 0) return mermaidCode

  let updatedCode = mermaidCode
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]
    const itemId = `block:${blockId}:mermaid_label:${span.index}`
    const translated = getTranslationValue(translationsInput, itemId)
    if (translated === undefined || translated === null) continue

    const sanitized = String(translated)
      .replace(/[\r\n]+/g, ' ')
      .replace(/"/g, "'")
      .trim()
    if (!sanitized) continue

    const charBefore = span.start > 0 ? updatedCode[span.start - 1] : ''
    const needsQuotes =
      !span.wasQuoted &&
      charBefore !== '|' &&
      /[[\](){}|:;<>]/.test(sanitized)

    const replacement = needsQuotes ? `"${sanitized}"` : sanitized
    updatedCode =
      updatedCode.slice(0, span.start) +
      replacement +
      updatedCode.slice(span.end)
  }

  return updatedCode
}

export function chunkTextContent(
  content: string,
  maxLen: number = NOTION_MAX_RICH_TEXT_LENGTH
): string[] {
  const str = String(content ?? '')
  if (str.length <= maxLen) return [str]
  const chunks: string[] = []
  let idx = 0
  while (idx < str.length) {
    chunks.push(str.slice(idx, idx + maxLen))
    idx += maxLen
  }
  return chunks
}

export interface RebuiltRichTextItem {
  type: string
  text?: {
    content: string
    link?: { url: string }
  }
  equation?: { expression: string }
  mention?: unknown
  annotations?: Record<string, unknown>
  plain_text?: string
  href?: string | null
}

/**
 * Reconstructs a Notion `rich_text` array using translated text mapped by stable run IDs,
 * preserving annotations, hyperlinks, inline code, inline equations, and mentions.
 */
export function rebuildRichTextArray(
  richTextArray: unknown,
  idPrefix: string,
  translationsInput: TranslationLookupInput,
  referenceMap?: ReferenceResolutionMap | null
): RebuiltRichTextItem[] {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return []

  const rebuiltRuns: RebuiltRichTextItem[] = []

  for (let i = 0; i < richTextArray.length; i++) {
    const origRun = richTextArray[i] as Record<string, unknown> | undefined
    if (!origRun || typeof origRun !== 'object') continue

    const runId = `${idPrefix}:run:${i}`
    const translatedText = getTranslationValue(translationsInput, runId)
    const annotations = sanitizeAnnotations(origRun.annotations)
    const runType = String(
      origRun.type ||
        (origRun.equation ? 'equation' : origRun.mention ? 'mention' : 'text')
    )

    if (runType === 'equation' && origRun.equation) {
      const eq = origRun.equation as { expression?: string }
      const expr = eq.expression || ''
      rebuiltRuns.push({
        type: 'equation',
        equation: { expression: expr },
        ...(annotations ? { annotations } : {}),
        plain_text:
          typeof origRun.plain_text === 'string' ? origRun.plain_text : expr,
        href: typeof origRun.href === 'string' ? origRun.href : null,
      })
      continue
    }

    if (runType === 'mention' && origRun.mention) {
      rebuiltRuns.push({
        type: 'mention',
        mention: sanitizeMention(origRun.mention, referenceMap),
        ...(annotations ? { annotations } : {}),
        plain_text:
          typeof origRun.plain_text === 'string' ? origRun.plain_text : '',
        href: localizeInternalUrl(
          typeof origRun.href === 'string' ? origRun.href : null,
          referenceMap
        ),
      })
      continue
    }

    const origTextObj = origRun.text as
      | { content?: string; link?: { url?: string } | null }
      | undefined
    const origText =
      origTextObj?.content ??
      (typeof origRun.plain_text === 'string' ? origRun.plain_text : '')
    const finalContent =
      translatedText !== undefined ? String(translatedText) : origText
    const rawLinkUrl =
      origTextObj?.link?.url ||
      (typeof origRun.href === 'string' ? origRun.href : null)
    const linkUrl = localizeInternalUrl(rawLinkUrl, referenceMap)

    const chunks = chunkTextContent(finalContent)
    for (const chunk of chunks) {
      rebuiltRuns.push({
        type: 'text',
        text: {
          content: chunk,
          ...(linkUrl ? { link: { url: linkUrl } } : {}),
        },
        ...(annotations ? { annotations } : {}),
        plain_text: chunk,
        href: linkUrl,
      })
    }
  }

  for (let i = 0; i < rebuiltRuns.length - 1; i++) {
    const curr = rebuiltRuns[i]
    const next = rebuiltRuns[i + 1]
    if (
      curr?.type === 'text' &&
      next?.type === 'text' &&
      curr.text &&
      next.text
    ) {
      const origCurr = richTextArray[i] as
        | { text?: { content?: string }; plain_text?: string }
        | undefined
      const origNext = richTextArray[i + 1] as
        | { text?: { content?: string }; plain_text?: string }
        | undefined
      const origCurrText = origCurr?.text?.content ?? origCurr?.plain_text ?? ''
      const origNextText = origNext?.text?.content ?? origNext?.plain_text ?? ''
      const hadBoundarySpace =
        /\s$/.test(origCurrText) || /^\s/.test(origNextText)
      const hasBoundarySpaceNow =
        /\s$/.test(curr.text.content) || /^\s/.test(next.text.content)
      if (
        hadBoundarySpace &&
        !hasBoundarySpaceNow &&
        curr.text.content &&
        next.text.content
      ) {
        curr.text.content += ' '
        curr.plain_text = (curr.plain_text || '') + ' '
      }
    }
  }

  return rebuiltRuns
}

/**
 * Strips read-only response fields (`plain_text`, `href`) from rich_text items
 * when building the payload for Notion write requests (`pages.create`, `blocks.children.append`).
 */
export function toNotionRichTextRequest(
  richTextArray: unknown
): Record<string, unknown>[] {
  if (!Array.isArray(richTextArray)) return []
  const result: Record<string, unknown>[] = []

  for (const rawItem of richTextArray) {
    const item = (rawItem || {}) as Record<string, unknown>
    const type = String(item.type || 'text')
    const annotations = item.annotations
      ? sanitizeAnnotations(item.annotations)
      : undefined

    if (type === 'equation') {
      const eq = item.equation as { expression?: string } | undefined
      const clean: Record<string, unknown> = {
        type,
        equation: { expression: eq?.expression || '' },
      }
      if (annotations) clean.annotations = annotations
      result.push(clean)
      continue
    }

    if (type === 'mention') {
      const clean: Record<string, unknown> = {
        type,
        mention: sanitizeMention(item.mention),
      }
      if (annotations) clean.annotations = annotations
      result.push(clean)
      continue
    }

    const textObj = item.text as
      | { content?: string; link?: { url?: string } | null }
      | undefined
    const content =
      textObj?.content ??
      (typeof item.plain_text === 'string' ? item.plain_text : '')
    const linkUrl =
      textObj?.link?.url ||
      (typeof item.href === 'string' ? item.href : null)
    const chunks =
      content.length > NOTION_MAX_RICH_TEXT_LENGTH
        ? chunkTextContent(content)
        : [content]

    for (const chunk of chunks) {
      const clean: Record<string, unknown> = {
        type,
        text: {
          content: chunk,
          ...(linkUrl ? { link: { url: linkUrl } } : {}),
        },
      }
      if (annotations) clean.annotations = annotations
      result.push(clean)
    }
  }

  return result
}
