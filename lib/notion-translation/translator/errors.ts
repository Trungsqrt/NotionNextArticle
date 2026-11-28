import type {
  AiProviderTokenUsage,
  TranslationFailureStage,
} from '../types'

export class QuotaExhaustedError extends Error {
  readonly code = 'AI_QUOTA_EXHAUSTED'
  readonly isQuotaExhausted = true
  readonly isRetryable = false
  readonly provider: string
  readonly model: string
  readonly status?: number
  readonly failureStage: TranslationFailureStage = 'AI Translation'

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

export interface HttpError extends Error {
  status?: number
  statusCode?: number
  code?: string
  isRetryable?: boolean
  isTruncated?: boolean
  isTokenLimitError?: boolean
  maxTokensUsed?: number
  rawModelText?: string
  tokenUsage?: AiProviderTokenUsage
  failureStage?: TranslationFailureStage
  provider?: string
  model?: string
}

export function isRetryableAiError(err: unknown): boolean {
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

export function isContextOrTokenLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if (isQuotaExhaustedError(err)) return false
  const e = err as HttpError
  if (e.isTokenLimitError) return true
  const msg = String(e.message || '').toLowerCase()
  return (
    msg.includes('maximum context length') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('request too large') ||
    msg.includes('tokens per minute')
  )
}

/**
 * Parses Retry-After / x-ratelimit-reset-* header values into milliseconds.
 * Supports plain seconds ("12"), Go-style durations ("1m30s", "500ms"), and HTTP dates.
 */
export function parseDurationHeaderMs(
  rawHeader: string | null | undefined
): number {
  if (!rawHeader) return 0
  const trimmed = rawHeader.trim()
  if (!trimmed) return 0

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.ceil(Number(trimmed) * 1000)
  }

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

/**
 * Distinguishes daily/credit quota exhaustion (non-retryable; pauses job safely)
 * from transient per-minute 429 rate limits (retryable after cooldown).
 */
export function detectDailyQuotaExhaustionFromResponse(
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

export function isTruncatedErrorReason(reason: string | null): boolean {
  if (!reason) return false
  return (
    reason.includes('finish_reason="length"') ||
    reason.includes('finish_reason="max_tokens"') ||
    reason.includes('finishReason="MAX_TOKENS"') ||
    reason.includes('stop_reason="max_tokens"')
  )
}
