import { Client } from '@notionhq/client'
import pRetry, { AbortError } from 'p-retry'
import { TRANSLATION_STATUS_OPTIONS, type TranslationConfig } from './config'
import type {
  ArticlesDataSourceInfo,
  NotionPageLike,
  NotionPropertySchemaMap,
  RetryConfigOptions,
  UploadedAssetRecord,
  WorkerLogger,
} from './types'
import { defaultLogger } from '../../worker/logger'

const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  english: 'en',
  vietnamese: 'vi',
  'tiếng việt': 'vi',
  'tieng viet': 'vi',
}

export function normalizeLocaleCode(
  raw: unknown,
  defaultLocale = 'en'
): string {
  if (raw === null || raw === undefined) return defaultLocale
  const value = String(raw).trim().toLowerCase()
  if (!value) return defaultLocale
  if (LOCALE_ALIASES[value]) return LOCALE_ALIASES[value]
  const primary = value.split(/[-_]/)[0]
  if (primary && /^[a-z]{2,3}$/.test(primary)) return primary
  return defaultLocale
}

export function normalizeNotionId(id: unknown): string {
  return id ? String(id).replace(/-/g, '').trim().toLowerCase() : ''
}

export function normalizePropKey(name: unknown): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

export function findPropertyKey(
  propsOrSchema: Record<string, unknown> | null | undefined,
  candidates: string | readonly string[]
): string | null {
  if (!propsOrSchema || typeof propsOrSchema !== 'object') return null
  const byNorm = new Map<string, string>()
  for (const key of Object.keys(propsOrSchema)) {
    const norm = normalizePropKey(key)
    if (!byNorm.has(norm)) byNorm.set(norm, key)
  }
  const list = Array.isArray(candidates) ? candidates : [candidates]
  for (const candidate of list) {
    const found = byNorm.get(normalizePropKey(candidate))
    if (found) return found
  }
  return null
}

export function findPropertyEntry<T = Record<string, unknown>>(
  propsOrSchema: Record<string, T> | null | undefined,
  candidates: string | readonly string[]
): { key: string | null; prop: T | null } {
  const key = findPropertyKey(propsOrSchema, candidates)
  if (!key || !propsOrSchema) return { key: null, prop: null }
  return { key, prop: propsOrSchema[key] ?? null }
}

export function findTitlePropertyKey(
  propsOrSchema: Record<string, unknown> | null | undefined
): string {
  if (!propsOrSchema || typeof propsOrSchema !== 'object') return 'Name'
  for (const [key, val] of Object.entries(propsOrSchema)) {
    if (val && typeof val === 'object') {
      const record = val as Record<string, unknown>
      if (record.type === 'title' || record.title !== undefined) {
        return key
      }
    }
  }
  return 'Name'
}

function extractRichTextSegmentPlain(item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const r = item as Record<string, unknown>
  if (typeof r.plain_text === 'string') return r.plain_text
  const textObj = r.text as Record<string, unknown> | undefined
  if (typeof textObj?.content === 'string') return textObj.content
  const eqObj = r.equation as Record<string, unknown> | undefined
  if (typeof eqObj?.expression === 'string') return eqObj.expression
  return ''
}

export function getPropertyPlainText(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return ''
  const record = prop as Record<string, unknown>
  const type = record.type

  switch (type) {
    case 'title': {
      const titleArr = Array.isArray(record.title) ? record.title : []
      return titleArr.map(extractRichTextSegmentPlain).join('')
    }
    case 'rich_text': {
      const rtArr = Array.isArray(record.rich_text) ? record.rich_text : []
      return rtArr.map(extractRichTextSegmentPlain).join('')
    }
    case 'select': {
      const sel = record.select as { name?: string } | null | undefined
      return sel?.name || ''
    }
    case 'multi_select': {
      const ms = Array.isArray(record.multi_select) ? record.multi_select : []
      return ms
        .map((item) =>
          item && typeof item === 'object' && 'name' in item
            ? String((item as { name?: unknown }).name || '')
            : ''
        )
        .filter(Boolean)
        .join(', ')
    }
    case 'status': {
      const st = record.status as { name?: string } | null | undefined
      return st?.name || ''
    }
    case 'number':
      return record.number !== undefined && record.number !== null
        ? String(record.number)
        : ''
    case 'date': {
      const dt = record.date as { start?: string } | null | undefined
      return dt?.start || ''
    }
    case 'url':
      return typeof record.url === 'string' ? record.url : ''
    case 'checkbox':
      return typeof record.checkbox === 'boolean'
        ? record.checkbox
          ? 'true'
          : 'false'
        : ''
    case 'email':
      return typeof record.email === 'string' ? record.email : ''
    case 'phone_number':
      return typeof record.phone_number === 'string' ? record.phone_number : ''
    case 'formula': {
      const formula = record.formula as Record<string, unknown> | undefined
      if (!formula) return ''
      if (formula.type === 'string') return String(formula.string || '')
      if (formula.type === 'number')
        return formula.number !== null && formula.number !== undefined
          ? String(formula.number)
          : ''
      if (formula.type === 'boolean') return formula.boolean ? 'true' : 'false'
      if (formula.type === 'date') {
        const fDate = formula.date as { start?: string } | null | undefined
        return fDate?.start || ''
      }
      return ''
    }
    default:
      return ''
  }
}

function parseRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const errRecord = error as Record<string, unknown>
  const responseRecord = errRecord.response as
    | Record<string, unknown>
    | undefined
  const headers = (errRecord.headers || responseRecord?.headers) as
    | { get?: (name: string) => string | null; [key: string]: unknown }
    | undefined
  if (!headers) return null

  let raw: unknown = null
  if (typeof headers.get === 'function') {
    raw = headers.get('retry-after') || headers.get('Retry-After')
  } else if (typeof headers === 'object') {
    raw = headers['retry-after'] || headers['Retry-After']
  }
  if (!raw || typeof raw !== 'string') return null

  const seconds = Number(raw)
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000)
  }
  const dateMs = Date.parse(raw)
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now())
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableNotionError(err: unknown, isIdempotent: boolean): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    status?: number
    statusCode?: number
    code?: string
    name?: string
  }
  const status = e.status ?? e.statusCode ?? (e.code === 'rate_limited' ? 429 : null)

  const isRateLimitOrOverload =
    status === 429 ||
    status === 529 ||
    e.code === 'rate_limited' ||
    e.code === 'service_unavailable'

  const isTransientServerOrTimeout =
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    e.code === 'internal_server_error' ||
    e.code === 'notionhq_client_request_timeout' ||
    e.name === 'RequestTimeoutError' ||
    e.code === 'ETIMEDOUT' ||
    e.code === 'ECONNRESET'

  return isRateLimitOrOverload || (isIdempotent && isTransientServerOrTimeout)
}

/**
 * Executes a Notion API operation using `p-retry` with explicit 429/529 rate-limit handling,
 * Retry-After support, and exponential backoff.
 * Does NOT blindly retry non-idempotent operations on 500/timeout errors.
 */
export async function withNotionRetry<T>(
  operationFn: () => Promise<T>,
  options: RetryConfigOptions = {}
): Promise<T> {
  const {
    isIdempotent = true,
    maxRetries = 4,
    initialDelayMs = 1000,
    maxDelayMs = 60000,
    label = 'notion-api',
    logger = defaultLogger,
  } = options

  return pRetry(
    async () => {
      try {
        return await operationFn()
      } catch (err) {
        if (!isRetryableNotionError(err, isIdempotent)) {
          throw new AbortError(err instanceof Error ? err : new Error(String(err)))
        }
        const retryAfterMs = parseRetryAfterMs(err)
        if (retryAfterMs !== null && retryAfterMs > initialDelayMs) {
          await sleep(Math.min(maxDelayMs, retryAfterMs))
        }
        throw err
      }
    },
    {
      retries: maxRetries,
      minTimeout: initialDelayMs,
      maxTimeout: maxDelayMs,
      factor: 2,
      randomize: true,
      onFailedAttempt: (failedErr) => {
        const cause = failedErr as unknown as {
          status?: number
          code?: string
          attemptNumber: number
          retriesLeft: number
        }
        logger.warn(
          `Retrying ${label} (attempt ${cause.attemptNumber}/${maxRetries + 1})`,
          {
            status: cause?.status,
            code: cause?.code,
            retriesLeft: cause.retriesLeft,
          }
        )
      },
    }
  )
}

export function createNotionClient(
  config: Partial<TranslationConfig> = {},
  customClient: Client | null = null
): Client {
  if (customClient) return customClient
  const timeoutMs = Math.max(
    1000,
    Number(
      config.notionTimeoutMs ??
        process.env.TRANSLATION_NOTION_TIMEOUT_MS ??
        30000
    ) || 30000
  )
  return new Client({
    auth:
      config.notionToken ||
      process.env.NOTION_TOKEN ||
      process.env.NOTION_API_SECRET ||
      process.env.NOTION_TOKEN_V2,
    timeoutMs,
  })
}

export interface PaginatedListResponse<T> {
  results?: T[]
  has_more?: boolean
  next_cursor?: string | null
}

/**
 * Centralized, strict pagination helper for Notion cursor-paginated endpoints.
 * Guarantees:
 * - Continues until `has_more` is false.
 * - Throws if `has_more` is true but `next_cursor` is missing or empty.
 * - Throws if `next_cursor` repeats (infinite loop protection).
 * - Throws if `maxPages` is reached while `has_more` is still true (never silently truncates).
 */
export async function paginateNotionList<T>(
  fetchPageFn: (cursor?: string) => Promise<PaginatedListResponse<T>>,
  options: {
    label: string
    maxPaginationPages?: number
    config?: Partial<TranslationConfig>
  }
): Promise<T[]> {
  const maxPages = Math.max(
    1,
    Number(
      options.maxPaginationPages ??
        options.config?.maxPaginationPages ??
        process.env.TRANSLATION_MAX_PAGINATION_PAGES ??
        500
    ) || 500
  )

  const items: T[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined = undefined
  let pageCount = 0

  while (true) {
    const response = await fetchPageFn(cursor)
    const batch = Array.isArray(response?.results) ? response.results : []
    items.push(...batch)
    pageCount += 1

    if (!response?.has_more) {
      break
    }

    const nextCursor =
      typeof response.next_cursor === 'string'
        ? response.next_cursor.trim()
        : ''

    if (!nextCursor) {
      throw new Error(
        `Notion pagination error in ${options.label}: has_more is true but next_cursor is missing or empty.`
      )
    }

    if (seenCursors.has(nextCursor)) {
      throw new Error(
        `Notion pagination error in ${options.label}: repeated next_cursor "${nextCursor}" detected.`
      )
    }

    if (pageCount >= maxPages) {
      throw new Error(
        `Notion pagination limit reached in ${options.label}: exceeded ${maxPages} pages (${items.length} items) while has_more is still true.`
      )
    }

    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  return items
}

export interface NotionOperationOptions {
  config?: Partial<TranslationConfig>
  logger?: WorkerLogger
  retryOptions?: RetryConfigOptions
  maxPaginationPages?: number
  dryRun?: boolean
  fetchImpl?: typeof fetch
  assetTimeoutMs?: number
  maxAssetBytes?: number
  filename?: string
}

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
    logger.info('Added missing translation schema properties to Notion database', {
      added: Object.keys(missingToCreate),
    })
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

function inferFilenameFromUrl(urlStr: string, fallback = 'notion-asset'): string {
  try {
    const parsed = new URL(urlStr)
    const base = decodeURIComponent(parsed.pathname.split('/').pop() || '')
    if (base && base.includes('.')) return base
  } catch {
    // Ignore URL parse error
  }
  return `${fallback}.bin`
}

function inferContentTypeFromFilename(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    pdf: 'application/pdf',
  }
  return map[ext] || 'application/octet-stream'
}

/**
 * Reads a fetch Response body while enforcing a strict maximum byte limit
 * during streaming so oversized assets are aborted before buffering in memory.
 */
async function readResponseWithByteLimit(
  response: Response,
  maxAssetBytes: number,
  controller: AbortController
): Promise<ArrayBuffer> {
  const headersAny = response.headers as unknown as {
    get?: (name: string) => string | null
    [key: string]: unknown
  }
  const rawContentLength =
    headersAny?.get?.('content-length') ??
    headersAny?.['content-length'] ??
    headersAny?.['Content-Length']

  if (
    rawContentLength !== undefined &&
    rawContentLength !== null &&
    String(rawContentLength).trim() !== ''
  ) {
    const declaredBytes = Number(rawContentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxAssetBytes) {
      controller.abort()
      throw new Error(
        `Asset size (${declaredBytes} bytes from Content-Length) exceeds maximum allowed limit (${maxAssetBytes} bytes)`
      )
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let receivedBytes = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          const chunk =
            value instanceof Uint8Array ? value : new Uint8Array(value)
          receivedBytes += chunk.byteLength
          if (receivedBytes > maxAssetBytes) {
            controller.abort()
            await reader.cancel().catch(() => {})
            throw new Error(
              `Asset download exceeded maximum allowed size (${maxAssetBytes} bytes; received >${receivedBytes} bytes)`
            )
          }
          chunks.push(chunk)
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // Ignore reader lock release errors
      }
    }

    const combined = new Uint8Array(receivedBytes)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return combined.buffer
  }

  // Fallback for environments where response.body is not a ReadableStream
  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer && arrayBuffer.byteLength > maxAssetBytes) {
    controller.abort()
    throw new Error(
      `Asset size (${arrayBuffer.byteLength} bytes) exceeds maximum allowed limit (${maxAssetBytes} bytes)`
    )
  }
  return arrayBuffer
}

/**
 * Re-uploads a Notion-hosted expiring file asset using the Notion File Upload API
 * (`client.fileUploads.create` + `client.fileUploads.send`).
 * Enforces both download timeout (`TRANSLATION_ASSET_TIMEOUT_MS`) and max byte size (`TRANSLATION_MAX_ASSET_BYTES`).
 */
export async function reuploadNotionAsset(
  client: Client,
  assetUrl: string,
  options: NotionOperationOptions = {}
): Promise<UploadedAssetRecord> {
  const {
    fetchImpl = globalThis.fetch,
    logger = defaultLogger,
    filename: explicitFilename,
  } = options

  if (!assetUrl) {
    throw new Error('Empty asset URL')
  }
  if (!client.fileUploads || typeof client.fileUploads.create !== 'function') {
    throw new Error('Notion client does not expose fileUploads API')
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for downloading Notion asset')
  }

  const assetTimeoutMs = Math.max(
    1000,
    Number(
      options.assetTimeoutMs ??
        options.config?.assetTimeoutMs ??
        process.env.TRANSLATION_ASSET_TIMEOUT_MS ??
        60000
    ) || 60000
  )

  const maxAssetBytes = Math.max(
    1024,
    Number(
      options.maxAssetBytes ??
        options.config?.maxAssetBytes ??
        process.env.TRANSLATION_MAX_ASSET_BYTES ??
        20 * 1024 * 1024
    ) || 20 * 1024 * 1024
  )

  const filename = explicitFilename || inferFilenameFromUrl(assetUrl, 'asset')
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, assetTimeoutMs)

  let arrayBuffer: ArrayBuffer
  let contentType: string
  try {
    const response = await fetchImpl(assetUrl, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(
        `Failed to download source asset (${response.status} ${response.statusText})`
      )
    }

    contentType =
      response.headers?.get?.('content-type')?.split(';')[0]?.trim() ||
      inferContentTypeFromFilename(filename)

    arrayBuffer = await readResponseWithByteLimit(
      response,
      maxAssetBytes,
      controller
    )
  } catch (err) {
    const isAbort =
      timedOut || (err instanceof Error && err.name === 'AbortError')
    if (isAbort) {
      throw new Error(`Asset download timed out after ${assetTimeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }

  const blob = new Blob([arrayBuffer], { type: contentType })

  const createdUpload = await withNotionRetry(
    () =>
      client.fileUploads.create({
        mode: 'single_part',
        filename,
        content_type: contentType,
      }),
    {
      isIdempotent: false,
      maxRetries: 2,
      label: 'fileUploads.create',
      logger,
      ...options.retryOptions,
    }
  )

  if (!createdUpload?.id) {
    throw new Error('fileUploads.create did not return an upload ID')
  }

  await withNotionRetry(
    () =>
      client.fileUploads.send({
        file_upload_id: createdUpload.id,
        file: {
          filename,
          data: blob,
        },
      }),
    {
      isIdempotent: false,
      maxRetries: 2,
      label: 'fileUploads.send',
      logger,
      ...options.retryOptions,
    }
  )

  return {
    fileUploadId: createdUpload.id,
    filename,
    contentType,
  }
}
