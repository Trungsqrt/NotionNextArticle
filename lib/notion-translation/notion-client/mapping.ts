import type {
  Client,
  CreatePageParameters,
  UpdatePageParameters,
} from '@notionhq/client'
import type { ArticlesDataSourceInfo, NotionPageLike } from '../types'
import { withNotionRetry, type NotionOperationOptions } from './client'
import { queryAllPages, resolveDatabaseById } from './database'
import {
  findPropertyKey,
  findTitlePropertyKey,
  getPropertyPlainText,
  normalizeNotionId,
} from './properties'

export interface TranslationMappingRecordInput {
  name: string
  enPageId: string
  viPageId: string
  status: 'Draft' | 'Ready' | string
}

export interface TranslationMappingRecordResult {
  id: string
  action: 'created' | 'updated' | 'skipped'
}

/**
 * Automatically upserts a translation mapping record in the dedicated Notion
 * Translation Mapping database without creating duplicate rows.
 * - Searches by EN Page ID or VI Page ID.
 * - If found, updates Name, VI Page ID (or EN Page ID), and Status.
 * - If not found, creates a new row.
 * - Marks 'Ready' only when translation is complete; preserves 'Draft' for incomplete work.
 */
export async function upsertNotionTranslationMappingRecord(
  client: Client,
  mappingDbId: string,
  entry: TranslationMappingRecordInput,
  options: NotionOperationOptions = {}
): Promise<TranslationMappingRecordResult> {
  const cleanDbId = String(mappingDbId || '').trim()
  if (!cleanDbId) {
    return { id: '', action: 'skipped' }
  }

  const normEnId = normalizeNotionId(entry.enPageId)
  const normViId = normalizeNotionId(entry.viPageId)
  if (!normEnId && !normViId) {
    return { id: '', action: 'skipped' }
  }

  const cleanName = (entry.name || '').trim()
  const statusVal =
    String(entry.status || '')
      .trim()
      .toLowerCase() === 'ready'
      ? 'Ready'
      : 'Draft'

  let dbInfo: ArticlesDataSourceInfo
  try {
    dbInfo = await resolveDatabaseById(client, cleanDbId, options)
  } catch (err: unknown) {
    options.logger?.warn?.(
      `[Mapping DB] Failed to resolve translation mapping database (${cleanDbId}): ${err instanceof Error ? err.message : String(err)}`
    )
    return { id: '', action: 'skipped' }
  }

  const rawDbRecord = dbInfo.rawDatabase as {
    properties?: Record<string, Record<string, unknown>>
  } | null
  const properties: Record<string, Record<string, unknown>> =
    rawDbRecord?.properties || {}

  // Identify property names in mapping DB schema
  const titleKey =
    findTitlePropertyKey(properties) ||
    findPropertyKey(properties, ['Name', 'Title', 'Lesson']) ||
    'Name'

  let enKey = findPropertyKey(properties, [
    'EN Page ID',
    'EN Page Id',
    'English Page ID',
    'EN ID',
    'EnPageId',
  ])

  let viKey = findPropertyKey(properties, [
    'VI Page ID',
    'VI Page Id',
    'Vietnamese Page ID',
    'VI ID',
    'ViPageId',
  ])

  let statusKey = findPropertyKey(properties, [
    'Status',
    'Translation Status',
    'State',
  ])

  // Ensure missing schema properties in the mapping database if any is absent
  const missingProps: Record<string, unknown> = {}
  if (!enKey) {
    missingProps['EN Page ID'] = { rich_text: {} }
    enKey = 'EN Page ID'
  }
  if (!viKey) {
    missingProps['VI Page ID'] = { rich_text: {} }
    viKey = 'VI Page ID'
  }
  if (!statusKey) {
    missingProps['Status'] = {
      select: {
        options: [
          { name: 'Draft', color: 'yellow' },
          { name: 'Ready', color: 'green' },
        ],
      },
    }
    statusKey = 'Status'
  }

  if (Object.keys(missingProps).length > 0 && !options.dryRun) {
    try {
      const updateDb = client.databases.update as unknown as (
        args: Record<string, unknown>
      ) => Promise<unknown>
      await withNotionRetry(
        () =>
          updateDb({
            database_id: dbInfo.databaseId,
            properties: missingProps,
          }),
        {
          label: 'databases.update(mappingSchema)',
          logger: options.logger,
          ...options.retryOptions,
        }
      )
    } catch (schemaErr: unknown) {
      options.logger?.warn?.(
        `[Mapping DB] Could not auto-add missing columns to mapping database: ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`
      )
    }
  }

  const statusProp = properties[statusKey]
  const statusType = String(statusProp?.type || 'select')

  // Query existing mapping records to avoid duplicate rows
  const existingPages = await queryAllPages(client, dbInfo, {}, options).catch(
    () => []
  )

  let matchingRow: NotionPageLike | null = null
  for (const page of existingPages) {
    const pProps = page.properties || {}
    const rowEn = normalizeNotionId(getPropertyPlainText(pProps[enKey]))
    const rowVi = normalizeNotionId(getPropertyPlainText(pProps[viKey]))

    const matchesEn = Boolean(normEnId && rowEn && rowEn === normEnId)
    const matchesVi = Boolean(normViId && rowVi && rowVi === normViId)

    if (matchesEn || matchesVi) {
      matchingRow = page
      break
    }
  }

  const helperStatusPayload = (val: string) => {
    if (statusType === 'status') {
      return { status: { name: val } }
    }
    if (statusType === 'select') {
      return { select: { name: val } }
    }
    return { rich_text: [{ type: 'text', text: { content: val } }] }
  }

  if (matchingRow) {
    // Existing row found: update it
    const existingProps = matchingRow.properties || {}
    const existingStatus = getPropertyPlainText(existingProps[statusKey])
    // If the mapping was already marked Ready and incoming status is Draft, preserve Ready
    const finalStatus =
      existingStatus.trim().toLowerCase() === 'ready' && statusVal === 'Draft'
        ? 'Ready'
        : statusVal

    const updateProps: Record<string, unknown> = {
      [statusKey]: helperStatusPayload(finalStatus),
    }

    if (cleanName) {
      updateProps[titleKey] = {
        title: [{ type: 'text', text: { content: cleanName } }],
      }
    }
    if (entry.enPageId) {
      updateProps[enKey] = {
        rich_text: [{ type: 'text', text: { content: entry.enPageId } }],
      }
    }
    if (entry.viPageId) {
      updateProps[viKey] = {
        rich_text: [{ type: 'text', text: { content: entry.viPageId } }],
      }
    }

    if (options.dryRun) {
      options.logger?.info?.(
        `[DRY RUN] Would update translation mapping for "${cleanName || matchingRow.id}" (status: ${finalStatus})`
      )
      return { id: matchingRow.id, action: 'updated' }
    }

    await withNotionRetry(
      () =>
        client.pages.update({
          page_id: matchingRow!.id,
          properties: updateProps,
        } as unknown as UpdatePageParameters),
      {
        label: `pages.update(mappingRow:${matchingRow.id})`,
        logger: options.logger,
        ...options.retryOptions,
      }
    )

    options.logger?.info?.(
      `[Mapping DB] Updated mapping row for "${cleanName || matchingRow.id}" -> status=${finalStatus}`,
      {
        rowId: matchingRow.id,
        enPageId: entry.enPageId,
        viPageId: entry.viPageId,
      }
    )

    return { id: matchingRow.id, action: 'updated' }
  }

  // No existing row found: create new row
  const createProps: Record<string, unknown> = {
    [titleKey]: {
      title: [{ type: 'text', text: { content: cleanName || 'Untitled' } }],
    },
    [statusKey]: helperStatusPayload(statusVal),
  }

  if (entry.enPageId) {
    createProps[enKey] = {
      rich_text: [{ type: 'text', text: { content: entry.enPageId } }],
    }
  }
  if (entry.viPageId) {
    createProps[viKey] = {
      rich_text: [{ type: 'text', text: { content: entry.viPageId } }],
    }
  }

  const parentPayload = dbInfo.dataSourceId
    ? { data_source_id: dbInfo.dataSourceId }
    : { database_id: dbInfo.databaseId }

  if (options.dryRun) {
    options.logger?.info?.(
      `[DRY RUN] Would create translation mapping row for "${cleanName}" (status: ${statusVal})`
    )
    return { id: 'dry-run-mapping-id', action: 'created' }
  }

  const createdPage = await withNotionRetry(
    () =>
      client.pages.create({
        parent: parentPayload,
        properties: createProps,
      } as unknown as CreatePageParameters),
    {
      label: 'pages.create(mappingRow)',
      logger: options.logger,
      ...options.retryOptions,
    }
  )

  options.logger?.info?.(
    `[Mapping DB] Created new mapping row for "${cleanName}" -> status=${statusVal}`,
    {
      rowId: createdPage.id,
      enPageId: entry.enPageId,
      viPageId: entry.viPageId,
    }
  )

  return { id: createdPage.id, action: 'created' }
}
