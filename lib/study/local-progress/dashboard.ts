/**
 * lib/study/local-progress/dashboard.ts — Dashboard local progress aggregation
 * ────────────────────────────────────────────────────────────────────────────
 * Combines locally persisted Practice attempts, Practice completion summaries,
 * and server-graded Mock Exam summaries into per-collection and overview metrics
 * for the Study Dashboard without issuing additional Notion queries.
 */

import { getDefaultStorage, type StorageLike } from './storage'
import { readPracticeAttempt, readPracticeSummary } from './practice'
import { readMockExamSummary } from './mock-exam'

export interface DashboardExamItem {
  examId: string
  title: string
  certificationCategory: string
  questionCount: number
}

export type PracticeCollectionStatus = 'not_started' | 'in_progress' | 'completed'
export type MockExamCollectionStatus = 'not_attempted' | 'passed' | 'not_passed'

export interface ExamDashboardMetrics {
  exam: DashboardExamItem
  practice: {
    status: PracticeCollectionStatus
    checkedCount: number
    totalQuestions: number
    progressPercent: number
    accuracyPercent: number | null
    hasOngoingAttempt: boolean
    hasCompletedSummary: boolean
    actionLabel: 'Start Practice' | 'Continue Practice' | 'Review Practice'
  }
  mockExam: {
    status: MockExamCollectionStatus
    latestScorePercent: number | null
    bestScorePercent: number | null
    latestPassed: boolean | null
    attemptsCount: number
  }
}

export interface DashboardOverviewMetrics {
  totalCollections: number
  completedPracticeCount: number
  completedMockExamCount: number
  latestPracticeAccuracy: number | null
  bestExamScore: number | null
  exams: ExamDashboardMetrics[]
}

export function computeDashboardOverview(
  userId: string,
  exams: readonly DashboardExamItem[],
  storage: StorageLike | null = getDefaultStorage()
): DashboardOverviewMetrics {
  let completedPracticeCount = 0
  let completedMockExamCount = 0
  let latestPracticeAccuracy: number | null = null
  let latestPracticeTimestampMs = -1
  let bestExamScore: number | null = null

  const examMetrics: ExamDashboardMetrics[] = exams.map((exam) => {
    const attempt = readPracticeAttempt(userId, exam.examId, storage)
    const completedSummary = readPracticeSummary(userId, exam.examId, storage)
    const examSummary = readMockExamSummary(userId, exam.examId, storage)

    const totalQuestions = exam.questionCount

    // Derive Practice status: ongoing attempt takes precedence when actively in progress,
    // while completed summaries preserve Completed status even after Restart Practice
    // clears an active attempt without starting a new one.
    const attemptCheckedEntries = attempt ? Object.entries(attempt.checkedResults) : []
    const attemptCheckedCount = attemptCheckedEntries.length
    const attemptCorrectCount = attemptCheckedEntries.filter(([, ok]) => ok).length
    const attemptAllGraded =
      totalQuestions > 0 && attemptCheckedCount >= totalQuestions

    let practiceStatus: PracticeCollectionStatus = 'not_started'
    let checkedCount = 0
    let accuracyPercent: number | null = null
    let actionLabel: 'Start Practice' | 'Continue Practice' | 'Review Practice' = 'Start Practice'

    if (attempt && attemptCheckedCount > 0 && !attemptAllGraded) {
      practiceStatus = 'in_progress'
      checkedCount = Math.min(attemptCheckedCount, totalQuestions || attemptCheckedCount)
      accuracyPercent = Math.round((attemptCorrectCount / attemptCheckedCount) * 100)
      actionLabel = 'Continue Practice'
    } else if (attempt && attemptAllGraded) {
      practiceStatus = 'completed'
      checkedCount = totalQuestions
      accuracyPercent = Math.round((attemptCorrectCount / attemptCheckedCount) * 100)
      actionLabel = 'Review Practice'
    } else if (completedSummary) {
      practiceStatus = 'completed'
      checkedCount = totalQuestions > 0 ? totalQuestions : completedSummary.completedCount
      accuracyPercent = completedSummary.accuracyPercent
      actionLabel = 'Review Practice'
    }

    if (practiceStatus === 'completed' || completedSummary) {
      completedPracticeCount += 1
    }

    // Track latest Practice accuracy across completed summaries or latest active graded attempt
    if (completedSummary) {
      const ts = Date.parse(completedSummary.completedAt)
      if (!Number.isNaN(ts) && ts >= latestPracticeTimestampMs) {
        latestPracticeTimestampMs = ts
        latestPracticeAccuracy = completedSummary.accuracyPercent
      }
    }
    if (attempt && attemptCheckedCount > 0) {
      const ts = Date.parse(attempt.updatedAt)
      const attemptAcc = Math.round((attemptCorrectCount / attemptCheckedCount) * 100)
      if (!Number.isNaN(ts) && ts > latestPracticeTimestampMs) {
        latestPracticeTimestampMs = ts
        latestPracticeAccuracy = attemptAcc
      }
    }

    const progressPercent =
      totalQuestions > 0 ? Math.min(100, Math.round((checkedCount / totalQuestions) * 100)) : 0

    // Derive Mock Exam metrics from actual server-graded summary
    let mockExamStatus: MockExamCollectionStatus = 'not_attempted'
    if (examSummary) {
      completedMockExamCount += 1
      mockExamStatus = examSummary.latestPassed ? 'passed' : 'not_passed'
      if (bestExamScore === null || examSummary.bestScorePercent > bestExamScore) {
        bestExamScore = examSummary.bestScorePercent
      }
    }

    return {
      exam,
      practice: {
        status: practiceStatus,
        checkedCount,
        totalQuestions,
        progressPercent,
        accuracyPercent,
        hasOngoingAttempt: Boolean(attempt && attemptCheckedCount > 0 && !attemptAllGraded),
        hasCompletedSummary: Boolean(completedSummary),
        actionLabel,
      },
      mockExam: {
        status: mockExamStatus,
        latestScorePercent: examSummary ? examSummary.latestScorePercent : null,
        bestScorePercent: examSummary ? examSummary.bestScorePercent : null,
        latestPassed: examSummary ? examSummary.latestPassed : null,
        attemptsCount: examSummary ? examSummary.attemptsCount : 0,
      },
    }
  })

  return {
    totalCollections: exams.length,
    completedPracticeCount,
    completedMockExamCount,
    latestPracticeAccuracy,
    bestExamScore,
    exams: examMetrics,
  }
}
