/**
 * lib/study/services/grading.ts — Pure server-side answer grading
 * ────────────────────────────────────────────────────────────────
 * Grades single_choice and multi_select answers using exact set matching.
 * Never exposes answer keys prior to submission.
 */

import type { StudyQuestion } from '../types'

export interface OptionFeedbackItem {
  optionId: string
  feedback: string
}

export interface GradedQuestionResult {
  questionId: string
  questionType: StudyQuestion['questionType']
  selectedOptionIds: string[]
  correctOptionIds: string[]
  isCorrect: boolean
  isSkipped: boolean
  explanation: string
  optionFeedback: OptionFeedbackItem[]
}

export function gradeQuestionAnswer(
  question: StudyQuestion,
  rawSelectedOptionIds: string[]
): GradedQuestionResult {
  const validOptionIds = new Set(question.options.map((o) => o.id))
  const normalizedSelected = [
    ...new Set(
      (rawSelectedOptionIds || [])
        .map((id) => String(id || '').trim())
        .filter((id) => validOptionIds.has(id))
    ),
  ]

  const isSkipped = normalizedSelected.length === 0
  const expectedSet = new Set(question.correctOptionIds)
  const isCorrect =
    !isSkipped &&
    normalizedSelected.length === expectedSet.size &&
    normalizedSelected.every((id) => expectedSet.has(id))

  const optionFeedback: OptionFeedbackItem[] = question.options
    .filter((o) => typeof o.feedback === 'string' && o.feedback.trim().length > 0)
    .map((o) => ({ optionId: o.id, feedback: o.feedback!.trim() }))

  return {
    questionId: question.questionId,
    questionType: question.questionType,
    selectedOptionIds: normalizedSelected,
    correctOptionIds: [...question.correctOptionIds],
    isCorrect,
    isSkipped,
    explanation: question.explanation,
    optionFeedback,
  }
}
