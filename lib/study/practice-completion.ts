/**
 * lib/study/practice-completion.ts — Pure Practice Mode completion calculations
 * ─────────────────────────────────────────────────────────────────────────────
 * Derives accuracy, counts, first-unanswered navigation index, and completion
 * eligibility strictly from existing Practice Mode client state.
 */

import type { GradedQuestionResult } from './services/grading'

export interface PracticeQuestionRef {
  questionId: string
}

export interface PracticeCompletionSummary {
  totalQuestions: number
  completedCount: number
  remainingUnansweredCount: number
  firstUnansweredIndex: number
  correctCount: number
  incorrectCount: number
  bookmarkedCount: number
  accuracyPercent: number
  allGraded: boolean
}

export function computePracticeCompletionSummary(
  allQuestions: readonly PracticeQuestionRef[],
  results: Readonly<Record<string, GradedQuestionResult>>,
  bookmarks: Readonly<Record<string, boolean>>
): PracticeCompletionSummary {
  const totalQuestions = allQuestions.length
  let completedCount = 0
  let correctCount = 0
  let incorrectCount = 0
  let bookmarkedCount = 0
  let firstUnansweredIndex = -1

  for (let i = 0; i < totalQuestions; i++) {
    const qId = allQuestions[i].questionId
    const graded = results[qId]

    if (graded) {
      completedCount += 1
      if (graded.isCorrect) {
        correctCount += 1
      } else {
        incorrectCount += 1
      }
    } else if (firstUnansweredIndex === -1) {
      firstUnansweredIndex = i
    }

    if (bookmarks[qId]) {
      bookmarkedCount += 1
    }
  }

  const remainingUnansweredCount = totalQuestions - completedCount
  const accuracyPercent =
    completedCount > 0 ? Math.round((correctCount / completedCount) * 100) : 0
  const allGraded = totalQuestions > 0 && remainingUnansweredCount === 0

  return {
    totalQuestions,
    completedCount,
    remainingUnansweredCount,
    firstUnansweredIndex,
    correctCount,
    incorrectCount,
    bookmarkedCount,
    accuracyPercent,
    allGraded,
  }
}

export function shouldShowFinishPractice(params: {
  filter: 'all' | 'incorrect' | 'bookmarked'
  safeIndex: number
  filteredLength: number
  allGraded: boolean
}): boolean {
  const { filter, safeIndex, filteredLength, allGraded } = params
  return (
    filter === 'all' &&
    filteredLength > 0 &&
    safeIndex === filteredLength - 1 &&
    allGraded
  )
}

export function shouldShowUnansweredPrompt(params: {
  filter: 'all' | 'incorrect' | 'bookmarked'
  safeIndex: number
  filteredLength: number
  remainingUnansweredCount: number
  firstUnansweredIndex: number
}): boolean {
  const {
    filter,
    safeIndex,
    filteredLength,
    remainingUnansweredCount,
    firstUnansweredIndex,
  } = params
  return (
    filter === 'all' &&
    filteredLength > 0 &&
    safeIndex === filteredLength - 1 &&
    remainingUnansweredCount > 0 &&
    firstUnansweredIndex !== -1 &&
    firstUnansweredIndex !== safeIndex
  )
}
