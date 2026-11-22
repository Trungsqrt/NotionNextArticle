import { Suspense } from 'react'
import { requireStudyPageSession } from '../../../lib/study/auth/guard'
import { createNotionStudyRepositories } from '../../../lib/study/repositories'
import type { ExamCollection } from '../../../lib/study/types'
import StudyNav from '../../../components/study/StudyNav'
import PracticeModeClient from '../../../components/study/PracticeModeClient'

export const dynamic = 'force-dynamic'

export default async function StudyPracticePage() {
  const user = await requireStudyPageSession({ returnTo: '/study/practice' })

  let exams: ExamCollection[] = []
  try {
    const repos = createNotionStudyRepositories()
    exams = await repos.exams.list({ status: 'published' })
  } catch {
    exams = []
  }

  return (
    <>
      <StudyNav user={user} />
      <Suspense fallback={null}>
        <PracticeModeClient exams={exams} />
      </Suspense>
    </>
  )
}
