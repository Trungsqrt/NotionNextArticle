import { TRANSLATION_STATUS } from '../config'
import {
  findPropertyKey,
  findTitlePropertyKey,
  getPropertyPlainText,
  normalizeNotionId,
} from '../notion-client'
import type {
  ArticlesDataSourceInfo,
  DiscoveredPageParentKind,
  NotionPageLike,
  ReferenceResolutionMap,
  TranslatedPagePropertiesPayload,
  TranslationStatus,
} from '../types'
import {
  getTranslationValue,
  rebuildRichTextArray,
  toNotionRichTextRequest,
  type RebuiltRichTextItem,
  type TranslationLookupInput,
} from './rich-text'

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
  parentKind?: DiscoveredPageParentKind
  referenceMap?: ReferenceResolutionMap | null
}

/**
 * Builds the Notion `properties` payload for creating the translated Vietnamese page
 * inside a Notion database or as a child page under a parent page.
 * Inspects the actual database schema before writing properties and always sets
 * `Status = Draft` and `Locale = vi` when supported by the database schema.
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
  const parentKind: DiscoveredPageParentKind =
    options.parentKind ||
    (sourcePage?.parent?.type === 'page_id' ? 'page' : 'database')
  const referenceMap = options.referenceMap || null

  const sourceProps = (sourcePage?.properties || {}) as Record<
    string,
    Record<string, unknown>
  >
  const dbSchemaProps = dataSourceInfo?.properties
  const hasExplicitDbSchema =
    Boolean(dbSchemaProps) && Object.keys(dbSchemaProps!).length > 0
  const schemaProps: Record<string, Record<string, unknown>> =
    hasExplicitDbSchema ? { ...dbSchemaProps! } : { ...sourceProps }

  const propertiesPayload: Record<string, unknown> = {}

  // 1. Title property
  const titleKey =
    dataSourceInfo?.titlePropertyName ||
    findTitlePropertyKey(schemaProps) ||
    findTitlePropertyKey(sourceProps)
  const sourceTitleKey = findTitlePropertyKey(sourceProps) || titleKey
  const sourceTitleProp = sourceProps[sourceTitleKey] || sourceProps[titleKey]
  let rebuiltTitleRuns: RebuiltRichTextItem[] = []
  if (
    sourceTitleProp &&
    Array.isArray(sourceTitleProp.title) &&
    sourceTitleProp.title.length > 0
  ) {
    rebuiltTitleRuns = rebuildRichTextArray(
      sourceTitleProp.title,
      'prop:title',
      translationResult,
      referenceMap
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

  const slugKeyInSource = findPropertyKey(sourceProps, ['Slug', 'slug'])
  const sourceSlug = slugKeyInSource
    ? getPropertyPlainText(sourceProps[slugKeyInSource]).trim()
    : ''
  const uniqueSlug = resolveUniqueVietnameseSlug(
    translatedTitlePlain,
    sourceSlug,
    existingSlugs,
    targetLocale
  )

  // If the page is a direct child_page (`parent: { type: 'page_id' }`), Notion API
  // only accepts the `title` property in `pages.create` / `pages.update`.
  if (parentKind === 'page') {
    propertiesPayload.title = {
      title: toNotionRichTextRequest(rebuiltTitleRuns),
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

  propertiesPayload[titleKey] = {
    title: toNotionRichTextRequest(rebuiltTitleRuns),
  }

  // 2. Slug property (only if present in schema)
  const slugKey = findPropertyKey(schemaProps, ['Slug', 'slug'])
  if (slugKey) {
    propertiesPayload[slugKey] = {
      rich_text: toNotionRichTextRequest([
        { type: 'text', text: { content: uniqueSlug } },
      ]),
    }
  }

  // 3. Summary property
  const summaryKey = findPropertyKey(schemaProps, [
    'Summary',
    'summary',
    'Description',
    'description',
  ])
  const sourceSummaryKey =
    findPropertyKey(sourceProps, [
      'Summary',
      'summary',
      'Description',
      'description',
    ]) || summaryKey
  if (
    summaryKey &&
    sourceSummaryKey &&
    sourceProps[sourceSummaryKey]?.rich_text
  ) {
    const rebuiltSummaryRuns = rebuildRichTextArray(
      sourceProps[sourceSummaryKey].rich_text,
      'prop:summary',
      translationResult,
      referenceMap
    )
    propertiesPayload[summaryKey] = {
      rich_text: toNotionRichTextRequest(rebuiltSummaryRuns),
    }
  }

  // 4. Locale property -> 'vi'
  const localeKey = findPropertyKey(schemaProps, ['Locale', 'locale'])
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

  // 7. Type (Course, Article, Tutorial, etc.)
  const typeKey = findPropertyKey(schemaProps, ['Type', 'type'])
  if (typeKey && sourceProps[typeKey]) {
    const srcType = sourceProps[typeKey]
    const sel = srcType.select as { name?: string } | undefined
    if (srcType.type === 'select' && sel?.name) {
      propertiesPayload[typeKey] = { select: { name: sel.name } }
    } else if (
      srcType.type === 'multi_select' &&
      Array.isArray(srcType.multi_select)
    ) {
      propertiesPayload[typeKey] = {
        multi_select: (srcType.multi_select as Array<{ name: string }>).map(
          (item) => ({ name: item.name })
        ),
      }
    } else if (
      srcType.type === 'rich_text' &&
      Array.isArray(srcType.rich_text)
    ) {
      propertiesPayload[typeKey] = {
        rich_text: toNotionRichTextRequest(srcType.rich_text),
      }
    }
  }

  // 8. Date
  const dateKey = findPropertyKey(schemaProps, [
    'Date',
    'date',
    'Published Date',
  ])
  if (
    dateKey &&
    sourceProps[dateKey]?.type === 'date' &&
    sourceProps[dateKey].date
  ) {
    const srcDate = sourceProps[dateKey].date as {
      start?: string
      end?: string | null
      time_zone?: string | null
    }
    if (srcDate.start) {
      propertiesPayload[dateKey] = {
        date: {
          start: srcDate.start,
          ...(srcDate.end ? { end: srcDate.end } : {}),
          ...(srcDate.time_zone ? { time_zone: srcDate.time_zone } : {}),
        },
      }
    }
  }

  // 9. Category
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

  // 10. Tags
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

  // 11. Difficulty
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

  // 12. Duration
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

  // 13. Parent / Parent Course relation or select
  const parentCourseKey = findPropertyKey(schemaProps, [
    'Parent Course',
    'Parent',
    'parent',
    'Parent Item',
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
        relation: (srcParent.relation as Array<{ id: string }>).map((r) => {
          const localizedParentId =
            referenceMap?.targetPageIdBySourcePageId?.get(
              normalizeNotionId(r.id)
            ) || r.id
          return { id: localizedParentId }
        }),
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

  // 14. Order
  const orderKey = findPropertyKey(schemaProps, ['Order', 'order'])
  if (orderKey && typeof sourceProps[orderKey]?.number === 'number') {
    propertiesPayload[orderKey] = { number: sourceProps[orderKey].number }
  }

  // 15. Translation Status on target page -> Draft Ready
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
