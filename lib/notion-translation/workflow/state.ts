import type { Client, UpdatePageParameters } from '@notionhq/client'
import {
  findPropertyKey,
  findTitlePropertyKey,
  getPropertyPlainText,
  normalizeLocaleCode,
  normalizeNotionId,
  withNotionRetry,
  type NotionOperationOptions,
} from '../notion-client'
import type {
  ArticlesDataSourceInfo,
  DatabasePageIndices,
  IndexedDatabasePage,
  NotionPageLike,
  PageWorkflowMeta,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import type { SourceWorkflowStateUpdates } from './types'

export function extractPageWorkflowMeta(
  page: NotionPageLike | null | undefined,
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null = null
): PageWorkflowMeta {
  const props = (page?.properties || {}) as Record<
    string,
    Record<string, unknown>
  >
  const schemaProps = { ...(dataSourceInfo?.properties || {}), ...props }

  const titleKey =
    dataSourceInfo?.titlePropertyName || findTitlePropertyKey(schemaProps)
  const slugKey = findPropertyKey(schemaProps, ['Slug', 'slug'])
  const statusKey = findPropertyKey(schemaProps, ['Status', 'status'])
  const localeKey = findPropertyKey(schemaProps, ['Locale'])
  const groupKey = findPropertyKey(schemaProps, [
    'Translation Group ID',
    'Translation Group',
    'TranslationGroupId',
  ])
  const transStatusKey = findPropertyKey(schemaProps, [
    'Translation Status',
    'TranslationStatus',
  ])
  const transErrorKey = findPropertyKey(schemaProps, [
    'Translation Error',
    'TranslationError',
  ])
  const transTargetIdKey = findPropertyKey(schemaProps, [
    'Translation Target Page ID',
    'TranslationTargetPageId',
  ])
  const transUpdatedAtKey = findPropertyKey(schemaProps, [
    'Translation Updated At',
    'TranslationUpdatedAt',
  ])

  const rawLocale = localeKey ? getPropertyPlainText(props[localeKey]) : ''
  const locale = normalizeLocaleCode(rawLocale, 'en')

  return {
    id: page?.id || '',
    url: page?.url || '',
    inTrash: Boolean(page?.in_trash || page?.archived),
    title:
      (titleKey ? getPropertyPlainText(props[titleKey]) : '') || 'Untitled',
    slug: (slugKey ? getPropertyPlainText(props[slugKey]) : '').trim(),
    status:
      (statusKey ? getPropertyPlainText(props[statusKey]) : '').trim() ||
      'Published',
    locale,
    rawLocale: rawLocale.trim(),
    translationGroupId: (groupKey
      ? getPropertyPlainText(props[groupKey])
      : ''
    ).trim(),
    translationStatus: (transStatusKey
      ? getPropertyPlainText(props[transStatusKey])
      : ''
    ).trim(),
    translationError: (transErrorKey
      ? getPropertyPlainText(props[transErrorKey])
      : ''
    ).trim(),
    translationTargetPageId: (transTargetIdKey
      ? getPropertyPlainText(props[transTargetIdKey])
      : ''
    ).trim(),
    translationUpdatedAt:
      (transUpdatedAtKey
        ? getPropertyPlainText(props[transUpdatedAtKey])
        : ''
      ).trim() ||
      page?.last_edited_time ||
      page?.created_time ||
      '',
  }
}

function formatTranslationStatusPropertyValue(
  schemaProps: Record<string, Record<string, unknown>> | undefined,
  pageProps: Record<string, Record<string, unknown>> | undefined,
  propKey: string,
  statusValue: string
): Record<string, unknown> {
  const propType = String(
    schemaProps?.[propKey]?.type || pageProps?.[propKey]?.type || 'select'
  )
  if (propType === 'status') {
    return { status: { name: statusValue } }
  }
  if (propType === 'rich_text') {
    return {
      rich_text: [{ type: 'text', text: { content: statusValue } }],
    }
  }
  return { select: { name: statusValue } }
}

export async function updateSourcePageWorkflowState(
  client: Client,
  sourcePage: NotionPageLike | string,
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null | undefined,
  updates: SourceWorkflowStateUpdates = {},
  options: NotionOperationOptions = {}
): Promise<unknown> {
  const { dryRun = false, logger = defaultLogger } = options
  const pageId =
    typeof sourcePage === 'string' ? sourcePage : sourcePage?.id || ''
  const pageProps = (
    typeof sourcePage === 'object' && sourcePage !== null
      ? sourcePage.properties
      : null
  ) as Record<string, Record<string, unknown>> | null
  const isChildPageParent =
    typeof sourcePage === 'object' &&
    sourcePage !== null &&
    sourcePage.parent?.type === 'page_id'
  if (isChildPageParent) {
    return null
  }

  const dbSchemaProps = dataSourceInfo?.properties
  const hasExplicitDbSchema =
    Boolean(dbSchemaProps) && Object.keys(dbSchemaProps!).length > 0
  const schemaProps: Record<string, Record<string, unknown>> = hasExplicitDbSchema
    ? { ...dbSchemaProps! }
    : { ...(dbSchemaProps || {}), ...(pageProps || {}) }

  const properties: Record<string, unknown> = {}

  if (updates.translationStatus !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Status',
      'TranslationStatus',
    ])
    const key = foundKey || (!hasExplicitDbSchema ? 'Translation Status' : null)
    if (key) {
      properties[key] = formatTranslationStatusPropertyValue(
        dataSourceInfo?.properties,
        pageProps || undefined,
        key,
        updates.translationStatus
      )
    }
  }

  if (updates.translationError !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Error',
      'TranslationError',
    ])
    const key = foundKey || (!hasExplicitDbSchema ? 'Translation Error' : null)
    if (key) {
      const text = String(updates.translationError || '').slice(0, 1950)
      properties[key] = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      }
    }
  }

  if (updates.translationTargetPageId !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Target Page ID',
      'TranslationTargetPageId',
    ])
    const key =
      foundKey || (!hasExplicitDbSchema ? 'Translation Target Page ID' : null)
    if (key) {
      const text = String(updates.translationTargetPageId || '').trim()
      properties[key] = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      }
    }
  }

  if (updates.translationUpdatedAt !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Updated At',
      'TranslationUpdatedAt',
    ])
    const key =
      foundKey || (!hasExplicitDbSchema ? 'Translation Updated At' : null)
    if (key) {
      const iso = updates.translationUpdatedAt || new Date().toISOString()
      properties[key] = {
        date: iso ? { start: iso } : null,
      }
    }
  }

  if (updates.translationGroupId !== undefined) {
    const foundKey = findPropertyKey(schemaProps, [
      'Translation Group ID',
      'Translation Group',
      'TranslationGroupId',
    ])
    const key =
      foundKey || (!hasExplicitDbSchema ? 'Translation Group ID' : null)
    if (key) {
      const text = String(updates.translationGroupId || '').trim()
      properties[key] = {
        rich_text: text ? [{ type: 'text', text: { content: text } }] : [],
      }
    }
  }

  if (Object.keys(properties).length === 0) {
    return null
  }

  if (dryRun) {
    logger.info(
      `[Dry Run] Would update page ${pageId} workflow properties:`,
      updates as Record<string, unknown>
    )
    return { id: pageId, properties, dryRun: true }
  }

  return withNotionRetry(
    () =>
      client.pages.update({
        page_id: pageId,
        properties,
      } as unknown as UpdatePageParameters),
    {
      isIdempotent: true,
      label: `pages.update(${pageId})`,
      logger,
      ...options.retryOptions,
    }
  )
}

/**
 * Builds helper lookup indices from all pages in the Articles database.
 */
export function buildDatabasePageIndices(
  allPages: readonly NotionPageLike[],
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null = null,
  targetLocale = 'vi'
): DatabasePageIndices {
  const existingSlugs = new Set<string>()
  const pagesByGroupAndLocale = new Map<
    string,
    Map<string, IndexedDatabasePage[]>
  >()
  const metaByPageId = new Map<string, IndexedDatabasePage>()

  for (const page of allPages || []) {
    if (!page || page.in_trash || page.archived) continue
    const meta = extractPageWorkflowMeta(page, dataSourceInfo)
    metaByPageId.set(normalizeNotionId(meta.id), { page, meta })

    if (meta.slug) {
      existingSlugs.add(meta.slug.toLowerCase())
    }

    if (meta.translationGroupId) {
      const groupKey = meta.translationGroupId.trim().toLowerCase()
      if (!pagesByGroupAndLocale.has(groupKey)) {
        pagesByGroupAndLocale.set(groupKey, new Map())
      }
      const byLocale = pagesByGroupAndLocale.get(groupKey)!
      if (!byLocale.has(meta.locale)) {
        byLocale.set(meta.locale, [])
      }
      byLocale.get(meta.locale)!.push({ page, meta })
    }
  }

  const localizedPageMap = new Map<string, PageWorkflowMeta>()
  for (const [, byLocale] of pagesByGroupAndLocale.entries()) {
    const enList = byLocale.get('en') || []
    const targetList = byLocale.get(targetLocale) || []
    if (enList.length > 0 && targetList.length === 1) {
      const targetMeta = targetList[0]!.meta
      for (const enEntry of enList) {
        localizedPageMap.set(normalizeNotionId(enEntry.meta.id), targetMeta)
      }
    }
  }

  return {
    existingSlugs,
    pagesByGroupAndLocale,
    metaByPageId,
    localizedPageMap,
  }
}
