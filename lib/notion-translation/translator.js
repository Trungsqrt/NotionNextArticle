'use strict'

const { getTranslationConfig, SERVICENOW_GLOSSARY } = require('./config')
const { defaultLogger } = require('../../worker/logger')

function buildSystemPrompt(targetLocale = 'vi', glossary = SERVICENOW_GLOSSARY) {
  const glossaryLines = (glossary || SERVICENOW_GLOSSARY)
    .map(g => `- "${g.term}": ${g.rule}`)
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

function buildUserPrompt(batchItems, contextMeta = {}, retryReason = null) {
  const payload = {
    targetLocale: contextMeta.targetLocale || 'vi',
    articleTitle: contextMeta.articleTitle || '',
    items: batchItems.map(item => ({
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

function createTranslationBatches(items, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize) || 20)
  const maxBatchChars = Math.max(500, Number(options.maxBatchChars) || 6000)

  const batches = []
  let currentBatch = []
  let currentChars = 0

  for (const item of items || []) {
    const itemChars = (item.text?.length || 0) + (item.context?.fullBlockText?.length || 0)
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= batchSize || currentChars + itemChars > maxBatchChars)
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

function extractJsonFromModelText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty response from AI provider')
  }
  const trimmed = rawText.trim()

  // Try direct JSON.parse first
  try {
    return JSON.parse(trimmed)
  } catch {
    // Strip markdown code fences if present
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim())
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
  }

  throw new Error('Response is not valid JSON')
}

/**
 * Validates that every requested translation ID in `batchItems` is returned
 * in `parsed` exactly once and has a valid string translation.
 */
function validateBatchTranslationResponse(batchItems, parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'Parsed response is not a JSON object' }
  }

  const expectedIds = new Set(batchItems.map(item => item.id))
  const expectedById = new Map(batchItems.map(item => [item.id, item]))
  const returnedMap = new Map()

  if (Array.isArray(parsed.translations)) {
    for (const entry of parsed.translations) {
      if (!entry || typeof entry.id !== 'string') {
        return { valid: false, error: 'Translation entry is missing string "id"' }
      }
      if (!expectedIds.has(entry.id)) {
        return { valid: false, error: `Unexpected translation id returned: "${entry.id}"` }
      }
      if (returnedMap.has(entry.id)) {
        return { valid: false, error: `Duplicate translation id returned: "${entry.id}"` }
      }
      if (typeof entry.text !== 'string') {
        return { valid: false, error: `Translation for "${entry.id}" has non-string text` }
      }
      const sourceItem = expectedById.get(entry.id)
      if (sourceItem?.text?.trim() && !entry.text.trim()) {
        return { valid: false, error: `Translation for "${entry.id}" is empty` }
      }
      returnedMap.set(entry.id, entry.text)
    }
  } else {
    return { valid: false, error: 'Response JSON must contain a "translations" array' }
  }

  const missingIds = []
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

function preserveBoundaryWhitespace(sourceItem, translatedText) {
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

/**
 * Built-in multi-provider AI adapter supporting:
 * - OpenAI & OpenAI-compatible APIs (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, etc.)
 * - Google Gemini API (generateContent)
 * - Anthropic Messages API
 */
function createAiProviderAdapter(config, options = {}) {
  if (typeof options.aiAdapter === 'function') {
    return options.aiAdapter
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch
  const provider = (config.aiProvider || 'openai').toLowerCase()
  const baseUrl = (config.aiBaseUrl || '').replace(/\/+$/, '')
  const apiKey = config.aiApiKey
  const model = config.aiModel

  return async function callAiModel({ systemPrompt, userPrompt, batchItems }) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Global fetch is unavailable for AI API requests')
    }

    // 1. Native Google Gemini API
    if ((provider === 'gemini' || provider === 'google') && !baseUrl.includes('/openai')) {
      const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`
      const res = await fetchImpl(endpoint, {
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
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        const err = new Error(`Gemini API error (${res.status}): ${errBody.slice(0, 300)}`)
        err.status = res.status
        throw err
      }

      const data = await res.json()
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
      return extractJsonFromModelText(text)
    }

    // 2. Native Anthropic Messages API
    if ((provider === 'anthropic' || provider === 'claude') && !baseUrl.includes('/openai')) {
      const endpoint = baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl}/messages`
      const res = await fetchImpl(endpoint, {
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
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        const err = new Error(`Anthropic API error (${res.status}): ${errBody.slice(0, 300)}`)
        err.status = res.status
        throw err
      }

      const data = await res.json()
      const text = (data?.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('')
      return extractJsonFromModelText(text)
    }

    // 3. OpenAI & OpenAI-compatible Chat Completions API
    const endpoint = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl}/chat/completions`

    const headers = {
      'Content-Type': 'application/json',
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    async function sendChatRequest(useJsonFormat = true) {
      const body = {
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
      }

      return fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    }

    let res = await sendChatRequest(true)
    // Fallback without response_format if the OpenAI-compatible server rejects response_format
    if (res.status === 400) {
      const retryRes = await sendChatRequest(false)
      if (retryRes.ok) {
        res = retryRes
      }
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      const err = new Error(`AI API error (${res.status}): ${errBody.slice(0, 300)}`)
      err.status = res.status
      throw err
    }

    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content || ''
    return extractJsonFromModelText(content)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Translates all items in a translation manifest into `targetLocale` (default: 'vi')
 * using batching, contextual prompts, strict ID schema validation, and batch retries.
 */
async function translateManifest(manifest, targetLocale = 'vi', options = {}) {
  const config = options.config || getTranslationConfig({ targetLocale })
  const logger = options.logger || defaultLogger
  const maxRetries = options.maxRetries ?? 3
  const initialRetryDelayMs = options.initialRetryDelayMs ?? 500
  const sleepFn = options.sleepFn || sleep

  const items = Array.isArray(manifest?.items)
    ? manifest.items
    : Array.isArray(manifest)
      ? manifest
      : []

  const translationsById = new Map()
  const issues = []
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

  async function translateSingleBatch(batchItems, batchLabel) {
    let lastError = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        retryCount += 1
        const delayMs = initialRetryDelayMs * Math.pow(2, attempt - 1)
        logger.warn(`Retrying AI translation batch ${batchLabel} (attempt ${attempt}/${maxRetries})`, {
          reason: lastError,
        })
        await sleepFn(delayMs)
      }

      try {
        const userPrompt = buildUserPrompt(
          batchItems,
          {
            targetLocale,
            articleTitle: manifest?.articleTitle || '',
          },
          attempt > 0 ? lastError : null
        )

        const rawResult = await adapter({
          systemPrompt,
          userPrompt,
          batchItems,
          targetLocale,
          attempt,
        })

        const parsed = typeof rawResult === 'string' ? extractJsonFromModelText(rawResult) : rawResult
        const validation = validateBatchTranslationResponse(batchItems, parsed)

        if (!validation.valid) {
          lastError = validation.error
          continue
        }

        for (const item of batchItems) {
          const rawTranslated = validation.returnedMap.get(item.id)
          const cleanTranslated = preserveBoundaryWhitespace(item, rawTranslated)
          translationsById.set(item.id, cleanTranslated)
        }
        return
      } catch (err) {
        lastError = err?.message || String(err)
      }
    }

    // If a multi-item batch failed all retries, split in half to isolate any problematic item
    if (batchItems.length > 1 && options.allowBatchSplit !== false) {
      const mid = Math.ceil(batchItems.length / 2)
      const left = batchItems.slice(0, mid)
      const right = batchItems.slice(mid)
      issues.push(
        `Batch ${batchLabel} failed after ${maxRetries + 1} attempts (${lastError}); splitting into sub-batches of ${left.length} and ${right.length}.`
      )
      await translateSingleBatch(left, `${batchLabel}a`)
      await translateSingleBatch(right, `${batchLabel}b`)
      return
    }

    const errorMessage = `Translation batch ${batchLabel} failed after ${maxRetries + 1} attempts: ${lastError}`
    issues.push(errorMessage)
    const err = new Error(errorMessage)
    err.issues = issues
    throw err
  }

  // Execute batches sequentially or with configured limited concurrency
  const concurrency = Math.max(1, Number(options.concurrency ?? config.concurrency ?? 1))
  let nextIndex = 0

  async function workerLoop() {
    while (nextIndex < batches.length) {
      const currentIdx = nextIndex++
      const batch = batches[currentIdx]
      await translateSingleBatch(batch, `${currentIdx + 1}/${batches.length}`)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, () => workerLoop())
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

module.exports = {
  translateManifest,
  createTranslationBatches,
  validateBatchTranslationResponse,
  extractJsonFromModelText,
  createAiProviderAdapter,
  buildSystemPrompt,
  buildUserPrompt,
  preserveBoundaryWhitespace,
}

