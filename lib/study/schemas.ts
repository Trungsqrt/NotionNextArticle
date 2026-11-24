/**
 * lib/study/schemas.ts — Zod validation schemas & safe DTO mappers
 * ────────────────────────────────────────────────────────────────
 * Enforces strict invariants for all 5 Study System datasets, including:
 * - Modern salted password-hash format validation (rejects unsalted SHA-256 / plaintext)
 * - Ordered answer option integrity & single_choice vs multi_select rules
 * - FSRS card state bounds & ISO timestamp validation
 * - Answer-stripping projection for client-safe prompts
 */

import { z } from 'zod'
import type {
  StudyUser,
  SafeStudyUser,
  ExamCollection,
  StudyQuestion,
  StudyQuestionPrompt,
  FsrsCardSnapshot,
  FsrsCardState,
  ReviewEvent,
} from './types'

const STABLE_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/
const USERNAME_REGEX = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/

// Salted modern KDF hash formats only:
// - scrypt-v1:   scrypt$<saltHex(>=32 chars)>$<derivedKeyHex(>=64 chars)>
// - argon2id-v1: $argon2id$v=19$m=...,t=...,p=...$<saltB64>$<hashB64>
const SCRYPT_HASH_REGEX = /^scrypt\$[0-9a-f]{32,128}\$[0-9a-f]{64,256}$/i
const ARGON2ID_HASH_REGEX = /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=_-]{16,}\$[A-Za-z0-9+/=_-]{32,}$/

export const isoDateTimeSchema = z
  .string()
  .min(1)
  .refine((val) => !Number.isNaN(Date.parse(val)), {
    message: 'Must be a valid ISO-8601 date-time string',
  })

export const stableIdSchema = z
  .string()
  .trim()
  .regex(STABLE_ID_REGEX, 'Must be a stable alphanumeric identifier (2-128 chars)')

export const normalizedUsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    USERNAME_REGEX,
    'Username must be 3-64 lowercase characters (a-z, 0-9, ., _, -)'
  )

export const accessKeyHashVersionSchema = z.enum(['scrypt-v1', 'argon2id-v1'])

export function isValidModernAccessKeyHash(
  hash: string,
  version: 'scrypt-v1' | 'argon2id-v1'
): boolean {
  if (typeof hash !== 'string') return false
  const trimmed = hash.trim()
  if (version === 'scrypt-v1') return SCRYPT_HASH_REGEX.test(trimmed)
  if (version === 'argon2id-v1') return ARGON2ID_HASH_REGEX.test(trimmed)
  return false
}

export const studyUserSchema = z
  .object({
    userId: stableIdSchema,
    username: normalizedUsernameSchema,
    accessKeyHash: z.string().trim().min(32),
    hashVersion: accessKeyHashVersionSchema,
    role: z.enum(['admin', 'student']),
    status: z.enum(['active', 'revoked']),
    credentialVersion: z.number().int().min(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((data, ctx) => {
    if (!isValidModernAccessKeyHash(data.accessKeyHash, data.hashVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accessKeyHash'],
        message: `accessKeyHash does not match required modern salted format for ${data.hashVersion}`,
      })
    }
  })

export const examCollectionSchema = z.object({
  examId: stableIdSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  certificationCategory: z.string().trim().min(1).max(100),
  questionCount: z.number().int().min(0).max(5000),
  status: z.enum(['published', 'draft']),
  createdAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema.optional(),
})

export const questionOptionSchema = z.object({
  id: z.string().trim().min(1).max(16),
  text: z.string().trim().min(1).max(2000),
  feedback: z.string().trim().max(2000).optional(),
})

export const questionImageRefSchema = z.object({
  id: z.string().trim().min(1).max(128),
  notionBlockId: z.string().trim().min(1).max(128).optional(),
  placement: z.enum(['question', 'option', 'feedback', 'explanation']).optional(),
  optionId: z.string().trim().min(1).max(16).optional(),
  order: z.number().int().min(0).optional(),
  originalFilename: z.string().trim().min(1).max(255).optional(),
  sourceRef: z.string().trim().min(1).max(500).optional(),
  sha256: z.string().trim().regex(/^[0-9a-f]{64}$/i).optional(),
  alt: z.string().trim().max(300),
  caption: z.string().trim().max(500).optional(),
})

export const studyQuestionSchema = z
  .object({
    questionId: stableIdSchema,
    examId: stableIdSchema,
    questionText: z.string().trim().min(1).max(8000),
    questionType: z.enum(['single_choice', 'multi_select']),
    options: z.array(questionOptionSchema).min(2).max(10),
    correctOptionIds: z.array(z.string().trim().min(1).max(16)).min(1).max(10),
    explanation: z.string().trim().max(8000),
    imageRefs: z.array(questionImageRefSchema).max(10).default([]),
    topic: z.string().trim().min(1).max(150),
    status: z.enum(['published', 'draft', 'retired']),
    contentVersion: z.number().int().min(1),
    updatedAt: isoDateTimeSchema.optional(),
  })
  .superRefine((q, ctx) => {
    const optionIds = q.options.map((o) => o.id)
    const uniqueOptionIds = new Set(optionIds)
    if (uniqueOptionIds.size !== optionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Answer option IDs must be unique within a question',
      })
    }

    const uniqueCorrectIds = new Set(q.correctOptionIds)
    if (uniqueCorrectIds.size !== q.correctOptionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctOptionIds'],
        message: 'correctOptionIds must not contain duplicates',
      })
    }

    for (const cid of q.correctOptionIds) {
      if (!uniqueOptionIds.has(cid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correctOptionIds'],
          message: `Correct option ID "${cid}" does not match any defined option`,
        })
      }
    }

    if (q.questionType === 'single_choice' && q.correctOptionIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctOptionIds'],
        message: 'single_choice questions must have exactly one correct option ID',
      })
    }
  })

export const fsrsCardSnapshotSchema = z.object({
  state: z.enum(['New', 'Learning', 'Review', 'Relearning']),
  due: isoDateTimeSchema,
  stability: z.number().finite().min(0),
  difficulty: z.number().finite().min(0),
  elapsedDays: z.number().finite().min(0),
  scheduledDays: z.number().finite().min(0),
  reps: z.number().int().min(0),
  lapses: z.number().int().min(0),
  lastReview: isoDateTimeSchema.nullable(),
  learningSteps: z.number().int().min(0).optional(),
})

export function buildCardStateKey(userId: string, questionId: string): string {
  return `${userId.trim()}::${questionId.trim()}`
}

export const fsrsCardStateSchema = z
  .object({
    stateKey: z.string().trim().min(5).max(260),
    userId: stableIdSchema,
    questionId: stableIdSchema,
    card: fsrsCardSnapshotSchema,
    due: isoDateTimeSchema,
    lastReview: isoDateTimeSchema.nullable(),
    revision: z.number().int().min(1),
    schedulerVersion: z.string().trim().min(1).max(64),
    parametersVersion: z.string().trim().min(1).max(64),
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((data, ctx) => {
    const expectedKey = buildCardStateKey(data.userId, data.questionId)
    if (data.stateKey !== expectedKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stateKey'],
        message: `stateKey must equal "${expectedKey}"`,
      })
    }
  })

export const studyRatingSchema = z.enum(['again', 'hard', 'good', 'easy'])

export const reviewEventSchema = z.object({
  eventId: stableIdSchema,
  userId: stableIdSchema,
  questionId: stableIdSchema,
  reviewedAt: isoDateTimeSchema,
  rating: studyRatingSchema,
  previousState: fsrsCardSnapshotSchema,
  resultingState: fsrsCardSnapshotSchema,
  schedulerVersion: z.string().trim().min(1).max(64),
  parametersVersion: z.string().trim().min(1).max(64),
})

/** Projects a StudyUser into a secret-free user object */
export function toSafeStudyUser(user: StudyUser): SafeStudyUser {
  const { accessKeyHash: _h, hashVersion: _v, ...safe } = user
  return safe
}

/** Projects a StudyQuestion into a client-safe prompt without answer keys or explanations */
export function toQuestionPrompt(question: StudyQuestion): StudyQuestionPrompt {
  return {
    questionId: question.questionId,
    examId: question.examId,
    questionText: question.questionText,
    questionType: question.questionType,
    options: question.options.map(({ id, text }) => ({ id, text })),
    imageRefs: question.imageRefs.map((img) => ({ ...img })),
    topic: question.topic,
    contentVersion: question.contentVersion,
  }
}

export function normalizeUsername(raw: string): string {
  return normalizedUsernameSchema.parse(raw)
}

type ParsedStudyUser = z.infer<typeof studyUserSchema>
type ParsedExamCollection = z.infer<typeof examCollectionSchema>
type ParsedStudyQuestion = z.infer<typeof studyQuestionSchema>
type ParsedFsrsCardSnapshot = z.infer<typeof fsrsCardSnapshotSchema>
type ParsedFsrsCardState = z.infer<typeof fsrsCardStateSchema>
type ParsedReviewEvent = z.infer<typeof reviewEventSchema>

// Compile-time structural alignment checks between Zod schemas and domain types
const _assertUser: (u: ParsedStudyUser) => StudyUser = (u) => u
const _assertExam: (e: ParsedExamCollection) => ExamCollection = (e) => e
const _assertQuestion: (q: ParsedStudyQuestion) => StudyQuestion = (q) => q
const _assertSnapshot: (s: ParsedFsrsCardSnapshot) => FsrsCardSnapshot = (s) => s
const _assertCardState: (c: ParsedFsrsCardState) => FsrsCardState = (c) => c
const _assertReviewEvent: (r: ParsedReviewEvent) => ReviewEvent = (r) => r
void [_assertUser, _assertExam, _assertQuestion, _assertSnapshot, _assertCardState, _assertReviewEvent]
