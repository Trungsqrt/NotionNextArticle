import test from 'node:test'
import assert from 'node:assert/strict'
import type { GradedQuestionResult } from '../../lib/study/services/grading'
import {
  computePracticeCompletionSummary,
  shouldShowFinishPractice,
  shouldShowUnansweredPrompt,
} from '../../lib/study/practice-completion'

function makeGraded(questionId: string, isCorrect: boolean): GradedQuestionResult {
  return {
    questionId,
    questionType: 'single_choice',
    isCorrect,
    isSkipped: false,
    selectedOptionIds: isCorrect ? ['A'] : ['B'],
    correctOptionIds: ['A'],
    explanation: 'Explanation',
    optionFeedback: [],
  }
}

const QUESTIONS = [
  { questionId: 'q1' },
  { questionId: 'q2' },
  { questionId: 'q3' },
  { questionId: 'q4' },
]

test('computePracticeCompletionSummary derives accuracy, counts, and first unanswered index', () => {
  const summary = computePracticeCompletionSummary(
    QUESTIONS,
    {
      q1: makeGraded('q1', true),
      q3: makeGraded('q3', false),
      q4: makeGraded('q4', true),
    },
    {
      q2: true,
      q3: true,
      stale_other_exam_q: true,
    }
  )

  assert.equal(summary.totalQuestions, 4)
  assert.equal(summary.completedCount, 3)
  assert.equal(summary.remainingUnansweredCount, 1)
  assert.equal(summary.firstUnansweredIndex, 1)
  assert.equal(summary.correctCount, 2)
  assert.equal(summary.incorrectCount, 1)
  assert.equal(summary.bookmarkedCount, 2)
  assert.equal(summary.accuracyPercent, 67)
  assert.equal(summary.allGraded, false)
})

test('computePracticeCompletionSummary marks allGraded true only when all questions have results', () => {
  const empty = computePracticeCompletionSummary([], {}, {})
  assert.equal(empty.allGraded, false)
  assert.equal(empty.accuracyPercent, 0)
  assert.equal(empty.firstUnansweredIndex, -1)

  const complete = computePracticeCompletionSummary(
    QUESTIONS,
    {
      q1: makeGraded('q1', true),
      q2: makeGraded('q2', true),
      q3: makeGraded('q3', false),
      q4: makeGraded('q4', true),
    },
    { q3: true }
  )

  assert.equal(complete.allGraded, true)
  assert.equal(complete.remainingUnansweredCount, 0)
  assert.equal(complete.firstUnansweredIndex, -1)
  assert.equal(complete.completedCount, 4)
  assert.equal(complete.correctCount, 3)
  assert.equal(complete.incorrectCount, 1)
  assert.equal(complete.bookmarkedCount, 1)
  assert.equal(complete.accuracyPercent, 75)
})

test('shouldShowFinishPractice only triggers on final question of All filter when all questions are graded', () => {
  // Final question of All + all graded -> true
  assert.equal(
    shouldShowFinishPractice({
      filter: 'all',
      safeIndex: 3,
      filteredLength: 4,
      allGraded: true,
    }),
    true
  )

  // Not final question -> false
  assert.equal(
    shouldShowFinishPractice({
      filter: 'all',
      safeIndex: 2,
      filteredLength: 4,
      allGraded: true,
    }),
    false
  )

  // Final question but unanswered questions remain -> false
  assert.equal(
    shouldShowFinishPractice({
      filter: 'all',
      safeIndex: 3,
      filteredLength: 4,
      allGraded: false,
    }),
    false
  )

  // Reaching end of Incorrect or Bookmarked filters never triggers completion
  assert.equal(
    shouldShowFinishPractice({
      filter: 'incorrect',
      safeIndex: 0,
      filteredLength: 1,
      allGraded: true,
    }),
    false
  )
  assert.equal(
    shouldShowFinishPractice({
      filter: 'bookmarked',
      safeIndex: 1,
      filteredLength: 2,
      allGraded: true,
    }),
    false
  )
})

test('shouldShowUnansweredPrompt shows only on final All question when earlier unanswered questions exist', () => {
  // On final question (idx 3), Q2 (idx 1) is unanswered -> show prompt
  assert.equal(
    shouldShowUnansweredPrompt({
      filter: 'all',
      safeIndex: 3,
      filteredLength: 4,
      remainingUnansweredCount: 1,
      firstUnansweredIndex: 1,
    }),
    true
  )

  // On final question (idx 3), only Q4 itself (idx 3) is unanswered -> don't show jump-to-self prompt
  assert.equal(
    shouldShowUnansweredPrompt({
      filter: 'all',
      safeIndex: 3,
      filteredLength: 4,
      remainingUnansweredCount: 1,
      firstUnansweredIndex: 3,
    }),
    false
  )

  // In Incorrect / Bookmarked filter -> false
  assert.equal(
    shouldShowUnansweredPrompt({
      filter: 'incorrect',
      safeIndex: 0,
      filteredLength: 1,
      remainingUnansweredCount: 2,
      firstUnansweredIndex: 0,
    }),
    false
  )

  // All graded -> false
  assert.equal(
    shouldShowUnansweredPrompt({
      filter: 'all',
      safeIndex: 3,
      filteredLength: 4,
      remainingUnansweredCount: 0,
      firstUnansweredIndex: -1,
    }),
    false
  )
})
