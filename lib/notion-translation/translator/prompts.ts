import { SERVICENOW_GLOSSARY } from '../config'
import {
  protectServiceNowTerminology,
  type ProtectedTextResult,
} from '../terminology'
import type { GlossaryRule, TranslationItem } from '../types'
import type { ModelReasoningCapability } from './reasoning'

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
