import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { TranslationConfig } from '../config'
import type { SegmentCacheStoreData } from '../types'
import { getStateDirectoryPath, writeAtomicJsonFile } from './storage'

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

  const safePayload = writeAtomicJsonFile<SegmentCacheStoreData>(filePath, {
    version: 1,
    entries: storeData.entries || {},
    updatedAt: new Date().toISOString(),
  })
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
