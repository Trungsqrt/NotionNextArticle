'use strict'

const fs = require('node:fs')
const path = require('node:path')

const TRANSLATION_STATUS = Object.freeze({
  NOT_STARTED: 'Not Started',
  REQUESTED: 'Requested',
  PROCESSING: 'Processing',
  DRAFT_READY: 'Draft Ready',
  NEEDS_REVIEW: 'Needs Review',
  FAILED: 'Failed',
})

const TRANSLATION_STATUS_OPTIONS = Object.freeze([
  { name: TRANSLATION_STATUS.NOT_STARTED, color: 'gray' },
  { name: TRANSLATION_STATUS.REQUESTED, color: 'blue' },
  { name: TRANSLATION_STATUS.PROCESSING, color: 'yellow' },
  { name: TRANSLATION_STATUS.DRAFT_READY, color: 'green' },
  { name: TRANSLATION_STATUS.NEEDS_REVIEW, color: 'orange' },
  { name: TRANSLATION_STATUS.FAILED, color: 'red' },
])

const SERVICENOW_GLOSSARY = Object.freeze([
  { term: 'ServiceNow', rule: 'Keep unchanged ("ServiceNow").' },
  { term: 'CMDB', rule: 'Keep unchanged ("CMDB").' },
  { term: 'CSDM', rule: 'Keep unchanged ("CSDM").' },
  { term: 'IRE', rule: 'Keep unchanged ("IRE").' },
  { term: 'GlideRecord', rule: 'Keep unchanged ("GlideRecord").' },
  { term: 'Business Rule', rule: 'Keep "Business Rule" (or contextually appropriate Vietnamese technical term such as "Business Rule (Quy tắc nghiệp vụ)").' },
  { term: 'Script Include', rule: 'Keep unchanged ("Script Include").' },
  { term: 'Flow Designer', rule: 'Keep unchanged ("Flow Designer").' },
  { term: 'Configuration Item (CI)', rule: 'Preserve the abbreviation "CI" / "Configuration Item (CI)".' },
  { term: 'Identification and Reconciliation Engine', rule: 'Preserve official terminology and abbreviation ("Identification and Reconciliation Engine (IRE)").' },
])

let envFilesLoaded = false

/**
 * Loads .env.local and .env if present without overriding already-set process.env keys.
 */
function loadEnvFilesIfNeeded(cwd = process.cwd()) {
  if (envFilesLoaded) return
  envFilesLoaded = true

  // Load .env.local first (higher precedence), then .env as fallback
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

function inferAiProvider(env) {
  const explicit = (env.AI_PROVIDER || '').trim().toLowerCase()
  if (explicit) return explicit

  const baseUrl = (env.AI_BASE_URL || '').trim().toLowerCase()
  const model = (env.AI_MODEL || '').trim().toLowerCase()

  if (baseUrl.includes('anthropic.com') || model.startsWith('claude-')) {
    return 'anthropic'
  }
  if (
    (baseUrl.includes('generativelanguage.googleapis.com') && !baseUrl.includes('/openai')) ||
    ( !baseUrl && model.startsWith('gemini-') )
  ) {
    return 'gemini'
  }
  if (baseUrl.includes('openrouter.ai')) return 'openrouter'
  if (baseUrl.includes('deepseek.com')) return 'deepseek'
  if (baseUrl.includes('groq.com')) return 'groq'
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
    if (!env.AI_API_KEY && !env.OPENAI_API_KEY && !baseUrl) return 'gemini'
  }
  if (env.ANTHROPIC_API_KEY && !env.AI_API_KEY && !env.OPENAI_API_KEY && !baseUrl) {
    return 'anthropic'
  }
  return 'openai'
}

function getDefaultBaseUrl(provider) {
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

function getDefaultModel(provider) {
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

function getTranslationConfig(overrides = {}) {
  loadEnvFilesIfNeeded()
  const env = { ...process.env, ...overrides.env }

  const notionToken =
    overrides.notionToken ||
    env.NOTION_TOKEN ||
    env.NOTION_API_SECRET ||
    env.NOTION_TOKEN_V2 ||
    ''

  const translationDatabaseId =
    overrides.translationDatabaseId ||
    env.NOTION_TRANSLATION_DATABASE_ID ||
    env.NOTION_DATABASE_ID ||
    env.NOTION_ROOT_PAGE_ID ||
    ''

  const rootPageId =
    overrides.rootPageId ||
    env.NOTION_ROOT_PAGE_ID ||
    env.NOTION_DATABASE_ID ||
    ''

  const aiProvider = overrides.aiProvider || inferAiProvider(env)
  const aiApiKey =
    overrides.aiApiKey ||
    env.AI_API_KEY ||
    env.OPENAI_API_KEY ||
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    ''

  const aiBaseUrl = (
    overrides.aiBaseUrl ||
    env.AI_BASE_URL ||
    getDefaultBaseUrl(aiProvider)
  ).replace(/\/+$/, '')

  const aiModel =
    overrides.aiModel ||
    env.AI_MODEL ||
    getDefaultModel(aiProvider)

  const pollIntervalMs = Math.max(
    1000,
    Number(overrides.pollIntervalMs ?? env.TRANSLATION_POLL_INTERVAL_MS ?? 60000) || 60000
  )

  const targetLocale = (
    overrides.targetLocale ||
    env.TRANSLATION_TARGET_LOCALE ||
    'vi'
  ).trim().toLowerCase()

  const sourceLocale = (
    overrides.sourceLocale ||
    env.TRANSLATION_SOURCE_LOCALE ||
    'en'
  ).trim().toLowerCase()

  const batchSize = Math.max(
    1,
    Number(overrides.batchSize ?? env.TRANSLATION_BATCH_SIZE ?? 20) || 20
  )

  const maxBatchChars = Math.max(
    500,
    Number(overrides.maxBatchChars ?? env.TRANSLATION_MAX_BATCH_CHARS ?? 6000) || 6000
  )

  const concurrency = Math.max(
    1,
    Number(overrides.concurrency ?? env.TRANSLATION_CONCURRENCY ?? 1) || 1
  )

  const staleTimeoutMs = Math.max(
    60000,
    Number(overrides.staleTimeoutMs ?? env.TRANSLATION_STALE_TIMEOUT_MS ?? 30 * 60 * 1000) || 30 * 60 * 1000
  )

  const maxBlocksPerAppend = Math.min(
    100,
    Math.max(1, Number(overrides.maxBlocksPerAppend ?? 100) || 100)
  )

  const lockFilePath =
    overrides.lockFilePath ||
    env.TRANSLATION_LOCK_FILE ||
    path.join(process.cwd(), '.translation-worker.lock')

  return {
    notionToken,
    translationDatabaseId,
    rootPageId,
    aiProvider,
    aiApiKey,
    aiBaseUrl,
    aiModel,
    pollIntervalMs,
    targetLocale,
    sourceLocale,
    batchSize,
    maxBatchChars,
    concurrency,
    staleTimeoutMs,
    maxBlocksPerAppend,
    lockFilePath,
    dryRun: Boolean(overrides.dryRun),
    once: Boolean(overrides.once),
    glossary: overrides.glossary || SERVICENOW_GLOSSARY,
  }
}

function validateConfig(config, { requireAi = true } = {}) {
  const errors = []
  if (!config.notionToken) {
    errors.push('Missing Notion API token (set NOTION_TOKEN or NOTION_API_SECRET in .env.local).')
  }
  if (!config.translationDatabaseId) {
    errors.push('Missing Notion database ID (set NOTION_TRANSLATION_DATABASE_ID or NOTION_ROOT_PAGE_ID in .env.local).')
  }
  if (requireAi && !config.aiApiKey && config.aiProvider !== 'ollama' && config.aiProvider !== 'mock') {
    errors.push('Missing AI API key (set AI_API_KEY in .env.local).')
  }
  return {
    valid: errors.length === 0,
    errors,
  }
}

module.exports = {
  TRANSLATION_STATUS,
  TRANSLATION_STATUS_OPTIONS,
  SERVICENOW_GLOSSARY,
  loadEnvFilesIfNeeded,
  getTranslationConfig,
  validateConfig,
}

