import type { TranslationItem } from '../types'
import { estimateTokenCount, SERVICENOW_SYSTEM_PROMPT } from './prompts'

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
