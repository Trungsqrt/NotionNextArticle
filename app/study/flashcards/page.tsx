import { Suspense } from 'react'
import { requireStudyPageSession } from '../../../lib/study/auth/guard'
import StudyNav from '../../../components/study/StudyNav'
import RecallSessionClient from '../../../components/study/RecallSessionClient'

export const dynamic = 'force-dynamic'

export default async function StudyFlashcardsPage() {
  const user = await requireStudyPageSession({ returnTo: '/study/flashcards' })

  return (
    <>
      <StudyNav user={user} />
      <Suspense fallback={null}>
        <RecallSessionClient />
      </Suspense>
    </>
  )
}
