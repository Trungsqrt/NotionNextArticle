'use strict'

const { Client } = require('@notionhq/client')
const { TRANSLATION_STATUS_OPTIONS } = require('./config')
const { defaultLogger } = require('../../worker/logger')

const LOCALE_ALIASES = {
  english: 'en',
  vietnamese: 'vi',
  'tiếng việt': 'vi',
  'tieng viet': 'vi',
}

function normalizeLocaleCode(raw, defaultLocale = 'en') {
  if (raw === null || raw === undefined) return defaultLocale
  const value = String(raw).trim().toLowerCase()
  if (!value) return defaultLocale
  if (LOCALE_ALIASES[value]) return LOCALE_ALIASES[value]
  const primary = value.split(/[-_]/)[0]
  if (/^[a-z]{2,3}$/.test(primary)) return primary
  return defaultLocale
}

function normalizeNotionId(id) {
  return id ? String(id).replace(/-/g, '').trim().toLowerCase() : ''
}

function normalizePropKey(name) {
  return String(name || '').toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * Finds the actual key name in a properties/schema object matching any of the candidates.
 */
function findPropertyKey(propsOrSchema, candidates) {
  if (!propsOrSchema || typeof propsOrSchema !== 'object') return null
  const keys = Object.keys(propsOrSchema)
  const byNorm = new Map()
  for (const key of keys) {
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

function findPropertyEntry(propsOrSchema, candidates) {
  const key = findPropertyKey(propsOrSchema, candidates)
  if (!key) return { key: null, prop: null }
  return { key, prop: propsOrSchema[key] }
}

function findTitlePropertyKey(propsOrSchema) {
  if (!propsOrSchema || typeof propsOrSchema !== 'object') return 'Name'
  for (const [key, val] of Object.entries(propsOrSchema)) {
    if (val?.type === 'title' || val?.title !== undefined) {
      return key
    }
  }
  return 'Name'
}

function getPropertyPlainText(prop) {
  if (!prop) return ''
  const type = prop.type
  switch (type) {
    case 'title':
      return (prop.title || []).map(t => t.plain_text || t.text?.content || '').join('')
    case 'rich_text':
      return (prop.rich_text || []).map(t => t.plain_text || t.text?.content || '').join('')
    case 'select':
      return prop.select?.name || ''
    case 'multi_select':
      return (prop.multi_select || []).map(item => item.name).join(', ')
    case 'status':
      return prop.status?.name || ''
    case 'number':
      return prop.number !== undefined && prop.number !== null ? String(prop.number) : ''
    case 'date':
      if (!prop.date) return ''
      return prop.date.start || ''
    case 'url':
      return prop.url || ''
    case 'checkbox':
      return typeof prop.checkbox === 'boolean' ? (prop.checkbox ? 'true' : 'false') : ''
    case 'email':
      return prop.email || ''
    case 'phone_number':
      return prop.phone_number || ''
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string || ''
      if (prop.formula?.type === 'number') return prop.formula.number !== null ? String(prop.formula.number) : ''
      if (prop.formula?.type === 'boolean') return prop.formula.boolean ? 'true' : 'false'
      if (prop.formula?.type === 'date') return prop.formula.date?.start || ''
      return ''
    default:
      return ''
  }
}

function parseRetryAfterMs(error) {
  const headers = error?.headers || error?.response?.headers
  if (!headers) return null

  let raw = null
  if (typeof headers.get === 'function') {
    raw = headers.get('retry-after') || headers.get('Retry-After')
  } else if (typeof headers === 'object') {
    raw = headers['retry-after'] || headers['Retry-After']
  }
  if (!raw) return null

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Executes a Notion API operation with explicit 429/529 rate-limit handling,
 * Retry-After support, and exponential backoff.
 * Does NOT blindly retry non-idempotent operations on 500/network errors.
 */
async function withNotionRetry(operationFn, options = {}) {
  const {
    isIdempotent = true,
    maxRetries = 4,
    initialDelayMs = 1000,
    maxDelayMs = 60000,
    label = 'notion-api',
    logger = defaultLogger,
    sleepFn = sleep,
  } = options

  let attempt = 0
  while (true) {
    try {
      return await operationFn()
    } catch (err) {
      const status = err?.status || err?.statusCode || (err?.code === 'rate_limited' ? 429 : null)
      const isRateLimitOrOverload =
        status === 429 ||
        status === 529 ||
        err?.code === 'rate_limited' ||
        err?.code === 'service_unavailable'

      const isTransientServerError =
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        err?.code === 'internal_server_error'

      const canRetry =
        attempt < maxRetries &&
        (isRateLimitOrOverload || (isIdempotent && isTransientServerError))

      if (!canRetry) {
        throw err
      }

      const retryAfterMs = parseRetryAfterMs(err)
      const expBackoff = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt))
      const jitter = Math.floor(Math.random() * 250)
      const delayMs = retryAfterMs !== null ? Math.min(maxDelayMs, Math.max(100, retryAfterMs)) : expBackoff + jitter

      attempt++
      logger.warn(`Retrying ${label} (attempt ${attempt}/${maxRetries}) after ${delayMs}ms`, {
        status,
        code: err?.code,
      })
      await sleepFn(delayMs)
    }
  }
}

function createNotionClient(config = {}, customClient = null) {
  if (customClient) return customClient
  return new Client({
    auth: config.notionToken || process.env.NOTION_TOKEN || process.env.NOTION_API_SECRET || process.env.NOTION_TOKEN_V2,
  })
}

/**
 * Inspects the configured database / root page and resolves the Articles database ID,
 * data source ID, and full property schema using existing Notion SDK conventions.
 */
async function resolveArticlesDataSource(client, config = {}, options = {}) {
  const targetId = config.translationDatabaseId || config.rootPageId
  if (!targetId) {
    throw new Error('NOTION_TRANSLATION_DATABASE_ID or NOTION_ROOT_PAGE_ID is required.')
  }

  const logger = options.logger || defaultLogger
  let databaseId = targetId
  let dataSourceId = targetId
  let properties = null
  let rawDatabase = null
  let rawDataSource = null

  // 1. Try retrieving as a database first (mirrors lib/notion.js fetchDatabase)
  if (typeof client.databases?.retrieve === 'function') {
    try {
      rawDatabase = await withNotionRetry(
        () => client.databases.retrieve({ database_id: targetId }),
        { isIdempotent: true, label: 'databases.retrieve', logger, ...options.retryOptions }
      )
      databaseId = rawDatabase.id || targetId
      dataSourceId = rawDatabase.data_sources?.[0]?.id || databaseId
      if (rawDatabase.properties && Object.keys(rawDatabase.properties).length > 0) {
        properties = rawDatabase.properties
      }
    } catch {
      // May be a data_source_id directly or a root page containing a child_database
    }
  }

  // 2. Retrieve data source schema when supported by SDK (2025-09-03)
  if (!properties && typeof client.dataSources?.retrieve === 'function') {
    try {
      rawDataSource = await withNotionRetry(
        () => client.dataSources.retrieve({ data_source_id: dataSourceId }),
        { isIdempotent: true, label: 'dataSources.retrieve', logger, ...options.retryOptions }
      )
      dataSourceId = rawDataSource.id || dataSourceId
      if (rawDataSource.parent?.database_id) {
        databaseId = rawDataSource.parent.database_id
      }
      if (rawDataSource.properties) {
        properties = rawDataSource.properties
      }
    } catch {
      // Fall through to child_database discovery
    }
  }

  // 3. Fallback: If targetId is a root page that holds a child_database block
  if (!properties && typeof client.blocks?.children?.list === 'function') {
    try {
      const childrenRes = await withNotionRetry(
        () => client.blocks.children.list({ block_id: targetId, page_size: 100 }),
        { isIdempotent: true, label: 'blocks.children.list(root)', logger, ...options.retryOptions }
      )
      const childDbBlock = (childrenRes.results || []).find(b => b.type === 'child_database')
      if (childDbBlock) {
        return resolveArticlesDataSource(
          client,
          { ...config, translationDatabaseId: childDbBlock.id },
          options
        )
      }
    } catch {
      // Ignore
    }
  }

  // 4. Final fallback: sample one page from query to infer property names/types
  if (!properties) {
    properties = {}
    try {
      const sampleRes = await queryDataSourceOrDatabase(client, { databaseId, dataSourceId }, { page_size: 1 }, options)
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
 * Adds any missing properties (unless dryRun is enabled).
 */
async function ensureTranslationSchema(client, dataSourceInfo, options = {}) {
  const { dryRun = false, logger = defaultLogger } = options
  const schema = dataSourceInfo.properties || {}

  const requiredDefs = [
    {
      canonicalName: 'Translation Status',
      candidates: ['Translation Status', 'TranslationStatus'],
      definition: {
        select: {
          options: TRANSLATION_STATUS_OPTIONS.map(o => ({ name: o.name, color: o.color })),
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
      candidates: ['Translation Group ID', 'Translation Group', 'TranslationGroupId'],
      definition: { rich_text: {} },
    },
  ]

  const missingToCreate = {}
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

  try {
    if (typeof client.dataSources?.update === 'function') {
      const updated = await withNotionRetry(
        () =>
          client.dataSources.update({
            data_source_id: dataSourceInfo.dataSourceId,
            properties: missingToCreate,
          }),
        { isIdempotent: true, label: 'dataSources.update(schema)', logger, ...options.retryOptions }
      )
      if (updated?.properties) {
        dataSourceInfo.properties = { ...schema, ...updated.properties }
      }
    } else if (typeof client.databases?.update === 'function') {
      const updated = await withNotionRetry(
        () =>
          client.databases.update({
            database_id: dataSourceInfo.databaseId,
            properties: missingToCreate,
          }),
        { isIdempotent: true, label: 'databases.update(schema)', logger, ...options.retryOptions }
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
    logger.warn('Could not auto-create missing translation properties on database (continuing with available schema)', {
      error: err?.message,
    })
  }

  return dataSourceInfo
}

async function queryDataSourceOrDatabase(client, dataSourceInfo, queryParams = {}, options = {}) {
  const logger = options.logger || defaultLogger
  const { dataSourceId, databaseId } = dataSourceInfo

  return withNotionRetry(
    async () => {
      if (typeof client.dataSources?.query === 'function') {
        return client.dataSources.query({
          data_source_id: dataSourceId || databaseId,
          ...queryParams,
        })
      }
      if (typeof client.databases?.query === 'function') {
        return client.databases.query({
          database_id: databaseId || dataSourceId,
          ...queryParams,
        })
      }
      throw new Error('Notion client does not support dataSources.query or databases.query')
    },
    { isIdempotent: true, label: 'queryDatabase', logger, ...options.retryOptions }
  )
}

async function queryAllPages(client, dataSourceInfo, queryParams = {}, options = {}) {
  const results = []
  let cursor = undefined
  let pages = 0
  const maxPages = 100

  do {
    const res = await queryDataSourceOrDatabase(
      client,
      dataSourceInfo,
      {
        ...queryParams,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
      options
    )
    results.push(...(res?.results || []))
    cursor = res?.has_more ? res.next_cursor : undefined
    pages++
  } while (cursor && pages < maxPages)

  return results
}

function inferFilenameFromUrl(urlStr, fallback = 'notion-asset') {
  try {
    const parsed = new URL(urlStr)
    const base = decodeURIComponent(parsed.pathname.split('/').pop() || '')
    if (base && base.includes('.')) return base
  } catch {
    // Ignore URL parse error
  }
  return `${fallback}.bin`
}

function inferContentTypeFromFilename(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const map = {
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
 * Re-uploads a Notion-hosted expiring file asset using the Notion File Upload API
 * (`client.fileUploads.create` + `client.fileUploads.send`).
 */
async function reuploadNotionAsset(client, assetUrl, options = {}) {
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

  const filename = explicitFilename || inferFilenameFromUrl(assetUrl, 'asset')

  // 1. Download original asset from signed Notion S3 URL
  const response = await fetchImpl(assetUrl)
  if (!response.ok) {
    throw new Error(`Failed to download source asset (${response.status} ${response.statusText})`)
  }

  const contentType =
    response.headers?.get?.('content-type')?.split(';')[0]?.trim() ||
    inferContentTypeFromFilename(filename)

  const arrayBuffer = await response.arrayBuffer()
  const blob = new Blob([arrayBuffer], { type: contentType })

  // 2. Create single-part file upload in Notion
  const createdUpload = await withNotionRetry(
    () =>
      client.fileUploads.create({
        mode: 'single_part',
        filename,
        content_type: contentType,
      }),
    { isIdempotent: false, maxRetries: 2, label: 'fileUploads.create', logger, ...options.retryOptions }
  )

  if (!createdUpload?.id) {
    throw new Error('fileUploads.create did not return an upload ID')
  }

  // 3. Send binary content
  await withNotionRetry(
    () =>
      client.fileUploads.send({
        file_upload_id: createdUpload.id,
        file: {
          filename,
          data: blob,
        },
      }),
    { isIdempotent: false, maxRetries: 2, label: 'fileUploads.send', logger, ...options.retryOptions }
  )

  return {
    fileUploadId: createdUpload.id,
    filename,
    contentType,
  }
}

module.exports = {
  createNotionClient,
  withNotionRetry,
  resolveArticlesDataSource,
  ensureTranslationSchema,
  queryDataSourceOrDatabase,
  queryAllPages,
  reuploadNotionAsset,
  normalizeLocaleCode,
  normalizeNotionId,
  normalizePropKey,
  findPropertyKey,
  findPropertyEntry,
  findTitlePropertyKey,
  getPropertyPlainText,
}

