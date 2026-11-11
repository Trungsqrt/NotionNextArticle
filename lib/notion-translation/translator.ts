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
  TranslationFailureStage,
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

export type ReasoningControlMode =
  | 'not_reasoning_model'
  | 'disabled_via_effort_none'
  | 'disabled_via_thinking_budget_zero'
  | 'disabled_via_openrouter_reasoning'
  | 'always_on_cannot_disable'
  | 'enabled_by_config'

export interface ModelReasoningCapability {
  provider: string
  model: string
  isReasoningModel: boolean
  canDisableReasoning: boolean
  mode: ReasoningControlMode
  supportsNemotronSystemDirective: boolean
  recommendedMinOutputTokens: number
  recommendedMaxOutputTokens: number
  warningMessage: string | null
}

const warnedReasoningModels = new Set<string>()

/**
 * Determines provider and model capabilities for reasoning control and output token limits.
 * Never claims reasoning is disabled when a model does not officially support disabling it.
 */
export function resolveModelReasoningCapability(
  providerRaw: string,
  modelRaw: string,
  disableReasoning = true
): ModelReasoningCapability {
  const provider = (providerRaw || 'openai').trim().toLowerCase()
  const model = (modelRaw || 'gpt-4o-mini').trim()
  const lowerModel = model.toLowerCase()

  const isNemotron = lowerModel.includes('nemotron')
  const isDeepSeekR1 =
    lowerModel.includes('deepseek-r1') ||
    lowerModel.includes('deepseek-reasoner') ||
    /(?:^|\/)r1(?:-|:|$)/.test(lowerModel)
  const isQwQOrThinkingOnly =
    lowerModel.includes('qwq') || lowerModel.includes('thinking')
  const isOpenAiOSeries = /^(?:openai\/)?o[134](?:-|:|$)/.test(lowerModel)
  const isGptOss = lowerModel.includes('gpt-oss')
  const isQwen3Hybrid =
    lowerModel.includes('qwen3') && !lowerModel.includes('thinking')
  const isGemini25Pro = lowerModel.includes('gemini-2.5-pro')
  const isGemini25Flash = lowerModel.includes('gemini-2.5-flash')
  const isClaudeHybrid =
    lowerModel.includes('claude-3-7') ||
    lowerModel.includes('claude-3.7') ||
    lowerModel.includes('claude-sonnet-4') ||
    lowerModel.includes('claude-opus-4')

  const isAlwaysOnReasoning =
    isNemotron ||
    isDeepSeekR1 ||
    isQwQOrThinkingOnly ||
    isOpenAiOSeries ||
    isGptOss ||
    isGemini25Pro

  const isHybridReasoning =
    isQwen3Hybrid || isGemini25Flash || isClaudeHybrid

  const isReasoningModel = isAlwaysOnReasoning || isHybridReasoning

  if (!isReasoningModel) {
    return {
      provider,
      model,
      isReasoningModel: false,
      canDisableReasoning: true,
      mode: 'not_reasoning_model',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  if (!disableReasoning) {
    return {
      provider,
      model,
      isReasoningModel: true,
      canDisableReasoning: !isAlwaysOnReasoning,
      mode: 'enabled_by_config',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  // 1. Groq + Qwen3 hybrid models officially support reasoning_effort="none"
  if (provider === 'groq' && isQwen3Hybrid) {
    return {
      provider,
      model,
      isReasoningModel: true,
      canDisableReasoning: true,
      mode: 'disabled_via_effort_none',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  // 2. Native Gemini API + gemini-2.5-flash officially supports thinkingBudget=0
  if (
    (provider === 'gemini' || provider === 'google') &&
    isGemini25Flash
  ) {
    return {
      provider,
      model,
      isReasoningModel: true,
      canDisableReasoning: true,
      mode: 'disabled_via_thinking_budget_zero',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  // 3. OpenRouter + hybrid reasoning models (Qwen3 non-thinking, Gemini 2.5 Flash, Claude 3.7/4)
  if (provider === 'openrouter' && isHybridReasoning) {
    return {
      provider,
      model,
      isReasoningModel: true,
      canDisableReasoning: true,
      mode: 'disabled_via_openrouter_reasoning',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  // 4. Always-on reasoning models (Nemotron Ultra/Super, DeepSeek R1, QwQ, Qwen3-Thinking, o1/o3/o4, Gemini 2.5 Pro)
  return {
    provider,
    model,
    isReasoningModel: true,
    canDisableReasoning: false,
    mode: 'always_on_cannot_disable',
    supportsNemotronSystemDirective: isNemotron,
    recommendedMinOutputTokens: 2048,
    recommendedMaxOutputTokens: 8192,
    warningMessage:
      `Model "${model}" on provider "${provider}" is an always-on reasoning model whose chain-of-thought cannot be disabled via API and consumes output token budget (max_tokens). ` +
      `Using output-aware batching (~5000 output tokens target) and max_tokens escalation up to TRANSLATION_MAX_OUTPUT_TOKENS to prevent truncation.`,
  }
}

export function logReasoningCapabilityWarningOnce(
  capability: ModelReasoningCapability,
  logger: WorkerLogger = defaultLogger
): void {
  if (!capability.warningMessage) return
  const key = `${capability.provider}::${capability.model}`
  if (warnedReasoningModels.has(key)) return
  warnedReasoningModels.add(key)
  logger.warn(capability.warningMessage, {
    provider: capability.provider,
    model: capability.model,
    reasoningMode: capability.mode,
    recommendedMinOutputTokens: capability.recommendedMinOutputTokens,
    recommendedMaxOutputTokens: capability.recommendedMaxOutputTokens,
  })
}

/**
 * Estimates token count using a fast character heuristic (~3.5 chars per token for mixed EN/VI/JSON).
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
  _glossary: readonly GlossaryRule[] = SERVICENOW_GLOSSARY,
  options: { supportsNemotronSystemDirective?: boolean } = {}
): string {
  let prompt = SERVICENOW_SYSTEM_PROMPT
  if (targetLocale && targetLocale.toLowerCase() !== 'vi') {
    prompt = `${prompt}\nTarget locale: ${targetLocale}.`
  }
  if (options.supportsNemotronSystemDirective) {
    prompt = `detailed thinking off\n${prompt}`
  }
  return prompt
}

export interface BatchOutputBudgetOptions {
  minOutputTokens?: number
  maxOutputTokens?: number
  outputTokenSafetyMargin?: number
  reasoningCapability?: ModelReasoningCapability
}

export interface BatchPromptBuildResult {
  userPrompt: string
  shortKeyToItemId: Map<string, string>
  itemIdToShortKey: Map<string, string>
  protectedByItemId: Map<string, ProtectedTextResult>
  estimatedInputTokens: number
  estimatedOutputTokens: number
  recommendedRequestMaxTokens: number
  effectiveMaxOutputCeiling: number
}

/**
 * Calculates both the estimated visible output token usage (for rate-limiter pacing)
 * and the safe generation budget (`max_tokens`) for the API request.
 */
export function computeBatchOutputTokenBudget(
  sourceTextChars: number,
  itemCount: number,
  budgetOptions: BatchOutputBudgetOptions = {}
): {
  estimatedVisibleOutputTokens: number
  recommendedRequestMaxTokens: number
  effectiveMaxOutputCeiling: number
} {
  const safetyMargin = Math.max(
    1.1,
    Number(budgetOptions.outputTokenSafetyMargin || 1.8)
  )
  const capability = budgetOptions.reasoningCapability
  const isUncontrollableReasoning =
    capability?.mode === 'always_on_cannot_disable' ||
    capability?.mode === 'enabled_by_config'

  // Estimated visible JSON + Vietnamese translation output tokens
  const jsonStructureOverhead = itemCount * 16 + 64
  const estimatedVisibleOutputTokens = Math.max(
    128,
    Math.ceil((sourceTextChars / 3.0) * 1.55) + jsonStructureOverhead
  )

  const effectiveMinFloor = Math.max(
    2048,
    Number(budgetOptions.minOutputTokens || 2048),
    isUncontrollableReasoning ? 4096 : 2048
  )
  const effectiveMaxOutputCeiling = Math.max(
    effectiveMinFloor,
    Number(budgetOptions.maxOutputTokens || 8192)
  )

  let targetRequestMaxTokens = Math.ceil(
    estimatedVisibleOutputTokens * safetyMargin
  )
  if (isUncontrollableReasoning) {
    // Allocate sufficient reasoning headroom from the first attempt so always-on reasoning
    // models do not fail with unnecessary finish_reason="length"
    const reasoningReserve = Math.max(
      1536,
      Math.ceil(estimatedVisibleOutputTokens * 0.65)
    )
    targetRequestMaxTokens += reasoningReserve
  }

  const recommendedRequestMaxTokens = Math.min(
    effectiveMaxOutputCeiling,
    Math.max(effectiveMinFloor, targetRequestMaxTokens)
  )

  return {
    estimatedVisibleOutputTokens,
    recommendedRequestMaxTokens,
    effectiveMaxOutputCeiling,
  }
}

export function buildCompactBatchPrompt(
  batchItems: readonly TranslationItem[],
  protectedMap: ReadonlyMap<string, ProtectedTextResult>,
  retryReason: string | null = null,
  budgetOptions: BatchOutputBudgetOptions = {}
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

  const {
    estimatedVisibleOutputTokens,
    recommendedRequestMaxTokens,
    effectiveMaxOutputCeiling,
  } = computeBatchOutputTokenBudget(
    sourceTextChars,
    batchItems.length,
    budgetOptions
  )

  return {
    userPrompt,
    shortKeyToItemId,
    itemIdToShortKey,
    protectedByItemId,
    estimatedInputTokens,
    estimatedOutputTokens: estimatedVisibleOutputTokens,
    recommendedRequestMaxTokens,
    effectiveMaxOutputCeiling,
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

export const DEFAULT_ASSUMED_OUTPUT_TOKENS_PER_SEC = 53

export interface CreateTranslationBatchesOptions {
  batchSize?: number
  maxBatchSegments?: number
  maxBatchChars?: number
  maxInputTokensPerBatch?: number
  targetOutputTokensPerBatch?: number
  maxOutputTokens?: number
  outputTokenSafetyMargin?: number
  aiTimeoutMs?: number
  assumedOutputTokensPerSec?: number
}

interface SectionGroup {
  sectionKey: string
  items: TranslationItem[]
  totalChars: number
  totalInputTokens: number
  totalVisibleOutputTokens: number
}

function computeItemBatchMetrics(item: TranslationItem): {
  itemChars: number
  itemInputTokens: number
  itemVisibleOutputTokens: number
} {
  const textLen = item.text?.length || 0
  const fullLen = item.context?.fullBlockText?.length || 0
  const isFragment = fullLen > textLen + 4 && fullLen <= 450
  const itemChars = textLen + (isFragment ? Math.min(fullLen, 300) : 0) + 12
  const itemInputTokens = Math.ceil(itemChars / 3.5) + 6
  const itemVisibleOutputTokens = Math.ceil((textLen / 3.0) * 1.55) + 14
  return {
    itemChars,
    itemInputTokens,
    itemVisibleOutputTokens,
  }
}

function groupTranslationItemsBySection(
  items: readonly TranslationItem[]
): SectionGroup[] {
  const sections: SectionGroup[] = []
  let currentGroup: SectionGroup | null = null
  let lastParentHeading = ''
  let headingCounter = 0

  for (const item of items || []) {
    const isHeadingBlock =
      item.kind === 'block' &&
      /^heading_[123]$/.test(item.blockType || '') &&
      item.runIndex === 0
    const parentHeading = (item.context?.parentHeading || '').trim()

    let sectionKey: string
    if (item.kind === 'property') {
      sectionKey = '__page_properties__'
    } else if (isHeadingBlock) {
      headingCounter += 1
      lastParentHeading = (item.text || parentHeading).trim()
      sectionKey = `sec_${headingCounter}_${lastParentHeading}`
    } else if (parentHeading && parentHeading !== lastParentHeading) {
      headingCounter += 1
      lastParentHeading = parentHeading
      sectionKey = `sec_${headingCounter}_${parentHeading}`
    } else {
      sectionKey = currentGroup?.sectionKey || 'sec_0_intro'
    }

    const metrics = computeItemBatchMetrics(item)
    if (!currentGroup || currentGroup.sectionKey !== sectionKey) {
      currentGroup = {
        sectionKey,
        items: [item],
        totalChars: metrics.itemChars,
        totalInputTokens: metrics.itemInputTokens,
        totalVisibleOutputTokens: metrics.itemVisibleOutputTokens,
      }
      sections.push(currentGroup)
    } else {
      currentGroup.items.push(item)
      currentGroup.totalChars += metrics.itemChars
      currentGroup.totalInputTokens += metrics.itemInputTokens
      currentGroup.totalVisibleOutputTokens += metrics.itemVisibleOutputTokens
    }
  }

  return sections
}

/**
 * Adaptive section-aware batch builder supporting 40–80 segments per request,
 * governed by input/output token budgets, character limits, and estimated generation time
 * (~53 output tokens/sec within `TRANSLATION_AI_TIMEOUT_MS`).
 */
export function createTranslationBatches(
  items: readonly TranslationItem[],
  options: CreateTranslationBatchesOptions = {}
): TranslationItem[][] {
  const targetBatchSize = Math.min(
    80,
    Math.max(1, Number(options.batchSize) || 60)
  )
  const hardMaxSegments = Math.min(
    80,
    Math.max(
      targetBatchSize,
      Number(options.maxBatchSegments) ||
        (targetBatchSize >= 40 ? 80 : targetBatchSize)
    )
  )
  const maxBatchChars = Math.max(500, Number(options.maxBatchChars) || 12000)
  const maxInputTokensPerBatch = Math.max(
    200,
    Number(options.maxInputTokensPerBatch) || 4500
  )
  const configuredTargetOutput = Math.max(
    1024,
    Number(options.targetOutputTokensPerBatch) || 5000
  )
  const maxOutputTokens = Math.max(
    2048,
    Number(options.maxOutputTokens) || 8192
  )
  const safetyMargin = Math.max(
    1.1,
    Number(options.outputTokenSafetyMargin) || 1.8
  )
  const aiTimeoutMs = Math.max(30_000, Number(options.aiTimeoutMs) || 120_000)
  const assumedOutputTps = Math.max(
    5,
    Number(options.assumedOutputTokensPerSec) ||
      DEFAULT_ASSUMED_OUTPUT_TOKENS_PER_SEC
  )

  // Ensure estimated generation time at ~53 output tokens/sec stays safely inside aiTimeoutMs
  const maxSafeGenerationSec = Math.max(
    20,
    Math.floor((aiTimeoutMs * 0.75) / 1000)
  )
  const maxOutputTokensByTimeout = Math.floor(
    maxSafeGenerationSec * assumedOutputTps
  )
  // Keep estimated visible output tokens within ceiling / safetyMargin so first attempt doesn't truncate
  const maxVisibleOutputByCeiling = Math.max(
    1500,
    Math.floor(maxOutputTokens / Math.min(safetyMargin, 1.65))
  )
  const effectiveOutputTokenBudget = Math.min(
    configuredTargetOutput,
    maxOutputTokensByTimeout,
    maxVisibleOutputByCeiling
  )

  const systemPromptTokens = estimateTokenCount(SERVICENOW_SYSTEM_PROMPT) + 24
  const sections = groupTranslationItemsBySection(items)

  const batches: TranslationItem[][] = []
  let currentBatch: TranslationItem[] = []
  let currentChars = 0
  let currentInputTokens = systemPromptTokens
  let currentOutputTokens = 64

  function flushCurrentBatch(): void {
    if (currentBatch.length > 0) {
      batches.push(currentBatch)
      currentBatch = []
      currentChars = 0
      currentInputTokens = systemPromptTokens
      currentOutputTokens = 64
    }
  }

  for (const section of sections) {
    // At a section boundary, if the current batch already has >= targetBatchSize items
    // (or >= 65% of token/char budget) and the entire incoming section cannot fit cleanly,
    // close the current batch so the new section starts cleanly at the top of the next batch.
    if (currentBatch.length > 0) {
      const wholeSectionFits =
        currentBatch.length + section.items.length <= hardMaxSegments &&
        currentChars + section.totalChars <= maxBatchChars &&
        currentInputTokens + section.totalInputTokens <=
          maxInputTokensPerBatch &&
        currentOutputTokens + section.totalVisibleOutputTokens <=
          effectiveOutputTokenBudget

      const batchSubstantiallyFilled =
        currentBatch.length >= targetBatchSize ||
        currentOutputTokens >= effectiveOutputTokenBudget * 0.65 ||
        currentChars >= maxBatchChars * 0.65 ||
        currentInputTokens >= maxInputTokensPerBatch * 0.65

      if (!wholeSectionFits && batchSubstantiallyFilled) {
        flushCurrentBatch()
      }
    }

    for (let i = 0; i < section.items.length; i++) {
      const item = section.items[i]!
      const { itemChars, itemInputTokens, itemVisibleOutputTokens } =
        computeItemBatchMetrics(item)

      const remainingInSection = section.items.length - i
      const canFinishSectionWithinHardCap =
        currentBatch.length + remainingInSection <= hardMaxSegments

      // Allow adaptive packing from targetBatchSize (40–60) up to hardMaxSegments (80)
      // when token/char/timeout budgets still have room (either to finish a section or pack short segments).
      const segmentCapForCurrentBatch =
        canFinishSectionWithinHardCap ||
        currentOutputTokens < effectiveOutputTokenBudget * 0.72
          ? hardMaxSegments
          : targetBatchSize

      if (
        currentBatch.length > 0 &&
        (currentBatch.length >= segmentCapForCurrentBatch ||
          currentChars + itemChars > maxBatchChars ||
          currentInputTokens + itemInputTokens > maxInputTokensPerBatch ||
          currentOutputTokens + itemVisibleOutputTokens >
            effectiveOutputTokenBudget)
      ) {
        flushCurrentBatch()
      }

      currentBatch.push(item)
      currentChars += itemChars
      currentInputTokens += itemInputTokens
      currentOutputTokens += itemVisibleOutputTokens
    }
  }

  flushCurrentBatch()
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

/**
 * Extracts already-completed `"shortKey": "translatedValue"` pairs from a truncated JSON string
 * so valid translations completed before `finish_reason="length"` are salvaged rather than discarded.
 */
export function salvageCompletePairsFromTruncatedJson(
  rawText: string,
  batchItems: readonly TranslationItem[],
  shortKeyToItemId: ReadonlyMap<string, string>,
  protectedByItemId: ReadonlyMap<string, ProtectedTextResult>
): Map<string, string> {
  const salvagedByItemId = new Map<string, string>()
  if (!rawText || typeof rawText !== 'string') return salvagedByItemId

  const withoutThink = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const expectedById = new Map(batchItems.map((item) => [item.id, item]))

  // Match complete JSON string key-value pairs: "a": "escaped string value"
  const pairRegex = /"([a-z]{1,3})"\s*:\s*("(?:[^"\\]|\\.)*")(?=\s*[,}])/g
  let match: RegExpExecArray | null
  while ((match = pairRegex.exec(withoutThink)) !== null) {
    const shortKey = match[1]!
    const jsonStringLiteral = match[2]!
    const itemId = shortKeyToItemId.get(shortKey)
    if (!itemId || !expectedById.has(itemId)) continue

    try {
      const parsedValue = JSON.parse(jsonStringLiteral) as string
      if (typeof parsedValue !== 'string') continue
      const sourceItem = expectedById.get(itemId)!
      if (sourceItem.text?.trim() && !parsedValue.trim()) continue

      const prot = protectedByItemId.get(itemId)
      if (prot && prot.placeholders.size > 0) {
        const check = verifyPlaceholdersIntact(parsedValue, prot.placeholders)
        if (!check.valid) continue
      }

      salvagedByItemId.set(itemId, parsedValue)
    } catch {
      // Ignore malformed partial string literal
    }
  }

  return salvagedByItemId
}

/**
 * Safely splits an oversized individual text segment at natural boundaries (newlines, sentences,
 * clauses, or word spaces) without breaking `__SN<n>__` placeholders or losing separator whitespace.
 */
export function splitOversizedSegmentText(
  text: string,
  maxChunkChars = 360
): Array<{ chunkText: string; leadingSep: string }> {
  const raw = String(text ?? '')
  if (raw.length <= maxChunkChars) {
    return [{ chunkText: raw, leadingSep: '' }]
  }

  const targetLen = Math.max(
    140,
    Math.min(maxChunkChars, Math.ceil(raw.length / 2))
  )

  // Split into sentence/line/clause tokens while preserving exact whitespace delimiters
  const pieces = raw.split(/(\r?\n+|(?<=[.!?。！？;:])\s+|(?<=,\s))/g)
  const chunks: Array<{ chunkText: string; leadingSep: string }> = []
  let currentText = ''
  let pendingSep = ''

  for (const piece of pieces) {
    if (!piece) continue
    if (/^\s+$/.test(piece)) {
      if (currentText) {
        currentText += piece
      } else {
        pendingSep += piece
      }
      continue
    }

    if (
      currentText.trim().length > 0 &&
      currentText.length + piece.length > targetLen
    ) {
      const trailingMatch = currentText.match(/(\s+)$/)
      const trailingSep = trailingMatch ? trailingMatch[1]! : ''
      const cleanChunk = trailingSep
        ? currentText.slice(0, -trailingSep.length)
        : currentText
      chunks.push({ chunkText: cleanChunk, leadingSep: pendingSep })
      pendingSep = trailingSep
      currentText = piece
    } else {
      currentText += piece
    }
  }

  if (currentText) {
    chunks.push({ chunkText: currentText, leadingSep: pendingSep })
  }

  // Fallback to word-boundary split if sentence/clause regex produced only 1 chunk
  if (chunks.length <= 1 && raw.length > 180) {
    const mid = Math.floor(raw.length / 2)
    let splitIdx = -1
    for (let offset = 0; offset < Math.min(120, mid); offset++) {
      const rightIdx = mid + offset
      const leftIdx = mid - offset
      if (rightIdx < raw.length && /\s/.test(raw[rightIdx]!)) {
        splitIdx = rightIdx
        break
      }
      if (leftIdx > 0 && /\s/.test(raw[leftIdx]!)) {
        splitIdx = leftIdx
        break
      }
    }
    if (splitIdx > 20 && splitIdx < raw.length - 20) {
      const leftPart = raw.slice(0, splitIdx)
      const sepMatch = raw.slice(splitIdx).match(/^(\s+)/)
      const sep = sepMatch ? sepMatch[1]! : ' '
      const rightPart = raw.slice(splitIdx + sep.length)
      if (leftPart.trim() && rightPart.trim()) {
        return [
          { chunkText: leftPart, leadingSep: '' },
          { chunkText: rightPart, leadingSep: sep },
        ]
      }
    }
  }

  return chunks.length > 0 ? chunks : [{ chunkText: raw, leadingSep: '' }]
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

function isContextOrTokenLimitError(err: unknown): boolean {
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

function parseDurationHeaderMs(rawHeader: string | null | undefined): number {
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
    while (
      this.minuteWindow.length > 0 &&
      this.minuteWindow[0]!.ts <= oneMinuteAgo
    ) {
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
    if (
      remReqs !== null &&
      Number(remReqs) <= 1 &&
      resetReqsMs > 0 &&
      resetReqsMs <= 60_000
    ) {
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
      if (reasoningCap.mode === 'disabled_via_thinking_budget_zero') {
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
        err.provider = provider
        err.model = model
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
        data?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || '')
          .join('') || ''
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
            maxOutputTokensUsed: boundedMaxTokens,
            usage,
          }
        } catch {
          const truncErr = new Error(
            `Gemini output truncated (finishReason="MAX_TOKENS", maxOutputTokens=${boundedMaxTokens})`
          ) as HttpError
          truncErr.isTruncated = true
          truncErr.isRetryable = false
          truncErr.maxTokensUsed = boundedMaxTokens
          truncErr.rawModelText = text
          truncErr.tokenUsage = usage
          truncErr.provider = provider
          truncErr.model = model
          throw truncErr
        }
      }

      return {
        __isStructuredAiResponse: true,
        data: extractJsonFromModelText(text),
        rawText: text,
        finishReason,
        maxOutputTokensUsed: boundedMaxTokens,
        usage,
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
        err.provider = provider
        err.model = model
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
            maxOutputTokensUsed: boundedMaxTokens,
            usage,
          }
        } catch {
          const truncErr = new Error(
            `Anthropic output truncated (stop_reason="max_tokens", max_tokens=${boundedMaxTokens})`
          ) as HttpError
          truncErr.isTruncated = true
          truncErr.isRetryable = false
          truncErr.maxTokensUsed = boundedMaxTokens
          truncErr.rawModelText = text
          truncErr.tokenUsage = usage
          truncErr.provider = provider
          truncErr.model = model
          throw truncErr
        }
      }

      return {
        __isStructuredAiResponse: true,
        data: extractJsonFromModelText(text),
        rawText: text,
        finishReason: data?.stop_reason,
        maxOutputTokensUsed: boundedMaxTokens,
        usage,
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

    async function sendChatRequest(
      useJsonFormat = true,
      includeReasoningControl = true
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
        if (reasoningCap.mode === 'disabled_via_effort_none') {
          body.reasoning_effort = 'none'
        } else if (reasoningCap.mode === 'disabled_via_openrouter_reasoning') {
          body.reasoning = { effort: 'none', exclude: true }
        } else if (
          provider === 'openrouter' &&
          reasoningCap.mode === 'always_on_cannot_disable'
        ) {
          // On OpenRouter always-on reasoning models, exclude reasoning text from message.content
          // without sending unsupported effort="none"
          body.reasoning = { exclude: true }
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

    let res = await sendChatRequest(true, true)
    if (res.status === 400) {
      // Fallback 1: retry without provider-specific reasoning parameter
      if (reasoningCap.isReasoningModel) {
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
      err.provider = provider
      err.model = model
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
            maxOutputTokensUsed: boundedMaxTokens,
            usage,
          }
        } catch {
          // Proceed to structured truncation handling
        }
      }

      const reasoningNote =
        reasoningTok > 0 ? `, reasoning_tokens=${reasoningTok}` : ''
      const truncErr = new Error(
        `AI output truncated (finish_reason="${finishReason}", max_tokens=${boundedMaxTokens}${reasoningNote})`
      ) as HttpError
      truncErr.isTruncated = true
      truncErr.isRetryable = false
      truncErr.maxTokensUsed = boundedMaxTokens
      truncErr.rawModelText = content
      truncErr.tokenUsage = usage
      truncErr.provider = provider
      truncErr.model = model
      throw truncErr
    }

    return {
      __isStructuredAiResponse: true,
      data: extractJsonFromModelText(content),
      rawText: content,
      finishReason,
      maxOutputTokensUsed: boundedMaxTokens,
      usage,
    }
  }
}

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

  const usageStats: TranslationUsageStats = {
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
      translationsById.set(item.id, preserveBoundaryWhitespace(item, preTranslated))
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

  if (usageStats.cachedSegments > 0 || usageStats.skippedTechnicalSegments > 0) {
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
            if (!httpIsTruncatedReason(lastErrorReason)) {
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

function httpIsTruncatedReason(reason: string | null): boolean {
  if (!reason) return false
  return (
    reason.includes('finish_reason="length"') ||
    reason.includes('finish_reason="max_tokens"') ||
    reason.includes('finishReason="MAX_TOKENS"') ||
    reason.includes('stop_reason="max_tokens"')
  )
}
