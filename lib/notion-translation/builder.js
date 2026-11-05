'use strict'

const { classifyBlock } = require('./block-classifier')
const { normalizeTreeNodes, attachTreeMeta, deepClone, extractBlockPlainText } = require('./reader')
const {
  findPropertyKey,
  findPropertyEntry,
  findTitlePropertyKey,
  getPropertyPlainText,
} = require('./notion-client')
const { TRANSLATION_STATUS } = require('./config')

const NOTION_MAX_RICH_TEXT_LENGTH = 2000

/**
 * Converts a Vietnamese or English string into a clean ASCII URL slug.
 * Explicitly converts 'đ' / 'Đ' -> 'd' and strips all Vietnamese diacritics.
 */
function generateVietnameseSlug(input) {
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
function resolveUniqueVietnameseSlug(translatedTitle, sourceSlug, existingSlugs = new Set(), targetLocale = 'vi') {
  const normalizedSet = new Set(
    Array.from(existingSlugs || []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean)
  )

  let base = generateVietnameseSlug(translatedTitle)
  if (!base && sourceSlug) {
    base = generateVietnameseSlug(`${sourceSlug}-${targetLocale}`)
  }
  if (!base) {
    base = `bai-viet-${targetLocale}`
  }

  // If the generated slug equals the source slug, suffix with targetLocale right away
  if (sourceSlug && base === String(sourceSlug).trim().toLowerCase()) {
    base = base.endsWith(`-${targetLocale}`) ? base : `${base}-${targetLocale}`
  }

  if (!normalizedSet.has(base)) {
    return base
  }

  const withLocale = base.endsWith(`-${targetLocale}`) ? base : `${base}-${targetLocale}`
  if (!normalizedSet.has(withLocale)) {
    return withLocale
  }

  let counter = 2
  while (normalizedSet.has(`${withLocale}-${counter}`)) {
    counter += 1
  }
  return `${withLocale}-${counter}`
}

function getTranslationValue(translationsMapOrResult, id) {
  if (!translationsMapOrResult) return undefined
  if (translationsMapOrResult instanceof Map) {
    return translationsMapOrResult.get(id)
  }
  if (translationsMapOrResult.translationsById instanceof Map) {
    return translationsMapOrResult.translationsById.get(id)
  }
  if (translationsMapOrResult.translations && typeof translationsMapOrResult.translations === 'object') {
    return translationsMapOrResult.translations[id]
  }
  if (typeof translationsMapOrResult === 'object') {
    return translationsMapOrResult[id]
  }
  return undefined
}

function sanitizeAnnotations(annotations) {
  if (!annotations || typeof annotations !== 'object') return undefined
  return {
    bold: Boolean(annotations.bold),
    italic: Boolean(annotations.italic),
    strikethrough: Boolean(annotations.strikethrough),
    underline: Boolean(annotations.underline),
    code: Boolean(annotations.code),
    color: annotations.color || 'default',
  }
}

function sanitizeMention(mention) {
  if (!mention || typeof mention !== 'object') return mention
  const type = mention.type
  if (type === 'page' && mention.page?.id) {
    return { type: 'page', page: { id: mention.page.id } }
  }
  if (type === 'database' && mention.database?.id) {
    return { type: 'database', database: { id: mention.database.id } }
  }
  if (type === 'date' && mention.date) {
    return { type: 'date', date: mention.date }
  }
  if (type === 'user' && mention.user?.id) {
    return { type: 'user', user: { id: mention.user.id } }
  }
  if (type === 'template_mention' && mention.template_mention) {
    return { type: 'template_mention', template_mention: mention.template_mention }
  }
  if (type === 'custom_emoji' && mention.custom_emoji?.id) {
    return { type: 'custom_emoji', custom_emoji: { id: mention.custom_emoji.id } }
  }
  return deepClone(mention)
}

function chunkTextContent(content, maxLen = NOTION_MAX_RICH_TEXT_LENGTH) {
  const str = String(content ?? '')
  if (str.length <= maxLen) return [str]
  const chunks = []
  let idx = 0
  while (idx < str.length) {
    chunks.push(str.slice(idx, idx + maxLen))
    idx += maxLen
  }
  return chunks
}

/**
 * Reconstructs a Notion `rich_text` array using translated text mapped by stable run IDs,
 * preserving annotations, hyperlinks, inline code, inline equations, and mentions.
 */
function rebuildRichTextArray(richTextArray, idPrefix, translationsInput) {
  if (!Array.isArray(richTextArray)) return []
  if (richTextArray.length === 0) return []

  const rebuiltRuns = []

  for (let i = 0; i < richTextArray.length; i++) {
    const origRun = richTextArray[i]
    if (!origRun || typeof origRun !== 'object') continue

    const runId = `${idPrefix}:run:${i}`
    const translatedText = getTranslationValue(translationsInput, runId)
    const annotations = sanitizeAnnotations(origRun.annotations)
    const runType = origRun.type || (origRun.equation ? 'equation' : origRun.mention ? 'mention' : 'text')

    if (runType === 'equation' && origRun.equation) {
      const expr = origRun.equation.expression || ''
      rebuiltRuns.push({
        type: 'equation',
        equation: { expression: expr },
        ...(annotations ? { annotations } : {}),
        plain_text: origRun.plain_text ?? expr,
        href: origRun.href ?? null,
      })
      continue
    }

    if (runType === 'mention' && origRun.mention) {
      rebuiltRuns.push({
        type: 'mention',
        mention: sanitizeMention(origRun.mention),
        ...(annotations ? { annotations } : {}),
        plain_text: origRun.plain_text ?? '',
        href: origRun.href ?? null,
      })
      continue
    }

    const origText = origRun.text?.content ?? origRun.plain_text ?? ''
    const finalContent = translatedText !== undefined ? String(translatedText) : origText
    const linkUrl = origRun.text?.link?.url || origRun.href || null
    const linkObj = linkUrl ? { url: linkUrl } : null

    const chunks = chunkTextContent(finalContent)
    for (const chunk of chunks) {
      rebuiltRuns.push({
        type: 'text',
        text: {
          content: chunk,
          ...(linkObj ? { link: linkObj } : {}),
        },
        ...(annotations ? { annotations } : {}),
        plain_text: chunk,
        href: linkUrl,
      })
    }
  }

  // Ensure boundary spaces between adjacent runs are not accidentally lost if source had them
  for (let i = 0; i < rebuiltRuns.length - 1; i++) {
    const curr = rebuiltRuns[i]
    const next = rebuiltRuns[i + 1]
    if (curr.type === 'text' && next.type === 'text') {
      const origCurrText = richTextArray[i]?.text?.content ?? richTextArray[i]?.plain_text ?? ''
      const origNextText = richTextArray[i + 1]?.text?.content ?? richTextArray[i + 1]?.plain_text ?? ''
      const hadBoundarySpace = /\s$/.test(origCurrText) || /^\s/.test(origNextText)
      const hasBoundarySpaceNow =
        /\s$/.test(curr.text.content) || /^\s/.test(next.text.content)
      if (hadBoundarySpace && !hasBoundarySpaceNow && curr.text.content && next.text.content) {
        curr.text.content += ' '
        curr.plain_text += ' '
      }
    }
  }

  return rebuiltRuns
}

/**
 * Strips read-only response fields (`plain_text`, `href`) from rich_text items
 * when building the payload for Notion write requests (`pages.create`, `blocks.children.append`).
 */
function toNotionRichTextRequest(richTextArray) {
  if (!Array.isArray(richTextArray)) return []
  return richTextArray.map(item => {
    const clean = { type: item.type || 'text' }
    if (clean.type === 'equation') {
      clean.equation = { expression: item.equation?.expression || '' }
    } else if (clean.type === 'mention') {
      clean.mention = sanitizeMention(item.mention)
    } else {
      const content = item.text?.content ?? item.plain_text ?? ''
      const linkUrl = item.text?.link?.url || item.href || null
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
function buildTranslatedBlockTree(rawTree, translationResult, options = {}) {
  const rootNodes = normalizeTreeNodes(rawTree)

  function buildNode(node) {
    const clonedRaw = deepClone(node.raw || node)
    const blockId = node.id || clonedRaw.id || `pos-${node.position || '0'}`
    const blockType = node.type || clonedRaw.type || 'unsupported'
    const classification = classifyBlock(node)
    const payload = clonedRaw[blockType] ? deepClone(clonedRaw[blockType]) : {}

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
        } else if (field === 'cells' && blockType === 'table_row' && Array.isArray(payload.cells)) {
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

    // synced_block is recreated as an independent block on the translated page
    if (blockType === 'synced_block') {
      payload.synced_from = null
    }

    clonedRaw[blockType] = payload

    const builtChildren = Array.isArray(node.children)
      ? node.children.map(child => buildNode(child))
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
      raw: clonedRaw,
      children: builtChildren,
    }
  }

  const translatedNodes = rootNodes.map(node => buildNode(node))
  return attachTreeMeta(translatedNodes, {
    pageId: rawTree?.pageId || options.sourcePageId || null,
  })
}

function resolveSchemaPropertyType(schemaProps, pageProps, propKey) {
  if (!propKey) return null
  return schemaProps?.[propKey]?.type || pageProps?.[propKey]?.type || null
}

function buildStatusWriteValue(schemaProp, sourceProp, desiredStatus = 'Draft') {
  const propType = schemaProp?.type || sourceProp?.type || 'status'
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
  // For Notion 'status' property type, match an existing option case-insensitively if options are known
  const options = schemaProp?.status?.options || []
  if (options.length > 0) {
    const exactOrCaseMatch = options.find(
      o => o.name?.toLowerCase() === desiredStatus.toLowerCase()
    )
    if (exactOrCaseMatch) {
      return { status: { name: exactOrCaseMatch.name } }
    }
    const draftLike = options.find(o =>
      /draft|not started|in progress|todo|to-do|pending/i.test(o.name || '')
    )
    if (draftLike) {
      return { status: { name: draftLike.name } }
    }
  }
  return { status: { name: desiredStatus } }
}

function buildLocaleWriteValue(schemaProp, sourceProp, targetLocale = 'vi') {
  const propType = schemaProp?.type || sourceProp?.type || 'select'
  if (propType === 'rich_text') {
    return {
      rich_text: [{ type: 'text', text: { content: targetLocale } }],
    }
  }
  return { select: { name: targetLocale } }
}

/**
 * Builds the Notion `properties` payload for creating the translated Vietnamese page
 * inside the Articles database.
 *
 * Guarantees:
 * - Dynamic title property detection
 * - Unique Vietnamese-friendly ASCII slug
 * - Locale = 'vi'
 * - Same Translation Group ID as source
 * - Status = 'Draft' (never Published)
 */
function buildTranslatedPageProperties(sourcePage, dataSourceInfo, translationResult, options = {}) {
  const targetLocale = options.targetLocale || 'vi'
  const translationGroupId = options.translationGroupId || ''
  const existingSlugs = options.existingSlugs || new Set()
  const targetTranslationStatus = options.targetTranslationStatus || TRANSLATION_STATUS.DRAFT_READY

  const sourceProps = sourcePage?.properties || {}
  const schemaProps = { ...(dataSourceInfo?.properties || {}), ...sourceProps }

  const propertiesPayload = {}

  // 1. Title property (detected dynamically)
  const titleKey = dataSourceInfo?.titlePropertyName || findTitlePropertyKey(schemaProps)
  const sourceTitleProp = sourceProps[titleKey]
  let rebuiltTitleRuns = []
  if (sourceTitleProp && Array.isArray(sourceTitleProp.title) && sourceTitleProp.title.length > 0) {
    rebuiltTitleRuns = rebuildRichTextArray(sourceTitleProp.title, 'prop:title', translationResult)
  } else {
    const fallbackTitle = getTranslationValue(translationResult, 'prop:title:run:0') || 'Bài viết'
    rebuiltTitleRuns = [{ type: 'text', text: { content: fallbackTitle }, plain_text: fallbackTitle }]
  }
  const translatedTitlePlain = rebuiltTitleRuns.map(r => r.text?.content ?? r.plain_text ?? '').join('').trim()
  propertiesPayload[titleKey] = {
    title: toNotionRichTextRequest(rebuiltTitleRuns),
  }

  // 2. Slug property (Vietnamese ASCII unique slug)
  const slugKey = findPropertyKey(schemaProps, ['Slug', 'slug'])
  const sourceSlug = slugKey ? getPropertyPlainText(sourceProps[slugKey]).trim() : ''
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

  // 3. Summary property (translated)
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

  // 5. Translation Group ID -> copy source value
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

  // 6. Status -> ALWAYS 'Draft' (never copy 'Published')
  const statusKey = findPropertyKey(schemaProps, ['Status', 'status'])
  if (statusKey) {
    propertiesPayload[statusKey] = buildStatusWriteValue(
      dataSourceInfo?.properties?.[statusKey],
      sourceProps[statusKey],
      'Draft'
    )
  }

  // 7. Category -> preserve by default
  const categoryKey = findPropertyKey(schemaProps, ['Category', 'category'])
  if (categoryKey && sourceProps[categoryKey]) {
    const srcCat = sourceProps[categoryKey]
    if (srcCat.type === 'select' && srcCat.select?.name) {
      propertiesPayload[categoryKey] = { select: { name: srcCat.select.name } }
    } else if (srcCat.type === 'multi_select' && Array.isArray(srcCat.multi_select)) {
      propertiesPayload[categoryKey] = {
        multi_select: srcCat.multi_select.map(item => ({ name: item.name })),
      }
    } else if (srcCat.type === 'rich_text' && Array.isArray(srcCat.rich_text)) {
      propertiesPayload[categoryKey] = {
        rich_text: toNotionRichTextRequest(srcCat.rich_text),
      }
    }
  }

  // 8. Tags -> preserve by default
  const tagsKey = findPropertyKey(schemaProps, ['Tags', 'tags'])
  if (tagsKey && sourceProps[tagsKey]) {
    const srcTags = sourceProps[tagsKey]
    if (srcTags.type === 'multi_select' && Array.isArray(srcTags.multi_select)) {
      propertiesPayload[tagsKey] = {
        multi_select: srcTags.multi_select.map(item => ({ name: item.name })),
      }
    } else if (srcTags.type === 'select' && srcTags.select?.name) {
      propertiesPayload[tagsKey] = { select: { name: srcTags.select.name } }
    }
  }

  // 9. Difficulty -> copy
  const difficultyKey = findPropertyKey(schemaProps, ['Difficulty', 'difficulty'])
  if (difficultyKey && sourceProps[difficultyKey]) {
    const srcDiff = sourceProps[difficultyKey]
    if (srcDiff.type === 'select' && srcDiff.select?.name) {
      propertiesPayload[difficultyKey] = { select: { name: srcDiff.select.name } }
    } else if (srcDiff.type === 'rich_text' && Array.isArray(srcDiff.rich_text)) {
      propertiesPayload[difficultyKey] = {
        rich_text: toNotionRichTextRequest(srcDiff.rich_text),
      }
    }
  }

  // 10. Duration -> copy
  const durationKey = findPropertyKey(schemaProps, ['Duration', 'duration'])
  if (durationKey && sourceProps[durationKey]) {
    const srcDur = sourceProps[durationKey]
    if (srcDur.type === 'rich_text' && Array.isArray(srcDur.rich_text)) {
      propertiesPayload[durationKey] = {
        rich_text: toNotionRichTextRequest(srcDur.rich_text),
      }
    } else if (srcDur.type === 'number' && typeof srcDur.number === 'number') {
      propertiesPayload[durationKey] = { number: srcDur.number }
    } else if (srcDur.type === 'select' && srcDur.select?.name) {
      propertiesPayload[durationKey] = { select: { name: srcDur.select.name } }
    }
  }

  // 11. Parent Course -> preserve where valid
  const parentCourseKey = findPropertyKey(schemaProps, [
    'Parent Course',
    'Parent',
    'Course',
    'Parent Course Name',
  ])
  if (parentCourseKey && sourceProps[parentCourseKey]) {
    const srcParent = sourceProps[parentCourseKey]
    if (srcParent.type === 'relation' && Array.isArray(srcParent.relation) && srcParent.relation.length > 0) {
      propertiesPayload[parentCourseKey] = {
        relation: srcParent.relation.map(r => ({ id: r.id })),
      }
    } else if (srcParent.type === 'select' && srcParent.select?.name) {
      propertiesPayload[parentCourseKey] = { select: { name: srcParent.select.name } }
    } else if (srcParent.type === 'rich_text' && Array.isArray(srcParent.rich_text)) {
      propertiesPayload[parentCourseKey] = {
        rich_text: toNotionRichTextRequest(srcParent.rich_text),
      }
    }
  }

  // 12. Order -> preserve if present
  const orderKey = findPropertyKey(schemaProps, ['Order', 'order'])
  if (orderKey && typeof sourceProps[orderKey]?.number === 'number') {
    propertiesPayload[orderKey] = { number: sourceProps[orderKey].number }
  }

  // 13. Translation Status on target page -> Draft Ready if supported
  const translationStatusKey = findPropertyKey(schemaProps, [
    'Translation Status',
    'TranslationStatus',
  ])
  if (translationStatusKey) {
    const propType = resolveSchemaPropertyType(dataSourceInfo?.properties, sourceProps, translationStatusKey) || 'select'
    if (propType === 'status') {
      propertiesPayload[translationStatusKey] = { status: { name: targetTranslationStatus } }
    } else if (propType === 'rich_text') {
      propertiesPayload[translationStatusKey] = {
        rich_text: [{ type: 'text', text: { content: targetTranslationStatus } }],
      }
    } else {
      propertiesPayload[translationStatusKey] = { select: { name: targetTranslationStatus } }
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

module.exports = {
  generateVietnameseSlug,
  resolveUniqueVietnameseSlug,
  rebuildRichTextArray,
  toNotionRichTextRequest,
  buildTranslatedBlockTree,
  buildTranslatedPageProperties,
  sanitizeAnnotations,
  chunkTextContent,
}

