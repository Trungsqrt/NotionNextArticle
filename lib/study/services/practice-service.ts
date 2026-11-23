/**
 * lib/study/services/practice-service.ts — Practice Mode (isolated from FSRS)
 * ────────────────────────────────────────────────────────────────────────────
 * Serves sanitized question prompts and performs immediate server-side answer
 * checking with detailed explanations. Practice checks intentionally NEVER
 * mutate FSRS card state or ReviewEvents.
 */

import type { StudyRepositories } from '../repositories'
import type { ExamCollection, StudyQuestionPrompt } from '../types'
import { toQuestionPrompt } from '../schemas'
import { gradeQuestionAnswer, type GradedQuestionResult } from './grading'

export interface PracticeExamPayload {
  exam: ExamCollection
  questions: StudyQuestionPrompt[]
}

export async function getPracticeExamPayload(
  examId: string,
  repos: StudyRepositories
): Promise<PracticeExamPayload | null> {
  const exam = await repos.exams.findByExamId(examId)
  if (!exam || exam.status !== 'published') return null

  const questions = await repos.questions.listByExamId(exam.examId, { status: 'published' })
  return {
    exam,
    questions: questions.map(toQuestionPrompt),
  }
}

export async function checkPracticeAnswer(
  questionId: string,
  selectedOptionIds: string[],
  repos: StudyRepositories
): Promise<GradedQuestionResult | null> {
  const question = await repos.questions.findByQuestionId(questionId)
  if (!question || question.status !== 'published') return null
  return gradeQuestionAnswer(question, selectedOptionIds)
}
