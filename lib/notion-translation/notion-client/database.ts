import type { Client } from '@notionhq/client'
import { TRANSLATION_STATUS_OPTIONS, type TranslationConfig } from '../config'
import type {
  ArticlesDataSourceInfo,
  NotionPageLike,
  NotionPropertySchemaMap,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import {
  paginateNotionList,
  withNotionRetry,
  type NotionOperationOptions,
  type PaginatedListResponse,
} from './client'
import {
  findPropertyKey,
  findTitlePropertyKey,
  normalizeNotionId,
} from './properties'

export async function queryDataSourceOrDatabase(
  client: Client,
  dataSourceInfo: Pick<ArticlesDataSourceInfo, 'databaseId' | 'dataSourceId'>,
  queryParams: Record<string, unknown> = {},
  options: NotionOperationOptions = {}
): Promise<PaginatedListResponse<NotionPageLike>> {
  const logger = options.logger || defaultLogger
  const { dataSourceId, databaseId } = dataSourceInfo
  const anyClient = client as unknown as {
    dataSources?: {
      query?: (
        args: Record<string, unknown>
      ) => Promise<PaginatedListResponse<NotionPageLike>>
    }
    databases?: {
      query?: (
        args: Record<string, unknown>
      ) => Promise<PaginatedListResponse<NotionPageLike>>
    }
  }

  return withNotionRetry(
    async () => {
      if (typeof anyClient.dataSources?.query === 'function') {
        return anyClient.dataSources.query({
          data_source_id: dataSourceId || databaseId,
          ...queryParams,
        })
      }
      if (typeof anyClient.databases?.query === 'function') {
        return anyClient.databases.query({
          database_id: databaseId || dataSourceId,
          ...queryParams,
        })
      }
      throw new Error(
        'Notion client does not support dataSources.query or databases.query'
      )
    },
    {
      isIdempotent: true,
      label: 'queryDatabase',
      logger,
      ...options.retryOptions,
    }
  )
}

export async function queryAllPages(
  client: Client,
  dataSourceInfo: Pick<ArticlesDataSourceInfo, 'databaseId' | 'dataSourceId'>,
  queryParams: Record<string, unknown> = {},
  options: NotionOperationOptions = {}
): Promise<NotionPageLike[]> {
  return paginateNotionList(
    (cursor) =>
      queryDataSourceOrDatabase(
        client,
        dataSourceInfo,
        {
          ...queryParams,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
        options
      ),
    {
      label: 'queryAllPages',
      maxPaginationPages: options.maxPaginationPages,
      config: options.config,
    }
  )
}

const databaseInfoCacheByClient = new WeakMap<
  Client,
  Map<string, ArticlesDataSourceInfo>
>()

function getClientDatabaseCache(
  client: Client
): Map<string, ArticlesDataSourceInfo> {
  let cache = databaseInfoCacheByClient.get(client)
  if (!cache) {
    cache = new Map<string, ArticlesDataSourceInfo>()
    databaseInfoCacheByClient.set(client, cache)
  }
  return cache
}

/**
 * Inspects a specific Notion database or data source by ID and returns its
 * resolved databaseId, dataSourceId, titlePropertyName, and property schema map.
 * Results are cached per Notion client instance.
 */
export async function resolveDatabaseById(
  client: Client,
  targetDatabaseOrDataSourceId: string,
  options: NotionOperationOptions & { forceRefresh?: boolean } = {}
): Promise<ArticlesDataSourceInfo> {
  const cleanId = String(targetDatabaseOrDataSourceId || '').trim()
  if (!cleanId) {
    throw new Error('resolveDatabaseById requires a non-empty database ID.')
  }

  const normKey = normalizeNotionId(cleanId)
  const cache = getClientDatabaseCache(client)
  if (!options.forceRefresh && normKey && cache.has(normKey)) {
    return cache.get(normKey)!
  }

  const info = await resolveArticlesDataSource(
    client,
    {
      ...(options.config || {}),
      translationDatabaseId: cleanId,
      rootPageId: cleanId,
    },
    options
  )

  if (normKey) {
    cache.set(normKey, info)
  }
  const normDb = normalizeNotionId(info.databaseId)
  if (normDb) {
    cache.set(normDb, info)
  }
  const normDs = normalizeNotionId(info.dataSourceId)
  if (normDs) {
    cache.set(normDs, info)
  }

  return info
}

/**
 * Inspects the configured database / root page and resolves the Articles database ID,
 * data source ID, and full property schema.
 */
export async function resolveArticlesDataSource(
  client: Client,
  config: Partial<TranslationConfig> = {},
  options: NotionOperationOptions = {}
): Promise<ArticlesDataSourceInfo> {
  const targetId = config.translationDatabaseId || config.rootPageId
  if (!targetId) {
    throw new Error(
      'NOTION_TRANSLATION_DATABASE_ID or NOTION_ROOT_PAGE_ID is required.'
    )
  }

  const logger = options.logger || defaultLogger
  let databaseId = targetId
  let dataSourceId = targetId
  let properties: NotionPropertySchemaMap | null = null
  let rawDatabase: ArticlesDataSourceInfo['rawDatabase'] = null
  let rawDataSource: ArticlesDataSourceInfo['rawDataSource'] = null

  // 1. Try retrieving as a database first
  if (typeof client.databases?.retrieve === 'function') {
    try {
      const dbRes = await withNotionRetry(
        () => client.databases.retrieve({ database_id: targetId }),
        {
          isIdempotent: true,
          label: 'databases.retrieve',
          logger,
          ...options.retryOptions,
        }
      )
      rawDatabase = dbRes
      databaseId = dbRes.id || targetId
      const dbRecord = dbRes as unknown as {
        data_sources?: Array<{ id?: string }>
        properties?: NotionPropertySchemaMap
      }
      dataSourceId = dbRecord.data_sources?.[0]?.id || databaseId
      if (
        dbRecord.properties &&
        Object.keys(dbRecord.properties).length > 0
      ) {
        properties = dbRecord.properties
      }
    } catch {
      // May be a data_source_id directly or a root page containing a child_database
    }
  }

  // 2. Retrieve data source schema when supported by SDK
  if (!properties && typeof client.dataSources?.retrieve === 'function') {
    try {
      const dsRes = await withNotionRetry(
        () => client.dataSources.retrieve({ data_source_id: dataSourceId }),
        {
          isIdempotent: true,
          label: 'dataSources.retrieve',
          logger,
          ...options.retryOptions,
        }
      )
      rawDataSource = dsRes as ArticlesDataSourceInfo['rawDataSource']
      const dsRecord = dsRes as unknown as {
        id?: string
        parent?: { database_id?: string }
        properties?: NotionPropertySchemaMap
      }
      dataSourceId = dsRecord.id || dataSourceId
      if (dsRecord.parent?.database_id) {
        databaseId = dsRecord.parent.database_id
      }
      if (dsRecord.properties) {
        properties = dsRecord.properties
      }
    } catch {
      // Fall through to child_database discovery
    }
  }

  // 3. Fallback: If targetId is a root page that holds a child_database block
  if (!properties && typeof client.blocks?.children?.list === 'function') {
    try {
      const rootBlocks = await paginateNotionList(
        (cursor) =>
          withNotionRetry(
            () =>
              client.blocks.children.list({
                block_id: targetId,
                page_size: 100,
                ...(cursor ? { start_cursor: cursor } : {}),
              }),
            {
              isIdempotent: true,
              label: 'blocks.children.list(root)',
              logger,
              ...options.retryOptions,
            }
          ),
        {
          label: `blocks.children.list(${targetId})`,
          maxPaginationPages: options.maxPaginationPages,
          config,
        }
      )
      const childDbBlock = rootBlocks.find(
        (b) =>
          b &&
          typeof b === 'object' &&
          'type' in b &&
          (b as { type?: string }).type === 'child_database'
      ) as { id?: string } | undefined

      if (childDbBlock?.id) {
        return resolveArticlesDataSource(
          client,
          { ...config, translationDatabaseId: childDbBlock.id },
          options
        )
      }
    } catch {
      // Ignore fallback discovery failure if targetId is not a readable root block
    }
  }

  // 4. Final fallback: sample one page from query to infer property names/types
  if (!properties) {
    properties = {}
    try {
      const sampleRes = await queryDataSourceOrDatabase(
        client,
        { databaseId, dataSourceId },
        { page_size: 1 },
        options
      )
      const samplePage = sampleRes?.results?.[0]
      if (samplePage?.properties) {
        properties = samplePage.properties
      }
    } catch {
      // Leave properties empty object if database has no pages yet
    }
  }

  const titlePropertyName = findTitlePropertyKey(properties)

  return {
    databaseId,
    dataSourceId,
    properties,
    titlePropertyName,
    rawDatabase,
    rawDataSource,
  }
}

/**
 * Ensures the required translation workflow properties exist in the Articles database schema.
 */
export async function ensureTranslationSchema(
  client: Client,
  dataSourceInfo: ArticlesDataSourceInfo,
  options: NotionOperationOptions = {}
): Promise<ArticlesDataSourceInfo> {
  const { dryRun = false, logger = defaultLogger } = options
  const schema: NotionPropertySchemaMap = dataSourceInfo.properties || {}

  const requiredDefs: ReadonlyArray<{
    canonicalName: string
    candidates: readonly string[]
    definition: Record<string, unknown>
  }> = [
    {
      canonicalName: 'Translation Status',
      candidates: ['Translation Status', 'TranslationStatus'],
      definition: {
        select: {
          options: TRANSLATION_STATUS_OPTIONS.map((o) => ({
            name: o.name,
            color: o.color,
          })),
        },
      },
    },
    {
      canonicalName: 'Translation Error',
      candidates: ['Translation Error', 'TranslationError'],
      definition: { rich_text: {} },
    },
    {
      canonicalName: 'Translation Target Page ID',
      candidates: ['Translation Target Page ID', 'TranslationTargetPageId'],
      definition: { rich_text: {} },
    },
    {
      canonicalName: 'Translation Updated At',
      candidates: ['Translation Updated At', 'TranslationUpdatedAt'],
      definition: { date: {} },
    },
    {
      canonicalName: 'Locale',
      candidates: ['Locale'],
      definition: {
        select: {
          options: [
            { name: 'en', color: 'blue' },
            { name: 'vi', color: 'green' },
          ],
        },
      },
    },
    {
      canonicalName: 'Translation Group ID',
      candidates: [
        'Translation Group ID',
        'Translation Group',
        'TranslationGroupId',
      ],
      definition: { rich_text: {} },
    },
  ]

  const missingToCreate: Record<string, Record<string, unknown>> = {}
  for (const item of requiredDefs) {
    const existingKey = findPropertyKey(schema, item.candidates)
    if (!existingKey) {
      missingToCreate[item.canonicalName] = item.definition
    }
  }

  if (Object.keys(missingToCreate).length === 0) {
    return dataSourceInfo
  }

  if (dryRun) {
    logger.info('[Dry Run] Would add missing Notion database properties:', {
      missingProperties: Object.keys(missingToCreate),
    })
    for (const [name, def] of Object.entries(missingToCreate)) {
      const type = Object.keys(def)[0]
      schema[name] = { type, ...def }
    }
    return dataSourceInfo
  }

  const anyClient = client as unknown as {
    dataSources?: {
      update?: (
        args: Record<string, unknown>
      ) => Promise<{ properties?: NotionPropertySchemaMap }>
    }
    databases?: {
      update?: (
        args: Record<string, unknown>
      ) => Promise<{ properties?: NotionPropertySchemaMap }>
    }
  }

  try {
    if (typeof anyClient.dataSources?.update === 'function') {
      const updated = await withNotionRetry(
        () =>
          anyClient.dataSources!.update!({
            data_source_id: dataSourceInfo.dataSourceId,
            properties: missingToCreate,
          }),
        {
          isIdempotent: true,
          label: 'dataSources.update(schema)',
          logger,
          ...options.retryOptions,
        }
      )
      if (updated?.properties) {
        dataSourceInfo.properties = { ...schema, ...updated.properties }
      }
    } else if (typeof anyClient.databases?.update === 'function') {
      const updated = await withNotionRetry(
        () =>
          anyClient.databases!.update!({
            database_id: dataSourceInfo.databaseId,
            properties: missingToCreate,
          }),
        {
          isIdempotent: true,
          label: 'databases.update(schema)',
          logger,
          ...options.retryOptions,
        }
      )
      if (updated?.properties) {
        dataSourceInfo.properties = { ...schema, ...updated.properties }
      }
    }
    for (const [name, def] of Object.entries(missingToCreate)) {
      if (!dataSourceInfo.properties[name]) {
        const type = Object.keys(def)[0]
        dataSourceInfo.properties[name] = { type, ...def }
      }
    }
    logger.info(
      'Added missing translation schema properties to Notion database',
      {
        added: Object.keys(missingToCreate),
      }
    )
  } catch (err) {
    logger.warn(
      'Could not auto-create missing translation properties on database (continuing with available schema)',
      {
        error: err instanceof Error ? err.message : String(err),
      }
    )
  }

  return dataSourceInfo
}
