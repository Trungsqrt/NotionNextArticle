/**
 * lib/study/exam-shuffle.ts — Dependency-free Mock Exam randomization utilities
 * ──────────────────────────────────────────────────────────────────────────────
 * Provides pure, non-mutating Fisher–Yates shuffling, positional display labels
 * (A, B, C, ...), order-dependent question detection, and review-order restoration
 * exclusively for Mock Exam sessions.
 */

import type { StudyQuestion } from './types'
import type { OptionFeedbackItem } from './services/grading'

export type RandomFn = () => number

/**
 * Dependency-free Fisher–Yates shuffle on a fresh shallow copy.
 * Never mutates the input array or its elements.
 */
export function fisherYatesShuffle<T>(
  items: readonly T[],
  random: RandomFn = Math.random
): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const raw = random()
    const unit = Number.isFinite(raw)
      ? Math.min(Math.max(raw, 0), 1 - Number.EPSILON)
      : 0
    const j = Math.floor(unit * (i + 1))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

/**
 * Generates positional display labels independent of internal option IDs:
 * 0 -> "A", 1 -> "B", ..., 25 -> "Z", 26 -> "AA", etc.
 */
export function getOptionDisplayLabel(index: number): string {
  const safeIndex = Math.max(0, Math.floor(index))
  let n = safeIndex
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

/**
 * Maps internal option IDs to their displayed positional labels based on the
 * current shuffled option order, sorted by displayed position.
 */
export function formatOptionDisplayLabels(
  orderedOptions: ReadonlyArray<{ id: string }>,
  optionIds: readonly string[]
): string[] {
  if (!Array.isArray(optionIds) || optionIds.length === 0) return []

  const selectedSet = new Set(optionIds)
  const labels: string[] = []
  const matchedIds = new Set<string>()

  orderedOptions.forEach((opt, idx) => {
    if (selectedSet.has(opt.id)) {
      labels.push(getOptionDisplayLabel(idx))
      matchedIds.add(opt.id)
    }
  })

  for (const id of optionIds) {
    if (!matchedIds.has(id)) {
      labels.push(id)
    }
  }

  return labels
}

/**
 * Reorders an options array to match `orderedIds` without mutating the source array.
 * Appends any option not present in `orderedIds` in its original relative order.
 */
export function reorderOptionsByIds<T extends { id: string }>(
  options: readonly T[],
  orderedIds?: readonly string[]
): T[] {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return [...options]
  }

  const byId = new Map(options.map((opt) => [opt.id, opt]))
  const reordered: T[] = []
  const seen = new Set<string>()

  for (const rawId of orderedIds) {
    const id = typeof rawId === 'string' ? rawId : ''
    if (!id || seen.has(id)) continue
    const match = byId.get(id)
    if (match) {
      reordered.push(match)
      seen.add(id)
    }
  }

  for (const opt of options) {
    if (!seen.has(opt.id)) {
      reordered.push(opt)
      seen.add(opt.id)
    }
  }

  return reordered
}

/**
 * Reorders per-option feedback items to match a shuffled option order while
 * preserving each item's stable `optionId`.
 */
export function reorderOptionFeedbackByOptionIds(
  feedback: readonly OptionFeedbackItem[],
  orderedIds?: readonly string[]
): OptionFeedbackItem[] {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0 || feedback.length <= 1) {
    return [...feedback]
  }

  const rank = new Map<string, number>()
  orderedIds.forEach((id, idx) => {
    if (!rank.has(id)) rank.set(id, idx)
  })

  return [...feedback].sort((a, b) => {
    const rankA = rank.get(a.optionId) ?? Number.MAX_SAFE_INTEGER
    const rankB = rank.get(b.optionId) ?? Number.MAX_SAFE_INTEGER
    return rankA - rankB
  })
}

const POSITIONAL_OPTION_PATTERNS: readonly RegExp[] = [
  /\b(?:all|none|both|neither|any)\s+of\s+the\s+(?:above|below|preceding|following|previous|listed|mentioned|options|choices|answers)\b/i,
  /\b(?:all|none|both|neither)\s+(?:the\s+above|the\s+below|of\s+these|of\s+them)\b/i,
  /\b(?:above|below)\s+(?:options?|choices?|answers?)\b/i,
  /\bthe\s+(?:first|second|third|fourth|fifth|last)\s+(?:two|three|four|option|choice|answer)\b/i,
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildLabelReferencePatterns(optionIds: readonly string[]): {
  optionTextPatterns: RegExp[]
  generalTextPatterns: RegExp[]
} {
  const cleanIds = [...new Set(optionIds.map((id) => id.trim()).filter((id) => /^[A-Z0-9]{1,2}$/.test(id)))]
  if (cleanIds.length === 0) {
    return { optionTextPatterns: [], generalTextPatterns: [] }
  }

  const labelAtom = `(?:${cleanIds.map(escapeRegExp).join('|')})`
  const lowerAtom = `(?:${cleanIds.map((id) => escapeRegExp(id.toLowerCase())).join('|')})`
  const sep = `(?:\\s*(?:,|&|\\/|\\band\\b|\\bor\\b|\\bnor\\b)\\s*)`
  const parenLabel = `(?:\\(${labelAtom}\\)|${labelAtom})`

  // Patterns checked specifically inside option text (e.g. "Both A and B", "A and C only", "All except B")
  const optionTextPatterns: RegExp[] = [
    new RegExp(
      `^\\s*(?:[Bb]oth\\s+|[Oo]nly\\s+|[Ee]ither\\s+|[Nn]either\\s+|[Aa]ll\\s+except\\s+)?${parenLabel}(?:${sep}${parenLabel})+(?:\\s+only)?\\s*\\.?\\s*$`
    ),
    new RegExp(`\\b[Aa]ll\\b[^.]*\\bexcept\\s+(?:[Oo]ption\\s+)?${parenLabel}(?=$|[\\s.,;:!?)])`),
  ]

  // Patterns checked across option text, question text, option feedback, and explanation
  const generalTextPatterns: RegExp[] = [
    // "Option A", "Options A and C", "Choice B", "Answers A, B, and D", "Option (A)"
    new RegExp(
      `\\b(?:[Oo]ptions?|[Cc]hoices?|[Aa]nswers?|[Ss]elections?|[Rr]esponses?)\\s+${parenLabel}(?:${sep}${parenLabel})*(?=$|[\\s.,;:!?)])`
    ),
    // Lowercase explicit reference with verb: "option a is correct" (avoids "option a user picks")
    new RegExp(
      `\\b(?:options?|choices?|answers?)\\s+${lowerAtom}\\s+(?:is|are|was|were|refers?|states?|describes?|correctly|incorrectly)\\b`,
      'i'
    ),
    // "Both A and C", "Only A and B", "Neither A nor B", "Either B or C"
    new RegExp(
      `\\b(?:[Bb]oth|[Oo]nly|[Nn]either|[Ee]ither)\\s+${parenLabel}(?:${sep}${parenLabel})+(?=$|[\\s.,;:!?)])`
    ),
    // "A is correct", "B is incorrect", "A and C are correct", "(B) is wrong"
    new RegExp(
      `(?:^|[\\s(])${parenLabel}(?:${sep}${parenLabel})*\\s+(?:is|are)\\s+(?:correct|incorrect|true|false|right|wrong|valid|invalid|not\\s+correct|the\\s+correct|the\\s+best|required)\\b`
    ),
    // "Correct answer: B", "Correct answers: A, C", "Answer: A", "Correct: B"
    new RegExp(
      `\\b(?:[Cc]orrect\\s+[Aa]nswers?|[Aa]nswers?|[Cc]orrect)\\s*:\\s*${parenLabel}(?:${sep}${parenLabel})*(?=$|[\\s.,;:!?)])`
    ),
  ]

  return { optionTextPatterns, generalTextPatterns }
}

/**
 * Returns `true` when shuffling answer options could invalidate the question,
 * its options, or its explanation (e.g., "All of the above", "None of the above",
 * "Both A and B", or explanations/feedback referencing original answer labels).
 */
export function shouldPreserveOptionOrder(
  question: Pick<StudyQuestion, 'questionText' | 'options' | 'explanation'>
): boolean {
  if (!Array.isArray(question.options) || question.options.length <= 1) {
    return true
  }

  for (const opt of question.options) {
    const text = opt.text || ''
    if (POSITIONAL_OPTION_PATTERNS.some((re) => re.test(text))) {
      return true
    }
  }

  const { optionTextPatterns, generalTextPatterns } = buildLabelReferencePatterns(
    question.options.map((o) => o.id)
  )

  for (const opt of question.options) {
    const text = opt.text || ''
    if (optionTextPatterns.some((re) => re.test(text))) {
      return true
    }
    if (generalTextPatterns.some((re) => re.test(text))) {
      return true
    }
    if (opt.feedback && generalTextPatterns.some((re) => re.test(opt.feedback!))) {
      return true
    }
  }

  if (question.questionText && generalTextPatterns.some((re) => re.test(question.questionText))) {
    return true
  }

  if (question.explanation && generalTextPatterns.some((re) => re.test(question.explanation))) {
    return true
  }

  return false
}
