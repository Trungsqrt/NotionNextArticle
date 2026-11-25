/**
 * lib/study/repositories/mappers.ts — Pure Notion property mappers & chunking
 * ───────────────────────────────────────────────────────────────────────────
 * Maps between validated Study System domain models and Notion database page
 * properties while respecting Notion's 2,000-character per-rich_text-element
 * limit via deterministic chunking.
 */

import type {
  StudyUser,
  ExamCollection,
  StudyQuestion,
  FsrsCardState,
  ReviewEvent,
  StudyBookmarkRecord,
} from '../types'
import {
  studyUserSchema,
  examCollectionSchema,
  studyQuestionSchema,
  fsrsCardStateSchema,
  reviewEventSchema,
  studyBookmarkRecordSchema,
  buildCardStateKey,
  buildBookmarkKey,
} from '../schemas'
import type { NotionPageRecord } from '../notion-client'
import { DataIntegrityError } from './interfaces'

export const NOTION_MAX_RICH_TEXT_CHARS = 2000

/**
 * Exact Notion property names for each private "Study System" database.
 * Keep in sync with docs/study-system-notion-setup.md.
 */
export const USER_PROPS = {
  userId: 'User ID',
  username: 'Username',
  accessKeyHash: 'Access Key Hash',
  hashVersion: 'Hash Version',
  role: 'Role',
  status: 'Status',
  credentialVersion: 'Credential Version',
  createdAt: 'Created At',
  updatedAt: 'Updated At',
} as const

export const EXAM_PROPS = {
  examId: 'Exam ID',
  title: 'Title',
  description: 'Description',
  certificationCategory: 'Certification Category',
  questionCount: 'Question Count',
  status: 'Status',
} as const

export const QUESTION_PROPS = {
  questionId: 'Question ID',
  examId: 'Exam ID',
  questionText: 'Question Text',
  questionType: 'Question Type',
  optionsJson: 'Options JSON',
  correctOptionIdsJson: 'Correct Option IDs',
  explanation: 'Explanation',
  imageRefsJson: 'Image Refs JSON',
  topic: 'Topic',
  status: 'Status',
  contentVersion: 'Content Version',
} as const

export const CARD_STATE_PROPS = {
  stateKey: 'State Key',
  userId: 'User ID',
  questionId: 'Question ID',
  cardStateJson: 'Card State JSON',
  due: 'Due',
  lastReview: 'Last Review',
  revision: 'Revision',
  schedulerVersion: 'Scheduler Version',
  parametersVersion: 'Parameters Version',
  updatedAt: 'Updated At',
} as const

export const REVIEW_EVENT_PROPS = {
  eventId: 'Event ID',
  userId: 'User ID',
  questionId: 'Question ID',
  reviewedAt: 'Reviewed At',
  rating: 'Rating',
  previousStateJson: 'Previous State JSON',
  resultingStateJson: 'Resulting State JSON',
  schedulerVersion: 'Scheduler Version',
  parametersVersion: 'Parameters Version',
} as const

export const BOOKMARK_PROPS = {
  bookmarkKey: 'Bookmark Key',
  userId: 'User ID',
  examId: 'Exam ID',
  bookmarkedQuestionsJson: 'Bookmarked Questions JSON',
  updatedAt: 'Updated At',
} as const

// ── Notion rich_text 2,000-character chunking helpers ───────────────────────

export interface NotionRichTextInput {
  type: 'text'
  text: { content: string }
}

/**
 * Splits a string into <=2,000-char Notion rich_text elements without altering
 * the concatenated text.
 */
export function toChunkedRichText(
  value: string,
  maxChars: number = NOTION_MAX_RICH_TEXT_CHARS
): NotionRichTextInput[] {
  if (!value) return []
  const chunks: NotionRichTextInput[] = []
  for (let i = 0; i < value.length; i += maxChars) {
    chunks.push({
      type: 'text',
      text: { content: value.slice(i, i + maxChars) },
    })
  }
  return chunks
}

/** Concatenates Notion title or rich_text arrays back into the original string. */
export function fromChunkedRichText(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return ''
  const record = prop as Record<string, unknown>
  const arr = Array.isArray(record.title)
    ? record.title
    : Array.isArray(record.rich_text)
      ? record.rich_text
      : []

  return arr
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const r = item as { plain_text?: unknown; text?: { content?: unknown } }
      if (typeof r.plain_text === 'string') return r.plain_text
      if (typeof r.text?.content === 'string') return r.text.content
      return ''
    })
    .join('')
}

function readSelect(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return ''
  const p = prop as { select?: { name?: unknown }; status?: { name?: unknown } }
  if (typeof p.select?.name === 'string') return p.select.name.trim()
  if (typeof p.status?.name === 'string') return p.status.name.trim()
  return ''
}

function readNumber(prop: unknown): number | null {
  if (!prop || typeof prop !== 'object') return null
  const n = (prop as { number?: unknown }).number
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function readDate(prop: unknown): string | null {
  if (!prop || typeof prop !== 'object') return null
  const start = (prop as { date?: { start?: unknown } | null }).date?.start
  return typeof start === 'string' && start.trim() ? start.trim() : null
}

function parseJsonProperty(raw: string, fieldName: string, recordId: string): unknown {
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new DataIntegrityError(
      `Invalid JSON in Notion property "${fieldName}" for record "${recordId}"`
    )
  }
}

function titleProp(value: string): Record<string, unknown> {
  return { title: toChunkedRichText(value) }
}

function richTextProp(value: string): Record<string, unknown> {
  return { rich_text: toChunkedRichText(value) }
}

function selectProp(value: string): Record<string, unknown> {
  return { select: { name: value } }
}

function numberProp(value: number): Record<string, unknown> {
  return { number: value }
}

function dateProp(iso: string | null): Record<string, unknown> {
  return { date: iso ? { start: iso } : null }
}

// ── 1. StudyUser mappers ────────────────────────────────────────────────────

export function mapNotionPageToStudyUser(page: NotionPageRecord): StudyUser {
  const props = page.properties || {}
  const candidate = {
    userId: fromChunkedRichText(props[USER_PROPS.userId]).trim(),
    username: fromChunkedRichText(props[USER_PROPS.username]).trim().toLowerCase(),
    accessKeyHash: fromChunkedRichText(props[USER_PROPS.accessKeyHash]).trim(),
    hashVersion: readSelect(props[USER_PROPS.hashVersion]),
    role: readSelect(props[USER_PROPS.role]).toLowerCase(),
    status: readSelect(props[USER_PROPS.status]).toLowerCase(),
    credentialVersion: readNumber(props[USER_PROPS.credentialVersion]),
    createdAt:
      readDate(props[USER_PROPS.createdAt]) || page.created_time || '',
    updatedAt:
      readDate(props[USER_PROPS.updatedAt]) || page.last_edited_time || '',
  }

  const parsed = studyUserSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new DataIntegrityError(
      `Invalid StudyUser record (${page.id}): ${parsed.error.issues[0]?.message || 'schema mismatch'}`
    )
  }
  return parsed.data
}

export function mapStudyUserToNotionProperties(user: StudyUser): Record<string, unknown> {
  const valid = studyUserSchema.parse(user)
  return {
    [USER_PROPS.userId]: titleProp(valid.userId),
    [USER_PROPS.username]: richTextProp(valid.username),
    [USER_PROPS.accessKeyHash]: richTextProp(valid.accessKeyHash),
    [USER_PROPS.hashVersion]: selectProp(valid.hashVersion),
    [USER_PROPS.role]: selectProp(valid.role),
    [USER_PROPS.status]: selectProp(valid.status),
    [USER_PROPS.credentialVersion]: numberProp(valid.credentialVersion),
    [USER_PROPS.createdAt]: dateProp(valid.createdAt),
    [USER_PROPS.updatedAt]: dateProp(valid.updatedAt),
  }
}

// ── 2. ExamCollection mappers ───────────────────────────────────────────────

export function mapNotionPageToExamCollection(page: NotionPageRecord): ExamCollection {
  const props = page.properties || {}
  const candidate = {
    examId: fromChunkedRichText(props[EXAM_PROPS.examId]).trim(),
    title: fromChunkedRichText(props[EXAM_PROPS.title]).trim(),
    description: fromChunkedRichText(props[EXAM_PROPS.description]).trim(),
    certificationCategory: readSelect(props[EXAM_PROPS.certificationCategory]),
    questionCount: readNumber(props[EXAM_PROPS.questionCount]) ?? 0,
    status: readSelect(props[EXAM_PROPS.status]).toLowerCase(),
    ...(page.created_time ? { createdAt: page.created_time } : {}),
    ...(page.last_edited_time ? { updatedAt: page.last_edited_time } : {}),
  }

  const parsed = examCollectionSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new DataIntegrityError(
      `Invalid ExamCollection record (${page.id}): ${parsed.error.issues[0]?.message || 'schema mismatch'}`
    )
  }
  return parsed.data
}

export function mapExamCollectionToNotionProperties(
  exam: ExamCollection
): Record<string, unknown> {
  const valid = examCollectionSchema.parse(exam)
  return {
    [EXAM_PROPS.examId]: titleProp(valid.examId),
    [EXAM_PROPS.title]: richTextProp(valid.title),
    [EXAM_PROPS.description]: richTextProp(valid.description),
    [EXAM_PROPS.certificationCategory]: selectProp(valid.certificationCategory),
    [EXAM_PROPS.questionCount]: numberProp(valid.questionCount),
    [EXAM_PROPS.status]: selectProp(valid.status),
  }
}

// ── 3. StudyQuestion mappers ────────────────────────────────────────────────

export function mapNotionPageToStudyQuestion(page: NotionPageRecord): StudyQuestion {
  const props = page.properties || {}
  const rawOptions = fromChunkedRichText(props[QUESTION_PROPS.optionsJson])
  const rawCorrect = fromChunkedRichText(props[QUESTION_PROPS.correctOptionIdsJson])
  const rawImages = fromChunkedRichText(props[QUESTION_PROPS.imageRefsJson])

  const options = parseJsonProperty(rawOptions, QUESTION_PROPS.optionsJson, page.id)
  const correctOptionIds = parseJsonProperty(
    rawCorrect,
    QUESTION_PROPS.correctOptionIdsJson,
    page.id
  )
  const imageRefs = rawImages.trim()
    ? parseJsonProperty(rawImages, QUESTION_PROPS.imageRefsJson, page.id)
    : []

  const candidate = {
    questionId: fromChunkedRichText(props[QUESTION_PROPS.questionId]).trim(),
    examId: fromChunkedRichText(props[QUESTION_PROPS.examId]).trim(),
    questionText: fromChunkedRichText(props[QUESTION_PROPS.questionText]).trim(),
    questionType: readSelect(props[QUESTION_PROPS.questionType]).toLowerCase(),
    options,
    correctOptionIds,
    explanation: fromChunkedRichText(props[QUESTION_PROPS.explanation]).trim(),
    imageRefs,
    topic: readSelect(props[QUESTION_PROPS.topic]) || fromChunkedRichText(props[QUESTION_PROPS.topic]).trim(),
    status: readSelect(props[QUESTION_PROPS.status]).toLowerCase(),
    contentVersion: readNumber(props[QUESTION_PROPS.contentVersion]) ?? 1,
    ...(page.last_edited_time ? { updatedAt: page.last_edited_time } : {}),
  }

  const parsed = studyQuestionSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new DataIntegrityError(
      `Invalid StudyQuestion record (${page.id}): ${parsed.error.issues[0]?.message || 'schema mismatch'}`
    )
  }
  return parsed.data
}

export function mapStudyQuestionToNotionProperties(
  question: StudyQuestion
): Record<string, unknown> {
  const valid = studyQuestionSchema.parse(question)
  return {
    [QUESTION_PROPS.questionId]: titleProp(valid.questionId),
    [QUESTION_PROPS.examId]: richTextProp(valid.examId),
    [QUESTION_PROPS.questionText]: richTextProp(valid.questionText),
    [QUESTION_PROPS.questionType]: selectProp(valid.questionType),
    [QUESTION_PROPS.optionsJson]: richTextProp(JSON.stringify(valid.options)),
    [QUESTION_PROPS.correctOptionIdsJson]: richTextProp(
      JSON.stringify(valid.correctOptionIds)
    ),
    [QUESTION_PROPS.explanation]: richTextProp(valid.explanation),
    [QUESTION_PROPS.imageRefsJson]: richTextProp(
      valid.imageRefs.length > 0 ? JSON.stringify(valid.imageRefs) : ''
    ),
    [QUESTION_PROPS.topic]: selectProp(valid.topic),
    [QUESTION_PROPS.status]: selectProp(valid.status),
    [QUESTION_PROPS.contentVersion]: numberProp(valid.contentVersion),
  }
}

// ── 4. FsrsCardState mappers ────────────────────────────────────────────────

export function mapNotionPageToFsrsCardState(page: NotionPageRecord): FsrsCardState {
  const props = page.properties || {}
  const userId = fromChunkedRichText(props[CARD_STATE_PROPS.userId]).trim()
  const questionId = fromChunkedRichText(props[CARD_STATE_PROPS.questionId]).trim()
  const stateKey =
    fromChunkedRichText(props[CARD_STATE_PROPS.stateKey]).trim() ||
    (userId && questionId ? buildCardStateKey(userId, questionId) : '')

  const rawCardJson = fromChunkedRichText(props[CARD_STATE_PROPS.cardStateJson])
  const card = parseJsonProperty(rawCardJson, CARD_STATE_PROPS.cardStateJson, page.id)

  const candidate = {
    stateKey,
    userId,
    questionId,
    card,
    due: readDate(props[CARD_STATE_PROPS.due]) || '',
    lastReview: readDate(props[CARD_STATE_PROPS.lastReview]),
    revision: readNumber(props[CARD_STATE_PROPS.revision]),
    schedulerVersion: fromChunkedRichText(props[CARD_STATE_PROPS.schedulerVersion]).trim(),
    parametersVersion: fromChunkedRichText(props[CARD_STATE_PROPS.parametersVersion]).trim(),
    updatedAt:
      readDate(props[CARD_STATE_PROPS.updatedAt]) || page.last_edited_time || '',
  }

  const parsed = fsrsCardStateSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new DataIntegrityError(
      `Invalid FsrsCardState record (${page.id}): ${parsed.error.issues[0]?.message || 'schema mismatch'}`
    )
  }
  return parsed.data
}

export function mapFsrsCardStateToNotionProperties(
  cardState: FsrsCardState
): Record<string, unknown> {
  const valid = fsrsCardStateSchema.parse(cardState)
  return {
    [CARD_STATE_PROPS.stateKey]: titleProp(valid.stateKey),
    [CARD_STATE_PROPS.userId]: richTextProp(valid.userId),
    [CARD_STATE_PROPS.questionId]: richTextProp(valid.questionId),
    [CARD_STATE_PROPS.cardStateJson]: richTextProp(JSON.stringify(valid.card)),
    [CARD_STATE_PROPS.due]: dateProp(valid.due),
    [CARD_STATE_PROPS.lastReview]: dateProp(valid.lastReview),
    [CARD_STATE_PROPS.revision]: numberProp(valid.revision),
    [CARD_STATE_PROPS.schedulerVersion]: richTextProp(valid.schedulerVersion),
    [CARD_STATE_PROPS.parametersVersion]: richTextProp(valid.parametersVersion),
    [CARD_STATE_PROPS.updatedAt]: dateProp(valid.updatedAt),
  }
}

// ── 5. ReviewEvent mappers ──────────────────────────────────────────────────

export function mapNotionPageToReviewEvent(page: NotionPageRecord): ReviewEvent {
  const props = page.properties || {}
  const prevState = parseJsonProperty(
    fromChunkedRichText(props[REVIEW_EVENT_PROPS.previousStateJson]),
    REVIEW_EVENT_PROPS.previousStateJson,
    page.id
  )
  const nextState = parseJsonProperty(
    fromChunkedRichText(props[REVIEW_EVENT_PROPS.resultingStateJson]),
    REVIEW_EVENT_PROPS.resultingStateJson,
    page.id
  )

  const candidate = {
    eventId: fromChunkedRichText(props[REVIEW_EVENT_PROPS.eventId]).trim(),
    userId: fromChunkedRichText(props[REVIEW_EVENT_PROPS.userId]).trim(),
    questionId: fromChunkedRichText(props[REVIEW_EVENT_PROPS.questionId]).trim(),
    reviewedAt: readDate(props[REVIEW_EVENT_PROPS.reviewedAt]) || '',
    rating: readSelect(props[REVIEW_EVENT_PROPS.rating]).toLowerCase(),
    previousState: prevState,
    resultingState: nextState,
    schedulerVersion: fromChunkedRichText(props[REVIEW_EVENT_PROPS.schedulerVersion]).trim(),
    parametersVersion: fromChunkedRichText(props[REVIEW_EVENT_PROPS.parametersVersion]).trim(),
  }

  const parsed = reviewEventSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new DataIntegrityError(
      `Invalid ReviewEvent record (${page.id}): ${parsed.error.issues[0]?.message || 'schema mismatch'}`
    )
  }
  return parsed.data
}

export function mapReviewEventToNotionProperties(
  event: ReviewEvent
): Record<string, unknown> {
  const valid = reviewEventSchema.parse(event)
  return {
    [REVIEW_EVENT_PROPS.eventId]: titleProp(valid.eventId),
    [REVIEW_EVENT_PROPS.userId]: richTextProp(valid.userId),
    [REVIEW_EVENT_PROPS.questionId]: richTextProp(valid.questionId),
    [REVIEW_EVENT_PROPS.reviewedAt]: dateProp(valid.reviewedAt),
    [REVIEW_EVENT_PROPS.rating]: selectProp(valid.rating),
    [REVIEW_EVENT_PROPS.previousStateJson]: richTextProp(
      JSON.stringify(valid.previousState)
    ),
    [REVIEW_EVENT_PROPS.resultingStateJson]: richTextProp(
      JSON.stringify(valid.resultingState)
    ),
    [REVIEW_EVENT_PROPS.schedulerVersion]: richTextProp(valid.schedulerVersion),
    [REVIEW_EVENT_PROPS.parametersVersion]: richTextProp(valid.parametersVersion),
  }
}

// ── 6. StudyBookmarkRecord mappers ──────────────────────────────────────────

export function mapNotionPageToStudyBookmarkRecord(
  page: NotionPageRecord
): StudyBookmarkRecord {
  const props = page.properties || {}
  const userId = fromChunkedRichText(props[BOOKMARK_PROPS.userId]).trim()
  const examId = fromChunkedRichText(props[BOOKMARK_PROPS.examId]).trim()
  const bookmarkKey =
    fromChunkedRichText(props[BOOKMARK_PROPS.bookmarkKey]).trim() ||
    (userId && examId ? buildBookmarkKey(userId, examId) : '')

  const rawJson = fromChunkedRichText(props[BOOKMARK_PROPS.bookmarkedQuestionsJson])
  const parsedIds = rawJson.trim()
    ? parseJsonProperty(rawJson, BOOKMARK_PROPS.bookmarkedQuestionsJson, page.id)
    : []

  const questionIds = Array.isArray(parsedIds)
    ? [...new Set(parsedIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))]
    : parsedIds

  const candidate = {
    bookmarkKey,
    userId,
    examId,
    questionIds,
    updatedAt: readDate(props[BOOKMARK_PROPS.updatedAt]) || page.last_edited_time || '',
  }

  const parsed = studyBookmarkRecordSchema.safeParse(candidate)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const fieldPath = issue?.path?.length ? `${issue.path.join('.')}: ` : ''
    throw new DataIntegrityError(
      `Invalid StudyBookmarkRecord (${page.id}): ${fieldPath}${issue?.message || 'schema mismatch'}`
    )
  }
  return parsed.data
}

export function mapStudyBookmarkRecordToNotionProperties(
  record: StudyBookmarkRecord
): Record<string, unknown> {
  const valid = studyBookmarkRecordSchema.parse(record)
  return {
    [BOOKMARK_PROPS.bookmarkKey]: titleProp(valid.bookmarkKey),
    [BOOKMARK_PROPS.userId]: richTextProp(valid.userId),
    [BOOKMARK_PROPS.examId]: richTextProp(valid.examId),
    [BOOKMARK_PROPS.bookmarkedQuestionsJson]: richTextProp(JSON.stringify(valid.questionIds)),
    [BOOKMARK_PROPS.updatedAt]: dateProp(valid.updatedAt),
  }
}
