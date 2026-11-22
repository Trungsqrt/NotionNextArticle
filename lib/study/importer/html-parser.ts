/**
 * lib/study/importer/html-parser.ts — Safe, zero-eval HTML quizData parser
 * ─────────────────────────────────────────────────────────────────────────
 * Extracts embedded JavaScript `quizData` (or compatible quiz arrays/objects)
 * from local HTML exam files WITHOUT executing any JavaScript (`eval`,
 * `new Function`, or `vm` are never used).
 *
 * Also extracts `<img src="...">` references from question text, answer
 * options, per-option feedback, and explanations while preserving exact order
 * and placement.
 */

import type { QuestionImagePlacement, QuestionType } from '../types'

export interface ExtractedImageTag {
  sourceRef: string
  alt: string
  placement: QuestionImagePlacement
  optionId?: string
  order: number
}

export interface ParsedRawOption {
  id: string
  text: string
  feedback?: string
}

export interface ParsedRawQuestion {
  index: number
  sourceQuestionId?: string
  questionText: string
  questionType: QuestionType
  options: ParsedRawOption[]
  correctOptionIds: string[]
  explanation: string
  topic: string
  images: ExtractedImageTag[]
}

export interface ParsedExamHtml {
  title: string
  questions: ParsedRawQuestion[]
}

// ── 1. Safe JSON5-subset recursive-descent parser (pure data only, no JS eval) ─

class SafeDataParser {
  private readonly src: string
  private pos = 0

  constructor(src: string) {
    this.src = src
  }

  parse(): unknown {
    this.skipWhitespaceAndComments()
    const value = this.parseValue()
    this.skipWhitespaceAndComments()
    if (this.pos < this.src.length) {
      throw new Error(`Unexpected trailing character "${this.src[this.pos]}" at offset ${this.pos}`)
    }
    return value
  }

  private skipWhitespaceAndComments(): void {
    const len = this.src.length
    while (this.pos < len) {
      const ch = this.src[this.pos]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF') {
        this.pos += 1
        continue
      }
      if (ch === '/' && this.src[this.pos + 1] === '/') {
        this.pos += 2
        while (this.pos < len && this.src[this.pos] !== '\n') this.pos += 1
        continue
      }
      if (ch === '/' && this.src[this.pos + 1] === '*') {
        this.pos += 2
        while (this.pos < len && !(this.src[this.pos] === '*' && this.src[this.pos + 1] === '/')) {
          this.pos += 1
        }
        this.pos += 2
        continue
      }
      break
    }
  }

  private parseValue(): unknown {
    this.skipWhitespaceAndComments()
    const ch = this.src[this.pos]
    if (ch === '{') return this.parseObject()
    if (ch === '[') return this.parseArray()
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString(ch)
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumber()
    if (this.src.startsWith('true', this.pos) && !this.isIdentChar(this.src[this.pos + 4])) {
      this.pos += 4
      return true
    }
    if (this.src.startsWith('false', this.pos) && !this.isIdentChar(this.src[this.pos + 5])) {
      this.pos += 5
      return false
    }
    if (this.src.startsWith('null', this.pos) && !this.isIdentChar(this.src[this.pos + 4])) {
      this.pos += 4
      return null
    }
    if (this.src.startsWith('undefined', this.pos) && !this.isIdentChar(this.src[this.pos + 9])) {
      this.pos += 9
      return undefined
    }
    throw new Error(`Unsupported or unsafe JavaScript expression near offset ${this.pos}`)
  }

  private isIdentChar(ch: string | undefined): boolean {
    if (!ch) return false
    return /[a-zA-Z0-9_$]/.test(ch)
  }

  private parseObject(): Record<string, unknown> {
    this.pos += 1 // skip '{'
    const obj: Record<string, unknown> = {}
    this.skipWhitespaceAndComments()
    if (this.src[this.pos] === '}') {
      this.pos += 1
      return obj
    }

    while (this.pos < this.src.length) {
      this.skipWhitespaceAndComments()
      if (this.src[this.pos] === '}') {
        this.pos += 1
        return obj
      }

      let key: string
      const ch = this.src[this.pos]
      if (ch === '"' || ch === "'" || ch === '`') {
        key = this.parseString(ch)
      } else if (/[a-zA-Z_$]/.test(ch)) {
        const start = this.pos
        while (this.pos < this.src.length && this.isIdentChar(this.src[this.pos])) {
          this.pos += 1
        }
        key = this.src.slice(start, this.pos)
      } else {
        throw new Error(`Expected object key at offset ${this.pos}`)
      }

      this.skipWhitespaceAndComments()
      if (this.src[this.pos] !== ':') {
        throw new Error(`Expected ":" after key "${key}" at offset ${this.pos}`)
      }
      this.pos += 1

      const val = this.parseValue()
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        obj[key] = val
      }

      this.skipWhitespaceAndComments()
      if (this.src[this.pos] === ',') {
        this.pos += 1
        continue
      }
      if (this.src[this.pos] === '}') {
        this.pos += 1
        return obj
      }
      throw new Error(`Expected "," or "}" in object at offset ${this.pos}`)
    }
    throw new Error('Unterminated object literal')
  }

  private parseArray(): unknown[] {
    this.pos += 1 // skip '['
    const arr: unknown[] = []
    this.skipWhitespaceAndComments()
    if (this.src[this.pos] === ']') {
      this.pos += 1
      return arr
    }

    while (this.pos < this.src.length) {
      this.skipWhitespaceAndComments()
      if (this.src[this.pos] === ']') {
        this.pos += 1
        return arr
      }

      arr.push(this.parseValue())
      this.skipWhitespaceAndComments()
      if (this.src[this.pos] === ',') {
        this.pos += 1
        continue
      }
      if (this.src[this.pos] === ']') {
        this.pos += 1
        return arr
      }
      throw new Error(`Expected "," or "]" in array at offset ${this.pos}`)
    }
    throw new Error('Unterminated array literal')
  }

  private parseString(quote: string): string {
    this.pos += 1 // skip opening quote
    let out = ''
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (quote === '`' && ch === '$' && this.src[this.pos + 1] === '{') {
        throw new Error(`Template literal interpolation is not permitted at offset ${this.pos}`)
      }
      if (ch === quote) {
        this.pos += 1
        return out
      }
      if (ch === '\\') {
        this.pos += 1
        const esc = this.src[this.pos]
        if (esc === undefined) throw new Error('Unterminated escape sequence')
        this.pos += 1
        switch (esc) {
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case '\\': out += '\\'; break
          case '"': out += '"'; break
          case "'": out += "'"; break
          case '`': out += '`'; break
          case '/': out += '/'; break
          case '\n': break // line continuation
          case '\r':
            if (this.src[this.pos] === '\n') this.pos += 1
            break
          case 'u': {
            const hex = this.src.slice(this.pos, this.pos + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new Error(`Invalid unicode escape at offset ${this.pos}`)
            }
            out += String.fromCharCode(Number.parseInt(hex, 16))
            this.pos += 4
            break
          }
          case 'x': {
            const hex = this.src.slice(this.pos, this.pos + 2)
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
              throw new Error(`Invalid hex escape at offset ${this.pos}`)
            }
            out += String.fromCharCode(Number.parseInt(hex, 16))
            this.pos += 2
            break
          }
          default:
            out += esc
        }
        continue
      }
      out += ch
      this.pos += 1
    }
    throw new Error('Unterminated string literal')
  }

  private parseNumber(): number {
    const start = this.pos
    if (this.src[this.pos] === '-') this.pos += 1
    while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) this.pos += 1
    if (this.src[this.pos] === '.') {
      this.pos += 1
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) this.pos += 1
    }
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      this.pos += 1
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos += 1
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) this.pos += 1
    }
    const raw = this.src.slice(start, this.pos)
    const num = Number(raw)
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid number "${raw}" at offset ${start}`)
    }
    return num
  }
}

/**
 * Extracts a balanced `[...]` or `{...}` literal starting at `startIndex`
 * while respecting quotes, escapes, and JS comments.
 */
function extractBalancedLiteral(source: string, startIndex: number): string {
  const open = source[startIndex]
  const close = open === '[' ? ']' : open === '{' ? '}' : null
  if (!close) {
    throw new Error(`Expected "[" or "{" at offset ${startIndex}`)
  }

  let depth = 0
  let i = startIndex
  let inQuote: string | null = null

  while (i < source.length) {
    const ch = source[i]

    if (inQuote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === inQuote) {
        inQuote = null
      }
      i += 1
      continue
    }

    if (ch === '/' && source[i + 1] === '/') {
      i += 2
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inQuote = ch
      i += 1
      continue
    }

    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        return source.slice(startIndex, i + 1)
      }
    }
    i += 1
  }

  throw new Error('Unterminated quizData literal in HTML script block')
}

export function extractQuizDataLiteralFromHtml(html: string): unknown {
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  const assignmentRegex =
    /(?:(?:const|let|var)\s+|window\.)(?:quizData|examData|questionsData|questions)\s*=\s*/i

  let match: RegExpExecArray | null
  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptBody = match[1]
    const assignMatch = assignmentRegex.exec(scriptBody)
    if (!assignMatch) continue

    let idx = assignMatch.index + assignMatch[0].length
    while (idx < scriptBody.length && /\s/.test(scriptBody[idx])) idx += 1

    const firstChar = scriptBody[idx]
    if (firstChar !== '[' && firstChar !== '{') continue

    const literal = extractBalancedLiteral(scriptBody, idx)
    return new SafeDataParser(literal).parse()
  }

  throw new Error('Could not find embedded quizData assignment in HTML file')
}

// ── 2. HTML image extraction & clean text normalization ─────────────────────

function decodeBasicHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

function extractAttr(tag: string, attrName: string): string {
  const regex = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = regex.exec(tag)
  return decodeBasicHtmlEntities((m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim())
}

/**
 * Extracts all `<img ...>` references in DOM order and converts the remaining
 * HTML fragment into clean, readable text with deterministic `[Image #N]`
 * placement markers so original image position is preserved.
 */
export function extractImagesAndCleanText(
  rawHtml: string,
  placement: QuestionImagePlacement,
  optionId?: string
): { text: string; images: ExtractedImageTag[] } {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return { text: '', images: [] }
  }

  const images: ExtractedImageTag[] = []
  let order = 0

  const withPlaceholders = rawHtml.replace(/<img\b[^>]*>/gi, (imgTag) => {
    const src = extractAttr(imgTag, 'src')
    const alt = extractAttr(imgTag, 'alt')
    const currentOrder = order
    order += 1

    if (src) {
      images.push({
        sourceRef: src,
        alt,
        placement,
        ...(optionId ? { optionId } : {}),
        order: currentOrder,
      })
    }
    return ` [[image:${placement}${optionId ? `:${optionId}` : ''}:${currentOrder}]] `
  })

  const cleaned = decodeBasicHtmlEntities(
    withPlaceholders
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text: cleaned, images }
}

function optionIndexToId(index: number): string {
  return String.fromCharCode(65 + index) // A, B, C, D...
}

function normalizeCorrectOptionIds(
  rawItem: Record<string, unknown>,
  options: ParsedRawOption[]
): string[] {
  const rawCorrect =
    rawItem.correctOptionIds ??
    rawItem.correctAnswers ??
    rawItem.correctAnswer ??
    rawItem.correct ??
    rawItem.answer ??
    rawItem.answers_correct

  const validIds = new Set(options.map((o) => o.id))
  const list = Array.isArray(rawCorrect)
    ? rawCorrect
    : rawCorrect !== undefined && rawCorrect !== null
      ? [rawCorrect]
      : []

  const resolved: string[] = []
  for (const entry of list) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry < options.length) {
      resolved.push(options[entry].id)
      continue
    }
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (validIds.has(trimmed)) {
        resolved.push(trimmed)
        continue
      }
      const upper = trimmed.toUpperCase()
      if (validIds.has(upper)) {
        resolved.push(upper)
        continue
      }
      // Numeric string index e.g. "0"
      if (/^\d+$/.test(trimmed)) {
        const idx = Number.parseInt(trimmed, 10)
        if (idx >= 0 && idx < options.length) {
          resolved.push(options[idx].id)
          continue
        }
      }
      // Match by option text as last resort
      const byText = options.find((o) => o.text === trimmed)
      if (byText) {
        resolved.push(byText.id)
      }
    }
  }

  return [...new Set(resolved)]
}

function extractHtmlDocumentTitle(html: string, fallbackTitle: string): string {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (titleMatch?.[1]) {
    const clean = decodeBasicHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim()
    if (clean) return clean
  }
  return fallbackTitle
}

export function parseExamHtmlContent(html: string, fallbackTitle: string): ParsedExamHtml {
  const rawData = extractQuizDataLiteralFromHtml(html)

  let rawQuestions: unknown[]
  let embeddedTitle = ''

  if (Array.isArray(rawData)) {
    rawQuestions = rawData
  } else if (rawData && typeof rawData === 'object') {
    const obj = rawData as Record<string, unknown>
    if (typeof obj.title === 'string') embeddedTitle = obj.title.trim()
    const candidate = obj.questions ?? obj.items ?? obj.quizData
    if (!Array.isArray(candidate)) {
      throw new Error('Embedded quizData object does not contain a questions array')
    }
    rawQuestions = candidate
  } else {
    throw new Error('Embedded quizData must be an array or an object with a questions array')
  }

  const title = embeddedTitle || extractHtmlDocumentTitle(html, fallbackTitle)
  const questions: ParsedRawQuestion[] = []

  for (let i = 0; i < rawQuestions.length; i++) {
    const item = rawQuestions[i]
    if (!item || typeof item !== 'object') {
      throw new Error(`Question at index ${i} is not an object`)
    }
    const rec = item as Record<string, unknown>

    const rawQuestionHtml = String(
      rec.questionText ?? rec.question ?? rec.prompt ?? rec.text ?? ''
    )
    const qExtracted = extractImagesAndCleanText(rawQuestionHtml, 'question')

    const rawOptions = Array.isArray(rec.options)
      ? rec.options
      : Array.isArray(rec.choices)
        ? rec.choices
        : Array.isArray(rec.answers)
          ? rec.answers
          : []

    const images: ExtractedImageTag[] = [...qExtracted.images]
    const options: ParsedRawOption[] = []

    const perOptionFeedbackMap =
      rec.optionFeedback && typeof rec.optionFeedback === 'object'
        ? (rec.optionFeedback as Record<string, unknown>)
        : rec.feedback && typeof rec.feedback === 'object'
          ? (rec.feedback as Record<string, unknown>)
          : null

    for (let optIdx = 0; optIdx < rawOptions.length; optIdx++) {
      const rawOpt = rawOptions[optIdx]
      let optId = optionIndexToId(optIdx)
      let rawOptText = ''
      let rawOptFeedback = ''

      if (typeof rawOpt === 'string') {
        rawOptText = rawOpt
      } else if (rawOpt && typeof rawOpt === 'object') {
        const oRec = rawOpt as Record<string, unknown>
        if (typeof oRec.id === 'string' && oRec.id.trim()) {
          optId = oRec.id.trim()
        }
        rawOptText = String(oRec.text ?? oRec.label ?? oRec.content ?? '')
        if (typeof oRec.feedback === 'string') {
          rawOptFeedback = oRec.feedback
        }
      }

      if (!rawOptFeedback && perOptionFeedbackMap) {
        const mapped = perOptionFeedbackMap[optId] ?? perOptionFeedbackMap[String(optIdx)]
        if (typeof mapped === 'string') rawOptFeedback = mapped
      }

      const optTextExtracted = extractImagesAndCleanText(rawOptText, 'option', optId)
      images.push(...optTextExtracted.images)

      let cleanFeedback: string | undefined
      if (rawOptFeedback) {
        const fbExtracted = extractImagesAndCleanText(rawOptFeedback, 'feedback', optId)
        images.push(...fbExtracted.images)
        if (fbExtracted.text) cleanFeedback = fbExtracted.text
      }

      options.push({
        id: optId,
        text: optTextExtracted.text || `Option ${optId}`,
        ...(cleanFeedback ? { feedback: cleanFeedback } : {}),
      })
    }

    const rawExplanationHtml = String(
      rec.explanation ?? rec.overallExplanation ?? rec.rationale ?? ''
    )
    const expExtracted = extractImagesAndCleanText(rawExplanationHtml, 'explanation')
    images.push(...expExtracted.images)

    const correctOptionIds = normalizeCorrectOptionIds(rec, options)

    const rawType = String(rec.questionType ?? rec.type ?? '').trim().toLowerCase()
    const questionType: QuestionType =
      rawType === 'multi_select' ||
      rawType === 'multi-select' ||
      rawType === 'multiple' ||
      correctOptionIds.length > 1
        ? 'multi_select'
        : 'single_choice'

    const topic = String(
      rec.topic ?? rec.domain ?? rec.category ?? 'General'
    ).trim() || 'General'

    const sourceQuestionId =
      typeof rec.questionId === 'string' && rec.questionId.trim()
        ? rec.questionId.trim()
        : typeof rec.id === 'string' && rec.id.trim()
          ? rec.id.trim()
          : undefined

    questions.push({
      index: i,
      sourceQuestionId,
      questionText: qExtracted.text,
      questionType,
      options,
      correctOptionIds,
      explanation: expExtracted.text,
      topic,
      images,
    })
  }

  return { title, questions }
}
