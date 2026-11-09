import pRetry, { AbortError } from 'p-retry'
import { z } from 'zod'
import {
  getTranslationConfig,
  SERVICENOW_GLOSSARY,
  type TranslationConfig,
} from './config'
import {
  computeSegmentCacheKey,
  getCachedSegmentTranslation,
  recordCachedSegmentTranslations,
} from './checkpoint-store'
import {
  loadServiceNowGlossary,
  protectServiceNowTerminology,
  restoreServiceNowTerminology,
  verifyPlaceholdersIntact,
  type ProtectedTextResult,
} from './terminology'
import type {
  AiProviderAdapter,
  AiProviderStructuredResponse,
  AiProviderTokenUsage,
  GlossaryRule,
  TranslateManifestResult,
  TranslationItem,
  TranslationManifest,
  TranslationUsageStats,
  WorkerLogger,
} from './types'
import { defaultLogger } from '../../worker/logger'

export const PROMPT_VERSION = 'sn-v2'

export const SERVICENOW_SYSTEM_PROMPT = [
  'You are a professional English-to-Vietnamese translator specializing in ServiceNow documentation.',
  '',
  'Translate accurately and naturally. Preserve the original meaning, structure, and technical details.',
  '',
  'Rules:',
  '- Keep official ServiceNow terms and product names in English (e.g. Catalog Item, Record Producer, Business Rule, Script Include, Flow Designer, CMDB, CSDM, IRE).',
  '- Never translate named ServiceNow records, Catalog Items, Flows, tables, fields, APIs, identifiers, code, URLs, or placeholders.',
  '- Translate ordinary prose, not technical names.',
  '- Do not add, omit, summarize, or explain content.',
  '- Preserve input segment IDs and return only valid compact JSON with translated values.',
  '- No commentary or Markdown fences.',
].join('\n')

const LegacyBatchTranslationResponseSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    })
  ),
})

export class QuotaExhaustedError extends Error {
  readonly code = 'AI_QUOTA_EXHAUSTED'
  readonly isQuotaExhausted = true
  readonly isRetryable = false
  readonly provider: string
  readonly model: string
  readonly status?: number

  constructor(
    message: string,
    options: { provider?: string; model?: string; status?: number } = {}
  ) {
    super(message)
    this.name = 'QuotaExhaustedError'
    this.provider = options.provider || 'unknown'
    this.model = options.model || 'unknown'
    this.status = options.status
  }
}

export function isQuotaExhaustedError(
  err: unknown
): err is QuotaExhaustedError {
  if (!err || typeof err !== 'object') return false
  if (err instanceof QuotaExhaustedError) return true
  const candidate = err as {
    code?: string
    isQuotaExhausted?: boolean
    name?: string
  }
  return (
    candidate.isQuotaExhausted === true ||
    candidate.code === 'AI_QUOTA_EXHAUSTED' ||
    candidate.name === 'QuotaExhaustedError'
  )
}

/**
 * Estimates token count using a fast character/word heuristic (~3.5 chars per token for mixed EN/VI/JSON).
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(String(text).length / 3.5))
}

/**
 * Converts a 0-based batch index into a short alphabetic key ("a", "b", ..., "z", "aa", "ab", ...).
 */
export function indexToShortKey(index: number): string {
  let n = Math.max(0, Math.floor(index))
  let key = ''
  do {
    key = String.fromCharCode(97 + (n % 26)) + key
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return key
}

export function buildSystemPrompt(
  targetLocale = 'vi',
  _glossary: readonly GlossaryRule[] = SERVICENOW_GLOSSARY
): string {
  if (targetLocale && targetLocale.toLowerCase() !== 'vi') {
    return `${SERVICENOW_SYSTEM_PROMPT}\nTarget locale: ${targetLocale}.`
  }
  return SERVICENOW_SYSTEM_PROMPT
}

export interface BatchPromptBuildResult {
  userPrompt: string
  shortKeyToItemId: Map<string, string>
  itemIdToShortKey: Map<string, string>
  protectedByItemId: Map<string, ProtectedTextResult>
  estimatedInputTokens: number
  estimatedOutputTokens: number
}

export function buildCompactBatchPrompt(
  batchItems: readonly TranslationItem[],
  protectedMap: ReadonlyMap<string, ProtectedTextResult>,
  retryReason: string | null = null
): BatchPromptBuildResult {
  const segmentsObj: Record<string, string> = {}
  const contextHintsObj: Record<string, string> = {}
  const shortKeyToItemId = new Map<string, string>()
  const itemIdToShortKey = new Map<string, string>()
  const protectedByItemId = new Map<string, ProtectedTextResult>()

  let sourceTextChars = 0

  batchItems.forEach((item, idx) => {
    const shortKey = indexToShortKey(idx)
    shortKeyToItemId.set(shortKey, item.id)
    itemIdToShortKey.set(item.id, shortKey)

    const prot =
      protectedMap.get(item.id) || protectServiceNowTerminology(item.text)
    protectedByItemId.set(item.id, prot)

    segmentsObj[shortKey] = prot.protectedText
    sourceTextChars += prot.protectedText.length

    const fullBlock = (item.context?.fullBlockText || '').trim()
    const itemTrimmed = (item.text || '').trim()
    if (
      fullBlock &&
      fullBlock !== itemTrimmed &&
      fullBlock.length > itemTrimmed.length + 4 &&
      fullBlock.length <= 450
    ) {
      contextHintsObj[shortKey] = fullBlock
    }
  })

  const hasContextHints = Object.keys(contextHintsObj).length > 0
  const payload = hasContextHints
    ? { segments: segmentsObj, _contextOnlyDoNotInclude: contextHintsObj }
    : segmentsObj

  let userPrompt = JSON.stringify(payload)
  if (hasContextHints) {
    userPrompt =
      `Translate each value in "segments" into Vietnamese and return ONLY a flat JSON object mapping each key (${Object.keys(segmentsObj).join(', ')}) to its translated string. Use "_contextOnlyDoNotInclude" only to understand sentence context for fragments.\n` +
      userPrompt
  }

  if (retryReason) {
    userPrompt =
      `RETRY FIX REQUIRED: ${retryReason}\n` +
      `Return ONLY valid JSON with exact keys: ${JSON.stringify(Object.keys(segmentsObj))}. Preserve every __SN<n>__ placeholder untouched.\n` +
      userPrompt
  }

  const estimatedInputTokens =
    estimateTokenCount(SERVICENOW_SYSTEM_PROMPT) +
    estimateTokenCount(userPrompt) +
    16
  const estimatedOutputTokens = Math.max(
    256,
    Math.ceil((sourceTextChars / 3.2) * 1.45) + batchItems.length * 12 + 64
  )

  return {
    userPrompt,
    shortKeyToItemId,
    itemIdToShortKey,
    protectedByItemId,
    estimatedInputTokens,
    estimatedOutputTokens,
  }
}

export function buildUserPrompt(
  batchItems: readonly TranslationItem[],
  _contextMeta: { targetLocale?: string; articleTitle?: string } = {},
  retryReason: string | null = null
): string {
  const protectedMap = new Map<string, ProtectedTextResult>()
  for (const item of batchItems) {
    protectedMap.set(item.id, protectServiceNowTerminology(item.text))
  }
  return buildCompactBatchPrompt(batchItems, protectedMap, retryReason)
    .userPrompt
}

export function createTranslationBatches(
  items: readonly TranslationItem[],
  options: {
    batchSize?: number
    maxBatchChars?: number
    maxInputTokensPerBatch?: number
  } = {}
): TranslationItem[][] {
  const batchSize = Math.max(1, Number(options.batchSize) || 20)
  const maxBatchChars = Math.max(500, Number(options.maxBatchChars) || 6000)
  const maxInputTokensPerBatch = Math.max(
    200,
    Number(options.maxInputTokensPerBatch) || 1800
  )
  const systemPromptTokens = estimateTokenCount(SERVICENOW_SYSTEM_PROMPT) + 24

  const batches: TranslationItem[][] = []
  let currentBatch: TranslationItem[] = []
  let currentChars = 0
  let currentTokens = systemPromptTokens

  for (const item of items || []) {
    const textLen = item.text?.length || 0
    const fullLen = item.context?.fullBlockText?.length || 0
    const isFragment = fullLen > textLen + 4 && fullLen <= 450
    const itemChars = textLen + (isFragment ? Math.min(fullLen, 300) : 0) + 12
    const itemTokens = Math.ceil(itemChars / 3.5) + 6

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= batchSize ||
        currentChars + itemChars > maxBatchChars ||
        currentTokens + itemTokens > maxInputTokensPerBatch)
    ) {
      batches.push(currentBatch)
      currentBatch = []
      currentChars = 0
      currentTokens = systemPromptTokens
    }
    currentBatch.push(item)
    currentChars += itemChars
    currentTokens += itemTokens
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  return batches
}

export function extractJsonFromModelText(rawText: string): unknown {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty response from AI provider')
  }

  // Strip optional <think>...</think> blocks emitted by reasoning models
  const withoutThink = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const trimmed = withoutThink || rawText.trim()

  try {
    return JSON.parse(trimmed)
  } catch {
    // Strip markdown code fences if present
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch && fenceMatch[1]) {
    return JSON.parse(fenceMatch[1].trim())
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
  }

  throw new Error('Response is not valid JSON')
}

export function validateBatchTranslationResponse(
  batchItems: readonly TranslationItem[],
  parsed: unknown,
  options: {
    shortKeyToItemId?: ReadonlyMap<string, string>
    protectedByItemId?: ReadonlyMap<string, ProtectedTextResult>
  } = {}
):
  | { valid: true; returnedMap: Map<string, string> }
  | { valid: false; error: string } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      valid: false,
      error: 'Invalid AI translation response: expected a JSON object',
    }
  }

  const expectedIds = new Set(batchItems.map((item) => item.id))
  const expectedById = new Map(batchItems.map((item) => [item.id, item]))
  const shortKeyMap =
    options.shortKeyToItemId ||
    new Map(batchItems.map((item, idx) => [indexToShortKey(idx), item.id]))
  const returnedMap = new Map<string, string>()

  const recordObj = parsed as Record<string, unknown>

  // 1. Support legacy {"translations":[{"id":"...","text":"..."}]} schema
  if (Array.isArray(recordObj.translations)) {
    const legacyCheck = LegacyBatchTranslationResponseSchema.safeParse(parsed)
    if (!legacyCheck.success) {
      const firstIssue = legacyCheck.error.issues[0]
      return {
        valid: false,
        error: `Invalid AI translation JSON schema: ${firstIssue?.message || 'invalid translations array'}`,
      }
    }
    for (const entry of legacyCheck.data.translations) {
      const resolvedId = shortKeyMap.get(entry.id) || entry.id
      if (!expectedIds.has(resolvedId)) {
        return {
          valid: false,
          error: `Unexpected translation id returned: "${entry.id}"`,
        }
      }
      if (returnedMap.has(resolvedId)) {
        return {
          valid: false,
          error: `Duplicate translation id returned: "${entry.id}"`,
        }
      }
      returnedMap.set(resolvedId, entry.text)
    }
  } else {
    // 2. Compact flat JSON map {"a":"...","b":"..."} (or nested under "segments" / "translations")
    const candidateMap =
      recordObj.segments &&
      typeof recordObj.segments === 'object' &&
      !Array.isArray(recordObj.segments)
        ? (recordObj.segments as Record<string, unknown>)
        : recordObj.translations &&
            typeof recordObj.translations === 'object' &&
            !Array.isArray(recordObj.translations)
          ? (recordObj.translations as Record<string, unknown>)
          : recordObj

    for (const [rawKey, rawVal] of Object.entries(candidateMap)) {
      if (rawKey === '_contextOnlyDoNotInclude') continue
      if (typeof rawVal !== 'string') {
        return {
          valid: false,
          error: `Invalid non-string translation value for key "${rawKey}"`,
        }
      }
      const resolvedId = shortKeyMap.get(rawKey) || rawKey
      if (!expectedIds.has(resolvedId)) {
        return {
          valid: false,
          error: `Unexpected translation key returned: "${rawKey}"`,
        }
      }
      if (returnedMap.has(resolvedId)) {
        return {
          valid: false,
          error: `Duplicate translation key returned: "${rawKey}"`,
        }
      }
      returnedMap.set(resolvedId, rawVal)
    }
  }

  // Verify completeness and non-empty values
  const missingIds: string[] = []
  for (const item of batchItems) {
    if (!returnedMap.has(item.id)) {
      missingIds.push(item.id)
      continue
    }
    const val = returnedMap.get(item.id) || ''
    if (item.text?.trim() && !val.trim()) {
      return {
        valid: false,
        error: `Translation for "${item.id}" is empty`,
      }
    }
    const protectedInfo = options.protectedByItemId?.get(item.id)
    if (protectedInfo && protectedInfo.placeholders.size > 0) {
      const placeholderCheck = verifyPlaceholdersIntact(
        val,
        protectedInfo.placeholders
      )
      if (!placeholderCheck.valid) {
        return {
          valid: false,
          error: `Missing protected ServiceNow placeholder(s) ${placeholderCheck.missingPlaceholders.join(', ')} in translation for "${item.id}"`,
        }
      }
    }
  }

  if (missingIds.length > 0) {
    return {
      valid: false,
      error: `Missing ${missingIds.length} translation ID(s): ${missingIds.join(', ')}`,
    }
  }

  return {
    valid: true,
    returnedMap,
  }
}

export function preserveBoundaryWhitespace(
  sourceItem: Pick<TranslationItem, 'leadingSpace' | 'trailingSpace'>,
  translatedText: string
): string {
  let result = String(translatedText ?? '')
  const leading = sourceItem?.leadingSpace || ''
  const trailing = sourceItem?.trailingSpace || ''

  if (leading && !/^\s/.test(result)) {
    result = leading + result
  }
  if (trailing && !/\s$/.test(result)) {
    result = result + trailing
  }
  return result
}

interface HttpError extends Error {
  status?: number
  statusCode?: number
  code?: string
  isRetryable?: boolean
  isTruncated?: boolean
  isTokenLimitError?: boolean
  retryAfterMs?: number
}

function isRetryableAiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true
  if (isQuotaExhaustedError(err)) return false
  const e = err as HttpError
  if (e.isTruncated || e.isTokenLimitError) return false
  if (typeof e.isRetryable === 'boolean') return e.isRetryable
  const status = Number(e.status || e.statusCode || 0)
  if (status === 401 || status === 403 || status === 404 || status === 422) {
    return false
  }
  return true
}

function isSplitEligibleError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if (isQuotaExhaustedError(err)) return false
  const e = err as HttpError
  if (e.isTruncated || e.isTokenLimitError) return true
  const msg = String(e.message || '').toLowerCase()
  return (
    msg.includes('maximum context length') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('max_tokens') ||
    msg.includes('request too large') ||
    msg.includes('tokens per minute') ||
    msg.includes('truncated')
  )
}

function parseDurationHeaderMs(rawHeader: string | null | undefined): number {
  if (!rawHeader) return 0
  const trimmed = rawHeader.trim()
  if (!trimmed) return 0

  // Standard integer/float seconds
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.ceil(Number(trimmed) * 1000)
  }

  // Groq/OpenAI style duration strings like "1m20.5s", "450ms", "2h10m"
  let totalMs = 0
  let matched = false
  const regex = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(trimmed)) !== null) {
    matched = true
    const val = Number(match[1])
    const unit = match[2]!.toLowerCase()
    if (unit === 'ms') totalMs += val
    else if (unit === 's') totalMs += val * 1000
    else if (unit === 'm') totalMs += val * 60_000
    else if (unit === 'h') totalMs += val * 3_600_000
  }
  if (matched) return Math.ceil(totalMs)

  const parsedDate = Date.parse(trimmed)
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now())
  }
  return 0
}

function detectDailyQuotaExhaustionFromResponse(
  status: number,
  bodyText: string,
  headers: Headers
): { isExhausted: boolean; reason: string } {
  if (status !== 429 && status !== 402) {
    return { isExhausted: false, reason: '' }
  }

  const lower = String(bodyText || '').toLowerCase()
  const retryAfterMs =
    parseDurationHeaderMs(headers.get('retry-after')) ||
    parseDurationHeaderMs(headers.get('x-ratelimit-reset-requests'))

  if (status === 402) {
    return {
      isExhausted: true,
      reason: `Provider returned HTTP 402 (credits/quota exhausted): ${bodyText.slice(0, 240)}`,
    }
  }

  const dailyQuotaPatterns = [
    'tokens per day',
    'requests per day',
    'per day (tpd)',
    'per day (rpd)',
    'daily limit',
    'daily quota',
    'exceeded your current quota',
    'insufficient_quota',
    'credit balance is too low',
    'free-models-per-day',
    'rate limit reached for model',
  ]

  const isDailyText =
    dailyQuotaPatterns.some((p) => lower.includes(p)) &&
    (lower.includes('day') ||
      lower.includes('tpd') ||
      lower.includes('rpd') ||
      lower.includes('insufficient_quota') ||
      lower.includes('exceeded your current quota') ||
      lower.includes('credit') ||
      retryAfterMs > 10 * 60 * 1000)

  if (isDailyText || retryAfterMs > 15 * 60 * 1000) {
    return {
      isExhausted: true,
      reason: `Daily AI quota exhausted (HTTP ${status}${retryAfterMs > 0 ? `, reset in ${Math.round(retryAfterMs / 60000)}m` : ''}): ${bodyText.slice(0, 240)}`,
    }
  }

  return { isExhausted: false, reason: '' }
}

/**
 * Sliding-window RateLimiter supporting RPM, TPM, RPD, and TPD budgets.
 */
class ProviderRateLimiter {
  private readonly rpmLimit: number
  private readonly tpmLimit: number
  private readonly rpdLimit: number
  private readonly tpdLimit: number
  private readonly provider: string
  private readonly model: string
  private readonly minuteWindow: Array<{ ts: number; tokens: number }> = []
  private readonly dayWindow: Array<{ ts: number; tokens: number }> = []
  private cooldownUntilMs = 0

  constructor(config: Partial<TranslationConfig>) {
    this.rpmLimit = Math.max(0, Number(config.rpmLimit || 0))
    this.tpmLimit = Math.max(0, Number(config.tpmLimit || 0))
    this.rpdLimit = Math.max(0, Number(config.rpdLimit || 0))
    this.tpdLimit = Math.max(0, Number(config.tpdLimit || 0))
    this.provider = config.aiProvider || 'openai'
    this.model = config.aiModel || 'unknown'
  }

  private prune(now: number): void {
    const oneMinuteAgo = now - 60_000
    while (this.minuteWindow.length > 0 && this.minuteWindow[0]!.ts <= oneMinuteAgo) {
      this.minuteWindow.shift()
    }
    const oneDayAgo = now - 86_400_000
    while (this.dayWindow.length > 0 && this.dayWindow[0]!.ts <= oneDayAgo) {
      this.dayWindow.shift()
    }
  }

  async acquire(estimatedTokens: number, logger?: WorkerLogger): Promise<void> {
    const now = Date.now()
    this.prune(now)

    // 1. Check daily RPD / TPD budgets first
    if (this.rpdLimit > 0 && this.dayWindow.length >= this.rpdLimit) {
      throw new QuotaExhaustedError(
        `Configured daily request limit (TRANSLATION_RPD_LIMIT=${this.rpdLimit}) reached for ${this.provider}/${this.model}. Pausing job safely.`,
        { provider: this.provider, model: this.model }
      )
    }
    const dayTokensUsed = this.dayWindow.reduce((acc, e) => acc + e.tokens, 0)
    if (
      this.tpdLimit > 0 &&
      dayTokensUsed + estimatedTokens > this.tpdLimit &&
      dayTokensUsed > 0
    ) {
      throw new QuotaExhaustedError(
        `Configured daily token limit (TRANSLATION_TPD_LIMIT=${this.tpdLimit}, used=${dayTokensUsed}) reached for ${this.provider}/${this.model}. Pausing job safely.`,
        { provider: this.provider, model: this.model }
      )
    }

    // 2. Respect provider Retry-After cooldown if active
    if (this.cooldownUntilMs > Date.now()) {
      const waitMs = this.cooldownUntilMs - Date.now()
      if (waitMs > 0) {
        logger?.info(
          `Waiting ${Math.ceil(waitMs / 1000)}s for AI provider rate-limit cooldown...`
        )
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }

    // 3. Check per-minute RPM / TPM sliding window
    for (let guard = 0; guard < 5; guard++) {
      const currentNow = Date.now()
      this.prune(currentNow)

      const minuteReqs = this.minuteWindow.length
      const minuteTokens = this.minuteWindow.reduce(
        (acc, e) => acc + e.tokens,
        0
      )

      const rpmExceeded = this.rpmLimit > 0 && minuteReqs >= this.rpmLimit
      const tpmExceeded =
        this.tpmLimit > 0 &&
        minuteTokens + estimatedTokens > this.tpmLimit &&
        minuteTokens > 0

      if (!rpmExceeded && !tpmExceeded) {
        break
      }

      const oldestTs = this.minuteWindow[0]?.ts || currentNow
      const sleepMs = Math.max(250, oldestTs + 60_050 - currentNow)
      logger?.info(
        `Pacing AI request to stay within per-minute rate limit (${rpmExceeded ? `RPM ${minuteReqs}/${this.rpmLimit}` : `TPM ${minuteTokens}/${this.tpmLimit}`}); waiting ${Math.ceil(sleepMs / 1000)}s...`
      )
      await new Promise((r) => setTimeout(r, sleepMs))
    }

    const recordTs = Date.now()
    this.minuteWindow.push({ ts: recordTs, tokens: estimatedTokens })
    this.dayWindow.push({ ts: recordTs, tokens: estimatedTokens })
  }

  recordActualUsage(estimatedTokens: number, actualTotalTokens: number): void {
    if (actualTotalTokens <= 0) return
    const delta = actualTotalTokens - estimatedTokens
    const lastMinute = this.minuteWindow[this.minuteWindow.length - 1]
    if (lastMinute) {
      lastMinute.tokens = Math.max(1, lastMinute.tokens + delta)
    }
    const lastDay = this.dayWindow[this.dayWindow.length - 1]
    if (lastDay) {
      lastDay.tokens = Math.max(1, lastDay.tokens + delta)
    }
  }

  applyHeadersCooldown(headers: Headers): void {
    const retryAfterMs = parseDurationHeaderMs(headers.get('retry-after'))
    if (retryAfterMs > 0 && retryAfterMs <= 10 * 60 * 1000) {
      this.cooldownUntilMs = Math.max(
        this.cooldownUntilMs,
        Date.now() + retryAfterMs
      )
      return
    }

    const remReqs = headers.get('x-ratelimit-remaining-requests')
    const resetReqsMs = parseDurationHeaderMs(
      headers.get('x-ratelimit-reset-requests')
    )
    if (remReqs !== null && Number(remReqs) <= 1 && resetReqsMs > 0 && resetReqsMs <= 60_000) {
      this.cooldownUntilMs = Math.max(
        this.cooldownUntilMs,
        Date.now() + resetReqsMs
      )
    }

    const remTokens = headers.get('x-ratelimit-remaining-tokens')
    const resetTokensMs = parseDurationHeaderMs(
      headers.get('x-ratelimit-reset-tokens')
    )
    if (
      remTokens !== null &&
      Number(remTokens) <= 250 &&
      resetTokensMs > 0 &&
      resetTokensMs <= 60_000
    ) {
      this.cooldownUntilMs = Math.max(
        this.cooldownUntilMs,
        Date.now() + resetTokensMs
      )
    }
  }
}

/**
 * Executes a fetch request with an AbortController timeout so hanging AI API requests
 * are genuinely aborted rather than left running in the background.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label = 'AI API request'
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    })
  } catch (err) {
    const isAbort =
      timedOut || (err instanceof Error && err.name === 'AbortError')
    if (isAbort) {
      const timeoutErr = new Error(
        `${label} timed out after ${timeoutMs}ms`
      ) as HttpError
      timeoutErr.code = 'AI_REQUEST_TIMEOUT'
      timeoutErr.isRetryable = true
      throw timeoutErr
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export interface CreateAiProviderOptions {
  aiAdapter?: AiProviderAdapter
  fetchImpl?: typeof fetch
  aiTimeoutMs?: number
  rateLimiter?: ProviderRateLimiter
  logger?: WorkerLogger
}

/**
 * Built-in multi-provider AI adapter supporting:
 * - Groq (`https://api.groq.com/openai/v1`)
 * - OpenRouter (`https://openrouter.ai/api/v1`)
 * - OpenAI & OpenAI-compatible APIs (OpenAI, DeepSeek, Ollama, etc.)
 * - Google Gemini API (`generateContent`)
 * - Anthropic Messages API
 */
export function createAiProviderAdapter(
  config: Partial<TranslationConfig>,
  options: CreateAiProviderOptions = {}
): AiProviderAdapter {
  if (typeof options.aiAdapter === 'function') {
    return options.aiAdapter
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch
  const provider = (config.aiProvider || 'openai').toLowerCase()
  const baseUrl = (config.aiBaseUrl || '').replace(/\/+$/, '')
  const apiKey = config.aiApiKey || ''
  const model = config.aiModel || 'gpt-4o-mini'
  const maxOutputTokensCap = Math.max(
    256,
    Number(config.maxOutputTokens || 4096)
  )
  const disableReasoning = config.disableReasoning !== false
  const aiTimeoutMs = Math.max(
    1000,
    Number(
      options.aiTimeoutMs ??
        config.aiTimeoutMs ??
        process.env.TRANSLATION_AI_TIMEOUT_MS ??
        120000
    ) || 120000
  )

  return async function callAiModel({
    systemPrompt,
    userPrompt,
    estimatedOutputTokens,
  }): Promise<AiProviderStructuredResponse> {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Global fetch is unavailable for AI API requests')
    }

    const boundedMaxTokens = Math.min(
      maxOutputTokensCap,
      Math.max(512, Number(estimatedOutputTokens || 2048))
    )

    // 1. Native Google Gemini API
    if (
      (provider === 'gemini' || provider === 'google') &&
      !baseUrl.includes('/openai')
    ) {
      const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`
      const generationConfig: Record<string, unknown> = {
        temperature: 0.1,
        maxOutputTokens: boundedMaxTokens,
        responseMimeType: 'application/json',
      }
      if (disableReasoning && model.includes('2.5')) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 }
      }

      const res = await fetchWithTimeout(
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: [
              {
                role: 'user',
                parts: [{ text: userPrompt }],
              },
            ],
            generationConfig,
          }),
        },
        aiTimeoutMs,
        'Gemini API request'
      )

      options.rateLimiter?.applyHeadersCooldown(res.headers)

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        const quotaCheck = detectDailyQuotaExhaustionFromResponse(
          res.status,
          errBody,
          res.headers
        )
        if (quotaCheck.isExhausted) {
          throw new QuotaExhaustedError(quotaCheck.reason, {
            provider,
            model,
            status: res.status,
          })
        }
        const err = new Error(
          `Gemini API error (${res.status}): ${errBody.slice(0, 300)}`
        ) as HttpError
        err.status = res.status
        err.isRetryable =
          res.status === 429 || res.status >= 500 || res.status === 408
        throw err
      }

      const data = (await res.json()) as {
        candidates?: Array<{
          finishReason?: string
          content?: { parts?: Array<{ text?: string }> }
        }>
        usageMetadata?: {
          promptTokenCount?: number
          candidatesTokenCount?: number
          totalTokenCount?: number
        }
      }
      const finishReason = data?.candidates?.[0]?.finishReason || ''
      if (finishReason === 'MAX_TOKENS') {
        const truncErr = new Error(
          `Gemini output truncated at maxOutputTokens (${boundedMaxTokens})`
        ) as HttpError
        truncErr.isTruncated = true
        truncErr.isRetryable = false
        throw truncErr
      }

      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || '')
          .join('') || ''
      return {
        __isStructuredAiResponse: true,
        data: extractJsonFromModelText(text),
        finishReason,
        usage: {
          inputTokens: Number(data?.usageMetadata?.promptTokenCount || 0),
          outputTokens: Number(data?.usageMetadata?.candidatesTokenCount || 0),
          totalTokens: Number(data?.usageMetadata?.totalTokenCount || 0),
        },
      }
    }

    // 2. Native Anthropic Messages API
    if (
      (provider === 'anthropic' || provider === 'claude') &&
      !baseUrl.includes('/openai')
    ) {
      const endpoint = baseUrl.endsWith('/messages')
        ? baseUrl
        : `${baseUrl}/messages`
      const res = await fetchWithTimeout(
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: boundedMaxTokens,
            temperature: 0.1,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        },
        aiTimeoutMs,
        'Anthropic API request'
      )

      options.rateLimiter?.applyHeadersCooldown(res.headers)

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        const quotaCheck = detectDailyQuotaExhaustionFromResponse(
          res.status,
          errBody,
          res.headers
        )
        if (quotaCheck.isExhausted) {
          throw new QuotaExhaustedError(quotaCheck.reason, {
            provider,
            model,
            status: res.status,
          })
        }
        const err = new Error(
          `Anthropic API error (${res.status}): ${errBody.slice(0, 300)}`
        ) as HttpError
        err.status = res.status
        err.isRetryable =
          res.status === 429 || res.status >= 500 || res.status === 408
        throw err
      }

      const data = (await res.json()) as {
        stop_reason?: string
        content?: Array<{ type?: string; text?: string }>
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      if (data?.stop_reason === 'max_tokens') {
        const truncErr = new Error(
          `Anthropic output truncated at max_tokens (${boundedMaxTokens})`
        ) as HttpError
        truncErr.isTruncated = true
        truncErr.isRetryable = false
        throw truncErr
      }

      const text = (data?.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '')
        .join('')
      const inTok = Number(data?.usage?.input_tokens || 0)
      const outTok = Number(data?.usage?.output_tokens || 0)
      return {
        __isStructuredAiResponse: true,
        data: extractJsonFromModelText(text),
        finishReason: data?.stop_reason,
        usage: {
          inputTokens: inTok,
          outputTokens: outTok,
          totalTokens: inTok + outTok,
        },
      }
    }

    // 3. OpenAI & OpenAI-compatible Chat Completions API (Groq, OpenRouter, OpenAI, DeepSeek)
    const endpoint = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl}/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    const isQwen3Model = /qwen3/i.test(model)

    async function sendChatRequest(
      useJsonFormat = true,
      includeReasoningControl = disableReasoning
    ): Promise<Response> {
      const body: Record<string, unknown> = {
        model,
        temperature: 0.1,
        max_tokens: boundedMaxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
      }

      if (includeReasoningControl) {
        if (provider === 'groq' && isQwen3Model) {
          body.reasoning_effort = 'none'
        } else if (provider === 'openrouter' && isQwen3Model) {
          body.reasoning = { effort: 'none', exclude: true }
        }
      }

      return fetchWithTimeout(
        fetchImpl,
        endpoint,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        aiTimeoutMs,
        `${provider.toUpperCase()} API request`
      )
    }

    let res = await sendChatRequest(true, disableReasoning)
    if (res.status === 400) {
      // Fallback 1: retry without provider-specific reasoning flag
      if (disableReasoning && isQwen3Model) {
        const retryNoReasoning = await sendChatRequest(true, false)
        if (retryNoReasoning.ok || retryNoReasoning.status !== 400) {
          res = retryNoReasoning
        }
      }
      // Fallback 2: retry without response_format: json_object if model doesn't support JSON mode
      if (res.status === 400) {
        const retryPlain = await sendChatRequest(false, false)
        if (retryPlain.ok) {
          res = retryPlain
        }
      }
    }

    options.rateLimiter?.applyHeadersCooldown(res.headers)

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      const quotaCheck = detectDailyQuotaExhaustionFromResponse(
        res.status,
        errBody,
        res.headers
      )
      if (quotaCheck.isExhausted) {
        throw new QuotaExhaustedError(quotaCheck.reason, {
          provider,
          model,
          status: res.status,
        })
      }

      const lowerErr = errBody.toLowerCase()
      const isTokenLimitError =
        (res.status === 400 || res.status === 413) &&
        (lowerErr.includes('context_length_exceeded') ||
          lowerErr.includes('maximum context length') ||
          lowerErr.includes('request too large') ||
          lowerErr.includes('max_tokens'))

      const err = new Error(
        `AI API error (${res.status}): ${errBody.slice(0, 300)}`
      ) as HttpError
      err.status = res.status
      err.isTokenLimitError = isTokenLimitError
      err.isRetryable =
        !isTokenLimitError &&
        (res.status === 429 || res.status >= 500 || res.status === 408)
      throw err
    }

    const data = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string
        message?: { content?: string }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      }
    }
    const finishReason = data?.choices?.[0]?.finish_reason || ''
    if (finishReason === 'length') {
      const truncErr = new Error(
        `AI output truncated (finish_reason="length", max_tokens=${boundedMaxTokens})`
      ) as HttpError
      truncErr.isTruncated = true
      truncErr.isRetryable = false
      throw truncErr
    }

    const content = data?.choices?.[0]?.message?.content || ''
    const inTok = Number(data?.usage?.prompt_tokens || 0)
    const outTok = Number(data?.usage?.completion_tokens || 0)
    const totTok = Number(data?.usage?.total_tokens || inTok + outTok)

    return {
      __isStructuredAiResponse: true,
      data: extractJsonFromModelText(content),
      finishReason,
      usage: {
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: totTok,
      },
    }
  }
}

export interface TranslateManifestOptions extends CreateAiProviderOptions {
  config?: TranslationConfig
  logger?: WorkerLogger
  batchSize?: number
  maxBatchChars?: number
  maxInputTokensPerBatch?: number
  concurrency?: number
  maxRetries?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
  allowBatchSplit?: boolean
  useSegmentCache?: boolean
}

function isStructuredAiResponse(
  val: unknown
): val is AiProviderStructuredResponse {
  return Boolean(
    val &&
      typeof val === 'object' &&
      (val as AiProviderStructuredResponse).__isStructuredAiResponse === true
  )
}

/**
 * Translates all items in a translation manifest into `targetLocale` (default: 'vi')
 * using ServiceNow terminology protection, persistent segment-level caching,
 * compact key-value batching, adaptive batch splitting, and rate/quota awareness.
 */
export async function translateManifest(
  manifest: TranslationManifest | TranslationItem[],
  targetLocale = 'vi',
  options: TranslateManifestOptions = {}
): Promise<TranslateManifestResult> {
  const config = options.config || getTranslationConfig({ targetLocale })
  const logger = options.logger || defaultLogger
  const maxRetries = options.maxRetries ?? 3
  const initialRetryDelayMs = options.initialRetryDelayMs ?? 500
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30000
  const useSegmentCache =
    options.useSegmentCache ?? typeof options.aiAdapter !== 'function'

  const items = Array.isArray((manifest as TranslationManifest)?.items)
    ? (manifest as TranslationManifest).items
    : Array.isArray(manifest)
      ? manifest
      : []

  const translationsById = new Map<string, string>()
  const issues: string[] = []
  let retryCount = 0

  const usageStats: TranslationUsageStats = {
    provider: config.aiProvider || 'openai',
    model: config.aiModel || 'unknown',
    apiRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedSegments: 0,
    skippedTechnicalSegments: 0,
    translatedSegments: 0,
    failedBatches: 0,
    estimatedCostUsd: null,
  }

  if (items.length === 0) {
    return {
      targetLocale,
      translationsById,
      translations: {},
      stats: {
        totalRequested: 0,
        totalTranslated: 0,
        batchCount: 0,
        retryCount: 0,
        usage: usageStats,
      },
      issues,
    }
  }

  const { hash: glossaryHash } = loadServiceNowGlossary({
    glossaryFilePath: config.glossaryFilePath,
    customProtectedTerms: config.customProtectedTerms,
  })

  const protectedByItemId = new Map<string, ProtectedTextResult>()
  const cacheKeyByItemId = new Map<string, string>()
  const itemsToTranslate: TranslationItem[] = []

  // Step 1: Pre-filter 100%-technical segments and segment-cache hits
  for (const item of items) {
    const prot = protectServiceNowTerminology(item.text, {
      glossaryFilePath: config.glossaryFilePath,
      customProtectedTerms: config.customProtectedTerms,
    })
    protectedByItemId.set(item.id, prot)

    if (prot.isFullyProtected) {
      translationsById.set(item.id, item.text)
      usageStats.skippedTechnicalSegments += 1
      continue
    }

    const fullBlock = (item.context?.fullBlockText || '').trim()
    const trimmedText = (item.text || '').trim()
    const contextKey =
      fullBlock && fullBlock !== trimmedText ? fullBlock.slice(0, 200) : ''

    const segCacheKey = computeSegmentCacheKey({
      text: trimmedText,
      sourceLocale: config.sourceLocale || 'en',
      targetLocale,
      promptVersion: PROMPT_VERSION,
      glossaryHash,
      contextKey,
    })
    cacheKeyByItemId.set(item.id, segCacheKey)

    if (useSegmentCache) {
      const cachedTranslated = getCachedSegmentTranslation(
        segCacheKey,
        targetLocale,
        config
      )
      if (cachedTranslated !== null) {
        translationsById.set(
          item.id,
          preserveBoundaryWhitespace(item, cachedTranslated)
        )
        usageStats.cachedSegments += 1
        continue
      }
    }

    itemsToTranslate.push(item)
  }

  if (itemsToTranslate.length === 0) {
    const translations = Object.fromEntries(translationsById.entries())
    return {
      targetLocale,
      translationsById,
      translations,
      stats: {
        totalRequested: items.length,
        totalTranslated: translationsById.size,
        batchCount: 0,
        retryCount: 0,
        usage: usageStats,
      },
      issues,
    }
  }

  const rateLimiter =
    options.rateLimiter || new ProviderRateLimiter(config)
  const adapter = createAiProviderAdapter(config, {
    ...options,
    rateLimiter,
    logger,
  })
  const systemPrompt = buildSystemPrompt(targetLocale, config.glossary)
  const batches = createTranslationBatches(itemsToTranslate, {
    batchSize: options.batchSize ?? config.batchSize,
    maxBatchChars: options.maxBatchChars ?? config.maxBatchChars,
    maxInputTokensPerBatch:
      options.maxInputTokensPerBatch ?? config.maxInputTokensPerBatch,
  })

  async function translateSingleBatch(
    batchItems: TranslationItem[],
    batchLabel: string
  ): Promise<void> {
    let lastErrorReason: string | null = null
    let nonRetryableFailure: HttpError | null = null
    let quotaError: QuotaExhaustedError | null = null
    let shouldSplitImmediately = false

    try {
      await pRetry(
        async (attemptNumber) => {
          const attemptIdx = attemptNumber - 1
          try {
            const promptInfo = buildCompactBatchPrompt(
              batchItems,
              protectedByItemId,
              attemptIdx > 0 ? lastErrorReason : null
            )

            const estimatedTotalTokens =
              promptInfo.estimatedInputTokens + promptInfo.estimatedOutputTokens
            await rateLimiter.acquire(estimatedTotalTokens, logger)

            usageStats.apiRequests += 1
            const rawResult = await adapter({
              systemPrompt,
              userPrompt: promptInfo.userPrompt,
              batchItems,
              targetLocale,
              attempt: attemptIdx,
              estimatedOutputTokens: promptInfo.estimatedOutputTokens,
            })

            let modelPayload: unknown = rawResult
            let tokenUsage: AiProviderTokenUsage | undefined
            if (isStructuredAiResponse(rawResult)) {
              modelPayload = rawResult.data
              tokenUsage = rawResult.usage
            }

            const inTokens =
              tokenUsage?.inputTokens && tokenUsage.inputTokens > 0
                ? tokenUsage.inputTokens
                : promptInfo.estimatedInputTokens
            const outTokens =
              tokenUsage?.outputTokens && tokenUsage.outputTokens > 0
                ? tokenUsage.outputTokens
                : estimateTokenCount(JSON.stringify(modelPayload || ''))
            const totTokens =
              tokenUsage?.totalTokens && tokenUsage.totalTokens > 0
                ? tokenUsage.totalTokens
                : inTokens + outTokens

            usageStats.inputTokens += inTokens
            usageStats.outputTokens += outTokens
            usageStats.totalTokens += totTokens
            rateLimiter.recordActualUsage(estimatedTotalTokens, totTokens)

            const parsed =
              typeof modelPayload === 'string'
                ? extractJsonFromModelText(modelPayload)
                : modelPayload
            const validation = validateBatchTranslationResponse(
              batchItems,
              parsed,
              {
                shortKeyToItemId: promptInfo.shortKeyToItemId,
                protectedByItemId: promptInfo.protectedByItemId,
              }
            )

            if (!validation.valid) {
              lastErrorReason = validation.error
              throw new Error(validation.error)
            }

            const newCacheEntries: Array<{
              cacheKey: string
              translatedText: string
              targetLocale: string
            }> = []

            for (const item of batchItems) {
              const rawTranslated = validation.returnedMap.get(item.id) || ''
              const prot = promptInfo.protectedByItemId.get(item.id)
              const restoredTranslated = prot
                ? restoreServiceNowTerminology(rawTranslated, prot.placeholders)
                : rawTranslated
              const cleanTranslated = preserveBoundaryWhitespace(
                item,
                restoredTranslated
              )
              translationsById.set(item.id, cleanTranslated)
              usageStats.translatedSegments += 1

              const segCacheKey = cacheKeyByItemId.get(item.id)
              if (useSegmentCache && segCacheKey && restoredTranslated.trim()) {
                newCacheEntries.push({
                  cacheKey: segCacheKey,
                  translatedText: restoredTranslated.trim(),
                  targetLocale,
                })
              }
            }

            if (newCacheEntries.length > 0) {
              recordCachedSegmentTranslations(newCacheEntries, config)
            }
          } catch (err) {
            lastErrorReason = err instanceof Error ? err.message : String(err)
            if (isQuotaExhaustedError(err)) {
              quotaError = err
              throw new AbortError(err)
            }
            if (
              isSplitEligibleError(err) &&
              batchItems.length > 1 &&
              options.allowBatchSplit !== false
            ) {
              shouldSplitImmediately = true
              throw new AbortError(
                err instanceof Error ? err : new Error(lastErrorReason)
              )
            }
            if (!isRetryableAiError(err)) {
              nonRetryableFailure = err as HttpError
              throw new AbortError(
                err instanceof Error ? err : new Error(lastErrorReason)
              )
            }
            throw err
          }
        },
        {
          retries: maxRetries,
          minTimeout: initialRetryDelayMs,
          maxTimeout: maxRetryDelayMs,
          factor: 2,
          onFailedAttempt: (ctx) => {
            if (nonRetryableFailure || quotaError || shouldSplitImmediately) {
              return
            }
            retryCount += 1
            logger.warn(
              `Retrying AI translation batch ${batchLabel} (attempt ${ctx.attemptNumber}/${maxRetries + 1})`,
              { reason: lastErrorReason }
            )
          },
        }
      )
      return
    } catch {
      if (quotaError) {
        throw quotaError
      }
      if (nonRetryableFailure && !shouldSplitImmediately) {
        usageStats.failedBatches += 1
        const errorMessage = `Translation batch ${batchLabel} failed with non-recoverable error: ${lastErrorReason}`
        issues.push(errorMessage)
        const fatalErr = new Error(errorMessage) as HttpError & {
          issues?: string[]
        }
        fatalErr.status = (nonRetryableFailure as HttpError).status
        fatalErr.isRetryable = false
        fatalErr.issues = issues
        throw fatalErr
      }
    }

    if (batchItems.length > 1 && options.allowBatchSplit !== false) {
      const mid = Math.ceil(batchItems.length / 2)
      const left = batchItems.slice(0, mid)
      const right = batchItems.slice(mid)
      const splitReason = shouldSplitImmediately
        ? `Batch ${batchLabel} exceeded token/output limit (${lastErrorReason}); splitting into sub-batches of ${left.length} and ${right.length}.`
        : `Batch ${batchLabel} failed after ${maxRetries + 1} attempts (${lastErrorReason}); splitting into sub-batches of ${left.length} and ${right.length}.`
      issues.push(splitReason)
      logger.warn(splitReason)
      await translateSingleBatch(left, `${batchLabel}a`)
      await translateSingleBatch(right, `${batchLabel}b`)
      return
    }

    usageStats.failedBatches += 1
    const errorMessage = `Translation batch ${batchLabel} failed after ${maxRetries + 1} attempts: ${lastErrorReason}`
    issues.push(errorMessage)
    const err = new Error(errorMessage) as Error & { issues?: string[] }
    err.issues = issues
    throw err
  }

  const concurrency = Math.max(
    1,
    Number(options.concurrency ?? config.concurrency ?? 1)
  )
  let nextIndex = 0

  async function workerLoop(): Promise<void> {
    while (nextIndex < batches.length) {
      const currentIdx = nextIndex++
      const batch = batches[currentIdx]
      if (batch) {
        await translateSingleBatch(batch, `${currentIdx + 1}/${batches.length}`)
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, batches.length) },
    () => workerLoop()
  )
  await Promise.all(workers)

  if (config.inputCostPer1M > 0 || config.outputCostPer1M > 0) {
    const inCost =
      (usageStats.inputTokens / 1_000_000) * (config.inputCostPer1M || 0)
    const outCost =
      (usageStats.outputTokens / 1_000_000) * (config.outputCostPer1M || 0)
    usageStats.estimatedCostUsd = Number((inCost + outCost).toFixed(6))
  }

  const translations = Object.fromEntries(translationsById.entries())

  return {
    targetLocale,
    translationsById,
    translations,
    stats: {
      totalRequested: items.length,
      totalTranslated: translationsById.size,
      batchCount: batches.length,
      retryCount,
      usage: usageStats,
    },
    issues,
  }
}
