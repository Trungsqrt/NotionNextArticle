/**
 * lib/study/notion-client.ts — Isolated server-side Notion client for Study System
 * ─────────────────────────────────────────────────────────────────────────────────
 * Completely independent from public lib/notion.js:
 * - Uses STUDY_NOTION_TOKEN exclusively (never NOTION_TOKEN).
 * - Does not share globalThis.__notionCache with public article rendering.
 * - Enforces request throttling (~3 req/sec), per-request timeouts, exponential
 *   backoff with Retry-After on HTTP 429 / 5xx, and bounded cursor pagination.
 */

import { Client } from '@notionhq/client'
import { getStudyNotionConfig, type StudyNotionConfig } from './config'
import {
  createDataSourceResolver,
  extractNotionErrorInfo,
  type RetrievedDatabaseLike,
  type RetrievedDataSourceLike,
} from './notion-data-source'

export interface NotionPageRecord {
  id: string
  archived?: boolean
  in_trash?: boolean
  created_time?: string
  last_edited_time?: string
  properties: Record<string, unknown>
}

export interface QueryDatabaseOptions {
  filter?: Record<string, unknown>
  sorts?: Array<Record<string, unknown>>
  pageSize?: number
  maxPages?: number
  /** Expected Notion property names for verified schema & multi-data-source selection */
  expectedProperties?: readonly string[]
}

export interface UploadedStudyFile {
  fileUploadId: string
  filename: string
  contentType: string
}

export interface AppendImageBlockInput {
  fileUploadId: string
  caption?: string
}

export interface FreshImageBlockUrl {
  url: string
  expiryTime: string | null
}

export class StudyNotionUploadExpiredError extends Error {
  readonly code = 'UPLOAD_EXPIRED'
  constructor(message: string = 'Notion file upload session expired') {
    super(message)
    this.name = 'StudyNotionUploadExpiredError'
  }
}

export const NOTION_FREE_PLAN_MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB (Notion Free plan per-file limit)
export const NOTION_SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024 // 20 MB (Notion API single-part limit)

export interface StudyNotionClient {
  queryDatabaseAll(
    databaseId: string,
    options?: QueryDatabaseOptions
  ): Promise<NotionPageRecord[]>
  createPage(
    databaseId: string,
    properties: Record<string, unknown>
  ): Promise<NotionPageRecord>
  updatePage(
    pageId: string,
    properties: Record<string, unknown>
  ): Promise<NotionPageRecord>
  retrievePage(pageId: string): Promise<NotionPageRecord>
  uploadLocalFile?(input: {
    filename: string
    contentType: string
    buffer: Uint8Array
  }): Promise<UploadedStudyFile>
  appendImageBlocks?(
    pageId: string,
    images: AppendImageBlockInput[]
  ): Promise<string[]>
  retrieveImageBlockUrl?(blockId: string): Promise<FreshImageBlockUrl | null>
  retrieveAuthorizedQuestionImageUrl?(
    blockId: string,
    options: { questionsDbId: string; allowDraft?: boolean }
  ): Promise<FreshImageBlockUrl | null>
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function getRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const headers = (err as { headers?: Record<string, string> }).headers
  const raw = headers?.['retry-after'] || headers?.['Retry-After']
  if (!raw) return null
  const seconds = Number.parseFloat(raw)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 30000)
  }
  return null
}

function isRetryableError(err: unknown): boolean {
  const status = getHttpStatus(err)
  if (status !== null) return RETRYABLE_STATUS_CODES.has(status)
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed')
    )
  }
  return false
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Study Notion request timed out after ${timeoutMs}ms (${label})`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface NotionImageBlockLike {
  archived?: boolean
  in_trash?: boolean
  type?: string
  parent?: {
    type?: string
    page_id?: string
    block_id?: string
  }
  image?: {
    type?: string
    file?: { url?: string; expiry_time?: string }
  }
}

export interface NotionOwnerPageLike extends NotionPageRecord {
  parent?: {
    type?: string
    database_id?: string
    data_source_id?: string
  }
}

function normalizeNotionId(id: string): string {
  return id.replace(/-/g, '').trim().toLowerCase()
}

/**
 * Pure ownership & publication-status verifier for private study image blocks.
 * Ensures an authenticated user can ONLY stream image blocks attached to a
 * non-archived Question page inside `STUDY_NOTION_QUESTIONS_DB_ID` (published
 * for students, or draft/published for admins).
 */
export async function verifyAuthorizedQuestionImageBlock(
  blockId: string,
  options: {
    allowedQuestionsDbIds: string[]
    allowDraft?: boolean
    retrieveBlock: (id: string) => Promise<NotionImageBlockLike | null>
    retrievePage: (id: string) => Promise<NotionOwnerPageLike | null>
  }
): Promise<FreshImageBlockUrl | null> {
  const allowedIds = new Set(options.allowedQuestionsDbIds.map(normalizeNotionId).filter(Boolean))
  const block = await options.retrieveBlock(blockId.trim())
  if (!block || block.archived || block.in_trash) return null
  if (block.type !== 'image' || block.image?.type !== 'file') return null
  const url = block.image.file?.url || ''
  if (!url) return null

  let ownerPageId: string | null = null
  let currentParent = block.parent
  for (let depth = 0; depth < 6 && currentParent; depth++) {
    if (currentParent.type === 'page_id' && currentParent.page_id) {
      ownerPageId = currentParent.page_id
      break
    }
    if (currentParent.type === 'block_id' && currentParent.block_id) {
      const parentBlock = await options.retrieveBlock(currentParent.block_id)
      if (!parentBlock || parentBlock.archived || parentBlock.in_trash) return null
      currentParent = parentBlock.parent
      continue
    }
    break
  }

  if (!ownerPageId) return null

  const ownerPage = await options.retrievePage(ownerPageId)
  if (!ownerPage || ownerPage.archived || ownerPage.in_trash) return null

  const parentDbId = ownerPage.parent?.database_id
    ? normalizeNotionId(ownerPage.parent.database_id)
    : ''
  const parentDsId = ownerPage.parent?.data_source_id
    ? normalizeNotionId(ownerPage.parent.data_source_id)
    : ''

  const belongsToQuestionsDb =
    (Boolean(parentDbId) && allowedIds.has(parentDbId)) ||
    (Boolean(parentDsId) && allowedIds.has(parentDsId))
  if (!belongsToQuestionsDb) return null

  const statusProp = ownerPage.properties?.Status as
    | { select?: { name?: string } | null; status?: { name?: string } | null }
    | undefined
  const statusValue = (statusProp?.select?.name || statusProp?.status?.name || '')
    .trim()
    .toLowerCase()

  if (statusValue !== 'published' && !options.allowDraft) {
    return null
  }

  return {
    url,
    expiryTime: block.image.file?.expiry_time || null,
  }
}

export function createStudyNotionClient(
  configOverride?: Partial<StudyNotionConfig>
): StudyNotionClient {
  if ('window' in globalThis) {
    throw new Error('lib/study/notion-client is server-only and cannot run in the browser')
  }

  const baseConfig = getStudyNotionConfig()
  const config: StudyNotionConfig = { ...baseConfig, ...configOverride }

  const sdk = new Client({
    auth: config.token,
    timeoutMs: config.timeoutMs,
  })

  const sdkAny = sdk as unknown as {
    dataSources?: {
      query?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
      retrieve?: (args: { data_source_id: string }) => Promise<RetrievedDataSourceLike>
    }
    databases: {
      retrieve: (args: { database_id: string }) => Promise<RetrievedDatabaseLike>
      query?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
  }

  // Sequential minimum-interval throttle queue to stay within Notion's ~3 req/s limit
  let throttleChain: Promise<void> = Promise.resolve()
  let lastRequestAt = 0

  async function scheduleThrottled<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
      if (config.minIntervalMs > 0) {
        const elapsed = Date.now() - lastRequestAt
        if (elapsed < config.minIntervalMs) {
          await sleep(config.minIntervalMs - elapsed)
        }
      }
      lastRequestAt = Date.now()
      return task()
    }

    const resultPromise = throttleChain.then(run, run)
    throttleChain = resultPromise.then(
      () => undefined,
      () => undefined
    )
    return resultPromise
  }

  async function executeWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0
    while (true) {
      try {
        return await scheduleThrottled(() => withTimeout(fn, config.timeoutMs, label))
      } catch (err) {
        attempt += 1
        if (attempt > config.maxRetries || !isRetryableError(err)) {
          const info = extractNotionErrorInfo(err)
          const safeMsg = info.status
            ? `Study Notion API error (${label}, HTTP ${info.status}${info.code ? `, ${info.code}` : ''})`
            : `Study Notion API error (${label}${info.code ? `, ${info.code}` : ''})`
          const wrapped = new Error(safeMsg) as Error & { status?: number; notionCode?: string }
          wrapped.status = info.status ?? undefined
          wrapped.notionCode = info.code ?? undefined
          throw wrapped
        }
        const retryAfterMs = getRetryAfterMs(err)
        const backoffMs = retryAfterMs ?? Math.min(500 * Math.pow(2, attempt - 1), 10000)
        await sleep(backoffMs)
      }
    }
  }

  // Verified, bounded-TTL, single-flight Database ID -> Data Source ID resolver
  // (never caches unverified or failed lookups)
  const dataSourceResolver = createDataSourceResolver(
    {
      retrieveDatabase: (dbId) =>
        executeWithRetry('databases.retrieve', () =>
          sdkAny.databases.retrieve({ database_id: dbId })
        ),
      ...(typeof sdkAny.dataSources?.retrieve === 'function'
        ? {
            retrieveDataSource: (dsId: string) =>
              executeWithRetry('dataSources.retrieve', () =>
                sdkAny.dataSources!.retrieve!({ data_source_id: dsId })
              ),
          }
        : {}),
    },
    { ttlMs: 15 * 60 * 1000, maxEntries: 100 }
  )

  async function resolveDataSourceId(
    databaseId: string,
    expectedProperties?: readonly string[],
    forceRefresh: boolean = false
  ): Promise<string> {
    const resolved = await dataSourceResolver.resolve(databaseId, {
      expectedProperties,
      forceRefresh,
    })
    return resolved.dataSourceId
  }

  return {
    async queryDatabaseAll(
      databaseId: string,
      options: QueryDatabaseOptions = {}
    ): Promise<NotionPageRecord[]> {
      const cleanId = databaseId.trim()
      const maxPages = Math.min(
        options.maxPages ?? config.maxPaginationPages,
        config.maxPaginationPages
      )
      const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100)

      const useDataSources = typeof sdkAny.dataSources?.query === 'function'

      const runPaginatedQuery = async (targetId: string): Promise<NotionPageRecord[]> => {
        const results: NotionPageRecord[] = []
        let cursor: string | undefined = undefined
        let pageCount = 0

        while (pageCount < maxPages) {
          const queryArgs: Record<string, unknown> = {
            ...(useDataSources ? { data_source_id: targetId } : { database_id: targetId }),
            page_size: pageSize,
            ...(options.filter ? { filter: options.filter } : {}),
            ...(options.sorts ? { sorts: options.sorts } : {}),
            ...(cursor ? { start_cursor: cursor } : {}),
          }

          const res = (await executeWithRetry('database.query', () =>
            useDataSources
              ? sdkAny.dataSources!.query!(queryArgs)
              : sdkAny.databases.query!(queryArgs)
          )) as {
            results?: NotionPageRecord[]
            has_more?: boolean
            next_cursor?: string | null
          }

          if (Array.isArray(res.results)) {
            for (const item of res.results) {
              if (!item.archived && !item.in_trash) {
                results.push(item)
              }
            }
          }

          pageCount += 1
          if (!res.has_more || !res.next_cursor) break
          cursor = res.next_cursor
        }

        return results
      }

      if (!useDataSources) {
        return runPaginatedQuery(cleanId)
      }

      const targetId = await resolveDataSourceId(cleanId, options.expectedProperties, false)
      try {
        return await runPaginatedQuery(targetId)
      } catch (err) {
        const info = extractNotionErrorInfo(err)
        // Stale cached data_source_id recovery: invalidate, re-resolve, and retry read AT MOST ONCE
        if (info.category === 'not_found') {
          dataSourceResolver.invalidate(cleanId, 'query_object_not_found')
          console.warn('[study-notion/ds] retry_after_object_not_found', {
            inputId: cleanId,
            staleDataSourceId: targetId,
          })
          const freshTargetId = await resolveDataSourceId(
            cleanId,
            options.expectedProperties,
            true
          )
          return await runPaginatedQuery(freshTargetId)
        }
        throw err
      }
    },

    async createPage(
      databaseId: string,
      properties: Record<string, unknown>
    ): Promise<NotionPageRecord> {
      const cleanId = databaseId.trim()
      const res = await executeWithRetry('pages.create', () =>
        sdk.pages.create({
          parent: { database_id: cleanId },
          properties: properties as Parameters<typeof sdk.pages.create>[0]['properties'],
        })
      )
      return res as unknown as NotionPageRecord
    },

    async updatePage(
      pageId: string,
      properties: Record<string, unknown>
    ): Promise<NotionPageRecord> {
      const cleanId = pageId.trim()
      const res = await executeWithRetry('pages.update', () =>
        sdk.pages.update({
          page_id: cleanId,
          properties: properties as Parameters<typeof sdk.pages.update>[0]['properties'],
        })
      )
      return res as unknown as NotionPageRecord
    },

    async retrievePage(pageId: string): Promise<NotionPageRecord> {
      const cleanId = pageId.trim()
      const res = await executeWithRetry('pages.retrieve', () =>
        sdk.pages.retrieve({ page_id: cleanId })
      )
      return res as unknown as NotionPageRecord
    },

    async uploadLocalFile(input: {
      filename: string
      contentType: string
      buffer: Uint8Array
      maxFileBytes?: number
    }): Promise<UploadedStudyFile> {
      const { filename, contentType, buffer } = input
      const effectiveMaxBytes = Math.min(
        input.maxFileBytes ?? NOTION_FREE_PLAN_MAX_FILE_BYTES,
        NOTION_SINGLE_PART_MAX_BYTES
      )
      if (!buffer || buffer.byteLength === 0) {
        throw new Error(`Cannot upload empty image file: ${filename}`)
      }
      if (buffer.byteLength > effectiveMaxBytes) {
        throw new Error(
          `Image file "${filename}" exceeds per-file upload limit (${buffer.byteLength} bytes > ${effectiveMaxBytes} bytes)`
        )
      }

      const sdkUploads = (sdk as unknown as {
        fileUploads?: {
          create?: (args: Record<string, unknown>) => Promise<{ id?: string }>
          send?: (args: Record<string, unknown>) => Promise<unknown>
        }
      }).fileUploads

      if (!sdkUploads?.create || !sdkUploads?.send) {
        throw new Error('Notion SDK client does not expose fileUploads API')
      }

      const created = await executeWithRetry('fileUploads.create', () =>
        sdkUploads.create!({
          mode: 'single_part',
          filename,
          content_type: contentType,
        })
      )

      if (!created?.id) {
        throw new Error('Notion fileUploads.create did not return a file_upload_id')
      }

      const arrayBufferCopy = new ArrayBuffer(buffer.byteLength)
      new Uint8Array(arrayBufferCopy).set(buffer)
      const blob = new Blob([arrayBufferCopy], { type: contentType })
      await executeWithRetry('fileUploads.send', () =>
        sdkUploads.send!({
          file_upload_id: created.id,
          file: {
            filename,
            data: blob,
          },
        })
      )

      return {
        fileUploadId: created.id,
        filename,
        contentType,
      }
    },

    async appendImageBlocks(
      pageId: string,
      images: AppendImageBlockInput[]
    ): Promise<string[]> {
      if (images.length === 0) return []
      const cleanPageId = pageId.trim()
      const createdIds: string[] = []

      // Notion blocks.children.append allows up to 100 children per request
      for (let i = 0; i < images.length; i += 100) {
        const slice = images.slice(i, i + 100)
        const children = slice.map((item) => ({
          object: 'block' as const,
          type: 'image' as const,
          image: {
            type: 'file_upload' as const,
            file_upload: { id: item.fileUploadId },
            ...(item.caption
              ? {
                  caption: [
                    {
                      type: 'text' as const,
                      text: { content: item.caption.slice(0, 2000) },
                    },
                  ],
                }
              : {}),
          },
        }))

        try {
          const res = (await executeWithRetry('blocks.children.append', () =>
            sdk.blocks.children.append({
              block_id: cleanPageId,
              children: children as unknown as Parameters<
                typeof sdk.blocks.children.append
              >[0]['children'],
            })
          )) as { results?: Array<{ id?: string }> }

          for (const block of res.results || []) {
            if (block.id) createdIds.push(block.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message.toLowerCase() : ''
          if (msg.includes('expired') || msg.includes('file upload')) {
            throw new StudyNotionUploadExpiredError()
          }
          throw err
        }
      }

      return createdIds
    },

    async retrieveImageBlockUrl(blockId: string): Promise<FreshImageBlockUrl | null> {
      const cleanId = blockId.trim()
      try {
        const block = (await executeWithRetry('blocks.retrieve', () =>
          sdk.blocks.retrieve({ block_id: cleanId })
        )) as {
          archived?: boolean
          in_trash?: boolean
          type?: string
          image?: {
            type?: string
            file?: { url?: string; expiry_time?: string }
          }
        }

        if (!block || block.archived || block.in_trash) return null
        if (block.type !== 'image' || block.image?.type !== 'file') return null
        const url = block.image.file?.url || ''
        if (!url) return null
        return {
          url,
          expiryTime: block.image.file?.expiry_time || null,
        }
      } catch (err) {
        const status = getHttpStatus(err)
        if (status === 404 || status === 400) return null
        throw err
      }
    },

    async retrieveAuthorizedQuestionImageUrl(
      blockId: string,
      options: { questionsDbId: string; allowDraft?: boolean }
    ): Promise<FreshImageBlockUrl | null> {
      const allowedDbIds = [options.questionsDbId]
      try {
        const resolvedDsId = await resolveDataSourceId(options.questionsDbId)
        if (resolvedDsId) allowedDbIds.push(resolvedDsId)
      } catch {
        // Keep raw questionsDbId
      }

      try {
        return await verifyAuthorizedQuestionImageBlock(blockId, {
          allowedQuestionsDbIds: allowedDbIds,
          allowDraft: options.allowDraft,
          retrieveBlock: async (id) =>
            (await executeWithRetry('blocks.retrieve', () =>
              sdk.blocks.retrieve({ block_id: id })
            )) as NotionImageBlockLike,
          retrievePage: async (id) =>
            (await executeWithRetry('pages.retrieve', () =>
              sdk.pages.retrieve({ page_id: id })
            )) as NotionOwnerPageLike,
        })
      } catch (err) {
        const status = getHttpStatus(err)
        if (status === 404 || status === 400) return null
        throw err
      }
    },
  }
}

let cachedDefaultClient: StudyNotionClient | null = null

export function getDefaultStudyNotionClient(): StudyNotionClient {
  if (!cachedDefaultClient) {
    cachedDefaultClient = createStudyNotionClient()
  }
  return cachedDefaultClient
}
