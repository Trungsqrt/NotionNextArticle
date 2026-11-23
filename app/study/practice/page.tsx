import { Suspense } from 'react'
import { requireStudyPageSession } from '../../../lib/study/auth/guard'
import { createNotionStudyRepositories } from '../../../lib/study/repositories'
import type { ExamCollection } from '../../../lib/study/types'
import PracticeModeClient from '../../../components/study/PracticeModeClient'
import { PracticeModeSkeleton } from '../../../components/study/StudySkeletons'

export const dynamic = 'force-dynamic'

export default async function StudyPracticePage() {
  await requireStudyPageSession({ returnTo: '/study/practice' })

  let exams: ExamCollection[] = []
  try {
    const repos = createNotionStudyRepositories()
    exams = await repos.exams.list({ status: 'published' })
  } catch {
    exams = []
  }

  return (
    <Suspense fallback={<PracticeModeSkeleton />}>
      <PracticeModeClient exams={exams} />
    </Suspense>
  )
}
