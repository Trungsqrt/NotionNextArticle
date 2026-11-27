/**
 * lib/notion/client.ts — Public Knowledge Hub Notion SDK client & query primitives
 * ────────────────────────────────────────────────────────────────────────────────
 * Owns the shared `@notionhq/client` instance, verified database -> data_source
 * resolution with single-flight deduplication and stale-mapping recovery, cached
 * page/database/block/search fetches, and bounded cursor pagination.
 */

import { Client, type ListBlockChildrenResponse } from '@notionhq/client'
import {
  normalizeNotionId,
  isNotionNotFoundError,
  parsePublicNotionId,
  executePublicDataSourceQueryWithRecovery,
} from '../notion-datasource-recovery'
import {
  CACHE_TTL,
  DS_MAPPING_TTL,
  deleteCacheKeys,
  getCache,
  setCache,
} from './cache'
import type {
  NotionBlockLike,
  NotionDatabaseLike,
  NotionDataSourceLike,
  NotionPageLike,
  NotionQueryResultLike,
  NotionSearchResultLike,
  QueryDatabaseOptions,
} from './types'

const NOTION_UUID_REGEX = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
const MAX_PAGINATION_PAGES = 100 // safety guard (10,000 records)

export const notion = new Client({
  auth: process.env.NOTION_API_SECRET || process.env.NOTION_TOKEN || process.env.NOTION_TOKEN_V2,
})

export function isValidNotionId(id: unknown): boolean {
  return typeof id === 'string' && NOTION_UUID_REGEX.test(id.trim())
}

export function getPublicNotionRootId(): string {
  return (process.env.NOTION_ROOT_PAGE_ID || process.env.NOTION_DATABASE_ID || '').trim()
}

export function getNotionErrorStatusOrCode(err: unknown): string | number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const candidate = err as { status?: unknown; code?: unknown }
  if (typeof candidate.status === 'number' || typeof candidate.status === 'string') {
    return candidate.status
  }
  if (typeof candidate.code === 'string' || typeof candidate.code === 'number') {
    return candidate.code
  }
  return undefined
}

interface LegacyDatabasesWithQuery {
  query: (args: Record<string, unknown>) => Promise<NotionQueryResultLike>
}

function hasLegacyDatabaseQuery(databases: unknown): databases is LegacyDatabasesWithQuery {
  return (
    typeof databases === 'object' &&
    databases !== null &&
    'query' in databases &&
    typeof (databases as { query?: unknown }).query === 'function'
  )
}

export async function fetchChildrenList(
  blockId: string,
  startCursor?: string
): Promise<ListBlockChildrenResponse> {
  const key = `children-${blockId}-${startCursor || 'first'}`
  const cached = getCache<ListBlockChildrenResponse>(key)
  if (cached) return cached
  const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: startCursor })
  setCache(key, res)
  return res
}

export async function fetchDatabase(dbId: string): Promise<NotionDatabaseLike> {
  const key = `db-${dbId}`
  const cached = getCache<NotionDatabaseLike>(key)
  if (cached) return cached
  const res = (await notion.databases.retrieve({ database_id: dbId })) as unknown as NotionDatabaseLike
  setCache(key, res)
  return res
}

// Single-flight deduplication and generation counters prevent stale in-flight
// data_source resolutions from overwriting newly invalidated cache entries.
const dsInFlight = new Map<string, Promise<string>>()
const dsInFlightRefresh = new Map<string, Promise<string>>()
const dsGenerations = new Map<string, number>()

export function invalidatePublicDataSourceCache(rawId: string): void {
  const { id: cleanId } = parsePublicNotionId(rawId)
  const norm = normalizeNotionId(cleanId)
  dsGenerations.set(norm, (dsGenerations.get(norm) || 0) + 1)
  deleteCacheKeys([`ds-map-${norm}`, `db-${cleanId}`])
  dsInFlight.delete(`ds-map-${norm}`)
}

export async function resolvePublicDataSourceId(
  rawId: string,
  forceRefresh = false
): Promise<string> {
  const { id: cleanId, explicitKind } = parsePublicNotionId(rawId)
  const norm = normalizeNotionId(cleanId)
  const cacheKey = `ds-map-${norm}`

  if (!forceRefresh) {
    const cached = getCache<string>(cacheKey, DS_MAPPING_TTL)
    if (cached) return cached
    const existingFlight = dsInFlight.get(cacheKey)
    if (existingFlight) return existingFlight
  } else {
    const existingRefresh = dsInFlightRefresh.get(cacheKey)
    if (existingRefresh) return existingRefresh
  }

  const flightMap = forceRefresh ? dsInFlightRefresh : dsInFlight
  const startGen = dsGenerations.get(norm) || 0

  const promise = (async (): Promise<string> => {
    // Explicit `ds:<id>` skips databases.retrieve() completely (zero 404 SDK warnings)
    if (explicitKind === 'data_source_id') {
      if (typeof notion.dataSources?.retrieve !== 'function') return cleanId
      const dsInfo = (await notion.dataSources.retrieve({
        data_source_id: cleanId,
      })) as unknown as NotionDataSourceLike
      if (!dsInfo?.id) throw new Error(`Notion data_source "${cleanId}" not found`)
      if ((dsGenerations.get(norm) || 0) === startGen) setCache(cacheKey, dsInfo.id)
      return dsInfo.id
    }

    try {
      const dbInfo = forceRefresh
        ? ((await notion.databases.retrieve({ database_id: cleanId })) as unknown as NotionDatabaseLike)
        : await fetchDatabase(cleanId)
      const dsId = dbInfo?.data_sources?.[0]?.id
      if (dsId) {
        if ((dsGenerations.get(norm) || 0) === startGen) setCache(cacheKey, dsId)
        return dsId
      }
      throw new Error(`Notion database "${cleanId}" returned no data_sources`)
    } catch (err: unknown) {
      // Only fall back to dataSources.retrieve on explicit 404 object_not_found with untyped ID;
      // never swallow transient timeouts/429/5xx or cache unverified IDs.
      if (
        explicitKind === 'database_id' ||
        !isNotionNotFoundError(err) ||
        typeof notion.dataSources?.retrieve !== 'function'
      ) {
        throw err
      }
      const dsInfo = (await notion.dataSources.retrieve({
        data_source_id: cleanId,
      })) as unknown as NotionDataSourceLike
      if (!dsInfo?.id) {
        throw err
      }
      if ((dsGenerations.get(norm) || 0) === startGen) setCache(cacheKey, dsInfo.id)
      return dsInfo.id
    }
  })().finally(() => {
    if (flightMap.get(cacheKey) === promise) {
      flightMap.delete(cacheKey)
    }
  })

  flightMap.set(cacheKey, promise)
  return promise
}

export async function queryDatabase(
  dbId: string,
  options: QueryDatabaseOptions = {}
): Promise<NotionQueryResultLike> {
  const cleanId = String(dbId || '').trim()
  const { __ttl, __isDataSourceId, __databaseId, ...queryOptions } = options
  const ttl = __ttl || CACHE_TTL
  const key = `db-query-${cleanId}-${JSON.stringify(queryOptions)}`
  const cached = getCache<NotionQueryResultLike>(key, ttl)
  if (cached) return cached

  let res: NotionQueryResultLike
  if (typeof notion.dataSources?.query === 'function') {
    res = await executePublicDataSourceQueryWithRecovery<NotionQueryResultLike>({
      targetId: cleanId,
      isDataSourceId: Boolean(__isDataSourceId),
      parentDatabaseId: __databaseId || null,
      resolveDataSource: resolvePublicDataSourceId,
      invalidateMapping: invalidatePublicDataSourceCache,
      runQuery: (dsId) =>
        notion.dataSources.query({
          data_source_id: dsId,
          ...(queryOptions as Record<string, unknown>),
        } as Parameters<typeof notion.dataSources.query>[0]) as unknown as Promise<NotionQueryResultLike>,
    })
  } else if (hasLegacyDatabaseQuery(notion.databases)) {
    res = await notion.databases.query({ database_id: cleanId, ...queryOptions })
  } else {
    throw new Error('Notion client does not support database or data source queries')
  }

  setCache(key, res)
  return res
}

export async function fetchPage(pageId: string): Promise<NotionPageLike> {
  const cacheId = isValidNotionId(pageId) ? normalizeNotionId(pageId) : pageId
  const key = `page-${cacheId}`
  const cached = getCache<NotionPageLike>(key)
  if (cached) return cached
  const res = (await notion.pages.retrieve({ page_id: pageId })) as unknown as NotionPageLike
  setCache(key, res)
  return res
}

export async function searchNotion(
  options: Parameters<typeof notion.search>[0] = {}
): Promise<NotionSearchResultLike> {
  const key = `search-${JSON.stringify(options)}`
  const cached = getCache<NotionSearchResultLike>(key)
  if (cached) return cached
  const res = (await notion.search(options)) as unknown as NotionSearchResultLike
  setCache(key, res)
  return res
}

export async function queryDatabaseAll(
  dbId: string,
  options: QueryDatabaseOptions = {}
): Promise<{ results: NotionPageLike[] }> {
  const results: NotionPageLike[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  do {
    const res = await queryDatabase(dbId, {
      ...options,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    results.push(...(res?.results || []))
    cursor = res?.has_more && res.next_cursor ? res.next_cursor : undefined
    pages++
  } while (cursor && pages < MAX_PAGINATION_PAGES)
  return { results }
}

export async function listAllChildren(blockId: string): Promise<NotionBlockLike[]> {
  const results: NotionBlockLike[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  do {
    const res = await fetchChildrenList(blockId, cursor)
    results.push(...((res?.results || []) as unknown as NotionBlockLike[]))
    cursor = res?.has_more && res.next_cursor ? res.next_cursor : undefined
    pages++
  } while (cursor && pages < MAX_PAGINATION_PAGES)
  return results
}
