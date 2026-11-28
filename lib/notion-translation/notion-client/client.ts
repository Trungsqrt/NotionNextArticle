import { Client } from '@notionhq/client'
import pRetry, { AbortError } from 'p-retry'
import type { TranslationConfig } from '../config'
import type { RetryConfigOptions, WorkerLogger } from '../types'
import { defaultLogger } from '../../../worker/logger'

export interface PaginatedListResponse<T> {
  results?: T[]
  has_more?: boolean
  next_cursor?: string | null
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
  const status =
    e.status ?? e.statusCode ?? (e.code === 'rate_limited' ? 429 : null)

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
          throw new AbortError(
            err instanceof Error ? err : new Error(String(err))
          )
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
