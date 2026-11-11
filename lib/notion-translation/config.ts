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

function nonNegativeIntWithDefault(
  fallback: number,
  max = Number.MAX_SAFE_INTEGER
) {
  return z.preprocess((raw) => {
    if (raw === undefined || raw === null || raw === '') return fallback
    const num = Number(raw)
    if (!Number.isFinite(num) || num < 0) return fallback
    return Math.min(max, Math.max(0, Math.floor(num)))
  }, z.number().int().min(0).max(max))
}

function nonNegativeFloatWithDefault(fallback: number) {
  return z.preprocess((raw) => {
    if (raw === undefined || raw === null || raw === '') return fallback
    const num = Number(raw)
    if (!Number.isFinite(num) || num < 0) return fallback
    return num
  }, z.number().min(0))
}

function boundedFloatWithDefault(
  fallback: number,
  min = 1.0,
  max = 10.0
) {
  return z.preprocess((raw) => {
    if (raw === undefined || raw === null || raw === '') return fallback
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) return fallback
    return Math.min(max, Math.max(min, num))
  }, z.number().min(min).max(max))
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
  if (env.GROQ_API_KEY && !env.AI_API_KEY && !env.OPENAI_API_KEY && !baseUrl) {
    return 'groq'
  }
  if (
    env.OPENROUTER_API_KEY &&
    !env.AI_API_KEY &&
    !env.OPENAI_API_KEY &&
    !baseUrl
  ) {
    return 'openrouter'
  }
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
    case 'groq':
      return 'qwen/qwen3-32b'
    case 'openrouter':
      return 'qwen/qwen3-32b'
    case 'openai':
    case 'openai-compatible':
    default:
      return 'gpt-4o-mini'
  }
}

export function resolveProviderApiKey(
  provider: string,
  env: Record<string, string | undefined>,
  explicitKey?: string
): string {
  if (explicitKey) return explicitKey
  if (env.AI_API_KEY) return env.AI_API_KEY

  switch (provider) {
    case 'groq':
      return env.GROQ_API_KEY || ''
    case 'openrouter':
      return env.OPENROUTER_API_KEY || ''
    case 'gemini':
    case 'google':
      return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || ''
    case 'anthropic':
    case 'claude':
      return env.ANTHROPIC_API_KEY || ''
    case 'deepseek':
      return env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || ''
    case 'openai':
    case 'openai-compatible':
    default:
      return (
        env.OPENAI_API_KEY ||
        env.GROQ_API_KEY ||
        env.OPENROUTER_API_KEY ||
        env.GEMINI_API_KEY ||
        env.GOOGLE_API_KEY ||
        env.ANTHROPIC_API_KEY ||
        ''
      )
  }
}

export const TranslationConfigSchema = z.object({
  notionToken: z.string(),
  translationDatabaseId: z.string(),
  rootPageId: z.string(),
  translationMappingDatabaseId: z.string().default(''),
  aiProvider: z.string().min(1),
  aiApiKey: z.string(),
  aiBaseUrl: z.string().min(1),
  aiModel: z.string().min(1),
  pollIntervalMs: positiveIntWithDefault(60000, 1000),
  targetLocale: z.string().min(1),
  sourceLocale: z.string().min(1),
  batchSize: positiveIntWithDefault(60, 1, 80),
  maxBatchSegments: positiveIntWithDefault(80, 1, 80),
  maxBatchChars: positiveIntWithDefault(12000, 500),
  maxInputTokensPerBatch: positiveIntWithDefault(4500, 200),
  targetOutputTokensPerBatch: positiveIntWithDefault(5000, 1024, 32768),
  minOutputTokens: positiveIntWithDefault(2048, 256, 32768),
  maxOutputTokens: positiveIntWithDefault(8192, 512, 65536),
  outputTokenSafetyMargin: boundedFloatWithDefault(1.8, 1.1, 5.0),
  assumedOutputTokensPerSec: positiveIntWithDefault(53, 5, 1000),
  rpmLimit: nonNegativeIntWithDefault(0),
  tpmLimit: nonNegativeIntWithDefault(0),
  rpdLimit: nonNegativeIntWithDefault(0),
  tpdLimit: nonNegativeIntWithDefault(0),
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
  glossaryFilePath: z.string().default(''),
  customProtectedTerms: z.array(z.string()).default([]),
  inputCostPer1M: nonNegativeFloatWithDefault(0),
  outputCostPer1M: nonNegativeFloatWithDefault(0),
  disableReasoning: z.boolean().default(true),
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

  const customProtectedTerms = Array.isArray(overrides.customProtectedTerms)
    ? overrides.customProtectedTerms
    : (env.TRANSLATION_CUSTOM_TERMS || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

  const disableReasoningRaw =
    overrides.disableReasoning !== undefined
      ? overrides.disableReasoning
      : env.TRANSLATION_DISABLE_REASONING !== undefined
        ? !/^(false|0|no)$/i.test(env.TRANSLATION_DISABLE_REASONING.trim())
        : true

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
    translationMappingDatabaseId:
      overrides.translationMappingDatabaseId ||
      env.NOTION_TRANSLATION_MAPPING_DATABASE_ID ||
      '415ac39b-0efb-8050-9ab4-ecb760e41cc5',
    aiProvider,
    aiApiKey: resolveProviderApiKey(aiProvider, env, overrides.aiApiKey),
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
    maxBatchSegments:
      overrides.maxBatchSegments ?? env.TRANSLATION_MAX_BATCH_SEGMENTS,
    maxBatchChars: overrides.maxBatchChars ?? env.TRANSLATION_MAX_BATCH_CHARS,
    maxInputTokensPerBatch:
      overrides.maxInputTokensPerBatch ??
      env.TRANSLATION_MAX_INPUT_TOKENS_PER_BATCH,
    targetOutputTokensPerBatch:
      overrides.targetOutputTokensPerBatch ??
      env.TRANSLATION_TARGET_OUTPUT_TOKENS_PER_BATCH,
    minOutputTokens:
      overrides.minOutputTokens ?? env.TRANSLATION_MIN_OUTPUT_TOKENS,
    maxOutputTokens:
      overrides.maxOutputTokens ?? env.TRANSLATION_MAX_OUTPUT_TOKENS,
    outputTokenSafetyMargin:
      overrides.outputTokenSafetyMargin ??
      env.TRANSLATION_OUTPUT_SAFETY_MARGIN,
    assumedOutputTokensPerSec:
      overrides.assumedOutputTokensPerSec ?? env.TRANSLATION_ASSUMED_OUTPUT_TPS,
    rpmLimit: overrides.rpmLimit ?? env.TRANSLATION_RPM_LIMIT,
    tpmLimit: overrides.tpmLimit ?? env.TRANSLATION_TPM_LIMIT,
    rpdLimit: overrides.rpdLimit ?? env.TRANSLATION_RPD_LIMIT,
    tpdLimit: overrides.tpdLimit ?? env.TRANSLATION_TPD_LIMIT,
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
    glossaryFilePath:
      overrides.glossaryFilePath ?? env.TRANSLATION_GLOSSARY_PATH ?? '',
    customProtectedTerms,
    inputCostPer1M:
      overrides.inputCostPer1M ?? env.TRANSLATION_INPUT_COST_PER_1M,
    outputCostPer1M:
      overrides.outputCostPer1M ?? env.TRANSLATION_OUTPUT_COST_PER_1M,
    disableReasoning: Boolean(disableReasoningRaw),
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
    errors.push(
      'Missing AI API key (set AI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY in .env.local).'
    )
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

