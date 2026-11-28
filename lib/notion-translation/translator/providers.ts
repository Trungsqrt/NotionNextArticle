import type { TranslationConfig } from '../config'
import type {
  AiProviderAdapter,
  AiProviderStructuredResponse,
  AiProviderTokenUsage,
  WorkerLogger,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import {
  QuotaExhaustedError,
  detectDailyQuotaExhaustionFromResponse,
  type HttpError,
} from './errors'
import type { ProviderRateLimiter } from './rate-limiter'
import {
  logReasoningCapabilityWarningOnce,
  resolveModelReasoningCapability,
  type ModelReasoningCapability,
} from './reasoning'
import { extractJsonFromModelText } from './response-parser'

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

interface ProviderRequestContext {
  fetchImpl: typeof fetch
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  aiTimeoutMs: number
  reasoningCap: ModelReasoningCapability
  rateLimiter?: ProviderRateLimiter
  systemPrompt: string
  userPrompt: string
  boundedMaxTokens: number
}

function buildTruncatedOutputError(params: {
  message: string
  boundedMaxTokens: number
  rawModelText: string
  usage: AiProviderTokenUsage
  provider: string
  model: string
}): HttpError {
  const truncErr = new Error(params.message) as HttpError
  truncErr.isTruncated = true
  truncErr.isRetryable = false
  truncErr.maxTokensUsed = params.boundedMaxTokens
  truncErr.rawModelText = params.rawModelText
  truncErr.tokenUsage = params.usage
  truncErr.provider = params.provider
  truncErr.model = params.model
  return truncErr
}

async function callGeminiApi(
  ctx: ProviderRequestContext
): Promise<AiProviderStructuredResponse> {
  const endpoint = `${ctx.baseUrl}/models/${encodeURIComponent(ctx.model)}:generateContent`
  const generationConfig: Record<string, unknown> = {
    temperature: 0.1,
    maxOutputTokens: ctx.boundedMaxTokens,
    responseMimeType: 'application/json',
  }
  if (ctx.reasoningCap.mode === 'disabled_via_thinking_budget_zero') {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }

  const res = await fetchWithTimeout(
    ctx.fetchImpl,
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': ctx.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: ctx.systemPrompt }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: ctx.userPrompt }],
          },
        ],
        generationConfig,
      }),
    },
    ctx.aiTimeoutMs,
    'Gemini API request'
  )

  ctx.rateLimiter?.applyHeadersCooldown(res.headers)

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const quotaCheck = detectDailyQuotaExhaustionFromResponse(
      res.status,
      errBody,
      res.headers
    )
    if (quotaCheck.isExhausted) {
      throw new QuotaExhaustedError(quotaCheck.reason, {
        provider: ctx.provider,
        model: ctx.model,
        status: res.status,
      })
    }
    const err = new Error(
      `Gemini API error (${res.status}): ${errBody.slice(0, 300)}`
    ) as HttpError
    err.status = res.status
    err.provider = ctx.provider
    err.model = ctx.model
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
      thoughtsTokenCount?: number
    }
  }
  const finishReason = data?.candidates?.[0]?.finishReason || ''
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ||
    ''
  const usage: AiProviderTokenUsage = {
    inputTokens: Number(data?.usageMetadata?.promptTokenCount || 0),
    outputTokens: Number(data?.usageMetadata?.candidatesTokenCount || 0),
    totalTokens: Number(data?.usageMetadata?.totalTokenCount || 0),
    reasoningTokens: Number(data?.usageMetadata?.thoughtsTokenCount || 0),
  }

  if (finishReason === 'MAX_TOKENS') {
    try {
      const parsedComplete = extractJsonFromModelText(text)
      return {
        __isStructuredAiResponse: true,
        data: parsedComplete,
        rawText: text,
        finishReason,
        maxOutputTokensUsed: ctx.boundedMaxTokens,
        usage,
      }
    } catch {
      throw buildTruncatedOutputError({
        message: `Gemini output truncated (finishReason="MAX_TOKENS", maxOutputTokens=${ctx.boundedMaxTokens})`,
        boundedMaxTokens: ctx.boundedMaxTokens,
        rawModelText: text,
        usage,
        provider: ctx.provider,
        model: ctx.model,
      })
    }
  }

  return {
    __isStructuredAiResponse: true,
    data: extractJsonFromModelText(text),
    rawText: text,
    finishReason,
    maxOutputTokensUsed: ctx.boundedMaxTokens,
    usage,
  }
}

async function callAnthropicApi(
  ctx: ProviderRequestContext
): Promise<AiProviderStructuredResponse> {
  const endpoint = ctx.baseUrl.endsWith('/messages')
    ? ctx.baseUrl
    : `${ctx.baseUrl}/messages`
  const res = await fetchWithTimeout(
    ctx.fetchImpl,
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ctx.model,
        max_tokens: ctx.boundedMaxTokens,
        temperature: 0.1,
        system: ctx.systemPrompt,
        messages: [{ role: 'user', content: ctx.userPrompt }],
      }),
    },
    ctx.aiTimeoutMs,
    'Anthropic API request'
  )

  ctx.rateLimiter?.applyHeadersCooldown(res.headers)

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const quotaCheck = detectDailyQuotaExhaustionFromResponse(
      res.status,
      errBody,
      res.headers
    )
    if (quotaCheck.isExhausted) {
      throw new QuotaExhaustedError(quotaCheck.reason, {
        provider: ctx.provider,
        model: ctx.model,
        status: res.status,
      })
    }
    const err = new Error(
      `Anthropic API error (${res.status}): ${errBody.slice(0, 300)}`
    ) as HttpError
    err.status = res.status
    err.provider = ctx.provider
    err.model = ctx.model
    err.isRetryable =
      res.status === 429 || res.status >= 500 || res.status === 408
    throw err
  }

  const data = (await res.json()) as {
    stop_reason?: string
    content?: Array<{ type?: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text = (data?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('')
  const inTok = Number(data?.usage?.input_tokens || 0)
  const outTok = Number(data?.usage?.output_tokens || 0)
  const usage: AiProviderTokenUsage = {
    inputTokens: inTok,
    outputTokens: outTok,
    totalTokens: inTok + outTok,
  }

  if (data?.stop_reason === 'max_tokens') {
    try {
      const parsedComplete = extractJsonFromModelText(text)
      return {
        __isStructuredAiResponse: true,
        data: parsedComplete,
        rawText: text,
        finishReason: data.stop_reason,
        maxOutputTokensUsed: ctx.boundedMaxTokens,
        usage,
      }
    } catch {
      throw buildTruncatedOutputError({
        message: `Anthropic output truncated (stop_reason="max_tokens", max_tokens=${ctx.boundedMaxTokens})`,
        boundedMaxTokens: ctx.boundedMaxTokens,
        rawModelText: text,
        usage,
        provider: ctx.provider,
        model: ctx.model,
      })
    }
  }

  return {
    __isStructuredAiResponse: true,
    data: extractJsonFromModelText(text),
    rawText: text,
    finishReason: data?.stop_reason,
    maxOutputTokensUsed: ctx.boundedMaxTokens,
    usage,
  }
}

async function callOpenAiCompatibleApi(
  ctx: ProviderRequestContext
): Promise<AiProviderStructuredResponse> {
  const endpoint = ctx.baseUrl.endsWith('/chat/completions')
    ? ctx.baseUrl
    : `${ctx.baseUrl}/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (ctx.apiKey) {
    headers.Authorization = `Bearer ${ctx.apiKey}`
  }

  async function sendChatRequest(
    useJsonFormat = true,
    includeReasoningControl = true
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: ctx.model,
      temperature: 0.1,
      max_tokens: ctx.boundedMaxTokens,
      messages: [
        { role: 'system', content: ctx.systemPrompt },
        { role: 'user', content: ctx.userPrompt },
      ],
      ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
    }

    if (includeReasoningControl) {
      if (ctx.reasoningCap.mode === 'disabled_via_effort_none') {
        body.reasoning_effort = 'none'
      } else if (ctx.reasoningCap.mode === 'disabled_via_openrouter_reasoning') {
        body.reasoning = { effort: 'none', exclude: true }
      } else if (
        ctx.provider === 'openrouter' &&
        ctx.reasoningCap.mode === 'always_on_cannot_disable'
      ) {
        // On OpenRouter always-on reasoning models, exclude reasoning text from message.content
        // without sending unsupported effort="none"
        body.reasoning = { exclude: true }
      }
    }

    return fetchWithTimeout(
      ctx.fetchImpl,
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      ctx.aiTimeoutMs,
      `${ctx.provider.toUpperCase()} API request`
    )
  }

  let res = await sendChatRequest(true, true)
  if (res.status === 400) {
    // Fallback 1: retry without provider-specific reasoning parameter
    if (ctx.reasoningCap.isReasoningModel) {
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

  ctx.rateLimiter?.applyHeadersCooldown(res.headers)

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const quotaCheck = detectDailyQuotaExhaustionFromResponse(
      res.status,
      errBody,
      res.headers
    )
    if (quotaCheck.isExhausted) {
      throw new QuotaExhaustedError(quotaCheck.reason, {
        provider: ctx.provider,
        model: ctx.model,
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
    err.provider = ctx.provider
    err.model = ctx.model
    err.isTokenLimitError = isTokenLimitError
    err.isRetryable =
      !isTokenLimitError &&
      (res.status === 429 || res.status >= 500 || res.status === 408)
    throw err
  }

  const data = (await res.json()) as {
    choices?: Array<{
      finish_reason?: string
      native_finish_reason?: string
      message?: { content?: string; reasoning?: string }
    }>
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
      completion_tokens_details?: { reasoning_tokens?: number }
    }
  }
  const finishReason =
    data?.choices?.[0]?.finish_reason ||
    data?.choices?.[0]?.native_finish_reason ||
    ''
  const content = data?.choices?.[0]?.message?.content || ''
  const inTok = Number(data?.usage?.prompt_tokens || 0)
  const outTok = Number(data?.usage?.completion_tokens || 0)
  const totTok = Number(data?.usage?.total_tokens || inTok + outTok)
  const reasoningTok = Number(
    data?.usage?.completion_tokens_details?.reasoning_tokens || 0
  )

  const usage: AiProviderTokenUsage = {
    inputTokens: inTok,
    outputTokens: outTok,
    totalTokens: totTok,
    ...(reasoningTok > 0 ? { reasoningTokens: reasoningTok } : {}),
  }

  if (finishReason === 'length' || finishReason === 'max_tokens') {
    // First check if the model actually finished emitting valid JSON right at the limit
    if (content.trim()) {
      try {
        const parsedComplete = extractJsonFromModelText(content)
        return {
          __isStructuredAiResponse: true,
          data: parsedComplete,
          rawText: content,
          finishReason,
          maxOutputTokensUsed: ctx.boundedMaxTokens,
          usage,
        }
      } catch {
        // Proceed to structured truncation handling
      }
    }

    const reasoningNote =
      reasoningTok > 0 ? `, reasoning_tokens=${reasoningTok}` : ''
    throw buildTruncatedOutputError({
      message: `AI output truncated (finish_reason="${finishReason}", max_tokens=${ctx.boundedMaxTokens}${reasoningNote})`,
      boundedMaxTokens: ctx.boundedMaxTokens,
      rawModelText: content,
      usage,
      provider: ctx.provider,
      model: ctx.model,
    })
  }

  return {
    __isStructuredAiResponse: true,
    data: extractJsonFromModelText(content),
    rawText: content,
    finishReason,
    maxOutputTokensUsed: ctx.boundedMaxTokens,
    usage,
  }
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
  const logger = options.logger || defaultLogger
  const provider = (config.aiProvider || 'openai').toLowerCase()
  const baseUrl = (config.aiBaseUrl || '').replace(/\/+$/, '')
  const apiKey = config.aiApiKey || ''
  const model = config.aiModel || 'gpt-4o-mini'
  const disableReasoning = config.disableReasoning !== false

  const reasoningCap = resolveModelReasoningCapability(
    provider,
    model,
    disableReasoning
  )
  logReasoningCapabilityWarningOnce(reasoningCap, logger)

  const minOutputTokens = Math.max(
    2048,
    Number(config.minOutputTokens || 2048),
    reasoningCap.mode === 'always_on_cannot_disable' ? 4096 : 2048
  )
  const maxOutputTokens = Math.max(
    minOutputTokens,
    Number(config.maxOutputTokens || 8192)
  )
  const outputSafetyMargin = Math.max(
    1.1,
    Number(config.outputTokenSafetyMargin || 1.8)
  )

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
    maxOutputTokensOverride,
  }): Promise<AiProviderStructuredResponse> {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Global fetch is unavailable for AI API requests')
    }

    const reasoningHeadroom =
      reasoningCap.mode === 'always_on_cannot_disable' &&
      estimatedOutputTokens &&
      estimatedOutputTokens > 0
        ? Math.max(1536, Math.ceil(estimatedOutputTokens * 0.65))
        : 0
    const estimatedWithMargin =
      estimatedOutputTokens && estimatedOutputTokens > 0
        ? Math.ceil(estimatedOutputTokens * outputSafetyMargin) +
          reasoningHeadroom
        : maxOutputTokens
    const requestedBudget =
      maxOutputTokensOverride && maxOutputTokensOverride > 0
        ? Math.max(maxOutputTokensOverride, estimatedWithMargin)
        : estimatedWithMargin

    const boundedMaxTokens = Math.min(
      maxOutputTokens,
      Math.max(minOutputTokens, requestedBudget)
    )

    const ctx: ProviderRequestContext = {
      fetchImpl,
      provider,
      baseUrl,
      apiKey,
      model,
      aiTimeoutMs,
      reasoningCap,
      rateLimiter: options.rateLimiter,
      systemPrompt,
      userPrompt,
      boundedMaxTokens,
    }

    // 1. Native Google Gemini API
    if (
      (provider === 'gemini' || provider === 'google') &&
      !baseUrl.includes('/openai')
    ) {
      return callGeminiApi(ctx)
    }

    // 2. Native Anthropic Messages API
    if (
      (provider === 'anthropic' || provider === 'claude') &&
      !baseUrl.includes('/openai')
    ) {
      return callAnthropicApi(ctx)
    }

    // 3. OpenAI & OpenAI-compatible Chat Completions API (Groq, OpenRouter, OpenAI, DeepSeek)
    return callOpenAiCompatibleApi(ctx)
  }
}
