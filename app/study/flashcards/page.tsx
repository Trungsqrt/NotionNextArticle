import { Suspense } from 'react'
import { requireStudyPageSession } from '../../../lib/study/auth/guard'
import { createNotionStudyRepositories } from '../../../lib/study/repositories'
import RecallSessionClient from '../../../components/study/RecallSessionClient'
import { RecallSessionSkeleton } from '../../../components/study/StudySkeletons'

export const dynamic = 'force-dynamic'

export default async function StudyFlashcardsPage() {
  const user = await requireStudyPageSession({ returnTo: '/study/flashcards' })

  let publishedExamIds: string[] = []
  try {
    const repos = createNotionStudyRepositories()
    const exams = await repos.exams.list({ status: 'published' })
    publishedExamIds = exams.map((e) => e.examId)
  } catch {
    publishedExamIds = []
  }

  return (
    <Suspense fallback={<RecallSessionSkeleton />}>
      <RecallSessionClient
        userId={user.userId}
        publishedExamIds={publishedExamIds}
      />
    </Suspense>
  )
}
