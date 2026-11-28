import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { normalizeNotionId } from '../notion-client'
import type { TranslationConfig } from '../config'
import type {
  ResourceMappingEntry,
  ResourceMappingStoreData,
} from '../types'
import { getStateDirectoryPath, writeAtomicJsonFile } from './storage'

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
  return writeAtomicJsonFile<ResourceMappingStoreData>(filePath, {
    version: 1,
    mappingsBySourceKey: storeData.mappingsBySourceKey || {},
    updatedAt: new Date().toISOString(),
  })
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
