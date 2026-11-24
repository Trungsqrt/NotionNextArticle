/**
 * lib/study/notion-data-source.ts — Verified Notion Database / Data Source ID resolver
 * ────────────────────────────────────────────────────────────────────────────────────
 * Explicitly distinguishes Notion `database_id` from `data_source_id` using verified
 * API responses, preventing permanent cache poisoning after transient errors.
 *
 * Guarantees:
 * - NEVER caches unverified IDs or fallback results on error.
 * - Distinguishes transient errors (429, 5xx, timeouts) from invalid IDs (404) and
 *   permission errors (401/403).
 * - Bounded TTL cache (default 15m, max 100 entries) with LRU eviction.
 * - Single-flight deduplication so concurrent cache misses share one resolution call.
 * - Multi-data-source selection verifies expected property schema instead of blindly
 *   picking `data_sources[0]`.
 * - Emits secret-safe structured logs for cache HIT/MISS, invalidation, recovery,
 *   schema mismatch, and upstream errors.
 */

export type NotionIdentifierKind = 'database_id' | 'data_source_id'

export type NotionErrorCategory =
  | 'transient'
  | 'permission'
  | 'not_found'
  | 'validation'
  | 'unknown'

export interface ResolvedNotionDataSource {
  inputId: string
  inputKind: NotionIdentifierKind
  databaseId: string | null
  dataSourceId: string
  dataSourceName: string | null
  propertyNames: string[]
  resolvedAt: number
  expiresAt: number
}

export interface DataSourceCandidateSummary {
  id?: string
  name?: string
}

export interface RetrievedDatabaseLike {
  id?: string
  object?: string
  data_sources?: DataSourceCandidateSummary[]
  properties?: Record<string, unknown>
}

export interface RetrievedDataSourceLike {
  id?: string
  object?: string
  name?: string
  parent?: {
    type?: string
    database_id?: string
  }
  properties?: Record<string, unknown>
}

export interface DataSourceResolverAdapter {
  retrieveDatabase(databaseId: string): Promise<RetrievedDatabaseLike>
  retrieveDataSource?(dataSourceId: string): Promise<RetrievedDataSourceLike>
}

export interface ResolveDataSourceOptions {
  /** Expected Notion property names used to verify schema & disambiguate multi-data-source DBs */
  expectedProperties?: readonly string[]
  /** When true, throws DataSourceResolutionError('schema_mismatch') if expectedProperties are missing */
  requireSchemaMatch?: boolean
  /** Bypasses any cached entry and performs a fresh verified lookup */
  forceRefresh?: boolean
}

export interface DataSourceResolverLogger {
  info?(event: string, meta: Record<string, unknown>): void
  warn?(event: string, meta: Record<string, unknown>): void
  error?(event: string, meta: Record<string, unknown>): void
}

export class DataSourceResolutionError extends Error {
  readonly category: NotionErrorCategory | 'schema_mismatch' | 'ambiguous_data_source'
  readonly httpStatus?: number
  readonly notionCode?: string

  constructor(
    message: string,
    options: {
      category: NotionErrorCategory | 'schema_mismatch' | 'ambiguous_data_source'
      httpStatus?: number
      notionCode?: string
    }
  ) {
    super(message)
    this.name = 'DataSourceResolutionError'
    this.category = options.category
    this.httpStatus = options.httpStatus
    this.notionCode = options.notionCode
  }
}

export function extractNotionErrorInfo(err: unknown): {
  status: number | null
  code: string | null
  category: NotionErrorCategory
} {
  if (!err || typeof err !== 'object') {
    return { status: null, code: null, category: 'unknown' }
  }
  const e = err as {
    status?: unknown
    statusCode?: unknown
    code?: unknown
    notionCode?: unknown
    name?: unknown
    message?: unknown
  }
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : null
  const code =
    typeof e.notionCode === 'string'
      ? e.notionCode
      : typeof e.code === 'string'
        ? e.code
        : null
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  const name = typeof e.name === 'string' ? e.name.toLowerCase() : ''

  if (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 'rate_limited' ||
    code === 'service_unavailable' ||
    code === 'internal_server_error' ||
    code === 'notionhq_client_request_timeout' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    name.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset')
  ) {
    return { status, code, category: 'transient' }
  }

  if (
    status === 401 ||
    status === 403 ||
    code === 'unauthorized' ||
    code === 'restricted_resource'
  ) {
    return { status, code, category: 'permission' }
  }

  if (status === 404 || code === 'object_not_found') {
    return { status: status ?? 404, code: code ?? 'object_not_found', category: 'not_found' }
  }

  if (status === 400 || code === 'validation_error') {
    return { status: status ?? 400, code: code ?? 'validation_error', category: 'validation' }
  }

  return { status, code, category: 'unknown' }
}

function normalizeNotionId(id: string): string {
  return id.replace(/-/g, '').trim().toLowerCase()
}

function defaultLogger(): DataSourceResolverLogger {
  return {
    info(event, meta) {
      if (process.env.STUDY_NOTION_DEBUG === 'true') {
        console.info(`[study-notion/ds] ${event}`, meta)
      }
    },
    warn(event, meta) {
      console.warn(`[study-notion/ds] ${event}`, meta)
    },
    error(event, meta) {
      console.error(`[study-notion/ds] ${event}`, meta)
    },
  }
}

export interface DataSourceResolver {
  resolve(inputId: string, options?: ResolveDataSourceOptions): Promise<ResolvedNotionDataSource>
  invalidate(inputId: string, reason?: string): void
  clear(): void
  getCacheSize(): number
}

export function createDataSourceResolver(
  adapter: DataSourceResolverAdapter,
  config?: {
    ttlMs?: number
    maxEntries?: number
    nowFn?: () => number
    logger?: DataSourceResolverLogger
  }
): DataSourceResolver {
  const ttlMs = Math.max(1000, config?.ttlMs ?? 15 * 60 * 1000) // 15 min default
  const maxEntries = Math.max(1, config?.maxEntries ?? 100)
  const nowFn = config?.nowFn ?? (() => Date.now())
  const fallbackLogger = defaultLogger()
  const logger: Required<DataSourceResolverLogger> = {
    info: config?.logger?.info ?? fallbackLogger.info!,
    warn: config?.logger?.warn ?? fallbackLogger.warn!,
    error: config?.logger?.error ?? fallbackLogger.error!,
  }

  const cache = new Map<string, ResolvedNotionDataSource>()
  const inFlight = new Map<string, Promise<ResolvedNotionDataSource>>()

  function buildCacheKey(inputId: string, expectedProperties?: readonly string[]): string {
    const normId = normalizeNotionId(inputId)
    if (!expectedProperties || expectedProperties.length === 0) return normId
    const sortedProps = [...expectedProperties].map((p) => p.trim()).sort().join('|')
    return `${normId}::${sortedProps}`
  }

  function readCached(key: string): ResolvedNotionDataSource | null {
    const entry = cache.get(key)
    if (!entry) return null
    if (nowFn() >= entry.expiresAt) {
      cache.delete(key)
      return null
    }
    // Touch for LRU recency
    cache.delete(key)
    cache.set(key, entry)
    return entry
  }

  function writeCached(key: string, entry: ResolvedNotionDataSource): void {
    if (cache.has(key)) {
      cache.delete(key)
    } else if (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    cache.set(key, entry)
  }

  function findMissingProperties(
    actualPropNames: readonly string[],
    expectedProperties?: readonly string[]
  ): string[] {
    if (!expectedProperties || expectedProperties.length === 0) return []
    const actualSet = new Set(actualPropNames)
    return expectedProperties.filter((p) => !actualSet.has(p))
  }

  async function inspectCandidateSchema(
    candidateId: string,
    fallbackProps?: Record<string, unknown>
  ): Promise<{ name: string | null; propertyNames: string[] }> {
    if (adapter.retrieveDataSource) {
      const ds = await adapter.retrieveDataSource(candidateId)
      const props = ds?.properties || fallbackProps || {}
      return {
        name: typeof ds?.name === 'string' ? ds.name : null,
        propertyNames: Object.keys(props),
      }
    }
    return {
      name: null,
      propertyNames: Object.keys(fallbackProps || {}),
    }
  }

  async function resolveUncached(
    cleanId: string,
    options: ResolveDataSourceOptions
  ): Promise<ResolvedNotionDataSource> {
    const expectedProps = options.expectedProperties

    // Step 1: Try retrieving as a Notion Database first
    let dbInfo: RetrievedDatabaseLike | null = null
    try {
      dbInfo = await adapter.retrieveDatabase(cleanId)
    } catch (err) {
      const info = extractNotionErrorInfo(err)
      // Transient and permission errors MUST NOT fall through to dataSources.retrieve or cache!
      if (info.category === 'transient') {
        logger.warn('upstream_error', {
          op: 'databases.retrieve',
          inputId: cleanId,
          category: info.category,
          httpStatus: info.status,
          notionCode: info.code,
        })
        throw new DataSourceResolutionError(
          `Transient Notion error while resolving database "${cleanId}"`,
          { category: 'transient', httpStatus: info.status ?? undefined, notionCode: info.code ?? undefined }
        )
      }
      if (info.category === 'permission') {
        logger.error('upstream_error', {
          op: 'databases.retrieve',
          inputId: cleanId,
          category: info.category,
          httpStatus: info.status,
          notionCode: info.code,
        })
        throw new DataSourceResolutionError(
          `Permission denied accessing Notion database "${cleanId}" (check integration sharing)`,
          { category: 'permission', httpStatus: info.status ?? undefined, notionCode: info.code ?? undefined }
        )
      }
      if (info.category !== 'not_found') {
        logger.error('upstream_error', {
          op: 'databases.retrieve',
          inputId: cleanId,
          category: info.category,
          httpStatus: info.status,
          notionCode: info.code,
        })
        throw err
      }
      // Only on 404 object_not_found do we check whether cleanId is already a data_source_id
    }

    // Step 2: If databases.retrieve succeeded, verify & select the right data_source
    if (dbInfo) {
      const candidates = Array.isArray(dbInfo.data_sources)
        ? dbInfo.data_sources.filter((ds): ds is { id: string; name?: string } => Boolean(ds?.id))
        : []

      if (candidates.length === 0) {
        throw new DataSourceResolutionError(
          `Notion database "${cleanId}" returned no data_sources`,
          { category: 'not_found', httpStatus: 404 }
        )
      }

      if (candidates.length === 1) {
        const only = candidates[0]
        let propertyNames = Object.keys(dbInfo.properties || {})
        let dsName = typeof only.name === 'string' ? only.name : null

        if (expectedProps && expectedProps.length > 0 && propertyNames.length === 0 && adapter.retrieveDataSource) {
          try {
            const inspected = await inspectCandidateSchema(only.id, dbInfo.properties)
            propertyNames = inspected.propertyNames
            dsName = inspected.name ?? dsName
          } catch (schemaErr) {
            const sInfo = extractNotionErrorInfo(schemaErr)
            if (sInfo.category === 'transient' || sInfo.category === 'permission') {
              throw new DataSourceResolutionError(
                `Failed to inspect data source "${only.id}" schema (${sInfo.category})`,
                {
                  category: sInfo.category,
                  httpStatus: sInfo.status ?? undefined,
                  notionCode: sInfo.code ?? undefined,
                }
              )
            }
          }
        }

        const missing = findMissingProperties(propertyNames, expectedProps)
        if (missing.length > 0 && propertyNames.length > 0) {
          logger.warn('schema_mismatch', {
            inputId: cleanId,
            dataSourceId: only.id,
            dataSourceName: dsName,
            missingProperties: missing,
          })
          if (options.requireSchemaMatch) {
            throw new DataSourceResolutionError(
              `Data source "${only.id}" is missing required Notion properties: ${missing.join(', ')}`,
              { category: 'schema_mismatch' }
            )
          }
        }

        const now = nowFn()
        return {
          inputId: cleanId,
          inputKind: 'database_id',
          databaseId: dbInfo.id || cleanId,
          dataSourceId: only.id,
          dataSourceName: dsName,
          propertyNames,
          resolvedAt: now,
          expiresAt: now + ttlMs,
        }
      }

      // Multiple data sources exist: DO NOT blindly select data_sources[0]!
      if (!adapter.retrieveDataSource || !expectedProps || expectedProps.length === 0) {
        logger.error('ambiguous_data_source', {
          inputId: cleanId,
          candidateCount: candidates.length,
        })
        throw new DataSourceResolutionError(
          `Database "${cleanId}" has ${candidates.length} data sources; expectedProperties are required to select the intended data source`,
          { category: 'ambiguous_data_source' }
        )
      }

      const inspectedCandidates: Array<{
        id: string
        name: string | null
        propertyNames: string[]
        missing: string[]
      }> = []

      for (const cand of candidates) {
        const inspected = await inspectCandidateSchema(cand.id)
        inspectedCandidates.push({
          id: cand.id,
          name: inspected.name ?? (typeof cand.name === 'string' ? cand.name : null),
          propertyNames: inspected.propertyNames,
          missing: findMissingProperties(inspected.propertyNames, expectedProps),
        })
      }

      const exactMatches = inspectedCandidates.filter((c) => c.missing.length === 0)
      if (exactMatches.length === 1) {
        const chosen = exactMatches[0]
        const now = nowFn()
        return {
          inputId: cleanId,
          inputKind: 'database_id',
          databaseId: dbInfo.id || cleanId,
          dataSourceId: chosen.id,
          dataSourceName: chosen.name,
          propertyNames: chosen.propertyNames,
          resolvedAt: now,
          expiresAt: now + ttlMs,
        }
      }

      logger.error('schema_mismatch', {
        inputId: cleanId,
        candidateCount: candidates.length,
        exactMatchCount: exactMatches.length,
        expectedProperties: [...expectedProps],
      })
      throw new DataSourceResolutionError(
        exactMatches.length === 0
          ? `None of the ${candidates.length} data sources in database "${cleanId}" match expected properties (${expectedProps.join(', ')})`
          : `Multiple (${exactMatches.length}) data sources in database "${cleanId}" ambiguously match expected properties`,
        { category: exactMatches.length === 0 ? 'schema_mismatch' : 'ambiguous_data_source' }
      )
    }

    // Step 3: databases.retrieve returned 404 object_not_found -> verify if cleanId is a data_source_id
    if (!adapter.retrieveDataSource) {
      throw new DataSourceResolutionError(
        `Notion database "${cleanId}" not found and SDK cannot verify data_source_id`,
        { category: 'not_found', httpStatus: 404, notionCode: 'object_not_found' }
      )
    }

    try {
      const dsInfo = await adapter.retrieveDataSource(cleanId)
      if (!dsInfo?.id) {
        throw new DataSourceResolutionError(
          `Invalid Notion data source response for "${cleanId}"`,
          { category: 'not_found', httpStatus: 404, notionCode: 'object_not_found' }
        )
      }

      const propertyNames = Object.keys(dsInfo.properties || {})
      const missing = findMissingProperties(propertyNames, expectedProps)
      if (missing.length > 0 && propertyNames.length > 0) {
        logger.warn('schema_mismatch', {
          inputId: cleanId,
          dataSourceId: dsInfo.id,
          dataSourceName: dsInfo.name ?? null,
          missingProperties: missing,
        })
        if (options.requireSchemaMatch) {
          throw new DataSourceResolutionError(
            `Data source "${dsInfo.id}" is missing required Notion properties: ${missing.join(', ')}`,
            { category: 'schema_mismatch' }
          )
        }
      }

      const now = nowFn()
      return {
        inputId: cleanId,
        inputKind: 'data_source_id',
        databaseId: dsInfo.parent?.database_id || null,
        dataSourceId: dsInfo.id,
        dataSourceName: typeof dsInfo.name === 'string' ? dsInfo.name : null,
        propertyNames,
        resolvedAt: now,
        expiresAt: now + ttlMs,
      }
    } catch (dsErr) {
      if (dsErr instanceof DataSourceResolutionError) throw dsErr
      const info = extractNotionErrorInfo(dsErr)
      logger.error('upstream_error', {
        op: 'dataSources.retrieve',
        inputId: cleanId,
        category: info.category,
        httpStatus: info.status,
        notionCode: info.code,
      })
      throw new DataSourceResolutionError(
        info.category === 'not_found'
          ? `Notion identifier "${cleanId}" is neither an accessible database_id nor a valid data_source_id`
          : `Failed to verify Notion data_source "${cleanId}" (${info.category})`,
        {
          category: info.category,
          httpStatus: info.status ?? undefined,
          notionCode: info.code ?? undefined,
        }
      )
    }
  }

  return {
    async resolve(
      inputId: string,
      options: ResolveDataSourceOptions = {}
    ): Promise<ResolvedNotionDataSource> {
      const cleanId = inputId.trim()
      const key = buildCacheKey(cleanId, options.expectedProperties)

      if (!options.forceRefresh) {
        const cached = readCached(key)
        if (cached) {
          logger.info('cache_hit', {
            inputId: cleanId,
            inputKind: cached.inputKind,
            dataSourceId: cached.dataSourceId,
          })
          return cached
        }
      }

      const existingFlight = inFlight.get(key)
      if (existingFlight && !options.forceRefresh) {
        logger.info('single_flight_join', { inputId: cleanId })
        return existingFlight
      }

      logger.info('cache_miss', { inputId: cleanId, forceRefresh: Boolean(options.forceRefresh) })

      const promise = resolveUncached(cleanId, options)
        .then((resolved) => {
          writeCached(key, resolved)
          logger.info('resolved', {
            inputId: cleanId,
            inputKind: resolved.inputKind,
            dataSourceId: resolved.dataSourceId,
            databaseId: resolved.databaseId,
          })
          return resolved
        })
        .finally(() => {
          if (inFlight.get(key) === promise) {
            inFlight.delete(key)
          }
        })

      inFlight.set(key, promise)
      return promise
    },

    invalidate(inputId: string, reason: string = 'manual'): void {
      const normPrefix = normalizeNotionId(inputId)
      let removed = 0
      for (const k of [...cache.keys()]) {
        if (k === normPrefix || k.startsWith(`${normPrefix}::`)) {
          cache.delete(k)
          removed += 1
        }
      }
      if (removed > 0) {
        logger.warn('cache_invalidate', { inputId: inputId.trim(), reason, removed })
      }
    },

    clear(): void {
      cache.clear()
      inFlight.clear()
    },

    getCacheSize(): number {
      return cache.size
    },
  }
}
