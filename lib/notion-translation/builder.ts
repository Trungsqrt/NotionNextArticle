import { classifyBlock } from './block-classifier'
import {
  normalizeTreeNodes,
  attachTreeMeta,
  deepClone,
  extractBlockPlainText,
} from './reader'
import {
  findPropertyKey,
  findTitlePropertyKey,
  getPropertyPlainText,
} from './notion-client'
import { TRANSLATION_STATUS } from './config'
import type {
  ArticlesDataSourceInfo,
  NotionBlockNode,
  NotionBlockTree,
  NotionPageLike,
  TranslateManifestResult,
  TranslatedPagePropertiesPayload,
  TranslationStatus,
} from './types'

const NOTION_MAX_RICH_TEXT_LENGTH = 2000

/**
 * Converts a Vietnamese or English string into a clean ASCII URL slug.
 * Explicitly converts 'đ' / 'Đ' -> 'd' and strips all Vietnamese diacritics.
 */
export function generateVietnameseSlug(input: string): string {
  if (!input) return ''
  return String(input)
    .trim()
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Generates a unique Vietnamese slug that does not collide with any existing slug in the database.
 */
export function resolveUniqueVietnameseSlug(
  translatedTitle: string,
  sourceSlug: string,
  existingSlugs: Iterable<string> = new Set(),
  targetLocale = 'vi'
): string {
  const normalizedSet = new Set(
    Array.from(existingSlugs || [])
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean)
  )

  let base = generateVietnameseSlug(translatedTitle)
  if (!base && sourceSlug) {
    base = generateVietnameseSlug(`${sourceSlug}-${targetLocale}`)
  }
  if (!base) {
    base = `bai-viet-${targetLocale}`
  }

  if (sourceSlug && base === String(sourceSlug).trim().toLowerCase()) {
    base = base.endsWith(`-${targetLocale}`) ? base : `${base}-${targetLocale}`
  }

  if (!normalizedSet.has(base)) {
    return base
  }

  const withLocale = base.endsWith(`-${targetLocale}`)
    ? base
    : `${base}-${targetLocale}`
  if (!normalizedSet.has(withLocale)) {
    return withLocale
  }

  let counter = 2
  while (normalizedSet.has(`${withLocale}-${counter}`)) {
    counter += 1
  }
  return `${withLocale}-${counter}`
}

type TranslationLookupInput =
  | Map<string, string>
  | TranslateManifestResult
  | Record<string, string>
  | null
  | undefined

function getTranslationValue(
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

function sanitizeMention(mention: unknown): unknown {
  if (!mention || typeof mention !== 'object') return mention
  const m = mention as Record<string, unknown>
  const type = m.type
  if (type === 'page' && (m.page as { id?: string } | undefined)?.id) {
    return { type: 'page', page: { id: (m.page as { id: string }).id } }
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
  translationsInput: TranslationLookupInput
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
        plain_text: typeof origRun.plain_text === 'string' ? origRun.plain_text : expr,
        href: typeof origRun.href === 'string' ? origRun.href : null,
      })
      continue
    }

    if (runType === 'mention' && origRun.mention) {
      rebuiltRuns.push({
        type: 'mention',
        mention: sanitizeMention(origRun.mention),
        ...(annotations ? { annotations } : {}),
        plain_text: typeof origRun.plain_text === 'string' ? origRun.plain_text : '',
        href: typeof origRun.href === 'string' ? origRun.href : null,
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
    const linkUrl =
      origTextObj?.link?.url ||
      (typeof origRun.href === 'string' ? origRun.href : null)

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
    if (curr?.type === 'text' && next?.type === 'text' && curr.text && next.text) {
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
  return richTextArray.map((rawItem) => {
    const item = (rawItem || {}) as Record<string, unknown>
    const type = String(item.type || 'text')
    const clean: Record<string, unknown> = { type }

    if (type === 'equation') {
      const eq = item.equation as { expression?: string } | undefined
      clean.equation = { expression: eq?.expression || '' }
    } else if (type === 'mention') {
      clean.mention = sanitizeMention(item.mention)
    } else {
      const textObj = item.text as
        | { content?: string; link?: { url?: string } | null }
        | undefined
      const content =
        textObj?.content ??
        (typeof item.plain_text === 'string' ? item.plain_text : '')
      const linkUrl =
        textObj?.link?.url ||
        (typeof item.href === 'string' ? item.href : null)
      clean.text = {
        content,
        ...(linkUrl ? { link: { url: linkUrl } } : {}),
      }
    }
    if (item.annotations) {
      clean.annotations = sanitizeAnnotations(item.annotations)
    }
    return clean
  })
}

/**
 * Reconstructs the Notion block tree with translated text while preserving
 * all original block types, hierarchy, annotations, code, formulas, links, and metadata.
 */
export function buildTranslatedBlockTree(
  rawTree: NotionBlockTree | NotionBlockNode[],
  translationResult: TranslationLookupInput,
  options: { sourcePageId?: string } = {}
): NotionBlockTree {
  const rootNodes = normalizeTreeNodes(rawTree)

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
            translationResult
          )
        } else if (field === 'caption' && Array.isArray(payload.caption)) {
          payload.caption = rebuildRichTextArray(
            payload.caption,
            `block:${blockId}:caption`,
            translationResult
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
              translationResult
            )
          )
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

function resolveSchemaPropertyType(
  schemaProps: Record<string, Record<string, unknown>> | undefined,
  pageProps: Record<string, Record<string, unknown>> | undefined,
  propKey: string | null
): string | null {
  if (!propKey) return null
  const schemaType = schemaProps?.[propKey]?.type
  const pageType = pageProps?.[propKey]?.type
  return typeof schemaType === 'string'
    ? schemaType
    : typeof pageType === 'string'
      ? pageType
      : null
}

function buildStatusWriteValue(
  schemaProp: Record<string, unknown> | undefined,
  sourceProp: Record<string, unknown> | undefined,
  desiredStatus = 'Draft'
): Record<string, unknown> {
  const propType = String(schemaProp?.type || sourceProp?.type || 'status')
  if (propType === 'checkbox') {
    return { checkbox: false }
  }
  if (propType === 'select') {
    return { select: { name: desiredStatus } }
  }
  if (propType === 'rich_text') {
    return {
      rich_text: [{ type: 'text', text: { content: desiredStatus } }],
    }
  }
  const statusConfig = schemaProp?.status as
    | { options?: Array<{ name?: string }> }
    | undefined
  const options = statusConfig?.options || []
  if (options.length > 0) {
    const exactOrCaseMatch = options.find(
      (o) => o.name?.toLowerCase() === desiredStatus.toLowerCase()
    )
    if (exactOrCaseMatch?.name) {
      return { status: { name: exactOrCaseMatch.name } }
    }
    const draftLike = options.find((o) =>
      /draft|not started|in progress|todo|to-do|pending/i.test(o.name || '')
    )
    if (draftLike?.name) {
      return { status: { name: draftLike.name } }
    }
  }
  return { status: { name: desiredStatus } }
}

function buildLocaleWriteValue(
  schemaProp: Record<string, unknown> | undefined,
  sourceProp: Record<string, unknown> | undefined,
  targetLocale = 'vi'
): Record<string, unknown> {
  const propType = String(schemaProp?.type || sourceProp?.type || 'select')
  if (propType === 'rich_text') {
    return {
      rich_text: [{ type: 'text', text: { content: targetLocale } }],
    }
  }
  return { select: { name: targetLocale } }
}

export interface BuildTranslatedPagePropertiesOptions {
  targetLocale?: string
  translationGroupId?: string
  existingSlugs?: Iterable<string>
  targetTranslationStatus?: TranslationStatus
}

/**
 * Builds the Notion `properties` payload for creating the translated Vietnamese page
 * inside the Articles database. Always sets `Status = Draft` and `Locale = vi`.
 */
export function buildTranslatedPageProperties(
  sourcePage: NotionPageLike,
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null | undefined,
  translationResult: TranslationLookupInput,
  options: BuildTranslatedPagePropertiesOptions = {}
): TranslatedPagePropertiesPayload {
  const targetLocale = options.targetLocale || 'vi'
  const translationGroupId = options.translationGroupId || ''
  const existingSlugs = options.existingSlugs || new Set<string>()
  const targetTranslationStatus =
    options.targetTranslationStatus || TRANSLATION_STATUS.DRAFT_READY

  const sourceProps = (sourcePage?.properties || {}) as Record<
    string,
    Record<string, unknown>
  >
  const schemaProps: Record<string, Record<string, unknown>> = {
    ...(dataSourceInfo?.properties || {}),
    ...sourceProps,
  }

  const propertiesPayload: Record<string, unknown> = {}

  // 1. Title property
  const titleKey =
    dataSourceInfo?.titlePropertyName || findTitlePropertyKey(schemaProps)
  const sourceTitleProp = sourceProps[titleKey]
  let rebuiltTitleRuns: RebuiltRichTextItem[] = []
  if (
    sourceTitleProp &&
    Array.isArray(sourceTitleProp.title) &&
    sourceTitleProp.title.length > 0
  ) {
    rebuiltTitleRuns = rebuildRichTextArray(
      sourceTitleProp.title,
      'prop:title',
      translationResult
    )
  } else {
    const fallbackTitle =
      getTranslationValue(translationResult, 'prop:title:run:0') || 'Bài viết'
    rebuiltTitleRuns = [
      {
        type: 'text',
        text: { content: fallbackTitle },
        plain_text: fallbackTitle,
      },
    ]
  }
  const translatedTitlePlain = rebuiltTitleRuns
    .map((r) => r.text?.content ?? r.plain_text ?? '')
    .join('')
    .trim()
  propertiesPayload[titleKey] = {
    title: toNotionRichTextRequest(rebuiltTitleRuns),
  }

  // 2. Slug property
  const slugKey = findPropertyKey(schemaProps, ['Slug', 'slug'])
  const sourceSlug = slugKey
    ? getPropertyPlainText(sourceProps[slugKey]).trim()
    : ''
  const uniqueSlug = resolveUniqueVietnameseSlug(
    translatedTitlePlain,
    sourceSlug,
    existingSlugs,
    targetLocale
  )
  if (slugKey) {
    propertiesPayload[slugKey] = {
      rich_text: toNotionRichTextRequest([
        { type: 'text', text: { content: uniqueSlug } },
      ]),
    }
  }

  // 3. Summary property
  const summaryKey = findPropertyKey(schemaProps, ['Summary', 'Description'])
  if (summaryKey && sourceProps[summaryKey]?.rich_text) {
    const rebuiltSummaryRuns = rebuildRichTextArray(
      sourceProps[summaryKey].rich_text,
      'prop:summary',
      translationResult
    )
    propertiesPayload[summaryKey] = {
      rich_text: toNotionRichTextRequest(rebuiltSummaryRuns),
    }
  }

  // 4. Locale property -> 'vi'
  const localeKey = findPropertyKey(schemaProps, ['Locale'])
  if (localeKey) {
    propertiesPayload[localeKey] = buildLocaleWriteValue(
      dataSourceInfo?.properties?.[localeKey],
      sourceProps[localeKey],
      targetLocale
    )
  }

  // 5. Translation Group ID
  const groupKey = findPropertyKey(schemaProps, [
    'Translation Group ID',
    'Translation Group',
    'TranslationGroupId',
  ])
  if (groupKey && translationGroupId) {
    propertiesPayload[groupKey] = {
      rich_text: [{ type: 'text', text: { content: translationGroupId } }],
    }
  }

  // 6. Status -> ALWAYS 'Draft'
  const statusKey = findPropertyKey(schemaProps, ['Status', 'status'])
  if (statusKey) {
    propertiesPayload[statusKey] = buildStatusWriteValue(
      dataSourceInfo?.properties?.[statusKey],
      sourceProps[statusKey],
      'Draft'
    )
  }

  // 7. Category
  const categoryKey = findPropertyKey(schemaProps, ['Category', 'category'])
  if (categoryKey && sourceProps[categoryKey]) {
    const srcCat = sourceProps[categoryKey]
    const sel = srcCat.select as { name?: string } | undefined
    if (srcCat.type === 'select' && sel?.name) {
      propertiesPayload[categoryKey] = { select: { name: sel.name } }
    } else if (
      srcCat.type === 'multi_select' &&
      Array.isArray(srcCat.multi_select)
    ) {
      propertiesPayload[categoryKey] = {
        multi_select: (srcCat.multi_select as Array<{ name: string }>).map(
          (item) => ({ name: item.name })
        ),
      }
    } else if (srcCat.type === 'rich_text' && Array.isArray(srcCat.rich_text)) {
      propertiesPayload[categoryKey] = {
        rich_text: toNotionRichTextRequest(srcCat.rich_text),
      }
    }
  }

  // 8. Tags
  const tagsKey = findPropertyKey(schemaProps, ['Tags', 'tags'])
  if (tagsKey && sourceProps[tagsKey]) {
    const srcTags = sourceProps[tagsKey]
    const sel = srcTags.select as { name?: string } | undefined
    if (
      srcTags.type === 'multi_select' &&
      Array.isArray(srcTags.multi_select)
    ) {
      propertiesPayload[tagsKey] = {
        multi_select: (srcTags.multi_select as Array<{ name: string }>).map(
          (item) => ({ name: item.name })
        ),
      }
    } else if (srcTags.type === 'select' && sel?.name) {
      propertiesPayload[tagsKey] = { select: { name: sel.name } }
    }
  }

  // 9. Difficulty
  const difficultyKey = findPropertyKey(schemaProps, [
    'Difficulty',
    'difficulty',
  ])
  if (difficultyKey && sourceProps[difficultyKey]) {
    const srcDiff = sourceProps[difficultyKey]
    const sel = srcDiff.select as { name?: string } | undefined
    if (srcDiff.type === 'select' && sel?.name) {
      propertiesPayload[difficultyKey] = { select: { name: sel.name } }
    } else if (
      srcDiff.type === 'rich_text' &&
      Array.isArray(srcDiff.rich_text)
    ) {
      propertiesPayload[difficultyKey] = {
        rich_text: toNotionRichTextRequest(srcDiff.rich_text),
      }
    }
  }

  // 10. Duration
  const durationKey = findPropertyKey(schemaProps, ['Duration', 'duration'])
  if (durationKey && sourceProps[durationKey]) {
    const srcDur = sourceProps[durationKey]
    const sel = srcDur.select as { name?: string } | undefined
    if (srcDur.type === 'rich_text' && Array.isArray(srcDur.rich_text)) {
      propertiesPayload[durationKey] = {
        rich_text: toNotionRichTextRequest(srcDur.rich_text),
      }
    } else if (srcDur.type === 'number' && typeof srcDur.number === 'number') {
      propertiesPayload[durationKey] = { number: srcDur.number }
    } else if (srcDur.type === 'select' && sel?.name) {
      propertiesPayload[durationKey] = { select: { name: sel.name } }
    }
  }

  // 11. Parent Course
  const parentCourseKey = findPropertyKey(schemaProps, [
    'Parent Course',
    'Parent',
    'Course',
    'Parent Course Name',
  ])
  if (parentCourseKey && sourceProps[parentCourseKey]) {
    const srcParent = sourceProps[parentCourseKey]
    const sel = srcParent.select as { name?: string } | undefined
    if (
      srcParent.type === 'relation' &&
      Array.isArray(srcParent.relation) &&
      srcParent.relation.length > 0
    ) {
      propertiesPayload[parentCourseKey] = {
        relation: (srcParent.relation as Array<{ id: string }>).map((r) => ({
          id: r.id,
        })),
      }
    } else if (srcParent.type === 'select' && sel?.name) {
      propertiesPayload[parentCourseKey] = { select: { name: sel.name } }
    } else if (
      srcParent.type === 'rich_text' &&
      Array.isArray(srcParent.rich_text)
    ) {
      propertiesPayload[parentCourseKey] = {
        rich_text: toNotionRichTextRequest(srcParent.rich_text),
      }
    }
  }

  // 12. Order
  const orderKey = findPropertyKey(schemaProps, ['Order', 'order'])
  if (orderKey && typeof sourceProps[orderKey]?.number === 'number') {
    propertiesPayload[orderKey] = { number: sourceProps[orderKey].number }
  }

  // 13. Translation Status on target page -> Draft Ready
  const translationStatusKey = findPropertyKey(schemaProps, [
    'Translation Status',
    'TranslationStatus',
  ])
  if (translationStatusKey) {
    const propType =
      resolveSchemaPropertyType(
        dataSourceInfo?.properties,
        sourceProps,
        translationStatusKey
      ) || 'select'
    if (propType === 'status') {
      propertiesPayload[translationStatusKey] = {
        status: { name: targetTranslationStatus },
      }
    } else if (propType === 'rich_text') {
      propertiesPayload[translationStatusKey] = {
        rich_text: [
          { type: 'text', text: { content: targetTranslationStatus } },
        ],
      }
    } else {
      propertiesPayload[translationStatusKey] = {
        select: { name: targetTranslationStatus },
      }
    }
  }

  return {
    properties: propertiesPayload,
    translatedTitle: translatedTitlePlain,
    slug: uniqueSlug,
    translationGroupId,
    locale: targetLocale,
    status: 'Draft',
  }
}

