/**
 * lib/study/services/dashboard-service.ts — Real persisted Study Dashboard metrics
 * ─────────────────────────────────────────────────────────────────────────────────
 * Computes all dashboard metrics strictly from persisted Notion Study System
 * repositories (ExamCollection, StudyQuestion, FsrsCardState, ReviewEvent).
 */

import type { StudyRepositories } from '../repositories'
import type { FsrsCardState, ReviewEvent, StudyQuestion, StudyRating } from '../types'

export interface UpcomingReviewBuckets {
  tomorrow: number
  next3Days: number
  next7Days: number
  later: number
}

export interface ExamProgressSummary {
  examId: string
  title: string
  certificationCategory: string
  totalQuestions: number
  studiedCount: number
  dueCount: number
  masteredCount: number
}

export interface TopicProgressSummary {
  topic: string
  totalQuestions: number
  studiedCount: number
  dueCount: number
  masteredCount: number
}

export interface RecentReviewItem {
  eventId: string
  questionId: string
  examId: string
  topic: string
  rating: StudyRating
  resultingState: string
  reviewedAt: string
  nextDue: string
}

export interface StudyDashboardData {
  generatedAt: string
  dueToday: number
  newCards: number
  totalCardsStudied: number
  totalPublishedQuestions: number
  studyStreakDays: number
  upcomingReviews: UpcomingReviewBuckets
  progressByExam: ExamProgressSummary[]
  progressByTopic: TopicProgressSummary[]
  recentlyReviewed: RecentReviewItem[]
}

function toUtcDayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

export function computeUtcStudyStreak(
  reviewEvents: ReviewEvent[],
  nowIso: string
): number {
  if (reviewEvents.length === 0) return 0

  const reviewedDays = new Set<string>()
  for (const ev of reviewEvents) {
    if (ev.reviewedAt && !Number.isNaN(Date.parse(ev.reviewedAt))) {
      reviewedDays.add(toUtcDayKey(ev.reviewedAt))
    }
  }
  if (reviewedDays.size === 0) return 0

  const nowDate = new Date(nowIso)
  const dayMs = 24 * 60 * 60 * 1000
  const todayUtc = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate()
  )

  let cursorMs = todayUtc
  const todayKey = new Date(todayUtc).toISOString().slice(0, 10)
  const yesterdayKey = new Date(todayUtc - dayMs).toISOString().slice(0, 10)

  if (!reviewedDays.has(todayKey)) {
    if (!reviewedDays.has(yesterdayKey)) return 0
    cursorMs = todayUtc - dayMs
  }

  let streak = 0
  while (reviewedDays.has(new Date(cursorMs).toISOString().slice(0, 10))) {
    streak += 1
    cursorMs -= dayMs
  }
  return streak
}

export async function getStudyDashboardData(
  userId: string,
  repos: StudyRepositories,
  nowIso: string = new Date().toISOString()
): Promise<StudyDashboardData> {
  const [exams, cardStates, reviewEvents] = await Promise.all([
    repos.exams.list({ status: 'published' }),
    repos.cardStates.listByUser(userId),
    repos.reviewEvents.listByUser(userId, { limit: 200 }),
  ])

  const questionsByExam = new Map<string, StudyQuestion[]>()
  const questionById = new Map<string, StudyQuestion>()

  for (const exam of exams) {
    const qs = await repos.questions.listByExamId(exam.examId, { status: 'published' })
    questionsByExam.set(exam.examId, qs)
    for (const q of qs) {
      questionById.set(q.questionId, q)
    }
  }

  const stateByQuestionId = new Map<string, FsrsCardState>()
  for (const st of cardStates) {
    stateByQuestionId.set(st.questionId, st)
  }

  const nowMs = Date.parse(nowIso)
  const endOfTodayDate = new Date(nowMs)
  endOfTodayDate.setUTCHours(23, 59, 59, 999)
  const endOfTodayMs = endOfTodayDate.getTime()
  const dayMs = 24 * 60 * 60 * 1000

  let dueToday = 0
  let newCards = 0
  let totalCardsStudied = 0
  const upcomingReviews: UpcomingReviewBuckets = {
    tomorrow: 0,
    next3Days: 0,
    next7Days: 0,
    later: 0,
  }

  const topicMap = new Map<string, TopicProgressSummary>()

  const progressByExam: ExamProgressSummary[] = exams.map((exam) => {
    const qs = questionsByExam.get(exam.examId) || []
    let studiedCount = 0
    let dueCount = 0
    let masteredCount = 0

    for (const q of qs) {
      const st = stateByQuestionId.get(q.questionId)
      const topicEntry = topicMap.get(q.topic) || {
        topic: q.topic,
        totalQuestions: 0,
        studiedCount: 0,
        dueCount: 0,
        masteredCount: 0,
      }
      topicEntry.totalQuestions += 1

      if (!st || st.card.reps === 0 || st.card.state === 'New') {
        newCards += 1
      } else {
        totalCardsStudied += 1
        studiedCount += 1
        topicEntry.studiedCount += 1

        const isMastered = st.card.state === 'Review' && st.card.scheduledDays >= 7
        if (isMastered) {
          masteredCount += 1
          topicEntry.masteredCount += 1
        }

        const dueMs = Date.parse(st.due)
        if (!Number.isNaN(dueMs)) {
          if (dueMs <= endOfTodayMs) {
            dueToday += 1
            dueCount += 1
            topicEntry.dueCount += 1
          } else if (dueMs <= endOfTodayMs + dayMs) {
            upcomingReviews.tomorrow += 1
          } else if (dueMs <= endOfTodayMs + 3 * dayMs) {
            upcomingReviews.next3Days += 1
          } else if (dueMs <= endOfTodayMs + 7 * dayMs) {
            upcomingReviews.next7Days += 1
          } else {
            upcomingReviews.later += 1
          }
        }
      }

      topicMap.set(q.topic, topicEntry)
    }

    return {
      examId: exam.examId,
      title: exam.title,
      certificationCategory: exam.certificationCategory,
      totalQuestions: qs.length,
      studiedCount,
      dueCount,
      masteredCount,
    }
  })

  const progressByTopic = [...topicMap.values()].sort((a, b) =>
    a.topic.localeCompare(b.topic)
  )

  const recentlyReviewed: RecentReviewItem[] = reviewEvents.slice(0, 15).map((ev) => {
    const q = questionById.get(ev.questionId)
    return {
      eventId: ev.eventId,
      questionId: ev.questionId,
      examId: q?.examId || 'unknown',
      topic: q?.topic || 'General',
      rating: ev.rating,
      resultingState: ev.resultingState.state,
      reviewedAt: ev.reviewedAt,
      nextDue: ev.resultingState.due,
    }
  })

  return {
    generatedAt: nowIso,
    dueToday,
    newCards,
    totalCardsStudied,
    totalPublishedQuestions: questionById.size,
    studyStreakDays: computeUtcStudyStreak(reviewEvents, nowIso),
    upcomingReviews,
    progressByExam,
    progressByTopic,
    recentlyReviewed,
  }
}
