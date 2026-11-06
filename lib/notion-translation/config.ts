import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { TRANSLATION_STATUS, type GlossaryRule } from './types'

export { TRANSLATION_STATUS }

export const TRANSLATION_STATUS_OPTIONS = [
  { name: TRANSLATION_STATUS.NOT_STARTED, color: 'gray' },
  { name: TRANSLATION_STATUS.REQUESTED, color: 'blue' },
  { name: TRANSLATION_STATUS.PROCESSING, color: 'yellow' },
  { name: TRANSLATION_STATUS.DRAFT_READY, color: 'green' },
  { name: TRANSLATION_STATUS.NEEDS_REVIEW, color: 'orange' },
  { name: TRANSLATION_STATUS.FAILED, color: 'red' },
] as const

export const SERVICENOW_GLOSSARY: readonly GlossaryRule[] = Object.freeze([
  { term: 'ServiceNow', rule: 'Keep unchanged ("ServiceNow").' },
  { term: 'CMDB', rule: 'Keep unchanged ("CMDB").' },
  { term: 'CSDM', rule: 'Keep unchanged ("CSDM").' },
  { term: 'IRE', rule: 'Keep unchanged ("IRE").' },
  { term: 'GlideRecord', rule: 'Keep unchanged ("GlideRecord").' },
  {
    term: 'Business Rule',
    rule: 'Keep "Business Rule" (or contextually appropriate Vietnamese technical term such as "Business Rule (Quy tắc nghiệp vụ)").',
  },
  { term: 'Script Include', rule: 'Keep unchanged ("Script Include").' },
  { term: 'Flow Designer', rule: 'Keep unchanged ("Flow Designer").' },
  {
    term: 'Configuration Item (CI)',
    rule: 'Preserve the abbreviation "CI" / "Configuration Item (CI)".',
  },
  {
    term: 'Identification and Reconciliation Engine',
    rule: 'Preserve official terminology and abbreviation ("Identification and Reconciliation Engine (IRE)").',
  },
])

let envFilesLoaded = false

/**
 * Loads .env.local and .env if present without overriding already-set process.env keys.
 */
export function loadEnvFilesIfNeeded(cwd: string = process.cwd()): void {
  if (envFilesLoaded) return
  envFilesLoaded = true

  const files = ['.env.local', '.env']
  for (const file of files) {
    const fullPath = path.join(cwd, file)
    if (!fs.existsSync(fullPath)) continue
    try {
      const content = fs.readFileSync(fullPath, 'utf8')
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eqIdx = line.indexOf('=')
        if (eqIdx <= 0) continue
        const key = line.slice(0, eqIdx).trim()
        let val = line.slice(eqIdx + 1).trim()
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1)
        }
        if (process.env[key] === undefined || process.env[key] === '') {
          process.env[key] = val
        }
      }
    } catch {
      // Ignore file read errors
    }
  }
}

function positiveIntWithDefault(
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
) {
  return z.preprocess((raw) => {
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) return fallback
    return Math.min(max, Math.max(min, Math.floor(num)))
  }, z.number().int().min(min).max(max))
}

export function inferAiProvider(env: Record<string, string | undefined>): string {
  const explicit = (env.AI_PROVIDER || '').trim().toLowerCase()
  if (explicit) return explicit

  const baseUrl = (env.AI_BASE_URL || '').trim().toLowerCase()
  const model = (env.AI_MODEL || '').trim().toLowerCase()

  if (baseUrl.includes('anthropic.com') || model.startsWith('claude-')) {
    return 'anthropic'
  }
  if (
    (baseUrl.includes('generativelanguage.googleapis.com') &&
      !baseUrl.includes('/openai')) ||
    (!baseUrl && model.startsWith('gemini-'))
  ) {
    return 'gemini'
  }
  if (baseUrl.includes('openrouter.ai')) return 'openrouter'
  if (baseUrl.includes('deepseek.com')) return 'deepseek'
  if (baseUrl.includes('groq.com')) return 'groq'
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
    if (!env.AI_API_KEY && !env.OPENAI_API_KEY && !baseUrl) return 'gemini'
  }
  if (
    env.ANTHROPIC_API_KEY &&
    !env.AI_API_KEY &&
    !env.OPENAI_API_KEY &&
    !baseUrl
  ) {
    return 'anthropic'
  }
  return 'openai'
}

export function getDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'gemini':
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'anthropic':
    case 'claude':
      return 'https://api.anthropic.com/v1'
    case 'openrouter':
      return 'https://openrouter.ai/api/v1'
    case 'deepseek':
      return 'https://api.deepseek.com/v1'
    case 'groq':
      return 'https://api.groq.com/openai/v1'
    case 'openai':
    case 'openai-compatible':
    default:
      return 'https://api.openai.com/v1'
  }
}

export function getDefaultModel(provider: string): string {
  switch (provider) {
    case 'gemini':
    case 'google':
      return 'gemini-2.5-flash'
    case 'anthropic':
    case 'claude':
      return 'claude-3-5-sonnet-latest'
    case 'deepseek':
      return 'deepseek-chat'
    case 'openrouter':
      return 'openai/gpt-4o-mini'
    case 'openai':
    case 'openai-compatible':
    default:
      return 'gpt-4o-mini'
  }
}

export const TranslationConfigSchema = z.object({
  notionToken: z.string(),
  translationDatabaseId: z.string(),
  rootPageId: z.string(),
  aiProvider: z.string().min(1),
  aiApiKey: z.string(),
  aiBaseUrl: z.string().min(1),
  aiModel: z.string().min(1),
  pollIntervalMs: positiveIntWithDefault(60000, 1000),
  targetLocale: z.string().min(1),
  sourceLocale: z.string().min(1),
  batchSize: positiveIntWithDefault(20, 1),
  maxBatchChars: positiveIntWithDefault(6000, 500),
  concurrency: positiveIntWithDefault(1, 1),
  staleTimeoutMs: positiveIntWithDefault(30 * 60 * 1000, 60000),
  maxBlocksPerAppend: positiveIntWithDefault(100, 1, 100),
  aiTimeoutMs: positiveIntWithDefault(120000, 1000),
  notionTimeoutMs: positiveIntWithDefault(30000, 1000),
  assetTimeoutMs: positiveIntWithDefault(60000, 1000),
  maxAssetBytes: positiveIntWithDefault(20 * 1024 * 1024, 1024),
  maxPaginationPages: positiveIntWithDefault(500, 1),
  lockFilePath: z.string().min(1),
  stateDirPath: z.string().min(1),
  dryRun: z.boolean().default(false),
  once: z.boolean().default(false),
  glossary: z.custom<readonly GlossaryRule[]>(),
})

export type TranslationConfig = z.infer<typeof TranslationConfigSchema>

export interface TranslationConfigOverrides extends Partial<TranslationConfig> {
  env?: Record<string, string | undefined>
}

export function getTranslationConfig(
  overrides: TranslationConfigOverrides = {}
): TranslationConfig {
  loadEnvFilesIfNeeded()
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...overrides.env,
  }

  const aiProvider = (overrides.aiProvider || inferAiProvider(env))
    .trim()
    .toLowerCase()

  const rawConfig = {
    notionToken:
      overrides.notionToken ||
      env.NOTION_TOKEN ||
      env.NOTION_API_SECRET ||
      env.NOTION_TOKEN_V2 ||
      '',
    translationDatabaseId:
      overrides.translationDatabaseId ||
      env.NOTION_TRANSLATION_DATABASE_ID ||
      env.NOTION_DATABASE_ID ||
      env.NOTION_ROOT_PAGE_ID ||
      '',
    rootPageId:
      overrides.rootPageId ||
      env.NOTION_ROOT_PAGE_ID ||
      env.NOTION_DATABASE_ID ||
      '',
    aiProvider,
    aiApiKey:
      overrides.aiApiKey ||
      env.AI_API_KEY ||
      env.OPENAI_API_KEY ||
      env.GEMINI_API_KEY ||
      env.GOOGLE_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      '',
    aiBaseUrl: (
      overrides.aiBaseUrl ||
      env.AI_BASE_URL ||
      getDefaultBaseUrl(aiProvider)
    ).replace(/\/+$/, ''),
    aiModel: overrides.aiModel || env.AI_MODEL || getDefaultModel(aiProvider),
    pollIntervalMs: overrides.pollIntervalMs ?? env.TRANSLATION_POLL_INTERVAL_MS,
    targetLocale: (
      overrides.targetLocale ||
      env.TRANSLATION_TARGET_LOCALE ||
      'vi'
    )
      .trim()
      .toLowerCase(),
    sourceLocale: (
      overrides.sourceLocale ||
      env.TRANSLATION_SOURCE_LOCALE ||
      'en'
    )
      .trim()
      .toLowerCase(),
    batchSize: overrides.batchSize ?? env.TRANSLATION_BATCH_SIZE,
    maxBatchChars: overrides.maxBatchChars ?? env.TRANSLATION_MAX_BATCH_CHARS,
    concurrency: overrides.concurrency ?? env.TRANSLATION_CONCURRENCY,
    staleTimeoutMs:
      overrides.staleTimeoutMs ?? env.TRANSLATION_STALE_TIMEOUT_MS,
    maxBlocksPerAppend: overrides.maxBlocksPerAppend,
    aiTimeoutMs: overrides.aiTimeoutMs ?? env.TRANSLATION_AI_TIMEOUT_MS,
    notionTimeoutMs:
      overrides.notionTimeoutMs ?? env.TRANSLATION_NOTION_TIMEOUT_MS,
    assetTimeoutMs:
      overrides.assetTimeoutMs ?? env.TRANSLATION_ASSET_TIMEOUT_MS,
    maxAssetBytes: overrides.maxAssetBytes ?? env.TRANSLATION_MAX_ASSET_BYTES,
    maxPaginationPages:
      overrides.maxPaginationPages ?? env.TRANSLATION_MAX_PAGINATION_PAGES,
    lockFilePath:
      overrides.lockFilePath ||
      env.TRANSLATION_LOCK_FILE ||
      path.join(process.cwd(), '.translation-worker.lock'),
    stateDirPath:
      overrides.stateDirPath ||
      env.TRANSLATION_STATE_DIR ||
      path.join(process.cwd(), '.translation-worker-state'),
    dryRun: Boolean(overrides.dryRun),
    once: Boolean(overrides.once),
    glossary: overrides.glossary || SERVICENOW_GLOSSARY,
  }

  return TranslationConfigSchema.parse(rawConfig)
}

export function validateConfig(
  config: TranslationConfig,
  options: { requireAi?: boolean } = {}
): { valid: boolean; errors: string[] } {
  const { requireAi = true } = options
  const errors: string[] = []

  if (!config.notionToken) {
    errors.push(
      'Missing Notion API token (set NOTION_TOKEN or NOTION_API_SECRET in .env.local).'
    )
  }
  if (!config.translationDatabaseId) {
    errors.push(
      'Missing Notion database ID (set NOTION_TRANSLATION_DATABASE_ID or NOTION_ROOT_PAGE_ID in .env.local).'
    )
  }
  if (
    requireAi &&
    !config.aiApiKey &&
    config.aiProvider !== 'ollama' &&
    config.aiProvider !== 'mock'
  ) {
    errors.push('Missing AI API key (set AI_API_KEY in .env.local).')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

