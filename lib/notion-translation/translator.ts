import pRetry, { AbortError } from 'p-retry'
import { z } from 'zod'
import {
  getTranslationConfig,
  SERVICENOW_GLOSSARY,
  type TranslationConfig,
} from './config'
import type {
  AiProviderAdapter,
  GlossaryRule,
  TranslateManifestResult,
  TranslationItem,
  TranslationManifest,
  WorkerLogger,
} from './types'
import { defaultLogger } from '../../worker/logger'

const AiBatchTranslationResponseSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    })
  ),
})

export function buildSystemPrompt(
  targetLocale = 'vi',
  glossary: readonly GlossaryRule[] = SERVICENOW_GLOSSARY
): string {
  const glossaryLines = (glossary || SERVICENOW_GLOSSARY)
    .map((g) => `- "${g.term}": ${g.rule}`)
    .join('\n')

  return [
    `You are a senior technical translator specializing in enterprise IT Service Management (ITSM) and ServiceNow architecture documentation.`,
    `Translate the provided English text segments into professional, accurate Vietnamese (locale: "${targetLocale}").`,
    ``,
    `STRICT TRANSLATION RULES:`,
    `1. Do NOT translate code, inline code snippets, API names, class/method names, variable names, database table names (e.g. cmdb_ci, sys_user, incident), or field names (e.g. sys_id, short_description).`,
    `2. Do NOT alter URLs, paths, or markdown/code identifiers.`,
    `3. Do NOT summarize, shorten, omit sentences, or invent extra explanations. Preserve the exact technical meaning, tone, and level of detail.`,
    `4. Each item in the input array represents a specific rich-text run with a unique "id". Surrounding block text ("fullBlockText", "parentHeading", "articleTitle") is provided ONLY as context so you translate fragments accurately within their sentence.`,
    `5. Translate ONLY the "text" field of each item. Do NOT include the rest of "fullBlockText" if the item's "text" is only a phrase or fragment of that sentence.`,
    `6. Preserve leading or trailing spaces on "text" when present so adjacent formatted text runs join cleanly.`,
    ``,
    `MANDATORY SERVICENOW GLOSSARY:`,
    glossaryLines,
    ``,
    `OUTPUT FORMAT:`,
    `Return ONLY valid JSON matching this exact schema (no markdown fences, no commentary):`,
    `{"translations":[{"id":"<exact-input-id>","text":"<translated-vietnamese-text>"}]}`,
    `Every requested "id" MUST appear in "translations" exactly once.`,
  ].join('\n')
}

export function buildUserPrompt(
  batchItems: readonly TranslationItem[],
  contextMeta: { targetLocale?: string; articleTitle?: string } = {},
  retryReason: string | null = null
): string {
  const payload = {
    targetLocale: contextMeta.targetLocale || 'vi',
    articleTitle: contextMeta.articleTitle || '',
    items: batchItems.map((item) => ({
      id: item.id,
      blockType: item.blockType,
      text: item.text,
      context: {
        parentHeading: item.context?.parentHeading || '',
        fullBlockText: item.context?.fullBlockText || '',
      },
    })),
  }

  let prompt = JSON.stringify(payload, null, 2)
  if (retryReason) {
    prompt =
      `PREVIOUS ATTEMPT FAILED VALIDATION: ${retryReason}\n` +
      `Ensure you return valid JSON with {"translations":[{"id":"...","text":"..."}]} containing EVERY requested id (${batchItems.length} items) exactly once.\n\n` +
      prompt
  }
  return prompt
}

export function createTranslationBatches(
  items: readonly TranslationItem[],
  options: { batchSize?: number; maxBatchChars?: number } = {}
): TranslationItem[][] {
  const batchSize = Math.max(1, Number(options.batchSize) || 20)
  const maxBatchChars = Math.max(500, Number(options.maxBatchChars) || 6000)

  const batches: TranslationItem[][] = []
  let currentBatch: TranslationItem[] = []
  let currentChars = 0

  for (const item of items || []) {
    const itemChars =
      (item.text?.length || 0) + (item.context?.fullBlockText?.length || 0)
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= batchSize ||
        currentChars + itemChars > maxBatchChars)
    ) {
      batches.push(currentBatch)
      currentBatch = []
      currentChars = 0
    }
    currentBatch.push(item)
    currentChars += itemChars
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
  const trimmed = rawText.trim()

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
  parsed: unknown
):
  | { valid: true; returnedMap: Map<string, string> }
  | { valid: false; error: string } {
  const schemaCheck = AiBatchTranslationResponseSchema.safeParse(parsed)
  if (!schemaCheck.success) {
    const firstIssue = schemaCheck.error.issues[0]
    return {
      valid: false,
      error: `Invalid AI translation JSON schema: ${firstIssue?.message || 'missing translations array'}`,
    }
  }

  const expectedIds = new Set(batchItems.map((item) => item.id))
  const expectedById = new Map(batchItems.map((item) => [item.id, item]))
  const returnedMap = new Map<string, string>()

  for (const entry of schemaCheck.data.translations) {
    if (!expectedIds.has(entry.id)) {
      return {
        valid: false,
        error: `Unexpected translation id returned: "${entry.id}"`,
      }
    }
    if (returnedMap.has(entry.id)) {
      return {
        valid: false,
        error: `Duplicate translation id returned: "${entry.id}"`,
      }
    }
    const sourceItem = expectedById.get(entry.id)
    if (sourceItem?.text?.trim() && !entry.text.trim()) {
      return {
        valid: false,
        error: `Translation for "${entry.id}" is empty`,
      }
    }
    returnedMap.set(entry.id, entry.text)
  }

  const missingIds: string[] = []
  for (const id of expectedIds) {
    if (!returnedMap.has(id)) {
      missingIds.push(id)
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
}

function isRetryableAiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true
  const e = err as HttpError
  if (typeof e.isRetryable === 'boolean') return e.isRetryable
  const status = Number(e.status || e.statusCode || 0)
  if (status === 401 || status === 403 || status === 404 || status === 422) {
    return false
  }
  return true
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
}

/**
 * Built-in multi-provider AI adapter supporting:
 * - OpenAI & OpenAI-compatible APIs (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, etc.)
 * - Google Gemini API (generateContent)
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
  const aiTimeoutMs = Math.max(
    1000,
    Number(
      options.aiTimeoutMs ??
        config.aiTimeoutMs ??
        process.env.TRANSLATION_AI_TIMEOUT_MS ??
        120000
    ) || 120000
  )

  return async function callAiModel({ systemPrompt, userPrompt }) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Global fetch is unavailable for AI API requests')
    }

    // 1. Native Google Gemini API
    if (
      (provider === 'gemini' || provider === 'google') &&
      !baseUrl.includes('/openai')
    ) {
      const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`
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
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        },
        aiTimeoutMs,
        'Gemini API request'
      )

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
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
          content?: { parts?: Array<{ text?: string }> }
        }>
      }
      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || '')
          .join('') || ''
      return extractJsonFromModelText(text)
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
            max_tokens: 4096,
            temperature: 0.1,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        },
        aiTimeoutMs,
        'Anthropic API request'
      )

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        const err = new Error(
          `Anthropic API error (${res.status}): ${errBody.slice(0, 300)}`
        ) as HttpError
        err.status = res.status
        err.isRetryable =
          res.status === 429 || res.status >= 500 || res.status === 408
        throw err
      }

      const data = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>
      }
      const text = (data?.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '')
        .join('')
      return extractJsonFromModelText(text)
    }

    // 3. OpenAI & OpenAI-compatible Chat Completions API
    const endpoint = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl}/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    async function sendChatRequest(useJsonFormat = true): Promise<Response> {
      const body = {
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
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
        'AI API request'
      )
    }

    let res = await sendChatRequest(true)
    if (res.status === 400) {
      const retryRes = await sendChatRequest(false)
      if (retryRes.ok) {
        res = retryRes
      }
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      const err = new Error(
        `AI API error (${res.status}): ${errBody.slice(0, 300)}`
      ) as HttpError
      err.status = res.status
      err.isRetryable =
        res.status === 429 || res.status >= 500 || res.status === 408
      throw err
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data?.choices?.[0]?.message?.content || ''
    return extractJsonFromModelText(content)
  }
}

export interface TranslateManifestOptions extends CreateAiProviderOptions {
  config?: TranslationConfig
  logger?: WorkerLogger
  batchSize?: number
  maxBatchChars?: number
  concurrency?: number
  maxRetries?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
  allowBatchSplit?: boolean
}

/**
 * Translates all items in a translation manifest into `targetLocale` (default: 'vi')
 * using batching, contextual prompts, strict Zod ID schema validation, and `p-retry` batch retries.
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

  const items = Array.isArray((manifest as TranslationManifest)?.items)
    ? (manifest as TranslationManifest).items
    : Array.isArray(manifest)
      ? manifest
      : []

  const articleTitle =
    !Array.isArray(manifest) && manifest?.articleTitle
      ? manifest.articleTitle
      : ''

  const translationsById = new Map<string, string>()
  const issues: string[] = []
  let retryCount = 0

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
      },
      issues,
    }
  }

  const adapter = createAiProviderAdapter(config, options)
  const systemPrompt = buildSystemPrompt(targetLocale, config.glossary)
  const batches = createTranslationBatches(items, {
    batchSize: options.batchSize ?? config.batchSize,
    maxBatchChars: options.maxBatchChars ?? config.maxBatchChars,
  })

  async function translateSingleBatch(
    batchItems: TranslationItem[],
    batchLabel: string
  ): Promise<void> {
    let lastErrorReason: string | null = null
    let nonRetryableFailure: HttpError | null = null

    try {
      await pRetry(
        async (attemptNumber) => {
          const attemptIdx = attemptNumber - 1
          try {
            const userPrompt = buildUserPrompt(
              batchItems,
              {
                targetLocale,
                articleTitle,
              },
              attemptIdx > 0 ? lastErrorReason : null
            )

            const rawResult = await adapter({
              systemPrompt,
              userPrompt,
              batchItems,
              targetLocale,
              attempt: attemptIdx,
            })

            const parsed =
              typeof rawResult === 'string'
                ? extractJsonFromModelText(rawResult)
                : rawResult
            const validation = validateBatchTranslationResponse(
              batchItems,
              parsed
            )

            if (!validation.valid) {
              lastErrorReason = validation.error
              throw new Error(validation.error)
            }

            for (const item of batchItems) {
              const rawTranslated = validation.returnedMap.get(item.id) || ''
              const cleanTranslated = preserveBoundaryWhitespace(
                item,
                rawTranslated
              )
              translationsById.set(item.id, cleanTranslated)
            }
          } catch (err) {
            lastErrorReason = err instanceof Error ? err.message : String(err)
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
            if (nonRetryableFailure) return
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
      if (nonRetryableFailure) {
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
      issues.push(
        `Batch ${batchLabel} failed after ${maxRetries + 1} attempts (${lastErrorReason}); splitting into sub-batches of ${left.length} and ${right.length}.`
      )
      await translateSingleBatch(left, `${batchLabel}a`)
      await translateSingleBatch(right, `${batchLabel}b`)
      return
    }

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
    },
    issues,
  }
}

