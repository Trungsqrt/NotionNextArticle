import test from 'node:test'
import assert from 'node:assert/strict'
import type { GradedQuestionResult } from '../../lib/study/services/grading'
import {
  buildPracticeExamUrl,
  resolveExternalParamExamSwitch,
  resolvePracticeRetryAction,
  resolveValidExamId,
  shouldShowViewSummaryButton,
  type PracticeError,
} from '../../lib/study/practice-state'
import { computePracticeCompletionSummary } from '../../lib/study/practice-completion'

const EXAMS = [
  { examId: 'csa-exam-1', title: 'CSA Practice Exam 1' },
  { examId: 'csa-exam-2', title: 'CSA Practice Exam 2' },
  { examId: 'csa-exam-3', title: 'CSA Practice Exam 3' },
]

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

test('P1: resolvePracticeRetryAction retries only the failed Check Answer without reloading exam (59/60 scenario)', () => {
  // Simulate 59 of 60 questions graded and Q60 failing Check Answer
  const questions = Array.from({ length: 60 }, (_, idx) => ({ questionId: `q-${idx + 1}` }))
  const results: Record<string, GradedQuestionResult> = {}
  const selections: Record<string, string[]> = {}
  for (let i = 1; i <= 59; i++) {
    results[`q-${i}`] = makeGraded(`q-${i}`, i % 5 !== 0)
    selections[`q-${i}`] = ['A']
  }
  selections['q-60'] = ['C']

  const checkError: PracticeError = {
    kind: 'check_answer',
    questionId: 'q-60',
    selectedOptionIds: ['C'],
    message: 'Unable to check answer right now.',
  }

  const retryAction = resolvePracticeRetryAction(checkError, selections)
  assert.deepEqual(retryAction, {
    type: 'check_answer',
    questionId: 'q-60',
    selectedOptionIds: ['C'],
  })

  // Confirm all 59 prior graded answers remain untouched before/during retry
  const summaryBefore = computePracticeCompletionSummary(questions, results, { 'q-10': true })
  assert.equal(summaryBefore.completedCount, 59)
  assert.equal(summaryBefore.remainingUnansweredCount, 1)
  assert.equal(summaryBefore.allGraded, false)

  // After retry succeeds on Q60, all 60 results are preserved and exam is complete
  results['q-60'] = makeGraded('q-60', true)
  const summaryAfter = computePracticeCompletionSummary(questions, results, { 'q-10': true })
  assert.equal(summaryAfter.completedCount, 60)
  assert.equal(summaryAfter.allGraded, true)
  assert.equal(summaryAfter.bookmarkedCount, 1)
})

test('P1: resolvePracticeRetryAction distinguishes initial exam load vs exam switch failures', () => {
  const switchError: PracticeError = {
    kind: 'load_exam',
    examId: 'csa-exam-2',
    isSwitch: true,
    message: 'Unable to switch to "CSA Practice Exam 2".',
  }
  assert.deepEqual(resolvePracticeRetryAction(switchError, {}), {
    type: 'load_exam',
    examId: 'csa-exam-2',
    isSwitch: true,
  })

  const initialError: PracticeError = {
    kind: 'load_exam',
    examId: 'csa-exam-1',
    isSwitch: false,
    message: 'Unable to load practice questions.',
  }
  assert.deepEqual(resolvePracticeRetryAction(initialError, {}), {
    type: 'load_exam',
    examId: 'csa-exam-1',
    isSwitch: false,
  })

  assert.equal(resolvePracticeRetryAction(null, {}), null)
})

test('P2: shouldShowViewSummaryButton only appears after all questions are graded and when not on summary screen', () => {
  // Before all graded -> hidden
  assert.equal(
    shouldShowViewSummaryButton({
      allGraded: false,
      isCompleted: false,
      isInitialLoading: false,
    }),
    false
  )

  // While initially loading -> hidden
  assert.equal(
    shouldShowViewSummaryButton({
      allGraded: true,
      isCompleted: false,
      isInitialLoading: true,
    }),
    false
  )

  // Already viewing completion screen -> hidden
  assert.equal(
    shouldShowViewSummaryButton({
      allGraded: true,
      isCompleted: true,
      isInitialLoading: false,
    }),
    false
  )

  // All graded and reviewing All / Incorrect / Bookmarked -> visible
  assert.equal(
    shouldShowViewSummaryButton({
      allGraded: true,
      isCompleted: false,
      isInitialLoading: false,
    }),
    true
  )
})

test('P3: resolveValidExamId validates URL examId against published exams and falls back safely', () => {
  assert.equal(resolveValidExamId('csa-exam-2', EXAMS), 'csa-exam-2')
  assert.equal(resolveValidExamId('  csa-exam-3  ', EXAMS), 'csa-exam-3')
  assert.equal(resolveValidExamId('unknown-exam-id', EXAMS), 'csa-exam-1')
  assert.equal(resolveValidExamId('', EXAMS), 'csa-exam-1')
  assert.equal(resolveValidExamId(null, []), '')
})

test('P3: resolveExternalParamExamSwitch never overrides intentional dropdown switch when URL param stays unchanged', () => {
  // Opened with ?examId=csa-exam-1, user intentionally switches to csa-exam-2 while URL still has csa-exam-1
  assert.equal(
    resolveExternalParamExamSwitch({
      paramExamId: 'csa-exam-1',
      lastHandledParamExamId: 'csa-exam-1',
      activeExamId: 'csa-exam-1',
      pendingExamId: 'csa-exam-2',
      exams: EXAMS,
    }),
    null
  )

  // After csa-exam-2 commits and URL updates to ?examId=csa-exam-2 -> no re-fetch
  assert.equal(
    resolveExternalParamExamSwitch({
      paramExamId: 'csa-exam-2',
      lastHandledParamExamId: 'csa-exam-2',
      activeExamId: 'csa-exam-2',
      pendingExamId: null,
      exams: EXAMS,
    }),
    null
  )

  // External navigation to ?examId=csa-exam-3 triggers switch
  assert.equal(
    resolveExternalParamExamSwitch({
      paramExamId: 'csa-exam-3',
      lastHandledParamExamId: 'csa-exam-2',
      activeExamId: 'csa-exam-2',
      pendingExamId: null,
      exams: EXAMS,
    }),
    'csa-exam-3'
  )

  // Invalid external URL examId is ignored
  assert.equal(
    resolveExternalParamExamSwitch({
      paramExamId: 'invalid-exam',
      lastHandledParamExamId: 'csa-exam-2',
      activeExamId: 'csa-exam-2',
      pendingExamId: null,
      exams: EXAMS,
    }),
    null
  )
})

test('P3: buildPracticeExamUrl updates examId while preserving other query parameters and hash', () => {
  assert.equal(
    buildPracticeExamUrl('https://servicenow-space.vercel.app/study/practice?examId=csa-exam-1', 'csa-exam-2'),
    '/study/practice?examId=csa-exam-2'
  )
  assert.equal(
    buildPracticeExamUrl('https://servicenow-space.vercel.app/study/practice?ref=dashboard#top', 'csa-exam-3'),
    '/study/practice?ref=dashboard&examId=csa-exam-3#top'
  )
})
