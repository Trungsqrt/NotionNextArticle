/**
 * lib/study/services/exam-service.ts — Timed CSA Mock Exam simulation
 * ────────────────────────────────────────────────────────────────────
 * Starts a timed exam session with an HMAC-signed `examToken` (never exposing
 * answer keys before submission) and grades the entire exam server-side on
 * submission, returning score, counts, topic breakdown, and post-exam review.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { StudyRepositories } from '../repositories'
import type { ExamCollection, StudyQuestionPrompt } from '../types'
import { toQuestionPrompt } from '../schemas'
import { gradeQuestionAnswer, type GradedQuestionResult } from './grading'

export const DEFAULT_EXAM_DURATION_MINUTES = 90
export const EXAM_PASS_THRESHOLD_PERCENT = 70

interface ExamTokenPayload {
  sub: string
  examId: string
  questionIds: string[]
  iat: number
  exp: number
}

export interface StartedExamSession {
  exam: ExamCollection
  examToken: string
  startedAt: string
  expiresAt: string
  durationMinutes: number
  questions: StudyQuestionPrompt[]
}

export interface ExamTopicBreakdown {
  topic: string
  total: number
  correct: number
  incorrect: number
  skipped: number
  accuracyPercent: number
}

export interface ExamQuestionReviewItem extends GradedQuestionResult {
  prompt: StudyQuestionPrompt
}

export interface GradedExamResult {
  examId: string
  submittedAt: string
  totalQuestions: number
  correctCount: number
  incorrectCount: number
  skippedCount: number
  scorePercent: number
  passed: boolean
  passThresholdPercent: number
  topicBreakdown: ExamTopicBreakdown[]
  reviewItems: ExamQuestionReviewItem[]
}

function signExamToken(payload: ExamTokenPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const input = `exam1.${encoded}`
  const sig = createHmac('sha256', secret).update(input).digest().toString('base64url')
  return `${input}.${sig}`
}

function verifyExamToken(
  token: string,
  secret: string
): { ok: true; payload: ExamTokenPayload } | { ok: false; reason: string } {
  const parts = (token || '').split('.')
  if (parts.length !== 3 || parts[0] !== 'exam1') {
    return { ok: false, reason: 'malformed' }
  }
  const [, encoded, providedSig] = parts
  const expectedSig = createHmac('sha256', secret).update(`exam1.${encoded}`).digest()
  let providedBuf: Buffer
  try {
    providedBuf = Buffer.from(providedSig, 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (providedBuf.length !== expectedSig.length || !timingSafeEqual(providedBuf, expectedSig)) {
    return { ok: false, reason: 'invalid_signature' }
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ExamTokenPayload
    if (
      !parsed ||
      typeof parsed.sub !== 'string' ||
      typeof parsed.examId !== 'string' ||
      !Array.isArray(parsed.questionIds) ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number'
    ) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, payload: parsed }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

export async function startExamSession(
  input: {
    userId: string
    examId: string
    durationMinutes?: number
    sessionSecret: string
    nowSec?: number
  },
  repos: StudyRepositories
): Promise<StartedExamSession | null> {
  const exam = await repos.exams.findByExamId(input.examId)
  if (!exam || exam.status !== 'published') return null

  const questions = await repos.questions.listByExamId(exam.examId, { status: 'published' })
  if (questions.length === 0) return null

  const durationMinutes = Math.min(
    Math.max(input.durationMinutes ?? DEFAULT_EXAM_DURATION_MINUTES, 5),
    180
  )
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000)
  // Allow 10-minute grace window on server submission for network latency / auto-submit
  const expSec = nowSec + (durationMinutes + 10) * 60

  const token = signExamToken(
    {
      sub: input.userId,
      examId: exam.examId,
      questionIds: questions.map((q) => q.questionId),
      iat: nowSec,
      exp: expSec,
    },
    input.sessionSecret
  )

  return {
    exam,
    examToken: token,
    startedAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: new Date((nowSec + durationMinutes * 60) * 1000).toISOString(),
    durationMinutes,
    questions: questions.map(toQuestionPrompt),
  }
}

export async function submitExamSession(
  input: {
    userId: string
    examToken: string
    answers: Record<string, string[]>
    sessionSecret: string
    nowSec?: number
  },
  repos: StudyRepositories
): Promise<GradedExamResult> {
  const verified = verifyExamToken(input.examToken, input.sessionSecret)
  if (!verified.ok) {
    throw new Error('Invalid exam session token')
  }

  const { payload } = verified
  if (payload.sub !== input.userId) {
    throw new Error('Exam session belongs to another user')
  }

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000)
  if (nowSec > payload.exp) {
    throw new Error('Exam session has expired')
  }

  const fetchedQuestions = await repos.questions.listByQuestionIds(payload.questionIds)
  const byId = new Map(fetchedQuestions.map((q) => [q.questionId, q]))

  let correctCount = 0
  let incorrectCount = 0
  let skippedCount = 0
  const topicStats = new Map<string, { total: number; correct: number; incorrect: number; skipped: number }>()
  const reviewItems: ExamQuestionReviewItem[] = []

  for (const qId of payload.questionIds) {
    const q = byId.get(qId)
    if (!q) continue

    const selected = Array.isArray(input.answers?.[qId]) ? input.answers[qId] : []
    const graded = gradeQuestionAnswer(q, selected)

    const t = topicStats.get(q.topic) || { total: 0, correct: 0, incorrect: 0, skipped: 0 }
    t.total += 1

    if (graded.isSkipped) {
      skippedCount += 1
      t.skipped += 1
    } else if (graded.isCorrect) {
      correctCount += 1
      t.correct += 1
    } else {
      incorrectCount += 1
      t.incorrect += 1
    }

    topicStats.set(q.topic, t)
    reviewItems.push({
      ...graded,
      prompt: toQuestionPrompt(q),
    })
  }

  const totalQuestions = reviewItems.length
  const scorePercent =
    totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0

  const topicBreakdown: ExamTopicBreakdown[] = [...topicStats.entries()]
    .map(([topic, s]) => ({
      topic,
      total: s.total,
      correct: s.correct,
      incorrect: s.incorrect,
      skipped: s.skipped,
      accuracyPercent: s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0,
    }))
    .sort((a, b) => a.topic.localeCompare(b.topic))

  return {
    examId: payload.examId,
    submittedAt: new Date(nowSec * 1000).toISOString(),
    totalQuestions,
    correctCount,
    incorrectCount,
    skippedCount,
    scorePercent,
    passed: scorePercent >= EXAM_PASS_THRESHOLD_PERCENT,
    passThresholdPercent: EXAM_PASS_THRESHOLD_PERCENT,
    topicBreakdown,
    reviewItems,
  }
}
