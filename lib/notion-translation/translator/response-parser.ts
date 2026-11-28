import { z } from 'zod'
import {
  verifyPlaceholdersIntact,
  type ProtectedTextResult,
} from '../terminology'
import type { TranslationItem } from '../types'
import { indexToShortKey } from './prompts'

const LegacyBatchTranslationResponseSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    })
  ),
})

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
