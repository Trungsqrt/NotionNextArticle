import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  findPropertyKey,
  findTitlePropertyKey,
  getPropertyPlainText,
  normalizeNotionId,
} from './notion-client'
import { normalizeTreeNodes } from './reader'
import { computeBlockFingerprint } from './writer'
import type { TranslationConfig } from './config'
import type {
  ArticlesDataSourceInfo,
  CachedTranslationSnapshot,
  CheckpointController,
  CheckpointJobState,
  JobCheckpoint,
  NotionBlockNode,
  NotionBlockTree,
  NotionPageLike,
  PendingWriteOperation,
  ResourceMappingEntry,
  ResourceMappingStoreData,
  SegmentCacheEntry,
  SegmentCacheStoreData,
  TranslateManifestResult,
  UploadedAssetRecord,
  WriteIssuesCollection,
} from './types'

const SENSITIVE_KEY_PATTERN =
  /(token|secret|api[_-]?key|authorization|password|credential)/i

const JobCheckpointSchema = z.object({
  version: z.literal(1),
  sourcePageId: z.string().min(1),
  sourceFingerprint: z.string().nullable(),
  translationGroupId: z.string(),
  targetLocale: z.string(),
  targetPageId: z.string().nullable(),
  pagePropertiesWritten: z.boolean(),
  jobState: z.enum([
    'initialized',
    'translating',
    'translated',
    'writing',
    'paused_quota',
    'failed',
    'needs_review',
    'completed',
  ]),
  cachedTranslationResult: z
    .object({
      targetLocale: z.string(),
      translations: z.record(z.string()),
      stats: z.record(z.unknown()),
      issues: z.array(z.string()),
      cachedAt: z.string(),
    })
    .nullable(),
  uploadedAssetsBySourceKey: z.record(
    z.object({
      fileUploadId: z.string(),
      filename: z.string(),
      contentType: z.string(),
      uploadedAt: z.string().optional(),
    })
  ),
  completedBatches: z.record(
    z.object({
      parentBlockId: z.string(),
      batchIndex: z.number(),
      expectedStartIndex: z.number(),
      sourceBlockIds: z.array(z.string()),
      targetBlockIds: z.array(z.string()),
      blockFingerprints: z.array(z.string()),
      completedAt: z.string(),
    })
  ),
  sourceToTargetBlockMap: z.record(z.string()),
  childTargetPageIdsBySourceId: z.record(z.string()).optional(),
  writeIssues: z.object({
    missingMedia: z.array(z.any()),
    unsupportedBlocks: z.array(z.any()),
    linkedResources: z.array(z.any()),
    syncedBlocks: z.array(z.any()),
  }),
  pendingOperation: z.any().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

function sanitizeCheckpointValue<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCheckpointValue(item)) as unknown as T
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) continue
      out[k] = sanitizeCheckpointValue(v)
    }
    return out as T
  }
  return value
}

export function getStateDirectoryPath(
  config: Partial<TranslationConfig> = {}
): string {
  return (
    config.stateDirPath ||
    process.env.TRANSLATION_STATE_DIR ||
    path.join(process.cwd(), '.translation-worker-state')
  )
}

export function getJobCheckpointPath(
  sourcePageId: string,
  config: Partial<TranslationConfig> = {}
): string | null {
  const normId = normalizeNotionId(sourcePageId)
  if (!normId) return null
  return path.join(getStateDirectoryPath(config), `job-${normId}.json`)
}

export function readJobCheckpoint(
  sourcePageId: string,
  config: Partial<TranslationConfig> = {}
): JobCheckpoint | null {
  const filePath = getJobCheckpointPath(sourcePageId, config)
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const validated = JobCheckpointSchema.safeParse(parsed)
    if (!validated.success) return null
    if (
      normalizeNotionId(validated.data.sourcePageId) !==
      normalizeNotionId(sourcePageId)
    ) {
      return null
    }
    return validated.data as JobCheckpoint
  } catch {
    return null
  }
}

export function writeJobCheckpoint(
  sourcePageId: string,
  checkpointData: JobCheckpoint,
  config: Partial<TranslationConfig> = {}
): JobCheckpoint | null {
  if (config?.dryRun) return null
  const filePath = getJobCheckpointPath(sourcePageId, config)
  if (!filePath) return null

  const dirPath = path.dirname(filePath)
  fs.mkdirSync(dirPath, { recursive: true })

  const safePayload = sanitizeCheckpointValue<JobCheckpoint>({
    ...checkpointData,
    version: 1,
    sourcePageId,
    updatedAt: new Date().toISOString(),
  })

  const serialized = JSON.stringify(safePayload, null, 2)
  const rand = crypto.randomBytes(4).toString('hex')
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`

  fs.writeFileSync(tmpPath, serialized, 'utf8')
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // Ignore temp cleanup failure
    }
    throw err
  }
  return safePayload
}

export function deleteJobCheckpoint(
  sourcePageId: string,
  config: Partial<TranslationConfig> = {}
): void {
  if (config?.dryRun) return
  const filePath = getJobCheckpointPath(sourcePageId, config)
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // Ignore delete failure
  }
}

export function computeSourceContentFingerprint(
  sourcePage: NotionPageLike,
  sourceTree: NotionBlockTree | NotionBlockNode[],
  dataSourceInfo: Partial<ArticlesDataSourceInfo> | null = null
): string {
  const props = (sourcePage?.properties || {}) as Record<
    string,
    Record<string, unknown>
  >
  const schemaProps = { ...(dataSourceInfo?.properties || {}), ...props }
  const titleKey =
    dataSourceInfo?.titlePropertyName || findTitlePropertyKey(schemaProps)
  const slugKey = findPropertyKey(schemaProps, ['Slug', 'slug'])
  const summaryKey = findPropertyKey(schemaProps, ['Summary', 'summary'])
  const categoryKey = findPropertyKey(schemaProps, ['Category', 'category'])
  const tagsKey = findPropertyKey(schemaProps, ['Tags', 'tags'])

  interface SerializedBlockFingerprintNode {
    id: string
    type: string
    position: string
    fp: string
    children: SerializedBlockFingerprintNode[]
  }

  function serializeNodes(
    nodes: NotionBlockTree | NotionBlockNode[]
  ): SerializedBlockFingerprintNode[] {
    return normalizeTreeNodes(nodes).map((node) => ({
      id: normalizeNotionId(node.id || node.raw?.id || ''),
      type: node.type || node.raw?.type || 'unsupported',
      position: node.position || '',
      fp: computeBlockFingerprint(node.raw || node),
      children:
        Array.isArray(node.children) && node.children.length > 0
          ? serializeNodes(node.children)
          : [],
    }))
  }

  const fingerprintPayload = {
    sourcePageId: normalizeNotionId(sourcePage?.id),
    title: titleKey ? getPropertyPlainText(props[titleKey]) : '',
    slug: slugKey ? getPropertyPlainText(props[slugKey]).trim() : '',
    summary: summaryKey ? getPropertyPlainText(props[summaryKey]) : '',
    category: categoryKey ? getPropertyPlainText(props[categoryKey]) : '',
    tags: tagsKey ? getPropertyPlainText(props[tagsKey]) : '',
    blocks: serializeNodes(sourceTree),
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(fingerprintPayload))
    .digest('hex')
}

export function createCheckpointController(
  sourcePageId: string,
  initialCheckpoint: JobCheckpoint | null | undefined,
  config: Partial<TranslationConfig> = {}
): CheckpointController {
  const nowIso = new Date().toISOString()
  const state: JobCheckpoint = {
    version: 1,
    sourcePageId,
    sourceFingerprint: initialCheckpoint?.sourceFingerprint || null,
    translationGroupId: initialCheckpoint?.translationGroupId || '',
    targetLocale:
      initialCheckpoint?.targetLocale || config.targetLocale || 'vi',
    targetPageId: initialCheckpoint?.targetPageId || null,
    pagePropertiesWritten: Boolean(initialCheckpoint?.pagePropertiesWritten),
    jobState: initialCheckpoint?.jobState || 'initialized',
    cachedTranslationResult:
      initialCheckpoint?.cachedTranslationResult || null,
    uploadedAssetsBySourceKey: {
      ...(initialCheckpoint?.uploadedAssetsBySourceKey || {}),
    },
    completedBatches: { ...(initialCheckpoint?.completedBatches || {}) },
    sourceToTargetBlockMap: {
      ...(initialCheckpoint?.sourceToTargetBlockMap || {}),
    },
    childTargetPageIdsBySourceId: {
      ...(initialCheckpoint?.childTargetPageIdsBySourceId || {}),
    },
    writeIssues: initialCheckpoint?.writeIssues || {
      missingMedia: [],
      unsupportedBlocks: [],
      linkedResources: [],
      syncedBlocks: [],
    },
    pendingOperation: initialCheckpoint?.pendingOperation || null,
    lastError: initialCheckpoint?.lastError || null,
    createdAt: initialCheckpoint?.createdAt || nowIso,
    updatedAt: nowIso,
  }

  function save(): JobCheckpoint | null {
    if (config?.dryRun) return state
    return writeJobCheckpoint(sourcePageId, state, config)
  }

  return {
    state,
    save,
    resetForSourceChange(newFingerprint, translationGroupId, targetLocale) {
      state.sourceFingerprint = newFingerprint
      state.translationGroupId = translationGroupId || state.translationGroupId
      state.targetLocale = targetLocale || state.targetLocale
      state.cachedTranslationResult = null
      state.completedBatches = {}
      state.sourceToTargetBlockMap = {}
      state.uploadedAssetsBySourceKey = {}
      state.writeIssues = {
        missingMedia: [],
        unsupportedBlocks: [],
        linkedResources: [],
        syncedBlocks: [],
      }
      state.pendingOperation = null
      state.pagePropertiesWritten = false
      state.jobState = 'translating'
      save()
    },
    setMetadata({
      sourceFingerprint,
      translationGroupId,
      targetLocale,
      jobState,
    }) {
      if (sourceFingerprint !== undefined)
        state.sourceFingerprint = sourceFingerprint
      if (translationGroupId !== undefined)
        state.translationGroupId = translationGroupId
      if (targetLocale !== undefined) state.targetLocale = targetLocale
      if (jobState !== undefined) state.jobState = jobState
      save()
    },
    getCachedTranslationResult(
      expectedFingerprint,
      expectedLocale
    ): CachedTranslationSnapshot | null {
      if (
        !state.cachedTranslationResult ||
        !state.cachedTranslationResult.translations ||
        typeof state.cachedTranslationResult.translations !== 'object'
      ) {
        return null
      }
      if (
        expectedFingerprint &&
        state.sourceFingerprint !== expectedFingerprint
      ) {
        return null
      }
      if (expectedLocale && state.targetLocale !== expectedLocale) {
        return null
      }
      return state.cachedTranslationResult
    },
    setCachedTranslationResult(
      translationResult: TranslateManifestResult,
      sourceFingerprint?: string
    ) {
      if (sourceFingerprint) {
        state.sourceFingerprint = sourceFingerprint
      }
      state.cachedTranslationResult = {
        targetLocale: translationResult.targetLocale,
        translations:
          translationResult.translations ||
          Object.fromEntries(translationResult.translationsById || []),
        stats: translationResult.stats || {},
        issues: translationResult.issues || [],
        cachedAt: new Date().toISOString(),
      }
      state.jobState = 'translated'
      save()
    },
    setTargetPageId(targetPageId: string) {
      state.targetPageId = targetPageId
      if (state.pendingOperation?.type === 'create_page') {
        state.pendingOperation = null
      }
      state.jobState = 'writing'
      save()
    },
    markPagePropertiesWritten(targetPageId?: string) {
      if (targetPageId) {
        state.targetPageId = targetPageId
      }
      state.pagePropertiesWritten = true
      if (state.pendingOperation?.type === 'create_page') {
        state.pendingOperation = null
      }
      save()
    },
    isPagePropertiesWritten(targetPageId: string): boolean {
      return (
        Boolean(state.pagePropertiesWritten) &&
        Boolean(state.targetPageId) &&
        normalizeNotionId(state.targetPageId) ===
          normalizeNotionId(targetPageId)
      )
    },
    getUploadedAsset(sourceKey: string): UploadedAssetRecord | null {
      return state.uploadedAssetsBySourceKey?.[sourceKey] || null
    },
    recordUploadedAsset(sourceKey: string, uploadInfo: UploadedAssetRecord) {
      if (!sourceKey || !uploadInfo?.fileUploadId) return
      state.uploadedAssetsBySourceKey[sourceKey] = {
        fileUploadId: uploadInfo.fileUploadId,
        filename: uploadInfo.filename || '',
        contentType: uploadInfo.contentType || '',
        uploadedAt: new Date().toISOString(),
      }
      save()
    },
    getCompletedBatch(batchKey: string) {
      return state.completedBatches?.[batchKey] || null
    },
    recordCompletedBatch(batchRecord) {
      const {
        batchKey,
        parentBlockId,
        batchIndex,
        expectedStartIndex,
        sourceBlockIds = [],
        targetBlockIds = [],
        blockFingerprints = [],
      } = batchRecord
      state.completedBatches[batchKey] = {
        parentBlockId,
        batchIndex,
        expectedStartIndex,
        sourceBlockIds,
        targetBlockIds,
        blockFingerprints,
        completedAt: new Date().toISOString(),
      }
      for (let i = 0; i < sourceBlockIds.length; i++) {
        const sId = sourceBlockIds[i]
        const tId = targetBlockIds[i]
        if (sId && tId) {
          state.sourceToTargetBlockMap[sId] = tId
        }
      }
      if (
        state.pendingOperation?.type === 'append_blocks' &&
        state.pendingOperation.batchKey === batchKey
      ) {
        state.pendingOperation = null
      }
      save()
    },
    getChildTargetPageId(sourceChildPageId: string): string | null {
      const normKey = normalizeNotionId(sourceChildPageId)
      if (!normKey) return null
      return state.childTargetPageIdsBySourceId?.[normKey] || null
    },
    recordChildTargetPageId(
      sourceChildPageId: string,
      targetChildPageId: string
    ) {
      const normSource = normalizeNotionId(sourceChildPageId)
      if (!normSource || !targetChildPageId) return
      if (!state.childTargetPageIdsBySourceId) {
        state.childTargetPageIdsBySourceId = {}
      }
      state.childTargetPageIdsBySourceId[normSource] = targetChildPageId
      save()
    },
    getPendingOperation(): PendingWriteOperation | null {
      return state.pendingOperation
    },
    recordPendingOperation(op: PendingWriteOperation) {
      state.pendingOperation = op
      state.jobState = 'writing'
      save()
    },
    recordWriteIssues(issues: Partial<WriteIssuesCollection> = {}) {
      const keys = [
        'missingMedia',
        'unsupportedBlocks',
        'linkedResources',
        'syncedBlocks',
      ] as const
      for (const key of keys) {
        const incoming = issues[key]
        if (Array.isArray(incoming) && incoming.length > 0) {
          const existing = state.writeIssues[key] as Array<{
            id?: string
            position?: string
          }>
          const seenIds = new Set(
            existing.map((item) => `${item.id || ''}:${item.position || ''}`)
          )
          for (const item of incoming) {
            const k = `${item.id || ''}:${item.position || ''}`
            if (!seenIds.has(k)) {
              existing.push(item as never)
              seenIds.add(k)
            }
          }
        }
      }
      save()
    },
    setJobState(jobState: CheckpointJobState, lastError: string | null = null) {
      state.jobState = jobState
      state.lastError = lastError
      save()
    },
    remove() {
      deleteJobCheckpoint(sourcePageId, config)
    },
  }
}

const ResourceMappingEntrySchema = z.object({
  sourcePageId: z.string().min(1),
  targetPageId: z.string().min(1),
  targetLocale: z.string().min(1),
  translationGroupId: z.string(),
  sourceSlug: z.string(),
  targetSlug: z.string(),
  sourceTitle: z.string(),
  targetTitle: z.string(),
  parentKind: z.enum(['database', 'page']),
  parentDatabaseId: z.string().nullable(),
  parentTargetPageId: z.string().nullable(),
  updatedAt: z.string(),
})

const ResourceMappingStoreSchema = z.object({
  version: z.literal(1),
  mappingsBySourceKey: z.record(ResourceMappingEntrySchema),
  updatedAt: z.string(),
})

export function getResourceMappingStorePath(
  config: Partial<TranslationConfig> = {}
): string {
  return path.join(getStateDirectoryPath(config), 'resource-map.json')
}

export function buildResourceMappingKey(
  sourcePageId: string,
  targetLocale = 'vi'
): string {
  return `${normalizeNotionId(sourcePageId)}:${String(targetLocale || 'vi')
    .trim()
    .toLowerCase()}`
}

export function readResourceMappingStore(
  config: Partial<TranslationConfig> = {}
): ResourceMappingStoreData {
  const filePath = getResourceMappingStorePath(config)
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      mappingsBySourceKey: {},
      updatedAt: new Date().toISOString(),
    }
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const validated = ResourceMappingStoreSchema.safeParse(parsed)
    if (!validated.success) {
      return {
        version: 1,
        mappingsBySourceKey: {},
        updatedAt: new Date().toISOString(),
      }
    }
    return validated.data as ResourceMappingStoreData
  } catch {
    return {
      version: 1,
      mappingsBySourceKey: {},
      updatedAt: new Date().toISOString(),
    }
  }
}

export function writeResourceMappingStore(
  storeData: ResourceMappingStoreData,
  config: Partial<TranslationConfig> = {}
): ResourceMappingStoreData | null {
  if (config?.dryRun) return storeData
  const filePath = getResourceMappingStorePath(config)
  const dirPath = path.dirname(filePath)
  fs.mkdirSync(dirPath, { recursive: true })

  const safePayload = sanitizeCheckpointValue<ResourceMappingStoreData>({
    version: 1,
    mappingsBySourceKey: storeData.mappingsBySourceKey || {},
    updatedAt: new Date().toISOString(),
  })

  const serialized = JSON.stringify(safePayload, null, 2)
  const rand = crypto.randomBytes(4).toString('hex')
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`

  fs.writeFileSync(tmpPath, serialized, 'utf8')
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // Ignore cleanup error
    }
    throw err
  }
  return safePayload
}

export function recordPageTranslationMapping(
  entry: Omit<ResourceMappingEntry, 'updatedAt'> & { updatedAt?: string },
  config: Partial<TranslationConfig> = {}
): ResourceMappingEntry | null {
  const normSource = normalizeNotionId(entry.sourcePageId)
  const normTarget = normalizeNotionId(entry.targetPageId)
  if (!normSource || !normTarget) return null

  const store = readResourceMappingStore(config)
  const key = buildResourceMappingKey(entry.sourcePageId, entry.targetLocale)
  const fullEntry: ResourceMappingEntry = {
    sourcePageId: entry.sourcePageId,
    targetPageId: entry.targetPageId,
    targetLocale: String(entry.targetLocale || 'vi')
      .trim()
      .toLowerCase(),
    translationGroupId: entry.translationGroupId || '',
    sourceSlug: entry.sourceSlug || '',
    targetSlug: entry.targetSlug || '',
    sourceTitle: entry.sourceTitle || '',
    targetTitle: entry.targetTitle || '',
    parentKind: entry.parentKind || 'database',
    parentDatabaseId: entry.parentDatabaseId || null,
    parentTargetPageId: entry.parentTargetPageId || null,
    updatedAt: entry.updatedAt || new Date().toISOString(),
  }

  store.mappingsBySourceKey[key] = fullEntry
  writeResourceMappingStore(store, config)
  return fullEntry
}

export function getMappedTargetPage(
  sourcePageId: string,
  targetLocale = 'vi',
  config: Partial<TranslationConfig> = {}
): ResourceMappingEntry | null {
  const key = buildResourceMappingKey(sourcePageId, targetLocale)
  const store = readResourceMappingStore(config)
  return store.mappingsBySourceKey[key] || null
}

export function getAllResourceMappings(
  targetLocale = 'vi',
  config: Partial<TranslationConfig> = {}
): ResourceMappingEntry[] {
  const normalizedLocale = String(targetLocale || 'vi')
    .trim()
    .toLowerCase()
  const store = readResourceMappingStore(config)
  return Object.values(store.mappingsBySourceKey || {}).filter(
    (entry) =>
      String(entry.targetLocale || '')
        .trim()
        .toLowerCase() === normalizedLocale
  )
}

const SegmentCacheEntrySchema = z.object({
  translatedText: z.string(),
  targetLocale: z.string(),
  updatedAt: z.string(),
})

const SegmentCacheStoreSchema = z.object({
  version: z.literal(1),
  entries: z.record(SegmentCacheEntrySchema),
  updatedAt: z.string(),
})

let inMemorySegmentCachePath = ''
let inMemorySegmentCache: SegmentCacheStoreData | null = null

export function getSegmentCacheStorePath(
  config: Partial<TranslationConfig> = {}
): string {
  return path.join(getStateDirectoryPath(config), 'segment-cache.json')
}

export function computeSegmentCacheKey(params: {
  text: string
  sourceLocale?: string
  targetLocale?: string
  promptVersion?: string
  glossaryHash?: string
  contextKey?: string
}): string {
  const normalizedText = String(params.text || '').trim()
  const sourceLocale = String(params.sourceLocale || 'en')
    .trim()
    .toLowerCase()
  const targetLocale = String(params.targetLocale || 'vi')
    .trim()
    .toLowerCase()
  const promptVersion = String(params.promptVersion || 'sn-v2').trim()
  const glossaryHash = String(params.glossaryHash || 'default').trim()
  const contextKey = String(params.contextKey || '').trim()

  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        normalizedText,
        sourceLocale,
        targetLocale,
        promptVersion,
        glossaryHash,
        contextKey,
      ])
    )
    .digest('hex')
    .slice(0, 32)
}

export function readSegmentCacheStore(
  config: Partial<TranslationConfig> = {}
): SegmentCacheStoreData {
  const filePath = getSegmentCacheStorePath(config)
  if (inMemorySegmentCache && inMemorySegmentCachePath === filePath) {
    return inMemorySegmentCache
  }

  if (!fs.existsSync(filePath)) {
    const empty: SegmentCacheStoreData = {
      version: 1,
      entries: {},
      updatedAt: new Date().toISOString(),
    }
    inMemorySegmentCachePath = filePath
    inMemorySegmentCache = empty
    return empty
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const validated = SegmentCacheStoreSchema.safeParse(parsed)
    if (!validated.success) {
      const empty: SegmentCacheStoreData = {
        version: 1,
        entries: {},
        updatedAt: new Date().toISOString(),
      }
      inMemorySegmentCachePath = filePath
      inMemorySegmentCache = empty
      return empty
    }
    inMemorySegmentCachePath = filePath
    inMemorySegmentCache = validated.data as SegmentCacheStoreData
    return inMemorySegmentCache
  } catch {
    const empty: SegmentCacheStoreData = {
      version: 1,
      entries: {},
      updatedAt: new Date().toISOString(),
    }
    inMemorySegmentCachePath = filePath
    inMemorySegmentCache = empty
    return empty
  }
}

export function writeSegmentCacheStore(
  storeData: SegmentCacheStoreData,
  config: Partial<TranslationConfig> = {}
): SegmentCacheStoreData | null {
  const filePath = getSegmentCacheStorePath(config)
  inMemorySegmentCachePath = filePath
  inMemorySegmentCache = storeData
  if (config?.dryRun) return storeData

  const dirPath = path.dirname(filePath)
  fs.mkdirSync(dirPath, { recursive: true })

  const safePayload = sanitizeCheckpointValue<SegmentCacheStoreData>({
    version: 1,
    entries: storeData.entries || {},
    updatedAt: new Date().toISOString(),
  })

  const serialized = JSON.stringify(safePayload, null, 2)
  const rand = crypto.randomBytes(4).toString('hex')
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`

  fs.writeFileSync(tmpPath, serialized, 'utf8')
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // Ignore cleanup error
    }
    throw err
  }
  inMemorySegmentCache = safePayload
  return safePayload
}

export function getCachedSegmentTranslation(
  cacheKey: string,
  targetLocale = 'vi',
  config: Partial<TranslationConfig> = {}
): string | null {
  if (!cacheKey) return null
  const store = readSegmentCacheStore(config)
  const entry = store.entries[cacheKey]
  if (!entry) return null
  if (
    String(entry.targetLocale || '')
      .trim()
      .toLowerCase() !==
    String(targetLocale || 'vi')
      .trim()
      .toLowerCase()
  ) {
    return null
  }
  return entry.translatedText
}

export function recordCachedSegmentTranslations(
  newEntries: ReadonlyArray<{
    cacheKey: string
    translatedText: string
    targetLocale: string
  }>,
  config: Partial<TranslationConfig> = {}
): void {
  if (!newEntries || newEntries.length === 0) return
  const store = readSegmentCacheStore(config)
  const nowIso = new Date().toISOString()
  let changed = false

  for (const item of newEntries) {
    if (!item.cacheKey || !item.translatedText?.trim()) continue
    store.entries[item.cacheKey] = {
      translatedText: item.translatedText,
      targetLocale: String(item.targetLocale || 'vi')
        .trim()
        .toLowerCase(),
      updatedAt: nowIso,
    }
    changed = true
  }

  if (changed) {
    writeSegmentCacheStore(store, config)
  }
}



