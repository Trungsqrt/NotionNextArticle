/**
 * Verified Notion database_id / data_source_id resolver for the Private Study Room.
 *
 * - Distinguishes `database_id` from `data_source_id` via verified API responses
 *   (or optional `db:` / `ds:` prefixes for backward-compatible zero-probe config).
 * - Never caches unverified IDs, failed lookups, or schema-incompatible data sources.
 * - Uses bounded TTL LRU caching, single-flight deduplication (normal + forceRefresh),
 *   and per-ID generation counters to prevent stale in-flight cache overwrites.
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

export interface RetrievedDatabaseLike {
  id?: string
  object?: string
  data_sources?: Array<{ id?: string; name?: string }>
  properties?: Record<string, unknown>
}

export interface RetrievedDataSourceLike {
  id?: string
  object?: string
  name?: string
  parent?: { type?: string; database_id?: string }
  properties?: Record<string, unknown>
}

export interface DataSourceResolverAdapter {
  retrieveDatabase(databaseId: string): Promise<RetrievedDatabaseLike>
  retrieveDataSource?(dataSourceId: string): Promise<RetrievedDataSourceLike>
}

export interface ResolveDataSourceOptions {
  expectedProperties?: readonly string[]
  requireSchemaMatch?: boolean
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

export function normalizeNotionId(id: string): string {
  return id.replace(/-/g, '').trim().toLowerCase()
}

export function parseTypedNotionIdentifier(raw: string): {
  id: string
  explicitKind: NotionIdentifierKind | null
} {
  const trimmed = raw.trim()
  const match = /^(db|database|ds|data_source):(.+)$/i.exec(trimmed)
  if (!match) return { id: trimmed, explicitKind: null }
  const prefix = match[1].toLowerCase()
  return {
    id: match[2].trim(),
    explicitKind: prefix === 'ds' || prefix === 'data_source' ? 'data_source_id' : 'database_id',
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
    (status !== null && status >= 500 && status <= 504) ||
    code === 'rate_limited' ||
    code === 'service_unavailable' ||
    code === 'internal_server_error' ||
    code === 'notionhq_client_request_timeout' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    name.includes('timeout') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset')
  ) {
    return { status, code, category: 'transient' }
  }

  if (status === 401 || status === 403 || code === 'unauthorized' || code === 'restricted_resource') {
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

const DEFAULT_LOGGER: Required<DataSourceResolverLogger> = {
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
  const ttlMs = Math.max(1000, config?.ttlMs ?? 15 * 60 * 1000)
  const maxEntries = Math.max(1, config?.maxEntries ?? 100)
  const nowFn = config?.nowFn ?? (() => Date.now())
  const logger: Required<DataSourceResolverLogger> = {
    info: config?.logger?.info ?? DEFAULT_LOGGER.info,
    warn: config?.logger?.warn ?? DEFAULT_LOGGER.warn,
    error: config?.logger?.error ?? DEFAULT_LOGGER.error,
  }

  const cache = new Map<string, ResolvedNotionDataSource>()
  const inFlight = new Map<string, Promise<ResolvedNotionDataSource>>()
  const inFlightRefresh = new Map<string, Promise<ResolvedNotionDataSource>>()
  const generations = new Map<string, number>()

  const getGeneration = (normId: string) => generations.get(normId) || 0

  function buildCacheKey(cleanId: string, expectedProperties?: readonly string[]): string {
    const normId = normalizeNotionId(cleanId)
    if (!expectedProperties?.length) return normId
    return `${normId}::${[...expectedProperties].map((p) => p.trim()).sort().join('|')}`
  }

  function readCached(key: string): ResolvedNotionDataSource | null {
    const entry = cache.get(key)
    if (!entry) return null
    if (nowFn() >= entry.expiresAt) {
      cache.delete(key)
      return null
    }
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

  function makeResolved(
    fields: Omit<ResolvedNotionDataSource, 'resolvedAt' | 'expiresAt'>
  ): ResolvedNotionDataSource {
    const now = nowFn()
    return { ...fields, resolvedAt: now, expiresAt: now + ttlMs }
  }

  function findMissingProperties(
    actualPropNames: readonly string[],
    expectedProperties?: readonly string[]
  ): string[] {
    if (!expectedProperties?.length) return []
    const actualSet = new Set(actualPropNames)
    return expectedProperties.filter((p) => !actualSet.has(p))
  }

  function validateSchema(
    resolved: ResolvedNotionDataSource,
    options: ResolveDataSourceOptions
  ): void {
    const expectedProps = options.expectedProperties
    if (!expectedProps?.length) return

    if (resolved.propertyNames.length === 0) {
      if (options.requireSchemaMatch) {
        logger.error('schema_mismatch', {
          inputId: resolved.inputId,
          dataSourceId: resolved.dataSourceId,
          reason: 'missing_schema_metadata',
          expectedProperties: [...expectedProps],
        })
        throw new DataSourceResolutionError(
          `Data source "${resolved.dataSourceId}" returned no schema metadata; cannot verify required properties (${expectedProps.join(', ')})`,
          { category: 'schema_mismatch' }
        )
      }
      return
    }

    const missing = findMissingProperties(resolved.propertyNames, expectedProps)
    if (missing.length > 0) {
      logger.warn('schema_mismatch', {
        inputId: resolved.inputId,
        dataSourceId: resolved.dataSourceId,
        dataSourceName: resolved.dataSourceName,
        missingProperties: missing,
      })
      if (options.requireSchemaMatch) {
        throw new DataSourceResolutionError(
          `Data source "${resolved.dataSourceId}" is missing required Notion properties: ${missing.join(', ')}`,
          { category: 'schema_mismatch' }
        )
      }
    }
  }

  function failUpstream(
    op: string,
    inputId: string,
    err: unknown,
    message: string
  ): never {
    const info = extractNotionErrorInfo(err)
    const logFn = info.category === 'transient' ? logger.warn : logger.error
    logFn('upstream_error', {
      op,
      inputId,
      category: info.category,
      httpStatus: info.status,
      notionCode: info.code,
    })
    throw new DataSourceResolutionError(message, {
      category: info.category,
      httpStatus: info.status ?? undefined,
      notionCode: info.code ?? undefined,
    })
  }

  async function inspectCandidateSchema(
    candidateId: string,
    fallbackProps?: Record<string, unknown>
  ): Promise<{ name: string | null; propertyNames: string[] }> {
    if (!adapter.retrieveDataSource) {
      return { name: null, propertyNames: Object.keys(fallbackProps || {}) }
    }
    const ds = await adapter.retrieveDataSource(candidateId)
    return {
      name: typeof ds?.name === 'string' ? ds.name : null,
      propertyNames: Object.keys(ds?.properties || fallbackProps || {}),
    }
  }

  async function resolveAsDataSourceDirect(
    cleanId: string,
    options: ResolveDataSourceOptions
  ): Promise<ResolvedNotionDataSource> {
    if (!adapter.retrieveDataSource) {
      throw new DataSourceResolutionError(
        `Notion identifier "${cleanId}" cannot be verified as a data_source_id without dataSources.retrieve`,
        { category: 'not_found', httpStatus: 404, notionCode: 'object_not_found' }
      )
    }

    try {
      const dsInfo = await adapter.retrieveDataSource(cleanId)
      if (!dsInfo?.id) {
        throw new DataSourceResolutionError(`Invalid Notion data source response for "${cleanId}"`, {
          category: 'not_found',
          httpStatus: 404,
          notionCode: 'object_not_found',
        })
      }
      const resolved = makeResolved({
        inputId: cleanId,
        inputKind: 'data_source_id',
        databaseId: dsInfo.parent?.database_id || null,
        dataSourceId: dsInfo.id,
        dataSourceName: typeof dsInfo.name === 'string' ? dsInfo.name : null,
        propertyNames: Object.keys(dsInfo.properties || {}),
      })
      validateSchema(resolved, options)
      return resolved
    } catch (dsErr) {
      if (dsErr instanceof DataSourceResolutionError) throw dsErr
      const info = extractNotionErrorInfo(dsErr)
      failUpstream(
        'dataSources.retrieve',
        cleanId,
        dsErr,
        info.category === 'not_found'
          ? `Notion identifier "${cleanId}" is neither an accessible database_id nor a valid data_source_id`
          : `Failed to verify Notion data_source "${cleanId}" (${info.category})`
      )
    }
  }

  async function resolveUncached(
    rawInputId: string,
    options: ResolveDataSourceOptions
  ): Promise<ResolvedNotionDataSource> {
    const { id: cleanId, explicitKind } = parseTypedNotionIdentifier(rawInputId)
    const expectedProps = options.expectedProperties

    if (explicitKind === 'data_source_id') {
      return resolveAsDataSourceDirect(cleanId, options)
    }

    let dbInfo: RetrievedDatabaseLike | null = null
    try {
      dbInfo = await adapter.retrieveDatabase(cleanId)
    } catch (err) {
      const info = extractNotionErrorInfo(err)
      if (info.category === 'transient') {
        failUpstream(
          'databases.retrieve',
          cleanId,
          err,
          `Transient Notion error while resolving database "${cleanId}"`
        )
      }
      if (info.category === 'permission') {
        failUpstream(
          'databases.retrieve',
          cleanId,
          err,
          `Permission denied accessing Notion database "${cleanId}" (check integration sharing)`
        )
      }
      if (info.category !== 'not_found' || explicitKind === 'database_id') {
        if (info.category === 'not_found') {
          failUpstream(
            'databases.retrieve',
            cleanId,
            err,
            `Explicit database_id "${cleanId}" was not found`
          )
        }
        logger.error('upstream_error', {
          op: 'databases.retrieve',
          inputId: cleanId,
          category: info.category,
          httpStatus: info.status,
          notionCode: info.code,
        })
        throw err
      }
      // Untyped ID returned 404 on databases.retrieve; check if it is a data_source_id
    }

    if (!dbInfo) {
      return resolveAsDataSourceDirect(cleanId, options)
    }

    const candidates = Array.isArray(dbInfo.data_sources)
      ? dbInfo.data_sources.filter((ds): ds is { id: string; name?: string } => Boolean(ds?.id))
      : []

    if (candidates.length === 0) {
      throw new DataSourceResolutionError(`Notion database "${cleanId}" returned no data_sources`, {
        category: 'not_found',
        httpStatus: 404,
      })
    }

    if (candidates.length === 1) {
      const only = candidates[0]
      let propertyNames = Object.keys(dbInfo.properties || {})
      let dsName = typeof only.name === 'string' ? only.name : null

      if (expectedProps?.length && propertyNames.length === 0 && adapter.retrieveDataSource) {
        try {
          const inspected = await inspectCandidateSchema(only.id, dbInfo.properties)
          propertyNames = inspected.propertyNames
          dsName = inspected.name ?? dsName
        } catch (schemaErr) {
          const sInfo = extractNotionErrorInfo(schemaErr)
          if (sInfo.category === 'transient' || sInfo.category === 'permission') {
            failUpstream(
              'dataSources.retrieve',
              only.id,
              schemaErr,
              `Failed to inspect data source "${only.id}" schema (${sInfo.category})`
            )
          }
        }
      }

      const resolved = makeResolved({
        inputId: cleanId,
        inputKind: 'database_id',
        databaseId: dbInfo.id || cleanId,
        dataSourceId: only.id,
        dataSourceName: dsName,
        propertyNames,
      })
      validateSchema(resolved, options)
      return resolved
    }

    // Multiple data sources exist: require expectedProperties to select deterministically
    if (!adapter.retrieveDataSource || !expectedProps?.length) {
      logger.error('ambiguous_data_source', { inputId: cleanId, candidateCount: candidates.length })
      throw new DataSourceResolutionError(
        `Database "${cleanId}" has ${candidates.length} data sources; expectedProperties are required to select the intended data source`,
        { category: 'ambiguous_data_source' }
      )
    }

    const inspectedCandidates = await Promise.all(
      candidates.map(async (cand) => {
        const inspected = await inspectCandidateSchema(cand.id)
        return {
          id: cand.id,
          name: inspected.name ?? (typeof cand.name === 'string' ? cand.name : null),
          propertyNames: inspected.propertyNames,
          missing: findMissingProperties(inspected.propertyNames, expectedProps),
        }
      })
    )

    const exactMatches = inspectedCandidates.filter(
      (c) => c.propertyNames.length > 0 && c.missing.length === 0
    )
    if (exactMatches.length === 1) {
      const chosen = exactMatches[0]
      return makeResolved({
        inputId: cleanId,
        inputKind: 'database_id',
        databaseId: dbInfo.id || cleanId,
        dataSourceId: chosen.id,
        dataSourceName: chosen.name,
        propertyNames: chosen.propertyNames,
      })
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

  return {
    async resolve(
      inputId: string,
      options: ResolveDataSourceOptions = {}
    ): Promise<ResolvedNotionDataSource> {
      const { id: cleanId } = parseTypedNotionIdentifier(inputId)
      const normId = normalizeNotionId(cleanId)
      const key = buildCacheKey(cleanId, options.expectedProperties)

      if (!options.forceRefresh) {
        const cached = readCached(key)
        if (cached) {
          if (
            options.requireSchemaMatch &&
            options.expectedProperties?.length &&
            cached.propertyNames.length === 0
          ) {
            cache.delete(key)
          } else {
            validateSchema(cached, options)
            logger.info('cache_hit', {
              inputId: cleanId,
              inputKind: cached.inputKind,
              dataSourceId: cached.dataSourceId,
            })
            return cached
          }
        }
      }

      const flightMap = options.forceRefresh ? inFlightRefresh : inFlight
      const existingFlight = flightMap.get(key)
      if (existingFlight) {
        logger.info('single_flight_join', {
          inputId: cleanId,
          forceRefresh: Boolean(options.forceRefresh),
        })
        const joined = await existingFlight
        validateSchema(joined, options)
        return joined
      }

      logger.info('cache_miss', { inputId: cleanId, forceRefresh: Boolean(options.forceRefresh) })
      const startGeneration = getGeneration(normId)

      const promise = resolveUncached(inputId, options)
        .then((resolved) => {
          if (getGeneration(normId) === startGeneration) {
            writeCached(key, resolved)
            logger.info('resolved', {
              inputId: cleanId,
              inputKind: resolved.inputKind,
              dataSourceId: resolved.dataSourceId,
              databaseId: resolved.databaseId,
            })
          } else {
            logger.warn('stale_inflight_discarded', {
              inputId: cleanId,
              dataSourceId: resolved.dataSourceId,
            })
          }
          return resolved
        })
        .finally(() => {
          if (flightMap.get(key) === promise) {
            flightMap.delete(key)
          }
        })

      flightMap.set(key, promise)
      return promise
    },

    invalidate(inputId: string, reason: string = 'manual'): void {
      const { id: cleanId } = parseTypedNotionIdentifier(inputId)
      const normPrefix = normalizeNotionId(cleanId)
      generations.set(normPrefix, getGeneration(normPrefix) + 1)

      let removed = 0
      for (const k of [...cache.keys()]) {
        if (k === normPrefix || k.startsWith(`${normPrefix}::`)) {
          cache.delete(k)
          removed += 1
        }
      }
      for (const k of [...inFlight.keys()]) {
        if (k === normPrefix || k.startsWith(`${normPrefix}::`)) {
          inFlight.delete(k)
        }
      }
      if (removed > 0) {
        logger.warn('cache_invalidate', { inputId: cleanId, reason, removed })
      }
    },

    clear(): void {
      cache.clear()
      inFlight.clear()
      inFlightRefresh.clear()
      generations.clear()
    },

    getCacheSize(): number {
      return cache.size
    },
  }
}
