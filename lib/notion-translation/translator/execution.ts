import pRetry, { AbortError } from 'p-retry'
import { getTranslationConfig, type TranslationConfig } from '../config'
import {
  computeSegmentCacheKey,
  getCachedSegmentTranslation,
  recordCachedSegmentTranslations,
} from '../checkpoint-store'
import {
  loadServiceNowGlossary,
  protectServiceNowTerminology,
  restoreServiceNowTerminology,
  type ProtectedTextResult,
} from '../terminology'
import type {
  AiProviderStructuredResponse,
  AiProviderTokenUsage,
  TranslateManifestResult,
  TranslationItem,
  TranslationManifest,
  TranslationUsageStats,
  WorkerLogger,
} from '../types'
import { defaultLogger } from '../../../worker/logger'
import {
  createTranslationBatches,
  splitOversizedSegmentText,
} from './batching'
import {
  QuotaExhaustedError,
  isContextOrTokenLimitError,
  isQuotaExhaustedError,
  isRetryableAiError,
  isTruncatedErrorReason,
  type HttpError,
} from './errors'
import {
  PROMPT_VERSION,
  buildCompactBatchPrompt,
  buildSystemPrompt,
  estimateTokenCount,
  type BatchOutputBudgetOptions,
} from './prompts'
import {
  createAiProviderAdapter,
  type CreateAiProviderOptions,
} from './providers'
import { ProviderRateLimiter } from './rate-limiter'
import {
  logReasoningCapabilityWarningOnce,
  resolveModelReasoningCapability,
} from './reasoning'
import {
  extractJsonFromModelText,
  preserveBoundaryWhitespace,
  salvageCompletePairsFromTruncatedJson,
  validateBatchTranslationResponse,
} from './response-parser'

export interface TranslateManifestOptions extends CreateAiProviderOptions {
  config?: TranslationConfig
  logger?: WorkerLogger
  batchSize?: number
  maxBatchSegments?: number
  maxBatchChars?: number
  maxInputTokensPerBatch?: number
  targetOutputTokensPerBatch?: number
  assumedOutputTokensPerSec?: number
  concurrency?: number
  maxRetries?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
  allowBatchSplit?: boolean
  useSegmentCache?: boolean
  preTranslatedById?: ReadonlyMap<string, string>
  onBatchTranslated?: (partialTranslations: ReadonlyMap<string, string>) => void
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

function createInitialUsageStats(
  config: TranslationConfig
): TranslationUsageStats {
  return {
    provider: config.aiProvider || 'openai',
    model: config.aiModel || 'unknown',
    plannedBatches: 0,
    apiRequests: 0,
    successfulRequests: 0,
    failedOrRetriedRequests: 0,
    splitBatchCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    avgOutputTokensPerRequest: 0,
    cachedSegments: 0,
    skippedTechnicalSegments: 0,
    translatedSegments: 0,
    failedBatches: 0,
    excessRequestReasons: [],
    estimatedCostUsd: null,
  }
}

/**
 * Translates all items in a translation manifest into `targetLocale` (default: 'vi')
 * using ServiceNow terminology protection, persistent segment-level caching,
 * adaptive section-aware batching (40–80 segments/request), first-attempt output budgeting,
 * truncation salvage/escalation, and rate/quota awareness.
 */
export async function translateManifest(
  manifest: TranslationManifest | TranslationItem[],
  targetLocale = 'vi',
  options: TranslateManifestOptions = {}
): Promise<TranslateManifestResult> {
  const config = options.config || getTranslationConfig({ targetLocale })
  const logger = options.logger || defaultLogger
  const maxRetries = options.maxRetries ?? 2
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
  const usageStats = createInitialUsageStats(config)

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

  const reasoningCap = resolveModelReasoningCapability(
    config.aiProvider,
    config.aiModel,
    config.disableReasoning
  )
  if (typeof options.aiAdapter !== 'function') {
    logReasoningCapabilityWarningOnce(reasoningCap, logger)
  }

  const { hash: glossaryHash } = loadServiceNowGlossary({
    glossaryFilePath: config.glossaryFilePath,
    customProtectedTerms: config.customProtectedTerms,
  })

  const protectedByItemId = new Map<string, ProtectedTextResult>()
  const cacheKeyByItemId = new Map<string, string>()
  const itemsToTranslate: TranslationItem[] = []

  // Step 1: Pre-filter 100%-technical segments, checkpoint pre-translations, and segment-cache hits
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

    const preTranslated = options.preTranslatedById?.get(item.id)
    if (preTranslated && preTranslated.trim()) {
      translationsById.set(
        item.id,
        preserveBoundaryWhitespace(item, preTranslated)
      )
      usageStats.cachedSegments += 1
      continue
    }

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

  if (
    usageStats.cachedSegments > 0 ||
    usageStats.skippedTechnicalSegments > 0
  ) {
    logger.info('Reusing cached and technical segments before AI batching', {
      totalSegments: items.length,
      reusedFromCache: usageStats.cachedSegments,
      skippedTechnical: usageStats.skippedTechnicalSegments,
      remainingToTranslate: itemsToTranslate.length,
    })
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
        reusedFromCheckpoint: true,
        usage: usageStats,
      },
      issues,
    }
  }

  // Step 2: Initialize shared rate limiter, provider adapter, system prompt, and adaptive batches
  const rateLimiter = options.rateLimiter || new ProviderRateLimiter(config)
  const adapter = createAiProviderAdapter(config, {
    ...options,
    rateLimiter,
    logger,
  })
  const systemPrompt = buildSystemPrompt(targetLocale, config.glossary, {
    supportsNemotronSystemDirective:
      reasoningCap.supportsNemotronSystemDirective,
  })
  const batches = createTranslationBatches(itemsToTranslate, {
    batchSize: options.batchSize ?? config.batchSize,
    maxBatchSegments: options.maxBatchSegments ?? config.maxBatchSegments,
    maxBatchChars: options.maxBatchChars ?? config.maxBatchChars,
    maxInputTokensPerBatch:
      options.maxInputTokensPerBatch ?? config.maxInputTokensPerBatch,
    targetOutputTokensPerBatch:
      options.targetOutputTokensPerBatch ?? config.targetOutputTokensPerBatch,
    maxOutputTokens: config.maxOutputTokens,
    outputTokenSafetyMargin: config.outputTokenSafetyMargin,
    aiTimeoutMs: options.aiTimeoutMs ?? config.aiTimeoutMs,
    assumedOutputTokensPerSec:
      options.assumedOutputTokensPerSec ?? config.assumedOutputTokensPerSec,
  })
  usageStats.plannedBatches = batches.length

  logger.info('Planned adaptive AI translation batches', {
    totalSegments: items.length,
    segmentsToTranslate: itemsToTranslate.length,
    initialBatchCount: batches.length,
    avgSegmentsPerBatch: Number(
      (itemsToTranslate.length / Math.max(1, batches.length)).toFixed(1)
    ),
  })

  const budgetOptions: BatchOutputBudgetOptions = {
    minOutputTokens: config.minOutputTokens,
    maxOutputTokens: config.maxOutputTokens,
    outputTokenSafetyMargin: config.outputTokenSafetyMargin,
    reasoningCapability: reasoningCap,
  }

  function recordCompletedSegmentMap(
    completedItems: readonly TranslationItem[],
    rawMap: ReadonlyMap<string, string>,
    protMap: ReadonlyMap<string, ProtectedTextResult>
  ): void {
    const newCacheEntries: Array<{
      cacheKey: string
      translatedText: string
      targetLocale: string
    }> = []

    for (const item of completedItems) {
      const rawTranslated = rawMap.get(item.id)
      if (!rawTranslated) continue
      const prot = protMap.get(item.id) || protectedByItemId.get(item.id)
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
    if (typeof options.onBatchTranslated === 'function') {
      options.onBatchTranslated(translationsById)
    }
  }

  async function translateOversizedSingleSegment(
    item: TranslationItem,
    batchLabel: string,
    maxOutputCeiling: number,
    segmentSplitDepth: number
  ): Promise<boolean> {
    if (segmentSplitDepth >= 2) return false
    const chunks = splitOversizedSegmentText(item.text, 340)
    if (chunks.length <= 1) return false

    const splitMsg = `Split oversized single segment "${item.id}" (${item.text.length} chars) into ${chunks.length} chunks at ${batchLabel}`
    logger.warn(splitMsg)
    issues.push(splitMsg)
    usageStats.splitBatchCount += 1
    usageStats.excessRequestReasons.push(splitMsg)

    const chunkItems: TranslationItem[] = chunks.map((c, idx) => {
      const chunkId = `${item.id}__chunk_${segmentSplitDepth}_${idx}`
      const chunkProt = protectServiceNowTerminology(c.chunkText, {
        glossaryFilePath: config.glossaryFilePath,
        customProtectedTerms: config.customProtectedTerms,
      })
      protectedByItemId.set(chunkId, chunkProt)
      return {
        ...item,
        id: chunkId,
        text: c.chunkText,
        leadingSpace: '',
        trailingSpace: '',
        context: {
          ...item.context,
          fullBlockText: c.chunkText,
        },
      }
    })

    for (let i = 0; i < chunkItems.length; i++) {
      const chunkItem = chunkItems[i]!
      const chunkProt = protectedByItemId.get(chunkItem.id)
      if (chunkProt?.isFullyProtected) {
        translationsById.set(chunkItem.id, chunkItem.text)
        continue
      }
      await translateSingleBatch(
        [chunkItem],
        `${batchLabel}.chunk${i + 1}`,
        maxOutputCeiling,
        segmentSplitDepth + 1
      )
    }

    let reconstructed = ''
    for (let i = 0; i < chunkItems.length; i++) {
      const chunkItem = chunkItems[i]!
      const sep = chunks[i]?.leadingSep || (i > 0 ? ' ' : '')
      const translatedChunk =
        translationsById.get(chunkItem.id) || chunkItem.text
      translationsById.delete(chunkItem.id)
      reconstructed += (i > 0 ? sep : '') + translatedChunk.trim()
    }

    const cleanFull = preserveBoundaryWhitespace(item, reconstructed)
    translationsById.set(item.id, cleanFull)

    const segCacheKey = cacheKeyByItemId.get(item.id)
    if (useSegmentCache && segCacheKey && reconstructed.trim()) {
      recordCachedSegmentTranslations(
        [
          {
            cacheKey: segCacheKey,
            translatedText: reconstructed.trim(),
            targetLocale,
          },
        ],
        config
      )
    }
    if (typeof options.onBatchTranslated === 'function') {
      options.onBatchTranslated(translationsById)
    }
    return true
  }

  async function translateSingleBatch(
    initialBatchItems: TranslationItem[],
    batchLabel: string,
    minMaxOutputTokensFloor = 0,
    segmentSplitDepth = 0
  ): Promise<void> {
    // Filter out any items already translated (e.g., salvaged or cached)
    let activeBatchItems = initialBatchItems.filter(
      (item) => !translationsById.has(item.id)
    )
    if (activeBatchItems.length === 0) return

    let lastErrorReason: string | null = null
    let nonRetryableFailure: HttpError | null = null
    let quotaError: QuotaExhaustedError | null = null
    let shouldSplitBatchNow = false
    let currentMaxTokensOverride = minMaxOutputTokensFloor
    let truncationEscalations = 0
    let validationFailures = 0

    try {
      await pRetry(
        async (attemptNumber) => {
          const attemptIdx = attemptNumber - 1
          try {
            const promptInfo = buildCompactBatchPrompt(
              activeBatchItems,
              protectedByItemId,
              attemptIdx > 0 ? lastErrorReason : null,
              budgetOptions
            )

            const requestMaxOutputTokens = Math.min(
              promptInfo.effectiveMaxOutputCeiling,
              Math.max(
                promptInfo.recommendedRequestMaxTokens,
                currentMaxTokensOverride
              )
            )
            currentMaxTokensOverride = requestMaxOutputTokens

            const estimatedTotalTokens =
              promptInfo.estimatedInputTokens + promptInfo.estimatedOutputTokens
            await rateLimiter.acquire(estimatedTotalTokens, logger)

            usageStats.apiRequests += 1
            const rawResult = await adapter({
              systemPrompt,
              userPrompt: promptInfo.userPrompt,
              batchItems: activeBatchItems,
              targetLocale,
              attempt: attemptIdx,
              estimatedOutputTokens: promptInfo.estimatedOutputTokens,
              maxOutputTokensOverride: requestMaxOutputTokens,
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
              activeBatchItems,
              parsed,
              {
                shortKeyToItemId: promptInfo.shortKeyToItemId,
                protectedByItemId: promptInfo.protectedByItemId,
              }
            )

            if (!validation.valid) {
              validationFailures += 1
              lastErrorReason = validation.error
              const valErr = new Error(validation.error) as HttpError
              valErr.code = 'AI_VALIDATION_ERROR'
              throw valErr
            }

            usageStats.successfulRequests += 1
            recordCompletedSegmentMap(
              activeBatchItems,
              validation.returnedMap,
              promptInfo.protectedByItemId
            )
          } catch (err) {
            usageStats.failedOrRetriedRequests += 1
            lastErrorReason = err instanceof Error ? err.message : String(err)

            if (isQuotaExhaustedError(err)) {
              quotaError = err
              throw new AbortError(err)
            }

            const httpErr = err as HttpError

            // Record token usage from failed/truncated response if reported
            if (httpErr?.tokenUsage) {
              const inTok = Number(httpErr.tokenUsage.inputTokens || 0)
              const outTok = Number(httpErr.tokenUsage.outputTokens || 0)
              const totTok = Number(
                httpErr.tokenUsage.totalTokens || inTok + outTok
              )
              usageStats.inputTokens += inTok
              usageStats.outputTokens += outTok
              usageStats.totalTokens += totTok
            }

            // Special handling for output truncation (finish_reason === "length" / "MAX_TOKENS")
            if (httpErr?.isTruncated) {
              const promptInfo = buildCompactBatchPrompt(
                activeBatchItems,
                protectedByItemId,
                null,
                budgetOptions
              )
              const ceiling = promptInfo.effectiveMaxOutputCeiling
              const usedBudget =
                httpErr.maxTokensUsed || currentMaxTokensOverride || 2048

              // 1. Salvage any already-completed key-value pairs before the truncation point
              let salvagedCount = 0
              if (httpErr.rawModelText) {
                const salvaged = salvageCompletePairsFromTruncatedJson(
                  httpErr.rawModelText,
                  activeBatchItems,
                  promptInfo.shortKeyToItemId,
                  promptInfo.protectedByItemId
                )
                salvagedCount = salvaged.size
                if (salvagedCount > 0) {
                  const completedItems = activeBatchItems.filter((item) =>
                    salvaged.has(item.id)
                  )
                  recordCompletedSegmentMap(
                    completedItems,
                    salvaged,
                    promptInfo.protectedByItemId
                  )
                  activeBatchItems = activeBatchItems.filter(
                    (item) => !salvaged.has(item.id)
                  )
                  logger.info(
                    `Salvaged ${salvagedCount} completed segment(s) from truncated batch ${batchLabel}; ${activeBatchItems.length} segment(s) remaining.`
                  )
                  if (activeBatchItems.length === 0) {
                    return
                  }
                }
              }

              // If segments were salvaged, continue with only the remaining items and full max_tokens ceiling
              if (salvagedCount > 0) {
                currentMaxTokensOverride = ceiling
                usageStats.excessRequestReasons.push(
                  `Batch ${batchLabel}: salvaged ${salvagedCount} segments after finish_reason="length" (max_tokens=${usedBudget}); continuing ${activeBatchItems.length} remaining segments`
                )
                throw err
              }

              // 2. If 0 segments were salvaged and output budget can be increased to ceiling, escalate once
              if (usedBudget < ceiling && truncationEscalations < 1) {
                truncationEscalations += 1
                currentMaxTokensOverride = ceiling
                const escReason = `Batch ${batchLabel}: truncated at max_tokens=${usedBudget}; escalated output budget to ceiling max_tokens=${ceiling}`
                usageStats.excessRequestReasons.push(escReason)
                logger.warn(escReason)
                throw err
              }

              // 3. Budget is already at ceiling and no segments salvaged: split immediately (never retry unchanged request)
              shouldSplitBatchNow = true
              nonRetryableFailure = httpErr
              throw new AbortError(
                err instanceof Error ? err : new Error(lastErrorReason)
              )
            }

            // Avoid repeatedly retrying validation errors on large batches; split after 1 validation retry
            if (
              httpErr?.code === 'AI_VALIDATION_ERROR' &&
              validationFailures >= 2 &&
              activeBatchItems.length > 1 &&
              options.allowBatchSplit !== false
            ) {
              shouldSplitBatchNow = true
              throw new AbortError(
                err instanceof Error ? err : new Error(lastErrorReason)
              )
            }

            if (
              isContextOrTokenLimitError(err) &&
              activeBatchItems.length > 1 &&
              options.allowBatchSplit !== false
            ) {
              shouldSplitBatchNow = true
              throw new AbortError(
                err instanceof Error ? err : new Error(lastErrorReason)
              )
            }

            if (!isRetryableAiError(err)) {
              nonRetryableFailure = httpErr
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
            if (nonRetryableFailure || quotaError || shouldSplitBatchNow) {
              return
            }
            retryCount += 1
            if (!isTruncatedErrorReason(lastErrorReason)) {
              usageStats.excessRequestReasons.push(
                `Batch ${batchLabel}: retry ${ctx.attemptNumber}/${maxRetries} after error (${lastErrorReason?.slice(0, 120)})`
              )
            }
            logger.warn(
              `Retrying AI translation batch ${batchLabel} (attempt ${ctx.attemptNumber}/${maxRetries + 1})`,
              {
                reason: lastErrorReason,
                remainingItems: activeBatchItems.length,
                maxOutputTokens: currentMaxTokensOverride,
              }
            )
          },
        }
      )
      return
    } catch {
      if (quotaError) {
        throw quotaError
      }
      if (nonRetryableFailure && !shouldSplitBatchNow) {
        usageStats.failedBatches += 1
        const errorMessage = `Translation batch ${batchLabel} failed with non-recoverable error: ${lastErrorReason}`
        issues.push(errorMessage)
        const fatalErr = new Error(errorMessage) as HttpError & {
          issues?: string[]
        }
        fatalErr.status = (nonRetryableFailure as HttpError).status
        fatalErr.isRetryable = false
        fatalErr.failureStage = 'AI Translation'
        fatalErr.provider = config.aiProvider
        fatalErr.model = config.aiModel
        fatalErr.issues = issues
        throw fatalErr
      }
    }

    // Multi-item batch split when budget ceiling is reached or retries exhausted
    if (activeBatchItems.length > 1 && options.allowBatchSplit !== false) {
      const mid = Math.ceil(activeBatchItems.length / 2)
      const left = activeBatchItems.slice(0, mid)
      const right = activeBatchItems.slice(mid)
      const splitReason = shouldSplitBatchNow
        ? `Batch ${batchLabel} hit output/context limit (${lastErrorReason}); splitting ${activeBatchItems.length} remaining items into sub-batches of ${left.length} and ${right.length}.`
        : `Batch ${batchLabel} failed after ${maxRetries + 1} attempts (${lastErrorReason}); splitting into sub-batches of ${left.length} and ${right.length}.`
      issues.push(splitReason)
      usageStats.splitBatchCount += 1
      usageStats.excessRequestReasons.push(splitReason)
      logger.warn(splitReason)
      await translateSingleBatch(
        left,
        `${batchLabel}a`,
        0,
        segmentSplitDepth
      )
      await translateSingleBatch(
        right,
        `${batchLabel}b`,
        0,
        segmentSplitDepth
      )
      return
    }

    // Single-segment natural text boundary splitting when 1 segment is oversized and truncated
    if (
      activeBatchItems.length === 1 &&
      options.allowBatchSplit !== false &&
      segmentSplitDepth < 2
    ) {
      const singleItem = activeBatchItems[0]!
      const splitSucceeded = await translateOversizedSingleSegment(
        singleItem,
        batchLabel,
        currentMaxTokensOverride,
        segmentSplitDepth
      )
      if (splitSucceeded) {
        return
      }
    }

    usageStats.failedBatches += 1
    const errorMessage = `Translation batch ${batchLabel} failed (${config.aiProvider}/${config.aiModel}): ${lastErrorReason}`
    issues.push(errorMessage)
    const err = new Error(errorMessage) as HttpError & { issues?: string[] }
    err.failureStage = 'AI Translation'
    err.provider = config.aiProvider
    err.model = config.aiModel
    err.issues = issues
    throw err
  }

  // Step 3: Execute batches across bounded worker pool
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

  // Step 4: Finalize usage metrics and efficiency summary
  usageStats.avgOutputTokensPerRequest =
    usageStats.apiRequests > 0
      ? Math.round(usageStats.outputTokens / usageStats.apiRequests)
      : 0

  if (config.inputCostPer1M > 0 || config.outputCostPer1M > 0) {
    const inCost =
      (usageStats.inputTokens / 1_000_000) * (config.inputCostPer1M || 0)
    const outCost =
      (usageStats.outputTokens / 1_000_000) * (config.outputCostPer1M || 0)
    usageStats.estimatedCostUsd = Number((inCost + outCost).toFixed(6))
  }

  logger.info('AI translation efficiency summary', {
    provider: usageStats.provider,
    model: usageStats.model,
    initialBatchCount: usageStats.plannedBatches,
    actualApiRequests: usageStats.apiRequests,
    successfulRequests: usageStats.successfulRequests,
    failedOrRetriedRequests: usageStats.failedOrRetriedRequests,
    splitBatchCount: usageStats.splitBatchCount,
    cachedSegments: usageStats.cachedSegments,
    skippedTechnicalSegments: usageStats.skippedTechnicalSegments,
    translatedSegments: usageStats.translatedSegments,
    inputTokens: usageStats.inputTokens,
    outputTokens: usageStats.outputTokens,
    avgOutputTokensPerRequest: usageStats.avgOutputTokensPerRequest,
    ...(usageStats.apiRequests > usageStats.plannedBatches
      ? {
          excessRequests: usageStats.apiRequests - usageStats.plannedBatches,
          excessRequestReasons: usageStats.excessRequestReasons,
        }
      : {}),
  })

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
